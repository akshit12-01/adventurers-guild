// Combat Log Generator — v3 (outcome-driven)
// Simulates a full battle that runs until one side is eliminated.
// Events are revealed one at a time; the quest finishes when the last event plays.
// All deterministic via seeded random so re-renders produce identical results.

import Game from '../game.js';
import { getQuest, getClass, randInt, getItem } from '../data.js';
import { getSkill } from '../skills.js';
import { esc } from '../util.js';
import { RANK_SCALES, SUB_TIER_MULTIPLIERS, RANK_ENEMY_COUNT, BOSS_ROLE_MULTS, BOSS_COMPOSITIONS, RAID_COMPOSITIONS, BRUTAL_PROMOTION, WEAPON_PROC_SCALAR, CELESTIAL_PROC_COOLDOWN } from '../data/rankScales.js';

// ── Phases are now structural markers, not progress-based ──────────────
const PHASES = [
  { id: 'travel',    label: 'Traveling',    icon: '🗺' },
  { id: 'encounter', label: 'Encounter',    icon: '👁' },
  { id: 'battle',    label: 'Battle',       icon: '⚔' },
  { id: 'resolve',   label: 'Resolution',   icon: '✦' },
];

export function getPhases() { return PHASES; }

export function getQuestPhase(progress) {
  // Map progress [0..1] to a phase for the phase tracker dots
  if (progress < 0.10) return PHASES[0];
  if (progress < 0.20) return PHASES[1];
  if (progress < 0.90) return PHASES[2];
  return PHASES[3];
}

// ── Event interval (seconds between revealed events) ────────────────────
export const EVENT_INTERVAL = 1.0;

// ── Seeded random ───────────────────────────────────────────────────────
function sRand(seed) {
  let x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}
function sPick(arr, seed) { return arr[Math.floor(sRand(seed) * arr.length)]; }
function sInt(min, max, seed) { return Math.floor(sRand(seed) * (max - min + 1)) + min; }

// ─────────────────────────────────────────────────────────────────────────
// COMBAT_TUNING — single source of truth for core combat knobs
// ─────────────────────────────────────────────────────────────────────────
// This object holds the global numeric levers used by the combat engine.
// Changing a value here applies everywhere the knob is referenced, and no
// deeper code edits are required for a simple pass. The companion design
// doc `combat-tuning-design.md` describes what each knob is intended to
// control and what the target ranges are for each tuning phase.
//
// IMPORTANT — what is NOT in here:
//   • Class-specific ability literals (e.g. Pressure Point 1.7× ATK,
//     Ki Shield 10% max HP, Flowing Strike 1.5× ATK, Shadow Bolt 1.3×).
//     These are class design decisions and live at the skill's code site
//     with a "INLINED BY DESIGN" comment explaining why. If a class
//     ability feels mis-tuned, change it at the skill site, not here.
//   • Talent-gated multipliers (Chain Strike, Cel Cascade, etc.). Same
//     reasoning — they belong to the class-rework-design.md domain.
//   • Per-enemy / per-quest scaling. Encounter generation lives in
//     buildSimulation's enemy generator and is tuned separately.
//
// If in doubt: if the number is universal to all attacks / heals /
// defenses regardless of who's using them, it goes here. If it's a
// specific ability's signature damage or effect, it stays inline.
// ─────────────────────────────────────────────────────────────────────────
const COMBAT_TUNING = {
  // ── ATB SYSTEM ────────────────────────────────────────────────────────
  // Gauge fill threshold that must be reached before an actor may act on
  // their lane (attack / buff / heal). Each tick fills the gauge by a
  // speed-derived amount; higher thresholds slow the cadence of actions.
  ATB_THRESHOLD: 100,

  // Default rounds of cooldown applied after any skill fires. Individual
  // skills may override this at their call site if they need shorter or
  // longer cooldowns, but the baseline is here.
  SKILL_COOLDOWN_DEFAULT: 2,

  // ── HEAL LANE THRESHOLDS ──────────────────────────────────────────────
  // Any ally below HEAL_TRIGGER_PCT of their max HP will cause healers
  // with a ready gauge to fire. Lower values delay heals (more drama,
  // more risk); higher values trigger heals earlier (safer parties).
  HEAL_TRIGGER_PCT: 0.70,

  // Emergency bypass — if any ally drops below this HP%, healers fire
  // immediately even if their ATB gauge is not full (the gauge is
  // snapped to threshold for the current tick). This is the safety net
  // that prevents one-shot wipes from reactive saves failing.
  HEAL_EMERGENCY_PCT: 0.35,

  // ── PARTY DAMAGE FORMULA (calcPartyDmg) ───────────────────────────────
  // Base party damage = stat * (PARTY_DMG_MIN_MULT + rand * PARTY_DMG_SPREAD)
  // At the defaults, a hit lands in the 1.8–2.8× stat range. Compressing
  // the spread (lowering PARTY_DMG_SPREAD) makes outcomes more predictable
  // and reduces skill-proc / crit variance on short fights.
  PARTY_DMG_MIN_MULT: 1.8,
  PARTY_DMG_SPREAD: 1.0,

  // Party crit damage multiplier applied to standard attacks (excludes
  // Crescendo / Crescendo-ally bursts, which override this at the call
  // site with higher multipliers).
  PARTY_BASE_CRIT_MULT: 1.5,

  // ── ENEMY DAMAGE FORMULA ──────────────────────────────────────────────
  // Enemy raw damage = atk * (ENEMY_DMG_MIN_MULT + rand * ENEMY_DMG_SPREAD)
  // Defaults of 0.5 / 0.7 give a 0.5–1.2× swing, which produces the
  // "boss one-shots the squishy, whiffs on the tank" extremes that
  // currently break healing. See §4.1 of combat-tuning-design.md for
  // the proposed compression to 0.80 / 0.40.
  ENEMY_DMG_MIN_MULT: 0.5,
  ENEMY_DMG_SPREAD: 0.7,

  // Chance an enemy attack is flagged as a "skill" (narrative only —
  // mechanically just adds the ENEMY_SKILL_DMG_MULT bonus).
  ENEMY_SKILL_PROC_CHANCE: 0.35,

  // Multiplier applied when an enemy attack is flagged as a skill.
  // §4.1 of the tuning doc proposes lowering this from 1.5 to 1.3 to
  // soften boss burst spikes.
  ENEMY_SKILL_DMG_MULT: 1.5,

  // Enemy crit damage multiplier (applied during the party-side
  // minion-target fallback damage path — enemies do not crit the party
  // directly in the current build, but this is reserved for symmetry).
  ENEMY_CRIT_MULT: 1.5,

  // ── DEF / CRIT / DODGE CURVES ────────────────────────────────────────
  // All three stats use a soft-cap curve: effect = stat / (stat + softcap).
  // Increasing the softcap makes the stat less impactful; lowering it
  // makes it more impactful. Caps prevent total immunity at extreme
  // stat values.
  //
  // At DEF_SOFTCAP 60: 10 DEF → 14% reduction, 30 DEF → 33%, 60 DEF → 50%.
  DEF_SOFTCAP: 60,
  // At CRIT_SOFTCAP 100: 10 CRIT → 9%, 20 → 17%, 50 → 33%.
  CRIT_SOFTCAP: 100,
  CRIT_CAP: 0.75,
  // At DODGE_SOFTCAP 80: 10 DDG → 11%, 20 → 20%, 40 → 33%.
  DODGE_SOFTCAP: 80,
  DODGE_CAP: 0.75,

  // ── HEAL FORMULA ─────────────────────────────────────────────────────
  // Base heal = magStat * (HEAL_MAG_MIN_MULT + rand * HEAL_MAG_SPREAD).
  // At the defaults, a 100-MAG Cleric heals for ~150–250 per cast.
  // §4.5 of the tuning doc proposes a throughput floor tied to recent
  // incoming damage, which would be layered on top of this base.
  HEAL_MAG_MIN_MULT: 1.5,
  HEAL_MAG_SPREAD: 1.0,
};

// ── Event text templates ────────────────────────────────────────────────
const T_TRAVEL = [
  (m, env) => `${m} leads the party through ${env}.`,
  (m, env) => `The path to ${env} is quiet... for now.`,
  (m, env) => `${m} scouts ahead as the party enters ${env}.`,
  (m, env) => `Footsteps echo as the party nears ${env}.`,
  (m, env) => `The air grows tense near ${env}. ${m} grips their weapon.`,
  (m, env) => `${m} notices tracks on the ground — something has been here recently.`,
  (m, env) => `The party moves in formation through ${env}.`,
];
const T_ENCOUNTER = [
  (m, e) => `${m} spots ${e} lurking ahead!`,
  (m, e) => `A wild ${e} appears from the shadows!`,
  (m, e) => `${m} raises an alarm — ${e} blocks the path!`,
  (m, e) => `The ground trembles. ${e} emerges!`,
  (m, e) => `${m} draws their weapon as ${e} charges!`,
  (m, e) => `Ambush! ${e} leaps from cover toward ${m}!`,
];
const T_RESOLVE_WIN = [
  (m) => `${m} surveys the battlefield — victory is theirs!`,
  (m) => `The last enemies fall. ${m} signals the all-clear.`,
  () => `The battle is won. The party gathers their spoils.`,
  (m) => `${m} sheathes their weapon as the dust settles.`,
];
const T_RESOLVE_LOSE = [
  (m) => `${m} falls to their knees... the party is overwhelmed.`,
  () => `The party retreats, battered and broken.`,
  (m) => `${m} drags the wounded to safety as hope fades.`,
];

// ── Class-specific attack templates ────────────────────────────────────
// Each class gets its own flavor. Fallback T_ATTACK used for unknown classes.
const T_ATTACK_HERO = [
  (m, e, dmg) => `${m} slashes ${e} with a swift blade — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} charges ${e} with a mighty strike — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} lunges forward, cutting ${e} for <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} follows up with a swift combo on ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
const T_ATTACK_KNIGHT = [
  (m, e, dmg) => `${m} delivers a crushing overhead blow to ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} shield-bashes ${e} and follows with a heavy slash — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} drives their sword through ${e}'s guard — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} charges ${e} in full plate — <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
