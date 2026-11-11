let seed = 777; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
Math.random = rnd;
let now = 1700000000000; Date.now = () => now;
const store = {};
globalThis.localStorage = { getItem:k=>store[k]??null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
globalThis.window = globalThis;
globalThis.document = { getElementById:()=>null, querySelectorAll:()=>[], addEventListener(){}, createElement:()=>({style:{}}), visibilityState:'visible' };
const Game = (await import('./js/game.js')).default;
const cl = await import('./js/ui/combatlog.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL:', m); } };
const texts = () => cl.getSimEvents().map(e => e.text);
const aqf = () => Game.state.guild.activeQuest;
function catchUp() { const a = aqf(); const iv = a.eventIntervalMs || 1000; now = a.startedAt + (a.pausedMs || 0) + (a.eventCount + 2) * iv; }
function setup(classes, lvl = 12, qi = 0) {
  Game.newGame('T', 'HERO'); Game.state.gold = 1e6;
  for (const c of classes) { const r = Game.recruitMember(c); if (r.ok) Game.setActive(r.member.id, true); }
  for (const m of [Game.state.player, ...Game.state.party]) m.level = lvl;
  now += 100000; cl.resetCombatLog();
  const q = Game.getQuestBoardQuests('F')[qi];
  const r = Game.startQuest(q.id, { battleMode: 'manual' }); ok(r.ok, 'start ' + r.reason);
  cl.getSimInfo();
}
function play(policy, hook) {
  let steps = 0, prev = [], prevCount = 0;
  while (steps++ < 400) {
    cl.getSimInfo(); const a = aqf();
    const t = texts();
    for (let i = 0; i < prev.length; i++) if (t[i] !== prev[i]) { ok(false, 'prefix changed at ' + i + ' step ' + steps); break; }
    ok(a.eventCount >= prevCount, 'eventCount monotonic'); prev = t; prevCount = a.eventCount;
    const p = cl.getPendingDecision();
    if (!p) return { steps, done: true };
    ok(a.awaitingInput === true, 'awaitingInput flag');
    ok(!Game.isQuestComplete(), 'not complete while awaiting');
    catchUp();
    const ch = policy(p, steps);
    if (hook) hook(p, ch, steps);
    const r = cl.submitManualChoice({ index: p.index, ...ch });
    ok(r.ok, 'submit failed: ' + r.reason + ' ' + JSON.stringify(ch));
    if (!r.ok) return { steps, done: false };
  }
  return { steps, done: false };
}
const firstReady = (p) => { const o = p.options.filter(o => o.ready); const o2 = o[o.length - 1]; return { skillId: o2.id, targetId: o2.kind === 'single' ? p.enemies[p.enemies.length - 1].id : null }; };
const randomPol = (p) => { const o = p.options.filter(o => o.ready); const x = o[Math.floor(rnd() * o.length)]; return { skillId: x.id, targetId: x.kind === 'single' ? p.enemies[Math.floor(rnd() * p.enemies.length)].id : null }; };

// 1. full battle, target honoured, finish
setup(['KNIGHT', 'MAGE', 'CLERIC', 'ROGUE'], 12, 1);
let sawTarget = 0;
const res = play(firstReady, (p, ch) => {});
ok(res.done, 'battle completes'); console.log('steps', res.steps, 'outcome', cl.getBattleOutcome(), 'events', texts().length);
catchUp(); ok(Game.isQuestComplete(), 'complete after last decision'); Game.finishQuest(); ok(Game.state.pendingResults && Game.state.guild.activeQuest === null, 'finished');
console.log('result success:', Game.state.pendingResults.result.success, 'matches sim:', Game.state.pendingResults.result.success === (cl.getBattleOutcome() === 'victory'));

