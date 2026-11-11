import Game from '../game.js';
import { getQuest, getClass, RANK_ORDER, CLASSES } from '../data.js';
import { rankTag, timeAgo, hpClass } from './helpers.js';
import { esc, rankCss } from '../util.js';
import { showToast } from './helpers.js';
import { getQuestPhase } from './combatlog.js';

let _rendered = false;

export function renderHall() {
  const el = document.getElementById('tab-hall');
  if (!_rendered || !el.querySelector('.hall-grid')) {
    _fullRenderHall(el);
    _rendered = true;
  } else {
    _updateHall(el);
  }
}

export function markHallDirty() {
  _rendered = false;
}

// ── Full render (first time or after structural change) ───────────────────

function _fullRenderHall(el) {
  const s = Game.state;
  const activeMembers = Game.getActiveMembers();
  const allParty = [s.player, ...activeMembers];

  const legacyCard = (s.guildLegacy && s.guildLegacy.level > 0) ? renderLegacyCard(s) : '';
  el.innerHTML = `
    <div class="hall-grid">
      ${renderActiveQuestCard(s)}
      ${renderPartyOverviewCard(s, allParty)}
      ${renderGuildProgressCard(s)}
      ${legacyCard}
      ${renderEventLogCard(s)}
      ${renderSaveManagementCard(s)}
    </div>
  `;

  // Wire save management buttons
  const exportBtn = el.querySelector('#btn-export-save');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const result = Game.exportSave();
      if (result?.ok) showToast('Save exported!', 'success');
    });
  }
  const importBtn = el.querySelector('#btn-import-save');
  const importFile = el.querySelector('#import-save-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const result = Game.importSave(evt.target.result);
        if (result.ok) {
          showToast(`Loaded save: ${result.guildName} (${result.guildRank}-Rank)`, 'success');
          _rendered = false;
          renderHall();
        } else {
          showToast(result.reason, 'error');
        }
        importFile.value = '';
      };
      reader.readAsText(file);
    });
  }
}

// ── Lightweight update (called every tick — no innerHTML replacement) ──────

function questTimerText(aq, revealed, total) {
  if (aq.battleMode === 'manual') {
    return (aq.awaitingInput && revealed >= total) ? '🎮 Awaiting your orders' : '🎮 Manual battle';
  }
  return `${Math.min(revealed, total)} / ${total}`;
}
function _updateHall(el) {
  const s = Game.state;

  // Update quest timer + progress (if active quest exists)
  const timerEl = el.querySelector('#quest-timer');
  const fillEl = el.querySelector('#quest-progress-fill');
  if (s.guild.activeQuest) {
    const aq = s.guild.activeQuest;
    const revealed = Game.questEventsRevealed();
    const total = aq.eventCount || 1;
    if (timerEl) timerEl.textContent = questTimerText(aq, revealed, total);
    if (fillEl) fillEl.style.width = (Game.questProgress() * 100).toFixed(1) + '%';
  }

  // Update party HP bars
  const activeMembers = Game.getActiveMembers();
  const allParty = [s.player, ...activeMembers];
  const rows = el.querySelectorAll('.party-member-row');
  rows.forEach((row, i) => {
    const m = allParty[i];
    if (!m) return;
    const hallAuras = Game.getPartyAuras();
    const eff = Game.effectiveStats(m, hallAuras);
    const hpPct = Math.round((eff.hp / eff.maxHp) * 100);
    const fill = row.querySelector('.progress-fill');
    if (fill) {
      fill.style.width = hpPct + '%';
      fill.className = 'progress-fill ' + hpClass(eff.hp, eff.maxHp);
    }
    const hpText = row.querySelector('.member-hp-text');
    if (hpText) hpText.textContent = `${eff.hp}/${eff.maxHp}`;
  });

  // Update event log timestamps
  el.querySelectorAll('.event-time').forEach((span, i) => {
    const ev = s.guild.eventLog[i];
    if (ev) span.textContent = timeAgo(ev.time);
  });
}

// ── Card builders (used by full render) ───────────────────────────────────

