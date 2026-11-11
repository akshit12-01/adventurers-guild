// Manual battle mode patch. Run from the repo root:  node manual-mode-patch/apply.mjs
// All edits are checked in memory first; nothing is written unless every anchor matches.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const snip = (n) => fs.readFileSync(path.join(here, 'snippets', n), 'utf8').replace(/\n$/, '');

const CL = 'js/ui/combatlog.js', GM = 'js/game.js', Q = 'js/ui/quests.js', H = 'js/ui/hall.js', CSS = 'style.css';
const E = []; // { file, find, to, count }
const rep  = (file, find, to, count = 1) => E.push({ file, find, to, count });
const before = (file, find, s, count = 1) => rep(file, find, s + '\n' + find, count);
const after  = (file, find, s, count = 1) => rep(file, find, find + '\n' + s, count);

// ── combatlog.js ──
before(CL, 'function buildSimulation(aq, quest) {', snip('cl_simenv.txt') + '\n');
after(CL, '  const seed = aq.startedAt;', snip('cl_se_decl.txt'));
rep(CL, 'let dmgBonus = 1 + (Game.getDmgBonus ? Game.getDmgBonus(aq.questId) : 0);', 'let dmgBonus = 1 + SE.getDmgBonus(aq.questId);');
rep(CL, 'const dmgReduction = Game.getDmgReduction ? Game.getDmgReduction(aq.questId) : 0;', 'const dmgReduction = SE.getDmgReduction(aq.questId);');
rep(CL, 'let atkSpeedBonus = Game.getAtkSpeedBonus ? Game.getAtkSpeedBonus(aq.questId) : 0;', 'let atkSpeedBonus = SE.getAtkSpeedBonus(aq.questId);');
rep(CL, 'const _ht = (id) => Game.hasTalent ? Game.hasTalent(id) : false;', 'const _ht = (id) => SE.hasTalent(id);');
rep(CL, 'const simAuras = Game.getPartyAuras ? Game.getPartyAuras() : null;', 'const simAuras = SE.getPartyAuras();');
rep(CL, 'Game.getHealBonus ? Game.getHealBonus(aq.questId) : 0', 'SE.getHealBonus(aq.questId)', 2);
rep(CL, 'const member = Game.getMember(m.id);', 'const member = SE.effStats(m.id, simAuras);');
rep(CL, 'const eff = member ? Game.effectiveStats(member, simAuras) : m.stats;', 'const eff = member || m.stats;');
rep(CL, 'const member = Game.getMember(p.id);', 'const _eq = SE.equipment(p.id);\n      const member = _eq ? { equipment: _eq } : null;');
rep(CL, 'Game.getActiveMemberSkills ? Game.getActiveMemberSkills(p.id) : []', 'SE.skills(p.id)');
rep(CL, 'Game.getActiveMemberSkills ? Game.getActiveMemberSkills(m.id) : []', 'SE.skills(m.id)', 3);
rep(CL, '  for (let i = 0; i < MAX_BATTLE_EVENTS; i++) {', snip('cl_manual_helpers.txt') + '\n' + snip('cl_loop_label.txt'));
before(CL, '      const _enemiesAlivePre = enemies.filter(e => e.alive).length;', snip('cl_reset_target.txt'));
rep(CL, '          let skillPool = memberAttackSkills[attacker.id].filter(sid => !skillCooldowns[attacker.id][sid]);', snip('cl_attack_hook.txt'));
rep(CL, 'const skillId = sPick(skillPool, es + 200);', 'const skillId = manualPick ? manualPick.skillId : sPick(skillPool, es + 200);');
rep(CL, 'if (skill && atkProcRoll < atkProcThreshold) {', 'if (skill && (manualPick || atkProcRoll < atkProcThreshold)) {');
for (const n of [100, 207, 208, 217, 250, 403]) rep(CL, `sPick(livingEnemies, es + ${n})`, `pickTarget(livingEnemies, es + ${n})`);
rep(CL, 'sPick(livingEnemies, es + 211)', 'pickTarget(livingEnemies, es + 211)', 2);
rep(CL, '        const skillPool = readySkills.length > 0 ? readySkills : buffSkills;', snip('cl_buff_hook.txt'));
rep(CL, 'if (skill && buffProcRoll < buffProcThreshold) {', 'if (skill && (manualBuffPick || buffProcRoll < buffProcThreshold)) {');
before(CL, '  _combatDebug.atb.totalRounds = roundCount;', snip('cl_pause_return.txt'));
rep(CL, 'let _simQuestId = null;', 'let _simQuestId = null;\nlet _simKey = null;');
before(CL, 'function ensureSim() {', snip('cl_ensure_helpers.txt'));
rep(CL, '  if (_simQuestId !== aq.questId) {', '  if (_simQuestId !== aq.questId || _simKey !== manualSimKey(aq)) {');
rep(CL, '      _simQuestId = aq.questId;', '      _simQuestId = aq.questId;\n      _simKey = manualSimKey(aq);\n      if (aq.battleMode === \'manual\') syncManualInfo(_sim);');
after(CL, '  const interval = sim.effectiveInterval || EVENT_INTERVAL;', snip('cl_visible_manual.txt'));
after(CL, '    fastForwardMs: FAST_FORWARD_INTERVAL * 1000,', '    awaitingInput: !!sim.pending,');
rep(CL, '  return _sim ? _sim.battleOutcome : null;', snip('cl_outcome.txt').split('\n').slice(1, -1).join('\n'));
before(CL, 'export function resetCombatLog() {', snip('cl_exports.txt'));