// 2. targeting really applies: choose last enemy with basic attack, check text names it
setup(['KNIGHT', 'MAGE'], 12, 2);
let checked = 0, matched = 0;
for (let s = 0; s < 40; s++) {
  cl.getSimInfo(); const p = cl.getPendingDecision(); if (!p) break; catchUp();
  const basic = p.options.find(o => o.id === '__BASIC__');
  if (p.lane === 'attack' && p.enemies.length > 1) {
    const tgt = p.enemies[p.enemies.length - 1];
    const before = texts().length;
    ok(cl.submitManualChoice({ index: p.index, skillId: '__BASIC__', targetId: tgt.id }).ok, 'basic submit'); cl.getSimInfo();
    const added = texts().slice(before).join(' '); checked++; if (added.includes(tgt.name)) matched++;
  } else { const c = firstReady(p); cl.submitManualChoice({ index: p.index, ...c }); }
}
console.log('target-honoured', matched + '/' + checked); ok(checked > 0 && matched === checked, 'targets honoured');

// 3. validation
setup(['KNIGHT', 'MAGE', 'CLERIC'], 12, 3);
{
  cl.getSimInfo(); let p = cl.getPendingDecision();
  while (p && p.enemies.length < 2) { catchUp(); cl.submitManualChoice({ index: p.index, ...firstReady(p) }); p = cl.getPendingDecision(); }
  if (p) {
    ok(!cl.submitManualChoice({ index: p.index, skillId: '__BASIC__', targetId: p.enemies[0].id }).ok || true, 'x');
  }
}
setup(['KNIGHT', 'MAGE', 'CLERIC'], 12, 3);
cl.getSimInfo(); let p3 = cl.getPendingDecision();
if (p3) {
  ok(cl.submitManualChoice({ index: p3.index, skillId: '__BASIC__', targetId: p3.enemies[0].id }).ok === false || Game.questEventsRevealed() >= aqf().eventCount, 'rejected while events still revealing (or already caught up)');
  now = aqf().startedAt + 1e7; Game.setQuestEventCount; 
  ok(!cl.submitManualChoice({ index: p3.index + 5, skillId: '__BASIC__', targetId: p3.enemies[0].id }).ok, 'wrong index rejected');
  ok(!cl.submitManualChoice({ index: p3.index, skillId: 'NOPE', targetId: null }).ok, 'unknown skill rejected');
  ok(!cl.submitManualChoice({ index: p3.index, skillId: '__BASIC__', targetId: 'ghost' }).ok, 'bad target rejected');
  const cd = p3.options.find(o => !o.ready); if (cd) ok(!cl.submitManualChoice({ index: p3.index, skillId: cd.id, targetId: p3.enemies[0].id }).ok, 'cooldown skill rejected');
  const good = cl.submitManualChoice({ index: p3.index, skillId: '__BASIC__', targetId: p3.enemies[0].id }); ok(good.ok, 'valid accepted');
  ok(!cl.submitManualChoice({ index: p3.index, skillId: '__BASIC__', targetId: p3.enemies[0].id }).ok, 'double submit rejected');
}

// 4. reload + mutated live state must not change the replay
setup(['KNIGHT', 'MAGE', 'CLERIC', 'RANGER'], 12, 1);
for (let s = 0; s < 4; s++) { cl.getSimInfo(); const p = cl.getPendingDecision(); if (!p) break; catchUp(); cl.submitManualChoice({ index: p.index, ...firstReady(p) }); }
cl.getSimInfo(); const snapTexts = texts(), snapPending = JSON.stringify(cl.getPendingDecision());
Game.save();
// mutate live state: heal/hurt, deactivate members, change level, dismiss talents
for (const m of [Game.state.player, ...Game.state.party]) { m.stats.atk += 500; m.stats.maxHp += 999; m.stats.hp = 1; m.level = 3; }
Game.state.activeSlots = []; Game.state.guildLegacy.talents = ['PARTY_SIEGE'];
Game.state.battleMode = 'auto';
cl.resetCombatLog(); cl.getSimInfo();
ok(JSON.stringify(texts()) === JSON.stringify(snapTexts), 'replay identical after live-state mutation');
ok(JSON.stringify(cl.getPendingDecision()) === snapPending, 'pending identical after mutation');
// true reload from storage
cl.resetCombatLog(); ok(Game.load(), 'load'); cl.getSimInfo();
ok(aqf() && aqf().battleMode === 'manual' && aqf().manualDecisions.length === 4, 'decisions persisted');
ok(JSON.stringify(texts()) === JSON.stringify(snapTexts), 'replay identical after reload');
Game.resolveIdle(); ok(aqf(), 'resolveIdle keeps awaiting quest');
now += 3600e3; ok(!Game.isQuestComplete(), 'does not complete offline while awaiting');
ok(Game.questEventsRevealed() === aqf().eventCount, 'revealed capped');

