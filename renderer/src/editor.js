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
