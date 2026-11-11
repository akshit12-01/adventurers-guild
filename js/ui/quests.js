import Game from '../game.js';
import { RANK_ORDER, getQuest, getItem, getClass, getItemRarity, CLASSES, rankIndex } from '../data.js';
import { rankTag, fmtTime, timeAgo, showToast } from './helpers.js';
import { generateCombatLog, getCombatSnapshot, getQuestPhase, getPhases, resetCombatLog, getSimInfo, getPendingDecision, submitManualChoice, autoResolveManualBattle } from './combatlog.js';
import { getQuestDifficultyTier, DIFFICULTY_TIERS } from '../questgen.js';
import { esc, rankCss } from '../util.js';

let questRankFilter = 'F';
let selectedQuestId = null;
let questView = 'board'; // 'board' | 'active' | 'history' | 'synergy'
let expandedHistoryIdx = null; // which history entry is expanded

export function getQuestRankFilter() { return questRankFilter; }

export function resetQuestsState() {
  questRankFilter = 'F';
  selectedQuestId = null;
  questView = 'board';
  expandedHistoryIdx = null;
  resetCombatLog();
}

// ── Main Render ─────────────────────────────────────────────────────────

export function renderQuests(setTabCallback) {
  const s = Game.state;
  const el = document.getElementById('tab-quests');

  // If there's an active quest, show active view
  if (s.guild.activeQuest) {
    questView = 'active';
  } else if (questView === 'active') {
    questView = 'board';
  }

  // Tab sub-navigation
  const tabs = `
    <div class="quest-tabs">
      <button class="quest-tab-btn${questView === 'board' || questView === 'active' ? ' active' : ''}" data-view="board">
        ${s.guild.activeQuest ? '⚔ Active Quest' : '📋 Quest Board'}
      </button>
      <button class="quest-tab-btn${questView === 'history' ? ' active' : ''}" data-view="history">
        📜 History
      </button>
      <button class="quest-tab-btn${questView === 'synergy' ? ' active' : ''}" data-view="synergy">
        🤝 Party Synergy
      </button>
    </div>
  `;

  let content = '';
  if (questView === 'active' && s.guild.activeQuest) {
    content = renderActiveQuestView(s);
  } else if (questView === 'history') {
    content = renderQuestHistory(s);
  } else if (questView === 'synergy') {
    content = renderPartySynergy(s);
  } else {
    content = renderQuestBoard(s);
  }

  el.innerHTML = tabs + content;
  bindEvents(el, setTabCallback);
  if (s.guild.activeQuest) updateManualPanel(s.guild.activeQuest);
}

// ── Live quest update (lightweight DOM patches) ─────────────────────────

// Fast visual update for combat — called at 250ms from the main loop
// so event reveals stay smooth regardless of event interval timing.
export function tickUpdateCombatVisuals() {
  const s = Game.state;
  if (!s.guild.activeQuest) return;
  const aq = s.guild.activeQuest;

  // Ensure event count is set from the sim
  if (!aq.eventCount) {
    const simInfo = getSimInfo();
    if (simInfo) Game.setQuestEventCount(simInfo.eventCount, simInfo.intervalMs, simInfo.decisiveIndex, simInfo.fastForwardMs, simInfo.awaitingInput);
  }

  // Phase tracker (progress bar removed — fight plays to completion)
  const progress = Game.questProgress();
  const phase = getQuestPhase(progress);
  updateManualPanel(aq);
  const phaseEl = document.getElementById('aq-phase-label');
  if (phaseEl) phaseEl.textContent = `${phase.icon} ${phase.label}`;

  const phases = getPhases();
  phases.forEach(p => {
    const dot = document.getElementById(`aq-phase-${p.id}`);
    if (dot) {
      const isActive = p.id === phase.id;
      const isPast = phases.indexOf(p) < phases.indexOf(phase);
      dot.className = `aq-phase-dot${isActive ? ' active' : ''}${isPast ? ' done' : ''}`;
    }
  });

  // Append new combat log entries
  const logContainer = document.getElementById('aq-combat-log');
  if (logContainer) {
    const log = generateCombatLog();
    const existingCount = logContainer.children.length;
    if (log.length > existingCount) {
      for (let i = existingCount; i < log.length; i++) {
        const entry = log[i];
        const div = document.createElement('div');
        div.className = `combat-log-entry log-${entry.type}`;
        div.innerHTML = `<span class="log-icon">${entry.icon}</span><span class="log-text">${entry.text}</span>`;
        div.style.animation = 'slideUp 0.3s ease-out';
        logContainer.appendChild(div);
      }
      logContainer.scrollTop = logContainer.scrollHeight;
    }

    // Update live HP bars from combat snapshot
    const snap = getCombatSnapshot();
    if (snap) {
      // Patch party HP bars (with death indicator)
      snap.party.forEach(p => {
        const el = document.querySelector(`.aq-party-member[data-member-id="${p.id}"]`);
        if (!el) return;
        const dead = p.hp <= 0;
        const hpPct = dead ? 0 : Math.round((p.hp / Math.max(1, p.maxHp)) * 100);
        const hpColor = dead ? 'var(--text-muted)' : hpPct > 60 ? 'var(--green)' : hpPct > 30 ? 'var(--gold)' : 'var(--red)';
        const fill = el.querySelector('.aq-hp-fill');
        if (fill) { fill.style.width = hpPct + '%'; fill.style.background = hpColor; }
        const text = el.querySelector('.aq-hp-text');
        if (text) text.textContent = dead ? '💀 KO' : `${p.hp}/${p.maxHp}`;
        el.classList.toggle('aq-member-dead', dead);
        const sigil = el.querySelector('.aq-party-sigil');
        if (sigil && dead && sigil.textContent !== '💀') sigil.textContent = '💀';
        // Live-update buff indicators
        const buffs = p.buffs || [];
        let buffRow = el.querySelector('.aq-buff-row');
        if (buffs.length > 0) {
          const buffHtml = buffs.map(b => {
            const cdClass = b.cooldown ? ' buff-cd' : '';
            return `<span class="aq-buff-pip${cdClass}" title="${b.label}: ${b.desc}">${b.icon}</span>`;
          }).join('');
          if (!buffRow) {
            buffRow = document.createElement('div');
            buffRow.className = 'aq-buff-row';
            el.appendChild(buffRow);
          }
          buffRow.innerHTML = buffHtml;
        } else if (buffRow) {
          buffRow.remove();
        }
      });

      // Patch enemy HP bars (and add new enemies for reinforcements)
      const enemyStrip = document.querySelector('.aq-enemy-strip');
      if (enemyStrip) {
        snap.enemies.forEach(e => {
          let el = enemyStrip.querySelector(`[data-enemy-id="${e.id}"]`);
          if (!el) {
            // New reinforcement — add it
            el = document.createElement('div');
            el.className = 'aq-enemy-card reinforcement';
            el.dataset.enemyId = e.id;
            el.style.animation = 'slideUp 0.3s ease-out';
            el.innerHTML = `<div class="aq-enemy-icon">👹</div>
              <div class="aq-enemy-info">
                <div class="aq-enemy-name">${e.name} <span class="aq-reinforce-tag">NEW</span></div>
                <div class="aq-hp-bar enemy"><div class="aq-hp-fill" style="width:100%;background:var(--red)"></div></div>
                <div class="aq-hp-text">${e.hp}/${e.maxHp}</div>
              </div>`;
            enemyStrip.appendChild(el);
          }
          const dead = e.hp <= 0 || !e.alive;
          const hpPct = Math.round((e.hp / Math.max(1, e.maxHp)) * 100);
          const hpColor = dead ? 'var(--text-muted)' : hpPct > 50 ? 'var(--red)' : hpPct > 25 ? 'var(--orange)' : 'var(--gold)';
          el.classList.toggle('defeated', dead);
          el.classList.toggle('debuffed', (e.debuffs || []).length > 0);
          const icon = el.querySelector('.aq-enemy-icon');
          if (icon) icon.textContent = dead ? '💀' : '👹';
          const fill = el.querySelector('.aq-hp-fill');
          if (fill) { fill.style.width = (dead ? 0 : hpPct) + '%'; fill.style.background = hpColor; }
          const text = el.querySelector('.aq-hp-text');
          if (text) text.textContent = dead ? 'Defeated' : `${e.hp}/${e.maxHp}`;
          // Live-update debuff indicators
          const debuffs = e.debuffs || [];
          const nameEl = el.querySelector('.aq-enemy-name');
          if (nameEl) {
            let debuffRow = nameEl.querySelector('.aq-debuff-row');
            if (debuffs.length > 0) {
              const debuffHtml = debuffs.map(d =>
                `<span class="aq-debuff-pip" title="${d.label}: ${d.desc}">${d.icon}<span class="aq-debuff-rounds">${d.rounds || ''}</span></span>`
              ).join('');
              if (!debuffRow) {
                debuffRow = document.createElement('span');
                debuffRow.className = 'aq-debuff-row';
                nameEl.appendChild(debuffRow);
              }
              debuffRow.innerHTML = debuffHtml;
            } else if (debuffRow) {
              debuffRow.remove();
            }
          }
        });
      }
    }
  }
}