const T_ATTACK_MAGE = [
  (m, e, dmg) => `${m} hurls a bolt of arcane fire at ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} conjures a shard of ice that pierces ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `Arcane energy crackles from ${m}'s staff, striking ${e} for <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} channels a lightning bolt at ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
];
const T_ATTACK_ROGUE = [
  (m, e, dmg) => `${m} darts behind ${e} and stabs deep — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} flicks a dagger into ${e}'s weak spot — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} slips through ${e}'s defenses with a quick stab — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} strikes from the shadows, piercing ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
// Cleric basic-attack flavor avoids skill names (Smite, Holy Light, etc.) so
// the narrative never suggests a class skill fired when it didn't.
const T_ATTACK_CLERIC = [
  (m, e, dmg) => `${m} swings their mace into ${e}'s guard — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} brings their mace down on ${e} with a solemn oath — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} cracks their mace across ${e}'s flank — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} lands a steady, faithful blow on ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
];
const T_ATTACK_RANGER = [
  (m, e, dmg) => `${m} looses an arrow that pierces ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} lines up a precise shot and hits ${e} for <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `An arrow whistles from ${m}'s bow, striking ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} fires a rapid volley at ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
const T_ATTACK_BARD = [
  (m, e, dmg) => `${m} strikes a dissonant chord that rattles ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} sings a piercing note — sonic energy blasts ${e} for <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `${m} strums a war melody, sending a shockwave into ${e} — <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (m, e, dmg) => `A cutting verse from ${m} strikes ${e} for <span class="dmg-num dmg-mag">${dmg}</span>!`,
];
const T_ATTACK_MONK = [
  (m, e, dmg) => `${m} delivers a flurry of fists to ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} lands a devastating palm strike on ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} sweeps ${e}'s legs and follows with an elbow strike — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} channels ki into a crushing blow against ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
];

// Fallback for unknown classes
const T_ATTACK = [
  (m, e, dmg) => `${m} strikes ${e} for <span class="dmg-num dmg-phys">${dmg}</span> damage!`,
  (m, e, dmg) => `${m} lands a clean hit on ${e} — <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (m, e, dmg) => `${m} attacks ${e}, dealing <span class="dmg-num dmg-phys">${dmg}</span> damage!`,
];

// Map class IDs to their template sets
const CLASS_ATTACK_TEMPLATES = {
  HERO: T_ATTACK_HERO, KNIGHT: T_ATTACK_KNIGHT, MAGE: T_ATTACK_MAGE,
  ROGUE: T_ATTACK_ROGUE, CLERIC: T_ATTACK_CLERIC, RANGER: T_ATTACK_RANGER,
  BARD: T_ATTACK_BARD, MONK: T_ATTACK_MONK,
};
// Magic-style classes (use ✨ icon instead of ⚔)
const MAGIC_CLASSES = new Set(['MAGE', 'CLERIC', 'BARD', 'NECROMANCER']);

function getAttackTemplate(classId, seed) {
  const templates = CLASS_ATTACK_TEMPLATES[classId] || T_ATTACK;
  return sPick(templates, seed);
}
function isMagicClass(classId) { return MAGIC_CLASSES.has(classId); }

const T_SKILL = [
  (m, sk, e, dmg) => `${m} activates <strong>${sk}</strong> on ${e} — <span class="dmg-num dmg-skill">${dmg}</span>!`,
  (m, sk, e, dmg) => `${m} unleashes <strong>${sk}</strong> — ${e} takes <span class="dmg-num dmg-skill">${dmg}</span>!`,
  (m, sk, e, dmg) => `The power of <strong>${sk}</strong> surges through ${m} — <span class="dmg-num dmg-skill">${dmg}</span> to ${e}!`,
];

// ── Non-celestial equipment proc templates (purple styling) ─────────
const T_EQUIP_SKILL = [
  (m, sk, e, dmg) => `${m}'s gear surges — <strong>${sk}</strong> strikes ${e} for <span class="dmg-num dmg-equip">${dmg}</span>!`,
  (m, sk, e, dmg) => `<strong>${sk}</strong> activates! ${m}'s weapon flares, hitting ${e} for <span class="dmg-num dmg-equip">${dmg}</span>!`,
  (m, sk, e, dmg) => `${m} triggers <strong>${sk}</strong> — enchanted energy slams ${e} for <span class="dmg-num dmg-equip">${dmg}</span>!`,
];

// ── Celestial equipment proc templates (teal glow styling) ──────────
const T_CELESTIAL_SKILL = [
  (m, sk, e, dmg) => `${m} channels <strong>${sk}</strong> — celestial energy engulfs ${e} for <span class="dmg-num dmg-celestial">${dmg}</span>!`,
  (m, sk, e, dmg) => `The heavens answer ${m}! <strong>${sk}</strong> strikes ${e} — <span class="dmg-num dmg-celestial">${dmg}</span>!`,
  (m, sk, e, dmg) => `Divine radiance erupts from ${m}'s gear — <strong>${sk}</strong> obliterates ${e} for <span class="dmg-num dmg-celestial">${dmg}</span>!`,
];

// ── Non-damaging equipment buff procs (empower next action) ─────────
const T_EQUIP_BUFF = [
  (m, sk) => `${m}'s gear surges — <strong>${sk}</strong> empowers their next action!`,
  (m, sk) => `<strong>${sk}</strong> activates! ${m} is wreathed in energy — their next blow will devastate!`,
  (m, sk) => `${m} triggers <strong>${sk}</strong> — arcane force coils, waiting to amplify the next strike!`,
];
const T_CELESTIAL_BUFF = [
  (m, sk) => `${m} channels <strong>${sk}</strong> — celestial power gathers for their next action!`,
  (m, sk) => `The heavens answer ${m}! <strong>${sk}</strong> readies divine force for the next blow!`,
  (m, sk) => `Celestial radiance blooms around ${m} — <strong>${sk}</strong> will overflow into their next action!`,
];

// ── Cleric heal templates (direct group heal) ────────────────────────
const T_HEAL_CLERIC = [
  (m, hp) => `${m} invokes a prayer of restoration — party recovers <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (m, hp) => `Divine light radiates from ${m}, healing the party for <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (m, hp) => `${m} lays hands on the wounded — <span class="dmg-num dmg-heal">+${hp}</span> HP restored!`,
];
function getHealTemplate(seed) { return sPick(T_HEAL_CLERIC, seed); }

// ── Bard regen templates (weaker but persistent) ─────────────────────
const T_BARD_REGEN = [
  (m, hp) => `${m} plays an invigorating melody — the party gains <span class="dmg-num dmg-heal">+${hp}</span> HP regen per round!`,
  (m, hp) => `${m} strums a restorative chord — party regenerates <span class="dmg-num dmg-heal">+${hp}</span> HP each round!`,
  (m, hp) => `A soothing song from ${m} washes over the party — <span class="dmg-num dmg-heal">+${hp}</span> HP regen!`,
];
const T_REGEN_TICK = [
  (hp) => `The party recovers <span class="dmg-num dmg-heal">+${hp}</span> HP from the bard's melody.`,
  (hp) => `The lingering song restores <span class="dmg-num dmg-heal">+${hp}</span> HP to the party.`,
];

// ── Knight Bulwark templates ──────────────────────────────────────────
const T_BULWARK = [
  (knight, ally, dmg) => `${knight} leaps in front of ${ally}, absorbing <span class="dmg-num dmg-block">${dmg}</span> damage!`,
  (knight, ally, dmg) => `${knight} throws themselves between ${ally} and the blow — <span class="dmg-num dmg-block">${dmg}</span> taken!`,
  (knight, ally, dmg) => `"Not on my watch!" ${knight} shields ${ally}, taking <span class="dmg-num dmg-block">${dmg}</span> damage!`,
];
// ── Hero Rally Cry templates ─────────────────────────────────────────
const T_RALLY_CRY = [
  (hero, ally, hp) => `${hero} shouts a Rally Cry! ${ally} is reinvigorated — <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (hero, ally, hp) => `"Fight on!" ${hero} rallies ${ally} back from the brink — <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (hero, ally, hp) => `${hero}'s inspiring cry reaches ${ally} — <span class="dmg-num dmg-heal">+${hp}</span> HP restored!`,
];
// ── Rogue Mark for Death templates ──────────────────────────────────
const T_MARK_FOR_DEATH = [
  (rogue, target) => `${rogue} exposes a weakness — ${target} is <span class="sk-debuff">Marked for Death</span>!`,
  (rogue, target) => `${rogue}'s critical strike reveals a vulnerability — ${target} is <span class="sk-debuff">Marked</span>!`,
  (rogue, target) => `"There!" ${rogue} marks ${target}'s weak point — <span class="sk-debuff">+20% damage taken</span>!`,
];
// Pluralization helpers for AoE templates — "1 foe" vs "3 foes"
const _f = (n) => n === 1 ? 'foe' : 'foes';
const _e = (n) => n === 1 ? 'enemy' : 'enemies';
const _t = (n) => n === 1 ? 'target' : 'targets';
const _ea = (n) => n === 1 ? '' : ' each';
// ── Ranger Volley templates ─────────────────────────────────────────
const T_VOLLEY = [
  (name, count, dmg) => `${name} launches a Volley — arrows rain on <span class="dmg-num dmg-ally">${count}</span> ${_e(count)} for <span class="dmg-num dmg-ally">${dmg}</span>${_ea(count)}!`,
  (name, count, dmg) => `${name} darkens the sky! Volley hits <span class="dmg-num dmg-ally">${count}</span> ${_f(count)} for <span class="dmg-num dmg-ally">${dmg}</span>${_ea(count)}!`,
  (name, count, dmg) => `A rain of arrows from ${name} strikes <span class="dmg-num dmg-ally">${count}</span> ${_e(count)} — <span class="dmg-num dmg-ally">${dmg}</span> damage${_ea(count)}!`,
];
const T_MAGE_AOE = [
  (name, skill, count, dmg) => `${name} unleashes ${skill} — arcane devastation hits <span class="dmg-num dmg-mag">${count}</span> ${_e(count)} for <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} casts ${skill}! Magical destruction rains on <span class="dmg-num dmg-mag">${count}</span> ${_f(count)} — <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `The air shatters as ${name} channels ${skill} — <span class="dmg-num dmg-mag">${count}</span> ${_e(count)} take <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
];
const T_MONK_AOE = [
  (name, skill, count, dmg) => `${name} blurs into a flurry of ${skill} — <span class="dmg-num dmg-phys">${count}</span> ${_e(count)} ${count === 1 ? 'is' : 'are'} battered for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} unleashes ${skill}! Rapid strikes pummel <span class="dmg-num dmg-phys">${count}</span> ${_f(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `A whirlwind of fists — ${name}'s ${skill} lands on <span class="dmg-num dmg-phys">${count}</span> ${_e(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
];
const T_CLERIC_AOE = [
  (name, skill, count, dmg) => `${name} calls down ${skill} — pillars of holy fire scour <span class="dmg-num dmg-mag">${count}</span> ${_f(count)} for <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} unleashes ${skill}! Sacred flame consumes <span class="dmg-num dmg-mag">${count}</span> ${_e(count)} for <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `A radiant blaze erupts as ${name} invokes ${skill} — <span class="dmg-num dmg-mag">${count}</span> ${_t(count)} burn for <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
];
const T_HERO_AOE = [
  (name, skill, count, dmg) => `${name} becomes a blur as ${skill} erupts — <span class="dmg-num dmg-phys">${count}</span> ${_f(count)} ${count === 1 ? 'is' : 'are'} cut down for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} unleashes ${skill}! Steel flashes through <span class="dmg-num dmg-phys">${count}</span> ${_e(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `A dazzling spin of blades — ${name}'s ${skill} sweeps <span class="dmg-num dmg-phys">${count}</span> ${_f(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
];
const T_ROGUE_AOE = [
  (name, skill, count, dmg) => `${name} spins and hurls ${skill} — <span class="dmg-num dmg-phys">${count}</span> ${_f(count)} ${count === 1 ? 'is' : 'are'} shredded for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} unleashes ${skill}! Blades whirl through <span class="dmg-num dmg-phys">${count}</span> ${_e(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `A glittering arc of steel — ${name}'s ${skill} slices <span class="dmg-num dmg-phys">${count}</span> ${_t(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
];
const T_RANGER_AOE = [
  (name, skill, count, dmg) => `${name} fires ${skill} — a storm of arrows hits <span class="dmg-num dmg-ally">${count}</span> ${_e(count)} for <span class="dmg-num dmg-ally">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} unleashes ${skill}! <span class="dmg-num dmg-ally">${count}</span> ${_f(count)} ${count === 1 ? 'is' : 'are'} struck for <span class="dmg-num dmg-ally">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `Arrows fly as ${name} activates ${skill} — <span class="dmg-num dmg-ally">${count}</span> ${_t(count)} take <span class="dmg-num dmg-ally">${dmg}</span>${_ea(count)}!`,
];
const T_KNIGHT_AOE = [
  (name, skill, count, dmg) => `${name} executes ${skill} — a wide arc cleaves <span class="dmg-num dmg-phys">${count}</span> ${_e(count)} for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `${name} swings ${skill}! <span class="dmg-num dmg-phys">${count}</span> ${_f(count)} ${count === 1 ? 'is' : 'are'} battered for <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
  (name, skill, count, dmg) => `Steel whirls as ${name}'s ${skill} sweeps the line — <span class="dmg-num dmg-phys">${count}</span> ${_t(count)} take <span class="dmg-num dmg-phys">${dmg}</span>${_ea(count)}!`,
];

// ── AoE skill registry ──
// Skills that hit ALL living enemies instead of a single target.
// dmgScale: fraction of normal attack damage applied per target (lower since it hits everyone)
const AOE_SKILLS = {
  // Ranger AoE
  VOLLEY:               { dmgScale: 0.60, templates: T_VOLLEY,     icon: '🎯', type: 'skill',     triggerCamo: true },
  ARROW_STORM:          { dmgScale: 0.75, templates: T_RANGER_AOE, icon: '🌧', type: 'skill',     triggerCamo: true },
  STORM_VOLLEY:         { dmgScale: 0.65, templates: T_RANGER_AOE, icon: '⚡', type: 'equip',     triggerCamo: true },
  CELESTIAL_VOLLEY:     { dmgScale: 0.70, templates: T_RANGER_AOE, icon: '🌠', type: 'equip',     triggerCamo: true },
  CEL_CELESTIAL_BARRAGE:{ dmgScale: 0.80, templates: T_RANGER_AOE, icon: '🌠', type: 'celestial', triggerCamo: true },
  // CEL_STARFIRE_VOLLEY removed — Constellation Quiver is a passive aura, not a combat AoE.
  // Mage AoE
  // ARCANE_CATACLYSM retired — replaced by Arcane Construct (pet). Legacy saves
  // with the old skill auto-upgrade; the AoE entry is removed.
  // BLIZZARD — L10 MAG-scaled AoE (§3.3 Mage rework, swapped from L6 with
  // Arcane Construct to boost early Mage survivability).
  BLIZZARD:             { dmgScale: 0.55, templates: T_MAGE_AOE, icon: '🌨', type: 'skill',     triggerCamo: false },
  FROSTBITE:            { dmgScale: 0.50, templates: T_MAGE_AOE, icon: '❄',  type: 'skill',     triggerCamo: false },
  METEOR_STORM:         { dmgScale: 0.70, templates: T_MAGE_AOE, icon: '☄',  type: 'skill',     triggerCamo: false },
  VOID_BURST:            { dmgScale: 0.45, templates: T_MAGE_AOE, icon: '🌀', type: 'equip',     triggerCamo: false },
  ARCANE_CATACLYSM_EQ:  { dmgScale: 0.50, templates: T_MAGE_AOE, icon: '💥', type: 'equip',     triggerCamo: false },
  CEL_ARCANUM_CATACLYSM:{ dmgScale: 0.60, templates: T_MAGE_AOE, icon: '💥', type: 'celestial', triggerCamo: false },
  // Monk AoE (class rework — Hundred Fists L6 class-defining workhorse)
  HUNDRED_FISTS:        { dmgScale: 0.55, templates: T_MONK_AOE, icon: '👊', type: 'skill',     triggerCamo: false },
  // Knight AoE (class rework — Sweeping Blow L10 capstone damage)
  SWEEPING_BLOW:        { dmgScale: 0.55, templates: T_KNIGHT_AOE, icon: '⚔', type: 'skill',   triggerCamo: false },
  // Knight epic/legendary weapon procs reverted to ST (v=126). Only Celestial is AoE.
  // HOLY_SMITE, GUARDIAN_AURA, DIVINE_JUDGEMENT, SANCTUM_BARRIER — now ST weapon procs
  // (handled by the standard weapon proc path with defScaling).
  CEL_BASTION_SMITE:    { dmgScale: 0.65, templates: T_KNIGHT_AOE, icon: '⚔', type: 'celestial', triggerCamo: false },
  // Rogue AoE (class rework — Fan of Knives L6 class-defining AoE)
  FAN_OF_KNIVES:        { dmgScale: 0.50, templates: T_ROGUE_AOE, icon: '🗡', type: 'skill',    triggerCamo: false },
  // Cleric AoE (class rework — Consecration L10 AoE + party buff, Righteous Burn L18 EPIC)
  CONSECRATION:         { dmgScale: 0.50, templates: T_CLERIC_AOE, icon: '🌅', type: 'skill',   triggerCamo: false },
  RIGHTEOUS_BURN:       { dmgScale: 0.60, templates: T_CLERIC_AOE, icon: '🔥', type: 'skill',   triggerCamo: false },
  // Hero AoE (class rework — Sword Dance L6, class-defining AoE)
  SWORD_DANCE:          { dmgScale: 0.55, templates: T_HERO_AOE, icon: '⚔', type: 'skill',    triggerCamo: false },
  // Hero AoE legacy (retired — kept for save compatibility / talent hook)
  WHIRLWIND_DANCE:      { dmgScale: 0.55, templates: T_HERO_AOE, icon: '🌀', type: 'skill',    triggerCamo: false },
};
// ── Mage Arcane Construct templates ─────────────────────────────────
const T_CONSTRUCT_SUMMON = [
  (name) => `${name} conjures an <span class="sk-magic">Arcane Construct</span> — crystallized magic takes form as a guardian!`,
  (name) => `An <span class="sk-magic">Arcane Construct</span> materializes at ${name}'s side — pure arcane energy given shape!`,
];
const T_CONSTRUCT_PULSE = [
  (dmg, count) => `The Arcane Construct unleashes an <span class="sk-magic">Arcane Pulse</span> — <span class="dmg-num dmg-mag">${dmg}</span> damage rips through ${count} ${count === 1 ? 'foe' : 'foes'}!`,
  (dmg, count) => `Arcane energy erupts from the Construct — <span class="dmg-num dmg-mag">${dmg}</span> damage sweeps across ${count} ${count === 1 ? 'enemy' : 'enemies'}!`,
];
const T_CONSTRUCT_DEATH = [
  () => `The Arcane Construct shatters into motes of light — its magic spent.`,
];
const T_CONSTRUCT_RESUMMON = [
  (name) => `${name} reweaves the shattered magic — the <span class="sk-magic">Arcane Construct</span> reforms!`,
];

// ── Necromancer templates ───────────────────────────────────────────
const T_RAISE_DEAD = [
  (name, minion) => `${name} tears a fallen ${minion} from death's embrace — <span class="sk-magic">it rises as a thrall!</span>`,
  (name, minion) => `${name} commands the corpse of ${minion} to rise — <span class="sk-magic">the dead obey!</span>`,
];
const T_MINION_ATTACK = [
  (minion, target, dmg) => `${minion} claws at ${target} — <span class="dmg-num dmg-mag">${dmg}</span> damage!`,
  (minion, target, dmg) => `${minion} shambles toward ${target} and strikes — <span class="dmg-num dmg-mag">${dmg}</span>!`,
];
const T_MINION_DEATH = [
  (minion) => `${minion} crumbles to dust — its stolen life spent.`,
];
const T_BLIGHT_DOT = [
  (dmg, count) => `Necrotic Blight corrodes <span class="dmg-num dmg-mag">${count}</span> ${_e(count)} for <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (dmg, count) => `Blight eats away at <span class="dmg-num dmg-mag">${count}</span> ${_f(count)} — <span class="dmg-num dmg-mag">${dmg}</span> necrotic damage${_ea(count)}!`,
];
const T_DARK_PACT = [
  (name) => `${name} weaves a <span class="sk-magic">Dark Pact</span> — life siphon active (drain + heal for 3 rounds)!`,
  (name) => `A <span class="sk-magic">Dark Pact</span> takes hold — ${name} channels life-draining magic (siphon for 3 rounds)!`,
];
const T_SHADOW_BOLT = [
  (name, target, dmg) => `${name} hurls a <span class="sk-magic">Shadow Bolt</span> at ${target} — <span class="dmg-num dmg-mag">${dmg}</span> dark damage!`,
  (name, target, dmg) => `A bolt of siphoning shadow — ${name}'s magic strikes ${target} for <span class="dmg-num dmg-mag">${dmg}</span>!`,
  (name, target, dmg) => `${name} calls forth a <span class="sk-magic">Shadow Bolt</span>; ${target} is wreathed in dark energy — <span class="dmg-num dmg-mag">${dmg}</span>!`,
];
const T_SHADOW_BOLT_LEECH = [
  (count, totalHeal) => `The dark energy floods back into the party — <span class="dmg-num dmg-heal">${count}</span> ${count === 1 ? 'ally drinks' : 'allies drink'} a combined <span class="dmg-num dmg-heal">${totalHeal}</span> HP from the shadow!`,
  (count, totalHeal) => `Siphoned life returns to the living — <span class="dmg-num dmg-heal">${count}</span> ${count === 1 ? 'ally recovers' : 'allies recover'} for <span class="dmg-num dmg-heal">${totalHeal}</span> total HP!`,
];
const T_GROUP_SIPHON = [
  (count, totalHeal) => `Stolen life floods back into the party — <span class="dmg-num dmg-heal">${count}</span> ${count === 1 ? 'ally recovers' : 'allies recover'} for <span class="dmg-num dmg-heal">${totalHeal}</span> total HP!`,
  (count, totalHeal) => `Necrotic siphon channels life to the living — <span class="dmg-num dmg-heal">${count}</span> ${count === 1 ? 'ally heals' : 'allies heal'} for <span class="dmg-num dmg-heal">${totalHeal}</span> total HP!`,
];
const T_FORGO_DEATH = [
  (minion, name) => `${minion} hurls itself before the killing blow — it crumbles to dust, but <span class="sk-magic">${name} endures!</span>`,
];
const T_ARMY_OF_DAMNED = [
  (name, count, rounds) => `${name} tears open the veil — <span class="sk-magic">${count} fallen rise as one</span> in an Army of the Damned (${rounds} rounds)!`,
];
const T_ARMY_TICK = [
  (dmg, count) => `The risen army tears into <span class="dmg-num dmg-mag">${count}</span> ${_e(count)} — <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
  (dmg, count) => `Risen corpses claw at the living — <span class="dmg-num dmg-mag">${count}</span> ${_f(count)} take <span class="dmg-num dmg-mag">${dmg}</span>${_ea(count)}!`,
];
const T_NECROTIC_REFLECT = [
  (dmg, name) => `Necrotic decay lashes back at ${name} — <span class="dmg-num dmg-mag">${dmg}</span> reflected!`,
];
// ── Monk Ki Barrier templates ───────────────────────────────────────
const T_KI_BARRIER = [
  (monk, hp) => `${monk}'s <span class="sk-react">Ki Barrier</span> pulses — <span class="dmg-num dmg-heal">+${hp}</span> HP shield (absorbs damage)!`,
  (monk, hp) => `${monk} channels a <span class="sk-react">Ki Barrier</span> — <span class="dmg-num dmg-heal">${hp}</span> HP absorption shield!`,
];
// ── Monk class rework templates ─────────────────────────────────────
const T_FLOWING_STRIKE = [
  (monk, target, dmg) => `${monk} flows around the attack and lashes back with a <span class="sk-react">Flowing Strike</span> — ${target} takes <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (monk, target, dmg) => `${monk} pivots and retaliates — <span class="sk-react">Flowing Strike</span> hits ${target} for <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (monk, target, dmg) => `Water-like ${monk} answers the miss with a <span class="sk-react">Flowing Strike</span> — ${target} reels for <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
const T_PRESSURE_POINT = [
  (monk, target, dmg) => `${monk} strikes a <span class="sk-skill">Pressure Point</span> on ${target} — <span class="dmg-num dmg-phys">${dmg}</span> damage! The foe is destabilized!`,
  (monk, target, dmg) => `${monk}'s fingers find a vital nerve — <span class="sk-skill">Pressure Point</span> on ${target} for <span class="dmg-num dmg-phys">${dmg}</span>!`,
  (monk, target, dmg) => `A precise jab — ${monk}'s <span class="sk-skill">Pressure Point</span> disables ${target} for <span class="dmg-num dmg-phys">${dmg}</span>!`,
];
const T_IRON_STANCE = [
  (monk) => `${monk} settles into <span class="sk-buff">Iron Stance</span> — +30% DEF, +20% dodge for 2 rounds!`,
  (monk) => `${monk} roots like stone — <span class="sk-buff">Iron Stance</span> (+30% DEF, +20% dodge for 2 rounds)!`,
];
const T_KI_SHIELD = [
  (monk, hp) => `${monk} weaves a shimmering <span class="sk-react">Ki Shield</span> — <span class="dmg-num dmg-heal">${hp}</span> absorption!`,
  (monk, hp) => `A barrier of pure ki envelops ${monk} — <span class="dmg-num dmg-heal">${hp}</span> HP shield!`,
];
const T_KI_SHIELD_ABSORB = [
  (monk, dmg) => `${monk}'s <span class="sk-react">Ki Shield</span> absorbs <span class="dmg-num dmg-heal">${dmg}</span> damage!`,
];

// ── Mage Phase Shift templates ─────────────────────────────────────
const T_PHASE_SHIFT = [
  (mage) => `Reality bends around ${mage} — <span class="sk-react">Phase Shift</span>! Untargetable for 2 rounds!`,
  (mage) => `${mage} flickers and fades — <span class="sk-react">Phase Shift</span> activated! Untargetable for 2 rounds!`,
  (mage) => `Arcane energy warps space around ${mage} — <span class="sk-react">Phase Shift</span>: untargetable for 2 rounds!`,
];
const T_PHASE_RETURN = [
  (mage) => `${mage} phases back into reality, crackling with arcane power!`,
  (mage) => `${mage} rematerializes — the air hums with unleashed energy!`,
  (mage) => `Reality snaps back as ${mage} returns from the Astral Plane!`,
];
// ── Mage Spell Echo templates ──────────────────────────────────────
const T_SPELL_ECHO = [
  (mage) => `Arcane energy swirls around ${mage} — <span class="sk-magic">Spell Echo</span> (×1.5 spell dmg for 2 rounds)!`,
  (mage) => `${mage}'s magic reverberates — <span class="sk-magic">Spell Echo</span>: spells amplified ×1.5 for 2 rounds!`,
  (mage) => `The air crackles as ${mage} channels <span class="sk-magic">Spell Echo</span> (×1.5 for 2 rounds)!`,
];
// ── Ranger Camouflage templates ────────────────────────────────────
const T_CAMOUFLAGE = [
  (ranger) => `${ranger} fades into the shadows — <span class="sk-buff">Camouflage</span> (+20% dodge, +25% ATK for 2 rounds)!`,
  (ranger) => `${ranger} blends with the terrain — <span class="sk-buff">Camouflage</span>: +20% dodge, +25% ATK for 2 rounds!`,
  (ranger) => `${ranger} vanishes from sight — <span class="sk-buff">Camouflaged</span> (+20% dodge, +25% ATK for 2 rounds)!`,
];
// ── Cleric Divine Shield templates ─────────────────────────────────
const T_DIVINE_SHIELD = [
  (cleric) => `${cleric} invokes a <span class="sk-buff">Divine Shield</span> — party takes -15% damage for 3 rounds!`,
  (cleric) => `Holy light surrounds the party! ${cleric}'s <span class="sk-buff">Divine Shield</span> (-15% damage for 3 rounds)!`,
  (cleric) => `${cleric} channels sacred energy — <span class="sk-buff">Divine Shield</span>: -15% incoming damage for 3 rounds!`,
];

// ── Cleric Divine Intervention templates (killing-blow intercept) ──
const T_DIVINE_INTERVENTION = [
  (cleric, ally) => `${cleric} calls upon <span class="sk-buff">Divine Intervention</span> — ${ally} is saved from death at 1 HP!`,
  (cleric, ally) => `A holy light erupts from ${cleric}! <span class="sk-buff">Divine Intervention</span> shields ${ally} from the killing blow!`,
  (cleric, ally) => `"Not yet!" ${cleric}'s <span class="sk-buff">Divine Intervention</span> pulls ${ally} back from the brink — 1 HP!`,
];
// ── Cleric Resurrection templates ─────────────────────────────────
const T_RESURRECTION = [
  (cleric, ally) => `${cleric} channels holy power — <span class="sk-buff">Resurrection</span>! ${ally} rises from the fallen!`,
  (cleric, ally) => `Divine light engulfs ${ally}'s body! ${cleric}'s <span class="sk-buff">Resurrection</span> restores them to life!`,
  (cleric, ally) => `${cleric} calls upon the divine — ${ally} is <span class="sk-buff">Resurrected</span> and returns to the fight!`,
];

// ── Bard Discord templates (enemy debuff) ─────────────────────────
const T_DISCORD = [
  (bard, rounds) => `${bard} strikes a jarring <span class="sk-dot">Discord</span> — -20% ATK, +25% fumble & sonic DoT for ${rounds} rounds!`,
  (bard, rounds) => `A dissonant chord from ${bard} rattles the enemy ranks — <span class="sk-dot">Discord</span>: -20% ATK, fumble & sonic DoT (${rounds}rd)!`,
  (bard, rounds) => `${bard}'s <span class="sk-dot">Discord</span> shrieks across the battlefield — -20% ATK, +25% fumble for ${rounds} rounds!`,
];
// ── Bard Crescendo templates (devastating crit buff) ──────────────
const T_CRESCENDO = [
  (bard) => `${bard} builds to a thundering <span class="sk-crit">Crescendo</span> — the next strike will be devastating!`,
  (bard) => `The air trembles as ${bard} channels a <span class="sk-crit">Crescendo</span> — an ally is pushed to their limit!`,
  (bard) => `${bard}'s music swells to a <span class="sk-crit">Crescendo</span> — raw power surges into the party!`,
];
const T_CRESCENDO_STRIKE = [
  (attacker, target, dmg) => `Empowered by the Crescendo, ${attacker} unleashes a <span class="sk-crit">DEVASTATING</span> blow on ${target} for <span class="dmg-num dmg-crit">${dmg}</span> damage!`,
  (attacker, target, dmg) => `${attacker} channels the Crescendo into a <span class="sk-crit">DEVASTATING STRIKE</span> — ${target} takes <span class="dmg-num dmg-crit">${dmg}</span>!`,
  (attacker, target, dmg) => `The Crescendo peaks! ${attacker} delivers a <span class="sk-crit">DEVASTATING CRITICAL</span> to ${target} — <span class="dmg-num dmg-crit">${dmg}</span> damage!`,
];

// ── Bard Discord DoT templates ────────────────────────────────────
const T_DISCORD_DOT = [
  (dmg, count) => `The dissonant echoes rattle <span class="dmg-num dmg-dot">${count}</span> ${count === 1 ? 'enemy' : 'enemies'} for <span class="sk-dot">${dmg}</span> sonic damage${count === 1 ? '' : ' each'}!`,
  (dmg, count) => `Discord reverberates — <span class="dmg-num dmg-dot">${count}</span> ${count === 1 ? 'foe takes' : 'foes take'} <span class="sk-dot">${dmg}</span> damage from the jarring sound!`,
  (dmg, count) => `The lingering Discord tears at <span class="dmg-num dmg-dot">${count}</span> ${count === 1 ? 'enemy' : 'enemies'} — <span class="sk-dot">${dmg}</span> sonic damage${count === 1 ? '' : ' each'}!`,
];

const T_DEFEND = [
  (m, e, dmg) => `${m} blocks ${e}'s attack — only <span class="dmg-num dmg-block">${dmg}</span> damage taken!`,
  (m, e, dmg) => `${m} parries ${e} — <span class="dmg-num dmg-block">${dmg}</span> damage absorbed!`,
];

// Enemy attacks
const T_ENEMY_ATK = [
  (e, m, dmg) => `${e} strikes ${m} for <span class="dmg-num dmg-enemy">${dmg}</span> damage!`,
  (e, m, dmg) => `${e} slams into ${m} — <span class="dmg-num dmg-enemy">${dmg}</span>!`,
  (e, m, dmg) => `${e} claws at ${m}, dealing <span class="dmg-num dmg-enemy">${dmg}</span>!`,
  (e, m, dmg) => `${e} unleashes a vicious attack on ${m} — <span class="dmg-num dmg-enemy">${dmg}</span>!`,
  (e, m, dmg) => `${e} charges ${m} with a fierce blow — <span class="dmg-num dmg-enemy">${dmg}</span>!`,
];
const T_ENEMY_SKILL = [
  (e, sk, m, dmg) => `${e} uses <strong>${sk}</strong> on ${m} — <span class="dmg-num dmg-enemy">${dmg}</span>!`,
  (e, sk, m, dmg) => `${e} casts <strong>${sk}</strong> — ${m} takes <span class="dmg-num dmg-enemy">${dmg}</span>!`,
];
const T_ENEMY_DEFEAT = [
  (e, m) => `${m} delivers the final blow — ${e} falls!`,
  (e, m) => `${e} crumbles to dust! The party presses on.`,
  (e, m) => `With a mighty strike, ${m} defeats ${e}!`,
];
const T_PARTY_KO = [
  (m, e) => `${e}'s blow is too much — ${m} collapses!`,
  (m, e) => `${m} can't take any more damage and falls unconscious!`,
  (m, e) => `${m} staggers and drops — knocked out of the fight!`,
];
const T_REINFORCEMENT = [
  (e) => `${e} calls for reinforcements!`,
  (e) => `A new ${e} joins the fray!`,
  (e) => `Reinforcements arrive — ${e} charges in!`,
];

// Monster skill names by flavor
const MONSTER_SKILLS = [
  'Frenzy', 'Poison Spit', 'Dark Slash', 'Tail Whip', 'Shadow Bolt',
  'Bone Crush', 'Howl', 'Venomous Bite', 'Fire Breath', 'Rock Throw',
  'Ice Spike', 'Thunder Claw', 'Cursed Touch', 'War Cry', 'Berserker Rage',
];

// ── Hero Specialization combat templates ─────────────────────────────
// Vanguard
const T_VANGUARD_OATH = [
  (hero, ally, dmg) => `${hero} intercepts the blow meant for ${ally} — <span class="sk-buff">Vanguard's Oath</span> absorbs <span class="dmg-num dmg-block">${dmg}</span> damage!`,
  (hero, ally, dmg) => `"I stand between you and harm!" ${hero}'s <span class="sk-buff">Vanguard's Oath</span> shields ${ally} — <span class="dmg-num dmg-block">${dmg}</span> taken!`,
  (hero, ally, dmg) => `${hero} throws up a guard — <span class="sk-buff">Vanguard's Oath</span> redirects <span class="dmg-num dmg-block">${dmg}</span> damage from ${ally}!`,
];
const T_UNBREAKABLE = [
  (hero) => `${hero} refuses to fall — <span class="sk-buff">Unbreakable Will</span>! 1 HP, 80% damage reduction!`,
  (hero) => `"I... won't... die!" ${hero} activates <span class="sk-buff">Unbreakable Will</span> — surviving at 1 HP!`,
  (hero) => `A golden aura erupts around ${hero} — <span class="sk-buff">Unbreakable Will</span>! Death denied!`,
];
// Champion
const T_EXECUTIONER = [
  (hero, target, dmg) => `${hero} sees the opening — <span class="sk-debuff">Executioner's Mark</span>! ${target} takes <span class="dmg-num dmg-crit">${dmg}</span> finishing damage!`,
  (hero, target, dmg) => `"Your time is up!" ${hero}'s <span class="sk-debuff">Executioner's Mark</span> strikes ${target} for <span class="dmg-num dmg-crit">${dmg}</span>!`,
  (hero, target, dmg) => `${hero} delivers the <span class="sk-debuff">Executioner's Mark</span> — ${target} staggers from <span class="dmg-num dmg-crit">${dmg}</span> damage!`,
];
const T_HEROS_WRATH = [
  (hero, target, dmg) => `${hero} channels pure fury — <span class="sk-crit">HERO'S WRATH</span>! ${target} takes <span class="dmg-num dmg-crit">${dmg}</span> devastating damage!`,
  (hero, target, dmg) => `Rage incarnate! ${hero}'s <span class="sk-crit">HERO'S WRATH</span> annihilates ${target} for <span class="dmg-num dmg-crit">${dmg}</span>!`,
];
const T_BLOODLUST_KILL = [
  (hero) => `${hero}'s eyes burn red — <span class="sk-debuff">Bloodlust</span>! Next attack deals 1.5× damage!`,
  (hero) => `The kill fuels ${hero}'s <span class="sk-debuff">Bloodlust</span> — 1.5× damage on the next strike!`,
];
// Warden
const T_GUARDIAN_SPIRIT = [
  (hero, ally, hp) => `${hero} calls a <span class="sk-buff">Guardian Spirit</span> — ${ally} is healed for <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (hero, ally, hp) => `Warm light wraps around ${ally} — ${hero}'s <span class="sk-buff">Guardian Spirit</span> restores <span class="dmg-num dmg-heal">+${hp}</span> HP!`,
  (hero, ally, hp) => `${hero} invokes a <span class="sk-buff">Guardian Spirit</span> — healing ${ally} for <span class="dmg-num dmg-heal">+${hp}</span>!`,
];
const T_LAST_STAND = [
  (hero, count) => `${hero} plants the banner — <span class="sk-buff">LAST STAND</span>! ${count} fallen allies rise again at 25% HP!`,
  (hero, count) => `"We're not done yet!" ${hero}'s <span class="sk-buff">LAST STAND</span> revives ${count} fallen allies!`,
];
const T_LAST_STAND_KNIGHT = [
  (knight) => `${knight} digs in for their <span class="sk-react">Last Stand</span> — +35% DEF, +20% ATK for 3 rounds!`,
  (knight) => `Bloodied but unbroken, ${knight} locks into a <span class="sk-react">Last Stand</span>!`,
  (knight) => `${knight}'s will hardens into iron — <span class="sk-react">Last Stand</span> activates!`,
];

// ── Battle simulation state ────────────────────────────────────────────
// Built once per quest (deterministic from seed), then sliced by progress.

let _sim = null;       // cached simulation
let _simQuestId = null;
let _simKey = null;

// ── Sim environment ──────────────────────────────────────────────────────
// Everything buildSimulation reads from live game state goes through here.
// Auto battles have no aq.simEnv and read live state exactly as before.
// Manual battles freeze these inputs when the quest starts (aq.simEnv), so the
// battle can be replayed identically after every decision and after a reload,
// whatever the player does in other tabs in the meantime.
function makeSimEnv(aq) {
  const env = aq.simEnv || null;
  if (!env) {
    return {
      getDmgBonus: (q) => (Game.getDmgBonus ? Game.getDmgBonus(q) : 0),
      getDmgReduction: (q) => (Game.getDmgReduction ? Game.getDmgReduction(q) : 0),
      getAtkSpeedBonus: (q) => (Game.getAtkSpeedBonus ? Game.getAtkSpeedBonus(q) : 0),
      getHealBonus: (q) => (Game.getHealBonus ? Game.getHealBonus(q) : 0),
      hasTalent: (id) => (Game.hasTalent ? Game.hasTalent(id) : false),
      getPartyAuras: () => (Game.getPartyAuras ? Game.getPartyAuras() : null),
      effStats: (id, auras) => { const m = Game.getMember(id); return m ? Game.effectiveStats(m, auras) : null; },
      equipment: (id) => { const m = Game.getMember(id); return m ? (m.equipment || {}) : null; },
      skills: (id) => (Game.getActiveMemberSkills ? Game.getActiveMemberSkills(id) : []),
    };
  }
  const talents = new Set(env.talents || []);
  const memberEnv = (id) => (env.members && env.members[id]) || null;
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  return {
    getDmgBonus: () => env.dmgBonus || 0,
    getDmgReduction: () => env.dmgReduction || 0,
    getAtkSpeedBonus: () => env.atkSpeedBonus || 0,
    getHealBonus: () => env.healBonus || 0,
    hasTalent: (id) => talents.has(id),
    getPartyAuras: () => clone(env.auras || null),
    effStats: (id) => { const me = memberEnv(id); return me ? clone(me.eff) : null; },
    equipment: (id) => { const me = memberEnv(id); return me ? clone(me.equipment || {}) : null; },
    skills: (id) => { const me = memberEnv(id); return me ? (me.skills || []).slice() : []; },
  };
}

function buildSimulation(aq, quest) {
  const seed = aq.startedAt;
  const SE = makeSimEnv(aq);
  const members = aq.partySnapshot || [];
  const enemyNames = quest.enemies || ['Monster'];
  const envName = quest.environment ? esc(quest.environment.name) : 'the unknown';

  // Synergy bonuses for repeated quests
  let dmgBonus = 1 + SE.getDmgBonus(aq.questId);
  const dmgReduction = SE.getDmgReduction(aq.questId);
  let atkSpeedBonus = SE.getAtkSpeedBonus(aq.questId);

  // Legacy talent combat modifiers
  const _ht = (id) => SE.hasTalent(id);
  const isBossQuest = !!quest.boss;
  if (_ht('PARTY_SIEGE') && isBossQuest) dmgBonus += 0.25;
  // Initialize party auras early so healBonus can include partyHealBonus
  const simAuras = SE.getPartyAuras();
  const partyHealAura = simAuras ? simAuras.heal : 0;
  // healBonus computed after partyHp is built (needs per-member item/skill healBonus)
  let healBonus = 1 + (SE.getHealBonus(aq.questId)) + partyHealAura;
  // Compute effective event interval (faster with ATK speed synergy)
  const effectiveInterval = EVENT_INTERVAL * (1 - atkSpeedBonus);
  const partyHp = members.map(m => {
    const member = SE.effStats(m.id, simAuras);
    const eff = member || m.stats;
    return {
      id: m.id, name: esc(m.name), class: m.class,
      maxHp: eff.maxHp || m.stats.maxHp || 100,
      hp: eff.hp || eff.maxHp || m.stats.hp || 100,
      level: m.level, power: m.power || 20,
      // Combat stats — used for damage calc, action weight, crit/dodge
      atk: eff.atk || m.stats.atk || 10,
      mag: eff.mag || m.stats.mag || 1,
      def: eff.def || m.stats.def || 5,
      spd: eff.spd || m.stats.spd || 10,
      crit: eff.crit || m.stats.crit || 0,
      dodge: eff.dodge || m.stats.dodge || 0,
      // Special percentage bonuses from items/passives — consumed by combat calculations
      dodgeChance: eff.dodgeChance || 0,   // flat additional dodge % (e.g. 0.15 = +15%)
      critChance: eff.critChance || 0,     // flat additional crit % from skills
      healBonus: eff.healBonus || 0,        // healing output multiplier from items/skills
    };
  });

  // Aggregate per-member item/skill healBonus into the global healBonus
  // (highest individual healBonus from a healer class applies, to avoid stacking from non-healers)
  const memberHealBonuses = partyHp
    .filter(p => p.class === 'CLERIC' || p.class === 'BARD')
    .map(p => p.healBonus || 0);
  if (memberHealBonuses.length > 0) {
    healBonus += Math.max(...memberHealBonuses);
  }

  // ── Capture initial combat stats for debug display ──
  const _combatDebug = {
    healBonus: { synergy: SE.getHealBonus(aq.questId), partyAura: partyHealAura, memberItem: memberHealBonuses.length ? Math.max(...memberHealBonuses) : 0, total: healBonus },
    dmgBonus, dmgReduction, atkSpeedBonus,
    partyAuras: simAuras,
    members: partyHp.map(p => ({
      id: p.id, name: p.name, class: p.class, level: p.level,
      atk: p.atk, def: p.def, mag: p.mag, spd: p.spd, crit: p.crit, dodge: p.dodge,
      maxHp: p.maxHp, dodgeChance: p.dodgeChance || 0, critChance: p.critChance || 0, healBonus: p.healBonus || 0,
      // Skill list captured at sim start so the party-composition printer can
      // show the skills that were actually in play rather than the post-levelup
      // list (fight victories often trigger level-ups that learn new skills).
      skills: SE.skills(p.id),
    })),
    // ATB tracking — populated during battle loop
    atb: {
      totalRounds: 0,
      laneActions: {},   // { memberId: { attack: { fires: 0, basicFallbacks: 0 }, buff: { fires: 0, procFails: 0 }, heal: { fires: 0, held: 0 } } }
      procRolls: [],     // [{ round, member, lane, skillId, skillName, procChance, roll, fired }]
      gaugeSnapshots: [], // [{ round, gauges: { memberId: { attack, buff, heal } } }]
      equipProcs: [],    // [{ round, member, skillId, skillName, lane, cooldownSet }]
      reactiveEvents: [], // [{ round, type, member, target, trigger }]
      roundSummaries: [], // [{ round, livingParty, livingEnemies, partyHpPct, enemyHpPct }]
    },
  };

  // ── SPD-weighted random pick helper ──
  // Higher SPD → more likely to be chosen to act, but using sqrt curve
  // so slow classes (Knights, Clerics) still participate meaningfully.
  // Linear (old): Knight 43 vs Rogue 202 = 4.7:1 ratio → Knight gets ~5% of actions
  // Sqrt (new):   Knight 41 vs Rogue 80  = 2.0:1 ratio → Knight gets ~8% of actions
  function sPickWeighted(arr, seed) {
    if (arr.length === 0) return null;
    if (arr.length === 1) return arr[0];
    const weights = arr.map(m => Math.sqrt((m.spd || 10) + 5) * 6 + 8);
    const total = weights.reduce((s, w) => s + w, 0);
    let roll = sRand(seed) * total;
    for (let i = 0; i < arr.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  // ── Pending equipment buff state ──
  // Non-weapon equipment skills (armor/accessory/offhand procs) don't deal
  // damage directly — they drop a pending buff that amplifies this member's
  // NEXT damage/heal action. Consumed inside calcPartyDmg (for damage) or
  // explicitly at heal sites.
  const pendingEquipBuffs = {};

  function consumePendingEquipBuff(memberId) {
    const buf = pendingEquipBuffs[memberId];
    if (!buf) return null;
    delete pendingEquipBuffs[memberId];
    return buf;
  }

  // ── Stat-based damage helper ──
  // Physical classes scale off ATK, magic classes scale off MAG
  function calcPartyDmg(attacker, seed, bonus) {
    const isMagic = isMagicClass(attacker.class);
    const stat = isMagic ? (attacker.mag || 1) : (attacker.atk || 10);
    // Base party damage multiplier — see COMBAT_TUNING.PARTY_DMG_* for the curve.
    const multiplier = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(seed) * COMBAT_TUNING.PARTY_DMG_SPREAD;
    let dmg = Math.max(2, Math.floor(stat * multiplier * bonus));
    // Consume any pending equipment buff from this member's last non-weapon proc.
    const buf = consumePendingEquipBuff(attacker.id);
    if (buf && buf.effects) {
      const e = buf.effects;
      const empowerMult = 1.0 + (e.atkBonus || 0) + (e.magBonus || 0) + (e.powerMultiplier ? (e.powerMultiplier - 1) : 0);
      dmg = Math.max(2, Math.floor(dmg * empowerMult));
    }
    return dmg;
  }

  // ── DEF-based damage reduction ──
  // reduction = def / (def + DEF_SOFTCAP). Curve tuned via COMBAT_TUNING.DEF_SOFTCAP.
  function applyDef(rawDmg, defender) {
    const def = defender.def || 0;
    const reduction = def / (def + COMBAT_TUNING.DEF_SOFTCAP);
    return Math.max(1, Math.floor(rawDmg * (1 - reduction)));
  }

  // ── CRIT chance from stat ──
  // crit / (crit + CRIT_SOFTCAP), capped at CRIT_CAP, plus flat bonus from skills.
  function critChance(attacker) {
    const c = attacker.crit || 0;
    const flatBonus = attacker.critChance || 0;
    return Math.min(COMBAT_TUNING.CRIT_CAP, c / (c + COMBAT_TUNING.CRIT_SOFTCAP) + flatBonus);
  }

  // ── DODGE chance from stat ──
  // dodge / (dodge + DODGE_SOFTCAP), capped at DODGE_CAP, plus flat bonus from items.
  function dodgeChance(defender) {
    const d = defender.dodge || 0;
    const flatBonus = defender.dodgeChance || 0;
    return Math.min(COMBAT_TUNING.DODGE_CAP, d / (d + COMBAT_TUNING.DODGE_SOFTCAP) + flatBonus);
  }

  // ── Apply Legacy Talent stat modifiers ──
  // PARTY_CEL_RESONANCE: celestial equipment grants +10% to all stats
  if (_ht('PARTY_CEL_RESONANCE')) {
    for (const p of partyHp) {
      const _eq = SE.equipment(p.id);
      const member = _eq ? { equipment: _eq } : null;
      if (!member) continue;
      const slots = ['weapon', 'armor', 'offhand', 'accessory'];
      let hasCelestial = false;
      for (const slot of slots) {
        const itemId = member.equipment?.[slot];
        if (itemId && itemId.startsWith('CEL_')) { hasCelestial = true; break; }
      }
      if (hasCelestial) {
        p.atk = Math.floor(p.atk * 1.10);
        p.def = Math.floor(p.def * 1.10);
        p.mag = Math.floor(p.mag * 1.10);
        p.spd = Math.floor(p.spd * 1.10);
        p.crit = Math.floor(p.crit * 1.10);
        p.dodge = Math.floor(p.dodge * 1.10);
        p.maxHp = Math.floor(p.maxHp * 1.10);
        p.hp = p.maxHp;
      }
    }
  }

  // ── Class-augmentation talent flags ──
  // Hero
  const talentChainStrike = _ht('HRO_CHAIN_STRIKE');
  const talentRallyingHeal = _ht('HRO_RALLYING_HEAL');
  const talentWhirlwindHeal = _ht('HRO_WHIRLWIND_HEAL');
  // Knight
  const talentDefShred = _ht('KNT_DEF_SHRED');
  const talentKntCounter = _ht('KNT_COUNTER');
  const talentTauntAura = _ht('KNT_TAUNT_AURA');
  // Mage
  const talentBlizzardFrost = _ht('MAG_BLIZZARD_FROST');
  const talentMeteorBurn = _ht('MAG_METEOR_BURN');
  const talentArcaneReflect = _ht('MAG_ARCANE_REFLECT');
  // Rogue
  const talentPoison = _ht('ROG_POISON');
  const talentSmokeHeal = _ht('ROG_SMOKE_HEAL');
  const talentExecute = _ht('ROG_EXECUTE');
  // Cleric
  const talentSacredWarmth = _ht('CLR_SHIELD_HOT');
  const talentSmiteBurn = _ht('CLR_SMITE_BURN');
  const talentWrath = _ht('CLR_WRATH');
  // Ranger
  const talentVolleySlow = _ht('RNG_VOLLEY_SLOW');
  const talentSharedCamo = _ht('RNG_SHARED_CAMO');
  const talentStormMark = _ht('RNG_STORM_MARK');
  // Bard
  const talentDiscordDmg = _ht('BRD_DISCORD_DMG');
  const talentCrescendoAlly = _ht('BRD_CRESCENDO_ALLY');
  const talentSymphonyLeech = _ht('BRD_SYMPHONY_LEECH');
  // Monk
  const talentDeepKi = _ht('MNK_KI_BOOST');
  const talentRetaliating = _ht('MNK_COUNTER_ATK');
  const talentInfiniteFists = _ht('MNK_FURY_PLUS');
  // Necromancer
  // Grave Hunger requires an actual Necromancer in the party — it enhances
  // Shroud of Decay, so without a Necro there's no aura to enhance.
  const partyHasNecromancer = members.some(m => m.class === 'NECROMANCER');
  const talentGraveHunger = _ht('NEC_GRAVE_HUNGER') && partyHasNecromancer;
  const talentNecroticCleave = _ht('NEC_NECRO_CLEAVE');
  const talentUndeadVanguard = _ht('NEC_SUMMON_SHIELD');
  // necroticCleaveTimer removed — uses roundCount % 2 directly
  // Grave Hunger (reworked, §7.7 final): enhances Shroud of Decay per enemy kill.
  // Per-stack: +2% party damage (covers ATK+MAG via calcPartyDmg's bonus),
  // +1% party crit, +1% party DEF. Starts at 1 stack when talent active, max 5. No decay.
  let graveHungerStacks = talentGraveHunger ? 1 : 0;
  let graveHungerCritBonus = talentGraveHunger ? 0.01 : 0;
  let graveHungerDefBonus = talentGraveHunger ? 0.01 : 0;
  if (talentGraveHunger) dmgBonus += 0.02; // starter stack damage bonus
  // Party-wide
  const talentCelCascade = _ht('PARTY_CEL_CASCADE');
  const talentCelEcho = _ht('PARTY_CEL_ECHO');
  const talentUndying = _ht('PARTY_UNDYING');
  let undyingUsed = false;

  // ── Celestial Cascade helper ──────────────────────────────────────────
  // Reusable: called from both normal celestial weapon procs and echo hits.
  // On a celestial weapon damage hit, 25% chance to splash 50% of the damage
  // as AoE to all other enemies. isEcho=true uses distinct "Harmonic Cascade"
  // visual when the cascade was triggered by an Echo hit. Returns true if fired.
  function tryCelestialCascade(dmgDealt, hitTarget, attackerObj, seed, isEcho = false) {
    if (!talentCelCascade) return false;
    if (sRand(seed) >= 0.25) return false;
    const splashDmg = Math.max(1, Math.floor(dmgDealt * 0.50));
    let cascadeHits = 0;
    const currentLiving = enemies.filter(e => e.alive);
    for (const e of currentLiving) {
      if (hitTarget && e.id === hitTarget.id) continue;
      if (e.hp <= 0) continue;
      e.hp = Math.max(0, e.hp - splashDmg);
      if (combatStats[attackerObj.id]) combatStats[attackerObj.id].dmgDealt += splashDmg;
      cascadeHits++;
      if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, seed + cascadeHits); }
    }
    if (cascadeHits > 0) {
      const foeWord = cascadeHits === 1 ? 'foe' : 'foes';
      const cascadeText = isEcho
        ? `⚡ <strong>HARMONIC CASCADE!</strong> ${attackerObj.name}'s echo reverberates — energy tears through ${cascadeHits} ${foeWord} for <span class="dmg-num dmg-celestial">${splashDmg}</span> each!`
        : `💫 <strong>CELESTIAL CASCADE!</strong> Energy arcs from ${attackerObj.name}'s strike to ${cascadeHits} ${foeWord} for <span class="dmg-num dmg-celestial">${splashDmg}</span> each!`;
      events.push({
        text: cascadeText,
        type: 'celestial', icon: isEcho ? '⚡' : '💫', phase: 'battle',
      });
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
    }
    return cascadeHits > 0;
  }

  // Talent status trackers
  const defShredTargets = {}; // { enemyId: roundsRemaining } — KNT_DEF_SHRED
  const tauntedEnemies = {}; // { enemyId: roundsRemaining } — KNT_TAUNT_AURA
  const exposedTargets = {}; // { enemyId: roundsRemaining } — ROG Fan of Knives Exposed (+10% dmg taken, 2r)
  const poisonTargets = {}; // { enemyId: { rounds, dmgPerTick, ownerId } } — ROG_POISON
  const equipPoisonTargets = {}; // { enemyId: { rounds, dmgPerTick, ownerId, atkDebuff } } — Rogue offhand DoT (Envenom/Toxin/Neurotoxin)
  const chiBurnTargets = {}; // { enemyId: { rounds, dmgPerTick, ownerId, spdDebuff } } — Monk offhand DoT (Spirit Scorch/Inner Fire/Chi Eruption)
  const deflectBuffs = {}; // { memberId: { rounds, chance, reduction, reflect, atkDebuff, kiShieldPct, ownerId } } — Monk 2H Flowing Defense
  const burnTargets = {}; // { enemyId: { rounds, dmgPerTick, source, ownerId } } — MAG_METEOR_BURN / CLR_SMITE_BURN
  const sacredWarmthRounds = {}; // { memberId: roundsRemaining } — CLR_SHIELD_HOT HoT
  const wrathBuff = {}; // { memberId: roundsRemaining } — CLR_WRATH +30% dmg
  const stormMarkRounds = {}; // { enemyId: roundsRemaining } — RNG_STORM_MARK
  const crescendoAllyCharges = { count: 0 }; // BRD_CRESCENDO_ALLY — next N ally attacks auto-crit
  let symphonyLeechActive = false; // BRD_SYMPHONY_LEECH — party lifesteal

  // ── Intrinsic enemy curve (§9.2 of combat-tuning-design.md) ──
  // Enemies derive their stats from the quest's rank + sub-tier, not from
  // party HP. Boss/raid encounters use a composition model with per-role
  // stat multipliers; standard encounters use uniform stats.
  // Tower floors additionally scale by towerFloorMult (+6% per floor).
  const rankScale = RANK_SCALES[quest.rank] || RANK_SCALES.F;
  const subTierKey = (quest.subTier || 'standard').toLowerCase();
  const tierMult = SUB_TIER_MULTIPLIERS[subTierKey] || SUB_TIER_MULTIPLIERS.standard;
  const towerMult = quest.towerFloorMult || 1.0; // Tower floor scaling (1.0 for non-tower)
  const partyCount = partyHp.length;
  const extraEnemies = Math.max(0, partyCount - 4);

  const isBoss = !!quest.boss;
  const isRaid = !!quest.raidBoss;
  let enemies;

  if (isBoss || isRaid) {
    // ── Boss / Raid encounter composition ──
    // Boss encounters always have a full complement of adds so attacks-per-
    // round matches standard encounters. Add quality progresses through a
    // hierarchy: captains (F-E) → lieutenants (D-C) → generals+LTs (B+).
    // Raid encounters use raidBoss/raidLt mults for the boss and LT roles.
    const bossRoleMult    = isRaid ? BOSS_ROLE_MULTS.raidBoss : BOSS_ROLE_MULTS.boss;
    const generalRoleMult = BOSS_ROLE_MULTS.general;
    const ltRoleMult      = isRaid ? BOSS_ROLE_MULTS.raidLt   : BOSS_ROLE_MULTS.lt;
    const captainRoleMult = BOSS_ROLE_MULTS.captain;

    // Look up composition for this rank
    const comp = isRaid
      ? (RAID_COMPOSITIONS[quest.rank] || { generals: 2, lts: 2 })
      : (BOSS_COMPOSITIONS[quest.rank] || { generals: 0, lts: 0, captains: 2 });
    const generalCount = comp.generals || 0;
    const ltCount      = comp.lts || 0;
    const captainCount = comp.captains || 0;
    let minionCount    = comp.minions || 0;
    // Party-size bonus adds extra minions (standard-strength)
    minionCount += extraEnemies;

    // Build the enemy roster: boss first, then generals, then LTs, then captains
    const roster = [];

    // Boss — use bossName or last template enemy name
    const bossName = quest.bossName || enemyNames[enemyNames.length - 1] || 'Boss';
    roster.push({ name: bossName, role: 'boss', roleMult: bossRoleMult });

    // All non-boss names for role assignments (cycle through them)
    const nonBossNames = enemyNames.filter(n => n !== bossName);
    if (nonBossNames.length === 0) nonBossNames.push('Minion');
    let nameIdx = 0;

    // Sanitize rank-implying words in template names to match assigned role.
    // e.g. "Kargoth's Lieutenant" assigned as captain → "Kargoth's Captain"
    const RANK_WORDS = /\b(lieutenant|captain|general|commander|sergeant|corporal|marshal)\b/i;
    const ROLE_LABELS = { general: 'General', lt: 'Lieutenant', captain: 'Captain', minion: null };
    function roleFixName(templateName, role) {
      const label = ROLE_LABELS[role];
      if (!label) return templateName; // minions keep original name
      if (RANK_WORDS.test(templateName)) {
        return templateName.replace(RANK_WORDS, label);
      }
      return templateName;
    }

    // Generals
    for (let i = 0; i < generalCount; i++) {
      roster.push({ name: roleFixName(nonBossNames[nameIdx++ % nonBossNames.length], 'general'), role: 'general', roleMult: generalRoleMult });
    }

    // Lieutenants
    for (let i = 0; i < ltCount; i++) {
      roster.push({ name: roleFixName(nonBossNames[nameIdx++ % nonBossNames.length], 'lt'), role: 'lt', roleMult: ltRoleMult });
    }

    // Captains — continue cycling non-boss names
    for (let i = 0; i < captainCount; i++) {
      roster.push({ name: roleFixName(nonBossNames[nameIdx++ % nonBossNames.length], 'captain'), role: 'captain', roleMult: captainRoleMult });
    }

    // Standard minions (F-E boss adds + party-size overflow)
    const minionRoleMult = BOSS_ROLE_MULTS.minion;
    for (let i = 0; i < minionCount; i++) {
      roster.push({ name: roleFixName(nonBossNames[nameIdx++ % nonBossNames.length], 'minion'), role: 'minion', roleMult: minionRoleMult });
    }

    enemies = roster.map((entry, i) => {
      const hpVar = 0.9 + sRand(seed + 500 + i) * 0.2;
      const atkVar = 0.9 + sRand(seed + 600 + i) * 0.2;
      const baseHp = Math.floor(rankScale.baseHp * tierMult.hpMult * towerMult * entry.roleMult.hpMult);
      const baseAtk = Math.floor(rankScale.baseAtk * tierMult.atkMult * towerMult * entry.roleMult.atkMult);
      return {
        id: `enemy_${i}`, name: esc(entry.name),
        maxHp: Math.max(15, Math.floor(baseHp * hpVar)),
        hp: 0,
        atk: Math.max(4, Math.floor(baseAtk * atkVar)),
        alive: true, isReinforcement: false,
        role: entry.role,
      };
    });
  } else {
    // ── Standard encounter — uniform stats, rank-driven count ──
    // Brutal encounters promote one enemy to a boss-hierarchy role (mini-boss).
    const rankBaseCount = RANK_ENEMY_COUNT[quest.rank] || 3;
    const targetEnemyCount = rankBaseCount + extraEnemies;

    const fullEnemyNames = [];
    for (let i = 0; i < targetEnemyCount; i++) {
      fullEnemyNames.push(enemyNames[i % enemyNames.length]);
    }

    const perEnemyBaseHp = Math.floor(rankScale.baseHp * tierMult.hpMult * towerMult);
    const perEnemyBaseAtk = Math.floor(rankScale.baseAtk * tierMult.atkMult * towerMult);

    // Brutal mini-boss: promote the LAST enemy (index = count - 1) so
    // it shows up at the end of the enemy list as the "surprise" threat.
    const promoRole = (subTierKey === 'brutal') ? BRUTAL_PROMOTION[quest.rank] : null;
    const promoMult = promoRole ? BOSS_ROLE_MULTS[promoRole] : null;

    enemies = fullEnemyNames.map((name, i) => {
      const hpVar = 0.9 + sRand(seed + 500 + i) * 0.2;
      const atkVar = 0.9 + sRand(seed + 600 + i) * 0.2;
      const isPromoted = promoMult && (i === targetEnemyCount - 1);
      const roleHpMult = isPromoted ? promoMult.hpMult : 1.0;
      const roleAtkMult = isPromoted ? promoMult.atkMult : 1.0;
      return {
        id: `enemy_${i}`, name: esc(name),
        maxHp: Math.max(15, Math.floor(perEnemyBaseHp * roleHpMult * hpVar)),
        hp: 0,
        atk: Math.max(4, Math.floor(perEnemyBaseAtk * roleAtkMult * atkVar)),
        alive: true, isReinforcement: false,
        role: isPromoted ? promoRole : 'standard',
      };
    });
  }
  enemies.forEach(e => e.hp = e.maxHp);

  const events = [];
  const snapshots = [];
  let nextEnemyId = enemies.length;
  let battleOutcome = null; // 'victory' or 'defeat'

  // ── Per-member combat stats tracking ──
  const combatStats = {};
  for (const m of partyHp) {
    combatStats[m.id] = { id: m.id, name: esc(m.name), class: m.class, dmgDealt: 0, healingDone: 0, healingReceived: 0, dmgTaken: 0, dmgMitigated: 0, dmgAbsorbed: 0, dmgDodged: 0, dmgReflected: 0 };
  }

  // ── Phase 1: Travel (2 events) ──
  for (let t = 0; t < 2; t++) {
    const es = seed + t * 3571;
    const m = sPick(members, es + 1);
    const text = sPick(T_TRAVEL, es)(m ? m.name : 'The party', envName);
    events.push({ text, type: 'travel', icon: '🗺', phase: 'travel' });
    snapshots.push(makeSnapshot(partyHp, enemies));
  }

  // ── Phase 2: Encounter (1 event) ──
  {
    const es = seed + 9001;
    const m = sPick(members, es + 1);
    const e = sPick(enemies, es + 2);
    const text = sPick(T_ENCOUNTER, es)(m ? m.name : 'The party', e.name);
    events.push({ text, type: 'encounter', icon: '👁', phase: 'encounter' });
    snapshots.push(makeSnapshot(partyHp, enemies));
  }

  // ── Phase 3: Battle (loop until one side dies) ──
  // High cap as safety net — battle should always end naturally via HP depletion
  const MAX_BATTLE_EVENTS = 80 + extraEnemies * 8;
  // Reinforcements removed under §9 rework — these vars are retained as
  // no-ops so any stale references don't crash. See line ~3643 comment.
  let reinforceCount = 0;
  const maxReinforcements = 0;
  let regenPerTick = 0; // Bard regen — HP per member per round
  let regenSource = null; // Name of the bard who cast regen
  let regenSourceId = null; // ID of the bard for stat tracking

  // Knight Bulwark — track cooldown per knight (keyed by party member id)
  const coverCooldowns = {}; // { memberId: roundsRemaining }
  // Build set of knights that have the Bulwark skill
  const knightsWithCover = new Set();

  // Hero Rally Cry — track cooldown per hero
  const rallyCooldowns = {}; // { memberId: roundsRemaining }
  const heroesWithRally = new Set();

  // Rogue Mark for Death — track which enemies are marked
  const markedEnemies = {}; // { enemyId: roundsRemaining }
  const roguesWithMark = new Set();

  // Ranger Volley — track which rangers have the skill
  const rangersWithVolley = new Set();
  const rangersWithCamouflage = new Set();
  const rangersWithPrecisionShot = new Set();
  // Ranger Hunter's Mark — reactive auto-crit on kill
  const rangersWithHuntersMark = new Set();
  const huntersMarkCharges = {}; // { rangerId: chargesRemaining }
  const huntersMarkCooldowns = {}; // { rangerId: roundsRemaining }
  // Knight Last Stand — reactive self-buff when HP < 30%
  const knightsWithLastStand = new Set();
  const lastStandBuffRounds = {}; // { knightId: roundsRemaining }
  const lastStandCooldowns = {};  // { knightId: roundsRemaining }

  // Monk Ki Barrier — track monks with lifesteal
  const monksWithKiBarrier = new Set();

  // Mage Phase Shift — reactive untargetable when below 40% HP
  const magesWithPhaseShift = new Set();
  const phaseShiftRounds = {}; // { memberId: roundsRemaining } — untargetable duration
  const phaseShiftCooldowns = {}; // { memberId: roundsRemaining } — 4-round CD
  const phaseShiftDmgBoost = {}; // { memberId: true } — Arcane Reflection talent: +25% dmg on return

  // Mage Arcane Construct — permanent pet that bodyguards the Mage
  const magesWithConstruct = new Set();
  const arcaneConstructs = []; // { id, name, hp, maxHp, def, ownerId, mageRef }
  const constructCooldowns = {}; // { mageId: roundsRemaining } — 2-round CD after death
  const constructPulseReady = {}; // { mageId: roundsRemaining } — fires every 2 rounds

  // Mage Arcane Aftershock (formerly Spell Echo) — damage amp REACTIVE primed
  // when any ally lands a killing blow. Set name kept for minimal-diff reasons;
  // it tracks mages with the L14 class skill SPELL_ECHO / "Arcane Aftershock".
  const magesWithSpellEcho = new Set();
  const spellEchoRounds = {}; // { memberId: roundsRemaining }
  const aftershockCooldowns = {}; // { memberId: roundsRemaining } — 3-round ICD

  // Ranger Camouflage — dodge/damage reduction after Volley
  const camoRounds = {}; // { memberId: roundsRemaining }

  // Bard Discord — enemy ATK reduction, fumble chance, sonic DoT
  const bardsWithDiscord = new Set();
  const discordCooldowns = {}; // { memberId: roundsRemaining }
  let discordRounds = 0; // party-wide: how many rounds the debuff lasts
  let discordSource = null; // name of bard who cast it

  // Monk Swift Palm — party-wide +25% ATK, +15% SPD for 2 rounds
  let swiftPalmRounds = 0;

  // Rogue Smoke Bomb — party-wide +30% dodge for 2 rounds
  let smokeBombRounds = 0;

  // Mage Frostbite — AoE ice debuff: enemy ATK -15%, 20% fumble, 3 rounds
  let frostbiteRounds = 0;

  // Bard Crescendo — devastating crit buff for next attacker
  const bardsWithCrescendo = new Set();
  const crescendoCooldowns = {}; // { memberId: roundsRemaining }
  let crescendoActive = false; // is the next-attack buff waiting to be consumed?
  let crescendoSourceId = null; // bard who cast it (for stat tracking)

  // Bard Cadence — 3-round party damage + crit buff
  const cadenceCooldowns = {}; // { memberId: roundsRemaining }
  let cadenceRounds = 0; // rounds remaining for active Cadence buff
  let cadenceSource = null; // name of bard who cast it

  // Cleric Divine Shield — party damage reduction after heal
  const clericsWithDivineShield = new Set();
  const clericsWithGuardianGrasp = new Set();
  const guardianGraspCooldowns = {};
  const roguesWithRiposte = new Set();
  const riposteCooldowns = {};
  let divineShieldRounds = 0; // party-wide counter
  let consecrationRounds = 0; // CLR CONSECRATION — party-wide DEF +10% + HoT 5% maxHP/r
  let consecrationSource = null;
  let divineShieldSource = null; // name of cleric who cast it

  // Cleric Divine Intervention — intercepts killing blow, saves ally at 1 HP
  const clericsWithIntervention = new Set();
  const interventionCooldowns = {}; // { memberId: roundsRemaining }

  // Cleric Resurrection — revives a KO'd party member at 40% HP
  const clericsWithResurrection = new Set();
  const resurrectionCooldowns = {}; // { memberId: roundsRemaining }

  // ── Hero Specialization combat tracking ──
  // Vanguard
  const heroesWithVanguard = new Set();
  const vanguardCooldowns = {}; // { memberId: roundsRemaining }
  const heroesWithUnbreakable = new Set();
  const unbreakableCooldowns = {}; // { memberId: roundsRemaining }
  const unbreakableDR = {}; // { memberId: roundsRemaining } — active DR after proc
  // Champion
  const heroesWithExecutioner = new Set();
  const executionerCooldowns = {}; // { memberId: roundsRemaining } — 3-round CD between mark fires
  const executeMarkRounds = {};    // { enemyId: roundsRemaining } — marked enemies take +10% party dmg for 2 rounds
  const heroesWithBloodlust = new Set();
  const bloodlustActive = {}; // { memberId: true } — next attack deals 1.5× damage
  const heroesWithWrath = new Set();
  const wrathCooldowns = {}; // { memberId: roundsRemaining }
  // Warden
  const heroesWithGuardian = new Set();
  const guardianCooldowns = {}; // { memberId: roundsRemaining }
  const heroesWithLastStand = new Set();
  const lastStandUsed = {}; // { memberId: true } — once per fight
  // Hero L14 baseline reactive (§3.1)
  const heroesWithSecondWind = new Set();
  const secondWindCooldowns = {}; // { memberId: roundsRemaining } — 4-round ICD
  const secondWindRounds = {};    // { memberId: roundsRemaining } — active +20% ATK buff

  // Monk class rework (Phase 1c) — Flowing Strike, Pressure Point, Ki Shield, Iron Stance
  const monksWithFlowingStrike = new Set();
  const flowingStrikeCooldowns = {}; // { memberId: roundsRemaining } — 3-round cooldown
  const monksWithPressurePoint = new Set();
  const pressurePointDebuffs = {}; // { enemyId: roundsRemaining } — target takes +10% dmg, -20% ATB
  const ironStanceBuffs = {}; // { monkId: roundsRemaining } — +20% DEF and +15% dodge for 2 rounds
  const kiShieldHP = {}; // { monkId: absorbHpRemaining }

  // Necromancer — minions, DoTs, reactive death save, damage reflect
  const necrosWithRaiseDead = new Set();
  const raiseDeadCooldowns = {}; // { memberId: roundsRemaining }
  const necrosWithDarkPact = new Set();
  let darkPactRounds = 0;
  let darkPactSource = null; // necro who cast it (for MAG scaling)
  const necrosWithBlight = new Set();
  const necrosWithForgoDeath = new Set();
  const necrosWithArmy = new Set();
  const necroMinions = []; // { id, name, hp, maxHp, def, dmgPerTick, ownerId }
  const fallenEnemies = []; // names of enemies that died (for Raise Dead / Army)
  let blightRounds = 0;
  let blightSource = null; // necro obj who cast it (for MAG scaling)
  let armyRounds = 0;
  let armyDmgPerTick = 0;
  let armySource = null;
  let necroticReflectMag = 0; // MAG of necro with Shroud of Decay (0 = no reflect)
  let necGroupSiphonPct = 0;   // passive group siphon heal % from offhand (Skull Whisper etc.)
  let minionDmgBonusTotal = 0; // accumulated from Lord of the Dead + Soul Anchor + scythe auras
  let minionHpBonusTotal = 0;  // accumulated from scythe auras (Death's Harvest line)
  let blightAmpTotal = 0;      // accumulated from scythe auras (Blight tick multiplier)
  let minionAoe = false;       // celestial scythe: thrall attacks hit ALL enemies

  // Bard Lute (Songweaver) aura bonuses — accumulated from equipment passives
  let regenAmpTotal = 0;        // multiplier boost to Regen Song potency
  let partyHealBonusTotal = 0;  // additive boost to global healBonus
  let regenNeverLower = false;  // celestial lute: regen re-rolls never go lower

  // Bard Drum (Wardrum) aura bonuses — accumulated from equipment passives
  let discordDotAmpTotal = 0;     // multiplier boost to Discord DoT damage
  let discordAtkRedBonusTotal = 0; // additive boost to Discord ATK reduction (base 20%)
  let discordFumbleBonusTotal = 0; // additive boost to Discord fumble chance (base 25%)

  // Cleric celestial persistent regen
  let clericRegenPerTick = 0;     // per-round regen from CEL_SANCTIFIED_RADIANCE
  let clericRegenSourceId = null; // cleric who provides the regen
  let clericRegenSourceName = null;

  for (const m of members) {
    const memberSkills = SE.skills(m.id);
    if (m.class === 'KNIGHT' && memberSkills.includes('BULWARK')) {
      knightsWithCover.add(m.id);
      coverCooldowns[m.id] = 0;
    }
    if (m.class === 'KNIGHT' && memberSkills.includes('LAST_STAND')) {
      knightsWithLastStand.add(m.id);
      lastStandBuffRounds[m.id] = 0;
      lastStandCooldowns[m.id] = 0;
    }
    if (m.class === 'HERO' && memberSkills.includes('RALLY_CRY')) {
      heroesWithRally.add(m.id);
      rallyCooldowns[m.id] = 0;
    }
    if (m.class === 'ROGUE' && memberSkills.includes('MARK_FOR_DEATH')) {
      roguesWithMark.add(m.id);
    }
    if (m.class === 'RANGER') {
      if (memberSkills.includes('VOLLEY')) rangersWithVolley.add(m.id);
      if (memberSkills.includes('CAMOUFLAGE')) rangersWithCamouflage.add(m.id);
      if (memberSkills.includes('PRECISION_SHOT')) rangersWithPrecisionShot.add(m.id);
      if (memberSkills.includes('HUNTERS_MARK')) {
        rangersWithHuntersMark.add(m.id);
        huntersMarkCharges[m.id] = 0;
        huntersMarkCooldowns[m.id] = 0;
      }
    }
    if (m.class === 'MONK' && memberSkills.includes('KI_BARRIER')) {
      monksWithKiBarrier.add(m.id);
    }
    if (m.class === 'MONK' && memberSkills.includes('FLOWING_STRIKE')) {
      monksWithFlowingStrike.add(m.id);
      flowingStrikeCooldowns[m.id] = 0;
    }
    if (m.class === 'MONK' && memberSkills.includes('PRESSURE_POINT')) {
      monksWithPressurePoint.add(m.id);
    }
    if (m.class === 'MAGE' && memberSkills.includes('MAGE_M_PHASE_SHIFT')) {
      magesWithPhaseShift.add(m.id);
      phaseShiftRounds[m.id] = 0;
      phaseShiftCooldowns[m.id] = 0;
    }
    if (m.class === 'MAGE' && (memberSkills.includes('ARCANE_CONSTRUCT') || memberSkills.includes('ARCANE_CATACLYSM'))) {
      // ARCANE_CATACLYSM legacy saves auto-upgrade to Arcane Construct
      magesWithConstruct.add(m.id);
      constructCooldowns[m.id] = 0;
      constructPulseReady[m.id] = 2; // first pulse at round 2
      // Summon construct at combat start — 150% of Mage's MAG for HP and DEF.
      // Should survive 3-4 direct hits; if it falls, Phase Shift buys time
      // until the 2-round respawn cooldown expires.
      // Single-target dmg matches thrall output (110% of owner's MAG).
      const pMe = partyHp.find(p => p.id === m.id);
      if (pMe) {
        const cHp = Math.max(50, Math.floor((pMe.mag || 10) * 1.50));
        const cDef = Math.max(10, Math.floor((pMe.mag || 10) * 1.50));
        const cDmg = Math.max(2, Math.floor((pMe.mag || 10) * 0.85));
        arcaneConstructs.push({
          id: `construct_${m.id}`,
          name: `${pMe.name}'s Construct`,
          hp: cHp, maxHp: cHp,
          def: cDef,
          dmgPerTick: cDmg,
          ownerId: m.id,
          mageRef: pMe,
        });
        // Summon event deferred to after _bufState init (see "Arcane Construct opening event" below)
      }
    }
    if (m.class === 'MAGE' && memberSkills.includes('SPELL_ECHO')) {
      // SPELL_ECHO is the Mage L14 "Arcane Aftershock" reactive (class rework §3.3).
      magesWithSpellEcho.add(m.id);
      spellEchoRounds[m.id] = 0;
      aftershockCooldowns[m.id] = 0;
    }
    if (m.class === 'BARD' && memberSkills.includes('DISCORD')) {
      bardsWithDiscord.add(m.id);
      discordCooldowns[m.id] = 0;
    }
    if (m.class === 'BARD' && memberSkills.includes('CRESCENDO')) {
      bardsWithCrescendo.add(m.id);
      crescendoCooldowns[m.id] = 0;
    }
    if (m.class === 'BARD' && memberSkills.includes('CADENCE')) {
      cadenceCooldowns[m.id] = 0;
    }
    // Vampiric Symphony (BRD_SYMPHONY_LEECH) — Symphony of War grants party lifesteal
    if (m.class === 'BARD' && memberSkills.includes('SYMPHONY_OF_WAR') && talentSymphonyLeech) {
      symphonyLeechActive = true;
    }
    if (m.class === 'CLERIC' && memberSkills.includes('DIVINE_SHIELD')) {
      clericsWithDivineShield.add(m.id);
    }
    if (m.class === 'CLERIC' && memberSkills.includes('GUARDIAN_GRASP')) {
      clericsWithGuardianGrasp.add(m.id);
      guardianGraspCooldowns[m.id] = 0;
    }
    if (m.class === 'ROGUE' && memberSkills.includes('RIPOSTE')) {
      roguesWithRiposte.add(m.id);
      riposteCooldowns[m.id] = 0;
    }
    if (m.class === 'CLERIC' && memberSkills.includes('DIVINE_INTERVENTION')) {
      clericsWithIntervention.add(m.id);
      interventionCooldowns[m.id] = 0;
    }
    if (m.class === 'CLERIC' && memberSkills.includes('RESURRECTION')) {
      clericsWithResurrection.add(m.id);
      resurrectionCooldowns[m.id] = 0;
    }
    // Hero Specialization skills
    if (m.class === 'HERO') {
      if (memberSkills.includes('VANGUARDS_OATH')) {
        heroesWithVanguard.add(m.id);
        vanguardCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('UNBREAKABLE_WILL')) {
        heroesWithUnbreakable.add(m.id);
        unbreakableCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('EXECUTIONERS_MARK')) {
        heroesWithExecutioner.add(m.id);
        executionerCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('BLOODLUST')) {
        heroesWithBloodlust.add(m.id);
      }
      if (memberSkills.includes('HEROS_WRATH')) {
        heroesWithWrath.add(m.id);
        wrathCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('GUARDIAN_SPIRIT')) {
        heroesWithGuardian.add(m.id);
        guardianCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('SECOND_DAWN')) {
        heroesWithLastStand.add(m.id);
        lastStandUsed[m.id] = false;
      }
      if (memberSkills.includes('SECOND_WIND')) {
        heroesWithSecondWind.add(m.id);
        secondWindCooldowns[m.id] = 0;
        secondWindRounds[m.id] = 0;
      }
    }
    // Necromancer skill detection
    if (m.class === 'NECROMANCER') {
      if (memberSkills.includes('RAISE_DEAD')) {
        necrosWithRaiseDead.add(m.id);
        raiseDeadCooldowns[m.id] = 0;
      }
      if (memberSkills.includes('DARK_PACT')) {
        necrosWithDarkPact.add(m.id);
      }
      if (memberSkills.includes('BLIGHT')) {
        necrosWithBlight.add(m.id);
      }
      if (memberSkills.includes('FORGO_DEATH')) {
        necrosWithForgoDeath.add(m.id);
      }
      if (memberSkills.includes('ARMY_OF_THE_DAMNED')) {
        necrosWithArmy.add(m.id);
      }
      // Check for Shroud of Decay (party aura with necrotic reflect)
      if (memberSkills.includes('NECRO_M_SHROUD_OF_DECAY')) {
        const pMe = partyHp.find(p => p.id === m.id);
        necroticReflectMag = pMe ? pMe.mag : (m.stats?.mag || 10);
      }
      // Accumulate minion bonuses from masteries, equipment auras, and celestial items
      const mSkills = memberSkills.map(sid => getSkill(sid)).filter(Boolean);
      for (const sk of mSkills) {
        if (!sk.effects) continue;
        if (sk.effects.minionDamageBonus) minionDmgBonusTotal += sk.effects.minionDamageBonus;
        if (sk.effects.minionHpBonus) minionHpBonusTotal += sk.effects.minionHpBonus;
        if (sk.effects.blightAmp) blightAmpTotal += sk.effects.blightAmp;
        if (sk.effects.minionAoe) minionAoe = true;
        // Passive group siphon from offhand (Skull Whisper etc.) — highest value wins
        if (sk.effects.groupSiphon && sk.type === 'passive' && sk.effects.siphonHealPct) {
          necGroupSiphonPct = Math.max(necGroupSiphonPct, sk.effects.siphonHealPct);
        }
      }
    }
    // Accumulate Bard equipment aura bonuses (Lute/Drum passives)
    if (m.class === 'BARD') {
      const bSkills = memberSkills.map(sid => getSkill(sid)).filter(Boolean);
      for (const sk of bSkills) {
        if (!sk.effects) continue;
        // Lute (Songweaver) path
        if (sk.effects.regenAmp) regenAmpTotal += sk.effects.regenAmp;
        if (sk.effects.partyHealBonus) partyHealBonusTotal += sk.effects.partyHealBonus;
        if (sk.effects.regenNeverLower) regenNeverLower = true;
        // Drum (Wardrum) path
        if (sk.effects.discordDotAmp) discordDotAmpTotal += sk.effects.discordDotAmp;
        if (sk.effects.discordAtkRedBonus) discordAtkRedBonusTotal += sk.effects.discordAtkRedBonus;
        if (sk.effects.discordFumbleBonus) discordFumbleBonusTotal += sk.effects.discordFumbleBonus;
      }
    }
    // Accumulate Cleric celestial persistent regen (CEL_SANCTIFIED_RADIANCE)
    if (m.class === 'CLERIC') {
      const cSkills = memberSkills.map(sid => getSkill(sid)).filter(Boolean);
      for (const sk of cSkills) {
        if (!sk.effects) continue;
        if (sk.effects.clericRegen) {
          const pMe = partyHp.find(p => p.id === m.id);
          const clericMag = pMe ? pMe.mag : (m.stats?.mag || 10);
          clericRegenPerTick = Math.max(1, Math.floor(clericMag * (sk.effects.clericRegenScale || 0.38)));
          clericRegenSourceId = m.id;
          clericRegenSourceName = pMe ? pMe.name : esc(m.name);
        }
      }
    }
  }

  // Apply partyHealBonus from Bard Lute aura to global healBonus
  if (partyHealBonusTotal > 0) {
    healBonus += partyHealBonusTotal;
  }

  // SKILL_COOLDOWN is centralized in COMBAT_TUNING.SKILL_COOLDOWN_DEFAULT (top of file).
  const SKILL_COOLDOWN = COMBAT_TUNING.SKILL_COOLDOWN_DEFAULT;

  // Explicit lane mapping for class skills
  // Note: KI_BARRIER, INNER_FOCUS, DARK_PACT retired by the Monk/Necro class
  // rework — removed from this set so reconcile'd members never schedule them.
  // The SKILLS[id] definitions still exist (source:'legacy') so any lingering
  // code references resolve harmlessly.
  const BUFF_LANE_SKILLS = new Set([
    'SHIELD_WALL', 'TAUNT',
    // SPELL_ECHO moved to REACTIVE_SKILLS — now the L14 Arcane Aftershock reactive.
    'MARK_FOR_DEATH', 'SMOKE_BOMB', 'DIVINE_SHIELD', 'SWIFT_PALM',
    'CAMOUFLAGE', 'REGEN_SONG', 'DISCORD', 'CADENCE',
    'MAGNUM_OPUS',
    'BLIGHT', 'ARMY_OF_THE_DAMNED',
  ]);
  const HEAL_LANE_SKILLS = new Set(['HOLY_LIGHT']);

  // Reactive-only skills — excluded from all ATB lanes, triggered by conditions only
  const REACTIVE_SKILLS = new Set([
    'RAISE_DEAD',        // triggers on enemy death
    'ARCANE_CONSTRUCT',  // auto-summon at combat start, re-summon on cooldown
    'ARCANE_CATACLYSM',  // legacy id → treated as Arcane Construct
    'BULWARK',           // triggers on ally hit
    'DIVINE_INTERVENTION', // triggers on ally lethal
    'LAST_STAND',        // Knight — triggers on self HP < 30%
    'RESURRECTION',      // triggers on ally KO during heal
    'FORGO_DEATH',       // triggers on necro lethal
    'UNBREAKABLE',       // triggers on hero lethal
    'VANGUARDS_OATH',    // Hero Vanguard — triggers on ally hit
    'UNBREAKABLE_WILL',  // Hero Vanguard — triggers on self lethal
    'EXECUTIONERS_MARK', // Hero Champion — triggers on enemy low HP
    'SECOND_DAWN',       // Hero Paragon — triggers on ally KO
    'RALLY_CRY',         // triggers on ally <30% HP
    'GUARDIAN_SPIRIT',   // triggers on ally <25% HP
    'HUNTERS_MARK',      // triggers on Ranger killing blow
    'CRESCENDO',         // Bard — triggers on ally crit
    'MAGE_M_PHASE_SHIFT', // Mage — Phase Shift, triggers on self HP < 40%
    'SPELL_ECHO',        // Mage — Arcane Aftershock, triggers on ally killing blow
    'SECOND_WIND',       // Hero L14 baseline — triggers on self HP < 35%
    'RIPOSTE',           // Rogue L14 — counter-strike on being hit (2r cd)
    'GUARDIAN_GRASP',    // Cleric L14 — negates any ally incoming damage (3r cd)
  ]);

  // Categorize CLASS/SPEC skills by lane (equipment skills skip this — they all
  // live in a single equipment proc pool and are dispatched by slot at proc time).
  function categorizeClassSkill(skill) {
    if (!skill || !skill.effects) return 'attack';
    const e = skill.effects;
    if ((e.healBonus || e.partyHealPct) && !e.powerMultiplier && !e.defPierce) return 'heal';
    if (e.powerMultiplier || e.defPierce) return 'attack';
    if (e.defBonus || e.maxHpBonus || e.dodgeBonus || e.spdBonus || e.partyDefBonus ||
        e.partyAtkBonus || e.partySpdBonus) return 'buff';
    return 'attack';
  }

  // Build skill pools by member and lane. Equipment skills all funnel into a
  // single memberEquipProcSkills pool regardless of what they do — the
  // end-of-round proc block reads the bound item's slot (weapon vs other) to
  // decide whether the proc fires damage or drops a pending empowering buff.
  const memberAttackSkills = {};
  const memberBuffSkills = {};
  const memberHealSkills = {};
  const memberEquipProcSkills = {};
  const equipProcCooldowns = {};

  for (const m of members) {
    // Dynamic skill lookup — recomputes from class + level + equipment every sim
    // so newly added class skills auto-apply to existing characters on game load.
    const allSkills = SE.skills(m.id);

    memberAttackSkills[m.id] = [];
    memberBuffSkills[m.id] = [];
    memberHealSkills[m.id] = [];
    memberEquipProcSkills[m.id] = [];
    equipProcCooldowns[m.id] = 0;

    for (const sid of allSkills) {
      const sk = getSkill(sid);
      if (!sk || sk.type === 'passive') continue;
      if (REACTIVE_SKILLS.has(sid)) continue; // reactive skills have no ATB lane

      if (sk.source === 'equipment') {
        // All equipment active skills go into the proc pool — slot lookup at proc time.
        memberEquipProcSkills[m.id].push(sid);
        continue;
      }

      let category = 'attack';
      if (BUFF_LANE_SKILLS.has(sid)) category = 'buff';
      else if (HEAL_LANE_SKILLS.has(sid)) category = 'heal';
      else if (!sk.effects || !sk.effects.powerMultiplier) category = categorizeClassSkill(sk);

      if (category === 'attack') memberAttackSkills[m.id].push(sid);
      else if (category === 'buff') memberBuffSkills[m.id].push(sid);
      else if (category === 'heal') memberHealSkills[m.id].push(sid);
    }
  }

  // ── Celestial Echo — pre-compute celestial weapon proc skills per member ──
  // Maps memberId → { skillId, skill, item } for the talent PARTY_CEL_ECHO.
  // Only weapon-slot celestial active skills qualify (not DoT, not buff, not deflect).
  const celEchoMap = {};
  if (talentCelEcho) {
    for (const m of members) {
      for (const sid of (memberEquipProcSkills[m.id] || [])) {
        const sk = getSkill(sid);
        if (!sk || sk.type !== 'active') continue;
        const boundItem = sk.itemId ? getItem(sk.itemId) : null;
        if (!boundItem || boundItem.rarity !== 'celestial' || boundItem.slot !== 'weapon') continue;
        // Must be a weapon damage proc (has powerMultiplier, not DoT, not deflect, not buff-only)
        const eff = sk.effects || {};
        if (!eff.powerMultiplier) continue;
        if (eff.dotAtkScale || eff.isDeflect) continue;
        celEchoMap[m.id] = { skillId: sid, skill: sk, item: boundItem };
        break; // one celestial weapon proc per member
      }
    }
  }

  // ── Initialize passive deflect buffs (Monk 2H Flowing Defense) ────────
  // Scan party equipment for passive deflect skills and set permanent buffs.
  for (const m of members) {
    const allSkills = SE.skills(m.id);
    for (const sid of allSkills) {
      const sk = getSkill(sid);
      if (!sk || sk.type !== 'passive' || !sk.effects || !sk.effects.isDeflect) continue;
      const eff = sk.effects;
      if (eff.partyWide) {
        // Celestial party-wide deflect — apply to all party members
        for (const p of members) {
          const isSelf = p.id === m.id;
          deflectBuffs[p.id] = {
            rounds: Infinity,
            chance: isSelf ? (eff.selfDeflectChance || eff.deflectChance) : eff.deflectChance,
            reduction: isSelf ? (eff.selfDmgReduction || eff.dmgReduction) : eff.dmgReduction,
            reflect: isSelf ? (eff.selfReflectPct || eff.reflectPct) : eff.reflectPct,
            atkDebuff: eff.atkDebuff || 0,
            kiShieldPct: eff.kiShieldPct || 0,
            partyDodge: eff.partyDodgeBonus || 0,
            ownerId: m.id,
          };
        }
      } else {
        // Self-only passive deflect
        deflectBuffs[m.id] = {
          rounds: Infinity,
          chance: eff.deflectChance,
          reduction: eff.dmgReduction,
          reflect: eff.reflectPct,
          atkDebuff: eff.atkDebuff || 0,
          kiShieldPct: eff.kiShieldPct || 0,
          ownerId: m.id,
        };
      }
    }
  }

  // ATB gauges and tracking
  const atbGauges = {};
  const atbLastAction = {};
  for (const m of partyHp) {
    atbGauges[m.id] = { attack: 0, buff: 0, heal: 100 };
    atbLastAction[m.id] = null;
    // Init ATB debug lane tracking per member
    _combatDebug.atb.laneActions[m.id] = {
      name: m.name, class: m.class || 'HERO',
      attack: { fires: 0, basicFallbacks: 0, skillFires: 0, skillAttempts: 0 },
      buff: { fires: 0, procFails: 0, attempts: 0 },
      heal: { fires: 0, held: 0 },
      skillPools: {
        attack: memberAttackSkills[m.id]?.map(sid => { const sk = getSkill(sid); return sk ? sk.name : sid; }) || [],
        buff: memberBuffSkills[m.id]?.map(sid => { const sk = getSkill(sid); return sk ? sk.name : sid; }) || [],
        heal: memberHealSkills[m.id]?.map(sid => { const sk = getSkill(sid); return sk ? sk.name : sid; }) || [],
      },
    };
  }
  for (const e of enemies) {
    atbGauges[e.id] = { attack: 0 };
  }
  
  const skillCooldowns = {};
  for (const m of partyHp) {
    skillCooldowns[m.id] = {};
  }
  
  let roundCount = 0;
  const hasActedThisRound = new Set();
  
  function getEquipRarity(skillId) {
    if (skillId && skillId.startsWith('CEL_')) return 'celestial';
    if (skillId && skillId.startsWith('LEG_')) return 'legendary';
    return 'epic';
  }
  
  function getEquipProcCooldown(skillId) {
    const rarity = getEquipRarity(skillId);
    if (rarity === 'celestial') return 5;
    if (rarity === 'legendary') return 4;
    return 3;
  }

  function _logReactive(type, member, target, trigger) {
    _combatDebug.atb.reactiveEvents.push({ round: roundCount, type, member, target: target || '', trigger });
  }

  // Live buff state — passed to snapshots so UI can render indicators
  const _bufState = {
    regenPerTick: 0, coverCooldowns, knightsWithCover,
    rallyCooldowns, heroesWithRally, markedEnemies,
    roguesWithMark, monksWithKiBarrier,
    magesWithPhaseShift, phaseShiftRounds, phaseShiftCooldowns, phaseShiftDmgBoost,
    magesWithConstruct, arcaneConstructs, constructCooldowns,
    magesWithSpellEcho, spellEchoRounds, aftershockCooldowns,
    camoRounds, rangersWithVolley, smokeBombRounds: 0, swiftPalmRounds: 0,
    divineShieldRounds: 0, clericsWithDivineShield, divineShieldSource: null,
    clericsWithIntervention, interventionCooldowns,
    clericsWithResurrection, resurrectionCooldowns,
    bardsWithDiscord, discordCooldowns, discordRounds: 0, discordSource: null, discordAtkRedBonusTotal, discordFumbleBonusTotal,
    bardsWithCrescendo, crescendoCooldowns, crescendoActive: false,
    cadenceCooldowns, cadenceRounds: 0,
    frostbiteRounds: 0,
    // Hero Champion spec — Executioner's Mark
    heroesWithExecutioner, executionerCooldowns, executeMarkRounds,
    // Necromancer state
    necroMinions, necrosWithRaiseDead, raiseDeadCooldowns,
    necrosWithForgoDeath, blightRounds: 0, armyRounds: 0,
    necroticReflectMag, necGroupSiphonPct, darkPactRounds: 0, darkPactSource: null,
    // DoT trackers — passed by reference so snapshot sees live state
    poisonTargets, equipPoisonTargets, chiBurnTargets, deflectBuffs, burnTargets,
    // Monk reactives + buffs
    ironStanceBuffs, monksWithFlowingStrike, flowingStrikeCooldowns,
    // Knight Last Stand reactive
    knightsWithLastStand, lastStandBuffRounds, lastStandCooldowns,
    // Rogue Riposte reactive
    roguesWithRiposte, riposteCooldowns,
    // Hero specs — Last Stand (once per fight), Second Wind, Vanguard Intercept
    heroesWithLastStand, lastStandUsed,
    heroesWithSecondWind, secondWindCooldowns, secondWindRounds,
    heroesWithVanguard, vanguardCooldowns,
    // Talent buff trackers
    tauntedEnemies, defShredTargets, exposedTargets,
    sacredWarmthRounds, wrathBuff, stormMarkRounds,
  };

  // Arcane Construct opening event — deferred from member init loop because
  // _bufState wasn't available yet. Emit the summon narration now.
  for (const c of arcaneConstructs) {
    if (c.hp > 0 && c.mageRef) {
      events.push({ text: sPick(T_CONSTRUCT_SUMMON, seed + 77)(c.mageRef.name), type: 'magic', icon: '🔮', phase: 'battle' });
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
    }
  }

  // ── Reactive: Raise Dead ─────────────────────────────────────────────────
  // Fires as a reaction to an enemy death, regardless of which death path
  // flipped alive=false (basic kill, skill kill, AoE, counter, reflect, DoT,
  // minion tick, etc.). Call immediately after `corpse.alive = false` so the
  // raise event slots in right next to the kill narratively.
  //
  // Corpse pool persistence: if the immediate attempt can't fire (necro on
  // CD, thrall already up, 70% roll failed, no eligible necro), the corpse
  // is enqueued into pendingRaiseCorpses. Every end-of-round sweep retries
  // each pending corpse — so the fight never "wastes" a death, and the
  // signature skill remains available after a thrall dies or is consumed
  // as a damage sink for another necro skill. A corpse stays in the pool
  // until a raise succeeds or the battle ends.
  const pendingRaiseCorpses = [];

  // Internal: perform a single raise attempt against `corpse` using `seed`.
  // Returns true if a thrall was raised and all narrative events pushed.
  function attemptRaise(corpse, seed) {
    if (!corpse || necroMinions.length !== 0) return false;
    const availableNecro = partyHp.find(p =>
      p.hp > 0 && necrosWithRaiseDead.has(p.id) && (raiseDeadCooldowns[p.id] || 0) === 0
    );
    if (!availableNecro) return false;
    if (sRand(seed) >= 0.70) return false;
    const minionHpRaw = Math.max(10, Math.floor((corpse.maxHp || 20) * 0.40));
    const minionHp = Math.max(10, Math.floor(minionHpRaw * (1 + minionHpBonusTotal)));
    const minionDmg = Math.max(2, Math.floor(availableNecro.mag * 0.7));
    const minionDef = Math.max(1, Math.floor(availableNecro.mag * 0.25));
    necroMinions.push({
      id: `minion_${corpse.id}`, name: `${corpse.name} Thrall`,
      hp: minionHp, maxHp: minionHp,
      def: minionDef, dmgPerTick: minionDmg, ownerId: availableNecro.id,
    });
    raiseDeadCooldowns[availableNecro.id] = 2;
    const raiseText = sPick(T_RAISE_DEAD, seed + 1)(availableNecro.name, corpse.name);
    events.push({ text: raiseText, type: 'magic', icon: '💀', phase: 'battle' });
    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
    _logReactive('Raise Dead', availableNecro.name, corpse.name, `minion HP:${minionHp}`);
    return true;
  }

  // Reactive entry point called at every enemy-death site. Tries the raise
  // immediately; if it can't fire, enqueues the corpse for the end-of-round
  // sweep. Duplicates are guarded so the same corpse can only enter the
  // pool once regardless of how many code paths flip alive=false.
  function tryRaiseDead(corpse, seed) {
    if (!corpse) return false;
    if (attemptRaise(corpse, seed)) return true;
    if (!pendingRaiseCorpses.some(pc => pc.corpse === corpse)) {
      pendingRaiseCorpses.push({ corpse, seedBase: seed });
    }
    return false;
  }

  // End-of-round sweep: re-roll every pending corpse once. Stops as soon as
  // a raise succeeds (the minion gate will block the rest anyway) so the
  // oldest eligible corpse wins the retry queue ordering. The per-sweep
  // seed is varied with roundCount so the same corpse doesn't lock into a
  // permanent failing roll across rounds.
  function sweepPendingRaises() {
    if (pendingRaiseCorpses.length === 0) return;
    for (let i = 0; i < pendingRaiseCorpses.length; i++) {
      const entry = pendingRaiseCorpses[i];
      if (attemptRaise(entry.corpse, entry.seedBase + roundCount * 17)) {
        pendingRaiseCorpses.splice(i, 1);
        return; // minion gate now blocks further attempts
      }
    }
  }

  // ── Manual battle mode ─────────────────────────────────────────────────
  // In a manual battle the player chooses the move (and target) for every
  // party attack / buff turn. The sim stays a pure function of
  // (seed, frozen inputs, recorded decisions): when it reaches a turn that has
  // no recorded decision it stops and describes that turn in `pending`. The UI
  // records the answer and the battle is replayed from the start with one more
  // decision. Heals, reactive skills, passives and equipment procs stay automatic.
  const manualMode = aq.battleMode === 'manual';
  const manualDecisions = Array.isArray(aq.manualDecisions) ? aq.manualDecisions : [];
  const manualAutoRest = manualMode && !!aq.manualAutoRest;
  const MANUAL_BASIC = '__BASIC__';
  let manualCursor = 0;
  let manualPending = null;
  let manualTargetId = null;
  function pickTarget(list, s) {
    if (manualTargetId) {
      const t = list.find(e => e.id === manualTargetId);
      if (t) return t;
    }
    return sPick(list, s);
  }
  function manualOptions(member, lane) {
    const cds = skillCooldowns[member.id] || {};
    const opts = [];
    if (lane === 'attack') {
      opts.push({ id: MANUAL_BASIC, name: 'Basic Attack', icon: '⚔', desc: 'A plain strike against one enemy.', kind: 'single', ready: true, cd: 0 });
    }
    const pool = lane === 'attack' ? memberAttackSkills[member.id] : memberBuffSkills[member.id];
    for (const sid of pool || []) {
      const sk = getSkill(sid);
      if (!sk) continue;
      if (lane === 'buff' && sid === 'CAMOUFLAGE' && member.class !== 'RANGER') continue;
      const cd = cds[sid] || 0;
      const kind = lane === 'attack'
        ? (AOE_SKILLS[sid] ? 'aoe' : 'single')
        : (sid === 'MARK_FOR_DEATH' ? 'single' : 'party');
      opts.push({ id: sid, name: sk.name || sid, icon: sk.icon || '✦', desc: sk.description || '', kind, ready: cd <= 0, cd });
    }
    return opts;
  }
  // Returns null (automatic turn), { skip } (nothing usable), { pause } (waiting
  // for the player) or { skillId, targetId } (the move to perform).
  function manualTurn(member, lane, foes) {
    if (!manualMode) return null;
    if (manualAutoRest && manualCursor >= manualDecisions.length) return null;
    const usable = manualOptions(member, lane).filter(o => o.ready);
    if (usable.length === 0) return { skip: true };
    const needsTarget = (o) => o.kind === 'single';
    if (usable.length === 1 && (!needsTarget(usable[0]) || foes.length === 1)) {
      return { skillId: usable[0].id, targetId: needsTarget(usable[0]) ? foes[0].id : null };
    }
    const d = manualDecisions[manualCursor];
    if (d) {
      manualCursor++;
      const o = usable.find(x => x.id === d.skillId) || usable[0];
      const t = needsTarget(o) && foes.some(e => e.id === d.targetId) ? d.targetId : null;
      return { skillId: o.id, targetId: t };
    }
    manualPending = {
      index: manualCursor,
      memberId: member.id,
      memberName: member.name,
      lane,
      options: manualOptions(member, lane),
      enemies: foes.map(e => ({ id: e.id, name: e.name, hp: e.hp, maxHp: e.maxHp })),
    };
    return { pause: true };
  }
  roundLoop: for (let i = 0; i < MAX_BATTLE_EVENTS; i++) {
    _bufState.regenPerTick = regenPerTick;
    _bufState.clericRegenPerTick = clericRegenPerTick;
    _bufState.divineShieldRounds = divineShieldRounds;
    _bufState.discordRounds = discordRounds;
    _bufState.crescendoActive = crescendoActive;
    _bufState.cadenceRounds = cadenceRounds;
    _bufState.frostbiteRounds = frostbiteRounds;
    _bufState.smokeBombRounds = smokeBombRounds;
    _bufState.swiftPalmRounds = swiftPalmRounds;
    _bufState.blightRounds = blightRounds;
    _bufState.darkPactRounds = darkPactRounds;
    _bufState.armyRounds = armyRounds;
    _bufState.graveHungerStacks = graveHungerStacks;
  
    let livingEnemies = enemies.filter(e => e.alive);
    let livingParty = partyHp.filter(p => p.hp > 0);

    if (livingEnemies.length === 0) { battleOutcome = 'victory'; break; }
    if (livingParty.length === 0) { battleOutcome = 'defeat'; break; }
  
    // Advance ATB gauges — fill rates scaled so actions happen every ~2-4 ticks.
    // All three of these dials are centralized in COMBAT_TUNING at the top of
    // the file. They are re-aliased locally here only so the hot loop below
    // reads cleanly; to actually change a value, edit COMBAT_TUNING.
    const ATB_THRESHOLD = COMBAT_TUNING.ATB_THRESHOLD;
    const HEAL_TRIGGER_PCT = COMBAT_TUNING.HEAL_TRIGGER_PCT;
    const HEAL_EMERGENCY_PCT = COMBAT_TUNING.HEAL_EMERGENCY_PCT;
    for (const m of livingParty) {
      const spd = m.spd || 10;
      const spdMult = swiftPalmRounds > 0 ? 1.15 : 1.0;
      const spdFill = Math.floor((20 + spd * 3) * spdMult); // base 20 + 3×SPD → SPD 5=35, SPD 18=74
      atbGauges[m.id].attack += spdFill;
      if (memberBuffSkills[m.id].length > 0) atbGauges[m.id].buff += spdFill;
      atbGauges[m.id].heal += spdFill + (m.mag || 1) * 2;
    }
    for (const e of livingEnemies) {
      // Chi Burn SPD debuff — Monk offhand DoTs slow enemy ATB fill
      const chiBurnSlow = (chiBurnTargets[e.id] && chiBurnTargets[e.id].rounds > 0) ? (1.0 - chiBurnTargets[e.id].spdDebuff) : 1.0;
      atbGauges[e.id].attack += Math.floor((25 + e.atk * 1.5) * chiBurnSlow); // base 25 + 1.5×ATK → enemies act every 2-3 ticks
    }
  
    // Collect actors this tick
    const actorsThisTick = [];
    for (const m of livingParty) {
      if (atbGauges[m.id].attack >= ATB_THRESHOLD) {
        actorsThisTick.push({ memberId: m.id, lane: 'attack', spd: m.spd, isParty: true });
      }
    }
    for (const m of livingParty) {
      if (memberBuffSkills[m.id].length > 0 && atbGauges[m.id].buff >= ATB_THRESHOLD) {
        actorsThisTick.push({ memberId: m.id, lane: 'buff', spd: m.spd, isParty: true });
      }
    }
    const partyNeedsHeal = livingParty.some(p => p.hp < p.maxHp * HEAL_TRIGGER_PCT);
    const partyEmergency = livingParty.some(p => p.hp < p.maxHp * HEAL_EMERGENCY_PCT);
    for (const m of livingParty) {
      if (memberHealSkills[m.id].length === 0) continue;
      const gaugeReady = atbGauges[m.id].heal >= ATB_THRESHOLD;
      if (partyEmergency) {
        // Emergency bypass — force-fire this healer this tick regardless of gauge.
        // Snap the gauge to threshold so the downstream reset to 0 still works.
        if (!gaugeReady) atbGauges[m.id].heal = ATB_THRESHOLD;
        actorsThisTick.push({ memberId: m.id, lane: 'heal', spd: m.spd, isParty: true });
      } else if (gaugeReady) {
        if (partyNeedsHeal) {
          actorsThisTick.push({ memberId: m.id, lane: 'heal', spd: m.spd, isParty: true });
        } else {
          // Gauge is full but held — party healthy
          if (_combatDebug.atb.laneActions[m.id]) _combatDebug.atb.laneActions[m.id].heal.held++;
        }
      }
    }
    for (const e of livingEnemies) {
      if (atbGauges[e.id].attack >= ATB_THRESHOLD) {
        actorsThisTick.push({ enemyId: e.id, lane: 'attack', spd: e.atk * 0.5, isParty: false });
      }
    }
  
    actorsThisTick.sort((a, b) => {
      if (b.spd !== a.spd) return b.spd - a.spd;
      return a.isParty ? -1 : 1;
    });
  
    for (let actorIdx = 0; actorIdx < actorsThisTick.length; actorIdx++) {
      const actor = actorsThisTick[actorIdx];
      // Per-actor seed offset so actors in the same tick get different rolls
      const es = seed + (i + 10) * 7919 + actorIdx * 997;
      if (actor.isParty) {
        const m = partyHp.find(p => p.id === actor.memberId);
        if (!m || m.hp <= 0) continue;
      } else {
        const e = enemies.find(en => en.id === actor.enemyId);
        if (!e || !e.alive) continue;
      }

      // Re-filter living lists so this actor sees kills/KOs from earlier
      // actors in the same tick. Prevents phantom attacks on dead targets.
      livingEnemies = enemies.filter(e => e.alive);
      livingParty = partyHp.filter(p => p.hp > 0);
      // Early-out: if one side is wiped mid-tick, stop processing actors
      if (livingEnemies.length === 0 || livingParty.length === 0) break;

      let text = '';
      let type = 'attack';
      let icon = '⚔';
      let actionPerformed = false;

      // Snapshot living enemy count before the actor acts — used by the
      // Arcane Aftershock kill-hook at the end of the loop body to detect
      // whether this actor's action produced a fresh killing blow.
      manualTargetId = null;
      const _enemiesAlivePre = enemies.filter(e => e.alive).length;

      if (actor.lane === 'attack') {
        // ─────────────────────────────────────────────────────────────────────
        // ATTACK LANE: Party attacks enemy
        // ─────────────────────────────────────────────────────────────────────
  
        if (actor.isParty) {
          const attacker = partyHp.find(p => p.id === actor.memberId);
          if (!attacker || livingEnemies.length === 0) continue;
          // Symphony Leech (10%) — snapshot dmgDealt before this turn for lifesteal calc
          const _dmgBefore = symphonyLeechActive && combatStats[attacker.id] ? combatStats[attacker.id].dmgDealt : 0;

          const targetCount = livingEnemies.length;
          const _mt = manualTurn(attacker, 'attack', livingEnemies);
          if (_mt && _mt.pause) break roundLoop;
          const manualPick = _mt && !_mt.skip ? _mt : null;
          manualTargetId = manualPick ? manualPick.targetId : null;
          let skillPool = manualPick
            ? (manualPick.skillId === MANUAL_BASIC ? [] : [manualPick.skillId])
            : memberAttackSkills[attacker.id].filter(sid => !skillCooldowns[attacker.id][sid]);
  
          if (skillPool.length === 0) {
            // Basic attack — no skills off cooldown
            if (_combatDebug.atb.laneActions[attacker.id]) {
              _combatDebug.atb.laneActions[attacker.id].attack.fires++;
              _combatDebug.atb.laneActions[attacker.id].attack.basicFallbacks++;
            }
            const target = pickTarget(livingEnemies, es + 100);
            let baseDmg = calcPartyDmg(attacker, es + 101, dmgBonus);
            // Knight basic attacks blend a small amount of DEF so they don't
            // feel completely weightless between skill procs.
            if (attacker.class === 'KNIGHT' && attacker.def) {
              const _baDef = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(es + 821) * COMBAT_TUNING.PARTY_DMG_SPREAD;
              baseDmg += Math.floor(attacker.def * 0.08 * _baDef);
            }

            if (wrathBuff[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.30);
            if (bloodlustActive[attacker.id]) {
              baseDmg = Math.floor(baseDmg * 1.5);
              delete bloodlustActive[attacker.id];
            }
            // Knight Last Stand — +20% ATK while buff is active
            if (attacker.class === 'KNIGHT' && lastStandBuffRounds[attacker.id] > 0) {
              baseDmg = Math.floor(baseDmg * 1.20);
            }
            // Hero Second Wind — +20% ATK while buff is active
            if (attacker.class === 'HERO' && secondWindRounds[attacker.id] > 0) {
              baseDmg = Math.floor(baseDmg * 1.20);
            }
            // Bard Cadence — +15% party dmg while buff is active
            if (cadenceRounds > 0) baseDmg = Math.floor(baseDmg * 1.15);
            // Monk Swift Palm — +25% party ATK while buff is active
            if (swiftPalmRounds > 0) baseDmg = Math.floor(baseDmg * 1.25);
            if (spellEchoRounds[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.50);
            if (phaseShiftDmgBoost[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.25);
            if (markedEnemies[target.id]) baseDmg = Math.floor(baseDmg * 1.20);
            if (executeMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
            if (stormMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.15);
            if (tauntedEnemies[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
            if (defShredTargets[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.12);
            if (exposedTargets[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
  
            const isExecute = talentExecute && attacker.class === 'ROGUE' && target.hp < target.maxHp * 0.25;
            const isCrescendo = crescendoActive;
            const isCrescendoAlly = !isCrescendo && crescendoAllyCharges.count > 0;
            // Hunter's Mark — Ranger's primed arrow auto-crits for 1.5×
            const isHuntersMark = attacker.class === 'RANGER' && (huntersMarkCharges[attacker.id] || 0) > 0;
            const cadenceCritBonus = cadenceRounds > 0 ? 0.10 : 0;
            const isCrit = isCrescendo || isCrescendoAlly || isExecute || isHuntersMark || sRand(es + 102) < (critChance(attacker) + graveHungerCritBonus + cadenceCritBonus);
            // Crescendo / Crescendo-ally burst multipliers (2.5× / 2.0×) are Bard-signature
            // numbers and INLINED BY DESIGN — they live with the Crescendo mechanic, not in
            // COMBAT_TUNING. The standard crit path uses COMBAT_TUNING.PARTY_BASE_CRIT_MULT.
            // Hunter's Mark uses a signature 1.5× per §3.6 — also INLINED BY DESIGN.
            const critMult = isCrescendo ? 2.5 : (isCrescendoAlly ? 2.0 : (isHuntersMark ? 1.5 : COMBAT_TUNING.PARTY_BASE_CRIT_MULT));
            const dmg = isCrit ? Math.floor(baseDmg * critMult) : baseDmg;

            if (isHuntersMark) huntersMarkCharges[attacker.id] = 0;
            if (isCrescendoAlly) crescendoAllyCharges.count--;
            if (isCrescendo) {
              crescendoActive = false;
              _bufState.crescendoActive = false;
              if (crescendoSourceId && combatStats[crescendoSourceId]) {
                combatStats[crescendoSourceId].dmgDealt += Math.floor(baseDmg * (critMult - 1));
              }
            }
  
            target.hp = Math.max(0, target.hp - dmg);
            if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += dmg;
  
            // HRO_CHAIN_STRIKE tightened — now fires on HEROIC_STRIKE skill proc
            // only (see §7.7 audit). Hook moved to the skill attack path below.
  
            // Celestial Cascade — removed from class skill path (v=153).
            // Now fires exclusively on celestial weapon damage procs and echoes.

            // Prime the base attack text up-front so modifier stacks below
            // push the correct line (not a fresh re-computed template).
            {
              const _classId = attacker.class || 'HERO';
              if (isCrit) {
                text = getAttackTemplate(_classId, es)(attacker.name, target.name, `${dmg} CRIT`);
                text = text.replace(/dmg-(phys|mag)/, 'dmg-crit');
                icon = '💥'; type = 'crit';
              } else {
                text = getAttackTemplate(_classId, es)(attacker.name, target.name, dmg);
                icon = isMagicClass(_classId) ? '✨' : '⚔';
                type = 'attack';
              }
            }

            // Bard Crescendo (reactive) — ally crit primes next attack for 2.5× devastating crit.
            // Guard: skip if this very crit was already a Crescendo-consumed hit (no chaining).
            if (isCrit && !isCrescendo && !crescendoActive && bardsWithCrescendo.size > 0) {
              for (const bardId of bardsWithCrescendo) {
                if ((crescendoCooldowns[bardId] || 0) !== 0) continue;
                const bard = partyHp.find(p => p.id === bardId && p.hp > 0);
                if (!bard) continue;
                crescendoActive = true;
                crescendoSourceId = bardId;
                crescendoCooldowns[bardId] = 3;
                if (talentCrescendoAlly) crescendoAllyCharges.count = 2;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_CRESCENDO, es + 108)(bard.name);
                icon = '🎶'; type = 'buff';
                _logReactive('Crescendo', bard.name, attacker.name, 'next-attack 2.5× crit buff');
                if (talentCrescendoAlly) {
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `The Crescendo echoes — next 2 ally attacks will crit!`;
                  icon = '🎵'; type = 'buff';
                }
                break;
              }
            }

            // Rogue Mark for Death
            if (isCrit && roguesWithMark.has(attacker.id) && target.alive && target.hp > 0) {
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              markedEnemies[target.id] = 2;
              text = sPick(T_MARK_FOR_DEATH, es + 104)(attacker.name, target.name);
              icon = '🎯'; type = 'debuff';
            }
  
            // Ki Barrier lifesteal
            if (monksWithKiBarrier.has(attacker.id) && attacker.hp > 0) {
              const kiRate = talentDeepKi ? 0.40 : 0.25;
              const lifeSteal = Math.max(1, Math.floor(dmg * kiRate));
              const before = attacker.hp;
              attacker.hp = Math.min(attacker.maxHp, attacker.hp + lifeSteal);
              const actual = attacker.hp - before;
              if (actual > 0) {
                if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += actual;
                if (combatStats[attacker.id]) combatStats[attacker.id].healingReceived += actual;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_KI_BARRIER, es + 105)(attacker.name, actual);
                icon = '🔮'; type = 'heal';
              }
            }
  
            // Bloodlust on kill
            if (target.hp <= 0) {
              target.alive = false;
              const bloodlustHero = partyHp.find(p => p.hp > 0 && heroesWithBloodlust.has(p.id));
              if (bloodlustHero) {
                bloodlustActive[bloodlustHero.id] = true;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_BLOODLUST_KILL, es + 106)(bloodlustHero.name);
                icon = '🩸'; type = 'buff';
              } else {
                text = sPick(T_ENEMY_DEFEAT, es + 107)(target.name, attacker.name);
                icon = '💥'; type = 'defeat';
              }
  
              if (talentGraveHunger && graveHungerStacks < 5) {
                graveHungerStacks++;
                dmgBonus += 0.02; // +2% party damage per stack (§7.7)
                graveHungerCritBonus += 0.01; // +1% party crit per stack
                graveHungerDefBonus += 0.01;  // +1% party DEF per stack
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = `The grave hungers — <span class="sk-buff">stack ${graveHungerStacks}/5</span>! (+${graveHungerStacks * 2}% dmg, +${graveHungerStacks}% crit, +${graveHungerStacks}% DEF)`;
                icon = '🩸'; type = 'buff';
              }

              // Hunter's Mark — Ranger killing blow primes next Ranger arrow for auto-crit
              if (attacker.class === 'RANGER' && rangersWithHuntersMark.has(attacker.id)
                  && (huntersMarkCooldowns[attacker.id] || 0) === 0) {
                huntersMarkCharges[attacker.id] = 1;
                huntersMarkCooldowns[attacker.id] = 3;
              }
  
              // Raise Dead — reacts to this kill via the shared helper so
              // every death path (basic, skill, AoE, counter, DoT, reflect,
              // minion tick) runs the same reactive logic.
              tryRaiseDead(target, es + 108);
            }
            // (Base attack text was primed above; target-alive path keeps modifier text.)

            atbGauges[attacker.id].attack = 0;
            actionPerformed = true;
          } else {
            // Skill attack
            const skillId = manualPick ? manualPick.skillId : sPick(skillPool, es + 200);
            const skill = getSkill(skillId);
            const atkProcRoll = sRand(es + 201);
            const atkProcThreshold = skill ? (skill.procChance || 0.70) : 0.70;
            if (_combatDebug.atb.laneActions[attacker.id]) {
              _combatDebug.atb.laneActions[attacker.id].attack.skillAttempts++;
            }
            _combatDebug.atb.procRolls.push({
              round: roundCount, member: attacker.name, lane: 'attack',
              skillId, skillName: skill?.name || skillId,
              procChance: atkProcThreshold, roll: Math.round(atkProcRoll * 1000) / 1000,
              fired: skill && atkProcRoll < atkProcThreshold,
            });
            if (skill && (manualPick || atkProcRoll < atkProcThreshold)) {
              if (_combatDebug.atb.laneActions[attacker.id]) {
                _combatDebug.atb.laneActions[attacker.id].attack.fires++;
                _combatDebug.atb.laneActions[attacker.id].attack.skillFires++;
              }
              // Knight class skills scale partly off DEF so the whole kit does
              // respectable damage despite low ATK. Values are intentionally modest
              // to keep Knight below CLR/BRD damage output — weapon procs close the gap.
              const CLASS_SKILL_DEF_SCALING = {
                SHIELD_BASH: 0.10,     // L1 opener — lightest scaling
                SHIELD_CHARGE: 0.15,   // L2 main ST skill
                SWEEPING_BLOW: 0.15,   // L10 AoE capstone
                UNBREAKABLE: 0.20,     // L18 EPIC — heaviest class skill scaling
              };
              const aoeInfo = AOE_SKILLS[skillId];
              if (aoeInfo) {
                // AoE SKILL
                // Early bail — no living targets (all died earlier this tick).
                // Without this guard the template renders "0 foes" lines and
                // DoT/debuff hooks run over an empty set.
                const preLiving = enemies.filter(e => e.alive);
                if (preLiving.length === 0) {
                  atbGauges[attacker.id].attack = 0;
                  actionPerformed = true;
                  continue;
                }
                let aoeRawBase = calcPartyDmg(attacker, es + 202, dmgBonus);
                const classDefScale = CLASS_SKILL_DEF_SCALING[skillId];
                if (classDefScale && attacker.def) {
                  const defMult = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(es + 819) * COMBAT_TUNING.PARTY_DMG_SPREAD;
                  aoeRawBase += Math.floor(attacker.def * classDefScale * defMult);
                }
                const perTargetDmg = Math.max(2, Math.floor(aoeRawBase * aoeInfo.dmgScale));
                let echoDmg = spellEchoRounds[attacker.id] > 0 ? Math.floor(perTargetDmg * 1.50) : perTargetDmg;
                if (phaseShiftDmgBoost[attacker.id] > 0) echoDmg = Math.floor(echoDmg * 1.25);
                const currentLiving = preLiving;
                let aoeTotalDmg = 0;
  
                let aoeKilled = false;
                for (const e of currentLiving) {
                  let mAmp = 1.0;
                  if (markedEnemies[e.id]) mAmp *= 1.20;
                  if (executeMarkRounds[e.id] > 0) mAmp *= 1.10;
                  const ampDmg = mAmp > 1.0 ? Math.floor(echoDmg * mAmp) : echoDmg;
                  e.hp = Math.max(0, e.hp - ampDmg);
                  aoeTotalDmg += ampDmg;
                  if (e.hp <= 0) { e.alive = false; aoeKilled = true; tryRaiseDead(e, es + 1730); }
                }
                if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += aoeTotalDmg;

                // Hunter's Mark — Ranger killing blow via AoE primes next arrow
                if (aoeKilled && attacker.class === 'RANGER' && rangersWithHuntersMark.has(attacker.id)
                    && (huntersMarkCooldowns[attacker.id] || 0) === 0) {
                  huntersMarkCharges[attacker.id] = 1;
                  huntersMarkCooldowns[attacker.id] = 3;
                }
  
                if (aoeInfo.templates === T_VOLLEY) {
                  text = sPick(T_VOLLEY, es + 203)(attacker.name, currentLiving.length, echoDmg);
                } else {
                  text = sPick(aoeInfo.templates, es + 203)(attacker.name, skill.name, currentLiving.length, echoDmg);
                }
                icon = aoeInfo.icon; type = aoeInfo.type;
  
                // Camouflage trigger
                if (aoeInfo.triggerCamo && rangersWithCamouflage.has(attacker.id)) {
                  camoRounds[attacker.id] = 2;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_CAMOUFLAGE, es + 204)(attacker.name);
                  icon = '🍃'; type = 'buff';
                  if (talentSharedCamo) {
                    const lowestAlly = livingParty.filter(p => p.id !== attacker.id).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
                    if (lowestAlly) {
                      camoRounds[lowestAlly.id] = 2;
                      events.push({ text, type, icon, phase: 'battle' });
                      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                      text = `${lowestAlly.name} is pulled into the shadows — <span class="sk-buff">+20% dodge</span> for 2 rounds!`;
                      icon = '🌿'; type = 'buff';
                    }
                  }
                }
  
                // Suppressing Fire — tightened to fire only on VOLLEY (§7.7 audit)
                if (talentVolleySlow && skillId === 'VOLLEY') {
                  for (const e of currentLiving) {
                    if (e.alive) e.atk = Math.max(1, Math.floor(e.atk * 0.80));
                  }
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `Suppressing fire weakens all foes — <span class="sk-debuff">-20% ATK</span> for 1 round!`;
                  icon = '🎯'; type = 'debuff';
                }
  
                // Storm Mark
                if (talentStormMark && (skillId === 'ARROW_STORM' || skillId === 'STORM_VOLLEY')) {
                  let markCount = 0;
                  for (const e of currentLiving) {
                    if (e.alive) { stormMarkRounds[e.id] = 2; markCount++; }
                  }
                  if (markCount > 0) {
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `Storm arrows mark ${markCount} ${markCount === 1 ? 'foe' : 'foes'} — <span class="sk-debuff">+15% damage taken</span> for 2 rounds!`;
                    icon = '🌧'; type = 'debuff';
                  }
                }
  
                // MAG_METEOR_BURN "Lingering Flames" — Meteor Storm leaves a burn DoT
                // Bumped 10% → 15% MAG/tick, 2 → 3 rounds so the tail actually
                // contributes meaningful damage on the Mage's flagship AoE.
                if (talentMeteorBurn && (skillId === 'METEOR_STORM')) {
                  const burnDmg = Math.max(2, Math.floor((attacker.mag || 10) * 0.15));
                  let burnCount = 0;
                  for (const e of currentLiving) {
                    if (e.alive) { burnTargets[e.id] = { rounds: 3, dmgPerTick: burnDmg, source: 'MAG', ownerId: attacker.id }; burnCount++; }
                  }
                  if (burnCount > 0) {
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `Lingering flames engulf ${burnCount} ${burnCount === 1 ? 'foe' : 'foes'} — <span class="dmg-num dmg-mag">${burnDmg}</span>/round burn for 3 rounds!`;
                    icon = '🔥'; type = 'debuff';
                  }
                }

                // Frostbite (legacy skill) — apply 3-round chill on cast
                if (skillId === 'FROSTBITE') {
                  frostbiteRounds = 3;
                }

                // MAG_BLIZZARD_FROST "Frostbite" — Blizzard has a 60% chance to chill
                // all enemies, applying the party-wide frostbite debuff (ATK slow +
                // fumble). Reuses existing frostbiteRounds infrastructure.
                if (talentBlizzardFrost && attacker.class === 'MAGE' && skillId === 'BLIZZARD') {
                  if (sRand(es + 216) < 0.60) {
                    frostbiteRounds = Math.max(frostbiteRounds, 2);
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `The Blizzard's chill lingers — <span class="sk-debuff">Frostbite</span> grips every foe for 2 rounds!`;
                    icon = '❄'; type = 'debuff';
                    _logReactive('Frostbite', attacker.name, '', 'all enemies chilled 2r');
                  }
                }

                // Consecration — consecrated ground party buff (DEF +10% + HoT) for 2r.
                if (skillId === 'CONSECRATION') {
                  consecrationRounds = Math.max(consecrationRounds, 2);
                  consecrationSource = attacker.name;
                }

                // Fan of Knives — always poisons struck enemies (7% max HP/round, 3r)
                // AND applies Exposed (+10% damage taken, 2r) per §3.4.
                // Poison bumped 5% → 7% so Rogue's signature AoE DoT keeps up.
                if (skillId === 'FAN_OF_KNIVES') {
                  for (const e of currentLiving) {
                    if (!e.alive) continue;
                    const pDmg = Math.max(2, Math.floor(e.maxHp * 0.07));
                    poisonTargets[e.id] = { rounds: 3, dmgPerTick: pDmg, ownerId: attacker.id };
                    exposedTargets[e.id] = 2;
                  }
                }

                // Righteous Burn — always applies burn DoT to struck enemies (40% MAG/r, 3r)
                // Bumped from 12% → 30% → 40% to match Blight (40% MAG).
                if (skillId === 'RIGHTEOUS_BURN') {
                  const burnDmg = Math.max(2, Math.floor((attacker.mag || 10) * 0.40));
                  for (const e of currentLiving) {
                    if (!e.alive) continue;
                    burnTargets[e.id] = { rounds: 3, dmgPerTick: burnDmg, source: 'CLR', ownerId: attacker.id };
                  }
                }

                // HRO_WHIRLWIND_HEAL "Whirlwind Heal" — Hero AoE skills
                // (Sword Dance / Whirlwind Dance) heal the party for 6% max HP
                // per enemy struck. Wired to all spec variants so it never dead-talents.
                if (talentWhirlwindHeal && (skillId === 'WHIRLWIND_DANCE' || skillId === 'SWORD_DANCE')) {
                  const struck = currentLiving.filter(e => e.alive).length;
                  if (struck > 0) {
                    let totalHealed = 0;
                    for (const p of livingParty) {
                      if (p.hp <= 0) continue;
                      const healAmt = Math.max(1, Math.floor(p.maxHp * 0.06 * struck));
                      const before = p.hp;
                      p.hp = Math.min(p.maxHp, p.hp + healAmt);
                      const actual = p.hp - before;
                      if (actual > 0) {
                        totalHealed += actual;
                        if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += actual;
                        if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
                      }
                    }
                    if (totalHealed > 0) {
                      const skillLabel = skillId === 'SWORD_DANCE' ? 'Sword Dance' : 'Whirlwind Dance';
                      events.push({ text, type, icon, phase: 'battle' });
                      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                      text = `${attacker.name}'s ${skillLabel} revitalizes the party — <span class="dmg-num dmg-heal">${totalHealed}</span> HP restored!`;
                      icon = '🌀'; type = 'heal';
                    }
                  }
                }
  
                // Arcane Aftershock (formerly Spell Echo) — NO LONGER auto-primes
                // on cast. It is now a reactive, primed when an ally lands a
                // killing blow. See the post-actor kill-hook below (§3.3 rework).

                skillCooldowns[attacker.id][skillId] = SKILL_COOLDOWN;
                actionPerformed = true;
              } else if (skillId === 'HEROS_WRATH') {
                // Champion Hero's Wrath
                let baseDmg = Math.max(3, Math.floor(calcPartyDmg(attacker, es + 206, dmgBonus) * 3.0));
                if (bloodlustActive[attacker.id]) {
                  baseDmg = Math.floor(baseDmg * 1.5);
                  delete bloodlustActive[attacker.id];
                }
                if (attacker.class === 'HERO' && secondWindRounds[attacker.id] > 0) {
                  baseDmg = Math.floor(baseDmg * 1.20);
                }
                if (spellEchoRounds[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.50);
            if (phaseShiftDmgBoost[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.25);
                {
                  const _mtEnt = pickTarget(livingEnemies, es + 207);
                  if (markedEnemies[_mtEnt.id]) baseDmg = Math.floor(baseDmg * 1.20);
                  if (executeMarkRounds[_mtEnt.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
                }
  
                const target = pickTarget(livingEnemies, es + 208);
                target.hp = Math.max(0, target.hp - baseDmg);
                if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += baseDmg;
                text = sPick(T_HEROS_WRATH, es + 209)(attacker.name, target.name, baseDmg);
                icon = '⚡'; type = 'crit';
  
                if (target.hp <= 0) {
                  target.alive = false;
                  if (heroesWithBloodlust.has(attacker.id)) bloodlustActive[attacker.id] = true;
                  tryRaiseDead(target, es + 1884);
                }

                skillCooldowns[attacker.id][skillId] = SKILL_COOLDOWN;
                actionPerformed = true;
              } else if (skillId === 'SHADOW_BOLT') {
                // Necromancer Shadow Bolt (class rework L6) — 1.3× MAG-scaled damage
                // with a party-wide leech on proc: each living ally heals 10% of their
                // own max HP. "AoE Rally" — slightly above Rally Cry's 15% single-target
                // heal per person, but well below Cleric group heal output.
                // INLINED BY DESIGN — the 1.3× multiplier and 0.10 leech ratio are
                // Shadow Bolt's class-signature numbers and are intentionally NOT in
                // COMBAT_TUNING. Change them here if rebalancing the Necromancer.
                let baseDmg = Math.max(3, Math.floor(calcPartyDmg(attacker, es + 210, dmgBonus) * 1.3));
                if (bloodlustActive[attacker.id]) {
                  baseDmg = Math.floor(baseDmg * 1.5);
                  delete bloodlustActive[attacker.id];
                }
                if (attacker.class === 'HERO' && secondWindRounds[attacker.id] > 0) {
                  baseDmg = Math.floor(baseDmg * 1.20);
                }
                if (spellEchoRounds[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.50);
            if (phaseShiftDmgBoost[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.25);

                const target = pickTarget(livingEnemies, es + 211);
                if (markedEnemies[target.id]) baseDmg = Math.floor(baseDmg * 1.20);
                if (executeMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
                target.hp = Math.max(0, target.hp - baseDmg);
                if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += baseDmg;

                text = sPick(T_SHADOW_BOLT, es + 212)(attacker.name, target.name, baseDmg);
                icon = '🌑'; type = 'magic';

                // Party leech — each living ally heals 10% of their own max HP
                // Design: "AoE Rally" — slightly more per person than Rally Cry's
                // 15% single-target heal, but well below Cleric group heal output.
                {
                  const leechPct = 0.10;
                  let leechCount = 0;
                  let leechTotal = 0;
                  for (const ally of livingParty) {
                    if (ally.hp <= 0) continue;
                    const healAmt = Math.max(1, Math.floor(ally.maxHp * leechPct));
                    const before = ally.hp;
                    ally.hp = Math.min(ally.maxHp, ally.hp + healAmt);
                    const actual = ally.hp - before;
                    if (actual > 0) {
                      leechCount++;
                      leechTotal += actual;
                      if (combatStats[ally.id]) combatStats[ally.id].healingReceived += actual;
                      if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += actual;
                    }
                  }
                  if (leechCount > 0) {
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = sPick(T_SHADOW_BOLT_LEECH, es + 213)(leechCount, leechTotal);
                    icon = '🩸'; type = 'heal';
                  }
                }

                if (target.hp <= 0) {
                  target.alive = false;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_ENEMY_DEFEAT, es + 214)(target.name, attacker.name);
                  icon = '💥'; type = 'defeat';
                  tryRaiseDead(target, es + 1943);
                }

                skillCooldowns[attacker.id][skillId] = SKILL_COOLDOWN;
                actionPerformed = true;
              } else if (skillId === 'PRESSURE_POINT') {
                // Monk Pressure Point (class rework L14) — 1.7× ATK w/ +10% crit chance,
                // applies debuff: target deals -20% dmg and takes +10% dmg for 2 rounds.
                // INLINED BY DESIGN — the 1.7× damage, +0.10 crit bonus, -0.20 enemy
                // damage debuff, and 2-round duration are Pressure Point's class-signature
                // numbers and are intentionally NOT in COMBAT_TUNING.
                let baseDmg = Math.max(3, Math.floor(calcPartyDmg(attacker, es + 215, dmgBonus) * 1.7));
                if (bloodlustActive[attacker.id]) {
                  baseDmg = Math.floor(baseDmg * 1.5);
                  delete bloodlustActive[attacker.id];
                }
                if (attacker.class === 'HERO' && secondWindRounds[attacker.id] > 0) {
                  baseDmg = Math.floor(baseDmg * 1.20);
                }
                // Extra +10% crit (on top of base crit chance) for Pressure Point
                const ppCritRoll = sRand(es + 216);
                const ppIsCrit = ppCritRoll < 0.10;
                if (ppIsCrit) baseDmg = Math.floor(baseDmg * 1.5);

                const target = pickTarget(livingEnemies, es + 217);
                if (markedEnemies[target.id]) baseDmg = Math.floor(baseDmg * 1.20);
                if (executeMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
                target.hp = Math.max(0, target.hp - baseDmg);
                if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += baseDmg;

                // Apply pressure point debuff — 2 rounds
                pressurePointDebuffs[target.id] = 2;

                text = sPick(T_PRESSURE_POINT, es + 218)(attacker.name, target.name, baseDmg);
                icon = '🫳'; type = ppIsCrit ? 'crit' : 'skill';

                // MNK_KI_BOOST → "Ki Barrier Resurgence": Pressure Point grants
                // a 10% max HP Ki Shield for 2 rounds on the caster.
                // INLINED BY DESIGN — 0.10 max HP shield is the Ki Barrier Resurgence
                // class-signature number, not a global tuning knob.
                if (talentDeepKi) {
                  const shieldHp = Math.max(1, Math.floor(attacker.maxHp * 0.10));
                  kiShieldHP[attacker.id] = Math.max(kiShieldHP[attacker.id] || 0, shieldHp);
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_KI_SHIELD, es + 220)(attacker.name, shieldHp);
                  icon = '🔵'; type = 'buff';
                }

                if (target.hp <= 0) {
                  target.alive = false;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_ENEMY_DEFEAT, es + 219)(target.name, attacker.name);
                  icon = '💥'; type = 'defeat';
                  delete pressurePointDebuffs[target.id];
                  tryRaiseDead(target, es + 1997);
                }

                skillCooldowns[attacker.id][skillId] = SKILL_COOLDOWN;
                actionPerformed = true;
              } else {
                // Standard skill attack — honors the skill's own powerMultiplier
                // (+ atkBonus/magBonus) from effects when present. Falls back to
                // the historical 1.25× when a class skill declares no multiplier.
                // Equipment skills no longer reach this branch; they fire via the
                // end-of-round equipment proc lane and honor powerMultiplier there.
                const _skEff = skill && skill.effects ? skill.effects : {};
                const _skPower = _skEff.powerMultiplier || 1.25;
                const _skBonus = 1.0 + (_skEff.atkBonus || 0) + (_skEff.magBonus || 0);
                // Knight ST class-skill DEF blending: Shield Bash, Shield Charge,
                // Unbreakable scale partly off DEF so the whole kit does respectable
                // damage. Without this, Knight ST skills deal ~117-ATK-scaled damage.
                let _skRawBase = calcPartyDmg(attacker, es + 210, dmgBonus);
                const _skDefScale = CLASS_SKILL_DEF_SCALING[skillId];
                if (_skDefScale && attacker.def) {
                  const _skDefMult = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(es + 820) * COMBAT_TUNING.PARTY_DMG_SPREAD;
                  _skRawBase += Math.floor(attacker.def * _skDefScale * _skDefMult);
                }
                let baseDmg = Math.max(3, Math.floor(_skRawBase * _skPower * _skBonus));
                if (bloodlustActive[attacker.id]) {
                  baseDmg = Math.floor(baseDmg * 1.5);
                  delete bloodlustActive[attacker.id];
                }
                if (attacker.class === 'HERO' && secondWindRounds[attacker.id] > 0) {
                  baseDmg = Math.floor(baseDmg * 1.20);
                }
                if (spellEchoRounds[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.50);
            if (phaseShiftDmgBoost[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.25);
                if (cadenceRounds > 0) baseDmg = Math.floor(baseDmg * 1.15);
                if (swiftPalmRounds > 0) baseDmg = Math.floor(baseDmg * 1.25);

                const target = pickTarget(livingEnemies, es + 211);
                if (markedEnemies[target.id]) baseDmg = Math.floor(baseDmg * 1.20);
                if (executeMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
                target.hp = Math.max(0, target.hp - baseDmg);
                if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += baseDmg;

                // Prime skill text BEFORE any follow-up handlers that push-then-reassign.
                // Without this, talent follow-ups (Poison, Smite Burn) would push an empty
                // text string because the skill text hadn't been assigned yet.
                {
                  const isCelestial = skillId.startsWith('CEL_');
                  const isEquipProc = !isCelestial && skill.source === 'equipment';
                  if (isCelestial) {
                    text = sPick(T_CELESTIAL_SKILL, es + 212)(attacker.name, skill.name, target.name, baseDmg);
                    icon = skill.icon || '✦'; type = 'celestial';
                  } else if (isEquipProc) {
                    text = sPick(T_EQUIP_SKILL, es + 212)(attacker.name, skill.name, target.name, baseDmg);
                    icon = skill.icon || '•'; type = 'equip';
                  } else {
                    text = sPick(T_SKILL, es + 212)(attacker.name, skill.name, target.name, baseDmg);
                    icon = skill.icon || '•'; type = 'skill';
                  }
                }

                // Rogue Venomous Blades — Shadow Strike has a 30% chance to poison
                if (talentPoison && skillId === 'SHADOW_STRIKE' && target.alive !== false && target.hp > 0 && sRand(es + 215) < 0.30) {
                  const pDmg = Math.max(2, Math.floor(target.maxHp * 0.07));
                  poisonTargets[target.id] = { rounds: 3, dmgPerTick: pDmg, ownerId: attacker.id };
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `${attacker.name}'s venomous blade poisons ${target.name} — <span class="dmg-num dmg-phys">${pDmg}</span>/round for 3 rounds!`;
                  icon = '🧪'; type = 'debuff';
                }

                // CLR_SMITE_BURN "Righteous Burn" — Smite applies a burn DoT (40% MAG/r)
                if (talentSmiteBurn && skillId === 'SMITE' && target.hp > 0) {
                  const burnDmg = Math.max(2, Math.floor((attacker.mag || 10) * 0.40));
                  burnTargets[target.id] = { rounds: 3, dmgPerTick: burnDmg, source: 'CLR', ownerId: attacker.id };
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `${attacker.name}'s Smite ignites ${target.name} — sacred fire burns for <span class="dmg-num dmg-mag">${burnDmg}</span>/round!`;
                  icon = '☀'; type = 'debuff';
                }

                // MNK_FURY_PLUS "Infinite Fists" — Fists of Fury lands a bonus
                // strike that can independently crit. Hooked per §7.7 audit.
                if (talentInfiniteFists && skillId === 'FISTS_OF_FURY' && target.hp > 0) {
                  const bonusCrit = sRand(es + 217) < critChance(attacker);
                  const bonusDmg = Math.max(1, Math.floor(baseDmg * (bonusCrit ? COMBAT_TUNING.PARTY_BASE_CRIT_MULT * 0.5 : 0.5)));
                  target.hp = Math.max(0, target.hp - bonusDmg);
                  if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += bonusDmg;
                  const fatal = target.hp <= 0;
                  if (fatal) { target.alive = false; fallenEnemies.push(target.name); tryRaiseDead(target, es + 2057); }
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `${attacker.name}'s fists blur — <span class="sk-skill">Infinite Fists</span> lands a bonus ${bonusCrit ? 'CRIT ' : ''}strike on ${target.name} for <span class="dmg-num dmg-phys">${bonusDmg}</span>!`;
                  icon = '👊'; type = bonusCrit ? 'crit' : 'attack';
                  _logReactive('Infinite Fists', attacker.name, target.name, `bonus ${bonusCrit ? 'crit ' : ''}${bonusDmg}`);
                }

                // KNT_DEF_SHRED "Armor Rend" — Shield Charge shreds target DEF
                // for 2 rounds. Retargeted from Bulwark intercept per §7.7. The
                // shred is mechanically a +15% damage-taken debuff via defShredTargets.
                if (talentDefShred && skillId === 'SHIELD_CHARGE' && target.hp > 0) {
                  defShredTargets[target.id] = 2;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `${attacker.name}'s charge rends ${target.name}'s armor — +15% damage taken for 2 rounds!`;
                  icon = '🔨'; type = 'debuff';
                }

                // HRO_CHAIN_STRIKE — Heroic Strike chains to a 2nd target at 50%
                // damage (tightened hook, §7.7 audit).
                if (talentChainStrike && skillId === 'HEROIC_STRIKE' && livingEnemies.length > 1) {
                  const chainTarget = livingEnemies.find(e => e.id !== target.id && e.alive !== false) || null;
                  if (chainTarget) {
                    const chainDmg = Math.max(1, Math.floor(baseDmg * 0.50));
                    chainTarget.hp = Math.max(0, chainTarget.hp - chainDmg);
                    if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += chainDmg;
                    if (chainTarget.hp <= 0) { chainTarget.alive = false; fallenEnemies.push(chainTarget.name); tryRaiseDead(chainTarget, es + 2080); }
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `${attacker.name}'s strike chains — ${chainTarget.name} takes <span class="dmg-num dmg-phys">${chainDmg}</span> damage!`;
                    icon = '⚔'; type = 'skill';
                  }
                }

                // (Skill text already primed above, before talent follow-up handlers.)

                // Monk Ki Barrier lifesteal on skill
                if (monksWithKiBarrier.has(attacker.id) && attacker.hp > 0) {
                  const kiRate2 = talentDeepKi ? 0.40 : 0.25;
                  const lifeSteal = Math.max(1, Math.floor(baseDmg * kiRate2));
                  const before = attacker.hp;
                  attacker.hp = Math.min(attacker.maxHp, attacker.hp + lifeSteal);
                  const actual = attacker.hp - before;
                  if (actual > 0) {
                    if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += actual;
                    if (combatStats[attacker.id]) combatStats[attacker.id].healingReceived += actual;
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = sPick(T_KI_BARRIER, es + 213)(attacker.name, actual);
                    icon = '🔮'; type = 'heal';
                  }
                }
  
                // Arcane Aftershock — reactive, not cast-primed. See post-actor
                // kill-hook below (§3.3 Mage rework).
  
                // Smoke Bomb — +30% dodge for 2 rounds
                if (skillId === 'SMOKE_BOMB') smokeBombRounds = 2;
                // Smoke Bomb heal (talent) — skip KO'd members; smoke cannot revive.
                if (talentSmokeHeal && skillId === 'SMOKE_BOMB') {
                  let smokeHealTotal = 0;
                  for (const p of livingParty) {
                    if (p.hp <= 0) continue;
                    const smokHeal = Math.max(1, Math.floor(p.maxHp * 0.08));
                    const bef = p.hp;
                    p.hp = Math.min(p.maxHp, p.hp + smokHeal);
                    const act = p.hp - bef;
                    if (act > 0) {
                      smokeHealTotal += act;
                      if (combatStats[p.id]) combatStats[p.id].healingReceived += act;
                    }
                  }
                  if (smokeHealTotal > 0) {
                    if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += smokeHealTotal;
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `Healing smoke mends the party — <span class="dmg-num dmg-heal">+${smokeHealTotal}</span> HP restored!`;
                    icon = '💚'; type = 'heal';
                  }
                }
  
                if (target.hp <= 0) {
                  target.alive = false;
                  tryRaiseDead(target, es + 2129);
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_ENEMY_DEFEAT, es + 215)(target.name, attacker.name);
                  icon = '💥'; type = 'defeat';
                  // Hunter's Mark — Ranger killing blow via skill primes next arrow
                  if (attacker.class === 'RANGER' && rangersWithHuntersMark.has(attacker.id)
                      && (huntersMarkCooldowns[attacker.id] || 0) === 0) {
                    huntersMarkCharges[attacker.id] = 1;
                    huntersMarkCooldowns[attacker.id] = 3;
                  }
                }

                skillCooldowns[attacker.id][skillId] = SKILL_COOLDOWN;
                actionPerformed = true;
              }
            } else {
              // Proc failed — fallback to basic attack
              if (_combatDebug.atb.laneActions[attacker.id]) {
                _combatDebug.atb.laneActions[attacker.id].attack.fires++;
                _combatDebug.atb.laneActions[attacker.id].attack.basicFallbacks++;
              }
              const target = pickTarget(livingEnemies, es + 250);
              let baseDmg = calcPartyDmg(attacker, es + 251, dmgBonus);
              if (wrathBuff[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.30);
              if (spellEchoRounds[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.50);
            if (phaseShiftDmgBoost[attacker.id] > 0) baseDmg = Math.floor(baseDmg * 1.25);
              if (markedEnemies[target.id]) baseDmg = Math.floor(baseDmg * 1.20);
              if (executeMarkRounds[target.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
              const cadenceCritBonus2 = cadenceRounds > 0 ? 0.10 : 0;
              const isCrit = sRand(es + 252) < (critChance(attacker) + graveHungerCritBonus + cadenceCritBonus2);
              if (cadenceRounds > 0) baseDmg = Math.floor(baseDmg * 1.15);
              if (swiftPalmRounds > 0) baseDmg = Math.floor(baseDmg * 1.25);
              const dmg = isCrit ? Math.floor(baseDmg * COMBAT_TUNING.PARTY_BASE_CRIT_MULT) : baseDmg;
              target.hp = Math.max(0, target.hp - dmg);
              if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += dmg;
              if (target.hp <= 0) {
                target.alive = false;
                tryRaiseDead(target, es + 2164);
                text = sPick(T_ENEMY_DEFEAT, es + 253)(target.name, attacker.name);
                icon = '💥'; type = 'defeat';
              } else {
                const classId = attacker.class || 'HERO';
                text = getAttackTemplate(classId, es + 254)(attacker.name, target.name, isCrit ? `${dmg} CRIT` : dmg);
                icon = isCrit ? '💥' : (isMagicClass(classId) ? '✨' : '⚔');
                type = isCrit ? 'crit' : 'attack';
              }

              // Bard Crescendo reactive — also fires from the proc-fail fallback
              // basic-attack path. Previously this was only wired to the no-skill
              // basic attack at line 1438, so in S++ parties where everyone has
              // skills but occasionally fails the proc roll, ally crits here were
              // invisible to Crescendo. (§3.10 reactive stack / playtest fix.)
              if (isCrit && !crescendoActive && bardsWithCrescendo.size > 0) {
                for (const bardId of bardsWithCrescendo) {
                  if ((crescendoCooldowns[bardId] || 0) !== 0) continue;
                  const bard = partyHp.find(p => p.id === bardId && p.hp > 0);
                  if (!bard) continue;
                  crescendoActive = true;
                  crescendoSourceId = bardId;
                  crescendoCooldowns[bardId] = 3;
                  if (talentCrescendoAlly) crescendoAllyCharges.count = 2;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_CRESCENDO, es + 258)(bard.name);
                  icon = '🎶'; type = 'buff';
                  _logReactive('Crescendo', bard.name, attacker.name, 'next-attack 2.5× crit buff');
                  if (talentCrescendoAlly) {
                    events.push({ text, type, icon, phase: 'battle' });
                    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                    text = `The Crescendo echoes — next 2 ally attacks will crit!`;
                    icon = '🎵'; type = 'buff';
                  }
                  break;
                }
              }

              actionPerformed = true;
            }
          }

          // Symphony Leech — 10% lifesteal on all damage this attacker dealt this turn
          if (symphonyLeechActive && combatStats[attacker.id] && attacker.hp > 0) {
            const turnDmg = combatStats[attacker.id].dmgDealt - _dmgBefore;
            if (turnDmg > 0) {
              const leechAmt = Math.max(1, Math.floor(turnDmg * 0.10));
              const before = attacker.hp;
              attacker.hp = Math.min(attacker.maxHp, attacker.hp + leechAmt);
              const actual = attacker.hp - before;
              if (actual > 0) {
                if (combatStats[attacker.id]) combatStats[attacker.id].healingReceived += actual;
                const bard = partyHp.find(p => p.class === 'BARD' && p.hp > 0);
                if (bard && combatStats[bard.id]) combatStats[bard.id].healingDone += actual;
                events.push({ text: `The symphony's melody drains life — ${attacker.name} recovers <span class="dmg-num dmg-heal">+${actual}</span> HP!`, type: 'heal', icon: '🎵', phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              }
            }
          }

          // Necro Passive Group Siphon — when a necromancer with a passive siphon
          // offhand (Skull Whisper etc.) deals damage, the whole party heals for
          // necGroupSiphonPct of each member's maxHP. Only triggers on the necro's
          // own attack turns, not on other party members' turns.
          if (necGroupSiphonPct > 0 && attacker.class === 'NECROMANCER' && combatStats[attacker.id] && attacker.hp > 0) {
            const turnDmg = combatStats[attacker.id].dmgDealt - _dmgBefore;
            if (turnDmg > 0) {
              let siphonCount = 0;
              let siphonTotal = 0;
              for (const ally of livingParty) {
                if (ally.hp <= 0) continue;
                const healAmt = Math.max(1, Math.floor(ally.maxHp * necGroupSiphonPct));
                const before = ally.hp;
                ally.hp = Math.min(ally.maxHp, ally.hp + healAmt);
                const actual = ally.hp - before;
                if (actual > 0) {
                  siphonCount++;
                  siphonTotal += actual;
                  if (combatStats[ally.id]) combatStats[ally.id].healingReceived += actual;
                  if (combatStats[attacker.id]) combatStats[attacker.id].healingDone += actual;
                }
              }
              if (siphonCount > 0) {
                const siphonText = sPick(T_GROUP_SIPHON, es + 835)(siphonCount, siphonTotal);
                events.push({ text: siphonText, type: 'heal', icon: '💬', phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              }
            }
          }

          atbGauges[attacker.id].attack = 0;
        } else {
          // Enemy attack
          const attacker = enemies.find(e => e.id === actor.enemyId);
          if (!attacker || livingParty.length === 0) continue;
  
          const livingMinions = necroMinions.filter(m => m.hp > 0);
          const livingConstructs = arcaneConstructs.filter(c => c.hp > 0);
          let target;
          let targetIsMinion = false;
          let targetIsConstruct = false;

          // Filter out phased Mages — they are untargetable
          const targetableParty = livingParty.filter(p => !(phaseShiftRounds[p.id] > 0));
          if (targetableParty.length === 0) {
            // All living members are phased — skip this enemy attack
            continue;
          }
          // Taunt targeting: taunted enemies MUST attack a Knight (if any
          // living Knight is targetable). Falls back to normal targeting
          // if no Knight is available (e.g. all Knights are phased/dead).
          if (tauntedEnemies[attacker.id] > 0) {
            const knights = targetableParty.filter(p => p.class === 'KNIGHT');
            target = knights.length > 0 ? sPick(knights, es + 302) : sPick(targetableParty, es + 302);
          } else {
            target = sPick(targetableParty, es + 302);
          }
          // Arcane Construct intercept — always blocks hits aimed at its Mage
          if (target && target.class === 'MAGE' && livingConstructs.length > 0) {
            const myConstruct = livingConstructs.find(c => c.ownerId === target.id);
            if (myConstruct) {
              target = myConstruct;
              targetIsConstruct = true;
            }
          }
          // Necro Thrall intercept — always blocks hits aimed at its Necromancer
          if (target && target.class === 'NECROMANCER' && livingMinions.length > 0) {
            const myMinion = livingMinions.find(m => m.ownerId === target.id);
            if (myMinion) {
              target = myMinion;
              targetIsMinion = true;
            }
          }

          if (targetIsMinion) {
            const discordAtkMult = (discordRounds > 0 ? (1.0 - 0.20 - discordAtkRedBonusTotal) : 1.0) * (frostbiteRounds > 0 ? 0.85 : 1.0);
            const rawDmg = Math.max(1, Math.floor(attacker.atk * discordAtkMult * (COMBAT_TUNING.ENEMY_DMG_MIN_MULT + sRand(es + 303) * COMBAT_TUNING.ENEMY_DMG_SPREAD)));
            const minionAfterDef = Math.max(1, Math.floor(rawDmg * (1 - target.def / (target.def + COMBAT_TUNING.DEF_SOFTCAP))));
            target.hp = Math.max(0, target.hp - minionAfterDef);
            const minionHpStatus = target.hp > 0 ? ` (${target.hp}/${target.maxHp} HP)` : '';
            text = `${attacker.name} slams into <span class="sk-buff">${target.name}</span> — <span class="dmg-num">${minionAfterDef}</span>!${minionHpStatus}`;
            icon = '💀'; type = 'enemy';
  
            if (necroticReflectMag > 0) {
              const reflectDmg = Math.max(1, Math.floor(necroticReflectMag * 0.35));
              attacker.hp = Math.max(0, attacker.hp - reflectDmg);
              if (target.ownerId && combatStats[target.ownerId]) {
                combatStats[target.ownerId].dmgDealt += reflectDmg;
                combatStats[target.ownerId].dmgReflected += reflectDmg;
              }
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_NECROTIC_REFLECT, es + 305)(reflectDmg, attacker.name);
              icon = '💜'; type = 'debuff';
              if (attacker.hp <= 0) {
                attacker.alive = false;
                fallenEnemies.push(attacker.name);
                tryRaiseDead(attacker, es + 2239);
              }
            }

            if (target.hp <= 0) {
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_MINION_DEATH, es + 306)(target.name);
              icon = '🧟'; type = 'defeat';
              necroMinions.splice(necroMinions.indexOf(target), 1);
            }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            atbGauges[attacker.id].attack = 0;
            continue;
          }

          // Arcane Construct intercept — takes the hit instead of the Mage
          if (targetIsConstruct) {
            const discordAtkMult = (discordRounds > 0 ? (1.0 - 0.20 - discordAtkRedBonusTotal) : 1.0) * (frostbiteRounds > 0 ? 0.85 : 1.0);
            const rawDmg = Math.max(1, Math.floor(attacker.atk * discordAtkMult * (COMBAT_TUNING.ENEMY_DMG_MIN_MULT + sRand(es + 309) * COMBAT_TUNING.ENEMY_DMG_SPREAD)));
            const cAfterDef = Math.max(1, Math.floor(rawDmg * (1 - target.def / (target.def + COMBAT_TUNING.DEF_SOFTCAP))));
            target.hp = Math.max(0, target.hp - cAfterDef);
            const constructHpStatus = target.hp > 0 ? ` (${target.hp}/${target.maxHp} HP)` : '';
            text = `${attacker.name} strikes <span class="sk-magic">${target.name}</span> for <span class="dmg-num">${cAfterDef}</span> damage!${constructHpStatus}`;
            icon = '🔮'; type = 'enemy';

            // Arcane Reflection — construct reflects 20% of raw (pre-DEF) damage back to attacker
            if (talentArcaneReflect && cAfterDef > 0 && attacker.alive) {
              const reflDmg = Math.max(1, Math.floor(rawDmg * 0.20));
              attacker.hp = Math.max(0, attacker.hp - reflDmg);
              if (combatStats[target.ownerId]) combatStats[target.ownerId].dmgReflected = (combatStats[target.ownerId].dmgReflected || 0) + reflDmg;
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = `Arcane wards flare from the Construct — <span class="sk-magic">Arcane Reflection</span> lashes ${attacker.name} for <span class="dmg-num dmg-mag">${reflDmg}</span>!`;
              icon = '💜'; type = 'magic';
              if (attacker.hp <= 0) { attacker.alive = false; fallenEnemies.push(attacker.name); tryRaiseDead(attacker, es + 2714); }
            }

            if (target.hp <= 0) {
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_CONSTRUCT_DEATH, es + 311)();
              icon = '🔮'; type = 'defeat';
              // Start respawn cooldown
              constructCooldowns[target.ownerId] = 2;
              arcaneConstructs.splice(arcaneConstructs.indexOf(target), 1);
            }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            atbGauges[attacker.id].attack = 0;
            continue;
          }

          // Discord fumble (base 25% + drum aura bonus)
          if (discordRounds > 0 && sRand(es + 310) < (0.25 + discordFumbleBonusTotal)) {
            text = `${attacker.name} staggers from the Discord — the attack goes wide!`;
            icon = '🎸'; type = 'dodge';
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            atbGauges[attacker.id].attack = 0;
            continue;
          }

          // Frostbite fumble (Mage) — numb fingers, missed swing
          if (frostbiteRounds > 0 && sRand(es + 314) < 0.20) {
            text = `${attacker.name} shivers from the Frostbite — the attack fails to land!`;
            icon = '❄'; type = 'dodge';
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            atbGauges[attacker.id].attack = 0;
            continue;
          }
  
          // Dodge check — Iron Stance adds +15% dodge to monks in stance.
          // INLINED BY DESIGN — 0.15 dodge is Iron Stance's class-signature number
          // and belongs to the MNK_COUNTER_ATK talent, not to COMBAT_TUNING.
          // The 0.40 camouflage dodge bonus is similarly Rogue/Ranger class-specific.
          const ironStanceDodge = (target.class === 'MONK' && ironStanceBuffs[target.id] > 0) ? 0.15 : 0;
          const smokeDodge = smokeBombRounds > 0 ? 0.30 : 0;
          // Cosmic Reflection party-wide dodge bonus from Monk 2H Celestial staff
          const cosmicDodge = (deflectBuffs[target.id] && deflectBuffs[target.id].rounds > 0 && deflectBuffs[target.id].partyDodge) ? deflectBuffs[target.id].partyDodge : 0;
          const totalDodge = dodgeChance(target) + (camoRounds[target.id] > 0 ? 0.40 : 0) + ironStanceDodge + smokeDodge + cosmicDodge;
          if (sRand(es + 311) < totalDodge) {
            const dodgeReason = smokeBombRounds > 0 ? 'vanishes in smoke' : camoRounds[target.id] > 0 ? 'is camouflaged' : 'deftly sidesteps';
            text = `${target.name} ${dodgeReason} — the attack misses!`;
            icon = camoRounds[target.id] > 0 ? '🍃' : '💨';
            type = 'dodge';
            const estRaw = Math.max(1, Math.floor(attacker.atk * (discordRounds > 0 ? (1.0 - 0.20 - discordAtkRedBonusTotal) : 1.0) * 0.85));
            const estDodged = applyDef(estRaw, target);
            if (combatStats[target.id]) combatStats[target.id].dmgDodged += estDodged;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));

            // Flowing Strike — Monks counter on dodge (3-round cooldown, 1.5× ATK).
            // INLINED BY DESIGN — the 1.5× counter multiplier and 3-round cooldown
            // are Flowing Strike's class-signature numbers and are intentionally NOT
            // in COMBAT_TUNING. Change here if rebalancing the Monk counter window.
            if (target.class === 'MONK' && monksWithFlowingStrike.has(target.id)
                && flowingStrikeCooldowns[target.id] === 0 && target.hp > 0 && attacker.alive) {
              const fsDmg = Math.max(1, Math.floor((target.atk || 10) * 1.5));
              attacker.hp = Math.max(0, attacker.hp - fsDmg);
              if (combatStats[target.id]) combatStats[target.id].dmgDealt += fsDmg;
              flowingStrikeCooldowns[target.id] = 3;
              const fsText = sPick(T_FLOWING_STRIKE, es + 318)(target.name, attacker.name, fsDmg);
              events.push({ text: fsText, type: 'skill', icon: '☯', phase: 'battle' });
              // MNK_COUNTER_ATK → "Iron Stance": Flowing Strike also grants
              // +20% DEF / +15% dodge for 2 rounds to the Monk.
              if (talentRetaliating) {
                ironStanceBuffs[target.id] = 2;
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                const isText = sPick(T_IRON_STANCE, es + 319)(target.name);
                events.push({ text: isText, type: 'buff', icon: '🛡', phase: 'battle' });
              }
              if (attacker.hp <= 0) {
                attacker.alive = false;
                fallenEnemies.push(attacker.name);
                tryRaiseDead(attacker, es + 2313);
              }
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            }

            atbGauges[attacker.id].attack = 0;
            continue;
          }
  
          // Damage calculation
          const discordAtkMult = (discordRounds > 0 ? (1.0 - 0.20 - discordAtkRedBonusTotal) : 1.0) * (frostbiteRounds > 0 ? 0.85 : 1.0);
          // Pressure Point debuff — enemies with the debuff deal -20% damage (translated from "ATB fill" design)
          const pressurePointAtkMult = (pressurePointDebuffs[attacker.id] > 0) ? 0.80 : 1.0;
          // ROG_POISON "Venomous Blades" — when the talent is active, poisoned enemies
          // also deal -15% ATK for the duration of the poison. Piggybacks on the
          // existing poisonTargets tracker so expiry is automatic.
          const venomAtkMult = (talentPoison && poisonTargets[attacker.id] && poisonTargets[attacker.id].rounds > 0) ? 0.85 : 1.0;
          // Equipment poison ATK debuff (Rogue offhand DoTs)
          const equipPoisonMult = (equipPoisonTargets[attacker.id] && equipPoisonTargets[attacker.id].rounds > 0) ? (1.0 - equipPoisonTargets[attacker.id].atkDebuff) : 1.0;
          const rawDmg = Math.max(1, Math.floor(attacker.atk * discordAtkMult * pressurePointAtkMult * venomAtkMult * equipPoisonMult * (COMBAT_TUNING.ENEMY_DMG_MIN_MULT + sRand(es + 312) * COMBAT_TUNING.ENEMY_DMG_SPREAD)));
          const shieldReduction = divineShieldRounds > 0 ? 0.15 : 0;
          const consecrationReduction = consecrationRounds > 0 ? 0.10 : 0;
          // Iron Stance — Monks in stance gain +20% DEF (extra flat reduction before other mitigations).
          // INLINED BY DESIGN — 0.20 reduction is Iron Stance's class-signature number.
          const ironStanceRed = (target.class === 'MONK' && ironStanceBuffs[target.id] > 0) ? 0.20 : 0;
          // Knight Last Stand — +40% DEF while active (class-signature, INLINED BY DESIGN)
          const lastStandRed = (target.class === 'KNIGHT' && lastStandBuffRounds[target.id] > 0) ? 0.40 : 0;
          // Flowing Defense deflect check — Monk 2H staff deflect buffs.
          // Roll chance; if deflect fires, reduce damage AND queue reflect for Phase 5.
          let deflectFired = false;
          let deflectReflectDmg = 0;
          let deflectReduction = 0;
          const dBuf = deflectBuffs[target.id];
          if (dBuf && dBuf.rounds > 0 && sRand(es + 350) < dBuf.chance) {
            deflectFired = true;
            deflectReduction = dBuf.reduction;
            // Reflect is based on pre-mitigation rawDmg so it scales with enemy power
            deflectReflectDmg = Math.max(1, Math.floor(rawDmg * dBuf.reflect));
          }
          const afterDef = Math.max(1, Math.floor(applyDef(rawDmg, target) * (1 - ironStanceRed) * (1 - lastStandRed) * (1 - deflectReduction) * (1 - graveHungerDefBonus)));
          const baseDmg = Math.max(1, Math.floor(afterDef * (1 - dmgReduction) * (1 - shieldReduction) * (1 - consecrationReduction)));
          const isSkill = sRand(es + 313) < COMBAT_TUNING.ENEMY_SKILL_PROC_CHANCE;
  
          let actualDmg = isSkill ? Math.floor(baseDmg * COMBAT_TUNING.ENEMY_SKILL_DMG_MULT) : baseDmg;
          if (unbreakableDR[target.id] > 0) {
            actualDmg = Math.max(1, Math.floor(actualDmg * 0.20));
          }
  
          // Ki Shield absorb — Monk Ki Shield soaks damage before HP is touched
          if (target.class === 'MONK' && kiShieldHP[target.id] > 0 && actualDmg > 0) {
            const ksAbs = Math.min(actualDmg, kiShieldHP[target.id]);
            kiShieldHP[target.id] -= ksAbs;
            actualDmg = Math.max(0, actualDmg - ksAbs);
            if (combatStats[target.id]) combatStats[target.id].dmgAbsorbed += ksAbs;
            const ksText = sPick(T_KI_SHIELD_ABSORB, es + 319)(target.name, ksAbs);
            events.push({ text: ksText, type: 'buff', icon: '🔵', phase: 'battle' });
            if (kiShieldHP[target.id] <= 0) delete kiShieldHP[target.id];
          }

          if (combatStats[target.id]) combatStats[target.id].dmgMitigated += Math.max(0, rawDmg - actualDmg);
  
          if (isSkill) {
            const skillName = sPick(MONSTER_SKILLS, es + 314);
            target.hp = Math.max(0, target.hp - actualDmg);
            if (combatStats[target.id]) combatStats[target.id].dmgTaken += actualDmg;
            text = sPick(T_ENEMY_SKILL, es + 315)(attacker.name, skillName, target.name, actualDmg);
            icon = '🔥'; type = 'enemy';
          } else {
            target.hp = Math.max(0, target.hp - actualDmg);
            if (combatStats[target.id]) combatStats[target.id].dmgTaken += actualDmg;
            text = sPick(T_ENEMY_ATK, es + 315)(attacker.name, target.name, actualDmg);
            icon = '💀'; type = 'enemy';
          }

          // ═════════════════════════════════════════════════════════
          // §3.10 REACTIVE PRIORITY STACK — Phase 1 → 2 → 3 → 4 → 5
          // Damage was applied above (target.hp -= actualDmg + text set).
          // Phase 1/2 (Bulwark/Guardian's Grasp/Vanguard) use a refund
          // pattern: if they fire, target.hp is restored and actualDmg
          // is zeroed so downstream Phase 3/4/5 hooks correctly skip.
          // See reactive-priority-audit.md for the full catalog.
          // ═════════════════════════════════════════════════════════

          // ─── §3.10 PHASE 1 — INTERCEPT (damage redirect) ──────────
          // Knight Bulwark: redirects hit to a covering Knight at full dmg.
          // Fires FIRST so downstream Phase 5 counters correctly gate off
          // when the hit was redirected (they must see actualDmg === 0).
          let dmgTaken = actualDmg;
          const availableBulwark = livingParty.filter(p =>
            p.hp > 0 && p.id !== target.id && knightsWithCover.has(p.id) && coverCooldowns[p.id] === 0
          );
          const availableVanguard = livingParty.filter(p =>
            p.hp > 0 && p.id !== target.id && heroesWithVanguard.has(p.id) && vanguardCooldowns[p.id] === 0
          );

          if (availableBulwark.length > 0 && dmgTaken > 0) {
            const knight = sPick(availableBulwark, es + 320);
            const interceptedDmg = dmgTaken; // captured before zero-out for counter hooks
            if (combatStats[target.id]) combatStats[target.id].dmgTaken -= dmgTaken;
            target.hp = Math.min(target.hp + dmgTaken, target.maxHp);
            knight.hp = Math.max(0, knight.hp - dmgTaken);
            if (combatStats[knight.id]) {
              combatStats[knight.id].dmgTaken += dmgTaken;
              combatStats[knight.id].dmgAbsorbed += dmgTaken;
            }
            coverCooldowns[knight.id] = 3;
            // Bulwark consumed the hit — zero out so P3/P4/P5 skip.
            dmgTaken = 0;
            actualDmg = 0;

            // KNT_COUNTER "Stalwart Counter" — P5 effect nested in P1 per §3.10 note.
            if (talentKntCounter) {
              const counterDmg = Math.max(1, Math.floor(interceptedDmg * 0.50));
              const counterTarget = sPick(livingEnemies, es + 321);
              if (counterTarget) {
                counterTarget.hp = Math.max(0, counterTarget.hp - counterDmg);
                if (combatStats[knight.id]) combatStats[knight.id].dmgDealt += counterDmg;
                if (counterTarget.hp <= 0) { counterTarget.alive = false; fallenEnemies.push(counterTarget.name); tryRaiseDead(counterTarget, es + 2417); }
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = `${knight.name} answers the blow — <span class="sk-skill">Stalwart Counter</span> strikes ${counterTarget.name} for <span class="dmg-num dmg-phys">${counterDmg}</span>!`;
                icon = '⚔'; type = 'attack';
                _logReactive('Stalwart Counter', knight.name, counterTarget.name, `counter ${counterDmg} dmg`);
              }
            }

            // KNT_TAUNT_AURA secondary hook — Bulwark intercept marks attacker.
            if (talentTauntAura && attacker.alive) {
              tauntedEnemies[attacker.id] = 2;
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = `${knight.name}'s oppressive presence taunts ${attacker.name} — forced to attack the Knight for 2 rounds!`;
              icon = '😤'; type = 'debuff';
            }

            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = sPick(T_BULWARK, es + 323)(knight.name, target.name, interceptedDmg);
            icon = '🛡'; type = 'cover';
            _logReactive('Bulwark', knight.name, target.name, `absorbed ${interceptedDmg} dmg`);

            // Nested P3 — DI saves the covering Knight if Bulwark KOs them.
            if (knight.hp <= 0) {
              const diSaveKnight = livingParty.find(p =>
                p.hp > 0 && p.id !== knight.id && clericsWithIntervention.has(p.id) && interventionCooldowns[p.id] === 0
              );
              if (diSaveKnight) {
                knight.hp = 1;
                interventionCooldowns[diSaveKnight.id] = 4;
                if (combatStats[diSaveKnight.id]) combatStats[diSaveKnight.id].healingDone += 1;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_DIVINE_INTERVENTION, es + 324)(diSaveKnight.name, knight.name);
                _logReactive('Divine Intervention', diSaveKnight.name, knight.name, 'saved from KO');
                icon = '🕊'; type = 'divine';
              } else {
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_PARTY_KO, es + 325)(knight.name, attacker.name);
                icon = '💀'; type = 'ko';
              }
            }
          }

          // ─── Undead Guardian (NEC_NECRO_CLEAVE talent) — thrall intercept ──
          // Living thrall has 25% chance to body-block a hit aimed at any ally.
          // Thrall takes full damage; if it dies, the hit is still absorbed.
          if (actualDmg > 0 && talentNecroticCleave && necroMinions.length > 0) {
            const guardian = necroMinions.find(mn => mn.hp > 0);
            if (guardian && sRand(es + 328) < 0.25) {
              const interceptedDmg = dmgTaken;
              if (combatStats[target.id]) combatStats[target.id].dmgTaken -= dmgTaken;
              target.hp = Math.min(target.hp + dmgTaken, target.maxHp);
              guardian.hp = Math.max(0, guardian.hp - dmgTaken);
              dmgTaken = 0;
              actualDmg = 0;
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              if (guardian.hp <= 0) {
                text = `🧟 <span class="sk-buff">${guardian.name}</span> hurls itself in front of ${target.name}, absorbing <span class="dmg-num">${interceptedDmg}</span> damage — and crumbles to dust!`;
              } else {
                text = `🧟 <span class="sk-buff">${guardian.name}</span> hurls itself in front of ${target.name}, absorbing <span class="dmg-num">${interceptedDmg}</span> damage! (${guardian.hp}/${guardian.maxHp} HP)`;
              }
              icon = '🛡'; type = 'cover';
              _logReactive('Undead Guardian', guardian.name, target.name, `absorbed ${interceptedDmg} dmg`);
            }
          }

          // ─── §3.10 PHASE 2 — NEGATE (damage prevented, no redirect) ──
          // Guardian's Grasp (Cleric) — negates the hit entirely, no-cost.
          // Vanguard's Oath (Hero Vanguard spec) — partial intercept (40% DR).
          // Both gated on actualDmg > 0 so they skip when Phase 1 handled it.
          const availableGuardian = livingParty.filter(p =>
            p.hp > 0 && p.id !== target.id && clericsWithGuardianGrasp.has(p.id) && guardianGraspCooldowns[p.id] === 0
          );

          if (actualDmg > 0 && availableGuardian.length > 0) {
            const cleric = sPick(availableGuardian, es + 340);
            if (combatStats[target.id]) combatStats[target.id].dmgTaken -= actualDmg;
            target.hp = Math.min(target.hp + actualDmg, target.maxHp);
            guardianGraspCooldowns[cleric.id] = 3;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `${cleric.name} reaches out with <span class="sk-buff">Guardian's Grasp</span> — ${target.name} is pulled from harm's way!`;
            icon = '🤲'; type = 'divine';
            _logReactive("Guardian's Grasp", cleric.name, target.name, `negated ${actualDmg} dmg`);
            actualDmg = 0;
            dmgTaken = 0;
          } else if (actualDmg > 0 && availableVanguard.length > 0) {
            const hero = sPick(availableVanguard, es + 326);
            const reducedDmg = Math.max(1, Math.floor(actualDmg * 0.60));
            if (combatStats[target.id]) combatStats[target.id].dmgTaken -= actualDmg;
            target.hp = Math.min(target.hp + actualDmg, target.maxHp);
            hero.hp = Math.max(0, hero.hp - reducedDmg);
            if (combatStats[hero.id]) {
              combatStats[hero.id].dmgTaken += reducedDmg;
              combatStats[hero.id].dmgAbsorbed += reducedDmg;
              combatStats[hero.id].dmgMitigated += (actualDmg - reducedDmg);
            }
            vanguardCooldowns[hero.id] = 3;
            // Vanguard consumed the hit — zero out so P3/P4/P5 skip.
            dmgTaken = 0;
            actualDmg = 0;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = sPick(T_VANGUARD_OATH, es + 327)(hero.name, target.name, reducedDmg);
            icon = '🛡'; type = 'cover';

            // Nested P3 — Unbreakable / DI save if Vanguard hero KOs.
            if (hero.hp <= 0) {
              if (heroesWithUnbreakable.has(hero.id) && unbreakableCooldowns[hero.id] === 0) {
                hero.hp = 1;
                unbreakableCooldowns[hero.id] = 5;
                unbreakableDR[hero.id] = 2;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_UNBREAKABLE, es + 328)(hero.name);
                icon = '💎'; type = 'divine';
                _logReactive('Unbreakable', hero.name, '', 'survived lethal');
              } else {
                const diSave = livingParty.find(p =>
                  p.hp > 0 && p.id !== hero.id && clericsWithIntervention.has(p.id) && interventionCooldowns[p.id] === 0
                );
                if (diSave) {
                  hero.hp = 1;
                  interventionCooldowns[diSave.id] = 4;
                  if (combatStats[diSave.id]) combatStats[diSave.id].healingDone += 1;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_DIVINE_INTERVENTION, es + 329)(diSave.name, hero.name);
                  icon = '🕊'; type = 'divine';
                } else {
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = sPick(T_PARTY_KO, es + 330)(hero.name, attacker.name);
                  icon = '💀'; type = 'ko';
                }
              }
            }
          }

          // ─── §3.10 PHASE 3 — KO SAVES (prevent lethal damage) ─────
          // Undying Oath / Forgo Death / Unbreakable / Phase Shift / DI.
          // Only reached if Phase 1/2 didn't handle the hit (target still KO'd).
          if (target.hp <= 0 && talentUndying && !undyingUsed) {
            undyingUsed = true;
            target.hp = Math.max(1, Math.floor(target.maxHp * 0.15));
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `${target.name} is saved by the party's Undying Oath!`;
            icon = '🔄'; type = 'heal';
          } else if (target.hp <= 0) {
            if (necrosWithForgoDeath.has(target.id) && necroMinions.length > 0) {
              const sacrificed = necroMinions.pop();
              target.hp = Math.max(1, Math.floor(target.maxHp * 0.20));
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_FORGO_DEATH, es + 331)(sacrificed.name, target.name);
              icon = '💀'; type = 'divine';
              _logReactive('Forgo Death', target.name, sacrificed.name, 'minion sacrificed');
            } else if (heroesWithUnbreakable.has(target.id) && unbreakableCooldowns[target.id] === 0) {
              target.hp = 1;
              unbreakableCooldowns[target.id] = 5;
              unbreakableDR[target.id] = 2;
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_UNBREAKABLE, es + 332)(target.name);
              icon = '💎'; type = 'divine';
              _logReactive('Unbreakable', target.name, '', 'survived lethal');
            } else if (target.class === 'MAGE' && magesWithPhaseShift.has(target.id)
                && phaseShiftRounds[target.id] === 0 && phaseShiftCooldowns[target.id] === 0) {
              // Phase Shift cheat-death: Mage phases out of reality to
              // avoid a lethal blow. Survives at 1 HP, becomes untargetable
              // for 2 rounds, same 4-round cooldown as the normal trigger.
              target.hp = 1;
              phaseShiftRounds[target.id] = 2;
              phaseShiftCooldowns[target.id] = 4;
              if (talentArcaneReflect) {
                phaseShiftDmgBoost[target.id] = 'pending';
              }
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_PHASE_SHIFT, es + 345)(target.name);
              icon = '🌀'; type = 'magic';
              _logReactive('Phase Shift', target.name, '', `cheat-death → 1 HP, untargetable 2 rounds (CD 4)`);
            } else {
              const diSave = livingParty.find(p =>
                p.hp > 0 && p.id !== target.id && clericsWithIntervention.has(p.id) && interventionCooldowns[p.id] === 0
              );
              if (diSave) {
                target.hp = 1;
                interventionCooldowns[diSave.id] = 4;
                if (combatStats[diSave.id]) combatStats[diSave.id].healingDone += 1;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_DIVINE_INTERVENTION, es + 333)(diSave.name, target.name);
                icon = '🕊'; type = 'divine';
                _logReactive('Divine Intervention', diSave.name, target.name, 'saved from KO');
                if (talentWrath) {
                  wrathBuff[target.id] = 2;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `Righteous wrath fills ${target.name} — <span class="sk-buff">+30% damage</span> for 2 rounds!`;
                  icon = '⚡'; type = 'buff';
                }
              } else {
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_PARTY_KO, es + 334)(target.name, attacker.name);
                icon = '💀'; type = 'ko';
              }
            }
          }
  
          // Last Stand revival — search partyHp (full array), NOT livingParty
          // which is pre-filtered to hp > 0 and would never contain dead members.
          const koCount = partyHp.filter(p => p.hp <= 0).length;
          if (koCount >= 2) {
            const lastStandHero = partyHp.find(p =>
              p.hp > 0 && heroesWithLastStand.has(p.id) && !lastStandUsed[p.id]
            );
            if (lastStandHero) {
              lastStandUsed[lastStandHero.id] = true;
              const fallen = partyHp.filter(p => p.hp <= 0);
              fallen.forEach(p => {
                const reviveHp = Math.max(1, Math.floor(p.maxHp * 0.25));
                p.hp = reviveHp;
                if (combatStats[lastStandHero.id]) combatStats[lastStandHero.id].healingDone += reviveHp;
                if (combatStats[p.id]) combatStats[p.id].healingReceived += reviveHp;
              });
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = sPick(T_LAST_STAND, es + 335)(lastStandHero.name, fallen.length);
              icon = '🌅'; type = 'divine';
              _logReactive('Last Stand', lastStandHero.name, '', `revived ${fallen.length} allies`);
            }
          }
  
          // ─── §3.10 PHASE 4 — POST-DAMAGE SELF / PARTY EFFECTS ─────
          // Self-buffs, heals, and other non-counter responses that fire
          // when the hit actually landed. All gated on actualDmg > 0 so an
          // intercepted/negated hit doesn't falsely trigger thresholds.

          // Knight Last Stand — reactive self-buff when HP drops below 35%.
          // Moved here from pre-P1 position; gated on actualDmg > 0 so
          // Bulwark/Guardian's Grasp refunds don't leave a bogus buff active.
          if (actualDmg > 0 && target.class === 'KNIGHT' && knightsWithLastStand.has(target.id)
              && target.hp > 0 && target.hp < target.maxHp * 0.35
              && lastStandBuffRounds[target.id] === 0 && lastStandCooldowns[target.id] === 0) {
            lastStandBuffRounds[target.id] = 3;
            lastStandCooldowns[target.id] = 4;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = sPick(T_LAST_STAND_KNIGHT, es + 317)(target.name);
            icon = '⚒'; type = 'buff';
            _logReactive('Last Stand', target.name, '', 'self-buff (+40% DEF, +20% ATK, 3rd)');
          }

          // Rally Cry reactive heal
          const woundedAlly = livingParty.find(p => p.hp > 0 && p.hp < p.maxHp * 0.30);
          if (woundedAlly) {
            const availableHero = livingParty.find(p =>
              p.hp > 0 && heroesWithRally.has(p.id) && rallyCooldowns[p.id] === 0
            );
            if (availableHero) {
              const rallyHeal = Math.max(1, Math.floor(woundedAlly.maxHp * 0.15));
              const before = woundedAlly.hp;
              woundedAlly.hp = Math.min(woundedAlly.maxHp, woundedAlly.hp + rallyHeal);
              const actual = woundedAlly.hp - before;
              rallyCooldowns[availableHero.id] = 4;
  
              if (actual > 0) {
                if (combatStats[availableHero.id]) combatStats[availableHero.id].healingDone += actual;
                if (combatStats[woundedAlly.id]) combatStats[woundedAlly.id].healingReceived += actual;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_RALLY_CRY, es + 336)(availableHero.name, woundedAlly.name, actual);
                icon = '📣'; type = 'buff';
                if (talentRallyingHeal) {
                  for (const p of livingParty) {
                    if (p.hp > 0) sacredWarmthRounds[p.id] = 2;
                  }
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `Rally Cry's warmth lingers — party gains <span class="sk-buff">5% HP/round HoT</span> for 2 rounds!`;
                  icon = '🌸'; type = 'heal';
                }
              }
            }
          }
  
          // Hero Second Wind — self reactive when the Hero drops below 35% HP (L14 baseline)
          if (heroesWithSecondWind.size > 0) {
            for (const heroId of heroesWithSecondWind) {
              if ((secondWindCooldowns[heroId] || 0) > 0) continue;
              if ((secondWindRounds[heroId] || 0) > 0) continue;
              const hero = partyHp.find(p => p.id === heroId && p.hp > 0);
              if (!hero) continue;
              if (hero.hp >= hero.maxHp * 0.35) continue;
              secondWindRounds[heroId] = 2;
              secondWindCooldowns[heroId] = 4;
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = `${hero.name} catches a <span class="sk-react">Second Wind</span> — +20% ATK for 2 rounds!`;
              icon = '💨'; type = 'buff';
              _logReactive('Second Wind', hero.name, '', '+20% ATK / 2rd');
            }
          }

          // Guardian Spirit reactive heal
          const criticalAlly = livingParty.find(p => p.hp > 0 && p.hp < p.maxHp * 0.25);
          if (criticalAlly) {
            const guardian = livingParty.find(p =>
              p.hp > 0 && heroesWithGuardian.has(p.id) && guardianCooldowns[p.id] === 0
            );
            if (guardian) {
              const healAmt = Math.max(1, Math.floor(criticalAlly.maxHp * 0.30));
              const before = criticalAlly.hp;
              criticalAlly.hp = Math.min(criticalAlly.maxHp, criticalAlly.hp + healAmt);
              const actual = criticalAlly.hp - before;
              guardianCooldowns[guardian.id] = 3;
  
              if (actual > 0) {
                if (combatStats[guardian.id]) combatStats[guardian.id].healingDone += actual;
                if (combatStats[criticalAlly.id]) combatStats[criticalAlly.id].healingReceived += actual;
                events.push({ text, type, icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = sPick(T_GUARDIAN_SPIRIT, es + 337)(guardian.name, criticalAlly.name, actual);
                icon = '💚'; type = 'heal';
              }
            }
          }

          // ─── §3.10 PHASE 5 — POST-DAMAGE COUNTERS ────────────────
          // Reflects and ripostes that fire only if the hit actually landed.
          // All gated on actualDmg > 0 (or dmgTaken > 0) so intercepted hits
          // correctly skip the counter — fixes the pre-refactor bug where
          // Arcane Reflection could fire on damage refunded by Guardian's Grasp.

          // MAG_ARCANE_REFLECT "Arcane Reflection" — Mages reflect 20% of damage
          // taken back at the attacker. Scales on post-mitigation actualDmg.
          if (talentArcaneReflect && target.class === 'MAGE' && actualDmg > 0 && attacker.alive) {
            const reflDmg = Math.max(1, Math.floor(actualDmg * 0.20));
            attacker.hp = Math.max(0, attacker.hp - reflDmg);
            if (combatStats[target.id]) combatStats[target.id].dmgReflected = (combatStats[target.id].dmgReflected || 0) + reflDmg;
            const fatal = attacker.hp <= 0;
            if (fatal) { attacker.alive = false; fallenEnemies.push(attacker.name); tryRaiseDead(attacker, es + 2713); }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `Arcane wards flare around ${target.name} — <span class="sk-magic">Arcane Reflection</span> lashes ${attacker.name} for <span class="dmg-num dmg-mag">${reflDmg}</span>!`;
            icon = '💜'; type = 'magic';
            _logReactive('Arcane Reflection', target.name, attacker.name, `reflected ${reflDmg} dmg`);
          }

          // Necrotic Reflect — party-wide passive from Necromancer mastery.
          // Gated on actualDmg > 0 so negated hits don't fire the reflect.
          if (actualDmg > 0 && necroticReflectMag > 0 && attacker.alive) {
            const reflectDmg = Math.max(1, Math.floor(necroticReflectMag * 0.35));
            attacker.hp = Math.max(0, attacker.hp - reflectDmg);
            if (combatStats[target.id]) {
              combatStats[target.id].dmgDealt += reflectDmg;
              combatStats[target.id].dmgReflected += reflectDmg;
            }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = sPick(T_NECROTIC_REFLECT, es + 316)(reflectDmg, attacker.name);
            icon = '💜'; type = 'debuff';
            if (attacker.hp <= 0) {
              attacker.alive = false;
              fallenEnemies.push(attacker.name);
              tryRaiseDead(attacker, es + 2735);
            }
          }

          // Flowing Defense reflect — Monk 2H deflect. Fires when deflectFired
          // was set in the pre-damage check. Deals reflect damage, applies ATK
          // debuff, and grants Ki Shield (T5+).
          if (deflectFired && attacker.alive && deflectReflectDmg > 0) {
            attacker.hp = Math.max(0, attacker.hp - deflectReflectDmg);
            if (combatStats[target.id]) {
              combatStats[target.id].dmgDealt += deflectReflectDmg;
              combatStats[target.id].dmgReflected = (combatStats[target.id].dmgReflected || 0) + deflectReflectDmg;
            }
            const fatal = attacker.hp <= 0;
            if (fatal) { attacker.alive = false; fallenEnemies.push(attacker.name); tryRaiseDead(attacker, es + 2750); }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `${target.name} deflects with the staff — <span class="sk-react">Flowing Defense</span> reflects <span class="dmg-num dmg-phys">${deflectReflectDmg}</span> back at ${attacker.name}!`;
            icon = '🪨'; type = 'skill';
            _logReactive('Flowing Defense', target.name, attacker.name, `reflected ${deflectReflectDmg} dmg`);
            // ATK debuff from deflect (T4+)
            if (dBuf.atkDebuff > 0 && attacker.alive) {
              // Piggyback on equipPoisonTargets for ATK debuff — 1-round duration
              if (!equipPoisonTargets[attacker.id] || equipPoisonTargets[attacker.id].rounds <= 0) {
                equipPoisonTargets[attacker.id] = { rounds: 1, dmgPerTick: 0, ownerId: dBuf.ownerId, atkDebuff: dBuf.atkDebuff };
              }
            }
            // Ki Shield from deflect (T5 Monkey King's Reflection)
            if (dBuf.kiShieldPct > 0 && target.hp > 0) {
              const shieldAmt = Math.max(1, Math.floor(target.maxHp * dBuf.kiShieldPct));
              kiShieldHP[target.id] = Math.max(kiShieldHP[target.id] || 0, shieldAmt);
              events.push({ text, type, icon, phase: 'battle' });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              text = `Ki hardens around ${target.name} — <span class="sk-buff">+${shieldAmt} Ki Shield</span> from the deflection!`;
              icon = '🔵'; type = 'buff';
            }
          }

          // Dark Pact siphon — Necromancer buff converts party hits into
          // life drain. Gated on actualDmg > 0 so negated hits don't siphon.
          if (actualDmg > 0 && darkPactRounds > 0 && darkPactSource && target.hp > 0 && attacker.alive) {
            const siphonMag = darkPactSource.mag || 10;
            const siphonDmg = Math.max(1, Math.floor(siphonMag * 0.60));
            const siphonHeal = Math.max(1, Math.floor(siphonDmg * 0.80));
            attacker.hp = Math.max(0, attacker.hp - siphonDmg);
            if (combatStats[target.id]) combatStats[target.id].dmgDealt += siphonDmg;
            const bef = target.hp;
            target.hp = Math.min(target.maxHp, target.hp + siphonHeal);
            const actHeal = target.hp - bef;
            if (actHeal > 0 && combatStats[target.id]) combatStats[target.id].healingReceived += actHeal;
            if (combatStats[darkPactSource.id]) combatStats[darkPactSource.id].healingDone += actHeal;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `Dark energy lashes back at ${attacker.name} — <span class="dmg-num dmg-mag">${siphonDmg}</span> drained, <span class="dmg-num dmg-heal">+${actHeal}</span> to ${target.name}!`;
            icon = '🩸'; type = 'magic';
            if (attacker.hp <= 0) {
              attacker.alive = false;
              fallenEnemies.push(attacker.name);
              tryRaiseDead(attacker, es + 2759);
            }
          }

          // Rogue Riposte — counter-strike when the Rogue took actual damage
          // and is still alive. 2-round cooldown (exception to default 3r —
          // Rogue identity is fast counters). Uses dmgTaken which equals
          // actualDmg in the non-intercepted path.
          if (dmgTaken > 0 && target.class === 'ROGUE' && target.hp > 0
              && roguesWithRiposte.has(target.id) && riposteCooldowns[target.id] === 0
              && attacker.alive) {
            const riposteDmg = Math.max(1, Math.floor((target.atk || 10) * 1.3));
            const riposteCrit = sRand(es + 341) < (critChance(target) + 0.15);
            const finalDmg = riposteCrit ? Math.floor(riposteDmg * COMBAT_TUNING.PARTY_BASE_CRIT_MULT) : riposteDmg;
            attacker.hp = Math.max(0, attacker.hp - finalDmg);
            if (combatStats[target.id]) combatStats[target.id].dmgDealt += finalDmg;
            riposteCooldowns[target.id] = 2;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = `${target.name} snaps back with a lightning <span class="sk-react">Riposte</span> — ${attacker.name} takes <span class="dmg-num">${finalDmg}</span>${riposteCrit ? ' CRIT' : ''}!`;
            icon = '⚔'; type = riposteCrit ? 'crit' : 'skill';
            _logReactive('Riposte', target.name, attacker.name, `counter ${finalDmg}${riposteCrit ? ' crit' : ''}`);
            if (attacker.hp <= 0) {
              attacker.alive = false;
              fallenEnemies.push(attacker.name);
              tryRaiseDead(attacker, es + 2783);
            }
          }

          // Mage Phase Shift — reactive untargetable when Mage drops below 40% HP
          if (dmgTaken > 0 && target.hp > 0 && target.class === 'MAGE'
              && magesWithPhaseShift.has(target.id)
              && phaseShiftRounds[target.id] === 0
              && phaseShiftCooldowns[target.id] === 0
              && target.hp < target.maxHp * 0.40) {
            phaseShiftRounds[target.id] = 2;
            phaseShiftCooldowns[target.id] = 4;
            // Arcane Reflection talent: grant +25% dmg boost on return
            if (talentArcaneReflect) {
              phaseShiftDmgBoost[target.id] = 'pending';
            }
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            text = sPick(T_PHASE_SHIFT, es + 345)(target.name);
            icon = '🌀'; type = 'magic';
            _logReactive('Phase Shift', target.name, '', `untargetable 2 rounds (CD 4)`);
          }

          // Final flush — the enemy-attack reactive chain uses a push-then-reassign
          // pattern where each hook pushes the prior text and reassigns. Without a
          // terminal flush, the last reassigned text (whether the enemy attack itself
          // when no reactives fired, or the last reactive's message) would be orphaned.
          // This mirrors the minion-branch flush at ~line 2230.
          if (text) {
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          }

          atbGauges[attacker.id].attack = 0;
        }
  
      } else if (actor.lane === 'buff') {
        // ─────────────────────────────────────────────────────────────────────
        // BUFF LANE: Apply buff effects
        // ─────────────────────────────────────────────────────────────────────
  
        const buffMember = partyHp.find(p => p.id === actor.memberId);
        if (!buffMember || buffMember.hp <= 0) continue;
  
        const buffSkills = memberBuffSkills[buffMember.id];
        const readySkills = buffSkills.filter(sid => !skillCooldowns[buffMember.id][sid]);
        const _mtb = manualTurn(buffMember, 'buff', livingEnemies);
        if (_mtb && _mtb.pause) break roundLoop;
        const manualBuffPick = _mtb && !_mtb.skip ? _mtb : null;
        manualTargetId = manualBuffPick ? manualBuffPick.targetId : null;
        const skillPool = _mtb
          ? (manualBuffPick ? [manualBuffPick.skillId] : [])
          : (readySkills.length > 0 ? readySkills : buffSkills);

        if (skillPool.length > 0) {
          // Knight Taunt priority: if Taunt is available and no enemies are
          // currently taunted, always pick Taunt. Tanking is the Knight's
          // core identity — it shouldn't be left to a coin flip.
          let skillId;
          const hasTauntReady = skillPool.includes('TAUNT');
          const anyTaunted = hasTauntReady && Object.values(tauntedEnemies).some(r => r > 0);
          if (hasTauntReady && !anyTaunted && buffMember.class === 'KNIGHT') {
            skillId = 'TAUNT';
          } else {
            skillId = sPick(skillPool, es + 400);
          }
          const skill = getSkill(skillId);
          const buffProcRoll = sRand(es + 401);
          const buffProcThreshold = skill ? (skill.procChance || 0.60) : 0.60;
          if (_combatDebug.atb.laneActions[buffMember.id]) {
            _combatDebug.atb.laneActions[buffMember.id].buff.attempts++;
          }
          _combatDebug.atb.procRolls.push({
            round: roundCount, member: buffMember.name, lane: 'buff',
            skillId, skillName: skill?.name || skillId,
            procChance: buffProcThreshold, roll: Math.round(buffProcRoll * 1000) / 1000,
            fired: skill && buffProcRoll < buffProcThreshold,
          });

          if (skill && (manualBuffPick || buffProcRoll < buffProcThreshold)) {
            if (_combatDebug.atb.laneActions[buffMember.id]) {
              _combatDebug.atb.laneActions[buffMember.id].buff.fires++;
            }
            text = '';
            icon = '✨';
            type = 'buff';
  
            // Buff skill handlers
            if (skillId === 'RALLY_CRY') {
              rallyCooldowns[buffMember.id] = 4;
              dmgBonus = Math.floor(dmgBonus * 1.12);
              text = sPick(T_RALLY_CRY, es + 402)(buffMember.name, livingParty[0]?.name || 'allies', Math.floor(dmgBonus * 0.12));
              icon = '📣';
            } else if (skillId === 'SHIELD_WALL') {
              // Knight L8 mastery (lifted): party-wide -15% dmg for 3 rounds
              divineShieldRounds = 3;
              divineShieldSource = buffMember.name;
              text = `${buffMember.name} raises their <span class="sk-react">Shield Wall</span> — party takes -15% damage for 3 rounds!`;
              icon = '🛡';
            } else if (skillId === 'TAUNT') {
              // Knight L16 mastery (lifted): mark all enemies for 2 rounds, triggers KNT_TAUNT_AURA
              // talent for +10% dmg taken if learned.
              for (const e of livingEnemies) {
                if (e && e.alive) tauntedEnemies[e.id] = 2;
              }
              text = `${buffMember.name} bellows a furious <span class="sk-debuff">Taunt</span> — all enemies forced to target Knight for 2 rounds!`;
              icon = '😤';
            } else if (skillId === 'MAGNUM_OPUS') {
              // Bard L16 mastery (new): reuse Cadence machinery for party-wide dmg/crit amp.
              // Magnum Opus is a stronger, shorter-duration Cadence cousin — 2 rounds at +15% dmg
              // and +10% crit, plus a +15% party MAG flavor tick via partyMagBuff (handled
              // naturally by cadenceRounds being active since it gates dmg amp).
              cadenceRounds = Math.max(cadenceRounds, 2);
              cadenceSource = buffMember.name;
              skillCooldowns[buffMember.id][skillId] = 4;
              text = `${buffMember.name} pours their soul into a <span class="sk-skill">Magnum Opus</span> — +15% dmg, +10% crit, +15% MAG for 2 rounds!`;
              icon = '🎼';
            } else if (skillId === 'MARK_FOR_DEATH') {
              const target = pickTarget(livingEnemies, es + 403);
              markedEnemies[target.id] = 2;
              text = sPick(T_MARK_FOR_DEATH, es + 404)(buffMember.name, target.name);
              icon = '🎯';
            } else if (skillId === 'DISCORD') {
              discordRounds = talentDiscordDmg ? 4 : 3;
              discordSource = buffMember;
              discordCooldowns[buffMember.id] = 4;
              text = sPick(T_DISCORD, es + 405)(buffMember.name, discordRounds);
              icon = '🎸';
            } else if (skillId === 'CADENCE') {
              cadenceRounds = 3;
              cadenceSource = buffMember.name;
              cadenceCooldowns[buffMember.id] = 4;
              text = `${buffMember.name} sets a driving Cadence — the party's tempo quickens (+15% dmg, +10% crit for 3 rounds)!`;
              icon = '🎼'; type = 'buff';
            } else if (skillId === 'DARK_PACT') {
              darkPactRounds = 3;
              darkPactSource = buffMember;
              text = sPick(T_DARK_PACT, es + 407)(buffMember.name);
              icon = '🩸';
            } else if (skillId === 'BLIGHT') {
              blightRounds = 3;
              blightSource = buffMember;
              text = `${buffMember.name} unleashes a wave of <span class="sk-magic">Blight</span> — necrotic DoT on all enemies for 3 rounds!`;
              icon = '☠';
            } else if (skillId === 'ARMY_OF_THE_DAMNED') {
              const armyCount = Math.max(1, fallenEnemies.length);
              const armyBaseDmg = Math.max(2, Math.floor(buffMember.mag * 0.7));
              armyDmgPerTick = armyCount * Math.floor(armyBaseDmg * (1 + minionDmgBonusTotal) * 2.5);
              armyRounds = talentUndeadVanguard ? 4 : 3;
              armySource = buffMember;
              blightRounds = 3;
              blightSource = buffMember;
              text = sPick(T_ARMY_OF_DAMNED, es + 408)(buffMember.name, armyCount, armyRounds);
              icon = '👻';
            } else if (skillId === 'REGEN_SONG') {
              // Regen Song — persistent HoT, 100% proc, 4-round cooldown
              // between re-rolls. The song is always playing; re-casts only
              // re-roll potency (keeps the higher value). MAG-scaled at
              // ~55% of a Cleric group-heal per tick per member.
              const baseRoll = Math.max(1, Math.floor((buffMember.mag || 10) * (0.45 + sRand(es + 418) * 0.20) * (1 + regenAmpTotal)));
              const newRegen = Math.max(1, Math.floor(baseRoll * healBonus));
              const previous = regenPerTick;
              // regenNeverLower (celestial lute): re-rolls never reduce the regen value
              if (regenNeverLower ? (newRegen >= regenPerTick) : (newRegen > regenPerTick)) regenPerTick = newRegen;
              regenSource = buffMember.name;
              regenSourceId = buffMember.id;
              // 4-round cooldown before next re-roll attempt
              skillCooldowns[buffMember.id][skillId] = 4;
              if (previous === 0) {
                text = `${buffMember.name} begins a restorative Regen Song — the party's wounds slowly close (<span class="dmg-num dmg-heal">+${regenPerTick}</span> HP/rd)!`;
              } else if (regenPerTick > previous) {
                text = `${buffMember.name}'s Regen Song swells — the healing melody grows stronger (<span class="dmg-num dmg-heal">+${regenPerTick}</span> HP/rd)!`;
              } else {
                text = `${buffMember.name} reprises the Regen Song — the party's regen holds steady (<span class="dmg-num dmg-heal">+${regenPerTick}</span> HP/rd).`;
              }
              icon = '🎵'; type = 'heal';
            } else if (skillId === 'SPELL_ECHO') {
              spellEchoRounds[buffMember.id] = 2;
              text = sPick(T_SPELL_ECHO, es + 411)(buffMember.name);
              icon = '🌀';
            } else if (skillId === 'CAMOUFLAGE') {
              // Class guard — Camouflage is a Ranger-only buff. Without this
              // guard a phantom trigger could fire on non-Rangers if CAMOUFLAGE
              // ever landed in their buff pool (e.g. via legacy save data).
              if (buffMember.class !== 'RANGER') {
                skillCooldowns[buffMember.id][skillId] = SKILL_COOLDOWN;
                continue;
              }
              camoRounds[buffMember.id] = 2;
              if (talentSharedCamo) {
                const lowestAlly = livingParty.filter(p => p.hp > 0 && p.id !== buffMember.id).sort((a, b) => (a.hp / a.maxHp) - (b.hp / b.maxHp))[0];
                if (lowestAlly) camoRounds[lowestAlly.id] = 2;
              }
              text = sPick(T_CAMOUFLAGE, es + 412)(buffMember.name);
              icon = '🍃';
            } else if (skillId === 'DIVINE_SHIELD') {
              divineShieldRounds = 3;
              divineShieldSource = buffMember.name;
              text = sPick(T_DIVINE_SHIELD, es + 413)(buffMember.name);
              icon = '⛨';
              if (talentSacredWarmth) {
                for (const p of livingParty) { sacredWarmthRounds[p.id] = 3; }
                events.push({ text, type: 'buff', icon, phase: 'battle' });
                snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                text = `Sacred warmth radiates from the shield — party gains <span class="sk-buff">5% HP/round HoT</span> for 3 rounds!`;
                icon = '🌸'; type = 'heal';
              }
            } else if (skillId === 'KI_BARRIER') {
              text = sPick(T_KI_BARRIER, es + 414)(buffMember.name, Math.floor(buffMember.maxHp * 0.25));
              icon = '🔮';
            } else if (skillId === 'SMOKE_BOMB') {
              smokeBombRounds = 2;
              text = `${buffMember.name} deploys <span class="sk-buff">Smoke Bomb</span> — party gains +30% dodge for 2 rounds!`;
              icon = '💨';
              // Smoke Bomb heal (talent) — skip KO'd members; smoke cannot revive.
              if (talentSmokeHeal) {
                let smokeHealTotal = 0;
                const livingMembers = livingParty.filter(p => p.hp > 0);
                for (const p of livingMembers) {
                  const smokHeal = Math.max(1, Math.floor(p.maxHp * 0.08));
                  const bef = p.hp;
                  p.hp = Math.min(p.maxHp, p.hp + smokHeal);
                  const act = p.hp - bef;
                  if (act > 0) {
                    smokeHealTotal += act;
                    if (combatStats[p.id]) combatStats[p.id].healingReceived += act;
                  }
                }
                if (smokeHealTotal > 0) {
                  if (combatStats[buffMember.id]) combatStats[buffMember.id].healingDone += smokeHealTotal;
                  events.push({ text, type, icon, phase: 'battle' });
                  snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
                  text = `Healing smoke mends the party — <span class="dmg-num dmg-heal">+${smokeHealTotal}</span> HP restored!`;
                  icon = '💚'; type = 'heal';
                }
              }
            } else if (skillId === 'SWIFT_PALM') {
              swiftPalmRounds = 2;
              text = `${buffMember.name} channels <span class="sk-buff">Swift Palm</span> — party gains +25% ATK, +15% SPD for 2 rounds!`;
              icon = '👊';
            } else {
              text = sPick(T_SKILL, es + 415)(buffMember.name, skill.name, 'party', 'buff applied');
            }
  
            // Apply default cooldown only if handler didn't set a custom one
            if (!skillCooldowns[buffMember.id][skillId] || skillCooldowns[buffMember.id][skillId] < SKILL_COOLDOWN) {
              skillCooldowns[buffMember.id][skillId] = SKILL_COOLDOWN;
            }
            actionPerformed = true;
          } else {
            // Buff proc failed — gauge resets, no buff this round
            if (_combatDebug.atb.laneActions[buffMember.id]) {
              _combatDebug.atb.laneActions[buffMember.id].buff.procFails++;
            }
          }
        }

        atbGauges[buffMember.id].buff = 0;
  
      } else if (actor.lane === 'heal') {
        // ─────────────────────────────────────────────────────────────────────
        // HEAL LANE: Group heal
        // ─────────────────────────────────────────────────────────────────────
  
        const healer = partyHp.find(p => p.id === actor.memberId);
        if (!healer || healer.hp <= 0) continue;
        if (_combatDebug.atb.laneActions[healer.id]) _combatDebug.atb.laneActions[healer.id].heal.fires++;

        const magStat = healer.mag || 10;
        const baseHeal = Math.max(3, Math.floor(magStat * (COMBAT_TUNING.HEAL_MAG_MIN_MULT + sRand(es + 500) * COMBAT_TUNING.HEAL_MAG_SPREAD)));
        const healAmt = Math.floor(baseHeal * healBonus);
        const perMemberHeal = Math.floor(healAmt * 0.5);
  
        const healed = [];
        let groupHealActualTotal = 0;
        // Skip KO'd members — group heals must not resurrect the dead.
        // `livingParty` is filtered at round start, so a member who was alive
        // then but has since been KO'd is still in this array with hp===0.
        // Only Cleric Resurrection (below) is allowed to bring allies back.
        for (const p of livingParty) {
          if (p.hp <= 0) continue;
          const before = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + perMemberHeal);
          const actual = p.hp - before;
          if (actual > 0) {
            groupHealActualTotal += actual;
            if (combatStats[healer.id]) combatStats[healer.id].healingDone += actual;
            if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
            if (p.id !== healer.id) healed.push({ name: p.name, amt: actual });
          }
        }

        for (const m of necroMinions) {
          if (m.hp > 0 && m.hp < m.maxHp) {
            m.hp = Math.min(m.maxHp, m.hp + perMemberHeal);
          }
        }

        // Show actual total healed (not the raw healAmt which is 2× what each member gets)
        text = getHealTemplate(es + 501)(healer.name, groupHealActualTotal || healAmt);
        icon = '💚';
        type = 'heal';
        events.push({ text, type, icon, phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
  
        if (healed.length > 0) {
          const names = healed.map(h => `${h.name} (<span class="dmg-num dmg-heal">+${h.amt}</span>)`).join(', ');
          text = `${names} received healing from ${healer.name}.`;
          icon = '💚';
          type = 'heal';
        }
  
        // Divine Shield after healing — only log when it's a fresh activation.
        // If the shield is already active (from buff-lane proc or a prior heal),
        // silently refresh the counter to avoid duplicate log spam.
        if (clericsWithDivineShield.has(healer.id)) {
          const wasActive = divineShieldRounds > 0;
          divineShieldRounds = 3;
          divineShieldSource = healer.name;
          if (!wasActive) {
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            const shieldText = sPick(T_DIVINE_SHIELD, es + 502)(healer.name);
            events.push({ text: shieldText, type: 'buff', icon: '⛨', phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          }
          if (talentSacredWarmth) {
            for (const p of livingParty) { sacredWarmthRounds[p.id] = 3; }
            events.push({ text: `Sacred warmth radiates from the shield — party gains <span class="sk-buff">5% HP/round HoT</span> for 3 rounds!`, type: 'heal', icon: '🌸', phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          }
        }

        // Resurrection — search partyHp (full array), NOT livingParty
        // which is pre-filtered to hp > 0 and would never contain dead members.
        const deadParty = partyHp.filter(p => p.hp <= 0);
        if (deadParty.length > 0) {
          const availableRezzer = livingParty.find(p =>
            p.hp > 0 && clericsWithResurrection.has(p.id) && resurrectionCooldowns[p.id] === 0
          );
          if (availableRezzer) {
            const reviveTarget = sPick(deadParty, es + 503);
            const reviveHp = Math.max(1, Math.floor(reviveTarget.maxHp * 0.40 * healBonus));
            reviveTarget.hp = reviveHp;
            resurrectionCooldowns[availableRezzer.id] = 3;
            if (combatStats[availableRezzer.id]) combatStats[availableRezzer.id].healingDone += reviveHp;
            events.push({ text, type, icon, phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            const rezText = sPick(T_RESURRECTION, es + 504)(availableRezzer.name, reviveTarget.name);
            events.push({ text: rezText, type: 'divine', icon: '🌟', phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          }
        }
  
        // CLR_SMITE_BURN "Righteous Burn" — see Smite hit path for the burn
        // application. Heal lane no longer splashes.

        atbGauges[healer.id].heal = 0;
      }
  
      if (actionPerformed) {
        events.push({ text, type, icon, phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }

      // ── Arcane Aftershock reactive prime (§3.3 Mage rework) ──
      // If this party actor's action reduced the enemy living count, prime
      // every ready mage with Aftershock: 2 rounds of 1.5× spell damage,
      // 3-round ICD. Enemy-actor kills (minion deaths) never trigger this.
      if (actor.isParty && actionPerformed && magesWithSpellEcho.size > 0) {
        const _enemiesAlivePost = enemies.filter(e => e.alive).length;
        if (_enemiesAlivePost < _enemiesAlivePre) {
          for (const mageId of magesWithSpellEcho) {
            if ((aftershockCooldowns[mageId] || 0) > 0) continue;
            if ((spellEchoRounds[mageId] || 0) > 0) continue;
            const mage = partyHp.find(p => p.id === mageId && p.hp > 0);
            if (!mage) continue;
            spellEchoRounds[mageId] = 2;
            aftershockCooldowns[mageId] = 3;
            events.push({
              text: `${mage.name} resonates with an <span class="sk-magic">Arcane Aftershock</span> — next spells empowered for 2 rounds!`,
              type: 'buff', icon: '🌀', phase: 'battle',
            });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            _logReactive('Arcane Aftershock', mage.name, '', 'primed 2rd / 1.5× spell dmg');
          }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // END-OF-ROUND PHASE: DoT/HoT ticks, debuff countdown, reinforcements
    // ─────────────────────────────────────────────────────────────────────────
    const es = seed + (i + 10) * 7919; // round-level seed for end-of-round events

    roundCount++;

    // ATB round snapshot
    const _gaugeSnap = {};
    for (const m of livingParty) {
      _gaugeSnap[m.name] = {
        attack: Math.round(atbGauges[m.id].attack),
        buff: Math.round(atbGauges[m.id].buff),
        heal: Math.round(atbGauges[m.id].heal),
      };
    }
    _combatDebug.atb.gaugeSnapshots.push({ round: roundCount, gauges: _gaugeSnap });
    const _partyHpTotal = livingParty.reduce((s, p) => s + p.hp, 0);
    const _partyHpMax = livingParty.reduce((s, p) => s + p.maxHp, 0);
    const _enemyHpTotal = livingEnemies.reduce((s, e) => s + e.hp, 0);
    const _enemyHpMax = livingEnemies.reduce((s, e) => s + e.maxHp, 0);
    _combatDebug.atb.roundSummaries.push({
      round: roundCount,
      livingParty: livingParty.length, livingEnemies: livingEnemies.length,
      partyHpPct: _partyHpMax > 0 ? Math.round((_partyHpTotal / _partyHpMax) * 100) : 0,
      enemyHpPct: _enemyHpMax > 0 ? Math.round((_enemyHpTotal / _enemyHpMax) * 100) : 0,
    });

    // Bard regen tick — heals every round but only logs every 3rd round to reduce spam
    if (regenPerTick > 0) {
      let anyHealed = false;
      let totalRegenHealed = 0;
      for (const p of livingParty) {
        if (p.hp <= 0) continue; // skip members who died this round
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + regenPerTick);
        const actual = p.hp - before;
        if (actual > 0) {
          anyHealed = true;
          totalRegenHealed += actual;
          if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
        }
      }
      // Credit the bard who cast Regen Song with the tick healing.
      if (totalRegenHealed > 0 && regenSourceId && combatStats[regenSourceId]) {
        combatStats[regenSourceId].healingDone += totalRegenHealed;
      }
      if (anyHealed && roundCount % 3 === 0) {
        const regenEvent = sPick(T_REGEN_TICK, es + 600)(regenPerTick);
        events.push({ text: regenEvent, type: 'heal', icon: '🎵', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Cleric celestial persistent regen (Sanctified Radiance) — independent of Bard regen
    if (clericRegenPerTick > 0) {
      let anyClericHealed = false;
      let totalClericRegenHealed = 0;
      for (const p of livingParty) {
        if (p.hp <= 0) continue;
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + clericRegenPerTick);
        const actual = p.hp - before;
        if (actual > 0) {
          anyClericHealed = true;
          totalClericRegenHealed += actual;
          if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
        }
      }
      if (totalClericRegenHealed > 0 && clericRegenSourceId && combatStats[clericRegenSourceId]) {
        combatStats[clericRegenSourceId].healingDone += totalClericRegenHealed;
      }
      if (anyClericHealed && roundCount % 3 === 0) {
        events.push({ text: `Sanctified Radiance pulses — the party heals for <span class="dmg-num dmg-heal">+${clericRegenPerTick}</span> HP!`, type: 'heal', icon: '✨', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Necro minion attacks — each living minion deals dmgPerTick to enemy(ies)
    // With celestial scythe (minionAoe), thrall attacks ALL enemies instead of one.
    for (const minion of necroMinions) {
      if (minion.hp <= 0 || livingEnemies.length === 0) continue;
      const mDmg = Math.max(1, Math.floor(minion.dmgPerTick * (1 + minionDmgBonusTotal)));
      const mTargets = minionAoe ? livingEnemies : [sPick(livingEnemies, es + 550 + necroMinions.indexOf(minion))];
      let totalMinionDmg = 0;
      for (const target of mTargets) {
        target.hp = Math.max(0, target.hp - mDmg);
        totalMinionDmg += mDmg;
        if (target.hp <= 0) {
          target.alive = false;
          fallenEnemies.push(target.name);
          tryRaiseDead(target, es + 3160);
        }
      }
      if (minion.ownerId && combatStats[minion.ownerId]) combatStats[minion.ownerId].dmgDealt += totalMinionDmg;
      if (minionAoe && mTargets.length > 1) {
        const mText = `🧟 <span class="sk-magic">${minion.name}</span> sweeps through all enemies — <strong>${mDmg}</strong> damage each! (${mTargets.length} hit)`;
        events.push({ text: mText, type: 'magic', icon: '🧟', phase: 'battle' });
      } else {
        const mText = sPick(T_MINION_ATTACK, es + 551)(minion.name, mTargets[0].name, mDmg);
        events.push({ text: mText, type: 'magic', icon: '🧟', phase: 'battle' });
      }
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      for (const target of mTargets) {
        if (target.hp <= 0 && !target.alive) {
          const defeatText = sPick(T_ENEMY_DEFEAT, es + 552)(target.name, minion.name);
          events.push({ text: defeatText, type: 'defeat', icon: '💥', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }

    // Arcane Construct — single-target attack every round + Arcane Pulse AoE every 2 rounds
    for (const construct of arcaneConstructs) {
      if (construct.hp <= 0) continue;
      const mage = partyHp.find(p => p.id === construct.ownerId && p.hp > 0);
      if (!mage || livingEnemies.length === 0) continue;

      // Single-target attack every round (70% owner MAG — tuned down from 85%)
      const cTarget = sPick(livingEnemies, es + 555 + arcaneConstructs.indexOf(construct));
      const cDmg = Math.max(2, construct.dmgPerTick || Math.floor((mage.mag || 10) * 0.70));
      cTarget.hp = Math.max(0, cTarget.hp - cDmg);
      if (combatStats[mage.id]) combatStats[mage.id].dmgDealt += cDmg;
      events.push({ text: `${construct.name} hurls an arcane bolt at ${cTarget.name} — <span class="dmg-num dmg-mag">${cDmg}</span> damage!`, type: 'magic', icon: '🔮', phase: 'battle' });
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      if (cTarget.hp <= 0) {
        cTarget.alive = false;
        fallenEnemies.push(cTarget.name);
        tryRaiseDead(cTarget, es + 3162);
        events.push({ text: sPick(T_ENEMY_DEFEAT, es + 556)(cTarget.name, construct.name), type: 'defeat', icon: '💥', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }

      // Arcane Pulse AoE fires every 2 rounds (~30% of Blizzard output: 0.17 × calcPartyDmg)
      if (roundCount > 0 && roundCount % 2 === 0 && livingEnemies.length > 0) {
        const pulseDmg = Math.max(3, Math.floor(calcPartyDmg(mage, es + 558, dmgBonus) * 0.17));
        const pulseTargetCount = livingEnemies.length;
        let totalPulseDmg = 0;
        for (const e of livingEnemies) {
          e.hp = Math.max(0, e.hp - pulseDmg);
          totalPulseDmg += pulseDmg;
          if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3165); }
        }
        if (totalPulseDmg > 0) {
          if (combatStats[mage.id]) combatStats[mage.id].dmgDealt += totalPulseDmg;
          events.push({ text: sPick(T_CONSTRUCT_PULSE, es + 560)(pulseDmg, pulseTargetCount), type: 'magic', icon: '🔮', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }
    // Arcane Construct respawn — if destroyed and cooldown expired, re-summon
    for (const mage of livingParty.filter(p => p.class === 'MAGE' && magesWithConstruct.has(p.id))) {
      if (arcaneConstructs.some(c => c.ownerId === mage.id && c.hp > 0)) continue; // already alive
      if (constructCooldowns[mage.id] > 0) {
        constructCooldowns[mage.id]--;
        continue;
      }
      // Cooldown expired and no living construct — re-summon
      // Remove any dead construct entries first
      for (let ci = arcaneConstructs.length - 1; ci >= 0; ci--) {
        if (arcaneConstructs[ci].ownerId === mage.id) arcaneConstructs.splice(ci, 1);
      }
      const cHp = Math.max(50, Math.floor((mage.mag || 10) * 1.50));
      const cDef = Math.max(10, Math.floor((mage.mag || 10) * 1.50));
      const cDmg = Math.max(2, Math.floor((mage.mag || 10) * 0.85));
      arcaneConstructs.push({
        id: `construct_${mage.id}`,
        name: `${mage.name}'s Construct`,
        hp: cHp, maxHp: cHp,
        def: cDef,
        dmgPerTick: cDmg,
        ownerId: mage.id,
        mageRef: mage,
      });
      events.push({ text: sPick(T_CONSTRUCT_RESUMMON, es + 565)(mage.name), type: 'magic', icon: '🔮', phase: 'battle' });
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
    }

    // Undead Guardian — thrall intercept is handled reactively during enemy attacks
    // (see Phase 1 Intercept in the enemy attack path above). The old Necrotic
    // Cleave end-of-round AoE was replaced by this reactive mechanic.

    // Blight DoT — 40% MAG per enemy per tick, 3 rounds
    // As the Necromancer's signature L10 AoE DoT this needs to actually
    // compete with their direct-damage kit. Shadow Bolt scales at 130% MAG
    // single-target per cast; Blight at 40% × 3 ticks = 120% MAG per enemy
    // across its full duration, which beats Shadow Bolt on 2+ enemies
    // while still losing to it single-target. That's the correct shape
    // for an AoE DoT vs single-target burst.
    if (blightRounds > 0) {
      const blightTargets = livingEnemies;
      let totalBlightDmg = 0;
      for (const e of blightTargets) {
        const blightDmg = Math.max(3, Math.floor((blightSource.mag || 10) * 0.40 * (1 + blightAmpTotal)));
        e.hp = Math.max(0, e.hp - blightDmg);
        totalBlightDmg += blightDmg;
        if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3176); }
      }
      if (totalBlightDmg > 0) {
        const dotText = sPick(T_BLIGHT_DOT, es + 601)(Math.floor(totalBlightDmg / Math.max(1, blightTargets.length)), blightTargets.length);
        events.push({ text: dotText, type: 'debuff', icon: '☠', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
      blightRounds--;
    }
  
    // Army of the Damned tick
    if (armyRounds > 0 && armyDmgPerTick > 0) {
      const armyTargets = livingEnemies;
      let totalArmyDmg = 0;
      for (const e of armyTargets) {
        e.hp = Math.max(0, e.hp - armyDmgPerTick);
        totalArmyDmg += armyDmgPerTick;
        if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3193); }
      }
      if (totalArmyDmg > 0) {
        const armyText = sPick(T_ARMY_TICK, es + 602)(armyDmgPerTick, armyTargets.length);
        events.push({ text: armyText, type: 'magic', icon: '👻', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
      armyRounds--;
    }
  
    // Discord DoT — 32% MAG per enemy per tick
    // Discord still carries its ATK -20% + fumble utility, but the sonic
    // DoT now contributes meaningful damage too. At Bard MAG 100 that's
    // 32/tick per enemy, ~96/tick vs a 3-enemy group, so across its full
    // 3-round duration a Discord cast threatens ~300+ total AoE damage
    // in addition to the debuff pressure. Discord is on a 4-round CD so
    // it's essentially a maintenance stance — the DoT should matter.
    if (discordRounds > 0) {
      const discordTargets = livingEnemies;
      let totalDiscordDmg = 0;
      for (const e of discordTargets) {
        const discordDmg = Math.max(3, Math.floor((discordSource?.mag || 10) * 0.32 * (1 + discordDotAmpTotal)));
        e.hp = Math.max(0, e.hp - discordDmg);
        totalDiscordDmg += discordDmg;
        if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3211); }
      }
      if (totalDiscordDmg > 0) {
        const dotText = sPick(T_DISCORD_DOT, es + 603)(Math.floor(totalDiscordDmg / Math.max(1, discordTargets.length)), discordTargets.length);
        events.push({ text: dotText, type: 'debuff', icon: '🎸', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
      discordRounds--;
    }

    // Consecration duration tick — applies party HoT then decrements
    // HoT bumped 6% → 8% maxHp so the consecrated-ground tick is a
    // meaningful sustain layer over its 2-round duration (~16% total).
    if (consecrationRounds > 0) {
      let totalHealed = 0;
      for (const p of livingParty) {
        if (p.hp <= 0) continue;
        const healAmt = Math.max(2, Math.floor(p.maxHp * 0.08));
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + healAmt);
        const actual = p.hp - before;
        totalHealed += actual;
        if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
      }
      if (totalHealed > 0 && consecrationSource) {
        // credit the cleric that cast it
        const src = livingParty.find(p => p.name === consecrationSource);
        if (src && combatStats[src.id]) combatStats[src.id].healingDone += totalHealed;
        events.push({ text: `Consecrated ground restores the party — <span class="dmg-num dmg-heal">+${totalHealed}</span> HP!`, type: 'heal', icon: '🌅', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
      consecrationRounds--;
      if (consecrationRounds === 0) {
        events.push({ text: `The Consecration fades — the ground is no longer hallowed.`, type: 'buff', icon: '🌅', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Sacred Warmth HoT tick (CLR_SHIELD_HOT / HRO_RALLYING_HEAL talents)
    // Heals each living party member for 5% max HP per round while active.
    {
      let warmthTotal = 0;
      const warmthHealed = [];
      for (const p of livingParty) {
        if (p.hp <= 0 || !sacredWarmthRounds[p.id] || sacredWarmthRounds[p.id] <= 0) continue;
        const healAmt = Math.max(1, Math.floor(p.maxHp * 0.05));
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + healAmt);
        const actual = p.hp - before;
        if (actual > 0) {
          warmthTotal += actual;
          warmthHealed.push(`${p.name} (+${actual})`);
          if (combatStats[p.id]) combatStats[p.id].healingReceived += actual;
        }
      }
      if (warmthTotal > 0) {
        // Credit healing to the cleric if present
        const clr = livingParty.find(p => p.class === 'CLERIC' && p.hp > 0);
        if (clr && combatStats[clr.id]) combatStats[clr.id].healingDone += warmthTotal;
        events.push({ text: `Sacred warmth soothes the party — <span class="dmg-num dmg-heal">+${warmthTotal}</span> HP restored!`, type: 'heal', icon: '🌸', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Bard Cadence duration tick
    if (cadenceRounds > 0) {
      cadenceRounds--;
      if (cadenceRounds === 0) {
        events.push({ text: `The Cadence fades — the party's tempo returns to normal.`, type: 'buff', icon: '🎼', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Mage Frostbite duration tick
    if (frostbiteRounds > 0) {
      frostbiteRounds--;
      if (frostbiteRounds === 0) {
        events.push({ text: `The Frostbite thaws — enemies recover their footing.`, type: 'buff', icon: '❄', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Rogue Smoke Bomb duration tick — party-wide +30% dodge
    if (smokeBombRounds > 0) {
      smokeBombRounds--;
      if (smokeBombRounds === 0) {
        events.push({ text: `The smoke dissipates — the party is visible again.`, type: 'buff', icon: '💨', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Monk Swift Palm duration tick — party-wide +25% ATK, +15% SPD
    if (swiftPalmRounds > 0) {
      swiftPalmRounds--;
      if (swiftPalmRounds === 0) {
        events.push({ text: `The Swift Palm's energy fades — the party's tempo slows.`, type: 'buff', icon: '👊', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Cleric Divine Shield duration tick — party-wide -15% incoming damage
    if (divineShieldRounds > 0) {
      divineShieldRounds--;
      if (divineShieldRounds === 0) {
        events.push({ text: `The Divine Shield fades — the party's protection wanes.`, type: 'buff', icon: '⛨', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
      }
    }

    // Burn DoT tick (Cleric Righteous Burn + Mage Lingering Flames).
    // Bucket hits by source so the tick message uses source-appropriate
    // flavor — Meteor Storm burns are Mage-flavored, Smite/Righteous Burn
    // are Cleric-flavored. Prior to this split the tick hardcoded "Sacred
    // flame" regardless of source, which was thematically wrong for Mage
    // parties with no Cleric present.
    {
      const burnIds = Object.keys(burnTargets);
      if (burnIds.length > 0) {
        const bucket = { MAG: { dmg: 0, hits: 0 }, CLR: { dmg: 0, hits: 0 } };
        for (const eid of burnIds) {
          const e = enemies.find(en => en.id === eid);
          if (!e || !e.alive || e.hp <= 0) { delete burnTargets[eid]; continue; }
          const b = burnTargets[eid];
          const dmg = b.dmgPerTick;
          e.hp = Math.max(0, e.hp - dmg);
          if (b.ownerId && combatStats[b.ownerId]) combatStats[b.ownerId].dmgDealt += dmg;
          const src = (b.source === 'MAG') ? 'MAG' : 'CLR';
          bucket[src].dmg += dmg;
          bucket[src].hits++;
          if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3284); }
          b.rounds--;
          if (b.rounds <= 0) delete burnTargets[eid];
        }
        if (bucket.MAG.hits > 0) {
          const avg = Math.floor(bucket.MAG.dmg / bucket.MAG.hits);
          events.push({ text: `Lingering flames scorch <span class="dmg-num dmg-mag">${bucket.MAG.hits}</span> ${_f(bucket.MAG.hits)} for <span class="dmg-num dmg-mag">${avg}</span>${_ea(bucket.MAG.hits)}!`, type: 'debuff', icon: '☄', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
        if (bucket.CLR.hits > 0) {
          const avg = Math.floor(bucket.CLR.dmg / bucket.CLR.hits);
          events.push({ text: `Sacred flame sears <span class="dmg-num dmg-mag">${bucket.CLR.hits}</span> ${_f(bucket.CLR.hits)} for <span class="dmg-num dmg-mag">${avg}</span>${_ea(bucket.CLR.hits)}!`, type: 'debuff', icon: '🔥', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }

    // Rogue Poison DoT tick
    {
      const poisonIds = Object.keys(poisonTargets);
      if (poisonIds.length > 0) {
        let totalPoisonDmg = 0;
        let poisonHits = 0;
        for (const eid of poisonIds) {
          const e = enemies.find(en => en.id === eid);
          if (!e || !e.alive || e.hp <= 0) { delete poisonTargets[eid]; continue; }
          const p = poisonTargets[eid];
          const dmg = p.dmgPerTick;
          e.hp = Math.max(0, e.hp - dmg);
          totalPoisonDmg += dmg;
          poisonHits++;
          if (p.ownerId && combatStats[p.ownerId]) combatStats[p.ownerId].dmgDealt += dmg;
          if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3315); }
          p.rounds--;
          if (p.rounds <= 0) delete poisonTargets[eid];
        }
        if (poisonHits > 0) {
          const avg = Math.floor(totalPoisonDmg / poisonHits);
          events.push({ text: `Venom sears <span class="dmg-num dmg-phys">${poisonHits}</span> ${_f(poisonHits)} for <span class="dmg-num dmg-phys">${avg}</span>${_ea(poisonHits)}!`, type: 'debuff', icon: '🧪', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }

    // ── Rogue Equipment Poison DoT tick (Envenom / Deadly Toxin / Neurotoxin) ──
    {
      const epIds = Object.keys(equipPoisonTargets);
      if (epIds.length > 0) {
        let totalDmg = 0;
        let hits = 0;
        for (const eid of epIds) {
          const e = enemies.find(en => en.id === eid);
          if (!e || !e.alive || e.hp <= 0) { delete equipPoisonTargets[eid]; continue; }
          const p = equipPoisonTargets[eid];
          // Only deal damage & count as a poison hit if dmgPerTick > 0.
          // Entries with dmgPerTick 0 are pure ATK-debuff piggybacks (e.g. Monk deflect).
          if (p.dmgPerTick > 0) {
            e.hp = Math.max(0, e.hp - p.dmgPerTick);
            totalDmg += p.dmgPerTick;
            hits++;
            if (p.ownerId && combatStats[p.ownerId]) combatStats[p.ownerId].dmgDealt += p.dmgPerTick;
            if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3520); }
          }
          p.rounds--;
          if (p.rounds <= 0) delete equipPoisonTargets[eid];
        }
        if (hits > 0) {
          const avg = Math.floor(totalDmg / hits);
          events.push({ text: `Poison corrodes <span class="dmg-num dmg-phys">${hits}</span> ${_f(hits)} for <span class="dmg-num dmg-phys">${avg}</span>${_ea(hits)}!`, type: 'debuff', icon: '🐍', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }

    // ── Monk Chi Burn DoT tick (Spirit Scorch / Inner Fire / Chi Eruption) ──
    {
      const cbIds = Object.keys(chiBurnTargets);
      if (cbIds.length > 0) {
        let totalDmg = 0;
        let hits = 0;
        for (const eid of cbIds) {
          const e = enemies.find(en => en.id === eid);
          if (!e || !e.alive || e.hp <= 0) { delete chiBurnTargets[eid]; continue; }
          const cb = chiBurnTargets[eid];
          e.hp = Math.max(0, e.hp - cb.dmgPerTick);
          totalDmg += cb.dmgPerTick;
          hits++;
          if (cb.ownerId && combatStats[cb.ownerId]) combatStats[cb.ownerId].dmgDealt += cb.dmgPerTick;
          if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3530); }
          cb.rounds--;
          if (cb.rounds <= 0) delete chiBurnTargets[eid];
        }
        if (hits > 0) {
          const avg = Math.floor(totalDmg / hits);
          events.push({ text: `Chi flames burn <span class="dmg-num dmg-phys">${hits}</span> ${_f(hits)} for <span class="dmg-num dmg-phys">${avg}</span>${_ea(hits)}!`, type: 'debuff', icon: '🔥', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }
    }

    // ── Executioner's Mark reactive fire ────────────────────────────────
    // Champion-spec Hero trigger: when any enemy falls below 30% HP, a
    // Champion off cooldown marks them (+10% party dmg for 2 rounds) and
    // strikes for 2.0× ATK. 3-round CD. Only fires on enemies not already
    // marked (prevents re-firing on the same target round over round).
    if (heroesWithExecutioner.size > 0) {
      const execTarget = livingEnemies.find(e =>
        e.hp > 0 && e.hp < e.maxHp * 0.30 && !(executeMarkRounds[e.id] > 0)
      );
      if (execTarget) {
        const execHero = livingParty.find(p =>
          p.hp > 0 && heroesWithExecutioner.has(p.id) && executionerCooldowns[p.id] === 0
        );
        if (execHero) {
          // Apply mark debuff (+10% party dmg for 2 rounds).
          // Set to 3 so the post-event countdown decrement leaves 2 rounds of effect.
          executeMarkRounds[execTarget.id] = 3;
          // Deal the Executioner's strike — 2.0× ATK is the Champion-signature
          // burst multiplier for this skill, INLINED BY DESIGN (not in COMBAT_TUNING).
          const baseDmg = calcPartyDmg(execHero, es + 750, dmgBonus);
          const strikeDmg = Math.max(1, Math.floor(baseDmg * 2.0));
          const actualDmg = applyDef(strikeDmg, execTarget.def || 0);
          execTarget.hp = Math.max(0, execTarget.hp - actualDmg);
          if (combatStats[execHero.id]) combatStats[execHero.id].dmgDealt += actualDmg;
          executionerCooldowns[execHero.id] = 3;
          const execText = sPick(T_EXECUTIONER, es + 751)(execHero.name, execTarget.name, actualDmg);
          events.push({ text: execText, type: 'crit', icon: '🎯', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          _logReactive("Executioner's Mark", execHero.name, execTarget.name, `${actualDmg} dmg + marked`);
          if (execTarget.hp <= 0) {
            execTarget.alive = false;
            fallenEnemies.push(execTarget.name);
            tryRaiseDead(execTarget, es + 3357);
            const defeatText = sPick(T_ENEMY_DEFEAT, es + 752)(execTarget.name, execHero.name);
            events.push({ text: defeatText, type: 'defeat', icon: '💥', phase: 'battle' });
            snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
            // Feed Bloodlust on kill if another hero has the passive
            const bloodlustHero = livingParty.find(p => p.hp > 0 && heroesWithBloodlust.has(p.id));
            if (bloodlustHero) bloodlustActive[bloodlustHero.id] = true;
          }
        }
      }
    }

    // ── Equipment active skill procs (bonus end-of-round action) ────────
    // Equipment active skills fire as a bonus action on top of the ATB attack
    // lane — they do NOT steal turn time from class skills. Per-member CD
    // (equipProcCooldowns) gates firing to at most once every 2 rounds to
    // prevent proc spam. Each skill also uses the standard skillCooldowns map.
    //
    // SLOT-DRIVEN DISPATCH: a proc's behavior is decided by the bound item's
    // slot (pulled from data.js at proc time):
    //   • weapon  → deals direct damage (honors powerMultiplier + atkBonus/
    //               magBonus + critChance boost)
    //   • other   → drops a pending buff on the member that empowers their
    //               NEXT damage/heal action (consumed in calcPartyDmg)
    // Celestial 2H weapons can still grant auras — those live as passives and
    // apply in applyPassiveSkills, not here. The only way to reach this lane
    // is a skill with type === 'active'.
    for (const m of livingParty) {
      if (m.hp <= 0) continue;
      if (equipProcCooldowns[m.id] > 0) continue;
      const equipPool = memberEquipProcSkills[m.id] || [];
      if (equipPool.length === 0) continue;
      const readyEquip = equipPool.filter(sid => !skillCooldowns[m.id][sid]);
      if (readyEquip.length === 0) continue;

      const pickedSid = sPick(readyEquip, es + 810 + equipPool.length);
      const eqSkill = getSkill(pickedSid);
      if (!eqSkill) continue;

      // Roll proc
      const procRoll = sRand(es + 811);
      const procThresh = eqSkill.procChance || 0.55;
      if (procRoll >= procThresh) continue;

      // Slot lookup → dispatch path
      const boundItem = eqSkill.itemId ? getItem(eqSkill.itemId) : null;
      const isWeaponProc = boundItem && boundItem.slot === 'weapon' && !eqSkill.pendingBuff;
      const isCelestial = boundItem && boundItem.rarity === 'celestial';

      // ── Offhand DoT proc → apply DoT to target ──────────────────────
      const skillEff = eqSkill.effects || {};
      if (skillEff.dotAtkScale) {
        const tgt = sPick(livingEnemies, es + 819);
        if (!tgt) continue;
        const dotDmg = Math.max(2, Math.floor(m.atk * skillEff.dotAtkScale));
        const dotRounds = skillEff.dotRounds || 3;
        const dotIcon = eqSkill.icon || '🧪';
        const dotType = isCelestial ? 'celestial' : 'equip';

        if (skillEff.atkDebuff) {
          // Rogue poison DoT
          equipPoisonTargets[tgt.id] = { rounds: dotRounds, dmgPerTick: dotDmg, ownerId: m.id, atkDebuff: skillEff.atkDebuff };
        } else if (skillEff.spdDebuff) {
          // Monk chi burn DoT
          chiBurnTargets[tgt.id] = { rounds: dotRounds, dmgPerTick: dotDmg, ownerId: m.id, spdDebuff: skillEff.spdDebuff };
        }
        const narrativeText = eqSkill.narrative ? `${m.name} ${eqSkill.narrative}` : `${m.name} applies ${eqSkill.name} to ${tgt.name}!`;
        events.push({ text: `${narrativeText} <span class="dmg-num dmg-phys">${dotDmg}</span>/round for ${dotRounds} rounds!`, type: dotType, icon: dotIcon, phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        equipProcCooldowns[m.id] = isCelestial ? CELESTIAL_PROC_COOLDOWN : 2;
        skillCooldowns[m.id][pickedSid] = SKILL_COOLDOWN;
        continue;
      }

      if (!isWeaponProc) {
        // ── Non-weapon proc → empower next action ─────────────────────
        // Drop a pending buff on this member. calcPartyDmg consumes it on
        // the next damage-dealing action. No damage is dealt right now.
        pendingEquipBuffs[m.id] = {
          source: eqSkill.name,
          effects: eqSkill.effects || {},
        };
        const tmpl = isCelestial ? T_CELESTIAL_BUFF : T_EQUIP_BUFF;
        const buffText = sPick(tmpl, es + 817)(m.name, eqSkill.name);
        const buffIcon = eqSkill.icon || (isCelestial ? '✦' : '•');
        const buffType = isCelestial ? 'celestial' : 'equip';
        events.push({ text: buffText, type: buffType, icon: buffIcon, phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        equipProcCooldowns[m.id] = isCelestial ? CELESTIAL_PROC_COOLDOWN : 2;
        skillCooldowns[m.id][pickedSid] = SKILL_COOLDOWN;
        continue;
      }

      // ── Weapon proc → direct damage ───────────────────────────────
      // Compute damage: baseDmg × powerMultiplier × (1 + statBonus) × rarityScalar
      // The rarity scalar keeps weapon procs below class skill damage:
      //   non-celestial = bonus hits, celestial = matches L6-L10 skills
      // DEF-scaling: Knight/Paladin weapons with defScaling blend DEF into the
      // raw base so tanky classes deal meaningful proc damage despite low ATK.
      const eff = eqSkill.effects || {};
      const powerMult = eff.powerMultiplier || 1.0;
      const bonusMult = 1.0 + (eff.atkBonus || 0) + (eff.magBonus || 0);
      const itemRarity = (boundItem && boundItem.rarity) ? boundItem.rarity.toLowerCase() : 'common';
      const procScalar = WEAPON_PROC_SCALAR[itemRarity] || WEAPON_PROC_SCALAR.common;
      let rawBase = calcPartyDmg(m, es + 812, dmgBonus);
      // Blend DEF into raw base for skills that opt in (e.g. Knight weapon procs)
      if (eff.defScaling && m.def) {
        const defMultiplier = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(es + 818) * COMBAT_TUNING.PARTY_DMG_SPREAD;
        rawBase += Math.floor(m.def * eff.defScaling * defMultiplier);
      }
      let baseDmg = Math.max(3, Math.floor(rawBase * powerMult * bonusMult * procScalar));

      // Extra crit chance from skill effects stacks with member's base crit
      const extraCrit = eff.critChance || 0;
      const equipIsCrit = sRand(es + 813) < Math.min(COMBAT_TUNING.CRIT_CAP, critChance(m) + extraCrit + graveHungerCritBonus);
      if (equipIsCrit) baseDmg = Math.floor(baseDmg * COMBAT_TUNING.PARTY_BASE_CRIT_MULT);

      // Route AoE through the shared AOE_SKILLS table
      const aoeInfo = AOE_SKILLS[pickedSid];
      let equipText;

      let procHitTarget = null; // track single-target hit for DEF shred
      let procDmgDealt = 0;    // track damage dealt for Celestial Cascade
      if (aoeInfo) {
        // AoE fire — baseDmg already reflects powerMultiplier; scale by aoe.dmgScale
        const currentLiving = enemies.filter(e => e.alive);
        if (currentLiving.length === 0) continue; // No targets — skip this equip proc
        let totalDmg = 0;
        const perTarget = Math.max(1, Math.floor(baseDmg * aoeInfo.dmgScale));
        for (const e of currentLiving) {
          let hit = perTarget;
          if (markedEnemies[e.id]) hit = Math.floor(hit * 1.20);
          if (executeMarkRounds[e.id] > 0) hit = Math.floor(hit * 1.10);
          const applied = eff.defPierce ? hit : applyDef(hit, e.def || 0);
          e.hp = Math.max(0, e.hp - applied);
          totalDmg += applied;
          if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, es + 3456); }
        }
        if (combatStats[m.id]) combatStats[m.id].dmgDealt += totalDmg;
        procDmgDealt = totalDmg;
        const tmpl = isCelestial ? T_CELESTIAL_SKILL : T_EQUIP_SKILL;
        equipText = sPick(tmpl, es + 814)(m.name, eqSkill.name, `${currentLiving.length} ${_f(currentLiving.length)}`, totalDmg);
      } else {
        // Single-target fire
        const tgt = sPick(livingEnemies, es + 815);
        if (!tgt) continue;
        procHitTarget = tgt;
        if (markedEnemies[tgt.id]) baseDmg = Math.floor(baseDmg * 1.20);
        if (executeMarkRounds[tgt.id] > 0) baseDmg = Math.floor(baseDmg * 1.10);
        const applied = eff.defPierce ? baseDmg : applyDef(baseDmg, tgt.def || 0);
        tgt.hp = Math.max(0, tgt.hp - applied);
        if (combatStats[m.id]) combatStats[m.id].dmgDealt += applied;
        procDmgDealt = applied;
        const tmpl = isCelestial ? T_CELESTIAL_SKILL : T_EQUIP_SKILL;
        equipText = sPick(tmpl, es + 816)(m.name, eqSkill.name, tgt.name, applied);
        if (tgt.hp <= 0) {
          tgt.alive = false;
          fallenEnemies.push(tgt.name);
          tryRaiseDead(tgt, es + 3474);
        }
      }

      // Apply DEF shred from scythe procs (Soul Reap, Abyssal Reap)
      if (eff.defShred && eff.defShredRounds && procHitTarget && procHitTarget.alive) {
        defShredTargets[procHitTarget.id] = Math.max(defShredTargets[procHitTarget.id] || 0, eff.defShredRounds);
      }

      const procIcon = eqSkill.icon || (isCelestial ? '✦' : '•');
      const procType = isCelestial ? 'celestial' : 'equip';
      events.push({ text: equipText, type: procType, icon: procIcon, phase: 'battle' });
      snapshots.push(makeSnapshot(partyHp, enemies, _bufState));

      // ── Weapon proc lifesteal (Whisper Drain, Deathrattle — self-heal) ──
      // Heals the caster for a % of the damage dealt by this proc.
      if (eff.lifesteal && eff.lifesteal > 0 && procDmgDealt > 0 && m.hp > 0) {
        const leechAmt = Math.max(1, Math.floor(procDmgDealt * eff.lifesteal));
        const before = m.hp;
        m.hp = Math.min(m.maxHp, m.hp + leechAmt);
        const actual = m.hp - before;
        if (actual > 0) {
          if (combatStats[m.id]) { combatStats[m.id].healingDone += actual; combatStats[m.id].healingReceived += actual; }
          const drainText = sPick(T_SHADOW_BOLT_LEECH, es + 8850)(1, actual);
          events.push({ text: drainText, type: 'heal', icon: '🩸', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }

      // ── Weapon proc party leech (Celestial Soul Drain — party-wide heal) ──
      // Like Shadow Bolt's party leech: each living ally heals X% of their max HP.
      if (eff.partyLeechPct && eff.partyLeechPct > 0 && procDmgDealt > 0) {
        let leechCount = 0;
        let leechTotal = 0;
        for (const ally of livingParty) {
          if (ally.hp <= 0) continue;
          const healAmt = Math.max(1, Math.floor(ally.maxHp * eff.partyLeechPct));
          const before = ally.hp;
          ally.hp = Math.min(ally.maxHp, ally.hp + healAmt);
          const actual = ally.hp - before;
          if (actual > 0) {
            leechCount++;
            leechTotal += actual;
            if (combatStats[ally.id]) combatStats[ally.id].healingReceived += actual;
            if (combatStats[m.id]) combatStats[m.id].healingDone += actual;
          }
        }
        if (leechCount > 0) {
          const drainText = sPick(T_SHADOW_BOLT_LEECH, es + 8855)(leechCount, leechTotal);
          events.push({ text: drainText, type: 'heal', icon: '🩸', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        }
      }

      // ── Celestial Cascade on weapon proc ──────────────────────────
      if (isCelestial && procDmgDealt > 0) {
        tryCelestialCascade(procDmgDealt, procHitTarget, m, es + 8800 + roundCount);
      }

      // ── Celestial Echo (PARTY_CEL_ECHO talent) ────────────────────
      // When a celestial weapon damage proc fires, 5% chance all OTHER
      // party members' celestial weapons echo in harmony.
      // Only triggers on weapon damage procs (not DoT, not buff, not deflect).
      // Echo hits cannot re-trigger further echoes (no cascading).
      if (talentCelEcho && isCelestial && isWeaponProc && eff.powerMultiplier) {
        const echoRoll = sRand(es + 9900 + round);
        if (echoRoll < 0.05) {
          events.push({
            text: `<strong>🌟 CELESTIAL ECHO!</strong> The party's celestial weapons resonate in harmony!`,
            type: 'celestial', icon: '🌟', phase: 'battle',
          });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          let echoSeed = es + 9910 + round * 7;
          for (const echoM of livingParty) {
            if (echoM.id === m.id || echoM.hp <= 0) continue;
            const echoData = celEchoMap[echoM.id];
            if (!echoData) continue;
            const eSk = echoData.skill;
            const eEff = eSk.effects || {};
            const ePower = eEff.powerMultiplier || 1.0;
            const eBonus = 1.0 + (eEff.atkBonus || 0) + (eEff.magBonus || 0);
            const eItem = echoData.item;
            const eScalar = WEAPON_PROC_SCALAR[eItem.rarity] || WEAPON_PROC_SCALAR.common;
            let eRaw = calcPartyDmg(echoM, echoSeed, dmgBonus);
            if (eEff.defScaling && echoM.def) {
              const eDefMult = COMBAT_TUNING.PARTY_DMG_MIN_MULT + sRand(echoSeed + 1) * COMBAT_TUNING.PARTY_DMG_SPREAD;
              eRaw += Math.floor(echoM.def * eEff.defScaling * eDefMult);
            }
            let echoDmg = Math.max(3, Math.floor(eRaw * ePower * eBonus * eScalar));
            // Echo crit check
            const echoCrit = sRand(echoSeed + 2) < Math.min(COMBAT_TUNING.CRIT_CAP, critChance(echoM) + (eEff.critChance || 0) + graveHungerCritBonus);
            if (echoCrit) echoDmg = Math.floor(echoDmg * COMBAT_TUNING.PARTY_BASE_CRIT_MULT);
            // AoE echo
            const eAoe = AOE_SKILLS[echoData.skillId];
            if (eAoe) {
              const eLiving = enemies.filter(e => e.alive);
              if (eLiving.length === 0) { echoSeed += 10; continue; }
              const ePer = Math.max(1, Math.floor(echoDmg * eAoe.dmgScale));
              let eTot = 0;
              for (const e of eLiving) {
                const eApplied = eEff.defPierce ? ePer : applyDef(ePer, e.def || 0);
                e.hp = Math.max(0, e.hp - eApplied);
                eTot += eApplied;
                if (e.hp <= 0) { e.alive = false; fallenEnemies.push(e.name); tryRaiseDead(e, echoSeed + 5); }
              }
              if (combatStats[echoM.id]) combatStats[echoM.id].dmgDealt += eTot;
              events.push({
                text: `${echoM.name}'s <strong>${eSk.name}</strong> echoes — <span class="dmg-num dmg-celestial">${eTot}</span> to ${eLiving.length} ${_f(eLiving.length)}!`,
                type: 'celestial', icon: eSk.icon || '✦', phase: 'battle',
              });
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              // Cascade can trigger on echo AoE hits too — uses Harmonic Cascade visual
              tryCelestialCascade(eTot, null, echoM, echoSeed + 7, true);
            } else {
              // Single-target echo — pick random living enemy
              const eTgt = sPick(enemies.filter(e => e.alive), echoSeed + 3);
              if (!eTgt) { echoSeed += 10; continue; }
              const eApplied = eEff.defPierce ? echoDmg : applyDef(echoDmg, eTgt.def || 0);
              eTgt.hp = Math.max(0, eTgt.hp - eApplied);
              if (combatStats[echoM.id]) combatStats[echoM.id].dmgDealt += eApplied;
              events.push({
                text: `${echoM.name}'s <strong>${eSk.name}</strong> echoes — <span class="dmg-num dmg-celestial">${eApplied}</span> to ${eTgt.name}!`,
                type: 'celestial', icon: eSk.icon || '✦', phase: 'battle',
              });
              if (eTgt.hp <= 0) { eTgt.alive = false; fallenEnemies.push(eTgt.name); tryRaiseDead(eTgt, echoSeed + 6); }
              snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
              // Cascade can trigger on echo ST hits too — uses Harmonic Cascade visual
              tryCelestialCascade(eApplied, eTgt, echoM, echoSeed + 8, true);
            }
            echoSeed += 10;
          }
        }
      }

      equipProcCooldowns[m.id] = isCelestial ? CELESTIAL_PROC_COOLDOWN : 2;
      skillCooldowns[m.id][pickedSid] = SKILL_COOLDOWN;
    }

    // Countdown all debuffs and buffs
    for (const e of livingEnemies) {
      if (markedEnemies[e.id] > 0) markedEnemies[e.id]--;
      if (stormMarkRounds[e.id] > 0) stormMarkRounds[e.id]--;
      if (tauntedEnemies[e.id] > 0) tauntedEnemies[e.id]--;
      if (defShredTargets[e.id] > 0) defShredTargets[e.id]--;
      if (exposedTargets[e.id] > 0) exposedTargets[e.id]--;
      if (executeMarkRounds[e.id] > 0) executeMarkRounds[e.id]--;
    }

    for (const m of livingParty) {
      if (spellEchoRounds[m.id] > 0) spellEchoRounds[m.id]--;
      if (aftershockCooldowns[m.id] > 0) aftershockCooldowns[m.id]--;
      // Mage Phase Shift — decrement active rounds and cooldown
      if (phaseShiftRounds[m.id] > 0) {
        phaseShiftRounds[m.id]--;
        if (phaseShiftRounds[m.id] === 0) {
          // Phase back in — narrate the return
          events.push({ text: sPick(T_PHASE_RETURN, es + 347)(m.name), type: 'magic', icon: '🌀', phase: 'battle' });
          snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
          // Arcane Reflection talent: +25% spell dmg for 2 rounds on return
          if (phaseShiftDmgBoost[m.id]) {
            phaseShiftDmgBoost[m.id] = 2; // rounds remaining for +25% dmg boost
          }
        }
      }
      if (phaseShiftCooldowns[m.id] > 0) phaseShiftCooldowns[m.id]--;
      if (phaseShiftDmgBoost[m.id] > 0) phaseShiftDmgBoost[m.id]--;
      if (camoRounds[m.id] > 0) camoRounds[m.id]--;
      if (sacredWarmthRounds[m.id] > 0) sacredWarmthRounds[m.id]--;
      if (unbreakableDR[m.id] > 0) unbreakableDR[m.id]--;
      if (wrathBuff[m.id] > 0) wrathBuff[m.id]--;
      // Monk class rework countdowns
      if (flowingStrikeCooldowns[m.id] > 0) flowingStrikeCooldowns[m.id]--;
      if (ironStanceBuffs[m.id] > 0) ironStanceBuffs[m.id]--;
      // Flowing Defense deflect buff countdown (active procs only — passive has Infinity rounds)
      if (deflectBuffs[m.id] && deflectBuffs[m.id].rounds !== Infinity && deflectBuffs[m.id].rounds > 0) deflectBuffs[m.id].rounds--;
      if (deflectBuffs[m.id] && deflectBuffs[m.id].rounds <= 0 && deflectBuffs[m.id].rounds !== Infinity) delete deflectBuffs[m.id];
      // Ranger Hunter's Mark cooldown
      if (huntersMarkCooldowns[m.id] > 0) huntersMarkCooldowns[m.id]--;
      // Knight Last Stand buff/cooldown
      if (lastStandBuffRounds[m.id] > 0) lastStandBuffRounds[m.id]--;
      if (lastStandCooldowns[m.id] > 0) lastStandCooldowns[m.id]--;
      // Bard Crescendo / Cadence cooldowns
      if (crescendoCooldowns[m.id] > 0) crescendoCooldowns[m.id]--;
      if (cadenceCooldowns[m.id] > 0) cadenceCooldowns[m.id]--;
      // Hero spec cooldowns
      if (vanguardCooldowns[m.id] > 0) vanguardCooldowns[m.id]--;
      if (unbreakableCooldowns[m.id] > 0) unbreakableCooldowns[m.id]--;
      if (executionerCooldowns[m.id] > 0) executionerCooldowns[m.id]--;
      if (wrathCooldowns[m.id] > 0) wrathCooldowns[m.id]--;
      if (guardianCooldowns[m.id] > 0) guardianCooldowns[m.id]--;
      // Hero L14 Second Wind buff + cooldown
      if (secondWindRounds[m.id] > 0) secondWindRounds[m.id]--;
      if (secondWindCooldowns[m.id] > 0) secondWindCooldowns[m.id]--;
      // Equipment proc lane lockout
      if (equipProcCooldowns[m.id] > 0) equipProcCooldowns[m.id]--;
      // Rogue Riposte / Cleric Guardian's Grasp reactive cooldowns
      if (riposteCooldowns[m.id] > 0) riposteCooldowns[m.id]--;
      if (guardianGraspCooldowns[m.id] > 0) guardianGraspCooldowns[m.id]--;
      // Necromancer Raise Dead cooldown (2-round corpse-gated signature)
      if (raiseDeadCooldowns[m.id] > 0) raiseDeadCooldowns[m.id]--;
    }
    // Retry any pending corpses — fires AFTER the Raise Dead cooldown has
    // decremented so a necro whose CD expires this round can immediately
    // raise a queued corpse, and AFTER the minion-death reconciliation
    // earlier in this round so a thrall dying opens the gate for the next
    // raise in the same round rather than making the party wait a turn.
    sweepPendingRaises();
    // Pressure Point debuff countdown on enemies
    for (const e of livingEnemies) {
      if (pressurePointDebuffs[e.id] > 0) pressurePointDebuffs[e.id]--;
    }
  
    // Skill cooldown countdown
    for (const m of livingParty) {
      for (const sid in skillCooldowns[m.id]) {
        if (skillCooldowns[m.id][sid] > 0) skillCooldowns[m.id][sid]--;
      }
    }
  
    // Global reinforcement proc — DELETED per §9 scaling rework.
    // Reinforcements used to exist as compensation for the old enemy generator
    // saturating against difficultyScale. With intrinsic rank curves there is
    // no reason to top up enemies mid-fight — encounters are now tuned at the
    // sub-tier level up front. Authored reinforcements (boss phase summons,
    // "Call for Help" skills) are preserved because they are part of encounter
    // design, not a scaling crutch.
  }
  
  // Finalize ATB debug
  if (manualPending) {
    _combatDebug.atb.totalRounds = roundCount;
    return {
      events, snapshots, partyHp, enemies, totalEvents: events.length, battleOutcome: null,
      effectiveInterval, combatStats, combatDebug: _combatDebug,
      decisiveIndex: Math.max(0, events.length - 1), pending: manualPending,
    };
  }
  _combatDebug.atb.totalRounds = roundCount;

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 3: Post-Battle Resolution
  // ─────────────────────────────────────────────────────────────────────────────
  
  if (!battleOutcome) {
    const livingEnemies = enemies.filter(e => e.alive);
    const livingParty = partyHp.filter(p => p.hp > 0);
    const partyHpLeft = livingParty.reduce((s, p) => s + p.hp, 0);
    const enemyHpLeft = livingEnemies.reduce((s, e) => s + e.hp, 0);
    const partyWins = partyHpLeft >= enemyHpLeft;
  
    if (partyWins) {
      let finishSeed = seed + 200000;
      for (const enemy of livingEnemies) {
        const attacker = sPickWeighted(livingParty.filter(p => p.hp > 0), finishSeed++);
        if (!attacker) break;
        const dmg = enemy.hp;
        enemy.hp = 0;
        enemy.alive = false;
        if (combatStats[attacker.id]) combatStats[attacker.id].dmgDealt += dmg;
        const classId = attacker.class || 'HERO';
        const atkText = getAttackTemplate(classId, finishSeed)(attacker.name, enemy.name, dmg);
        events.push({ text: atkText, type: 'attack', icon: '⚔', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        const defeatText = sPick(T_ENEMY_DEFEAT, finishSeed + 1)(enemy.name, attacker.name);
        events.push({ text: defeatText, type: 'defeat', icon: '💥', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        finishSeed += 100;
      }
      battleOutcome = 'victory';
    } else {
      let finishSeed = seed + 300000;
      for (const member of livingParty) {
        const attacker = sPick(enemies.filter(e => e.alive), finishSeed++);
        if (!attacker) break;
        const dmg = member.hp;
        member.hp = 0;
        if (combatStats[member.id]) combatStats[member.id].dmgTaken += dmg;
        const atkText = sPick(T_ENEMY_ATK, finishSeed)(attacker.name, member.name, dmg);
        events.push({ text: atkText, type: 'enemy', icon: '💀', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        const koText = sPick(T_PARTY_KO, finishSeed + 1)(member.name, attacker.name);
        events.push({ text: koText, type: 'ko', icon: '💀', phase: 'battle' });
        snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
        finishSeed += 100;
      }
      battleOutcome = 'defeat';
    }
  }
  
  {
    const es = seed + 99999;
    const m = sPick(members, es + 1);
    const templates = battleOutcome === 'victory' ? T_RESOLVE_WIN : T_RESOLVE_LOSE;
    const text = sPick(templates, es)(m ? m.name : 'The party');
    events.push({ text, type: 'resolve', icon: '✦', phase: 'resolve' });
    snapshots.push(makeSnapshot(partyHp, enemies, _bufState));
  }


  const totalEvents = events.length;

  // Compute "decisive moment" — the snapshot after which the fight is permanently over.
  // Must handle reinforcements: enemies may briefly all die, then respawn. So we scan
  // from the END backwards and find the last snapshot where the fight was still
  // contested (both sides had living members). The next snapshot is the true decisive
  // frame — everything after plays at fast-forward to avoid UI drag.
  let decisiveIndex = totalEvents - 1;
  for (let idx = snapshots.length - 1; idx >= 0; idx--) {
    const snap = snapshots[idx];
    if (!snap) continue;
    const enemiesAlive = snap.enemies && snap.enemies.some(e => e.hp > 0 && e.alive !== false);
    const partyAlive = snap.party && snap.party.some(p => p.hp > 0);
    if (enemiesAlive && partyAlive) {
      decisiveIndex = Math.min(totalEvents - 1, idx + 1);
      break;
    }
  }

  return { events, snapshots, partyHp, enemies, totalEvents, battleOutcome, effectiveInterval, combatStats, combatDebug: _combatDebug, decisiveIndex };
}

function makeSnapshot(party, enemies, buffs) {
  const b = buffs || {};
  return {
    party: party.map(p => {
      const pBuffs = [];
      // Bard regen
      if (b.regenPerTick > 0) pBuffs.push({ id: 'regen', icon: '🎵', label: 'Regen', desc: `+${b.regenPerTick} HP/rd` });
      if (b.clericRegenPerTick > 0) pBuffs.push({ id: 'cleric-regen', icon: '✨', label: 'Sanctified', desc: `+${b.clericRegenPerTick} HP/rd` });
      // Knight Bulwark cooldown
      if (b.coverCooldowns && b.coverCooldowns[p.id] !== undefined) {
        const cd = b.coverCooldowns[p.id];
        if (b.knightsWithCover && b.knightsWithCover.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'bulwark_cd', icon: '🛡', label: 'Bulwark', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'bulwark', icon: '🛡', label: 'Bulwark', desc: 'Ready' });
        }
      }
      // Hero Rally Cry cooldown
      if (b.rallyCooldowns && b.rallyCooldowns[p.id] !== undefined) {
        const cd = b.rallyCooldowns[p.id];
        if (b.heroesWithRally && b.heroesWithRally.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'rally_cd', icon: '📣', label: 'Rally', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'rally', icon: '📣', label: 'Rally', desc: 'Ready' });
        }
      }
      // Monk Ki Barrier
      if (b.monksWithKiBarrier && b.monksWithKiBarrier.has(p.id)) {
        pBuffs.push({ id: 'ki_barrier', icon: '🔮', label: 'Ki Barrier', desc: 'Lifesteal' });
      }
      // Rogue Mark available
      if (b.roguesWithMark && b.roguesWithMark.has(p.id)) {
        pBuffs.push({ id: 'mark', icon: '🎯', label: 'Mark', desc: 'On crit' });
      }
      // Mage Phase Shift (reactive) — phased / cooldown / ready
      if (b.phaseShiftRounds && b.phaseShiftRounds[p.id] > 0) {
        pBuffs.push({ id: 'phase_shift', icon: '🌀', label: 'Phased', desc: `${b.phaseShiftRounds[p.id]}rd — untargetable` });
      } else if (b.phaseShiftCooldowns && b.phaseShiftCooldowns[p.id] > 0) {
        pBuffs.push({ id: 'phase_cd', icon: '🌀', label: 'Phase', desc: `CD: ${b.phaseShiftCooldowns[p.id]}`, cooldown: true });
      } else if (b.magesWithPhaseShift && b.magesWithPhaseShift.has(p.id)) {
        pBuffs.push({ id: 'phase_ready', icon: '🌀', label: 'Phase', desc: 'Ready' });
      }
      // Phase Shift damage boost (Arcane Reflection talent)
      if (b.phaseShiftDmgBoost && b.phaseShiftDmgBoost[p.id] > 0) {
        pBuffs.push({ id: 'phase_dmg', icon: '💜', label: 'Arcane Surge', desc: `${b.phaseShiftDmgBoost[p.id]}rd — +25% dmg` });
      }
      // Mage Arcane Aftershock (reactive) — status + ICD cooldown
      if (b.spellEchoRounds && b.spellEchoRounds[p.id] > 0) {
        pBuffs.push({ id: 'aftershock', icon: '🌀', label: 'Aftershock', desc: `${b.spellEchoRounds[p.id]}rd — 1.5× dmg` });
      } else if (b.aftershockCooldowns && b.aftershockCooldowns[p.id] > 0) {
        pBuffs.push({ id: 'aftershock_cd', icon: '🌀', label: 'Aftershock', desc: `CD: ${b.aftershockCooldowns[p.id]}`, cooldown: true });
      } else if (b.magesWithSpellEcho && b.magesWithSpellEcho.has(p.id)) {
        pBuffs.push({ id: 'aftershock_ready', icon: '🌀', label: 'Aftershock', desc: 'Ready', cooldown: true });
      }
      // Ranger Camouflage
      if (b.camoRounds && b.camoRounds[p.id] > 0) {
        pBuffs.push({ id: 'camo', icon: '🍃', label: 'Camo', desc: `${b.camoRounds[p.id]}rd — 40% dodge` });
      }
      // Cleric Divine Shield (party-wide)
      if (b.divineShieldRounds > 0) {
        pBuffs.push({ id: 'divine_shield', icon: '⛨', label: 'D.Shield', desc: `${b.divineShieldRounds}rd — -15% dmg` });
      }
      // Cleric Divine Intervention cooldown
      if (b.interventionCooldowns && b.interventionCooldowns[p.id] !== undefined) {
        const cd = b.interventionCooldowns[p.id];
        if (b.clericsWithIntervention && b.clericsWithIntervention.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'intervention_cd', icon: '🕊', label: 'D.Interv', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'intervention', icon: '🕊', label: 'D.Interv', desc: 'Ready' });
        }
      }
      // Cleric Resurrection cooldown
      if (b.resurrectionCooldowns && b.resurrectionCooldowns[p.id] !== undefined) {
        const cd = b.resurrectionCooldowns[p.id];
        if (b.clericsWithResurrection && b.clericsWithResurrection.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'rez_cd', icon: '🌟', label: 'Resurrect', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'rez', icon: '🌟', label: 'Resurrect', desc: 'Ready' });
        }
      }
      // Hero Champion — Executioner's Mark cooldown
      if (b.executionerCooldowns && b.executionerCooldowns[p.id] !== undefined) {
        const cd = b.executionerCooldowns[p.id];
        if (b.heroesWithExecutioner && b.heroesWithExecutioner.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'exec_cd', icon: '🎯', label: "Exec Mark", desc: `CD: ${cd}`, cooldown: true }
            : { id: 'exec', icon: '🎯', label: "Exec Mark", desc: 'Ready' });
        }
      }
      // Bard Discord cooldown
      if (b.discordCooldowns && b.discordCooldowns[p.id] !== undefined) {
        const cd = b.discordCooldowns[p.id];
        if (b.bardsWithDiscord && b.bardsWithDiscord.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'discord_cd', icon: '🎸', label: 'Discord', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'discord', icon: '🎸', label: 'Discord', desc: 'Ready' });
        }
      }
      // Bard Crescendo cooldown
      if (b.crescendoCooldowns && b.crescendoCooldowns[p.id] !== undefined) {
        const cd = b.crescendoCooldowns[p.id];
        if (b.bardsWithCrescendo && b.bardsWithCrescendo.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'cresc_cd', icon: '🎶', label: 'Crescendo', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'cresc', icon: '🎶', label: 'Crescendo', desc: 'Ready' });
        }
      }
      // Crescendo active (party-wide indicator)
      if (b.crescendoActive) {
        pBuffs.push({ id: 'cresc_active', icon: '🎶', label: 'Crescendo', desc: 'Next atk: 2.5× CRIT' });
      }
      // Bard Cadence cooldown (per-bard) + active rounds (party-wide)
      if (b.cadenceCooldowns && b.cadenceCooldowns[p.id] !== undefined && p.class === 'BARD') {
        const cd = b.cadenceCooldowns[p.id];
        pBuffs.push(cd > 0
          ? { id: 'cadence_cd', icon: '🎼', label: 'Cadence', desc: `CD: ${cd}`, cooldown: true }
          : { id: 'cadence', icon: '🎼', label: 'Cadence', desc: 'Ready' });
      }
      if (b.cadenceRounds > 0) {
        pBuffs.push({ id: 'cadence_active', icon: '🎼', label: 'Cadence', desc: `+15% dmg, +10% crit (${b.cadenceRounds}r)` });
      }
      // Mage Frostbite active debuff (party-wide enemy debuff)
      if (b.frostbiteRounds > 0) {
        pBuffs.push({ id: 'frostbite', icon: '❄', label: 'Frostbite', desc: `Enemies -15% ATK, 20% fumble (${b.frostbiteRounds}r)` });
      }
      // Rogue Smoke Bomb — party-wide dodge buff
      if (b.smokeBombRounds > 0) {
        pBuffs.push({ id: 'smoke_bomb', icon: '💨', label: 'Smoke', desc: `+30% dodge (${b.smokeBombRounds}r)` });
      }
      // Monk Swift Palm — party-wide ATK + SPD buff
      if (b.swiftPalmRounds > 0) {
        pBuffs.push({ id: 'swift_palm', icon: '👊', label: 'Swift Palm', desc: `+25% ATK, +15% SPD (${b.swiftPalmRounds}r)` });
      }
      // Necromancer Raise Dead cooldown
      if (b.raiseDeadCooldowns && b.raiseDeadCooldowns[p.id] !== undefined) {
        const cd = b.raiseDeadCooldowns[p.id];
        if (b.necrosWithRaiseDead && b.necrosWithRaiseDead.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'raise_cd', icon: '💀', label: 'Raise', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'raise', icon: '💀', label: 'Raise', desc: 'Ready' });
        }
      }
      // Mage Arcane Construct indicator
      if (b.arcaneConstructs && b.magesWithConstruct && b.magesWithConstruct.has(p.id)) {
        const myC = b.arcaneConstructs.find(c => c.ownerId === p.id && c.hp > 0);
        if (myC) {
          pBuffs.push({ id: 'construct', icon: '🔮', label: 'Construct', desc: `${myC.name} (${myC.hp}/${myC.maxHp})` });
        } else if (b.constructCooldowns && b.constructCooldowns[p.id] > 0) {
          pBuffs.push({ id: 'construct_cd', icon: '🔮', label: 'Construct', desc: `Reforming (${b.constructCooldowns[p.id]}rd)`, cooldown: true });
        }
      }
      // Necromancer active minion indicator
      if (b.necroMinions && b.necroMinions.length > 0 && b.necrosWithRaiseDead && b.necrosWithRaiseDead.has(p.id)) {
        const m = b.necroMinions[0];
        pBuffs.push({ id: 'minion', icon: '🧟', label: 'Thrall', desc: `${m.name} (${m.hp}/${m.maxHp})` });
      }
      // Necromancer Forgo Death available
      if (b.necrosWithForgoDeath && b.necrosWithForgoDeath.has(p.id) && b.necroMinions && b.necroMinions.length > 0) {
        pBuffs.push({ id: 'forgo_death', icon: '🛡', label: 'Forgo Death', desc: 'Minion shield' });
      }
      // Blight — enemy-only DoT, icon lives on enemy cards (eDebuffs) not here
      // Army of the Damned active (party-wide)
      if (b.armyRounds > 0) {
        pBuffs.push({ id: 'army', icon: '👻', label: 'Army', desc: `${b.armyRounds}rd — risen dead` });
      }
      // Necrotic reflect (party-wide when Necro has Shroud of Decay)
      if (b.necroticReflectMag > 0) {
        pBuffs.push({ id: 'nec_reflect', icon: '💜', label: 'Decay', desc: 'Dmg reflect' });
      }
      // Dark Pact active (party-wide)
      if (b.darkPactRounds > 0) {
        pBuffs.push({ id: 'dark_pact', icon: '🩸', label: 'D.Pact', desc: `${b.darkPactRounds}rd — life siphon` });
      }
      // Necro passive group siphon (from offhand like Skull Whisper)
      if (b.necGroupSiphonPct > 0 && p.class === 'NECROMANCER') {
        pBuffs.push({ id: 'group_siphon', icon: '💬', label: 'Siphon', desc: `${Math.round(b.necGroupSiphonPct * 100)}% party heal on attack` });
      }
      // Grave Hunger stacks (party-wide dmg/crit/def from kills)
      if (b.graveHungerStacks > 0) {
        const gh = b.graveHungerStacks;
        pBuffs.push({ id: 'grave_hunger', icon: '🪓', label: `GH×${gh}`, desc: `+${gh * 2}% party dmg, +${gh}% crit, +${gh}% DEF (Shroud stack)` });
      }
      // Monk Iron Stance active
      if (b.ironStanceBuffs && b.ironStanceBuffs[p.id] > 0) {
        pBuffs.push({ id: 'iron_stance', icon: '🪨', label: 'Iron Stance', desc: `${b.ironStanceBuffs[p.id]}rd — +30% DEF, +20% dodge` });
      }
      // Monk Flowing Defense deflect buff
      if (b.deflectBuffs && b.deflectBuffs[p.id] && b.deflectBuffs[p.id].rounds > 0) {
        const db = b.deflectBuffs[p.id];
        const durStr = db.rounds === Infinity ? 'Passive' : `${db.rounds}rd`;
        pBuffs.push({ id: 'deflect', icon: '🛡', label: 'Deflect', desc: `${durStr} — ${Math.round(db.chance * 100)}% chance, -${Math.round(db.reduction * 100)}% dmg, ${Math.round(db.reflect * 100)}% reflect` });
      }
      // Monk Flowing Strike reactive — ready / cooldown
      if (b.flowingStrikeCooldowns && b.flowingStrikeCooldowns[p.id] !== undefined) {
        const cd = b.flowingStrikeCooldowns[p.id];
        if (b.monksWithFlowingStrike && b.monksWithFlowingStrike.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'flowing_cd', icon: '🌊', label: 'Flowing', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'flowing', icon: '🌊', label: 'Flowing', desc: 'Ready' });
        }
      }
      // Knight Last Stand reactive — active buff / cooldown / ready
      if (b.lastStandBuffRounds && b.lastStandBuffRounds[p.id] > 0) {
        pBuffs.push({ id: 'knt_last_stand', icon: '🔥', label: 'Last Stand', desc: `${b.lastStandBuffRounds[p.id]}rd — +40% DEF, +20% ATK` });
      } else if (b.lastStandCooldowns && b.lastStandCooldowns[p.id] > 0) {
        if (b.knightsWithLastStand && b.knightsWithLastStand.has(p.id)) {
          pBuffs.push({ id: 'knt_ls_cd', icon: '🔥', label: 'Last Stand', desc: `CD: ${b.lastStandCooldowns[p.id]}`, cooldown: true });
        }
      } else if (b.knightsWithLastStand && b.knightsWithLastStand.has(p.id)) {
        pBuffs.push({ id: 'knt_ls_ready', icon: '🔥', label: 'Last Stand', desc: 'Ready (<35% HP)' });
      }
      // Rogue Riposte reactive — ready / cooldown
      if (b.riposteCooldowns && b.riposteCooldowns[p.id] !== undefined) {
        const cd = b.riposteCooldowns[p.id];
        if (b.roguesWithRiposte && b.roguesWithRiposte.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'riposte_cd', icon: '⚔', label: 'Riposte', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'riposte', icon: '⚔', label: 'Riposte', desc: 'Ready' });
        }
      }
      // Hero Last Stand (once per fight revival)
      if (b.heroesWithLastStand && b.heroesWithLastStand.has(p.id)) {
        pBuffs.push(b.lastStandUsed && b.lastStandUsed[p.id]
          ? { id: 'hero_ls_used', icon: '⭐', label: 'Last Stand', desc: 'Used', cooldown: true }
          : { id: 'hero_ls', icon: '⭐', label: 'Last Stand', desc: 'Ready (party revive)' });
      }
      // Hero Second Wind reactive — active buff / cooldown / ready
      if (b.secondWindRounds && b.secondWindRounds[p.id] > 0) {
        pBuffs.push({ id: 'second_wind', icon: '💨', label: '2nd Wind', desc: `${b.secondWindRounds[p.id]}rd — +20% ATK` });
      } else if (b.secondWindCooldowns && b.secondWindCooldowns[p.id] > 0) {
        if (b.heroesWithSecondWind && b.heroesWithSecondWind.has(p.id)) {
          pBuffs.push({ id: 'sw_cd', icon: '💨', label: '2nd Wind', desc: `CD: ${b.secondWindCooldowns[p.id]}`, cooldown: true });
        }
      } else if (b.heroesWithSecondWind && b.heroesWithSecondWind.has(p.id)) {
        pBuffs.push({ id: 'sw_ready', icon: '💨', label: '2nd Wind', desc: 'Ready (<35% HP)' });
      }
      // Hero Vanguard Intercept reactive — ready / cooldown
      if (b.vanguardCooldowns && b.vanguardCooldowns[p.id] !== undefined) {
        const cd = b.vanguardCooldowns[p.id];
        if (b.heroesWithVanguard && b.heroesWithVanguard.has(p.id)) {
          pBuffs.push(cd > 0
            ? { id: 'vanguard_cd', icon: '🏹', label: 'Intercept', desc: `CD: ${cd}`, cooldown: true }
            : { id: 'vanguard', icon: '🏹', label: 'Intercept', desc: 'Ready' });
        }
      }
      // Cleric Sacred Warmth HoT
      if (b.sacredWarmthRounds && b.sacredWarmthRounds[p.id] > 0) {
        pBuffs.push({ id: 'sacred_warmth', icon: '🌸', label: 'Warmth', desc: `${b.sacredWarmthRounds[p.id]}rd — HoT` });
      }
      // Cleric Wrath buff
      if (b.wrathBuff && b.wrathBuff[p.id] > 0) {
        pBuffs.push({ id: 'wrath', icon: '⚡', label: 'Wrath', desc: `${b.wrathBuff[p.id]}rd — +30% dmg` });
      }
      // Passive bonus indicators (from items, passive skills, auras)
      if (p.dodgeChance > 0) {
        pBuffs.push({ id: 'dodge_bonus', icon: '💨', label: 'Dodge+', desc: `+${Math.round(p.dodgeChance * 100)}% dodge` });
      }
      if (p.critChance > 0) {
        pBuffs.push({ id: 'crit_bonus', icon: '⚡', label: 'Crit+', desc: `+${Math.round(p.critChance * 100)}% crit` });
      }
      if (p.healBonus > 0 && (p.class === 'CLERIC' || p.class === 'BARD')) {
        pBuffs.push({ id: 'heal_bonus', icon: '💚', label: 'Heal+', desc: `+${Math.round(p.healBonus * 100)}% heal` });
      }
      return { id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp, class: p.class, buffs: pBuffs };
    }),
    enemies: enemies.map(e => {
      const eDebuffs = [];
      if (b.executeMarkRounds && b.executeMarkRounds[e.id] > 0) {
        eDebuffs.push({ id: 'exec_mark', icon: '🎯', label: 'Exec Mark', desc: `${b.executeMarkRounds[e.id]}rd — +10% dmg`, rounds: b.executeMarkRounds[e.id] });
      }
      if (b.markedEnemies && b.markedEnemies[e.id] > 0) {
        eDebuffs.push({ id: 'marked', icon: '🎯', label: 'Marked', desc: `${b.markedEnemies[e.id]}rd`, rounds: b.markedEnemies[e.id] });
      }
      // Discord debuff on enemies
      if (b.discordRounds > 0) {
        eDebuffs.push({ id: 'discord', icon: '🎸', label: 'Discord', desc: `${b.discordRounds}rd — -${Math.round((0.20 + (b.discordAtkRedBonusTotal || 0)) * 100)}% ATK, ${Math.round((0.25 + (b.discordFumbleBonusTotal || 0)) * 100)}% fumble, DoT` });
      }
      // Blight debuff on enemies
      if (b.blightRounds > 0) {
        eDebuffs.push({ id: 'blight', icon: '☠', label: 'Blight', desc: `${b.blightRounds}rd — necrotic DoT` });
      }
      // Poison DoT (Rogue venom / Poison Blade proc)
      if (b.poisonTargets && b.poisonTargets[e.id] && b.poisonTargets[e.id].rounds > 0) {
        const pt = b.poisonTargets[e.id];
        eDebuffs.push({ id: 'poison', icon: '🧪', label: 'Poison', desc: `${pt.rounds}rd — ${pt.dmgPerTick}/tick`, rounds: pt.rounds });
      }
      // Burn DoT (Meteor Storm / Righteous Burn)
      if (b.burnTargets && b.burnTargets[e.id] && b.burnTargets[e.id].rounds > 0) {
        const bt = b.burnTargets[e.id];
        const icon = bt.source === 'CLR' ? '☀' : '🔥';
        eDebuffs.push({ id: 'burn', icon, label: 'Burn', desc: `${bt.rounds}rd — ${bt.dmgPerTick}/tick`, rounds: bt.rounds });
      }
      // Taunted (Knight Taunt)
      if (b.tauntedEnemies && b.tauntedEnemies[e.id] > 0) {
        eDebuffs.push({ id: 'taunted', icon: '😤', label: 'Taunted', desc: `${b.tauntedEnemies[e.id]}rd — forced target Knight` });
      }
      // DEF Shred (Knight talent)
      if (b.defShredTargets && b.defShredTargets[e.id] > 0) {
        eDebuffs.push({ id: 'def_shred', icon: '🔨', label: 'DEF Shred', desc: `${b.defShredTargets[e.id]}rd — +15% dmg taken` });
      }
      // Exposed (Rogue Fan of Knives)
      if (b.exposedTargets && b.exposedTargets[e.id] > 0) {
        eDebuffs.push({ id: 'exposed', icon: '👁', label: 'Exposed', desc: `${b.exposedTargets[e.id]}rd — +10% dmg taken` });
      }
      // Storm Mark (Ranger)
      if (b.stormMarkRounds && b.stormMarkRounds[e.id] > 0) {
        eDebuffs.push({ id: 'storm_mark', icon: '⛈', label: 'Storm Mark', desc: `${b.stormMarkRounds[e.id]}rd — +15% dmg taken` });
      }
      // Frostbite (party-wide enemy debuff)
      if (b.frostbiteRounds > 0) {
        eDebuffs.push({ id: 'frostbite', icon: '❄', label: 'Frostbite', desc: `${b.frostbiteRounds}rd — -15% ATK, 20% fumble` });
      }
      return {
        id: e.id, name: e.name, hp: Math.max(0, e.hp), maxHp: e.maxHp,
        alive: e.alive, isReinforcement: e.isReinforcement || false,
        role: e.role || 'standard',
        debuffs: eDebuffs,
      };
    }),
  };
}

// ── Ensure sim is built ────────────────────────────────────────────────
function manualSimKey(aq) {
  if (aq.battleMode !== 'manual') return '';
  return `${aq.startedAt}:${(aq.manualDecisions || []).length}:${aq.manualAutoRest ? 'a' : 'm'}`;
}
function syncManualInfo(sim) {
  Game.setQuestEventCount(sim.totalEvents, sim.effectiveInterval * 1000, sim.decisiveIndex, FAST_FORWARD_INTERVAL * 1000, !!sim.pending);
}
function ensureSim() {
  const aq = Game.state.guild.activeQuest;
  if (!aq) { _sim = null; _simQuestId = null; return null; }

  const quest = aq.questData || Game.getGeneratedQuest(aq.questId) || getQuest(aq.questId);
  if (!quest) return null;

  if (_simQuestId !== aq.questId || _simKey !== manualSimKey(aq)) {
    try {
      _sim = buildSimulation(aq, quest);
      _simQuestId = aq.questId;
      _simKey = manualSimKey(aq);
      if (aq.battleMode === 'manual') syncManualInfo(_sim);
    } catch (err) {
      console.error('[CombatSim] buildSimulation crashed — clearing stuck quest:', err);
      _sim = null;
      _simQuestId = null;
      // Prevent the quest from being permanently stuck
      Game.state.guild.activeQuest = null;
      return null;
    }
  }
  return _sim;
}

// ── Public API ──────────────────────────────────────────────────────────

// Get the battle outcome from the current simulation ('victory' or 'defeat' or null)
export function getBattleOutcome() {
  const aq = Game.state && Game.state.guild && Game.state.guild.activeQuest;
  if (aq && aq.battleMode === 'manual') ensureSim();
  return _sim ? _sim.battleOutcome : null;
}

// Helper: get the effective event interval (in seconds) for the current sim
function _getInterval() {
  return _sim ? _sim.effectiveInterval : EVENT_INTERVAL;
}

// Fast-forward interval for post-decisive events (DoTs, cleanup, resolve text).
// Once the fight is decided, burn through trailing events quickly so the UI doesn't drag.
const FAST_FORWARD_INTERVAL = 0.08;

// Shared dynamic-pacing visible count calculation.
// Events before decisiveIndex reveal at the normal interval; after, they accelerate.
function _computeVisibleCount(sim, aq) {
  if (!sim || !aq) return 0;
  const interval = sim.effectiveInterval || EVENT_INTERVAL;
  if (aq.battleMode === 'manual') {
    return Math.min(sim.totalEvents, Math.max(1, Math.floor(Game.questElapsedMs() / 1000 / interval) + 1));
  }
  const elapsedSec = (Date.now() - aq.startedAt) / 1000;
  const decisive = (sim.decisiveIndex != null) ? sim.decisiveIndex : sim.totalEvents - 1;

  // Time at which the decisive event is revealed (using normal pacing).
  const decisiveTime = (decisive + 1) * interval;

  if (elapsedSec <= decisiveTime) {
    return Math.min(sim.totalEvents, Math.max(1, Math.floor(elapsedSec / interval) + 1));
  }
  // Past the decisive moment — play trailing events at the fast-forward rate.
  const extraSec = elapsedSec - decisiveTime;
  const extraEvents = Math.floor(extraSec / FAST_FORWARD_INTERVAL);
  return Math.min(sim.totalEvents, decisive + 1 + extraEvents);
}

export function generateCombatLog() {
  const aq = Game.state.guild.activeQuest;
  if (!aq) { _sim = null; _simQuestId = null; return []; }

  const sim = ensureSim();
  if (!sim) return [];

  const visibleCount = _computeVisibleCount(sim, aq);
  return sim.events.slice(0, visibleCount);
}

// Get the HP snapshot at the current point in the battle
export function getCombatSnapshot() {
  const aq = Game.state.guild.activeQuest;
  if (!aq || !_sim) return null;

  const visibleCount = _computeVisibleCount(_sim, aq);
  return _sim.snapshots[visibleCount - 1] || null;
}

// Get sim info for game.js: { eventCount, intervalMs, decisiveIndex, fastForwardMs }
export function getSimInfo() {
  const sim = ensureSim();
  if (!sim) return null;
  return {
    eventCount: sim.totalEvents,
    intervalMs: sim.effectiveInterval * 1000,
    decisiveIndex: sim.decisiveIndex != null ? sim.decisiveIndex : sim.totalEvents - 1,
    fastForwardMs: FAST_FORWARD_INTERVAL * 1000,
    awaitingInput: !!sim.pending,
  };
}

// Get per-member combat stats from the simulation
export function getCombatStats() {
  const sim = ensureSim();
  if (!sim || !sim.combatStats) return null;
  return Object.values(sim.combatStats);
}

// Get the combat debug info (effective stats, bonuses, aura breakdown)
export function getCombatDebug() {
  const sim = ensureSim();
  return sim ? sim.combatDebug : null;
}

/** Set of skill IDs that are AoE (used by compendium to badge procs). */
export const AOE_SKILL_IDS = new Set(Object.keys(AOE_SKILLS));

// Get all simulation events (call before resetCombatLog to capture for export)
export function getSimEvents() {
  if (!_sim) return [];
  return _sim.events.map(e => ({
    text: e.text.replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
    type: e.type,
    icon: e.icon,
    phase: e.phase,
  }));
}

// ── Manual battle API ────────────────────────────────────────────────────
export function getPendingDecision() {
  const aq = Game.state.guild.activeQuest;
  if (!aq || aq.battleMode !== 'manual') return null;
  const sim = ensureSim();
  return sim && sim.pending ? sim.pending : null;
}
function _freezeManualClock(aq, sim) {
  // Called when the sim was waiting on the player: restart the playback clock
  // at the last revealed event so the next events play at normal pace instead
  // of fast-forwarding through the time spent deciding.
  const intervalMs = sim.effectiveInterval * 1000;
  aq.pausedMs = Math.max(0, Date.now() - aq.startedAt - Math.max(0, sim.totalEvents - 1) * intervalMs);
}
export function submitManualChoice(choice) {
  const aq = Game.state.guild.activeQuest;
  if (!aq || aq.battleMode !== 'manual') return { ok: false, reason: 'No manual battle in progress.' };
  const sim = ensureSim();
  if (!sim || !sim.pending) return { ok: false, reason: 'No one is waiting for orders.' };
  const pending = sim.pending;
  if (!choice || choice.index !== pending.index) return { ok: false, reason: 'That turn has already passed.' };
  if (Game.questEventsRevealed() < sim.totalEvents) return { ok: false, reason: 'Wait for the current action to finish.' };
  const opt = pending.options.find(o => o.id === choice.skillId);
  if (!opt) return { ok: false, reason: 'That move is not available.' };
  if (!opt.ready) return { ok: false, reason: `${opt.name} is on cooldown.` };
  let targetId = null;
  if (opt.kind === 'single') {
    const t = pending.enemies.find(e => e.id === choice.targetId);
    if (!t) return { ok: false, reason: 'Choose a valid target.' };
    targetId = t.id;
  }
  _freezeManualClock(aq, sim);
  aq.manualDecisions = (aq.manualDecisions || []).concat([{ skillId: opt.id, targetId }]);
  if (!ensureSim()) return { ok: false, reason: 'The battle could not continue.' };
  Game.save();
  return { ok: true };
}
export function autoResolveManualBattle() {
  const aq = Game.state.guild.activeQuest;
  if (!aq || aq.battleMode !== 'manual') return { ok: false, reason: 'No manual battle in progress.' };
  if (aq.manualAutoRest) return { ok: true };
  const sim = ensureSim();
  if (!sim) return { ok: false, reason: 'The battle could not continue.' };
  if (!sim.pending) return { ok: true };
  if (Game.questEventsRevealed() >= sim.totalEvents) _freezeManualClock(aq, sim);
  aq.manualAutoRest = true;
  if (!ensureSim()) return { ok: false, reason: 'The battle could not continue.' };
  Game.save();
  return { ok: true };
}
export function resetCombatLog() {
  _sim = null;
  _simQuestId = null;
}
