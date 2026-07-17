// Extracted from app.js — classic script, shares global scope. Keep load order.

// ===== Tabbed interactive terminal — real PTYs + xterm.js =====
const termView = document.getElementById('term-view');
const tvTabs = document.getElementById('tv-tabs');
const tvBody = document.getElementById('tv-body');
const termTabs = [];        // { id, shell, title, xterm, fit, pane, dead }
let termActive = null;      // id
let termSeq = 0;

function termOpen() { return !termView.classList.contains('hidden'); }
function tabOf(id) { return termTabs.find(t => t.id === id); }

// one dispatcher for every tab's PTY output
window.deck.onTermData(p => {
  const t = tabOf(p.termId);
  if (!t) return;
  t.xterm.write(p.data);
  if (p.exited) { t.dead = true; renderTermTabs(); }
});

function renderTermTabs() {
  tvTabs.innerHTML = '';
  for (const t of termTabs) {
    const el = document.createElement('div');
    el.className = 'tv-tab' + (t.id === termActive ? ' active' : '') + (t.dead ? ' dead' : '');
    el.title = 'double-click or right-click to rename';
    el.innerHTML = '<span class="tv-tab-name"></span><b title="Close tab">✕</b>';
    el.querySelector('.tv-tab-name').textContent = t.title;
    el.onclick = () => activateTerm(t.id);
    el.querySelector('b').onclick = e => { e.stopPropagation(); closeTerm(t.id); };
    el.ondblclick = e => { e.stopPropagation(); renameTermTab(t, el); };
    el.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); renameTermTab(t, el); };
    tvTabs.appendChild(el);
  }
  renderConsoleChips();
}

// inline-rename a terminal tab (right-click or double-click)
function renameTermTab(t, el) {
  const nameEl = el.querySelector('.tv-tab-name');
  if (!nameEl || el.querySelector('.tv-rename')) return;
  const inp = document.createElement('input');
  inp.className = 'tv-rename';
  inp.value = t.title;
  inp.spellcheck = false;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) { const v = inp.value.trim(); if (v) t.title = v; }
    renderTermTabs();
  };
  inp.onclick = e => e.stopPropagation();
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  inp.onblur = () => commit(true);
}

function activateTerm(id) {
  termActive = id;
  for (const t of termTabs) t.pane.classList.toggle('hidden', t.id !== id);
  renderTermTabs();
  const t = tabOf(id);
  if (t) { try { t.fit.fit(); } catch {} t.xterm.focus(); }
}

// ===== "Analyze with AI" — floating button over a terminal selection =====
// highlight an error in the terminal → the button appears → one click sends the
// selection to GENERAL-OPS with simple diagnose-and-fix rules
const termAiBtn = document.createElement('button');
termAiBtn.id = 'term-ai-btn';
termAiBtn.className = 'hidden';
termAiBtn.textContent = '✨ Analyze with AI';
document.body.appendChild(termAiBtn);
let termAiSel = '';

function hideTermAi() { termAiBtn.classList.add('hidden'); }
function showTermAi(x, y) {
  termAiBtn.style.left = Math.max(8, Math.min(x, window.innerWidth - 160)) + 'px';
  termAiBtn.style.top = Math.max(8, y - 38) + 'px';
  termAiBtn.classList.remove('hidden');
}
document.addEventListener('mousedown', e => { if (e.target !== termAiBtn) hideTermAi(); });

termAiBtn.onclick = () => {
  const text = termAiSel;
  hideTermAi();
  if (!text.trim()) return;
  const agent = agents.find(a => a.id === 'def-general') || byRole('custom')[0] || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { toast('✗ ' + agent.name + ' is busy — try again shortly', false); return; }
  const prompt = `Analyze this terminal output the operator highlighted. Simple rules:
1) WHAT: the error/issue in one line (or "not an error" + what it means).
2) WHY: root cause in 1-2 lines.
3) FIX: the exact command(s) or edit to run, ready to copy. Prefer the smallest fix.
Do not explore the project unless strictly necessary. Max 10 lines total.

=== TERMINAL OUTPUT ===
${text.slice(0, 6000)}`;
  closeTerminalView();   // bring the console forward so the answer is visible
  plog('info', `✨ analyzing highlighted terminal output on ${agent.name}…`);
  runAgent(agent.id, prompt, false, false, { fresh: true, model: 'claude-sonnet-5' });
};