function renderActiveQuestCard(s) {
  const aq = s.guild.activeQuest;
  let content;
  if (aq) {
    const quest = aq.questData || Game.getGeneratedQuest(aq.questId) || getQuest(aq.questId);
    if (!quest) { return `<div class="card hall-wide"><div class="card-title">Active Quest</div><div class="active-quest-empty">Quest data not found.</div></div>`; }
    const progress = Game.questProgress();
    const pct = progress * 100;
    const revealed = Game.questEventsRevealed();
    const total = aq.eventCount || 1;
    const phase = getQuestPhase(progress);
    const env = quest.environment || { name: '???', icon: '?', mood: 'dungeon' };
    content = `
      <div class="hall-quest-top">
        <div class="active-quest-name">
          ${rankTag(quest.rank)}
          ${quest.title}
        </div>
        <span class="hall-quest-phase">${phase.icon} ${phase.label}</span>
      </div>
      <div class="active-quest-meta">
        <span>${env.icon} ${env.name}</span> ·
        <span>Party: ${aq.partySnapshot.length} members</span>
      </div>
      <div class="quest-timer" id="quest-timer">${questTimerText(aq, revealed, total)}</div>
      <div class="progress-bar thick">
        <div class="progress-fill" id="quest-progress-fill" style="width:${pct.toFixed(1)}%; background: var(--cyan)"></div>
      </div>
    `;
  } else {
    content = `
      <div class="active-quest-empty">
        No active quest.<br>
        <span style="font-size:0.8rem">Visit the Quest Board to send your party out.</span>
      </div>
    `;
  }
  return `<div class="card hall-wide"><div class="card-title">Active Quest</div>${content}</div>`;
}

function renderPartyOverviewCard(s, members) {
  if (members.length === 0) {
    return `<div class="card"><div class="card-title">Party Overview</div><div class="empty-state">No party members assigned.</div></div>`;
  }
  const hallOverviewAuras = Game.getPartyAuras();
  const rows = members.map(m => {
    const eff = Game.effectiveStats(m, hallOverviewAuras);
    const hpPct = Math.round((eff.hp / eff.maxHp) * 100);
    const cls = getClass(m.class);
    return `
      <div class="party-member-row">
        <div>
          <div class="member-name-cls">
            ${esc(m.name)}
            <span class="member-sigil">${cls.sigil}</span>
            <span class="member-level">Lv.${m.level}</span>
          </div>
          <div class="progress-bar" style="margin-top:4px">
            <div class="progress-fill ${hpClass(eff.hp, eff.maxHp)}" style="width:${hpPct}%"></div>
          </div>
        </div>
        <div class="member-hp-text">${eff.hp}/${eff.maxHp}</div>
      </div>
    `;
  }).join('');
  return `<div class="card"><div class="card-title">Party Overview</div><div class="party-overview">${rows}</div></div>`;
}

