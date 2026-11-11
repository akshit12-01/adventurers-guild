import {
  RANK_ORDER, CLASSES, NAMES, EQUIPMENT, LOOT_ITEMS, QUESTS,
  getItem, getItemRarity, getClass, getQuest, computeBaseStats, randomName, getAvailableClasses,
  getRecruitCost, rankIndex, randInt, canClassEquip
} from './data.js';
import {
  getSkill, getUnlockedClassSkills, getUnlockedClassMasteries,
  getEquipmentSkill, getEquipmentSkills, getMemberActiveSkills, applyPassiveSkills, rollActiveSkills,
  collectPartyAuras, HERO_SPECS, getUnlockedSpecSkills, HERO_SPEC_REPLACED_SKILLS
} from './skills.js';
import {
  calculatePartyStrength, generateQuestBoard, shouldRefreshBoard,
  getQuestDifficultyTier, BOARD_REFRESH_MS
} from './questgen.js';
import { getCombatStats, getSimEvents, getBattleOutcome, getCombatDebug } from './ui/combatlog.js';
import {
  generateFloorQuest, calculateTowerLoot, getDefaultTowerState,
  isTowerUnlocked, isRestFloor, isBossFloor, TOWER_CONFIG
} from './tower.js';

const Game = (() => {

  const SAVE_KEY = 'adventurersGuild_v1';
  const RANK_THRESHOLDS = { F:1000, E:3000, D:7000, C:15000, B:35000, A:80000, S:200000, 'S+':500000, 'S++':null };
  const SHOP_REFRESH_MS = 10 * 60 * 1000;  // 10 minutes
  const SHOP_QUEST_REFRESH = 2; // refresh shop every N completed quests

  // ── Hero Spec Replacement Model (§3.1.1) ───────────────────────────────
  // Replacement list lives in skills/index.js so the UI can filter the
  // Class Skills table to match what the sim actually uses.
  function applyHeroSpecReplacement(member) {
    if (!member || member.class !== 'HERO' || !member.heroSpec) return;
    if (!Array.isArray(member.skills)) return;
    member.skills = member.skills.filter(id => !HERO_SPEC_REPLACED_SKILLS.includes(id));
  }

  // ── Progression Caps ──────────────────────────────────────────────────────
  // PLAYER_LEVEL_CAP — hard ceiling for member levels. Set just above the
  // L20 final-skill unlock to give 5 levels of "mastered" stat growth without
  // letting raw stats dwarf the §3.10 talent / mastery balance work.
  const PLAYER_LEVEL_CAP = 25;

  // LEGACY_LEVEL_CAP — hard ceiling for Guild Legacy levels. The value equals
  // the total talent point cost of every currently-designed talent so that a
  // completionist player can purchase everything exactly once. Breakdown:
  //   • Class talents: 9 classes × (1 + 2 + 3) = 54 pts
  //   • Party-wide:    2 + 2 + 2 + 3 + 3 + 4   = 16 pts
  //   • Total:                                  = 70 pts
  // Once the cap is reached, excess RP is discarded rather than silently
  // accumulating — no new talent points, no unbounded LEGACY_BONUSES growth.
  const LEGACY_LEVEL_CAP = 70;

  // ── Party Expansion ───────────────────────────────────────────────────────
  // Active slots (NOT including the Hero/player who is always present)
  // Default: 4 active members + Hero = 5 in combat
  // Expansion: 5 active members + Hero = 6 in combat (endgame unlock)
  const BASE_PARTY_SIZE = 4;      // default max active slots (Hero always present separately)
  const MAX_PARTY_SIZE = 5;       // ultimate max after expansion (base game)
  const MAX_PARTY_SIZE_TALENT = 6; // with Sixth Slot talent
  const PARTY_EXPANSION_COSTS = [500000]; // 500K gold for the 5th active slot

  function getMaxPartySize() {
    const expansions = state.partyExpansions || 0;
    const talentSlot = hasTalent('PARTY_SIXTH_SLOT') ? 1 : 0;
    const cap = MAX_PARTY_SIZE + talentSlot;
    return Math.min(BASE_PARTY_SIZE + expansions + talentSlot, cap);
  }

  function getPartyExpansionCost() {
    const expansions = state.partyExpansions || 0;
    if (expansions >= PARTY_EXPANSION_COSTS.length) return null; // maxed
    return PARTY_EXPANSION_COSTS[expansions];
  }

  function expandParty() {
    const expansions = state.partyExpansions || 0;
    if (expansions >= PARTY_EXPANSION_COSTS.length) return { ok: false, reason: 'Guild hall is already at maximum capacity!' };
    const cost = PARTY_EXPANSION_COSTS[expansions];
    if (state.gold < cost) return { ok: false, reason: `Need ${cost.toLocaleString()}g (have ${state.gold.toLocaleString()}g)` };
    state.gold -= cost;
    state.partyExpansions = expansions + 1;
    const newMax = getMaxPartySize();
    logEvent(`Guild hall expanded! Active party size increased to ${newMax}.`);
    return { ok: true, newMax };
  }

  // ── Default State ──────────────────────────────────────────────────────────

  function newGameState(playerName, playerClass) {
    return {
      version: 1,
      lastSaved: null,
      lastTick: Date.now(),
      gold: 200,
      guild: {
        rank: 'F',
        rankPoints: 0,
        completedQuests: [],   // quest IDs (repeats for repeat completions)
        activeQuest: null,     // { questId, startedAt, eventCount, partySnapshot, questData }
        eventLog: [],          // [{ text, time }]
      },
      player: {
        id: 'player',
        name: playerName,
        class: playerClass,
        level: 1, exp: 0,
        stats: computeStats(playerClass, 1),
        equipment: { weapon:null, armor:null, accessory:null, offhand:null },
        skills: getUnlockedClassSkills(playerClass, 1).map(s => s.id),
        questsCompleted: 0,
        heroSpec: null,       // 'vanguard' | 'champion' | 'warden' | null
      },
      party: [],          // recruited members
      activeSlots: [],    // member IDs currently "in party" (max determined by partyExpansions)
      inventory: [],      // [{ itemId, quantity }]
      shop: { stock: [], lastRefreshed: null, level: 0 },
      questBoard: { quests: {}, lastRefreshed: {}, seeds: {} }, // rank → generated quests
      questHistory: [],   // [{ quest, result, levelUps, timestamp }] — last 50
      partySynergy: {
        totalQuestsAsTeam: 0,   // quests completed with same active party
        lastPartyHash: null,    // hash of active party IDs to track changes
        bonusesUnlocked: [],    // synergy bonus IDs
        secretBossesFound: 0,
      },
      partyExpansions: 0,  // 0-3 purchased expansions (party size 4→7)
      autoRun: null,
      battleMode: 'auto',      // { strategy:'safe'|'balanced'|'push', remaining, total, rank } or null
      nextMemberId: 1,
      pendingResults: null,
      tower: getDefaultTowerState(), // Tower Climb game mode
      guildLegacy: { overflowRP: 0, level: 0, talents: [] }, // RP overflow & talent tree at S++
      tutorial: { step: 0, dismissed: false }, // Tutorial progression
    };
  }

  // ── Stat helpers ───────────────────────────────────────────────────────────

  function computeStats(classId, level) {
    return computeBaseStats(classId, level);
  }

  function effectiveStats(member, partyAuras) {
    const stats = { ...member.stats };
    // Capture HP ratio before any maxHp modifications so we can scale proportionally.
    // This prevents auras/passives from making health bars appear partially empty.
    const baseMaxHp = stats.maxHp || 100;
    const hpRatio = (stats.hp || baseMaxHp) / baseMaxHp;

    // 1) Apply equipment flat stat bonuses
    if (member.equipment) {
      for (const itemId of Object.values(member.equipment)) {
        if (!itemId) continue;
        const item = getItem(itemId);
        if (!item || !item.statBonus) continue;
        for (const [k, v] of Object.entries(item.statBonus)) {
          stats[k] = (stats[k] || 0) + v;
        }
      }
    }
    // 2) Handle percentage-based item statBonus keys (atkBonus, dodgeChance, healBonus)
    //    These were added as flat values above but are actually multipliers/percentages.
    if (stats.atkBonus) {
      stats.atk = Math.floor((stats.atk || 0) * (1 + stats.atkBonus));
    }
    // dodgeChance and healBonus are kept on stats for the combat sim to consume directly

    // 3) Apply individual passive skill bonuses (non-party bonuses from type:'passive' skills)
    applyPassiveSkills(stats, member);

    // 4) Apply party-wide aura bonuses (from passive skills of all active party members)
    if (partyAuras) {
      if (partyAuras.atk)   stats.atk   = Math.floor((stats.atk || 0) * (1 + partyAuras.atk));
      if (partyAuras.def)   stats.def   = Math.floor((stats.def || 0) * (1 + partyAuras.def));
      if (partyAuras.mag)   stats.mag   = Math.floor((stats.mag || 0) * (1 + partyAuras.mag));
      if (partyAuras.spd)   stats.spd   = Math.floor((stats.spd || 0) * (1 + partyAuras.spd));
      if (partyAuras.crit)  stats.crit  = Math.floor((stats.crit || 0) * (1 + partyAuras.crit));
      if (partyAuras.dodge) stats.dodge = Math.floor((stats.dodge || 0) * (1 + partyAuras.dodge));
      if (partyAuras.maxHp) {
        stats.maxHp = Math.floor((stats.maxHp || 100) * (1 + partyAuras.maxHp));
      }
    }

    // 5) Scale current HP proportionally to the final maxHp.
    //    A member at full health stays at full health; a member at 50% stays at 50%.
    stats.hp = Math.min(Math.round(hpRatio * stats.maxHp), stats.maxHp);

    return stats;
  }

  function memberPower(member) {
    const s = effectiveStats(member);
    return (s.atk * 2) + s.def + s.spd + Math.floor((s.maxHp || 50) / 10) + (s.mag * 1.5) + (s.crit || 0) + Math.floor((s.dodge || 0) * 0.5);
  }

  function expToNext(level) {
    return Math.floor(100 * Math.pow(level, 1.5));
  }

  // ── Save / Load ────────────────────────────────────────────────────────────

  function save() {
    if (!state) return;
    state.lastSaved = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch(e) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) return false;
      state = parsed;

      // Migration: cap partyExpansions to new max (1 expansion available)
      if ((state.partyExpansions || 0) > PARTY_EXPANSION_COSTS.length) {
        state.partyExpansions = PARTY_EXPANSION_COSTS.length;
      }
      // Migration: trim active slots to current max party size
      const maxSlots = getMaxPartySize();
      if (state.activeSlots && state.activeSlots.length > maxSlots) {
        state.activeSlots = state.activeSlots.slice(0, maxSlots);
      }

      // Deduplicate skills on all members (cleans up any prior migration damage)
      const dedupeSkills = (member) => {
        if (!member || !member.skills) return;
        member.skills = [...new Set(member.skills)];
      };
      dedupeSkills(state.player);
      if (state.party) state.party.forEach(m => dedupeSkills(m));

      // Class rework migration — strip skill IDs that have been retired from
      // class progression (Monk: KI_BARRIER / INNER_FOCUS / COUNTER_STANCE,
      // Necromancer: DARK_PACT). These definitions still exist in SKILLS as
      // source:'legacy' so any stale references resolve, but they must be
      // removed from per-member skill lists so reconcile picks up the new
      // replacement skills without duplication.
      const RETIRED_CLASS_SKILL_IDS = new Set([
        'KI_BARRIER', 'INNER_FOCUS', 'COUNTER_STANCE', 'DARK_PACT',
      ]);
      const stripRetiredSkills = (member) => {
        if (!member || !member.skills) return;
        member.skills = member.skills.filter(id => !RETIRED_CLASS_SKILL_IDS.has(id));
      };
      stripRetiredSkills(state.player);
      if (state.party) state.party.forEach(m => stripRetiredSkills(m));

      // Strip any skill IDs that no longer resolve to a definition. Equipment
      // proc refactors occasionally delete/rename skills (e.g. ETERNAL_WARD →
      // CELESTIAL_WARD); without this pass, save data carries the dead ID
      // forever and it renders as a bare UPPERCASE string in the UI.
      const stripDeadSkills = (member) => {
        if (!member || !member.skills) return;
        member.skills = member.skills.filter(id => getSkill(id) != null);
      };
      stripDeadSkills(state.player);
      if (state.party) state.party.forEach(m => stripDeadSkills(m));

      // Reconcile equipment-granted skills — if an equipped item's grantedSkill
      // was renamed or rebound (see equipment refactors), make sure the new
      // skill ID shows up in the member's skill list without requiring a
      // re-equip. Walks every equipment slot and adds any missing grants.
      const reconcileEquipmentSkills = (member) => {
        if (!member || !member.equipment) return;
        if (!member.skills) member.skills = [];
        for (const slot of Object.keys(member.equipment)) {
          const itemId = member.equipment[slot];
          if (!itemId) continue;
          const item = getItem(itemId);
          if (!item) continue;
          const grants = [].concat(item.grantedSkill || [], item.grantedSkills || []);
          for (const sk of grants) {
            if (sk && getSkill(sk) && !member.skills.includes(sk)) {
              member.skills.push(sk);
            }
          }
        }
      };
      reconcileEquipmentSkills(state.player);
      if (state.party) state.party.forEach(m => reconcileEquipmentSkills(m));

      // Reconcile class skills — ensure every member has all class skills they
      // should have at their current level. Covers newly added skills (e.g.
      // level-1 starters) without requiring a level-up trigger.
      const reconcileClassSkills = (member) => {
        if (!member || !member.class) return;
        if (!member.skills) member.skills = [];
        // Strip legacy/retired skills from save (source: 'legacy' or type: 'legacy')
        member.skills = member.skills.filter(id => {
          const sk = getSkill(id);
          if (!sk) return true; // unknown — leave alone (might be equipment)
          return sk.source !== 'legacy' && sk.type !== 'legacy';
        });
        const shouldHave = getUnlockedClassSkills(member.class, member.level || 1);
        for (const sk of shouldHave) {
          if (!member.skills.includes(sk.id)) member.skills.push(sk.id);
        }
        const shouldHaveMasteries = getUnlockedClassMasteries(member.class, member.level || 1);
        for (const sk of shouldHaveMasteries) {
          if (!member.skills.includes(sk.id)) member.skills.push(sk.id);
        }
        // Hero spec replacement: strip baseline L10/14/18 if specced (§3.1.1)
        applyHeroSpecReplacement(member);
        // Also grant any spec skills the Hero should have at current level
        if (member.class === 'HERO' && member.heroSpec) {
          const specUnlocks = getUnlockedSpecSkills(member.heroSpec, member.level || 1);
          for (const sk of specUnlocks) {
            if (!member.skills.includes(sk.id)) member.skills.push(sk.id);
          }
        }
      };
      reconcileClassSkills(state.player);
      if (state.party) state.party.forEach(m => reconcileClassSkills(m));

      // Migration: add tower state if missing
      if (!state.tower) state.tower = getDefaultTowerState();
      // Migration: add guild legacy if missing
      if (!state.guildLegacy) state.guildLegacy = { overflowRP: 0, level: 0, talents: [] };
      if (!state.guildLegacy.talents) state.guildLegacy.talents = [];
      // Migration: clamp legacy level to current cap (cap was lowered from 72→70 in v=154)
      if (state.guildLegacy.level > LEGACY_LEVEL_CAP) {
        state.guildLegacy.level = LEGACY_LEVEL_CAP;
        state.guildLegacy.overflowRP = 0;
      }
      // Migration: clear stuck active quest whose sim never built.
      // eventCount starts at 0 and is set by the UI after buildSimulation(),
      // so we only wipe quests older than 60s with eventCount still at 0 —
      // that means the sim definitely failed, not that it just hasn't run yet.
      if (state.guild.activeQuest && !state.guild.activeQuest.eventCount
          && state.guild.activeQuest.startedAt < Date.now() - 60000) {
        state.guild.activeQuest = null;
      }
      // Migration: add tutorial state if missing (mark as dismissed for existing saves)
      if (state.battleMode !== 'manual') state.battleMode = 'auto';
      if (!state.tutorial) state.tutorial = { step: 0, dismissed: true };

      return true;
    } catch(e) { return false; }
  }

  function hasSave() {
    return !!localStorage.getItem(SAVE_KEY);
  }

  function deleteSave() {
    localStorage.removeItem(SAVE_KEY);
    state = null;
  }

  function exportSave() {
    if (!state) return null;
    save(); // ensure latest state is captured
    const data = JSON.stringify(state);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const guildName = state.guild?.name || 'adventurers-guild';
    const date = new Date().toISOString().slice(0, 10);
    a.download = `${guildName.replace(/[^a-zA-Z0-9]/g, '_')}_${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { ok: true };
  }

  function importSave(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      // Basic structure validation
      if (!parsed.version || !parsed.guild || !parsed.party) {
        return { ok: false, reason: 'Invalid save file — missing required data' };
      }
      // Reject saves from a newer game version (can't migrate forward)
      if (parsed.version > 1) {
        return { ok: false, reason: `Save is from a newer game version (v${parsed.version}). Update the game first.` };
      }
      // Back up current save before overwriting
      const backup = localStorage.getItem(SAVE_KEY);
      // Store imported data and reload through normal load() path for migrations
      localStorage.setItem(SAVE_KEY, jsonString);
      const success = load();
      if (!success) {
        // Restore backup if import failed
        if (backup) localStorage.setItem(SAVE_KEY, backup);
        else localStorage.removeItem(SAVE_KEY);
        return { ok: false, reason: 'Save file failed validation' };
      }
      save(); // persist any migrations applied by load()
      return { ok: true, guildName: state.guild?.name, guildRank: state.guild?.rank };
    } catch (e) {
      return { ok: false, reason: 'Could not parse save file — is it valid JSON?' };
    }
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  function logEvent(text) {
    state.guild.eventLog.unshift({ text, time: Date.now() });
    if (state.guild.eventLog.length > 20) state.guild.eventLog.pop();
  }

  // ── Guild Legacy ─────────────────────────────────────────────────────────
  // At max rank (S++), excess RP overflow into the legacy system.
  // Every LEGACY_RP_PER_LEVEL RP earned grants a Legacy Level with stacking bonuses.
  const LEGACY_RP_PER_LEVEL = 50000;
  const LEGACY_BONUSES = {
    goldBonus:      0.02,   // +2% gold per level
    itemFind:       0.01,   // +1% item find per level
    celestialBonus: 0.005,  // +0.5% celestial drop chance per level
    expBonus:       0.01,   // +1% exp per level
  };

  function addRankPoints(points) {
    if (!points) return null;
    // LEGACY_LEVEL_CAP: once the Guild Legacy is at the talent-point ceiling
    // AND the guild rank is already S++ (max rank), drop the incoming RP on
    // the floor. We still accept RP if there's rank progress left, because
    // the cap only affects overflow into the Legacy track — regular ranks
    // up through S++ are untouched.
    const legacyAtCap = (state.guildLegacy?.level || 0) >= LEGACY_LEVEL_CAP;
    const ri0 = rankIndex(state.guild.rank);
    const atMaxRank = ri0 >= RANK_ORDER.length - 1 && RANK_THRESHOLDS[state.guild.rank] === null;
    if (legacyAtCap && atMaxRank) {
      return null; // No new points accepted — player is fully capped.
    }
    state.guild.rankPoints += points;
    let oldRank = null;
    let newRank = null;
    let ri = rankIndex(state.guild.rank);
    while (ri < RANK_ORDER.length - 1) {
      const threshold = RANK_THRESHOLDS[state.guild.rank];
      if (threshold && state.guild.rankPoints >= threshold) {
        if (!oldRank) oldRank = state.guild.rank;
        state.guild.rankPoints -= threshold;
        ri++;
        state.guild.rank = RANK_ORDER[ri];
        newRank = state.guild.rank;
        logEvent(`Guild rank advanced to ${state.guild.rank} Rank!`);
      } else break;
    }

    // At max rank, overflow RP into Guild Legacy
    if (ri >= RANK_ORDER.length - 1 && RANK_THRESHOLDS[state.guild.rank] === null) {
      if (!state.guildLegacy) state.guildLegacy = { overflowRP: 0, level: 0 };
      state.guildLegacy.overflowRP += state.guild.rankPoints;
      state.guild.rankPoints = 0; // All RP flows into legacy
      const oldLevel = state.guildLegacy.level;
      while (state.guildLegacy.level < LEGACY_LEVEL_CAP && state.guildLegacy.overflowRP >= LEGACY_RP_PER_LEVEL) {
        state.guildLegacy.overflowRP -= LEGACY_RP_PER_LEVEL;
        state.guildLegacy.level++;
        logEvent(`Guild Legacy advanced to Level ${state.guildLegacy.level}!`);
        if (state.guildLegacy.level >= LEGACY_LEVEL_CAP) {
          logEvent(`Guild Legacy has reached its MAX level of ${LEGACY_LEVEL_CAP}!`);
        }
      }
      // Cap hit mid-award — discard any leftover overflow RP so the bar
      // reads 0/50000 and future quests don't silently bank into a pool
      // that will never convert to a level.
      if (state.guildLegacy.level >= LEGACY_LEVEL_CAP) {
        state.guildLegacy.overflowRP = 0;
      }
    }

    return oldRank && newRank ? { from: oldRank, to: newRank } : null;
  }

  function getLegacyBonuses() {
    const lvl = state.guildLegacy?.level || 0;
    return {
      goldBonus:      lvl * LEGACY_BONUSES.goldBonus,
      itemFind:       lvl * LEGACY_BONUSES.itemFind,
      celestialBonus: lvl * LEGACY_BONUSES.celestialBonus,
      expBonus:       lvl * LEGACY_BONUSES.expBonus,
      level:          lvl,
    };
  }

  // ── Legacy Talents ──────────────────────────────────────────────────────
  // Each Legacy level grants 1 talent point. Talents are class-augmentation upgrades
  // organized in 3 tiers. Class talents enhance specific abilities; party talents
  // provide broad bonuses.
  const LEGACY_TALENTS = {
    // ── HERO (HRO) ──
    HRO_CHAIN_STRIKE:   { id: 'HRO_CHAIN_STRIKE',   tier: 1, cost: 1, reqLevel: 1, classId: 'HERO',        label: 'Chain Strike',       icon: '⚔', desc: 'Heroic Strike chains to a 2nd target at 50% damage.' },
    HRO_RALLYING_HEAL:  { id: 'HRO_RALLYING_HEAL',  tier: 2, cost: 2, reqLevel: 3, classId: 'HERO',        label: 'Rallying Heal',      icon: '📣', desc: 'Rally Cry also applies a heal-over-time (5% max HP/round, 2 rounds) to all allies.' },
    HRO_WHIRLWIND_HEAL: { id: 'HRO_WHIRLWIND_HEAL', tier: 3, cost: 3, reqLevel: 6, classId: 'HERO',        label: 'Whirlwind Heal',     icon: '🌀', desc: 'Hero AoE skills (Sword Dance / Whirlwind Dance) heal the party for 6% max HP per enemy struck.' },

    // ── KNIGHT (KNT) ──
    KNT_DEF_SHRED:      { id: 'KNT_DEF_SHRED',      tier: 1, cost: 1, reqLevel: 1, classId: 'KNIGHT',     label: 'Armor Rend',         icon: '🛡', desc: 'Shield Charge hits shred the target\'s armor — they take +15% damage for 2 rounds.' },
    KNT_COUNTER:        { id: 'KNT_COUNTER',         tier: 2, cost: 2, reqLevel: 3, classId: 'KNIGHT',     label: 'Stalwart Counter',   icon: '⚔', desc: 'Bulwark counterattacks for 50% of the intercepted damage.' },
    KNT_TAUNT_AURA:     { id: 'KNT_TAUNT_AURA',     tier: 3, cost: 3, reqLevel: 6, classId: 'KNIGHT',     label: 'Oppressive Presence',icon: '😤', desc: 'Taunted enemies take +10% damage from all sources for 2 rounds.' },

    // ── MAGE (MAG) ──
    MAG_BLIZZARD_FROST: { id: 'MAG_BLIZZARD_FROST', tier: 1, cost: 1, reqLevel: 1, classId: 'MAGE',       label: 'Frostbite',          icon: '❄', desc: 'Blizzard has a 60% chance to chill all enemies — they suffer Frostbite (-15% ATK, 20% fumble) for 2 rounds.' },
    MAG_METEOR_BURN:    { id: 'MAG_METEOR_BURN',    tier: 2, cost: 2, reqLevel: 3, classId: 'MAGE',       label: 'Lingering Flames',   icon: '🔥', desc: 'Meteor Storm leaves a burn DoT (15% MAG per round, 3 rounds) on all targets.' },
    MAG_ARCANE_REFLECT: { id: 'MAG_ARCANE_REFLECT', tier: 3, cost: 3, reqLevel: 6, classId: 'MAGE',       label: 'Arcane Reflection',  icon: '💜', desc: 'Mages reflect 20% of damage taken back at attackers. Phase Shift grants +25% spell damage for 2 rounds upon returning.' },

    // ── ROGUE (ROG) ──
    ROG_POISON:         { id: 'ROG_POISON',           tier: 1, cost: 1, reqLevel: 1, classId: 'ROGUE',      label: 'Venomous Blades',    icon: '🗡', desc: 'Shadow Strike has a 30% chance to poison the target (7% max HP/round, 3 rounds). Poisoned enemies also deal -15% damage.' },
    ROG_SMOKE_HEAL:     { id: 'ROG_SMOKE_HEAL',       tier: 2, cost: 2, reqLevel: 3, classId: 'ROGUE',      label: 'Healing Smoke',      icon: '💨', desc: 'Smoke Bomb also heals the entire party for 8% max HP.' },
    ROG_EXECUTE:        { id: 'ROG_EXECUTE',           tier: 3, cost: 3, reqLevel: 6, classId: 'ROGUE',      label: 'Executioner',        icon: '☠', desc: 'Assassinate always crits against enemies below 25% HP.' },

    // ── CLERIC (CLR) ──
    CLR_SHIELD_HOT:     { id: 'CLR_SHIELD_HOT',       tier: 1, cost: 1, reqLevel: 1, classId: 'CLERIC',     label: 'Sacred Warmth',      icon: '💚', desc: 'Divine Shield also applies a HoT (5% max HP/round, 3 rounds) to all allies.' },
    CLR_SMITE_BURN:     { id: 'CLR_SMITE_BURN',       tier: 2, cost: 2, reqLevel: 3, classId: 'CLERIC',     label: 'Righteous Burn',     icon: '🔥', desc: 'Smite also applies a burning DoT (40% MAG per round, 3 rounds) to its target.' },
    CLR_WRATH:          { id: 'CLR_WRATH',             tier: 3, cost: 3, reqLevel: 6, classId: 'CLERIC',     label: 'Righteous Wrath',    icon: '⚡', desc: 'Divine Intervention grants the saved ally +30% damage for 2 rounds.' },

    // ── RANGER (RNG) ──
    RNG_VOLLEY_SLOW:    { id: 'RNG_VOLLEY_SLOW',      tier: 1, cost: 1, reqLevel: 1, classId: 'RANGER',     label: 'Suppressing Fire',   icon: '🎯', desc: 'Volley hits reduce enemy ATK by 20% for 1 round.' },
    RNG_SHARED_CAMO:    { id: 'RNG_SHARED_CAMO',      tier: 2, cost: 2, reqLevel: 3, classId: 'RANGER',     label: 'Shared Camouflage',  icon: '🌿', desc: 'Camouflage extends to the lowest-HP ally, granting them +20% dodge for 2 rounds.' },
    RNG_STORM_MARK:     { id: 'RNG_STORM_MARK',       tier: 3, cost: 3, reqLevel: 6, classId: 'RANGER',     label: 'Storm Mark',         icon: '🌧', desc: 'Arrow Storm marks all surviving enemies — they take +15% damage from all sources for 2 rounds.' },

    // ── BARD (BRD) ──
    BRD_DISCORD_DMG:    { id: 'BRD_DISCORD_DMG',      tier: 1, cost: 1, reqLevel: 1, classId: 'BARD',       label: 'Lingering Discord',  icon: '🎵', desc: 'Discord\'s duration is extended by 1 round (3 → 4).' },
    BRD_CRESCENDO_ALLY: { id: 'BRD_CRESCENDO_ALLY',   tier: 2, cost: 2, reqLevel: 3, classId: 'BARD',       label: 'Grand Crescendo',    icon: '🎶', desc: 'Crescendo\'s guaranteed crit also applies to the next 2 ally attacks.' },
    BRD_SYMPHONY_LEECH: { id: 'BRD_SYMPHONY_LEECH',   tier: 3, cost: 3, reqLevel: 6, classId: 'BARD',       label: 'Vampiric Symphony',  icon: '🎻', desc: 'Symphony of War grants +10% lifesteal to the entire party.' },

    // ── MONK (MNK) ──
    MNK_KI_BOOST:       { id: 'MNK_KI_BOOST',         tier: 1, cost: 1, reqLevel: 1, classId: 'MONK',       label: 'Ki Barrier Resurgence', icon: '🔵', desc: 'Pressure Point grants the Monk a Ki Shield equal to 10% of their max HP, absorbing incoming damage.' },
    MNK_COUNTER_ATK:    { id: 'MNK_COUNTER_ATK',       tier: 2, cost: 2, reqLevel: 3, classId: 'MONK',       label: 'Iron Stance',        icon: '🛡', desc: 'When Flowing Strike counters on dodge, the Monk also gains +20% DEF and +15% dodge for 2 rounds.' },
    MNK_FURY_PLUS:      { id: 'MNK_FURY_PLUS',         tier: 3, cost: 3, reqLevel: 6, classId: 'MONK',       label: 'Infinite Fists',     icon: '💥', desc: 'Fists of Fury gains +1 hit, and each hit can independently crit.' },

    // ── NECROMANCER (NEC) ──
    NEC_GRAVE_HUNGER:   { id: 'NEC_GRAVE_HUNGER',      tier: 1, cost: 1, reqLevel: 1, classId: 'NECROMANCER',label: 'Grave Hunger',       icon: '🩸', desc: 'Shroud of Decay grows stronger as enemies fall. Each kill grants +2% party damage, +1% party crit, and +1% party DEF (max 5 stacks). Combat starts with 1 stack already active.' },
    NEC_NECRO_CLEAVE:   { id: 'NEC_NECRO_CLEAVE',      tier: 2, cost: 2, reqLevel: 3, classId: 'NECROMANCER',label: 'Undead Guardian',     icon: '🛡', desc: 'Raised thralls gain a 25% chance to intercept attacks aimed at any party member, absorbing the damage. The thrall takes full damage from the intercepted hit.' },
    NEC_SUMMON_SHIELD:  { id: 'NEC_SUMMON_SHIELD',     tier: 3, cost: 3, reqLevel: 6, classId: 'NECROMANCER',label: 'Undead Vanguard',    icon: '🪦', desc: 'Army of the Damned duration is extended by 1 round (3 → 4).' },

    // ── PARTY-WIDE ──
    PARTY_CEL_RESONANCE: { id: 'PARTY_CEL_RESONANCE',  tier: 2, cost: 2, reqLevel: 3, classId: null, label: 'Celestial Resonance', icon: '✦', desc: 'Celestial equipment grants +10% to all stats.' },
    PARTY_CEL_CASCADE:   { id: 'PARTY_CEL_CASCADE',    tier: 2, cost: 2, reqLevel: 3, classId: null, label: 'Celestial Cascade',   icon: '💫', desc: 'When a celestial weapon deals damage (proc or echo), 25% chance the impact cascades — dealing 50% of the hit as AoE to all other enemies.' },
    PARTY_SIEGE:         { id: 'PARTY_SIEGE',           tier: 2, cost: 2, reqLevel: 3, classId: null, label: 'Siege Breaker',       icon: '🔥', desc: '+25% damage against bosses and raid bosses.' },
    PARTY_SIXTH_SLOT:    { id: 'PARTY_SIXTH_SLOT',      tier: 3, cost: 3, reqLevel: 6, classId: null, label: 'Sixth Party Slot',    icon: '👥', desc: 'Unlock a 6th active party member slot.' },
    PARTY_UNDYING:       { id: 'PARTY_UNDYING',          tier: 3, cost: 3, reqLevel: 6, classId: null, label: 'Undying Oath',        icon: '🔄', desc: 'Once per quest, a KO\'d party member auto-revives at 15% HP.' },
    PARTY_CEL_ECHO:      { id: 'PARTY_CEL_ECHO',         tier: 4, cost: 4, reqLevel: 10, classId: null, label: 'Celestial Echo',      icon: '🌟', desc: 'When a celestial weapon proc fires, there is a 5% chance all other celestial weapons in the party echo in harmony, triggering their damage effects simultaneously.' },
  };

  function getLegacyTalentPoints() {
    const lvl = state.guildLegacy?.level || 0;
    const spent = (state.guildLegacy?.talents || []).reduce((s, tid) => s + (LEGACY_TALENTS[tid]?.cost || 0), 0);
    return { total: lvl, spent, available: lvl - spent };
  }

  function canPurchaseTalent(talentId) {
    const t = LEGACY_TALENTS[talentId];
    if (!t) return { ok: false, reason: 'Unknown talent.' };
    const lvl = state.guildLegacy?.level || 0;
    if (lvl < t.reqLevel) return { ok: false, reason: `Requires Legacy Level ${t.reqLevel}.` };
    const { available } = getLegacyTalentPoints();
    if (available < t.cost) return { ok: false, reason: `Need ${t.cost} talent points (${available} available).` };
    if ((state.guildLegacy?.talents || []).includes(talentId)) return { ok: false, reason: 'Already purchased.' };
    return { ok: true };
  }

  function purchaseTalent(talentId) {
    const check = canPurchaseTalent(talentId);
    if (!check.ok) return check;
    if (!state.guildLegacy.talents) state.guildLegacy.talents = [];
    state.guildLegacy.talents.push(talentId);
    logEvent(`Talent unlocked: ${LEGACY_TALENTS[talentId].label}!`);
    save();
    return { ok: true };
  }

  function hasTalent(talentId) {
    return (state.guildLegacy?.talents || []).includes(talentId);
  }

  function resetTalents() {
    if (!state.guildLegacy) return;
    state.guildLegacy.talents = [];
    logEvent('All talents have been reset.');
    save();
  }

  function addExp(memberId, amount) {
    const member = memberId === 'player' ? state.player : state.party.find(m => m.id === memberId);
    if (!member) return { levelUps: [], skillGains: [] };
    // PLAYER_LEVEL_CAP: once a member is at the cap, all further EXP is
    // discarded. We zero out the progress bar so the UI doesn't show a
    // creeping overflow and there's no "banked" EXP that would suddenly
    // fire on a future cap raise (which would produce a surprise flood
    // of level-up popups from a dozen post-cap quests).
    if (member.level >= PLAYER_LEVEL_CAP) {
      member.exp = 0;
      return { levelUps: [], skillGains: [] };
    }
    member.exp += amount;
    const levelUps = [];
    const skillGains = [];
    while (member.level < PLAYER_LEVEL_CAP && member.exp >= expToNext(member.level)) {
      member.exp -= expToNext(member.level);
      member.level++;
      const newStats = computeStats(member.class, member.level);
      const hpGain = newStats.maxHp - member.stats.maxHp;
      for (const [k, v] of Object.entries(newStats)) {
        if (k !== 'hp') member.stats[k] = v;
      }
      member.stats.hp = Math.min(member.stats.maxHp, member.stats.hp + Math.max(0, hpGain));
      // Check for new class skill unlocks
      const newSkill = getUnlockedClassSkills(member.class, member.level).find(s => !member.skills.includes(s.id));
      // Specced Heroes skip baseline L10/14/18 class skills — specs replace them (§3.1.1)
      const skipBaseline = newSkill && member.class === 'HERO' && member.heroSpec && HERO_SPEC_REPLACED_SKILLS.includes(newSkill.id);
      if (newSkill && !skipBaseline && !member.skills.includes(newSkill.id)) {
        member.skills.push(newSkill.id);
        logEvent(`${member.name} learned skill: ${newSkill.name}!`);
        skillGains.push({ memberName: member.name, skillName: newSkill.name, skillIcon: newSkill.icon || '⚡', type: 'skill' });
      }
      // Check for new mastery unlocks
      const newMastery = getUnlockedClassMasteries(member.class, member.level).find(s => !member.skills.includes(s.id));
      if (newMastery && !member.skills.includes(newMastery.id)) {
        member.skills.push(newMastery.id);
        logEvent(`${member.name} gained mastery: ${newMastery.name}!`);
        skillGains.push({ memberName: member.name, skillName: newMastery.name, skillIcon: newMastery.icon || '🔶', type: 'mastery' });
      }
      // Check for new specialization skill unlocks (Hero only)
      if (member.class === 'HERO' && member.heroSpec) {
        const newSpec = getUnlockedSpecSkills(member.heroSpec, member.level).find(s => !member.skills.includes(s.id));
        if (newSpec && !member.skills.includes(newSpec.id)) {
          member.skills.push(newSpec.id);
          logEvent(`${member.name} learned spec skill: ${newSpec.name}!`);
          skillGains.push({ memberName: member.name, skillName: newSpec.name, skillIcon: newSpec.icon || '⚔', type: 'spec' });
        }
      }
      levelUps.push({ name: member.name, level: member.level });
    }
    // If we stopped because the member hit the cap mid-gain, zero any
    // leftover EXP so the progress bar reads 0/MAX instead of e.g. 1843/1420.
    if (member.level >= PLAYER_LEVEL_CAP) member.exp = 0;
    return { levelUps, skillGains };
  }

  function addToInventory(itemId, qty = 1) {
    const entry = state.inventory.find(e => e.itemId === itemId);
    if (entry) entry.quantity += qty;
    else state.inventory.push({ itemId, quantity: qty });
  }

  function removeFromInventory(itemId, qty = 1) {
    const idx = state.inventory.findIndex(e => e.itemId === itemId);
    if (idx === -1) return false;
    if (state.inventory[idx].quantity < qty) return false;
    state.inventory[idx].quantity -= qty;
    if (state.inventory[idx].quantity === 0) state.inventory.splice(idx, 1);
    return true;
  }

  function healTick(secondsElapsed) {
    // Don't heal while the results modal is showing
    if (state.pendingResults) return;

    const onQuestIds = new Set();
    if (state.guild.activeQuest) {
      for (const snap of state.guild.activeQuest.partySnapshot) onQuestIds.add(snap.id);
    }
    // Recover fully in ~45-60 seconds (120%/min). Always heal at least 1 HP, round up.
    // Use effectiveStats so equipment maxHp bonuses (e.g. shields) are included.
    const healPct = (120 / 60) * secondsElapsed / 100;
    const heal = (m) => {
      if (onQuestIds.has(m.id)) return;
      const eff = effectiveStats(m);
      if (m.stats.hp < eff.maxHp) {
        const amount = Math.max(1, Math.ceil(eff.maxHp * healPct));
        m.stats.hp = Math.min(eff.maxHp, m.stats.hp + amount);
      }
    };
    heal(state.player);
    state.party.forEach(heal);
  }

  // ── Party ──────────────────────────────────────────────────────────────────

  function recruitMember(classId) {
    const cls = getClass(classId);
    if (!cls.recruitCost) return { ok:false, reason:'Cannot recruit this class' };
    if (state.party.length >= 8) return { ok:false, reason:'Roster full (max 8 members)' };
    const cost = getRecruitCost(state.party.length);
    if (state.gold < cost) return { ok:false, reason:`Need ${cost}g (have ${state.gold}g)` };

    state.gold -= cost;
    const stats = computeStats(classId, 1);
    // +/- 10% variance on stats
    for (const k of Object.keys(stats)) {
      if (k === 'hp') continue;
      stats[k] = Math.max(1, Math.round(stats[k] * (1 + (Math.random() * 0.2 - 0.1))));
    }
    stats.hp = stats.maxHp;

    // Grant any class skills unlocked at level 1 (starter skill every class has)
    const starterSkills = getUnlockedClassSkills(classId, 1).map(s => s.id);
    const member = {
      id: `m${state.nextMemberId++}`,
      name: randomName(classId, state.party),
      class: classId,
      level: 1, exp: 0,
      stats,
      equipment: { weapon:null, armor:null, accessory:null, offhand:null },
      skills: starterSkills,
      questsCompleted: 0,
    };
    state.party.push(member);
    logEvent(`${member.name} the ${cls.label} has joined!`);
    return { ok:true, member };
  }

  function dismissMember(memberId) {
    const idx = state.party.findIndex(m => m.id === memberId);
    if (idx === -1) return { ok:false, reason:'Member not found' };
    if (state.guild.activeQuest) return { ok:false, reason:'Cannot dismiss while party is on a quest' };
    state.activeSlots = state.activeSlots.filter(id => id !== memberId);
    state.party.splice(idx, 1);
    return { ok:true };
  }

  function setActive(memberId, active) {
    if (active) {
      if (state.activeSlots.includes(memberId)) return { ok:false, reason:'Already active' };
      const maxSize = getMaxPartySize();
      if (state.activeSlots.length >= maxSize) return { ok:false, reason:`Active party full (max ${maxSize})` };
      if (!state.party.find(m => m.id === memberId)) return { ok:false, reason:'Member not found' };
      state.activeSlots.push(memberId);
    } else {
      state.activeSlots = state.activeSlots.filter(id => id !== memberId);
    }
    return { ok:true };
  }

  // ── Hero Specialization ─────────────────────────────────────────────────

  function setHeroSpec(memberId, specTrack) {
    const member = memberId === 'player' ? state.player : state.party.find(m => m.id === memberId);
    if (!member) return { ok: false, reason: 'Member not found' };
    if (member.class !== 'HERO') return { ok: false, reason: 'Only Heroes can specialize' };
    if (member.level < 10) return { ok: false, reason: 'Must be level 10 to specialize' };
    if (member.heroSpec) return { ok: false, reason: 'Already specialized. Use respec to change.' };
    if (!HERO_SPECS[specTrack]) return { ok: false, reason: 'Invalid specialization track' };

    member.heroSpec = specTrack;
    // Grant any spec skills already unlocked at current level
    const specSkills = getUnlockedSpecSkills(specTrack, member.level);
    for (const sk of specSkills) {
      if (!member.skills.includes(sk.id)) {
        member.skills.push(sk.id);
        logEvent(`${member.name} learned spec skill: ${sk.name}!`);
      }
    }
    // Strip baseline L10/14/18 Hero skills — specs REPLACE them (§3.1.1)
    applyHeroSpecReplacement(member);
    save();
    return { ok: true, spec: HERO_SPECS[specTrack] };
  }

  function respecHeroSpec(memberId, newSpecTrack) {
    const member = memberId === 'player' ? state.player : state.party.find(m => m.id === memberId);
    if (!member) return { ok: false, reason: 'Member not found' };
    if (member.class !== 'HERO') return { ok: false, reason: 'Only Heroes can specialize' };
    if (!member.heroSpec) return { ok: false, reason: 'No specialization to reset' };
    if (newSpecTrack && !HERO_SPECS[newSpecTrack]) return { ok: false, reason: 'Invalid specialization track' };
    if (newSpecTrack === member.heroSpec) return { ok: false, reason: 'Already on that track' };

    // Respec is free for Heroes — encourages experimenting with specs.
    const cost = 0;

    // Remove old spec skills
    const oldSpec = HERO_SPECS[member.heroSpec];
    if (oldSpec) {
      member.skills = member.skills.filter(id => !oldSpec.skills.includes(id));
    }

    member.heroSpec = newSpecTrack || null;

    // Grant new spec skills if switching to a new track
    if (newSpecTrack) {
      const specSkills = getUnlockedSpecSkills(newSpecTrack, member.level);
      for (const sk of specSkills) {
        if (!member.skills.includes(sk.id)) {
          member.skills.push(sk.id);
          logEvent(`${member.name} learned spec skill: ${sk.name}!`);
        }
      }
      // Strip baseline L10/14/18 Hero skills — specs REPLACE them (§3.1.1)
      applyHeroSpecReplacement(member);
    } else {
      // Clearing spec — re-grant baseline L10/14/18 class skills the hero earned
      const baseline = getUnlockedClassSkills(member.class, member.level || 1);
      for (const sk of baseline) {
        if (!member.skills.includes(sk.id)) {
          member.skills.push(sk.id);
          logEvent(`${member.name} re-learned ${sk.name}!`);
        }
      }
    }
    save();
    return { ok: true, cost };
  }

  function getRespecCost() {
    // Respec is free — Hero specs should be easy to pick and choose.
    return 0;
  }

  /** Return an array of skill IDs granted by an item (handles both grantedSkill and grantedSkills). */
  function getItemGrantedSkills(item) {
    if (!item) return [];
    const skills = [];
    if (item.grantedSkill) skills.push(item.grantedSkill);
    if (item.grantedSkills) skills.push(...item.grantedSkills);
    return skills;
  }

  function equipItem(memberId, itemId, targetSlot) {
    const member = memberId === 'player' ? state.player : state.party.find(m => m.id === memberId);
    if (!member) return { ok:false, reason:'Member not found' };
    const item = getItem(itemId);
    if (!item || !item.slot) return { ok:false, reason:'Not equippable' };
    if (!canClassEquip(member.class, item)) {
      const cls = getClass(member.class);
      return { ok:false, reason:`${cls.label} cannot equip ${item.name}` };
    }

    // Determine which slot to equip into.
    // Dual-wield: Rogues=daggers, Monks=claws, Rangers=swords — can go in weapon OR offhand.
    // Bows are mainhand-only (bow: true), quivers are offhand-only (quiver: true).
    const canDualWield =
      (item.dagger && member.class === 'ROGUE') ||
      (item.claw && member.class === 'MONK') ||
      (item.slot === 'weapon' && !item.twoHanded && !item.dagger && !item.claw && !item.bow &&
       member.class === 'RANGER' && item.classReq && item.classReq.includes('RANGER'));

    let slot = item.slot;
    if (targetSlot === 'offhand' && canDualWield) {
      slot = 'offhand';
    } else if (targetSlot && targetSlot !== item.slot) {
      if (!(canDualWield && targetSlot === 'offhand')) {
        return { ok:false, reason:'Cannot equip that item in this slot' };
      }
    }

    // 2h weapon check: if equipping a 2h weapon, auto-unequip offhand
    if (slot === 'weapon' && item.twoHanded && member.equipment.offhand) {
      unequipItem(memberId, 'offhand');
    }
    // If equipping offhand but weapon is 2h, block it
    if (slot === 'offhand' && member.equipment.weapon) {
      const wpn = getItem(member.equipment.weapon);
      if (wpn && wpn.twoHanded) {
        return { ok:false, reason:'Cannot use offhand with a two-handed weapon' };
      }
    }

    const inv = state.inventory.find(e => e.itemId === itemId);
    if (!inv || inv.quantity < 1) return { ok:false, reason:'Not in inventory' };

    const oldItemId = member.equipment[slot];
    if (oldItemId) {
      addToInventory(oldItemId, 1);
      const oldItem = getItem(oldItemId);
      const oldSkills = getItemGrantedSkills(oldItem);
      if (oldSkills.length) {
        // Only remove skills if they aren't also granted by the other slot's item
        const otherSlot = slot === 'weapon' ? 'offhand' : 'weapon';
        const otherItemId = member.equipment[otherSlot];
        const otherItem = otherItemId ? getItem(otherItemId) : null;
        const otherSkills = new Set(getItemGrantedSkills(otherItem));
        for (const sk of oldSkills) {
          if (!otherSkills.has(sk)) {
            member.skills = member.skills.filter(id => id !== sk);
          }
        }
      }
    }

    inv.quantity--;
    if (inv.quantity === 0) state.inventory.splice(state.inventory.indexOf(inv), 1);
    member.equipment[slot] = itemId;
    for (const sk of getItemGrantedSkills(item)) {
      if (!member.skills.includes(sk)) member.skills.push(sk);
    }
    return { ok:true };
  }

  function unequipItem(memberId, slot) {
    const member = memberId === 'player' ? state.player : state.party.find(m => m.id === memberId);
    if (!member || !member.equipment[slot]) return { ok:false, reason:'Nothing to unequip' };
    const itemId = member.equipment[slot];
    const item = getItem(itemId);
    for (const sk of getItemGrantedSkills(item)) {
      member.skills = member.skills.filter(id => id !== sk);
    }
    addToInventory(itemId, 1);
    member.equipment[slot] = null;
    return { ok:true };
  }

  function buildPartySnapshot() {
    // Collect all party-wide aura bonuses from the active party
    const allActive = [state.player, ...state.activeSlots.map(id => state.party.find(p => p.id === id)).filter(Boolean)];
    const auras = collectPartyAuras(allActive);

    const members = [{ id:'player', name:state.player.name, class:state.player.class, level:state.player.level, stats:effectiveStats(state.player, auras), power:memberPower(state.player) }];
    for (const id of state.activeSlots) {
      const m = state.party.find(p => p.id === id);
      if (m) members.push({ id:m.id, name:m.name, class:m.class, level:m.level, stats:effectiveStats(m, auras), power:memberPower(m) });
    }
    return members;
  }

  function getPartyAuras() {
    const allActive = [state.player, ...state.activeSlots.map(id => state.party.find(p => p.id === id)).filter(Boolean)];
    return collectPartyAuras(allActive);
  }

  function totalPartyPower() {
    return buildPartySnapshot().reduce((s, m) => s + m.power, 0);
  }

  function getMember(id) {
    if (id === 'player') return state.player;
    return state.party.find(m => m.id === id) || null;
  }

  function getActiveMembers() {
    return state.activeSlots.map(id => state.party.find(m => m.id === id)).filter(Boolean);
  }

  function getActiveMemberSkills(memberId) {
    const member = getMember(memberId);
    if (!member) return [];
    const skills = [];
    // Class skills (proc-based, unlock every 2 levels starting at 2)
    let classSkills = getUnlockedClassSkills(member.class, member.level);
    // Hero spec replacement (§3.1.1) — strip baseline L10/L14/L18 when specced
    if (member.class === 'HERO' && member.heroSpec) {
      classSkills = classSkills.filter(s => !HERO_SPEC_REPLACED_SKILLS.includes(s.id));
    }
    skills.push(...classSkills.map(s => s.id));
    // Class masteries (passive, unlock every 2 levels starting at 4)
    const classMasteries = getUnlockedClassMasteries(member.class, member.level);
    skills.push(...classMasteries.map(s => s.id));
    // Hero spec skills (replace the stripped baseline slots)
    if (member.class === 'HERO' && member.heroSpec) {
      const specSkills = getUnlockedSpecSkills(member.heroSpec, member.level);
      for (const sk of specSkills) {
        if (!skills.includes(sk.id)) skills.push(sk.id);
      }
    }
    // Equipment-granted skills (item procs, separate from class skills)
    // Uses getEquipmentSkills (plural) so items with multiple granted skills
    // (e.g. CEL_SCEPTER_OF_DAWN with both an active and a passive) all load.
    for (const slot of Object.values(member.equipment || {})) {
      if (slot) {
        const eqSkills = getEquipmentSkills(slot);
        for (const eqSkill of eqSkills) {
          if (eqSkill && !skills.includes(eqSkill.id)) skills.push(eqSkill.id);
        }
      }
    }
    return skills;
  }

  // ── Guild ──────────────────────────────────────────────────────────────────

  function canTakeQuest(questId) {
    const quest = getGeneratedQuest(questId) || getQuest(questId);
    if (!quest) return { ok:false, reason:'Quest not found' };
    if (state.guild.activeQuest) return { ok:false, reason:'Party is already on a quest' };
    if (rankIndex(state.guild.rank) < rankIndex(quest.requiredGuildRank)) {
      return { ok:false, reason:`Requires ${quest.requiredGuildRank} Rank` };
    }
    const completions = state.guild.completedQuests.filter(id => id === questId).length;
    if (!quest.isRepeatable && completions > 0) return { ok:false, reason:'Already completed' };
    return { ok:true };
  }

  function completionCount(questId) {
    return state.guild.completedQuests.filter(id => id === questId).length;
  }

  // ── Combat / Loot ──────────────────────────────────────────────────────────

  function resolveQuest(questDef, snapshot) {
    const activatedSkills = [];
    let adjustedPartyPower = snapshot.reduce((s, m) => s + m.power, 0);
    for (const memberSnap of snapshot) {
      const member = getMember(memberSnap.id);
      if (!member) continue;
      const triggered = rollActiveSkills(member, snapshot);
      for (const skill of triggered) {
        activatedSkills.push({ memberId: member.id, memberName: member.name, skill });
        if (skill.effects && skill.effects.powerMultiplier) {
          adjustedPartyPower += memberSnap.power * (skill.effects.powerMultiplier - 1);
        }
      }
    }

    const partyPower = adjustedPartyPower;
    const questPower = questDef.recommendedPower || 15;
    const ratio = partyPower / Math.max(1, questPower);

    // Use the combat simulation's outcome if available (keeps visual narrative in sync)
    // Fall back to probability formula only if no sim exists (e.g. instant-resolve scenarios)
    const simOutcome = getBattleOutcome();
    let success;
    if (simOutcome) {
      success = simOutcome === 'victory';
    } else {
      // Fallback: probability formula for cases without a combat sim
      const successChance = Math.min(0.95, Math.max(0.05, ratio * 0.40 + 0.30));
      success = Math.random() < successChance;
    }
    // Loot bonus from party synergy skills only (LCK stat removed)
    const luckBonus = 0;

    const baseGold = randInt(questDef.goldReward.min, questDef.goldReward.max);
    const baseExp  = randInt(questDef.expReward.min, questDef.expReward.max);
    // Cap the ratio multiplier to prevent runaway rewards on overleveled quests
    const cappedRatio = Math.min(ratio, 3.0);
    // Synergy bonuses for repeated quests + Guild Legacy bonuses
    const legacy = getLegacyBonuses();
    const goldXpMult = 1 + getGoldXpBonus(questDef.id) + legacy.goldBonus + legacy.expBonus;
    const rpMult = 1 + getRpBonus(questDef.id);
    const itemFindBonus = getItemFind(questDef.id) + legacy.itemFind;
    const goldEarned = success ? Math.floor(baseGold * (0.8 + cappedRatio * 0.4) * goldXpMult) : 0;
    const expEarned  = Math.floor(baseExp * (success ? 1 : 0.2) * goldXpMult);

    // ── §10 Sub-difficulty loot quality + quantity scaling ─────────────
    // Quest rarity boosts loot drop chance at resolution time
    const questRarityMult = questDef.rarity === 'legendary' ? 1.4
      : questDef.rarity === 'rare' ? 1.2
      : questDef.rarity === 'uncommon' ? 1.1 : 1.0;

    // Sub-tier quality shift: hard/brutal quests boost equipment drop
    // chances AND add bonus drop slots. This makes sub-difficulty matter
    // for loot quality, not just XP/gold/RP.
    const subTier = questDef.subTier || 'standard';

    // ── Quality-weighted sub-tier drop multipliers ──────────────────────
    // Harder sub-tiers give progressively bigger boosts to higher-rarity
    // items. A Brutal quest doesn't just drop more items — it shifts the
    // quality distribution upward so epic/legendary/celestial gear drops
    // more frequently relative to common/magic filler.
    //
    // Rarity key:  common  magic  rare   epic  legendary  celestial
    // Easy:         0.80   0.80   0.80  0.80    0.80      0.80
    // Standard:     1.00   1.00   1.00  1.00    1.00      1.00
    // Hard:         1.10   1.15   1.25  1.40    1.50      1.60
    // Brutal:       1.20   1.30   1.50  1.80    2.00      2.20
    const SUB_TIER_QUALITY_MULT = {
      easy:     { common: 0.80, magic: 0.80, rare: 0.80, epic: 0.80, legendary: 0.80, celestial: 0.80 },
      standard: { common: 1.00, magic: 1.00, rare: 1.00, epic: 1.00, legendary: 1.00, celestial: 1.00 },
      hard:     { common: 1.10, magic: 1.15, rare: 1.25, epic: 1.40, legendary: 1.50, celestial: 1.60 },
      brutal:   { common: 1.20, magic: 1.30, rare: 1.50, epic: 1.80, legendary: 2.00, celestial: 2.20 },
    };
    const subQualityTable = SUB_TIER_QUALITY_MULT[subTier] || SUB_TIER_QUALITY_MULT.standard;

    const loot = [];
    if (success) {
      // Track failed entries for loot guarantee system
      const failedEntries = [];

      for (const entry of questDef.lootTable) {
        // Guaranteed drops (chance === 1.0) always drop — skip RNG entirely
        if (entry.chance >= 1.0) {
          loot.push({ itemId: entry.itemId, quantity: randInt(entry.quantity[0], entry.quantity[1]) });
          continue;
        }
        const lootRatio = Math.min(ratio, 3.0);
        const baseChance = entry.chance * (0.7 + lootRatio * 0.3) + luckBonus * 0.02;
        // Legacy celestial bonus applies on top for celestial items
        const item = getItem(entry.itemId);
        const itemRarity = getItemRarity(item)?.id || 'common';
        const isCelItem = itemRarity === 'celestial';
        const celBonus = isCelItem ? legacy.celestialBonus : 0;
        // Quality-weighted sub-tier multiplier: higher rarity = bigger boost
        const subTierDropMult = subQualityTable[itemRarity] || 1.0;
        const chance = Math.min(0.95, baseChance * (1 + itemFindBonus + celBonus) * questRarityMult * subTierDropMult);
        if (Math.random() < chance) {
          loot.push({ itemId: entry.itemId, quantity: randInt(entry.quantity[0], entry.quantity[1]) });
        } else {
          failedEntries.push({ entry, chance });
        }
      }

      // ── Loot drop guarantees ──────────────────────────────────────────
      // Base drops per rank tier (at Easy difficulty):
      //   F-E: 2, D-C: 3, B-A: 4, S/S+/S++: 5
      // Each sub-difficulty step above Easy adds +1:
      //   Standard +1, Hard +2, Brutal +3
      // Boss Hard: 6-8, Boss Brutal: 7-9, Raid: 10
      const RANK_BASE_DROPS = {
        F: 2, E: 2, D: 3, C: 3, B: 4, A: 4,
        S: 5, 'S+': 5, 'S++': 5,
      };
      const SUB_TIER_DROP_BONUS = {
        easy: 0, standard: 1, hard: 2, brutal: 3,
      };

      const isRaid = !!questDef.raidBoss;
      const isBoss = !!questDef.boss;
      let minLoot, maxLoot;

      if (isRaid) {
        // Raid bosses: flat 10 guaranteed drops ("celestial piñatas")
        minLoot = 10;
        maxLoot = 10;
      } else if (isBoss) {
        // Boss Hard: 6-8, Boss Brutal: 7-9, other bosses: rank base + sub bonus
        if (subTier === 'brutal') {
          minLoot = 7; maxLoot = 9;
        } else if (subTier === 'hard') {
          minLoot = 6; maxLoot = 8;
        } else {
          const base = RANK_BASE_DROPS[questDef.rank] || 2;
          const bonus = SUB_TIER_DROP_BONUS[subTier] || 0;
          minLoot = base + bonus;
          maxLoot = minLoot + 2; // bosses still get a small range above min
        }
      } else {
        // Normal quests: rank base + sub-difficulty bonus
        const base = RANK_BASE_DROPS[questDef.rank] || 2;
        const bonus = SUB_TIER_DROP_BONUS[subTier] || 0;
        minLoot = base + bonus;
        maxLoot = minLoot; // no range for non-boss, just the guarantee floor
      }

      // Cap at max if natural rolls exceeded it
      if (maxLoot && loot.length > maxLoot) {
        while (loot.length > maxLoot) loot.pop();
      }

      // Fill up to minimum from failed rolls, sorted by drop chance (best first)
      if (loot.length < minLoot && failedEntries.length > 0) {
        failedEntries.sort((a, b) => {
          // Prioritize equipment over consumables for forced drops
          const aEquip = EQUIPMENT[a.entry.itemId] ? 1 : 0;
          const bEquip = EQUIPMENT[b.entry.itemId] ? 1 : 0;
          if (aEquip !== bEquip) return bEquip - aEquip;
          return b.chance - a.chance;
        });
        for (const fe of failedEntries) {
          if (loot.length >= minLoot) break;
          if (loot.some(l => l.itemId === fe.entry.itemId)) continue;
          loot.push({ itemId: fe.entry.itemId, quantity: randInt(fe.entry.quantity[0], fe.entry.quantity[1]) });
        }
      }
    }

    const baseRp = success ? questDef.rankPointReward : 0;
    const rankPoints = Math.floor(baseRp * rpMult);
    const pool = success ? questDef.narratives.success : questDef.narratives.failure;
    const narrative = pool[Math.floor(Math.random() * pool.length)];

    return { success, partyPower, questPower, ratio, goldEarned, expEarned, rankPoints, loot, narrative, activatedSkills };
  }

  // ── Economy ────────────────────────────────────────────────────────────────

  function refreshShopIfNeeded() {
    const now = Date.now();
    const timerExpired = !state.shop.lastRefreshed || now - state.shop.lastRefreshed >= SHOP_REFRESH_MS;
    const questThreshold = (state.shop.questsSinceRefresh || 0) >= SHOP_QUEST_REFRESH;
    if (timerExpired || questThreshold) {
      refreshShop();
    }
  }

  // Called after each quest completes to tick the quest-based refresh counter
  function tickShopQuestCounter() {
    state.shop.questsSinceRefresh = (state.shop.questsSinceRefresh || 0) + 1;
    if (state.shop.questsSinceRefresh >= SHOP_QUEST_REFRESH) {
      refreshShop();
    }
  }

  // Rush restock — gold sink: costs 20% of the upgrade cost for the current level
  function getRushRestockCost() {
    const level = state.shop.level || 0;
    if (level === 0) return 100; // base cost when shop hasn't been upgraded yet
    // 20% of the cost it took to reach this level
    return Math.floor(SHOP_UPGRADE_COSTS[level - 1] * 0.20);
  }

  function rushRestock() {
    const cost = getRushRestockCost();
    if (state.gold < cost) {
      return { ok: false, reason: `Need ${cost.toLocaleString()}g (have ${state.gold.toLocaleString()}g)` };
    }
    state.gold -= cost;
    refreshShop();
    logEvent(`Rush restock! Spent ${cost.toLocaleString()}g to refresh the shop.`);
    return { ok: true, cost };
  }

  // ── Shop Upgrade System ─────────────────────────────────────────────────
  // 10 levels of shop upgrades. Each level shifts rarity weights toward
  // higher-quality items. At max level the shop is dominated by epic/legendary.

  const SHOP_UPGRADE_COSTS = [
    500, 1500, 4000, 8000, 15000, 25000, 40000, 60000, 80000, 100000
  ];

  // Rank required to purchase each shop level (1-indexed: index 0 = level 1 requirement)
  // F(1-3), E(4-5), D(6-7), C(8-9), B(10)
  // Level 3 at Rank F unlocks +1 tier bonus → Magic items available early
  const SHOP_LEVEL_RANK_REQ = ['F', 'F', 'F', 'E', 'E', 'D', 'D', 'C', 'C', 'B'];

  // Base weights at level 0, and weights at level 10
  // Intermediate levels interpolate linearly between these
  const RARITY_WEIGHT_BASE = { common: 40, magic: 30, rare: 18, epic: 8, legendary: 4 };
  const RARITY_WEIGHT_MAX  = { common: 0,  magic: 0,  rare: 10, epic: 45, legendary: 45 };

  function getShopRarityWeights() {
    const level = state.shop.level || 0;
    const t = level / 10; // 0.0 → 1.0
    const weights = {};
    for (const r of Object.keys(RARITY_WEIGHT_BASE)) {
      weights[r] = Math.round(RARITY_WEIGHT_BASE[r] * (1 - t) + RARITY_WEIGHT_MAX[r] * t);
    }
    return weights;
  }

  function getShopUpgradeCost() {
    const level = state.shop.level || 0;
    if (level >= 10) return null; // maxed
    return SHOP_UPGRADE_COSTS[level];
  }

  function getShopUpgradeRankReq() {
    const level = state.shop.level || 0;
    if (level >= 10) return null;
    return SHOP_LEVEL_RANK_REQ[level] || 'F';
  }

  function canUpgradeShop() {
    const level = state.shop.level || 0;
    if (level >= 10) return { ok: false, reason: 'Shop is already max level!' };
    const reqRank = SHOP_LEVEL_RANK_REQ[level] || 'F';
    if (rankIndex(state.guild.rank) < rankIndex(reqRank)) {
      return { ok: false, reason: `Requires Guild Rank ${reqRank}` };
    }
    const cost = SHOP_UPGRADE_COSTS[level];
    if (state.gold < cost) return { ok: false, reason: `Need ${cost.toLocaleString()}g (have ${state.gold.toLocaleString()}g)` };
    return { ok: true };
  }

  function upgradeShop() {
    const check = canUpgradeShop();
    if (!check.ok) return check;
    const level = state.shop.level || 0;
    const cost = SHOP_UPGRADE_COSTS[level];
    state.gold -= cost;
    state.shop.level = level + 1;
    logEvent(`Shop upgraded to level ${state.shop.level}!`);
    refreshShop(); // restock with new weights immediately
    return { ok: true, newLevel: state.shop.level };
  }

  // Shop levels can unlock the NEXT rarity tier one rank early (max +1).
  // Kicks in at shop level 3 — you see gear one tier above your guild rank.
  // Higher shop levels improve rarity weights but don't unlock additional tiers.
  function getShopBonusRanks() {
    return (state.shop.level || 0) >= 3 ? 1 : 0;
  }

  function getShopEffectiveRankIndex() {
    return Math.min(RANK_ORDER.length - 1, rankIndex(state.guild.rank) + getShopBonusRanks());
  }

  function refreshShop() {
    const ri = getShopEffectiveRankIndex();
    const available = Object.values(EQUIPMENT).filter(item => item.rarity !== 'celestial' && item.shopMinRank != null && rankIndex(item.shopMinRank) <= ri);
    if (available.length === 0) { state.shop.stock = []; state.shop.lastRefreshed = Date.now(); return; }

    // Weighted random selection — pick 10 items, preferring common/magic
    const selected = [];
    const used = new Set();

    // First: guarantee one item from each slot type that has items available
    const slots = ['weapon', 'armor', 'accessory', 'offhand'];
    for (const slot of slots) {
      const slotItems = available.filter(it => it.slot === slot && !used.has(it.id));
      if (slotItems.length > 0) {
        const pick = weightedPick(slotItems);
        selected.push(pick);
        used.add(pick.id);
      }
    }

    // Fill remaining slots with weighted random picks (up to 10 total)
    const remaining = available.filter(it => !used.has(it.id));
    while (selected.length < 10 && remaining.length > 0) {
      const pick = weightedPick(remaining);
      selected.push(pick);
      used.add(pick.id);
      remaining.splice(remaining.indexOf(pick), 1);
    }

    // Rarity affects quantity and can add a price premium for rare+ items
    state.shop.stock = selected.map(item => {
      const rarity = item.rarity || 'common';
      const qty = rarity === 'legendary' ? 1 : rarity === 'epic' ? randInt(1, 1) : randInt(1, 3);
      return { itemId: item.id, price: item.buyPrice, quantity: qty };
    });
    state.shop.lastRefreshed = Date.now();
    state.shop.questsSinceRefresh = 0;
  }

  function weightedPick(items) {
    const weights = getShopRarityWeights();
    const totalWeight = items.reduce((sum, it) => sum + (weights[it.rarity || 'common'] || 20), 0);
    let roll = Math.random() * totalWeight;
    for (const item of items) {
      roll -= weights[item.rarity || 'common'] || 20;
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  function buyItem(itemId) {
    const entry = state.shop.stock.find(s => s.itemId === itemId && s.quantity > 0);
    if (!entry) return { ok:false, reason:'Out of stock' };
    if (state.gold < entry.price) return { ok:false, reason:`Need ${entry.price}g (have ${state.gold}g)` };
    const cost = entry.price;
    state.gold -= cost;
    entry.quantity--;
    addToInventory(itemId, 1);
    return { ok:true, cost };
  }

  function toggleKeepItem(itemId) {
    const entry = state.inventory.find(e => e.itemId === itemId);
    if (!entry) return { ok:false, reason:'Item not found' };
    entry.kept = !entry.kept;
    return { ok:true, kept: entry.kept };
  }

  function sellItem(itemId, qty = 1) {
    const item = getItem(itemId);
    if (!item) return { ok:false, reason:'Unknown item' };
    const entry = state.inventory.find(e => e.itemId === itemId);
    if (entry && entry.kept) return { ok:false, reason:'Item is kept — unlock it first' };
    if (!removeFromInventory(itemId, qty)) return { ok:false, reason:'Not enough items' };
    const earned = Math.floor((item.sellPrice || Math.floor(item.buyPrice * 0.4)) * qty);
    state.gold += earned;
    return { ok:true, earned };
  }

  function sellAllItems() {
    let totalEarned = 0;
    let totalSold = 0;
    // Iterate over a copy since sellItem mutates the array; skip kept items
    const entries = [...state.inventory].filter(e => {
      const item = getItem(e.itemId);
      return item && (item.sellPrice || item.buyPrice) && e.quantity > 0 && !e.kept;
    });
    for (const e of entries) {
      const item = getItem(e.itemId);
      if (!item) continue;
      const earned = Math.floor((item.sellPrice || Math.floor(item.buyPrice * 0.4)) * e.quantity);
      totalSold += e.quantity;
      totalEarned += earned;
      removeFromInventory(e.itemId, e.quantity);
    }
    state.gold += totalEarned;
    return { ok: true, earned: totalEarned, count: totalSold };
  }

  function shopRefreshMs() {
    if (!state.shop.lastRefreshed) return 0;
    return Math.max(0, SHOP_REFRESH_MS - (Date.now() - state.shop.lastRefreshed));
  }

  function shopQuestsUntilRefresh() {
    return Math.max(0, SHOP_QUEST_REFRESH - (state.shop.questsSinceRefresh || 0));
  }

  // ── Quest Board ────────────────────────────────────────────────────────────

  function getPartyStrength() {
    const activeMembers = getActiveMembers();
    const auras = getPartyAuras();
    const effectiveWithAuras = (m) => effectiveStats(m, auras);
    return calculatePartyStrength(state.player, activeMembers, effectiveWithAuras);
  }

  function refreshQuestBoard(rank, force = false) {
    if (!state.questBoard) {
      state.questBoard = { quests: {}, lastRefreshed: {}, seeds: {} };
    }
    if (!force && !shouldRefreshBoard(state.questBoard.lastRefreshed[rank])) {
      return state.questBoard.quests[rank] || [];
    }
    const seed = Date.now() + rankIndex(rank) * 10000;
    const strength = getPartyStrength();
    const quests = generateQuestBoard(rank, strength, seed, state.guild?.rank);
    state.questBoard.quests[rank] = quests;
    state.questBoard.lastRefreshed[rank] = Date.now();
    state.questBoard.seeds[rank] = seed;
    return quests;
  }

  function getQuestBoardQuests(rank) {
    if (!state.questBoard) {
      state.questBoard = { quests: {}, lastRefreshed: {}, seeds: {} };
    }
    // Auto-refresh if needed
    if (shouldRefreshBoard(state.questBoard.lastRefreshed[rank])) {
      return refreshQuestBoard(rank);
    }
    return state.questBoard.quests[rank] || [];
  }

  function questBoardRefreshMs(rank) {
    if (!state.questBoard || !state.questBoard.lastRefreshed[rank]) return 0;
    return Math.max(0, BOARD_REFRESH_MS - (Date.now() - state.questBoard.lastRefreshed[rank]));
  }

  // Pick the best quest from the current board based on auto-run strategy.
  // 'safe'     → lowest difficulty (easiest quest)
  // 'balanced' → closest to "moderate" tier (ratio ~0.7-0.9)
  // 'push'     → highest difficulty (hardest quest)
  function pickQuestByStrategy(rank, strategy) {
    const quests = getQuestBoardQuests(rank);
    if (!quests || quests.length === 0) return null;
    const partyStr = getPartyStrength();
    if (partyStr <= 0) return quests[0];

    // Score each quest: ratio = questPower / partyStrength
    const scored = quests.map(q => ({
      quest: q,
      ratio: (q.difficulty * 20) / partyStr,
    }));

    if (strategy === 'safe') {
      // Lowest ratio = easiest
      scored.sort((a, b) => a.ratio - b.ratio);
    } else if (strategy === 'push') {
      // Highest ratio = hardest
      scored.sort((a, b) => b.ratio - a.ratio);
    } else {
      // 'balanced' — closest to 0.8 ratio (moderate sweet spot)
      scored.sort((a, b) => Math.abs(a.ratio - 0.8) - Math.abs(b.ratio - 0.8));
    }
    return scored[0].quest;
  }

  // Look up a generated quest by ID (check all ranks)
  function getGeneratedQuest(questId) {
    if (!state.questBoard || !state.questBoard.quests) return null;
    for (const rank of RANK_ORDER) {
      const quests = state.questBoard.quests[rank];
      if (quests) {
        const q = quests.find(q => q.id === questId);
        if (q) return q;
      }
    }
    return null;
  }

  // ── Party Synergy ─────────────────────────────────────────────────────────

  const SYNERGY_THRESHOLDS = [
    // Early unlocks (every 2-3 quests) — introduce each bonus type
    { id: 'GOLD_XP_1',     quests: 3,   label: 'Shrewd Negotiators I',  desc: '+10% gold & XP',           goldXpBonus: 0.10 },
    { id: 'DMG_1',         quests: 5,   label: 'Precise Strikes I',     desc: '+5% damage (all types)',    dmgBonus: 0.05 },
    { id: 'DMG_TAKEN_1',   quests: 7,   label: 'Iron Resolve I',        desc: '−5% damage taken',          dmgReduction: 0.05 },
    { id: 'AUTO_RUN_2',    quests: 8,   label: 'Battle Fervor I',       desc: 'Unlock auto-battle ×2',     autoRunMax: 2 },
    { id: 'ATK_SPD_1',     quests: 10,  label: 'Combat Momentum I',     desc: '+10% attack speed',         atkSpeedBonus: 0.10 },
    { id: 'HEAL_1',        quests: 12,  label: 'Field Medic I',         desc: '+15% healing efficiency',    healBonus: 0.15 },
    { id: 'AUTO_RUN_5',    quests: 15,  label: 'Battle Fervor II',      desc: 'Unlock auto-battle ×5',     autoRunMax: 5 },
    { id: 'ITEM_FIND_1',   quests: 17,  label: 'Treasure Hunter I',     desc: '+10% item find chance',      itemFind: 0.10 },
    { id: 'BOSS_1',        quests: 19,  label: 'Keen Eye I',            desc: '5% boss encounter chance',   secretBossChance: 0.05 },
    { id: 'RP_1',          quests: 21,  label: 'War Stories I',         desc: '+15% rank points',           rpBonus: 0.15 },

    // Mid unlocks (every 3-4 quests) — tier 2
    { id: 'GOLD_XP_2',     quests: 24,  label: 'Shrewd Negotiators II', desc: '+20% gold & XP',            goldXpBonus: 0.20 },
    { id: 'DMG_2',         quests: 27,  label: 'Precise Strikes II',    desc: '+10% damage (all types)',    dmgBonus: 0.10 },
    { id: 'AUTO_RUN_10',   quests: 30,  label: 'Battle Fervor III',     desc: 'Unlock auto-battle ×10',    autoRunMax: 10 },
    { id: 'DMG_TAKEN_2',   quests: 33,  label: 'Iron Resolve II',       desc: '−10% damage taken',          dmgReduction: 0.10 },
    { id: 'ATK_SPD_2',     quests: 36,  label: 'Combat Momentum II',    desc: '+20% attack speed',          atkSpeedBonus: 0.20 },
    { id: 'HEAL_2',        quests: 39,  label: 'Field Medic II',        desc: '+30% healing efficiency',     healBonus: 0.30 },
    { id: 'ITEM_FIND_2',   quests: 42,  label: 'Treasure Hunter II',    desc: '+20% item find chance',       itemFind: 0.20 },
    { id: 'BOSS_2',        quests: 45,  label: 'Keen Eye II',           desc: '10% boss encounter chance',   secretBossChance: 0.10 },
    { id: 'RP_2',          quests: 48,  label: 'War Stories II',        desc: '+30% rank points',            rpBonus: 0.30 },

    // Late unlocks (every 4-5 quests) — tier 3
    { id: 'AUTO_RUN_20',   quests: 50,  label: 'Battle Fervor IV',      desc: 'Unlock auto-battle ×20',     autoRunMax: 20 },
    { id: 'GOLD_XP_3',     quests: 54,  label: 'Shrewd Negotiators III',desc: '+35% gold & XP',             goldXpBonus: 0.35 },
    { id: 'DMG_3',         quests: 58,  label: 'Precise Strikes III',   desc: '+18% damage (all types)',     dmgBonus: 0.18 },
    { id: 'DMG_TAKEN_3',   quests: 62,  label: 'Iron Resolve III',      desc: '−18% damage taken',           dmgReduction: 0.18 },
    { id: 'ATK_SPD_3',     quests: 66,  label: 'Combat Momentum III',   desc: '+30% attack speed',           atkSpeedBonus: 0.30 },
    { id: 'HEAL_3',        quests: 70,  label: 'Field Medic III',       desc: '+50% healing efficiency',      healBonus: 0.50 },
    { id: 'ITEM_FIND_3',   quests: 74,  label: 'Treasure Hunter III',   desc: '+35% item find chance',        itemFind: 0.35 },
    { id: 'BOSS_3',        quests: 78,  label: 'Keen Eye III',          desc: '15% boss encounter chance',    secretBossChance: 0.15 },
    { id: 'RP_3',          quests: 82,  label: 'War Stories III',       desc: '+50% rank points',             rpBonus: 0.50 },
  ];

  function getPartyHash() {
    return ['player', ...state.activeSlots].sort().join(',');
  }

  function updatePartySynergy() {
    if (!state.partySynergy) {
      state.partySynergy = { totalQuestsAsTeam: 0, lastPartyHash: null, bonusesUnlocked: [], secretBossesFound: 0 };
    }
    const currentHash = getPartyHash();
    // If party composition changed, reset streak but keep total
    if (state.partySynergy.lastPartyHash && state.partySynergy.lastPartyHash !== currentHash) {
      // Don't reset total — synergy persists even through party changes
    }
    state.partySynergy.lastPartyHash = currentHash;
    state.partySynergy.totalQuestsAsTeam++;

    // Check for new unlocks — return list of newly unlocked thresholds
    const newUnlocks = [];
    for (const thresh of SYNERGY_THRESHOLDS) {
      if (state.partySynergy.totalQuestsAsTeam >= thresh.quests &&
          !state.partySynergy.bonusesUnlocked.includes(thresh.id)) {
        state.partySynergy.bonusesUnlocked.push(thresh.id);
        newUnlocks.push(thresh);
        logEvent(`Party Synergy: ${thresh.label} unlocked! ${thresh.desc}`);
      }
    }
    return newUnlocks;
  }

  function getMaxAutoRun() {
    if (!state.partySynergy) return 0;
    let max = 0;
    for (const thresh of SYNERGY_THRESHOLDS) {
      if (state.partySynergy.bonusesUnlocked.includes(thresh.id) && thresh.autoRunMax) {
        max = Math.max(max, thresh.autoRunMax);
      }
    }
    return max;
  }

  // Returns a multiplier (0 if not repeated or no bonus) for the given synergy key
  function _getSynergyBonus(questId, key) {
    if (!state.partySynergy) return 0;
    const completions = completionCount(questId);
    if (completions === 0) return 0;
    // Scale with completions: ×1=40%, ×5=70%, ×10+=100% of the bonus
    const compMult = completions >= 10 ? 1.0 : completions >= 5 ? 0.7 : 0.4;
    let bonus = 0;
    for (const thresh of SYNERGY_THRESHOLDS) {
      if (state.partySynergy.bonusesUnlocked.includes(thresh.id) && thresh[key]) {
        bonus = Math.max(bonus, thresh[key]);
      }
    }
    return bonus * compMult;
  }

  function getGoldXpBonus(questId)     { return _getSynergyBonus(questId, 'goldXpBonus'); }
  function getDmgBonus(questId)        { return _getSynergyBonus(questId, 'dmgBonus'); }
  function getDmgReduction(questId)    { return _getSynergyBonus(questId, 'dmgReduction'); }
  function getAtkSpeedBonus(questId)   { return _getSynergyBonus(questId, 'atkSpeedBonus'); }
  function getHealBonus(questId)       { return _getSynergyBonus(questId, 'healBonus'); }
  function getItemFind(questId)        { return _getSynergyBonus(questId, 'itemFind'); }
  function getRpBonus(questId)         { return _getSynergyBonus(questId, 'rpBonus'); }

  function getSecretBossChance() {
    if (!state.partySynergy) return 0;
    let chance = 0;
    for (const thresh of SYNERGY_THRESHOLDS) {
      if (state.partySynergy.bonusesUnlocked.includes(thresh.id) && thresh.secretBossChance) {
        chance = Math.max(chance, thresh.secretBossChance);
      }
    }
    return chance;
  }

  // ── Secret Boss Encounters ────────────────────────────────────────────────

  const SECRET_BOSSES = [
    { name: 'Mimic Treasure King', icon: '📦', powerMult: 1.5, goldMult: 3.0, expMult: 2.0 },
    { name: 'Wandering Lich',      icon: '💀', powerMult: 1.8, goldMult: 2.5, expMult: 2.5 },
    { name: 'Shadow Doppelganger', icon: '👤', powerMult: 2.0, goldMult: 2.0, expMult: 3.0 },
    { name: 'Golden Dragon Hatchling', icon: '🐉', powerMult: 1.3, goldMult: 5.0, expMult: 1.5 },
    { name: 'Chaos Knight',        icon: '⚔', powerMult: 2.2, goldMult: 2.0, expMult: 2.0 },
    { name: 'The Collector',       icon: '🎭', powerMult: 1.6, goldMult: 2.0, expMult: 2.0 },
  ];

  // Class-specific unique rewards from secret bosses
  const CLASS_UNIQUE_REWARDS = {
    HERO:   { skillId: null, statBoost: { atk: 3, def: 2 }, name: 'Hero\'s Resolve' },
    KNIGHT: { skillId: null, statBoost: { def: 5, maxHp: 15 }, name: 'Iron Will' },
    MAGE:   { skillId: null, statBoost: { mag: 5, spd: 1 }, name: 'Arcane Insight' },
    ROGUE:  { skillId: null, statBoost: { spd: 4, crit: 3 }, name: 'Shadow\'s Favor' },
    CLERIC: { skillId: null, statBoost: { mag: 3, def: 2, maxHp: 10 }, name: 'Divine Grace' },
    RANGER: { skillId: null, statBoost: { atk: 3, spd: 2, crit: 2 }, name: 'Predator\'s Mark' },
    BARD:   { skillId: null, statBoost: { dodge: 3, crit: 2, spd: 2 }, name: 'Muse\'s Kiss' },
    MONK:   { skillId: null, statBoost: { atk: 2, def: 2, spd: 2, mag: 1 }, name: 'Inner Peace' },
  };

  function rollSecretBoss(questDef, snapshot) {
    let chance = getSecretBossChance();

    // Dynamic boss scaling: stronger parties attract more boss encounters.
    // If party power is 2x+ the quest power, add bonus boss chance (up to +40%).
    const partyPow = snapshot.reduce((s, m) => s + m.power, 0);
    const questPow = questDef.recommendedPower || 15;
    if (questPow > 0) {
      const overPowerRatio = partyPow / questPow;
      if (overPowerRatio > 2.0) {
        const bonusChance = Math.min(0.40, (overPowerRatio - 2.0) * 0.08);
        chance = Math.max(chance, bonusChance);
      }
    }

    if (chance <= 0 || Math.random() >= chance) return null;

    const boss = SECRET_BOSSES[Math.floor(Math.random() * SECRET_BOSSES.length)];
    const bossPartyPower = snapshot.reduce((s, m) => s + m.power, 0);
    const bossQuestPower = (questDef.recommendedPower || 15) * boss.powerMult;
    const bossRatio = bossPartyPower / Math.max(1, bossQuestPower);
    const bossSuccess = Math.random() < Math.min(0.90, Math.max(0.10, bossRatio * 0.4 + 0.3));

    // Pick one random party member to receive the unique reward
    const recipient = snapshot[Math.floor(Math.random() * snapshot.length)];
    const recipientMember = getMember(recipient.id);
    const classReward = recipientMember ? CLASS_UNIQUE_REWARDS[recipientMember.class] : null;

    return {
      boss,
      success: bossSuccess,
      goldBonus: bossSuccess ? Math.floor(questDef.goldReward.max * boss.goldMult) : 0,
      expBonus: bossSuccess ? Math.floor(questDef.expReward.max * boss.expMult) : 0,
      recipientId: recipient.id,
      recipientName: recipient.name,
      classReward: bossSuccess ? classReward : null,
    };
  }

  // ── Quest History ─────────────────────────────────────────────────────────

  function addToHistory(questDef, result, levelUps, partySnapshot, combatStatsData) {
    if (!state.questHistory) state.questHistory = [];

    // Build compact party summary with before/after HP
    const partySummary = (partySnapshot || []).map(snap => {
      return {
        id: snap.id,
        name: snap.name,
        class: snap.class,
        level: snap.level,
        maxHp: snap.stats.maxHp || 100,
      };
    });

    state.questHistory.unshift({
      questTitle: questDef.title,
      questRank: questDef.rank,
      questId: questDef.id,
      environment: questDef.environment || null,
      enemies: questDef.enemies || [],
      difficulty: questDef.difficulty || 0,
      recommendedPower: questDef.recommendedPower || 0,
      rarity: questDef.rarity || 'common',
      subTier: questDef.subTier || null,
      success: result.success,
      partyPower: result.partyPower || 0,
      questPower: result.questPower || 0,
      goldEarned: result.goldEarned,
      expEarned: result.expEarned,
      rankPoints: result.rankPoints,
      loot: result.loot,
      activatedSkills: result.activatedSkills,
      secretBoss: result.secretBoss || null,
      levelUps,
      narrative: result.narrative,
      partySummary,
      combatStats: combatStatsData || [],
      timestamp: Date.now(),
    });
    // Keep last 50
    if (state.questHistory.length > 50) state.questHistory.pop();
  }

  // ── Engine ─────────────────────────────────────────────────────────────────

  // Event-based quest system: quests run until combat resolves (all enemies or party die).
  // EVENT_INTERVAL_MS is the time between revealing each combat event.
  const EVENT_INTERVAL_MS = 1500; // 1.5 seconds per event

  function startQuest(questId, opts) {
    const manual = !!(opts && opts.battleMode === 'manual');
    if (manual && state.autoRun) return { ok: false, reason: 'Stop Auto-Battle before starting a manual battle.' };
    // Try generated quest first, then fall back to static
    const quest = getGeneratedQuest(questId) || getQuest(questId);
    if (!quest) return { ok:false, reason:'Quest not found' };
    const check = canTakeQuest(questId);
    if (!check.ok) return check;
    const snapshot = buildPartySnapshot();

    state.guild.activeQuest = {
      questId, startedAt: Date.now(),
      eventCount: 0, // set by UI when combat sim is built
      partySnapshot: snapshot,
      questData: quest,
    };

    if (manual) {
      Object.assign(state.guild.activeQuest, {
        battleMode: 'manual',
        manualDecisions: [],
        manualAutoRest: false,
        pausedMs: 0,
        awaitingInput: false,
        simEnv: captureSimEnv(questId, snapshot),
      });
    }
    logEvent(`Party departed for: ${quest.title}`);
    save();
    return { ok:true };
  }

  // Called by the UI after the combat simulation is built
  function setQuestEventCount(count, intervalMs, decisiveIndex, fastForwardMs, awaiting) {
    if (state.guild.activeQuest) {
      state.guild.activeQuest.eventCount = count;
      state.guild.activeQuest.eventIntervalMs = intervalMs || EVENT_INTERVAL_MS;
      state.guild.activeQuest.decisiveIndex = (decisiveIndex != null) ? decisiveIndex : (count - 1);
      state.guild.activeQuest.fastForwardMs = fastForwardMs || 80;
      state.guild.activeQuest.awaitingInput = !!awaiting;
    }
  }

  function startAutoRun(strategy, count, rank) {
    state.autoRun = { strategy, remaining: count, total: count, rank };
    // Pick first quest and start it
    const quest = pickQuestByStrategy(rank, strategy);
    if (!quest) {
      state.autoRun = null;
      return { ok: false, reason: 'No quests available for this rank.' };
    }
    const result = startQuest(quest.id);
    if (!result.ok) {
      state.autoRun = null;
      return result;
    }
    // Decrement since we just started one
    state.autoRun.remaining--;
    return { ok: true };
  }

  function stopAutoRun() {
    if (state.autoRun) {
      logEvent('Auto-run stopped.');
      state.autoRun = null;
      save();
    }
  }

  function _getEventInterval() {
    const aq = state.guild.activeQuest;
    return (aq && aq.eventIntervalMs) || EVENT_INTERVAL_MS;
  }

  // Total wall-clock ms needed to play the full event log given fast-forward pacing.
  function _totalPlaybackMs(aq) {
    if (!aq || !aq.eventCount) return 0;
    const interval = _getEventInterval();
    const decisive = (aq.decisiveIndex != null) ? aq.decisiveIndex : (aq.eventCount - 1);
    const ff = aq.fastForwardMs || 80;
    const normalMs = (decisive + 1) * interval;
    const trailingEvents = Math.max(0, aq.eventCount - decisive - 1);
    return normalMs + trailingEvents * ff;
  }

  function questEventsRevealed() {
    if (!state.guild.activeQuest) return 0;
    const aq = state.guild.activeQuest;
    if (aq.battleMode === 'manual') {
      const _ivl = _getEventInterval();
      return Math.min(aq.eventCount || 1, Math.max(1, Math.floor(questElapsedMs() / _ivl) + 1));
    }
    const elapsed = Date.now() - aq.startedAt;
    const interval = _getEventInterval();
    const decisive = (aq.decisiveIndex != null) ? aq.decisiveIndex : ((aq.eventCount || 1) - 1);
    const ff = aq.fastForwardMs || 80;
    const decisiveTime = (decisive + 1) * interval;
    if (elapsed <= decisiveTime) {
      return Math.max(1, Math.floor(elapsed / interval) + 1);
    }
    const extra = Math.floor((elapsed - decisiveTime) / ff);
    return decisive + 1 + extra;
  }

  function questTimeRemaining() {
    if (!state.guild.activeQuest) return 0;
    const aq = state.guild.activeQuest;
    if (!aq.eventCount) return 99;
    const totalMs = _totalPlaybackMs(aq);
    return Math.max(0, Math.ceil((aq.startedAt + totalMs - Date.now()) / 1000));
  }

  function questProgress() {
    if (!state.guild.activeQuest) return 0;
    const aq = state.guild.activeQuest;
    if (!aq.eventCount) return 0;
    const revealed = questEventsRevealed();
    if (aq.battleMode === 'manual' && !isQuestComplete()) return Math.min(0.88, revealed / (revealed + 8));
    return Math.min(1, revealed / aq.eventCount);
  }

  function isQuestComplete() {
    if (!state.guild.activeQuest) return false;
    const aq = state.guild.activeQuest;
    if (!aq.eventCount) return false;
    if (aq.battleMode === 'manual' && aq.awaitingInput) return false;
    return questEventsRevealed() >= aq.eventCount;
  }

  function finishQuest() {
    {
      const _maq = state.guild.activeQuest;
      if (_maq && _maq.battleMode === 'manual' && _maq.awaitingInput) return;
    }
    if (!state.guild.activeQuest) return;
    const aq = state.guild.activeQuest;
    const quest = aq.questData || getGeneratedQuest(aq.questId) || getQuest(aq.questId);
    if (!quest) { state.guild.activeQuest = null; return; }

    const result = resolveQuest(quest, aq.partySnapshot);

    // Roll for secret boss encounter
    const secretBoss = rollSecretBoss(quest, aq.partySnapshot);
    if (secretBoss) {
      result.secretBoss = secretBoss;
      result.goldEarned += secretBoss.goldBonus;
      logEvent(`Secret boss found: ${secretBoss.boss.icon} ${secretBoss.boss.name}!`);
      if (secretBoss.success && secretBoss.classReward) {
        const recipient = getMember(secretBoss.recipientId);
        if (recipient) {
          // Apply permanent stat boost
          for (const [stat, val] of Object.entries(secretBoss.classReward.statBoost)) {
            recipient.stats[stat] = (recipient.stats[stat] || 0) + val;
          }
          if (recipient.stats.maxHp && recipient.stats.hp) {
            recipient.stats.hp = Math.min(recipient.stats.hp, recipient.stats.maxHp);
          }
          logEvent(`${secretBoss.recipientName} gained ${secretBoss.classReward.name}!`);
        }
        if (!state.partySynergy) state.partySynergy = { totalQuestsAsTeam: 0, lastPartyHash: null, bonusesUnlocked: [], secretBossesFound: 0 };
        state.partySynergy.secretBossesFound++;
      }
    }

    state.gold += result.goldEarned;
    const rankUp = addRankPoints(result.rankPoints);

    const levelUps = [];
    const skillGains = [];
    for (const snap of aq.partySnapshot) {
      const gained = addExp(snap.id, result.expEarned + (secretBoss ? secretBoss.expBonus : 0));
      levelUps.push(...gained.levelUps);
      skillGains.push(...gained.skillGains);
    }

    for (const drop of result.loot) {
      addToInventory(drop.itemId, drop.quantity);
    }

    let synergyUnlocks = [];
    if (result.success) {
      state.guild.completedQuests.push(aq.questId);
      for (const snap of aq.partySnapshot) {
        const m = getMember(snap.id);
        if (m) {
          m.questsCompleted = (m.questsCompleted || 0) + 1;
        }
      }
      // Update party synergy
      synergyUnlocks = updatePartySynergy();
    }

    logEvent(result.success ? `Quest complete: ${quest.title} (+${result.goldEarned}g)` : `Quest failed: ${quest.title}`);

    // Grab combat stats, debug info, and full event log from the simulation before it resets
    const combatStatsData = getCombatStats() || [];
    const combatEventsData = getSimEvents() || [];
    const combatDebugData = getCombatDebug() || null;

    // Add to quest history
    addToHistory(quest, result, levelUps, aq.partySnapshot, combatStatsData);

    state.pendingResults = { quest, result, levelUps, rankUp, synergyUnlocks, skillGains, combatStats: combatStatsData, combatEvents: combatEventsData, combatDebug: combatDebugData, resolvedAt: Date.now() };
    state.guild.activeQuest = null;

    // Refresh quest board for this rank on completion
    refreshQuestBoard(quest.rank, true);

    // Tick shop quest counter — shop restocks every 2 completed quests
    tickShopQuestCounter();

    // Handle auto-run (strategy-based)
    // The actual decrement + next-quest start happens in ui.js when the user
    // dismisses the results modal.  Here we only cancel on failure / injury.
    if (state.autoRun && result.success) {
      const allAlive = [state.player, ...getActiveMembers()].every(m =>
        m.stats.hp > effectiveStats(m).maxHp * 0.25
      );
      if (!allAlive) {
        logEvent('Auto-run cancelled: party too injured.');
        state.autoRun = null;
      }
    } else if (state.autoRun && !result.success) {
      logEvent('Auto-run cancelled: quest failed.');
      state.autoRun = null;
    }

    save();
  }

  function captureSimEnv(questId, snapshot) {
    const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
    const auras = getPartyAuras();
    const env = {
      dmgBonus: getDmgBonus(questId),
      dmgReduction: getDmgReduction(questId),
      atkSpeedBonus: getAtkSpeedBonus(questId),
      healBonus: getHealBonus(questId),
      talents: ((state.guildLegacy && state.guildLegacy.talents) || []).slice(),
      auras: clone(auras),
      members: {},
    };
    for (const snap of snapshot) {
      const m = getMember(snap.id);
      if (!m) continue;
      env.members[snap.id] = {
        eff: clone(effectiveStats(m, auras)),
        skills: getActiveMemberSkills(snap.id).slice(),
        equipment: clone(m.equipment || {}),
      };
    }
    return env;
  }
  function questElapsedMs() {
    const aq = state.guild.activeQuest;
    if (!aq) return 0;
    return Math.max(0, Date.now() - aq.startedAt - (aq.pausedMs || 0));
  }
  function setBattleMode(mode) {
    state.battleMode = mode === 'manual' ? 'manual' : 'auto';
    save();
  }
  function resolveIdle() {
    if (!state.guild.activeQuest) return;
    if (isQuestComplete()) finishQuest();
  }

  // ── Tower Climb ─────────────────────────────────────────────────────────

  function towerCanEnter() {
    if (!isTowerUnlocked(state.guild.rank)) return { ok: false, reason: 'Requires S Rank to enter the Tower.' };
    if (state.guild.activeQuest) return { ok: false, reason: 'Party is currently on a quest.' };
    if (state.tower && state.tower.active) return { ok: false, reason: 'Already in the Tower.' };
    return { ok: true };
  }

  function towerEnter() {
    const check = towerCanEnter();
    if (!check.ok) return check;

    if (!state.tower) state.tower = getDefaultTowerState();

    const snapshot = buildPartySnapshot();
    state.tower.active = {
      floor: 1,
      startedAt: Date.now(),
      partySnapshot: snapshot,
      atRest: false,
      floorsCleared: 0,
      accumulatedGold: 0,
      accumulatedExp: 0,
    };
    state.tower.totalRuns = (state.tower.totalRuns || 0) + 1;

    // Start the first floor as a quest
    const floorQuest = generateFloorQuest(1);
    state.guild.activeQuest = {
      questId: floorQuest.id,
      startedAt: Date.now(),
      eventCount: 0,
      partySnapshot: snapshot,
      questData: floorQuest,
    };

    logEvent('The party enters the Endless Tower...');
    save();
    return { ok: true };
  }

  function towerAdvanceFloor() {
    if (!state.tower || !state.tower.active) return { ok: false, reason: 'Not in the Tower.' };
    if (state.guild.activeQuest) return { ok: false, reason: 'Floor battle still in progress.' };

    const tower = state.tower.active;
    tower.floor++;

    // Check for rest floor
    if (isRestFloor(tower.floor - 1)) {
      // The party just cleared a rest checkpoint floor — show rest option
      tower.atRest = true;
      logEvent(`Floor ${tower.floor - 1} cleared! Rest room reached.`);
      save();
      return { ok: true, rest: true, floor: tower.floor - 1 };
    }

    // Start the next floor combat
    const snapshot = buildPartySnapshot();
    tower.partySnapshot = snapshot;
    const floorQuest = generateFloorQuest(tower.floor);

    state.guild.activeQuest = {
      questId: floorQuest.id,
      startedAt: Date.now(),
      eventCount: 0,
      partySnapshot: snapshot,
      questData: floorQuest,
    };

    logEvent(`Ascending to floor ${tower.floor}...`);
    save();
    return { ok: true, rest: false, floor: tower.floor };
  }

  function towerContinueFromRest() {
    if (!state.tower || !state.tower.active || !state.tower.active.atRest) {
      return { ok: false, reason: 'Not at a rest room.' };
    }
    state.tower.active.atRest = false;

    // Heal party partially at rest room (50% of missing HP)
    const activeMembers = getActiveMembers();
    const allMembers = [state.player, ...activeMembers];
    for (const m of allMembers) {
      const eff = effectiveStats(m);
      const missing = eff.maxHp - m.stats.hp;
      if (missing > 0) {
        m.stats.hp = Math.min(eff.maxHp, m.stats.hp + Math.floor(missing * 0.5));
      }
    }

    // Start the next floor
    return towerAdvanceFloor();
  }

  function towerExit(voluntary = true) {
    if (!state.tower || !state.tower.active) return { ok: false, reason: 'Not in the Tower.' };

    const tower = state.tower.active;
    const floorsCleared = tower.floorsCleared;

    // Calculate loot
    const rewards = calculateTowerLoot(floorsCleared);

    // Update best floor record
    if (floorsCleared > (state.tower.bestFloor || 0)) {
      state.tower.bestFloor = floorsCleared;
      state.tower.bestParty = tower.partySnapshot.map(m => ({
        name: m.name, class: m.class, level: m.level,
      }));
    }

    // Apply rewards
    state.gold += rewards.gold;
    const rankUp = addRankPoints(rewards.rankPoints);

    const levelUps = [];
    const skillGains = [];
    for (const snap of tower.partySnapshot) {
      const gained = addExp(snap.id, rewards.exp);
      levelUps.push(...gained.levelUps);
      skillGains.push(...gained.skillGains);
    }

    for (const drop of rewards.loot) {
      addToInventory(drop.itemId, drop.quantity);
    }

    // Set pending results for the recap screen
    state.pendingResults = {
      quest: {
        title: `Endless Tower — Floor ${floorsCleared}`,
        rank: 'S',
        boss: false,
        raidBoss: false,
        towerRun: true,
        towerFloor: floorsCleared,
        environment: { name: 'The Endless Tower', icon: '🗼', mood: 'dungeon' },
      },
      result: {
        success: voluntary,
        partyPower: tower.partySnapshot.reduce((s, m) => s + m.power, 0),
        questPower: 0,
        ratio: 0,
        goldEarned: rewards.gold,
        expEarned: rewards.exp,
        rankPoints: rewards.rankPoints,
        loot: rewards.loot,
        narrative: voluntary
          ? `The party returns from floor ${floorsCleared} of the Endless Tower, laden with treasures.`
          : `The party was defeated on floor ${floorsCleared + 1}. Their tower run ends here.`,
        activatedSkills: [],
        towerRun: true,
        towerFloor: floorsCleared,
        bestFloor: state.tower.bestFloor,
      },
      levelUps,
      rankUp,
      synergyUnlocks: [],
      skillGains,
      combatStats: [],
      combatEvents: [],
      combatDebug: null,
      resolvedAt: Date.now(),
    };

    logEvent(voluntary
      ? `Tower run complete! Reached floor ${floorsCleared}.`
      : `Defeated in the Tower on floor ${floorsCleared + 1}.`);

    // Clear tower active state
    state.tower.active = null;
    state.guild.activeQuest = null;
    save();

    return { ok: true, floorsCleared, rewards };
  }

  function finishTowerFloor() {
    if (!state.tower || !state.tower.active) return;
    if (!state.guild.activeQuest) return;
    if (!isQuestComplete()) return;

    const aq = state.guild.activeQuest;
    const quest = aq.questData;
    const result = resolveQuest(quest, aq.partySnapshot);

    if (!result.success) {
      // Party defeated — end the tower run
      towerExit(false);
      return;
    }

    // Floor cleared — accumulate rewards
    const tower = state.tower.active;
    tower.floorsCleared = tower.floor;
    tower.accumulatedGold += result.goldEarned;
    tower.accumulatedExp += result.expEarned;

    // Apply per-floor XP for level progression during the run
    for (const snap of aq.partySnapshot) {
      addExp(snap.id, Math.floor(result.expEarned * 0.3)); // 30% of floor exp during run
    }

    // Clear the active quest (floor done)
    state.guild.activeQuest = null;

    // Floor 100 (apex) cleared — tower conquered! End the run as victory.
    if (tower.floor >= 100) {
      logEvent('The Architect falls. The tower is conquered!');
      towerExit(true);
      return;
    }

    // Check for rest floor
    if (isRestFloor(tower.floor)) {
      tower.atRest = true;
      logEvent(`Floor ${tower.floor} cleared! A rest room appears.`);
    } else {
      // Auto-advance to next floor
      const nextFloor = tower.floor + 1;
      tower.floor = nextFloor;
      const snapshot = buildPartySnapshot();
      tower.partySnapshot = snapshot;
      const floorQuest = generateFloorQuest(nextFloor);

      state.guild.activeQuest = {
        questId: floorQuest.id,
        startedAt: Date.now(),
        eventCount: 0,
        partySnapshot: snapshot,
        questData: floorQuest,
      };
    }

    save();
  }

  function getTowerState() {
    if (!state.tower) state.tower = getDefaultTowerState();
    return state.tower;
  }

  let tickInterval = null;
  let saveInterval = null;

  function startTick(onTick) {
    tickInterval = setInterval(() => {
      try {
        const now = Date.now();
        const rawElapsed = (now - state.lastTick) / 1000;
        state.lastTick = now;
        // Cap elapsed to 2s so idle-time doesn't instantly full-heal the party.
        // This makes HP recovery visible tick-by-tick after returning from a quest.
        const elapsed = Math.min(rawElapsed, 2);
        healTick(elapsed);
        if (state.guild.activeQuest && isQuestComplete()) {
          // Tower mode: handle floor completion differently
          if (state.tower && state.tower.active) {
            finishTowerFloor();
          } else {
            finishQuest();
          }
        }
        refreshShopIfNeeded();
        if (onTick) onTick();
      } catch (err) {
        console.error('[GameTick] Error in game tick:', err);
      }
    }, 1000);

    saveInterval = setInterval(save, 60000);
  }

  function stopTick() {
    clearInterval(tickInterval);
    clearInterval(saveInterval);
  }

  // ── Public surface ─────────────────────────────────────────────────────────

  let state = null;

  return {
    get state() { return state; },
    set state(s) { state = s; },

    newGame(name, cls) { state = newGameState(name, cls); refreshShop(); save(); },
    save, load, hasSave, deleteSave,

    // Queries
    questTimeRemaining, questProgress, questEventsRevealed, isQuestComplete,
    setQuestEventCount, completionCount, canTakeQuest,
    totalPartyPower, buildPartySnapshot, getMember, getActiveMembers, getActiveMemberSkills,
    effectiveStats, getPartyAuras, memberPower, shopRefreshMs, shopQuestsUntilRefresh, getRushRestockCost,
    getInventoryItem: (itemId) => state.inventory.find(e => e.itemId === itemId),

    // Quest Board
    getQuestBoardQuests, refreshQuestBoard, questBoardRefreshMs, getGeneratedQuest,
    getPartyStrength,

    // Party Synergy
    getMaxAutoRun, getSecretBossChance,
    getGoldXpBonus, getDmgBonus, getDmgReduction, getAtkSpeedBonus, getHealBonus, getItemFind, getRpBonus,
    SYNERGY_THRESHOLDS, RANK_THRESHOLDS,

    // Auto-run
    pickQuestByStrategy, startAutoRun, stopAutoRun,

    // Mutations
    logEvent, addRankPoints, addExp, addToInventory, removeFromInventory,
    healTick, recruitMember, dismissMember, setActive, equipItem, unequipItem,
    setHeroSpec, respecHeroSpec, getRespecCost,
    refreshShop, buyItem, sellItem, sellAllItems, toggleKeepItem, upgradeShop, canUpgradeShop, getShopUpgradeCost, getShopUpgradeRankReq, getShopRarityWeights, getShopBonusRanks, getShopEffectiveRankIndex, rushRestock,
    expandParty, getPartyExpansionCost, getMaxPartySize,

    // Engine
    startQuest, finishQuest, resolveIdle, startTick, stopTick, questElapsedMs, setBattleMode,

    // Tower Climb
    towerCanEnter, towerEnter, towerContinueFromRest, towerExit, getTowerState,
    finishTowerFloor, isTowerUnlocked: () => isTowerUnlocked(state.guild.rank),

    // Guild Legacy & Talents
    getLegacyBonuses, LEGACY_RP_PER_LEVEL, LEGACY_TALENTS,
    PLAYER_LEVEL_CAP, LEGACY_LEVEL_CAP,
    getLegacyTalentPoints, canPurchaseTalent, purchaseTalent, hasTalent, resetTalents,

    // Save Management
    exportSave, importSave,
  };
})();

export default Game;