// ── game.js ──
after(GM, '      autoRun: null,', snip('game_newstate.txt'));
before(GM, "      if (!state.tutorial) state.tutorial = { step: 0, dismissed: true };", snip('game_load_default.txt'));
rep(GM, '  function startQuest(questId) {', snip('game_start_head.txt'));
before(GM, '    logEvent(`Party departed for: ${quest.title}`);', snip('game_start_manual.txt'));
before(GM, '  function resolveIdle() {', snip('game_capture_env.txt') + '\n' + snip('game_manual_api.txt'));
rep(GM, '  function setQuestEventCount(count, intervalMs, decisiveIndex, fastForwardMs) {', snip('game_set_event_count.txt'));
after(GM, '      state.guild.activeQuest.fastForwardMs = fastForwardMs || 80;', snip('game_awaiting_line.txt'));
before(GM, '    const elapsed = Date.now() - aq.startedAt;', snip('game_revealed_manual.txt'));
before(GM, '    return questEventsRevealed() >= aq.eventCount;', snip('game_complete_manual.txt'));
before(GM, '    return Math.min(1, revealed / aq.eventCount);', snip('game_progress_manual.txt'));
rep(GM, '  function finishQuest() {', snip('game_finish_guard.txt'));
rep(GM, '    startQuest, finishQuest, resolveIdle, startTick, stopTick,', '    startQuest, finishQuest, resolveIdle, startTick, stopTick, questElapsedMs, setBattleMode,');

// ── ui/quests.js ──
rep(Q, "import { generateCombatLog, getCombatSnapshot, getQuestPhase, getPhases, resetCombatLog, getSimInfo } from './combatlog.js';",
  "import { generateCombatLog, getCombatSnapshot, getQuestPhase, getPhases, resetCombatLog, getSimInfo, getPendingDecision, submitManualChoice, autoResolveManualBattle } from './combatlog.js';");
rep(Q, 'simInfo.fastForwardMs)', 'simInfo.fastForwardMs, simInfo.awaitingInput)', 2);
rep(Q, 'Game.startQuest(btn.dataset.questId);', 'Game.startQuest(btn.dataset.questId, { battleMode: Game.state.battleMode });');
before(Q, '  const partyStr = Game.getPartyStrength();', snip('ui_mode_picker.txt'));
before(Q, '      ${strategyPicker}', snip('ui_mode_picker_use.txt'));
before(Q, "  const stopBtn = el.querySelector('.btn-ar-stop');", snip('ui_mode_bind.txt'));
before(Q, '          <div class="aq-combat-log-section">', snip('ui_panel_host.txt'));
before(Q, 'function renderActiveQuestView(s) {', snip('ui_manual_panel.txt'));
after(Q, '  bindEvents(el, setTabCallback);', snip('ui_after_render.txt'));
before(Q, "  const phaseEl = document.getElementById('aq-phase-label');", snip('ui_tick_hook.txt'));

// ── ui/hall.js ──
before(H, 'function _updateHall(el) {', snip('ui_hall_timer.txt'));
rep(H, 'timerEl.textContent = `${Math.min(revealed, total)} / ${total}`;', 'timerEl.textContent = questTimerText(aq, revealed, total);');
rep(H, '<div class="quest-timer" id="quest-timer">${Math.min(revealed, total)} / ${total}</div>', '<div class="quest-timer" id="quest-timer">${questTimerText(aq, revealed, total)}</div>');

// ── run ──
const texts = {};
for (const f of new Set(E.map(e => e.file))) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.error('Missing file: ' + p + '\nRun this from the repo root (or pass the root as an argument).'); process.exit(1); }
  texts[f] = fs.readFileSync(p, 'utf8');
}
if (texts[CL].includes('function manualTurn(')) { console.log('Manual mode patch already applied - nothing to do.'); process.exit(0); }
let bad = 0;
for (const e of E) {
  const parts = texts[e.file].split(e.find);
  const n = parts.length - 1;
  if (n !== e.count) { console.error(`FAILED  ${e.file}: expected ${e.count} match(es), found ${n} for:\n    ${e.find.slice(0, 110)}`); bad++; continue; }
  texts[e.file] = parts.join(e.to);
}
if (bad) { console.error(`\n${bad} edit(s) failed. No files were changed.`); process.exit(1); }
texts[CSS] = fs.readFileSync(path.join(root, CSS), 'utf8') + fs.readFileSync(path.join(here, 'style_manual.css'), 'utf8');
for (const [f, t] of Object.entries(texts)) fs.writeFileSync(path.join(root, f), t);
console.log(`Manual mode patch applied: ${E.length} edits across ${Object.keys(texts).length} files.`);