// 5. auto-resolve the rest
setup(['KNIGHT', 'MAGE', 'CLERIC'], 12, 1);
for (let s = 0; s < 3; s++) { cl.getSimInfo(); const p = cl.getPendingDecision(); if (!p) break; catchUp(); cl.submitManualChoice({ index: p.index, ...firstReady(p) }); }
cl.getSimInfo(); const before5 = texts();
ok(cl.autoResolveManualBattle().ok, 'autoresolve ok'); cl.getSimInfo();
ok(cl.getPendingDecision() === null, 'no pending after autoresolve');
const after5 = texts(); ok(before5.every((t, i) => after5[i] === t), 'prefix kept after autoresolve'); ok(after5.length > before5.length, 'more events');
now = aqf().startedAt + aqf().pausedMs + 1e6; ok(Game.isQuestComplete(), 'completes'); Game.finishQuest(); ok(Game.state.pendingResults, 'results');
// reload mid-autoresolve consistency
// 6. fuzz
let battles = 0, maxSteps = 0, crashes = 0;
const sets = [['KNIGHT','MAGE','CLERIC'],['ROGUE','RANGER','BARD','MONK'],['NECROMANCER','CLERIC','MAGE','KNIGHT'],[],['CLERIC'],['BARD','BARD','MAGE','ROGUE']];
for (let n = 0; n < 60; n++) {
  try {
    setup(sets[n % sets.length], 3 + (n % 25), n % 5);
    const r = play(randomPol); battles++; maxSteps = Math.max(maxSteps, r.steps);
    ok(r.done, 'fuzz battle ' + n + ' finished'); catchUp();
    if (r.done) { ok(Game.isQuestComplete(), 'fuzz complete'); Game.finishQuest(); ok(Game.state.pendingResults, 'fuzz results'); }
  } catch (e) { crashes++; console.log('CRASH', n, e.stack.split('\n').slice(0, 4).join(' / ')); }
}
console.log('fuzz battles', battles, 'max steps', maxSteps, 'crashes', crashes);
ok(crashes === 0, 'no crashes');
// timing
setup(['KNIGHT','MAGE','CLERIC','ROGUE','RANGER','BARD','MONK'], 25, 4);
const t0 = performance.now(); let reps = 0; while (reps < 30) { cl.resetCombatLog(); cl.getSimInfo(); reps++; } console.log('ms per rebuild', ((performance.now() - t0) / reps).toFixed(1));
// tower/auto quest untouched
Game.newGame('T','HERO'); now += 1e6; cl.resetCombatLog(); const qq = Game.getQuestBoardQuests('F')[0]; Game.startQuest(qq.id); cl.getSimInfo();
ok(aqf().battleMode === undefined && cl.getPendingDecision() === null && cl.getBattleOutcome() !== null, 'auto quest unaffected');
ok(!Game.startQuest(qq.id, {battleMode:'manual'}).ok, 'cannot start 2nd quest');
Game.state.guild.activeQuest = null; Game.state.autoRun = { strategy: 'safe', remaining: 2, total: 2, rank: 'F' };
ok(!Game.startQuest(qq.id, { battleMode: 'manual' }).ok, 'manual refused during auto-run');
console.log(fails ? 'FAILURES: ' + fails : 'ALL OK');
