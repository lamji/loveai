// ============================================================
// Extracted from app.js — loaded as a classic script AFTER app.js,
// so it shares the same global scope (no imports/exports). Keep the
// <script> order in index.html or top-level execution order breaks.
// ============================================================

// ============================================================
// CODE EDITOR — read, edit, Ctrl+S save. VS Code style.
// Each open file: { path, lang, content (as on disk), value (buffer), html, dirty }
// ============================================================
const viewer = document.getElementById('viewer');
const vwInput = document.getElementById('vw-input');
const vwCode = document.getElementById('vw-code');
const vwGutter = document.getElementById('vw-gutter');
const openFiles = [];
let activeFile = null;

function baseName(p) { return p.split(/[\\/]/).pop(); }
function relPath(p) { return projectDir && p.startsWith(projectDir) ? p.slice(projectDir.length).replace(/^[\\/]/, '') : p; }

function markOpenRows() {
  exTree.querySelectorAll('.ex-row.is-file').forEach(r => {
    r.classList.toggle('open-file', r.dataset.file === activeFile);
  });
}

// shiki hands back a full <pre class="shiki"><code>…</code></pre>; we want just the
// <code> innards so the code sits next to our own line-number gutter
function shikiInner(html) {
  if (!html) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const code = tmp.querySelector('pre.shiki > code');
  return code ? code.innerHTML : null;
}

function activeF() { return openFiles.find(x => x.path === activeFile) || null; }

// indent width the file already uses — so Tab matches its neighbours
function detectIndent(text) {
  const counts = {};
  for (const line of text.split('\n')) {
    const m = /^( +)\S/.exec(line);
    if (m) counts[m[1].length] = (counts[m[1].length] || 0) + 1;
  }
  const widths = Object.keys(counts).map(Number).filter(n => n > 0);
  if (!widths.length) return 2;
  const step = Math.min(...widths);
  return step >= 2 && step <= 8 ? step : 2;
}

async function openFile(path) {
  if (!openFiles.some(f => f.path === path)) {
    const r = await window.deck.fsRead(projectDir, path, shikiTheme());
    if (!r.ok) { feedRaw('EXPLORER', 'err', `${baseName(path)}: ${r.error}`, '🗀'); return; }
    openFiles.push({
      path, lang: r.lang,
      content: r.content,          // what's on disk
      value: r.content,            // what's in the buffer
      html: shikiInner(r.html),
      indent: detectIndent(r.content),
      dirty: false
    });
  }
  activeFile = path;
  paneOverride = 'editor';
  viewer.classList.remove('hidden');
  setTermIconActive(false);
  termView.classList.add('hidden');
  renderViewer();
  renderConsoleChips();
  vwInput.focus();
}

async function closeFile(path) {
  const f = openFiles.find(x => x.path === path);
  if (!f) return;
  if (f.dirty) {
    const discard = await showAlert({
      title: 'UNSAVED CHANGES',
      message: `${baseName(path)} has changes that aren't saved yet. Closing it now will discard them.`,
      okText: 'DISCARD',
      cancelText: 'KEEP EDITING',
      kind: 'danger'
    });
    if (!discard) return;
  }
  const i = openFiles.indexOf(f);
  openFiles.splice(i, 1);
  if (activeFile === path) activeFile = openFiles.length ? openFiles[Math.max(0, i - 1)].path : null;
  if (!activeFile) { paneOverride = null; viewer.classList.add('hidden'); renderTabs(); markOpenRows(); return; }
  renderViewer();
}