// hover tooltip for terminal links — VS Code-style "ctrl+click to open"
const linkTip = document.createElement('div');
linkTip.id = 'link-tip';
linkTip.className = 'hidden';
document.body.appendChild(linkTip);

function showLinkTip(e, uri) {
  linkTip.textContent = '⌨ Hold Ctrl + click to open  ·  ' + uri;
  linkTip.classList.remove('hidden');
  linkTip.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - linkTip.offsetWidth - 8)) + 'px';
  linkTip.style.top = (e.clientY + 18) + 'px';
}
function hideLinkTip() { linkTip.classList.add('hidden'); }

async function newTerm(shell, cwd) {
  const id = 'tab-' + (++termSeq) + '-' + uid();
  const pane = document.createElement('div');
  pane.className = 'tv-pane';
  tvBody.appendChild(pane);

  const xt = new Terminal({
    fontSize: 12.5,
    fontFamily: "'Cascadia Code', Consolas, monospace",
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme()
  });
  const fit = new FitAddon.FitAddon();
  xt.loadAddon(fit);
  // URLs in the terminal become real links: ctrl+click opens the OS browser
  xt.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => {
    if (e.ctrlKey || e.metaKey) { hideLinkTip(); window.deck.openExternal(uri); }
  }, { hover: showLinkTip, leave: hideLinkTip }));
  xt.open(pane);
  // Clipboard, terminal-style: Ctrl+C copies the SELECTION (and falls through to
  // SIGINT when nothing is selected); Ctrl+V pastes. Ctrl+Shift+C/V also work.
  // cache the live selection — some keydowns fire after xterm clears it
  let lastSel = '';
  xt.onSelectionChange(() => { const s = xt.getSelection(); if (s) lastSel = s; });
  // selection made with the mouse → offer the AI analyzer right there
  pane.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const s = xt.getSelection();
      if (s && s.trim().length >= 8) { termAiSel = s; showTermAi(e.clientX, e.clientY); }
      else hideTermAi();
    }, 30);
  });
  xt.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const c = e.ctrlKey || e.metaKey;
    if (!c) return true;
    // Ctrl+C / Ctrl+Shift+C: copy the selection; plain Ctrl+C with no selection
    // falls through so it still interrupts the running process.
    if (e.code === 'KeyC') {
      const sel = xt.getSelection() || lastSel;
      if (sel) { window.deck.clipboardWrite(sel); lastSel = ''; xt.clearSelection(); return false; }
      return !e.shiftKey;
    }
    // Ctrl+V: xterm's textarea receives the native paste event and feeds it
    // through onData already — injecting the clipboard here too pasted twice.
    // Just let the native path handle it.
    if (e.code === 'KeyV') return true;
    return true;
  });
  // right-click: copy selection if any, else paste — a mouse fallback that always works
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const sel = xt.getSelection() || lastSel;
    if (sel) { window.deck.clipboardWrite(sel); lastSel = ''; xt.clearSelection(); }
    else { const t = await window.deck.clipboardRead(); if (t) window.deck.termInput(id, t); }
  });
  xt.onData(d => {
    window.deck.termInput(id, d);
    if (d === '\r') setTimeout(gitRefresh, 1500); // refresh badge after each command
  });
  xt.onResize(({ cols, rows }) => window.deck.termResize(id, cols, rows));
  new ResizeObserver(() => {
    if (termOpen() && termActive === id) { try { fit.fit(); } catch {} }
  }).observe(pane);

  const startCwd = cwd || gitRepo || projectDir || '';
  const t = { id, shell, cwd: startCwd, title: '', xterm: xt, fit, pane, dead: false };
  termTabs.push(t);
  activateTerm(id);
  try { fit.fit(); } catch {}

  const r = await window.deck.termStart(id, startCwd, xt.cols, xt.rows, shell);
  // bash silently falls back to powershell when git-bash isn't installed
  t.title = (r.shell === 'git bash' ? 'BASH' : 'PS') + ' ' + termSeq;
  if (!r.ok) {
    t.title = '✕ ' + t.title;
    t.dead = true;
    xt.writeln('\x1b[31m' + (r.error || 'failed to start shell') + '\x1b[0m');
  }
  renderTermTabs();
}

