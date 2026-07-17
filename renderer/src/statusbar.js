// ============================================================
// STATUS BAR — VS Code style. Reads existing globals and repaints on the
// events that already fire (git refresh, agent activity, caret move, theme).
// Loaded as a classic script; shares global scope. See index.html #statusbar.
// ============================================================

function sbSet(id, text) { const e = document.getElementById(id); if (e) e.textContent = text; }
function sbShow(id, on) { const e = document.getElementById(id); if (e) e.classList.toggle('hidden', !on); }

// caret line/column of the active editor file
function sbLnCol() {
  const f = (typeof activeF === 'function') ? activeF() : null;
  if (!f || viewer.classList.contains('hidden')) return null;
  const pos = vwInput.selectionStart || 0;
  const before = vwInput.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - (before.lastIndexOf('\n') + 1) + 1;
  const selLen = (vwInput.selectionEnd || 0) - pos;
  return { line, col, lang: f.lang, indent: f.indent, selLen };
}

function renderStatusBar() {
  // ----- git branch + ahead/behind -----
  const st = (typeof statusGit !== 'undefined') ? statusGit : null;
  if (typeof gitRepo !== 'undefined' && gitRepo && st) {
    sbShow('sb-branch', true);
    sbSet('sb-branch-name', st.branch || '(detached)');
    let sync = '';
    if (st.ahead) sync += ' ↑' + st.ahead;
    if (st.behind) sync += ' ↓' + st.behind;
    if (!st.upstream) sync = ' ⤒';                 // never published
    sbSet('sb-sync', sync);
  } else {
    sbShow('sb-branch', false);
  }

  // ----- project name -----
  if (typeof projectDir !== 'undefined' && projectDir) {
    sbShow('sb-project', true);
    sbSet('sb-project-name', '🖿 ' + projectDir.split(/[\\/]/).pop());
  } else {
    sbShow('sb-project', false);
  }

  // ----- work in progress (agent running OR pipeline active/paused) -----
  renderWork();

  // ----- Claude login dot -----
  const on = (typeof auth !== 'undefined') && auth.loggedIn;
  const dot = document.getElementById('sb-claude-dot');
  if (dot) dot.className = 'sb-dot ' + (on ? 'on' : 'off');
  sbSet('sb-claude-txt', on ? (auth.email ? auth.email.split('@')[0] : 'Claude') : 'Claude — signed out');

  // ----- editor position -----
  const lc = sbLnCol();
  if (lc) {
    sbShow('sb-lncol', true); sbShow('sb-lang', true); sbShow('sb-indent', true);
    sbSet('sb-lncol', lc.selLen > 0 ? `Ln ${lc.line}, Col ${lc.col} (${lc.selLen} sel)` : `Ln ${lc.line}, Col ${lc.col}`);
    sbSet('sb-lang', (lc.lang || 'text').toUpperCase());
    sbSet('sb-indent', 'Spaces: ' + (lc.indent || 2));
  } else {
    sbShow('sb-lncol', false); sbShow('sb-lang', false); sbShow('sb-indent', false);
  }
}
window.renderStatusBar = renderStatusBar;

// the single "what's happening" indicator, living in the status bar. Covers a
// running agent and a pipeline stage (including the paused "awaiting review").
// The stop button always resolves to something real, and everything hides the
// moment nothing is active — so no ghost STOP after a run finishes.
function renderWork() {
  const work = document.getElementById('sb-work');
  const txt = document.getElementById('sb-work-txt');
  if (!work || !txt) return;
  const busyAgent = (typeof agents !== 'undefined')
    ? agents.find(a => R(a.id).running) : null;
  const pipe = window.pipeState ? window.pipeState() : { active: false };

  let label = null, stoppable = false;
  if (busyAgent) {
    const st = R(busyAgent.id).status;
    label = esc(busyAgent.name) + (st ? ' · ' + esc(String(st).slice(0, 44)) : '');
    stoppable = true;
  } else if (pipe.active && pipe.label) {
    // pipeline is active but no agent is running right now (e.g. awaiting review)
    label = esc(pipe.label);
    stoppable = pipe.stage !== 'plan';   // during plan-review, use the card, not stop
  }

  if (!label) { work.classList.add('hidden'); return; }
  work.classList.remove('hidden');
  txt.textContent = label;
  const stopBtn = document.getElementById('sb-work-stop');
  if (stopBtn) stopBtn.classList.toggle('hidden', !stoppable);
}

document.getElementById('sb-work-stop').onclick = (e) => {
  e.stopPropagation();
  if (window.stopEverything) window.stopEverything();
};

// ----- click actions -----
document.getElementById('sb-branch').onclick = () => {
  const p = document.getElementById('git-panel');
  if (p) p.classList.toggle('hidden');
};
// ----- Claude account drop-up menu (no modal; opens ABOVE the status bar) -----
const claudeMenu = document.createElement('div');
claudeMenu.id = 'claude-menu';
claudeMenu.className = 'dropup-menu hidden';
document.body.appendChild(claudeMenu);