export function tickUpdateQuests() {
  const s = Game.state;

  // Active quest — delegate visuals to the fast updater
  if (s.guild.activeQuest) {
    tickUpdateCombatVisuals();
    return;
  }

  // Quest board view — update the refresh timer text without destroying
  // the refresh button (textContent would wipe child elements).
  const refreshEl = document.getElementById('qb-refresh-timer');
  if (refreshEl) {
    const timerSpan = refreshEl.querySelector('.qb-timer-text');
    if (timerSpan) {
      const refreshMs = Game.questBoardRefreshMs(questRankFilter);
      timerSpan.textContent = refreshMs <= 0
        ? 'New quests available! '
        : `New quests in: ${fmtTime(Math.ceil(refreshMs / 1000))} — `;
    }
  }
}

// ── Active Quest View ───────────────────────────────────────────────────

// ── Manual battle panel ──────────────────────────────────────────────────
let manualPick = null; // { index, skillId } — a single-target move waiting for its target
function sendManualChoice(pending, skillId, targetId) {
  const r = submitManualChoice({ index: pending.index, skillId, targetId });
  manualPick = null;
  if (!r.ok) showToast(r.reason, 'error');
  const host = document.getElementById('aq-manual-panel');
  if (host) host.dataset.key = '';
  tickUpdateCombatVisuals();
}
function updateManualPanel(aq) {
  const host = document.getElementById('aq-manual-panel');
  if (!host) return;
  if (!aq || aq.battleMode !== 'manual') {
    if (host.dataset.key) { host.innerHTML = ''; host.dataset.key = ''; }
    return;
  }
  const pending = getPendingDecision();
  if (!pending) {
    manualPick = null;
    if (host.dataset.key !== 'none') {
      host.innerHTML = aq.manualAutoRest ? '<div class="aq-manual-note">🤖 The party is finishing the battle on its own…</div>' : '';
      host.dataset.key = 'none';
    }
    return;
  }
  if (manualPick && manualPick.index !== pending.index) manualPick = null;
  const caughtUp = Game.questEventsRevealed() >= (aq.eventCount || 0);
  const key = caughtUp ? `ask:${pending.index}:${manualPick ? manualPick.skillId : ''}` : `wait:${pending.index}`;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  if (!caughtUp) {
    host.innerHTML = '<div class="aq-manual-note">⏳ The battle unfolds…</div>';
    return;
  }
  const sel = manualPick ? pending.options.find(o => o.id === manualPick.skillId) : null;
  const skillBtns = pending.options.map(o => {
    const tag = o.kind === 'aoe' ? 'all enemies' : o.kind === 'single' ? 'one enemy' : 'party';
    const cd = o.ready ? '' : ` · cooldown ${o.cd}`;
    return `<button class="btn btn-sm aq-manual-skill${sel && sel.id === o.id ? ' selected' : ''}" data-skill="${esc(o.id)}" ${o.ready ? '' : 'disabled'} title="${esc(o.desc)}">${o.icon} ${esc(o.name)} <span class="aq-manual-tag">${tag}${cd}</span></button>`;
  }).join('');
  let targetRow = '';
  if (sel && sel.kind === 'single') {
    targetRow = `<div class="aq-manual-subhead">Choose a target for ${esc(sel.name)}</div><div class="aq-manual-row">` +
      pending.enemies.map(e => `<button class="btn btn-sm aq-manual-target" data-enemy="${esc(e.id)}">👹 ${e.name} <span class="aq-manual-tag">${e.hp}/${e.maxHp}</span></button>`).join('') +
      '</div>';
  }
  host.innerHTML = `
    <div class="aq-manual-head">🎮 ${pending.memberName}'s turn — choose a ${pending.lane === 'buff' ? 'support move' : 'move'}</div>
    <div class="aq-manual-row">${skillBtns}</div>
    ${targetRow}
    <div class="aq-manual-foot"><button class="btn btn-sm btn-ghost aq-manual-auto">🤖 Auto-resolve the rest</button></div>`;
  host.querySelectorAll('.aq-manual-skill').forEach(btn => {
    btn.addEventListener('click', () => {
      const o = pending.options.find(x => x.id === btn.dataset.skill);
      if (!o || !o.ready) return;
      if (o.kind === 'single' && pending.enemies.length > 1) {
        manualPick = { index: pending.index, skillId: o.id };
        updateManualPanel(aq);
        return;
      }
      sendManualChoice(pending, o.id, o.kind === 'single' ? pending.enemies[0].id : null);
    });
  });
  host.querySelectorAll('.aq-manual-target').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!manualPick) return;
      sendManualChoice(pending, manualPick.skillId, btn.dataset.enemy);
    });
  });
  const autoBtn = host.querySelector('.aq-manual-auto');
  if (autoBtn) {
    autoBtn.addEventListener('click', () => {
      if (!confirm('Let the party finish this battle on its own? You cannot take control back.')) return;
      const r = autoResolveManualBattle();
      if (!r.ok) showToast(r.reason, 'error');
      manualPick = null;
      host.dataset.key = '';
      tickUpdateCombatVisuals();
    });
  }
}
function renderActiveQuestView(s) {
  const aq = s.guild.activeQuest;
  const quest = aq.questData || Game.getGeneratedQuest(aq.questId) || getQuest(aq.questId);
  if (!quest) return '<div class="empty-state">Quest data not found.</div>';

  // Ensure event count is set
  if (!aq.eventCount) {
    const simInfo = getSimInfo();
    if (simInfo) Game.setQuestEventCount(simInfo.eventCount, simInfo.intervalMs, simInfo.decisiveIndex, simInfo.fastForwardMs, simInfo.awaitingInput);
  }

  const progress = Game.questProgress();
  const phase = getQuestPhase(progress);
  const env = quest.environment || { name: 'Unknown', icon: '?', mood: 'dungeon' };
  const phases = getPhases();

  const phaseTracker = phases.map(p => {
    const isActive = p.id === phase.id;
    const isPast = phases.indexOf(p) < phases.indexOf(phase);
    return `<div class="aq-phase-step">
      <div class="aq-phase-dot${isActive ? ' active' : ''}${isPast ? ' done' : ''}" id="aq-phase-${p.id}"></div>
      <span class="aq-phase-name${isActive ? ' active' : ''}">${p.label}</span>
    </div>`;
  }).join('<div class="aq-phase-line"></div>');

  // Get current combat snapshot for live HP bars
  const snap = getCombatSnapshot();

  const partyStrip = aq.partySnapshot.map(m => {
    const cls = getClass(m.class);
    const pSnap = snap ? snap.party.find(p => p.id === m.id) : null;
    const hp = pSnap ? pSnap.hp : (m.stats.hp || m.stats.maxHp);
    const maxHp = pSnap ? pSnap.maxHp : m.stats.maxHp;
    const dead = hp <= 0;
    const hpPct = dead ? 0 : Math.round((hp / Math.max(1, maxHp)) * 100);
    const hpColor = dead ? 'var(--text-muted)' : hpPct > 60 ? 'var(--green)' : hpPct > 30 ? 'var(--gold)' : 'var(--red)';
    // Render buff/cooldown indicators from snapshot
    const buffs = (pSnap && pSnap.buffs) ? pSnap.buffs : [];
    const buffIcons = buffs.map(b => {
      const cdClass = b.cooldown ? ' buff-cd' : '';
      return `<span class="aq-buff-pip${cdClass}" title="${b.label}: ${b.desc}">${b.icon}</span>`;
    }).join('');
    const buffRow = buffs.length > 0 ? `<div class="aq-buff-row">${buffIcons}</div>` : '';
    return `<div class="aq-party-member${dead ? ' aq-member-dead' : ''}" data-member-id="${m.id}">
      <div class="aq-party-header">
        <div class="aq-party-sigil">${dead ? '💀' : cls.sigil}</div>
        <div class="aq-party-info">
          <div class="aq-party-name">${esc(m.name.split(' ')[0])}</div>
          <div class="aq-party-level">${cls.label} Lv.${m.level}</div>
        </div>
      </div>
      <div class="aq-hp-bar"><div class="aq-hp-fill" style="width:${hpPct}%;background:${hpColor}"></div></div>
      <div class="aq-hp-text">${dead ? '💀 KO' : `${hp}/${maxHp}`}</div>
      ${buffRow}
    </div>`;
  }).join('');

  // Enemy cards with HP bars — includes reinforcements from snapshot
  let enemyList = (quest.enemies || ['Monster']).map((name, i) => ({
    id: `enemy_${i}`, name, hp: 100, maxHp: 100, alive: true, isReinforcement: false,
  }));
  if (snap) {
    enemyList = snap.enemies;
  }
  // Role-based styling for boss encounter enemies
  const ROLE_STYLE = {
    boss:     { icon: '👑', border: '#c41e3a', bg: 'rgba(196,30,58,0.12)', label: 'BOSS' },
    raidBoss: { icon: '💀', border: '#8b00ff', bg: 'rgba(139,0,255,0.15)', label: 'RAID' },
    general:  { icon: '⚔',  border: '#ff8c00', bg: 'rgba(255,140,0,0.10)', label: 'GEN' },
    lt:       { icon: '🗡',  border: '#daa520', bg: 'rgba(218,165,32,0.10)', label: 'LT' },
    captain:  { icon: '🛡',  border: '#4a90d9', bg: 'rgba(74,144,217,0.10)', label: 'CPT' },
    raidLt:   { icon: '🗡',  border: '#9b59b6', bg: 'rgba(155,89,182,0.12)', label: 'R-LT' },
    minion:   { icon: '👹', border: '', bg: '', label: '' },
    standard: { icon: '👹', border: '', bg: '', label: '' },
  };
  const enemyCards = enemyList.map(e => {
    const hpPct = Math.round((e.hp / Math.max(1, e.maxHp)) * 100);
    const hpColor = e.hp <= 0 ? 'var(--text-muted)' : hpPct > 50 ? 'var(--red)' : hpPct > 25 ? 'var(--orange)' : 'var(--gold)';
    const dead = e.hp <= 0 || !e.alive;
    const role = e.role || 'standard';
    const rs = ROLE_STYLE[role] || ROLE_STYLE.standard;
    const roleIcon = dead ? '💀' : rs.icon;
    const roleBorder = rs.border ? `border-left:3px solid ${rs.border};` : '';
    const roleBg = rs.bg ? `background:${rs.bg};` : '';
    const roleTag = rs.label ? `<span class="aq-role-tag" style="color:${rs.border};border-color:${rs.border};font-size:0.65em;padding:1px 4px;border:1px solid;border-radius:3px;margin-left:4px;font-weight:700;letter-spacing:0.5px;">${rs.label}</span>` : '';
    // Debuff indicators from snapshot
    const debuffs = (e.debuffs || []);
    const debuffIcons = debuffs.map(d =>
      `<span class="aq-debuff-pip" title="${d.label}: ${d.desc}">${d.icon}<span class="aq-debuff-rounds">${d.rounds || ''}</span></span>`
    ).join('');
    const debuffRow = debuffs.length > 0 ? `<div class="aq-debuff-row">${debuffIcons}</div>` : '';
    return `<div class="aq-enemy-card${dead ? ' defeated' : ''}${e.isReinforcement ? ' reinforcement' : ''}${debuffs.length > 0 ? ' debuffed' : ''}" data-enemy-id="${e.id}" style="${roleBorder}${roleBg}">
      <div class="aq-enemy-icon">${roleIcon}</div>
      <div class="aq-enemy-info">
        <div class="aq-enemy-name">${e.name}${roleTag}${e.isReinforcement ? ' <span class="aq-reinforce-tag">NEW</span>' : ''}${debuffRow}</div>
        <div class="aq-hp-bar enemy"><div class="aq-hp-fill" style="width:${dead ? 0 : hpPct}%;background:${hpColor}"></div></div>
        <div class="aq-hp-text">${dead ? 'Defeated' : `${e.hp}/${e.maxHp}`}</div>
      </div>
    </div>`;
  }).join('');

  const log = generateCombatLog();
  const logEntries = log.map(entry =>
    `<div class="combat-log-entry log-${entry.type}"><span class="log-icon">${entry.icon}</span><span class="log-text">${entry.text}</span></div>`
  ).join('');

  // Auto-run indicator
  let autoRunInfo = '';
  if (s.autoRun && s.autoRun.remaining > 0) {
    const stratIcons = { safe: '🛡', balanced: '⚖', push: '🔥' };
    const stratLabels = { safe: 'Play it Safe', balanced: 'Balanced', push: 'Push Limits' };
    const icon = stratIcons[s.autoRun.strategy] || '⚖';
    const label = stratLabels[s.autoRun.strategy] || 'Balanced';
    autoRunInfo = `<div class="aq-auto-run">${icon} Auto-Battle (${label}): ${s.autoRun.remaining} of ${s.autoRun.total} remaining</div>`;
  }

  return `
    <div class="aq-scene">
      <div class="aq-scene-header mood-${env.mood}">
        <div class="aq-scene-env">
          <span class="aq-scene-icon">${env.icon}</span>
          <span class="aq-scene-name">${env.name}</span>
        </div>
        <div class="aq-scene-quest">
          ${rankTag(quest.rank)}
          <span class="aq-scene-title">${quest.title}</span>
        </div>
        ${autoRunInfo}
      </div>

      <div class="aq-phase-tracker">${phaseTracker}</div>

      <div class="aq-main-content">
        <div class="aq-left-col">
          <div class="aq-phase-status">
            <div class="aq-phase-current" id="aq-phase-label">${phase.icon} ${phase.label}</div>
          </div>
          <div class="aq-party-strip-section">
            <div class="aq-section-label">Party</div>
            <div class="aq-party-strip">${partyStrip}</div>
          </div>
          <div class="aq-enemies-section">
            <div class="aq-section-label">Enemies</div>
            <div class="aq-enemy-strip">${enemyCards}</div>
          </div>
          <div class="aq-rewards-preview">
            <div class="aq-section-label">Potential Rewards</div>
            <div class="aq-rewards-row">
              <span class="aq-reward"><span class="aq-reward-icon">💰</span> ${quest.goldReward.min}–${quest.goldReward.max}g</span>
              <span class="aq-reward"><span class="aq-reward-icon">✦</span> ${quest.expReward.min}–${quest.expReward.max} exp</span>
              <span class="aq-reward"><span class="aq-reward-icon">⭐</span> +${quest.rankPointReward} RP</span>
            </div>
          </div>
        </div>
        <div class="aq-right-col">
          <div class="aq-manual-panel" id="aq-manual-panel"></div>
          <div class="aq-combat-log-section">
            <div class="aq-section-label">Combat Log</div>
            <div class="aq-combat-log" id="aq-combat-log">${logEntries}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Quest Board ─────────────────────────────────────────────────────────

function renderQuestBoard(s) {
  const filterBtns = RANK_ORDER.map(r => {
    const unlocked = rankIndex(s.guild.rank) >= rankIndex(r);
    const active = r === questRankFilter;
    return `<button class="rank-filter-btn rank-${rankCss(r)}${active ? ' active' : ''}${!unlocked ? ' locked' : ''}" data-rank="${r}">${r}</button>`;
  }).join('');

  const unlockedRank = rankIndex(s.guild.rank) >= rankIndex(questRankFilter);
  let questItems = '';
  let refreshTimer = '';

  if (!unlockedRank) {
    questItems = `<div class="empty-state">Requires ${questRankFilter} Rank to view these quests.</div>`;
  } else {
    const quests = Game.getQuestBoardQuests(questRankFilter);
    const partyStrength = Game.getPartyStrength();

    if (quests.length === 0) {
      questItems = `<div class="empty-state">No quests available. Check back soon!</div>`;
    } else {
      questItems = quests.map(q => renderQuestCard(s, q, partyStrength)).join('');
    }

    const refreshMs = Game.questBoardRefreshMs(questRankFilter);
    const timerText = refreshMs > 0 ? `New quests in: ${fmtTime(Math.ceil(refreshMs / 1000))} — ` : '';
    refreshTimer = `<div class="qb-refresh-timer" id="qb-refresh-timer"><span class="qb-timer-text">${timerText}</span><button class="btn btn-sm btn-refresh-board" style="font-size:0.85em;padding:2px 10px;cursor:pointer;">🔄 Refresh Board</button></div>`;
  }

  // Party strength display
  const bm = s.battleMode === 'manual' ? 'manual' : 'auto';
  const battleModePicker = `
        <div class="bm-picker">
          <div class="bm-label">Battle Mode</div>
          <div class="bm-options">
            <button class="btn btn-sm btn-battle-mode${bm === 'auto' ? ' selected' : ''}" data-mode="auto" title="The party fights on its own">🤖 Auto</button>
            <button class="btn btn-sm btn-battle-mode${bm === 'manual' ? ' selected' : ''}" data-mode="manual" title="You choose each move and target">🎮 Manual</button>
          </div>
          ${bm === 'manual' ? '<div class="bm-hint">You pick every attack and buff move (and its target). The battle waits for you. Auto-Battle runs always fight automatically.</div>' : ''}
        </div>`;
  const partyStr = Game.getPartyStrength();

  // Auto-run strategy picker
  const maxRun = Game.getMaxAutoRun();
  const autoRun = s.autoRun;
  let strategyPicker = '';
  if (maxRun >= 2) {
    const runOpts = [2, 5, 10, 20].filter(n => n <= maxRun);
    const strategies = [
      { id: 'safe', icon: '🛡', label: 'Play it Safe', desc: 'Easiest quests' },
      { id: 'balanced', icon: '⚖', label: 'Balanced', desc: 'Moderate difficulty' },
      { id: 'push', icon: '🔥', label: 'Push Limits', desc: 'Hardest quests' },
    ];

    if (autoRun && autoRun.remaining > 0) {
      // Active auto-run — show status + stop button
      const strat = strategies.find(s => s.id === autoRun.strategy) || strategies[1];
      strategyPicker = `
        <div class="ar-picker ar-active">
          <div class="ar-status">
            <span class="ar-status-icon">${strat.icon}</span>
            <span class="ar-status-text">${strat.label}: ${autoRun.remaining} of ${autoRun.total} remaining</span>
          </div>
          <button class="btn btn-sm btn-danger btn-ar-stop">⏹ Stop</button>
        </div>`;
    } else {
      // Show strategy picker
      const stratBtns = strategies.map(st =>
        `<button class="btn btn-sm btn-ar-strategy" data-strategy="${st.id}" title="${st.desc}">${st.icon} ${st.label}</button>`
      ).join('');
      const countBtns = runOpts.map(n =>
        `<button class="btn btn-sm btn-ar-count${n === 2 ? ' selected' : ''}" data-count="${n}">×${n}</button>`
      ).join('');
      strategyPicker = `
        <div class="ar-picker">
          <div class="ar-label">Auto-Battle</div>
          <div class="ar-strategies">${stratBtns}</div>
          <div class="ar-counts">${countBtns}</div>
        </div>`;
    }
  }

  return `
    <div class="qb-header">
      <div class="qb-header-row">
        <div>
          <div class="qb-title">Quest Board</div>
          <div class="qb-subtitle">5 quests per rank — refreshes on quest completion or every 15 min</div>
        </div>
        <div class="qb-party-strength">
          <div class="qb-ps-label">Party Strength</div>
          <div class="qb-ps-value">${Math.round(partyStr)}</div>
        </div>
      </div>
      ${battleModePicker}
      ${strategyPicker}
      ${refreshTimer}
    </div>
    <div class="rank-filter">${filterBtns}</div>
    <div class="quest-list">${questItems}</div>
  `;
}

// ── Quest Card ──────────────────────────────────────────────────────────

function renderQuestCard(s, quest, partyStrength) {
  const check = Game.canTakeQuest(quest.id);
  const completions = Game.completionCount(quest.id);
  const expanded = selectedQuestId === quest.id;

  // Sub-tier badge — authoritative under the §9 rework. Replaces the old
  // ratio-based classifier which saturated at low party strength and lied
  // about toughness once intrinsic rank curves took over.
  const subTier = quest.subTier || 'standard';
  const SUB_TIER_DISPLAY = {
    easy:     { label: 'Easy',     color: '#2ecc71', icon: '◐' },
    standard: { label: 'Standard', color: '#f0c060', icon: '●' },
    hard:     { label: 'Hard',     color: '#e67e22', icon: '◆' },
    brutal:   { label: 'Brutal',   color: '#e74c3c', icon: '✦' },
  };
  const tier = SUB_TIER_DISPLAY[subTier] || SUB_TIER_DISPLAY.standard;

  const isDone = !quest.isRepeatable && completions > 0;
  const isBoss = quest.boss;
  const isRaidBoss = quest.raidBoss;
  const isGemMining = quest.gemMining;
  const cardClass = `quest-card${expanded ? ' selected' : ''}${isDone ? ' done' : ''}${isBoss ? ' quest-boss' : ''}${isRaidBoss ? ' quest-raid' : ''}${isGemMining ? ' quest-gem-mining' : ''}`;
  const env = quest.environment || { name: '???', icon: '?', mood: 'dungeon' };

  // Rarity badge
  const rarity = quest.rarity || 'common';
  const rarityBadge = rarity !== 'common'
    ? `<span class="rarity-badge rarity-${rarity}">${rarity}</span>`
    : '';

  // Special quest type tag
  const typeTag = isBoss
    ? `<span class="quest-type-tag tag-boss">⚠ BOSS</span>`
    : isGemMining
      ? `<span class="quest-type-tag tag-gem-mining">💎 GEM HAUL</span>`
      : '';

  const metaRight = `
    <span class="qc-stat qc-gold" title="Gold reward">💰 ${quest.goldReward.min}–${quest.goldReward.max}</span>
    <span class="qc-stat qc-exp" title="EXP reward">✦ ${quest.expReward.min}–${quest.expReward.max}</span>
    <span class="qc-stat qc-rp" title="Rank points">⭐ ${quest.rankPointReward}</span>
    <span class="qc-stat qc-rec" title="Recommended power">⚔ ${Math.round(quest.recommendedPower)}</span>
    <span class="difficulty-badge" style="background:${tier.color}20;color:${tier.color}">${tier.icon} ${tier.label}</span>
    ${rarityBadge}
    ${completions > 0 ? `<span class="quest-done-badge">×${completions}</span>` : ''}
  `;

  let detail = '';
  if (expanded) {
    const lootEntries = quest.lootTable.map(e => {
      const item = getItem(e.itemId);
      if (!item) return `<span>${e.itemId}</span>`;
      const rarity = getItemRarity(item);
      const classReqStr = item.classReq
        ? item.classReq.map(cid => CLASSES[cid]?.label || cid).join(', ')
        : 'Any class';
      return `<span class="qd-loot-entry"><span style="color:${rarity.color}">${item.name}</span> <span class="item-rarity-badge" style="color:${rarity.color};border-color:${rarity.color}30">${rarity.label}</span> <span class="qd-loot-class-req">${classReqStr}</span></span>`;
    }).join('');

    const powerRatio = partyStrength / Math.max(1, quest.recommendedPower);
    const powerPct = Math.min(100, powerRatio * 50);
    const powerBarColor = tier.color;

    const enemies = (quest.enemies || []).join(', ');

    // Synergy bonuses for repeated quests
    const synergyBonuses = [];
    const goldXp = Game.getGoldXpBonus(quest.id);
    if (goldXp > 0) synergyBonuses.push(`💰 +${Math.round(goldXp * 100)}% Gold/XP`);
    const dmg = Game.getDmgBonus(quest.id);
    if (dmg > 0) synergyBonuses.push(`⚔ +${Math.round(dmg * 100)}% Damage`);
    const spd = Game.getAtkSpeedBonus(quest.id);
    if (spd > 0) synergyBonuses.push(`⚡ +${Math.round(spd * 100)}% ATK Speed`);
    const dmgRed = Game.getDmgReduction(quest.id);
    if (dmgRed > 0) synergyBonuses.push(`🛡 −${Math.round(dmgRed * 100)}% Damage Taken`);
    const heal = Game.getHealBonus(quest.id);
    if (heal > 0) synergyBonuses.push(`💚 +${Math.round(heal * 100)}% Healing`);
    const itemF = Game.getItemFind(quest.id);
    if (itemF > 0) synergyBonuses.push(`🔮 +${Math.round(itemF * 100)}% Item Find`);
    const rpB = Game.getRpBonus(quest.id);
    if (rpB > 0) synergyBonuses.push(`📈 +${Math.round(rpB * 100)}% Rank Points`);
    const synergyInfo = synergyBonuses.length > 0
      ? `<div class="qd-synergy-bonuses">${synergyBonuses.join(' · ')}</div>`
      : '';

    // (Auto-run is now a board-level control, not per-quest)

    let actionRow = '';
    if (!check.ok) {
      actionRow = `<div class="quest-block-reason">${check.reason}</div>`;
    } else {
      actionRow = `<button class="btn btn-success btn-lg btn-send-party" data-quest-id="${quest.id}">⚔ Send Party</button>`;
    }

    detail = `
      <div class="quest-detail">
        <div class="qd-flavor">
          <span class="qd-env-icon">${env.icon}</span>
          <div>
            <div class="qd-env-name">${env.name}</div>
            <div class="quest-description">"${quest.description}"</div>
          </div>
        </div>

        ${enemies ? `<div class="qd-enemies">
          <span class="qd-enemies-label">Threats:</span>
          <span class="qd-enemies-list">${enemies}</span>
        </div>` : ''}

        <div class="qd-rewards-grid">
          <div class="qd-reward-box">
            <div class="qd-reward-val text-gold">${quest.goldReward.min}–${quest.goldReward.max}g</div>
            <div class="qd-reward-label">Gold</div>
          </div>
          <div class="qd-reward-box">
            <div class="qd-reward-val text-cyan">${quest.expReward.min}–${quest.expReward.max}</div>
            <div class="qd-reward-label">Exp / member</div>
          </div>
          <div class="qd-reward-box">
            <div class="qd-reward-val" style="color:var(--purple)">+${quest.rankPointReward}</div>
            <div class="qd-reward-label">Rank pts</div>
          </div>
        </div>

        <div class="qd-power-section">
          <div class="qd-power-header">
            <span>Party Strength: <strong style="color:${powerBarColor}">${Math.round(partyStrength)}</strong></span>
            <span>Recommended: <strong>${Math.round(quest.recommendedPower)}</strong></span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${powerPct}%; background:${powerBarColor}"></div>
          </div>
          <div class="qd-tier-label" style="color:${tier.color}">${tier.icon} ${tier.label} Difficulty</div>
        </div>

        ${synergyInfo}

        <div class="qd-loot">
          <span class="qd-loot-label">Possible Loot:</span>
          <div class="qd-loot-list">${lootEntries}</div>
        </div>

        <div class="qd-actions">
          <span class="qd-repeatable">${quest.isRepeatable ? 'Repeatable' : 'One-time'}</span>
          ${actionRow}
        </div>
      </div>
    `;
  }

  return `
    <div class="${cardClass}">
      <div class="quest-header" data-quest-id="${quest.id}">
        <span class="quest-rank-tag rank-${rankCss(quest.rank)}" style="color:var(--rank-${rankCss(quest.rank)});border-color:var(--rank-${rankCss(quest.rank)})">${quest.rank}</span>
        <span class="qc-env-icon">${env.icon}</span>
        <span class="quest-title">${quest.title}</span>${typeTag}
        <div class="quest-meta">${metaRight}</div>
      </div>
      ${detail}
    </div>
  `;
}

// ── Quest History View ──────────────────────────────────────────────────

function renderQuestHistory(s) {
  const history = s.questHistory || [];

  if (history.length === 0) {
    return `<div class="empty-state">No quest history yet. Complete your first quest to see results here.</div>`;
  }

  const entries = history.map((h, i) => {
    const isExpanded = expandedHistoryIdx === i;

    // Quick stats line (always visible)
    const quickStats = [
      h.goldEarned > 0 ? `<span class="qh-stat text-gold">+${h.goldEarned}g</span>` : '',
      h.expEarned > 0 ? `<span class="qh-stat text-cyan">+${h.expEarned} exp</span>` : '',
      h.rankPoints > 0 ? `<span class="qh-stat" style="color:var(--purple)">+${h.rankPoints} RP</span>` : '',
    ].filter(Boolean).join('');

    const lootCount = (h.loot || []).length;
    const hasSecretBoss = !!h.secretBoss;
    const chevron = isExpanded ? '▾' : '▸';

    // Collapsed summary hints
    const hints = [];
    if (lootCount > 0) hints.push(`${lootCount} item${lootCount > 1 ? 's' : ''}`);
    if (hasSecretBoss) hints.push('Boss!');
    if ((h.levelUps || []).length > 0) hints.push('Level up!');
    const hintText = hints.length > 0 ? `<span class="qh-hints">${hints.join(' · ')}</span>` : '';

    // Expanded detail section
    let detail = '';
    if (isExpanded) {
      // Environment & difficulty
      const env = h.environment;
      const envLine = env ? `<div class="qh-detail-row"><span class="qh-detail-label">Location:</span> <span>${env.icon} ${env.name}</span></div>` : '';

      const enemies = (h.enemies || []);
      const enemiesLine = enemies.length > 0
        ? `<div class="qh-detail-row"><span class="qh-detail-label">Enemies:</span> <span>${enemies.join(', ')}</span></div>`
        : '';

      // Difficulty tier — prefer stored subTier (new system), fall back to
      // ratio-based reconstruction for legacy entries.
      let tierLine = '';
      if (h.subTier) {
        const SUB_TIER_HIST = {
          easy:     { label: 'Easy',     color: '#2ecc71', icon: '◐' },
          standard: { label: 'Standard', color: '#f0c060', icon: '●' },
          hard:     { label: 'Hard',     color: '#e67e22', icon: '◆' },
          brutal:   { label: 'Brutal',   color: '#e74c3c', icon: '✦' },
        };
        const st = SUB_TIER_HIST[h.subTier] || SUB_TIER_HIST.standard;
        const powerNote = (h.questPower && h.partyPower)
          ? ` <span class="qh-detail-sub">(Party ${Math.round(h.partyPower)} vs Quest ${Math.round(h.questPower)})</span>` : '';
        tierLine = `<div class="qh-detail-row"><span class="qh-detail-label">Difficulty:</span> <span style="color:${st.color}">${st.icon} ${st.label}</span>${powerNote}</div>`;
      } else if (h.questPower && h.partyPower) {
        const tier = getQuestDifficultyTier(h.questPower, h.partyPower);
        tierLine = `<div class="qh-detail-row"><span class="qh-detail-label">Difficulty:</span> <span style="color:${tier.color}">${tier.icon} ${tier.label}</span> <span class="qh-detail-sub">(Party ${Math.round(h.partyPower)} vs Quest ${Math.round(h.questPower)})</span></div>`;
      }

      // Rarity
      const rarityLine = h.rarity && h.rarity !== 'common'
        ? `<div class="qh-detail-row"><span class="qh-detail-label">Rarity:</span> <span class="rarity-badge rarity-${h.rarity}">${h.rarity}</span></div>`
        : '';

      // Narrative
      const narrativeLine = h.narrative ? `<div class="qh-detail-narrative">"${h.narrative}"</div>` : '';

      // Combat stats
      let combatStatsHtml = '';
      const cStats = h.combatStats || [];
      if (cStats.length > 0) {
        const maxDmg = Math.max(1, ...cStats.map(c => c.dmgDealt));
        const csRows = cStats.map(c => {
          const cls = getClass(c.class);
          const sigil = cls ? cls.sigil : '?';
          const dmgPct = Math.round((c.dmgDealt / maxDmg) * 100);
          const healDone = c.healingDone > 0 ? `<span class="cs-heal" title="Healing done">⚕${c.healingDone}</span>` : '';
          const healRcvd = (c.healingReceived || 0) > 0 ? `<span class="cs-heal-rcvd" title="Healing received">💚${c.healingReceived}</span>` : '';
          const taken = c.dmgTaken > 0 ? `<span class="cs-taken" title="Damage taken">💔${c.dmgTaken}</span>` : '';
          return `<div class="cs-row">
            <div class="cs-name">${sigil} ${esc(c.name.split(' ')[0])}</div>
            <div class="cs-bar-wrap"><div class="cs-bar" style="width:${dmgPct}%"></div><span class="cs-dmg-val">${c.dmgDealt}</span></div>
            <div class="cs-extras">${healDone}${healRcvd}${taken}</div>
          </div>`;
        }).join('');
        combatStatsHtml = `<div class="qh-detail-section">
          <div class="qh-detail-section-title">Combat Performance</div>
          <div class="cs-header"><span>Member</span><span>Damage Dealt</span><span>⚕ Done · 💚 Rcvd · 💔 Taken</span></div>
          ${csRows}
        </div>`;
      }

      // Loot detail
      let lootHtml = '';
      const loot = h.loot || [];
      if (loot.length > 0) {
        const lootItems = loot.map(d => {
          const item = getItem(d.itemId);
          if (!item) return `<span class="qh-loot-item">${d.itemId}</span>`;
          const rarity = getItemRarity(item);
          const classReqStr = item.classReq
            ? item.classReq.map(cid => CLASSES[cid]?.label || cid).join(', ')
            : 'Any class';
          const qty = d.quantity > 1 ? ` ×${d.quantity}` : '';
          return `<span class="qh-loot-item"><span style="color:${rarity.color}">${item.name}</span>${qty} <span class="item-rarity-badge" style="color:${rarity.color};border-color:${rarity.color}30">${rarity.label}</span> <span class="qh-loot-class-req">${classReqStr}</span></span>`;
        }).join('');
        lootHtml = `<div class="qh-detail-section"><div class="qh-detail-section-title">Loot Obtained</div><div class="qh-loot-grid">${lootItems}</div></div>`;
      }

      // Skills activated — consolidated: count per member's skill, show top uses
      let skillsHtml = '';
      const skills = h.activatedSkills || [];
      if (skills.length > 0) {
        // Count uses per skill per member
        const skillCounts = {};
        for (const a of skills) {
          const key = `${a.memberName}::${a.skill.name}`;
          if (!skillCounts[key]) skillCounts[key] = { name: a.memberName, skill: a.skill.name, icon: a.skill.icon || '•', count: 0 };
          skillCounts[key].count++;
        }
        const sorted = Object.values(skillCounts).sort((a, b) => b.count - a.count);
        const topSkills = sorted.slice(0, 5); // show top 5
        const skillRows = topSkills.map(s =>
          `<div class="highlight-row"><span class="highlight-icon">${s.icon}</span><span class="highlight-label">${esc(s.name)}</span><span class="highlight-value">${esc(s.skill)} — <strong>×${s.count}</strong></span></div>`
        ).join('');
        skillsHtml = `<div class="qh-detail-section"><div class="qh-detail-section-title">Top Skills Used</div>${skillRows}</div>`;
      }

      // Level ups — consolidated per character
      let levelUpsHtml = '';
      const levelUps = h.levelUps || [];
      if (levelUps.length > 0) {
        const byName = {};
        for (const lu of levelUps) {
          if (!byName[lu.name]) byName[lu.name] = [];
          byName[lu.name].push(lu.level);
        }
        const luRows = Object.entries(byName).map(([name, levels]) => {
          const from = Math.min(...levels) - 1;
          const to = Math.max(...levels);
          return `<div class="result-levelup-entry"><span class="levelup-name">⭐ ${esc(name)}</span><span class="levelup-levels">${from} → ${to}</span></div>`;
        }).join('');
        levelUpsHtml = `<div class="qh-detail-section"><div class="qh-detail-section-title">Level Ups</div>${luRows}</div>`;
      }

      // Secret boss
      let secretBossHtml = '';
      if (h.secretBoss) {
        const sb = h.secretBoss;
        secretBossHtml = `
          <div class="qh-detail-section">
            <div class="qh-secret-boss ${sb.success ? 'success' : 'failure'}">
              ${sb.boss.icon} <strong>Secret Boss: ${sb.boss.name}</strong> — ${sb.success ? 'Defeated!' : 'Escaped!'}
              ${sb.success ? `<br>Bonus: +${sb.goldBonus}g, +${sb.expBonus} exp` : ''}
              ${sb.success && sb.classReward ? `<br>${sb.recipientName} gained <strong>${sb.classReward.name}</strong>` : ''}
            </div>
          </div>`;
      }

      detail = `
        <div class="qh-detail">
          ${narrativeLine}
          <div class="qh-detail-grid">
            ${envLine}${enemiesLine}${tierLine}${rarityLine}
          </div>
          ${combatStatsHtml}
          ${lootHtml}
          ${skillsHtml}
          ${levelUpsHtml}
          ${secretBossHtml}
        </div>`;
    }

    return `
      <div class="qh-entry ${h.success ? 'success' : 'failure'}${isExpanded ? ' expanded' : ''}" data-history-idx="${i}">
        <div class="qh-header" data-history-toggle="${i}">
          <div class="qh-title">
            <span class="qh-chevron">${chevron}</span>
            ${rankTag(h.questRank)}
            <span class="qh-quest-name">${h.questTitle}</span>
            <span class="qh-outcome ${h.success ? 'success' : 'failure'}">${h.success ? '✓' : '✗'}</span>
          </div>
          <div class="qh-header-right">
            <div class="qh-stats">${quickStats}</div>
            ${hintText}
            <span class="qh-time">${timeAgo(h.timestamp)}</span>
          </div>
        </div>
        ${detail}
      </div>
    `;
  }).join('');

  return `
    <div class="qh-container">
      <div class="qh-title-bar">
        <div class="qb-title">Quest History</div>
        <div class="qb-subtitle">${history.length} recent quests (max 50) · Click to expand</div>
      </div>
      <div class="qh-list">${entries}</div>
    </div>
  `;
}

// ── Party Synergy View ──────────────────────────────────────────────────

function renderPartySynergy(s) {
  const synergy = s.partySynergy || { totalQuestsAsTeam: 0, bonusesUnlocked: [], secretBossesFound: 0 };
  const thresholds = Game.SYNERGY_THRESHOLDS;

  const bonusList = thresholds.map(t => {
    const unlocked = synergy.bonusesUnlocked.includes(t.id);
    const progress = Math.min(100, (synergy.totalQuestsAsTeam / t.quests) * 100);
    return `
      <div class="syn-bonus ${unlocked ? 'unlocked' : 'locked'}">
        <div class="syn-bonus-header">
          <span class="syn-bonus-name">${unlocked ? '✓' : '🔒'} ${t.label}</span>
          <span class="syn-bonus-req">${synergy.totalQuestsAsTeam}/${t.quests} quests</span>
        </div>
        <div class="syn-bonus-desc">${t.desc}</div>
        ${!unlocked ? `<div class="progress-bar"><div class="progress-fill" style="width:${progress}%; background:var(--cyan)"></div></div>` : ''}
      </div>
    `;
  }).join('');

  const maxRepeat = Game.getMaxAutoRun();
  const secretChance = Game.getSecretBossChance();

  return `
    <div class="syn-container">
      <div class="qb-header">
        <div class="qb-title">Party Synergy</div>
        <div class="qb-subtitle">As your party completes quests together, you unlock permanent bonuses</div>
      </div>

      <div class="syn-stats-row">
        <div class="syn-stat-box">
          <div class="syn-stat-val">${synergy.totalQuestsAsTeam}</div>
          <div class="syn-stat-label">Quests Together</div>
        </div>
        <div class="syn-stat-box">
          <div class="syn-stat-val">${synergy.secretBossesFound}</div>
          <div class="syn-stat-label">Secret Bosses Found</div>
        </div>
        <div class="syn-stat-box">
          <div class="syn-stat-val">${maxRepeat > 0 ? '×' + maxRepeat : '—'}</div>
          <div class="syn-stat-label">Auto-Battle Max</div>
        </div>
        <div class="syn-stat-box">
          <div class="syn-stat-val">${secretChance > 0 ? Math.round(secretChance * 100) + '%' : '—'}</div>
          <div class="syn-stat-label">Secret Boss Chance</div>
        </div>
      </div>

      <div class="syn-bonus-list">${bonusList}</div>
    </div>
  `;
}

// ── Event Binding ───────────────────────────────────────────────────────

function bindEvents(el, setTabCallback) {
  // Tab sub-navigation
  el.querySelectorAll('.quest-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'board' && Game.state.guild.activeQuest) {
        questView = 'active';
      } else {
        questView = view;
      }
      renderQuests(setTabCallback);
    });
  });

  // Rank filter
  el.querySelectorAll('.rank-filter-btn:not(.locked)').forEach(btn => {
    btn.addEventListener('click', () => {
      questRankFilter = btn.dataset.rank;
      selectedQuestId = null;
      renderQuests(setTabCallback);
    });
  });

  // Quest card clicks
  el.querySelectorAll('.quest-header[data-quest-id]').forEach(header => {
    header.addEventListener('click', () => {
      const qid = header.dataset.questId;
      selectedQuestId = selectedQuestId === qid ? null : qid;
      renderQuests(setTabCallback);
    });
  });

  // Send party buttons
  el.querySelectorAll('.btn-send-party[data-quest-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const result = Game.startQuest(btn.dataset.questId, { battleMode: Game.state.battleMode });
      if (result.ok) {
        selectedQuestId = null;
        resetCombatLog();
        questView = 'active';
        renderQuests(setTabCallback);
      } else {
        showToast(result.reason, 'error');
      }
    });
  });

  // Auto-run strategy picker
  let selectedArCount = 2; // default
  el.querySelectorAll('.btn-ar-count').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedArCount = parseInt(btn.dataset.count, 10);
      el.querySelectorAll('.btn-ar-count').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
  el.querySelectorAll('.btn-ar-strategy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const strategy = btn.dataset.strategy;
      // Read count from currently selected count button
      const countBtn = el.querySelector('.btn-ar-count.selected');
      const count = countBtn ? parseInt(countBtn.dataset.count, 10) : selectedArCount;
      const result = Game.startAutoRun(strategy, count, questRankFilter);
      if (result.ok) {
        selectedQuestId = null;
        resetCombatLog();
        questView = 'active';
        renderQuests(setTabCallback);
      } else {
        showToast(result.reason || 'Cannot start auto-battle', 'error');
      }
    });
  });
  // Stop auto-run button
  el.querySelectorAll('.btn-battle-mode').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      Game.setBattleMode(btn.dataset.mode);
      renderQuests(setTabCallback);
    });
  });
  const stopBtn = el.querySelector('.btn-ar-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Game.stopAutoRun();
      renderQuests(setTabCallback);
    });
  }

  // Refresh board button
  const refreshBoardBtn = el.querySelector('.btn-refresh-board');
  if (refreshBoardBtn) {
    refreshBoardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Game.refreshQuestBoard(questRankFilter, true);
      selectedQuestId = null;
      renderQuests(setTabCallback);
    });
  }

  // History expand/collapse
  el.querySelectorAll('[data-history-toggle]').forEach(header => {
    header.addEventListener('click', () => {
      const idx = parseInt(header.dataset.historyToggle, 10);
      expandedHistoryIdx = expandedHistoryIdx === idx ? null : idx;
      renderQuests(setTabCallback);
    });
  });

  // Auto-scroll combat log
  const logEl = document.getElementById('aq-combat-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}
