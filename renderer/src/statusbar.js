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
  if (!f || f.kind === 'image' || viewer.classList.contains('hidden')) return null;
  const pos = vwInput.selectionStart || 0;
  const before = vwInput.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - (before.lastIndexOf('\n') + 1) + 1;
  const selLen = (vwInput.selectionEnd || 0) - pos;
  return { line, col, lang: f.lang, indent: f.indent, selLen };
}

// zoom level of whatever's active — image preview scale, or text editor font
// size expressed as a percentage of its 14px default
function sbZoomInfo() {
  const f = (typeof activeF === 'function') ? activeF() : null;
  if (!f || viewer.classList.contains('hidden')) return null;
  if (f.kind === 'image') return { pct: f.zoom || 100, image: true };
  return { pct: Math.round((currentEditorFont() / EDITOR_FONT_DEFAULT) * 100), image: false };
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

  // ----- code graph status (throttled internally) -----
  refreshGraphStatus();

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

  // ----- zoom (image preview scale, or editor font size) -----
  const zoom = sbZoomInfo();
  if (zoom) { sbShow('sb-zoom', true); sbSet('sb-zoom', zoom.pct + '%'); }
  else sbShow('sb-zoom', false);
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
document.getElementById('sb-zoom').onclick = () => {
  const f = (typeof activeF === 'function') ? activeF() : null;
  if (!f) return;
  if (f.kind === 'image') { if (typeof resetImageView === 'function') resetImageView(f); }
  else if (typeof applyEditorFont === 'function') applyEditorFont(EDITOR_FONT_DEFAULT);
  renderStatusBar();
};
document.getElementById('sb-agent').onclick = (e) => {
  const id = e.currentTarget.dataset.agent;
  if (id && typeof openChat === 'function') openChat(id);
};
document.getElementById('sb-project').onclick = () => { if (window.openRecentProjects) window.openRecentProjects(); };

// ----- code-graph status + manual recompute -----
// Shows whether the regression-impact graph is precomputed, whether its fs
// watcher is running, and when it was last built. Click = rebuild (progress
// bar). Status IPC is throttled (not the 1s tick); progress comes from events.
const sbGraph = { building: false, pct: 0, lastError: '', phase: 'graph' };
let sbGraphFetchAt = 0;
let sbGraphProj = null;

function graphAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function paintGraph(st) {
  const item = document.getElementById('sb-graph');
  const txt = document.getElementById('sb-graph-txt');
  const bar = document.getElementById('sb-graph-bar');
  if (!item || !txt) return;
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd) { item.classList.add('hidden'); return; }
  item.classList.remove('hidden');
  if (sbGraph.building || (st && st.building)) {
    item.classList.add('building');
    const lbl = sbGraph.phase === 'vectors' ? 'vectors' : 'graph';
    txt.textContent = lbl + ' ⏳ ' + (sbGraph.pct || 0) + '%';
    if (bar) { bar.classList.remove('hidden'); bar.querySelector('i').style.width = (sbGraph.pct || 0) + '%'; }
    item.title = sbGraph.phase === 'vectors'
      ? 'Embedding symbols for semantic search…'
      : 'Building code graph…';
    return;
  }
  item.classList.remove('building');
  if (bar) bar.classList.add('hidden');
  if (st && st.broken) {
    txt.textContent = 'graph ✗';
    item.title = 'Code graph failed: ' + (st.error || 'tree-sitter unavailable')
      + '\nClick to retry.';
    return;
  }
  if (st && st.built) {
    txt.textContent = 'graph ✓ ' + graphAgo(st.lastBuilt) + (st.watching ? ' · watching' : '');
    item.title = 'Code graph — ' + st.files + ' symbols · built '
      + (st.lastBuilt ? new Date(st.lastBuilt).toLocaleString() : 'unknown')
      + (st.watching ? ' · watcher running' : ' · watcher off') + '\nClick to recompute.';
  } else if (st && st.empty) {
    // the build completed (the bar hit 100%) but produced no symbols — say so,
    // instead of repainting as "no graph yet" like the build never happened
    txt.textContent = 'graph ⚠ 0 symbols';
    item.title = 'Code graph built but found 0 symbols.\n'
      + 'Likely no supported languages (js/ts/tsx/py/go/rs/java) or grammar '
      + 'loads failed — check DevTools console for "[codegraph]" errors.\n'
      + 'Click to rebuild.';
  } else if (sbGraph.lastError) {
    txt.textContent = 'graph ✗';
    item.title = 'Last build failed: ' + sbGraph.lastError + '\nClick to retry.';
  } else {
    txt.textContent = 'graph — build';
    item.title = 'No code graph yet — click to compute regression impact.';
  }
}
async function refreshGraphStatus(force) {
  const item = document.getElementById('sb-graph');
  if (!item) return;
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd) { item.classList.add('hidden'); return; }
  if (pd !== sbGraphProj) {
    sbGraphProj = pd;
    force = true;
    // reset transient build state so another project's in-flight bar doesn't leak in
    sbGraph.building = false;
    sbGraph.pct = 0;
    sbGraph.phase = 'graph';
    sbGraph.lastError = '';
  }
  const now = Date.now();
  if (!force && now - sbGraphFetchAt < 4000) return;            // throttle — not every 1s tick
  sbGraphFetchAt = now;
  let st; try { st = await window.deck.codegraphStatus(pd); } catch { return; }
  if (st && st.ok) paintGraph(st);
}
document.getElementById('sb-graph').onclick = async () => {
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd || sbGraph.building) return;
  sbGraph.building = true; sbGraph.pct = 0; sbGraph.phase = 'graph';
  paintGraph({ building: true });
  // keep the result — a failed build repainted as "no graph yet" otherwise
  let r = null;
  try { r = await window.deck.codegraphBuild(pd); } catch {}
  sbGraph.building = false;   // 'codegraph-updated' also finalizes; guards a silent finish
  sbGraph.lastError = (r && !r.ok && r.error) ? r.error : '';
  refreshGraphStatus(true);
};
window.deck.onCodegraphProgress((p) => {
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd || p.cwd !== pd) return;
  sbGraph.building = true; sbGraph.phase = 'graph';
  sbGraph.pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  paintGraph({ building: true });
});
window.deck.onCodegraphUpdated((p) => {
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd || !p || p.cwd !== pd) return;
  // Graph is done, but the semantic VECTOR build starts right after (main.js kicks
  // it off). Don't finalize to 100% yet — switch into the 'vectors' phase so the
  // bar keeps running until vectors.json actually exists. Otherwise the user sees
  // "100%" while the vector index is still missing.
  sbGraph.building = true; sbGraph.phase = 'vectors'; sbGraph.pct = 0;
  paintGraph({ building: true });
});
// vector-embedding progress (second half of a build)
window.deck.onVectorProgress((p) => {
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd || p.cwd !== pd) return;
  sbGraph.building = true; sbGraph.phase = 'vectors';
  sbGraph.pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  paintGraph({ building: true });
});
window.deck.onVectorUpdated((p) => {
  const pd = (typeof projectDir !== 'undefined') && projectDir;
  if (!pd || (p && p.cwd && p.cwd !== pd)) return;
  // ignore the incremental re-embeds the file watcher emits — only a running
  // build (vectors phase) should finalize the bar.
  if (sbGraph.phase !== 'vectors' || !sbGraph.building) return;
  sbGraph.building = false; sbGraph.pct = 100; sbGraph.phase = 'graph';
  sbGraph.lastError = (p && p.ok === false)
    ? ('vector embedding failed' + (p.error ? ': ' + p.error : '')) : '';
  refreshGraphStatus(true);
});

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