function renderClaudeMenu() {
  const on = (typeof auth !== 'undefined') && auth.loggedIn;
  const row = (label, val) => val ? `<div class="pm-row"><span>${label}</span><b>${esc(String(val))}</b></div>` : '';
  claudeMenu.innerHTML = `
    <div class="pm-head">
      <div class="acct-avatar lg claude"><span>✳</span></div>
      <div class="pm-id">
        <div class="pm-name">${on ? 'Claude — connected' : 'Claude — signed out'}</div>
        <div class="pm-email">${esc(on ? (auth.email || 'logged in') : 'not signed in')}</div>
      </div>
    </div>
    ${row('Plan', on ? (auth.subscriptionType || '—') : '')}
    ${row('Auth', on ? (auth.authMethod || '—') : '')}
    ${on ? `
      <div class="pm-sep"></div>
      <div class="cm-usage-head">USAGE LIMITS <span id="cm-usage-upd"></span></div>
      <div class="cm-usage" id="cm-usage"><div class="pu-loading">loading…</div></div>` : ''}
    <div class="pm-sep"></div>
    ${on
      ? '<button class="pm-item danger" id="cm-logout">⏻ Log out of Claude</button>'
      : '<button class="pm-item" id="cm-login">✳ Log in to Claude</button>'}`;
  if (on) loadClaudeUsage();
  const lo = document.getElementById('cm-logout');
  if (lo) lo.onclick = () => { claudeMenu.classList.add('hidden'); document.getElementById('ac-logout').click(); };
  const li = document.getElementById('cm-login');
  if (li) li.onclick = () => { claudeMenu.classList.add('hidden'); document.getElementById('ac-login').click(); };
}

// compact plan-usage donuts (reuses puDonut/planUsage). Reusable across menus:
// pass the target element + an optional "updated" timestamp element id.
async function renderPlanDonuts(boxId, updId) {
  const first = document.getElementById(boxId);
  if (!first) return;
  const r = await window.deck.planUsage();
  const target = document.getElementById(boxId);       // menu may have re-rendered
  if (!target) return;
  if (!r.ok) { target.innerHTML = `<div class="pu-loading">${esc(r.error || 'unavailable')}</div>`; return; }
  const names = { session: 'Session', weekly_all: 'Weekly' };
  target.innerHTML = '';
  for (const l of (r.limits || [])) {
    const label = l.kind === 'weekly_scoped'
      ? ((l.scope && l.scope.model && l.scope.model.display_name) || 'Model')
      : (names[l.kind] || l.kind);
    const sev = l.percent >= 90 ? 'crit' : l.percent >= 70 ? 'warn' : '';
    const cell = document.createElement('div');
    cell.className = 'cm-pu-cell';
    const resets = (typeof fmtReset === 'function' && l.resets_at) ? fmtReset(l.resets_at) : '';
    cell.innerHTML = (typeof puDonut === 'function' ? puDonut(l.percent, sev) : `<b>${l.percent}%</b>`)
      + `<div class="cm-pu-label">${esc(label)}</div>`
      + `<div class="cm-pu-reset">${esc(resets)}</div>`;
    target.appendChild(cell);
  }
  const upd = updId && document.getElementById(updId);
  if (upd) upd.textContent = '· ' + new Date().toLocaleTimeString();
}
window.renderPlanDonuts = renderPlanDonuts;
function loadClaudeUsage() { renderPlanDonuts('cm-usage', 'cm-usage-upd'); }

function positionDropup(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  // measure real width (menu must be laid out) then right-align to the anchor,
  // clamped so neither edge leaves the viewport regardless of app width
  const wasHidden = menu.classList.contains('hidden');
  if (wasHidden) { menu.style.visibility = 'hidden'; menu.classList.remove('hidden'); }
  const w = menu.offsetWidth || 300;
  if (wasHidden) { menu.classList.add('hidden'); menu.style.visibility = ''; }
  let left = r.right - w;                          // align right edges
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  menu.style.left = left + 'px';
  menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';   // sit ABOVE the bar
}

document.getElementById('sb-claude').onclick = (e) => {
  e.stopPropagation();
  const opening = claudeMenu.classList.contains('hidden');
  if (opening && typeof refreshAuth === 'function') {
    refreshAuth().then(() => { renderClaudeMenu(); renderStatusBar(); });
  }
  renderClaudeMenu();
  positionDropup(claudeMenu, document.getElementById('sb-claude'));
  claudeMenu.classList.toggle('hidden', !opening);
};
document.addEventListener('click', (e) => {
  if (!claudeMenu.contains(e.target) && e.target.closest('#sb-claude') === null) {
    claudeMenu.classList.add('hidden');
  }
});
document.getElementById('sb-lncol').onclick = () => { if (window.paletteGoToLine) window.paletteGoToLine(); };
document.getElementById('sb-agent').onclick = (e) => {
  const id = e.currentTarget.dataset.agent;
  if (id && typeof openChat === 'function') openChat(id);
};
document.getElementById('sb-project').onclick = () => { if (window.openRecentProjects) window.openRecentProjects(); };

// ----- repaint hooks -----
// caret / selection movement while editing
for (const ev of ['keyup', 'click', 'input', 'select']) {
  vwInput.addEventListener(ev, () => renderStatusBar());
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === vwInput) renderStatusBar();
});
// agent activity ticks ~1s; piggyback on the existing activity interval
setInterval(renderStatusBar, 1000);

renderStatusBar();