function closeTerm(id) {
  const i = termTabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = termTabs[i];
  window.deck.termKill(id);
  t.xterm.dispose();
  t.pane.remove();
  termTabs.splice(i, 1);
  if (termActive === id) {
    termActive = termTabs.length ? termTabs[Math.max(0, i - 1)].id : null;
    if (termActive) activateTerm(termActive);
  }
  renderTermTabs();
}

function openTerminal() {
  termView.classList.remove('hidden');
  consoleFeed.classList.add('hidden');
  viewer.classList.add('hidden');
  if (!termTabs.length) newTerm('bash');
  else activateTerm(termActive || termTabs[0].id);
  setTermIconActive(true);
  renderConsoleChips();
}

function closeTerminalView() {
  // tabs keep their PTYs alive in the background — this only swaps the pane
  termView.classList.add('hidden');
  consoleFeed.classList.remove('hidden');
  setTermIconActive(false);
  syncPane();
  renderConsoleChips();
}

// #2 — reflect terminal-open in the top-right icon
function setTermIconActive(on) { document.getElementById('btn-term').classList.toggle('ico-active', on); }

// ===== Surface chips beside CENTRAL CONSOLE =====
// The main area shows ONE surface at a time (no split). When more than one is
// active — Console + Terminal + Explorer — chips let you switch and close each.
const SURFACE_META = {
  console: { icon: '◈', label: 'Console', closable: false },
  editor: { icon: '📄', label: 'Explorer', closable: true },
  terminal: { icon: '⌨', label: 'Terminal', closable: true }
};
function activeSurfaces() {
  const arr = ['console'];
  if (openFiles.length) arr.push('editor');
  if (termTabs.length) arr.push('terminal');
  return arr;
}
function currentSurface() {
  if (termOpen()) return 'terminal';
  if (!viewer.classList.contains('hidden')) return 'editor';
  return 'console';
}
function showSurface(name) {
  if (name === 'terminal') { openTerminal(); return; }
  termView.classList.add('hidden');
  setTermIconActive(false);
  if (name === 'editor' && openFiles.length) {
    paneOverride = 'editor';
    viewer.classList.remove('hidden');
    consoleFeed.classList.add('hidden');
  } else {
    paneOverride = 'console';
    viewer.classList.add('hidden');
    consoleFeed.classList.remove('hidden');
  }
  renderConsoleChips();
}
async function closeSurface(name) {
  if (name === 'terminal') {
    for (const t of [...termTabs]) closeTerm(t.id);
    closeTerminalView();
  } else if (name === 'editor') {
    for (const f of [...openFiles]) await closeFile(f.path);
    showSurface('console');
  }
  renderConsoleChips();
}
function renderConsoleChips() {
  const bar = document.getElementById('console-chips');
  if (!bar) return;
  const surfaces = activeSurfaces();
  if (surfaces.length <= 1) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const cur = currentSurface();
  bar.innerHTML = '';
  for (const s of surfaces) {
    const m = SURFACE_META[s];
    const chip = document.createElement('div');
    chip.className = 'cc-chip' + (s === cur ? ' active' : '');
    chip.innerHTML = `<span class="cc-label">${m.icon} ${m.label}</span>${m.closable ? '<b class="cc-x" title="Close">✕</b>' : ''}`;
    chip.querySelector('.cc-label').onclick = () => showSurface(s);
    const x = chip.querySelector('.cc-x');
    if (x) x.onclick = (e) => { e.stopPropagation(); closeSurface(s); };
    bar.appendChild(chip);
  }
}

document.getElementById('btn-term').onclick = () => (termOpen() ? closeTerminalView() : openTerminal());
document.getElementById('tv-close').onclick = closeTerminalView;
document.getElementById('tv-new-bash').onclick = () => newTerm('bash');
document.getElementById('tv-new-ps').onclick = () => newTerm('powershell');
document.getElementById('git-stage-all').onclick = () => gitDo('stage', '*');
document.getElementById('git-unstage-all').onclick = () => gitDo('unstage', '*');
document.getElementById('git-pull').onclick = () => gitDo('pull');

// commit like VS Code: if nothing is staged, stage everything first
// push; if the branch has no upstream yet, publish it (push -u origin <branch>)
async function pushOrPublish() {
  let r = await window.deck.gitCmd(gitRepo, 'push');
  if (!r.ok && /no upstream branch|set-upstream/i.test(r.out)) {
    const st = await window.deck.gitStatus(gitRepo);
    r = await window.deck.gitCmd(gitRepo, 'publish', st.branch || 'HEAD');
  }
  return r;
}