function renderGuildProgressCard(s) {
  const threshold = Game.RANK_THRESHOLDS[s.guild.rank];
  const pct = threshold ? Math.round((s.guild.rankPoints / threshold) * 100) : 100;
  const nextRank = RANK_ORDER[RANK_ORDER.indexOf(s.guild.rank) + 1] || null;

  let progressSection;
  if (threshold) {
    progressSection = `<div class="rank-progress-label"><span>${s.guild.rankPoints.toLocaleString()} / ${threshold.toLocaleString()} pts</span><span>→ ${nextRank} Rank</span></div>
       <div class="progress-bar"><div class="progress-fill rank-bar" style="width:${pct}%"></div></div>`;
  } else {
    // Max rank — show legacy overflow progress
    const legacy = s.guildLegacy || { overflowRP: 0, level: 0 };
    const legacyCapped = legacy.level >= Game.LEGACY_LEVEL_CAP;
    const legacyPct = legacyCapped ? 100 : Math.round((legacy.overflowRP / Game.LEGACY_RP_PER_LEVEL) * 100);
    const legacyRightLabel = legacyCapped
      ? `<span class="lvl-max-tag">MAX</span>`
      : `${legacy.overflowRP.toLocaleString()} / ${Game.LEGACY_RP_PER_LEVEL.toLocaleString()} RP`;
    progressSection = `
      <div class="rank-progress-label"><span style="color:var(--rank-S)">Maximum rank achieved!</span></div>
      <div style="margin-top:6px">
        <div class="rank-progress-label"><span style="color:var(--gold)">Legacy Lv.${legacy.level}${legacyCapped ? ` / ${Game.LEGACY_LEVEL_CAP}` : ''}</span><span>${legacyRightLabel}</span></div>
        <div class="progress-bar"><div class="progress-fill${legacyCapped ? ' lvl-max-bar' : ''}" style="width:${legacyPct}%;background:linear-gradient(90deg,var(--gold),#f0c040)"></div></div>
      </div>`;
  }

  return `
    <div class="card">
      <div class="card-title">Guild Standing</div>
      <div class="rank-progress-section">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span class="rank-badge rank-${rankCss(s.guild.rank)}" style="font-size:1rem;padding:4px 14px">${s.guild.rank}</span>
          <span style="color:var(--text-dim);font-size:0.875rem">Quests completed: <strong style="color:var(--text)">${s.guild.completedQuests.length}</strong></span>
        </div>
        ${progressSection}
      </div>
    </div>
  `;
}

function renderEventLogCard(s) {
  const rows = s.guild.eventLog.length === 0
    ? `<div class="event-empty">Nothing yet. Send your party on a quest!</div>`
    : s.guild.eventLog.slice(0, 8).map(e => `
        <div class="event-row">
          <span class="event-time">${timeAgo(e.time)}</span>
          <span class="event-text">${e.text}</span>
        </div>`).join('');
  return `<div class="card"><div class="card-title">Recent Events</div><div class="event-log">${rows}</div></div>`;
}

// ── Save Management Card ─────────────────────────────────────────────────────

function renderSaveManagementCard(s) {
  const lastSaved = s.lastSaved ? new Date(s.lastSaved).toLocaleString() : 'Never';
  return `
    <div class="card save-mgmt-card">
      <div class="card-title">Save Management</div>
      <div class="save-mgmt-info">Last saved: ${lastSaved}</div>
      <div class="save-mgmt-actions">
        <button class="btn btn-sm" id="btn-export-save">Export Save</button>
        <button class="btn btn-sm" id="btn-import-save">Import Save</button>
        <input type="file" id="import-save-file" accept=".json" style="display:none">
      </div>
      <div class="save-mgmt-hint">Export your save to back it up or move it to another device.</div>
    </div>
  `;
}