function renderTabs() {
  const tabs = document.getElementById('vw-tabs');
  tabs.innerHTML = '';
  for (const f of openFiles) {
    const t = document.createElement('div');
    t.className = 'vw-tab' + (f.path === activeFile ? ' active' : '') + (f.dirty ? ' dirty' : '');
    t.title = f.path + (f.dirty ? ' — unsaved (Ctrl+S)' : '');
    t.innerHTML = '<span></span><b></b>';
    t.querySelector('span').textContent = baseName(f.path);
    // unsaved files show a dot instead of the ✕, like VS Code
    const mark = t.querySelector('b');
    mark.textContent = f.dirty ? '○' : '✕';
    mark.title = f.dirty ? 'Unsaved — click to close' : 'Close';
    if (f.dirty) {
      mark.onmouseenter = () => { mark.textContent = '✕'; };
      mark.onmouseleave = () => { mark.textContent = '○'; };
    }
    t.onclick = () => { activeFile = f.path; renderViewer(); vwInput.focus(); };
    mark.onclick = e => { e.stopPropagation(); closeFile(f.path); };
    tabs.appendChild(t);
  }
  renderConsoleChips();
}

function renderGutter(text) {
  const n = text.split('\n').length;
  vwGutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
}

// A textarea renders a final empty line for a trailing newline; a <pre> gives an
// empty last line no height. Without this the highlight layer ends up one line
// short, the textarea scrolls inside itself, and the two drift apart. The
// zero-width space gives that last line a box at zero visual cost.
const EOF_PAD = '​';

function paintCode(f) {
  // html is shiki's escaped markup; plain text covers huge files and
  // anything shiki couldn't tokenise
  if (f.html) vwCode.innerHTML = f.html + EOF_PAD;
  else vwCode.textContent = f.value + EOF_PAD;
}

function renderViewer() {
  const f = activeF();
  if (!f) return;
  renderTabs();
  vwInput.value = f.value;
  paintCode(f);
  renderGutter(f.value);
  document.getElementById('vw-body').scrollTop = 0;
  markOpenRows();
}

// re-colouring costs an IPC round-trip, so it waits for a pause in typing;
// until then the plain-text layer keeps the box the right size
let hlTimer = null;
function scheduleHighlight(f) {
  clearTimeout(hlTimer);
  hlTimer = setTimeout(async () => {
    const snapshot = f.value;
    const r = await window.deck.fsHighlight(snapshot, f.lang, shikiTheme());
    // discard if the buffer moved on, or the user switched files, while we waited
    if (!r.ok || f.value !== snapshot) return;
    f.html = shikiInner(r.html);
    if (activeFile === f.path) paintCode(f);
  }, 180);
}

vwInput.addEventListener('input', () => {
  const f = activeF();
  if (!f) return;
  f.value = vwInput.value;
  const wasDirty = f.dirty;
  f.dirty = f.value !== f.content;
  f.html = null;                  // stale until the re-highlight lands
  paintCode(f);                   // instant, uncoloured — keeps the layers aligned
  renderGutter(f.value);
  if (f.dirty !== wasDirty) renderTabs();
  scheduleHighlight(f);
});

// keep the caret line in view: the textarea can't scroll (it's sized to its
// content), so the scrolling happens on the container around it
vwInput.addEventListener('scroll', () => { vwInput.scrollTop = 0; vwInput.scrollLeft = 0; });

async function saveFile(f) {
  if (!f || !f.dirty) return;
  const r = await window.deck.fsWrite(projectDir, f.path, f.value);
  if (!r.ok) { feedRaw('EDITOR', 'err', `save failed — ${baseName(f.path)}: ${r.error}`, '💾'); return; }
  f.content = f.value;
  f.dirty = false;
  renderTabs();
  feedRaw('EDITOR', 'ok', `saved ${relPath(f.path)}`, '💾');
  if (gitRepo) gitRefresh();
}

vwInput.addEventListener('keydown', e => {
  const f = activeF();
  if (!f) return;

  // Ctrl+S — save
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile(f);
    return;
  }

  // Tab — indent instead of leaving the editor. execCommand keeps native undo.
  if (e.key === 'Tab') {
    e.preventDefault();
    document.execCommand('insertText', false, ' '.repeat(f.indent));
    return;
  }

  // Enter — carry the current line's indentation down, like VS Code
  if (e.key === 'Enter' && !e.shiftKey) {
    const upto = vwInput.value.slice(0, vwInput.selectionStart);
    const line = upto.slice(upto.lastIndexOf('\n') + 1);
    const lead = (/^[ \t]*/.exec(line) || [''])[0];
    if (lead) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n' + lead);
    }
  }
});

