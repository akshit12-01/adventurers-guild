let now = 1700000000000; Date.now = () => now;
const store = {};
globalThis.localStorage = { getItem:k=>store[k]??null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
globalThis.window = globalThis; globalThis.confirm = () => true;
const handlers = {};
const host = { dataset: {}, _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; handlers.length = 0; this.btns = []; },
  querySelectorAll(sel) { this.cache = this.cache || {}; if (this.cache[sel] && this.cache.html === this._html) return this.cache[sel]; const cls = sel.slice(1); const re = new RegExp(`<button class="[^"]*${cls}[^"]*"([^>]*)>`, 'g'); const out = []; let m; while ((m = re.exec(this._html))) { const attrs = m[1]; const el = { dataset: { skill: (/data-skill="([^"]*)"/.exec(attrs)||[])[1], enemy: (/data-enemy="([^"]*)"/.exec(attrs)||[])[1] }, addEventListener: (e, f) => { el.click = f; } }; out.push(el); this.btns.push(el); } if (this.cache.html !== this._html) this.cache = { html: this._html }; this.cache[sel] = out; return out; },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; } };
globalThis.document = { getElementById: (id) => id === 'aq-manual-panel' ? host : null, querySelectorAll: () => [], querySelector: () => null, addEventListener(){}, createElement:()=>({style:{}}), visibilityState:'visible' };
const Game = (await import('./js/game.js')).default;
const cl = await import('./js/ui/combatlog.js');
const Q = await import('./js/ui/quests.js');
Game.newGame('T','HERO'); for (const c of ['KNIGHT','MAGE']) { const r = Game.recruitMember(c); Game.setActive(r.member.id, true); }
for (const m of [Game.state.player, ...Game.state.party]) m.level = 12;
now += 1e5; cl.resetCombatLog();
Game.startQuest(Game.getQuestBoardQuests('F')[1].id, { battleMode: Game.state.battleMode === 'manual' ? 'manual' : 'manual' });
let guard = 0, panels = 0;
while (guard++ < 100) {
  Q.tickUpdateCombatVisuals();
  const a = Game.state.guild.activeQuest;
  if (/aq-manual-skill/.test(host.innerHTML)) {
    panels++;
    // pick last enabled skill
    const re = /<button class="btn btn-sm aq-manual-skill[^"]*" data-skill="([^"]*)" (disabled)?/g; let m, last;
    while ((m = re.exec(host.innerHTML))) if (!m[2]) last = m[1];
    const skillEl = host.querySelectorAll('.aq-manual-skill').find(e => e.dataset.skill === last);
    skillEl.click();
    if (/aq-manual-target/.test(host.innerHTML)) { host.querySelectorAll('.aq-manual-target')[0].click(); }
    now = a.startedAt + (a.pausedMs||0) + (a.eventCount + 2) * 1000;
    continue;
  }
  now = a.startedAt + (a.pausedMs||0) + (a.eventCount + 2) * 1000;
  if (!cl.getPendingDecision()) break;
}
console.log('panels rendered/answered', panels, 'pending', cl.getPendingDecision(), 'outcome', cl.getBattleOutcome(), 'host:', host._html.slice(0, 80));
console.log(host._html.includes('aq-manual-skill') ? 'still asking?' : 'ui flow OK');