// ── Guild Legacy + Talents Card ──────────────────────────────────────────────
function renderLegacyCard(s) {
  const legacy = s.guildLegacy;
  const bonuses = Game.getLegacyBonuses();
  const tp = Game.getLegacyTalentPoints();
  const talents = Game.LEGACY_TALENTS;

  // Passive bonuses summary
  const bonusRows = [
    { label: 'Gold Bonus', val: `+${(bonuses.goldBonus * 100).toFixed(0)}%`, icon: '💰' },
    { label: 'Item Find', val: `+${(bonuses.itemFind * 100).toFixed(0)}%`, icon: '🔍' },
    { label: 'EXP Bonus', val: `+${(bonuses.expBonus * 100).toFixed(0)}%`, icon: '📈' },
    { label: 'Celestial Bonus', val: `+${(bonuses.celestialBonus * 100).toFixed(1)}%`, icon: '✦' },
  ];

  const bonusHtml = bonusRows.map(b =>
    `<div class="legacy-bonus-row"><span>${b.icon} ${b.label}</span><span class="legacy-bonus-val">${b.val}</span></div>`
  ).join('');

  // Build talent tree grouped by class then party-wide
  const classIds = Object.keys(CLASSES);
  const purchased = new Set(legacy.talents || []);

  // Group talents
  const classTalents = {};
  const partyTalents = [];
  for (const [id, t] of Object.entries(talents)) {
    if (t.classId) {
      if (!classTalents[t.classId]) classTalents[t.classId] = [];
      classTalents[t.classId].push(t);
    } else {
      partyTalents.push(t);
    }
  }

  let talentHtml = '';
  // Class talent sections
  for (const cid of classIds) {
    const cls = getClass(cid);
    if (!classTalents[cid]) continue;
    const rows = classTalents[cid].sort((a, b) => a.tier - b.tier).map(t => renderTalentNode(t, purchased, tp, legacy.level)).join('');
    talentHtml += `<div class="talent-class-group">
      <div class="talent-class-header">${cls?.label || cid}</div>
      <div class="talent-nodes">${rows}</div>
    </div>`;
  }
  // Party-wide section
  if (partyTalents.length > 0) {
    const rows = partyTalents.sort((a, b) => a.tier - b.tier).map(t => renderTalentNode(t, purchased, tp, legacy.level)).join('');
    talentHtml += `<div class="talent-class-group">
      <div class="talent-class-header">🌐 Party-Wide</div>
      <div class="talent-nodes">${rows}</div>
    </div>`;
  }

  return `
    <div class="card legacy-card" style="grid-column:1/-1">
      <div class="card-title" style="color:var(--gold)">Guild Legacy <span style="font-size:0.8em;color:var(--text-dim)">(Lv.${legacy.level}${legacy.level >= Game.LEGACY_LEVEL_CAP ? ` / ${Game.LEGACY_LEVEL_CAP}` : ''})</span>${legacy.level >= Game.LEGACY_LEVEL_CAP ? ' <span class="lvl-max-tag">MAX</span>' : ''}</div>
      <div class="legacy-overview">
        <div class="legacy-bonuses">
          <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px">Passive Bonuses</div>
          ${bonusHtml}
        </div>
        <div class="legacy-talents-summary">
          <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px">Talent Points</div>
          <div class="talent-points-display">
            <span class="tp-available">${tp.available}</span> / <span class="tp-total">${tp.total}</span>
            <span style="color:var(--text-dim);font-size:0.75rem">(${tp.spent} spent)</span>
          </div>
          ${tp.spent > 0 ? `<button class="btn btn-sm btn-danger" onclick="window._resetTalents()">Reset Talents</button>` : ''}
        </div>
      </div>
      <div class="talent-tree">
        <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:8px">Talent Tree</div>
        ${talentHtml}
      </div>
    </div>
  `;
}

function renderTalentNode(t, purchased, tp, legacyLevel) {
  const owned = purchased.has(t.id);
  const canBuy = !owned && tp.available >= t.cost && legacyLevel >= t.reqLevel;
  const locked = !owned && legacyLevel < t.reqLevel;
  const tierLabel = t.tier === 1 ? 'I' : t.tier === 2 ? 'II' : t.tier === 3 ? 'III' : 'IV';

  let stateClass = 'talent-locked';
  if (owned) stateClass = 'talent-owned';
  else if (canBuy) stateClass = 'talent-available';

  const costDots = Array(t.cost).fill('<span class="tp-dot"></span>').join('');

  return `
    <div class="talent-node ${stateClass}" ${canBuy ? `onclick="window._purchaseTalent('${t.id}')"` : ''} title="${t.desc}">
      <div class="talent-icon">${t.icon}</div>
      <div class="talent-info">
        <div class="talent-name">${t.label} <span class="talent-tier">T${tierLabel}</span></div>
        <div class="talent-desc">${t.desc}</div>
      </div>
      <div class="talent-cost">${costDots}${locked ? `<span class="talent-req">Lv.${t.reqLevel}</span>` : ''}</div>
    </div>
  `;
}

// Wire up global handlers for talent interactions
if (typeof window !== 'undefined') {
  window._purchaseTalent = (id) => {
    const result = Game.purchaseTalent(id);
    if (result.ok) {
      _rendered = false;
      renderHall();
    }
  };
  window._resetTalents = () => {
    if (confirm('Reset all talent points? This is free.')) {
      Game.resetTalents();
      _rendered = false;
      renderHall();
    }
  };
}