// Ctrl+S also works when focus is elsewhere in the editor pane
// (defaultPrevented = the textarea handler above already saved)
document.addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !viewer.classList.contains('hidden')) {
    e.preventDefault();
    saveFile(activeF());
  }
});

document.getElementById('vw-close').onclick = () => {
  paneOverride = 'console';
  viewer.classList.add('hidden');
  markOpenRows();
};

// ============================================================
// FIND IN FILE — Ctrl+F, VS Code style. Enter = next,
// Shift+Enter = previous, Esc = close. Aa toggles case.
// ============================================================
const findBar = document.createElement('div');
findBar.id = 'vw-find';
findBar.className = 'hidden';
findBar.innerHTML = `
  <input id="vwf-input" placeholder="Find" spellcheck="false" />
  <span id="vwf-count">0 / 0</span>
  <button id="vwf-case" class="vwf-btn" title="Match case">Aa</button>
  <button id="vwf-prev" class="vwf-btn" title="Previous match (Shift+Enter)">↑</button>
  <button id="vwf-next" class="vwf-btn" title="Next match (Enter)">↓</button>
  <button id="vwf-close" class="vwf-btn" title="Close (Esc)">✕</button>`;
viewer.insertBefore(findBar, document.getElementById('vw-body'));

const vwfInput = document.getElementById('vwf-input');
const vwfCount = document.getElementById('vwf-count');
const find = { matches: [], at: -1, caseSensitive: false };

// match-highlight layer: a mirror <pre> between the coloured code and the
// textarea — transparent text, tinted <mark> boxes exactly under each match
const vwMarks = document.createElement('pre');
vwMarks.id = 'vw-marks';
vwMarks.className = 'vw-code vw-marks';
vwCode.after(vwMarks);

function findEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function htmlEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderFindMarks() {
  const f = activeF();
  const qLen = vwfInput.value.length;
  if (!f || !find.matches.length || !qLen || findBar.classList.contains('hidden')) {
    vwMarks.innerHTML = '';
    return;
  }
  const t = f.value;
  let html = '', pos = 0;
  for (let i = 0; i < find.matches.length; i++) {
    const s = find.matches[i];
    html += htmlEsc(t.slice(pos, s));
    html += `<mark class="${i === find.at ? 'cur' : ''}">${htmlEsc(t.slice(s, s + qLen))}</mark>`;
    pos = s + qLen;
  }
  html += htmlEsc(t.slice(pos));
  vwMarks.innerHTML = html + EOF_PAD;
}

function findRun(moveTo = 'nearest') {
  const f = activeF();
  const q = vwfInput.value;
  find.matches = [];
  if (f && q) {
    const re = new RegExp(findEsc(q), find.caseSensitive ? 'g' : 'gi');
    let m;
    while ((m = re.exec(f.value)) && find.matches.length < 5000) {
      find.matches.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;   // zero-length guard
    }
  }
  if (!find.matches.length) {
    find.at = -1;
    vwfCount.textContent = '0 / 0';
    vwfCount.classList.toggle('none', !!q);
    renderFindMarks();
    return;
  }
  vwfCount.classList.remove('none');
  if (moveTo === 'nearest') {
    // first match at/after the caret, like VS Code
    const caret = vwInput.selectionStart || 0;
    find.at = find.matches.findIndex(i => i >= caret);
    if (find.at < 0) find.at = 0;
  } else if (moveTo === 'next') {
    find.at = (find.at + 1) % find.matches.length;
  } else if (moveTo === 'prev') {
    find.at = (find.at - 1 + find.matches.length) % find.matches.length;
  }
  findShow();
}

function findShow() {
  const f = activeF();
  if (!f || find.at < 0) return;
  const start = find.matches[find.at];
  const len = vwfInput.value.length;
  vwfCount.textContent = `${find.at + 1} / ${find.matches.length}`;
  renderFindMarks();
  // keep the buffer selection on the match too (typing replaces it, like VS Code)
  vwInput.setSelectionRange(start, start + len);
  // the textarea itself can't scroll — scroll the surrounding pane so the
  // current match is on screen (vertically AND horizontally)
  const before = f.value.slice(0, start);
  const line = before.split('\n').length - 1;
  const col = start - (before.lastIndexOf('\n') + 1);
  const lineH = parseFloat(getComputedStyle(document.getElementById('vw-body')).lineHeight) || 19;
  const body = document.getElementById('vw-body');
  const y = line * lineH;
  if (y < body.scrollTop + lineH || y > body.scrollTop + body.clientHeight - lineH * 2.5) {
    body.scrollTop = Math.max(0, y - body.clientHeight / 2);
  }
  const charW = lineH * 0.47;                    // monospace estimate
  const x = col * charW;
  const gutterW = vwGutter.offsetWidth || 0;
  const viewW = body.clientWidth - gutterW;
  if (x < body.scrollLeft || x > body.scrollLeft + viewW - 80) {
    body.scrollLeft = Math.max(0, x - viewW / 3);
  }
}

function findOpen() {
  findBar.classList.remove('hidden');
  // prefill with the current selection, like VS Code
  const sel = vwInput.value.slice(vwInput.selectionStart, vwInput.selectionEnd);
  if (sel && !sel.includes('\n')) vwfInput.value = sel;
  vwfInput.focus();
  vwfInput.select();
  findRun('nearest');
}

function findClose() {
  findBar.classList.add('hidden');
  vwMarks.innerHTML = '';
  vwInput.focus();
}

vwfInput.addEventListener('input', () => findRun('nearest'));
vwfInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); findRun(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); findRun('prev'); }
  else if (e.key === 'Escape') { e.preventDefault(); findClose(); }
});

// buffer edited while the bar is open → positions moved; re-search in place
vwInput.addEventListener('input', () => {
  if (!findBar.classList.contains('hidden')) findRun('nearest');
});
document.getElementById('vwf-next').onclick = () => findRun('next');
document.getElementById('vwf-prev').onclick = () => findRun('prev');
document.getElementById('vwf-close').onclick = findClose;
document.getElementById('vwf-case').onclick = (e) => {
  find.caseSensitive = !find.caseSensitive;
  e.currentTarget.classList.toggle('on', find.caseSensitive);
  findRun('nearest');
  vwfInput.focus();
};

// switching files/tabs: re-run the search against the new buffer (or clear)
const _renderViewer = renderViewer;
renderViewer = function () {
  _renderViewer();
  if (!findBar.classList.contains('hidden')) findRun('nearest');
  else vwMarks.innerHTML = '';
};

// Ctrl+F anywhere in the editor pane opens the bar; Esc in the editor closes it
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' &&
      !viewer.classList.contains('hidden')) {
    e.preventDefault();
    findOpen();
  } else if (e.key === 'Escape' && !findBar.classList.contains('hidden') &&
      !viewer.classList.contains('hidden')) {
    findClose();
  }
});

applyTheme();
renderProject();
renderUsage();
gitDetect();
loadSlashItems();
refreshAuth().then(on => {
  if (!on) acctModal.classList.remove('hidden');
});

render();
setStage(null);

// on load: if a project is already imported, ensure its map (cached under
// .loveai, or build it) and start watching for new/removed files this session
if (projectDir) {
  window.deck.symbolEnsure(projectDir).then(r => {
    if (r && r.ok) {
      plog('info', r.cached ? `project map ready (${r.files} files, cached).` : `project map built (${r.files} files).`);
      window.deck.symbolWatch(projectDir).catch(() => {});
    }
  }).catch(() => {});
}
window.deck.onSymbolUpdated(p => plog('info', `project map updated (+/- ${p.changed}) — now ${p.files} files.`));
