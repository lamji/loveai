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
const vwEdit = document.querySelector('.vw-edit');
const vwImage = document.getElementById('vw-image');
const vwImageEl = document.getElementById('vw-image-el');
const openFiles = [];
let activeFile = null;

function baseName(p) { return p.split(/[\\/]/).pop(); }
function relPath(p) { return projectDir && p.startsWith(projectDir) ? p.slice(projectDir.length).replace(/^[\\/]/, '') : p; }

// previewed, not edited — no text buffer, no shiki, no dirty tracking
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|apng|tiff?|jfif)$/i;
function isImageFile(p) { return IMAGE_EXT_RE.test(p); }

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
    if (isImageFile(path)) {
      const r = await window.deck.fsReadImage(projectDir, path);
      if (!r.ok) { feedRaw('EXPLORER', 'err', `${baseName(path)}: ${r.error}`, '🗀'); return; }
      // re-check after the await — a fast double-click can race two openFile
      // calls; the first to finish wins the tab, the second just re-opens it
      if (!openFiles.some(f => f.path === path)) {
        openFiles.push({
          path, kind: 'image', dataUrl: r.dataUrl,
          zoom: 100, panX: 0, panY: 0,
          dirty: false, diskChanged: false
        });
        syncWatchedFiles();
      }
    } else {
      const r = await window.deck.fsRead(projectDir, path, shikiTheme());
      if (!r.ok) { feedRaw('EXPLORER', 'err', `${baseName(path)}: ${r.error}`, '🗀'); return; }
      if (!openFiles.some(f => f.path === path)) {
        openFiles.push({
          path, lang: r.lang,
          content: r.content,          // what's on disk
          value: r.content,            // what's in the buffer
          html: shikiInner(r.html),
          indent: detectIndent(r.content),
          dirty: false,
          diskChanged: false
        });
        syncWatchedFiles();
      }
    }
  }
  activeFile = path;
  paneOverride = 'editor';
  viewer.classList.remove('hidden');
  consoleFeed.classList.add('hidden');   // editor takes the editor-area (panel unaffected)
  renderViewer();
  renderConsoleChips();
  if (!isImageFile(path)) vwInput.focus();
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
  syncWatchedFiles();
  if (activeFile === path) activeFile = openFiles.length ? openFiles[Math.max(0, i - 1)].path : null;
  if (!activeFile) { paneOverride = null; viewer.classList.add('hidden'); renderTabs(); markOpenRows(); return; }
  renderViewer();
}

// ===== Watch open files on disk — reload / warn when they change externally
// (an agent editing the file, a git checkout, an external editor). =====
function syncWatchedFiles() {
  window.deck.watchFiles(projectDir, openFiles.map(f => f.path)).catch(() => {});
}

async function reloadFromDisk(f) {
  if (f.kind === 'image') {
    const r = await window.deck.fsReadImage(projectDir, f.path);
    if (!r.ok) { feedRaw('EDITOR', 'err', `reload failed — ${baseName(f.path)}: ${r.error}`, '🔄'); return; }
    f.dataUrl = r.dataUrl;
    f.diskChanged = false;
    if (activeFile === f.path) renderViewer();
    renderTabs();
    updateDiskBanner();
    return;
  }
  const r = await window.deck.fsRead(projectDir, f.path, shikiTheme());
  if (!r.ok) { feedRaw('EDITOR', 'err', `reload failed — ${baseName(f.path)}: ${r.error}`, '🔄'); return; }
  f.content = r.content;
  f.value = r.content;
  f.html = shikiInner(r.html);
  f.dirty = false;
  f.diskChanged = false;
  if (activeFile === f.path) { vwInput.value = f.value; renderViewer(); }
  renderTabs();
  updateDiskBanner();
}

window.deck.onFileDiskChange(({ path }) => {
  const f = openFiles.find(x => x.path === path);
  if (!f) return;
  if (!f.dirty) { reloadFromDisk(f); return; }   // clean buffer → silent refresh
  // dirty buffer → don't clobber the user's edits; flag + surface a banner
  f.diskChanged = true;
  renderTabs();
  if (activeFile === f.path) updateDiskBanner();
});

// non-destructive banner over the editor when the active dirty file changed on disk
const diskBanner = document.createElement('div');
diskBanner.id = 'vw-diskbanner';
diskBanner.className = 'hidden';
diskBanner.innerHTML = `
  <span>⚠ This file changed on disk while you had unsaved edits.</span>
  <button id="vwd-reload" class="vwd-btn">Reload from disk</button>
  <button id="vwd-keep" class="vwd-btn ghost">Keep my edits</button>`;

function mountDiskBanner() {
  if (diskBanner.parentNode) return;
  viewer.insertBefore(diskBanner, document.getElementById('vw-body'));
  document.getElementById('vwd-reload').onclick = () => { const f = activeF(); if (f) reloadFromDisk(f); };
  document.getElementById('vwd-keep').onclick = () => {
    const f = activeF(); if (f) { f.diskChanged = false; renderTabs(); updateDiskBanner(); }
  };
}
function updateDiskBanner() {
  mountDiskBanner();
  const f = activeF();
  diskBanner.classList.toggle('hidden', !(f && f.diskChanged));
}

function renderTabs() {
  const tabs = document.getElementById('vw-tabs');
  tabs.innerHTML = '';
  for (const f of openFiles) {
    const t = document.createElement('div');
    t.className = 'vw-tab' + (f.path === activeFile ? ' active' : '')
      + (f.dirty ? ' dirty' : '') + (f.diskChanged ? ' disk-changed' : '');
    t.title = f.path + (f.dirty ? ' — unsaved (Ctrl+S)' : '')
      + (f.diskChanged ? ' — changed on disk' : '');
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
    t.onclick = () => { activeFile = f.path; renderViewer(); if (f.kind !== 'image') vwInput.focus(); };
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
  const isImage = f.kind === 'image';
  vwGutter.classList.toggle('hidden', isImage);
  vwEdit.classList.toggle('hidden', isImage);
  vwImage.classList.toggle('hidden', !isImage);
  if (isImage) {
    vwImageEl.src = f.dataUrl;
    applyImageTransform(f);
  } else {
    vwInput.value = f.value;
    paintCode(f);
    renderGutter(f.value);
  }
  document.getElementById('vw-body').scrollTop = 0;
  markOpenRows();
  updateDiskBanner();
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
  // the file changed underneath us and the user chose to keep editing — confirm
  // before the save overwrites whatever landed on disk (e.g. an agent's edit)
  if (f.diskChanged) {
    const overwrite = await showAlert({
      title: 'FILE CHANGED ON DISK',
      message: `${baseName(f.path)} was modified on disk after you started editing. `
        + `Saving now overwrites those changes with your version.`,
      okText: 'OVERWRITE',
      cancelText: 'CANCEL',
      kind: 'danger'
    });
    if (!overwrite) return;
    f.diskChanged = false;
    updateDiskBanner();
  }
  const r = await window.deck.fsWrite(projectDir, f.path, f.value);
  if (!r.ok) { feedRaw('EDITOR', 'err', `save failed — ${baseName(f.path)}: ${r.error}`, '💾'); return; }
  f.content = f.value;
  f.dirty = false;
  renderTabs();
  feedRaw('EDITOR', 'ok', `saved ${relPath(f.path)}`, '💾');
  if (gitRepo) gitRefresh();
}

// ============================================================
// TOGGLE COMMENT — Ctrl+/, VS Code style. Comments/uncomments every line
// touched by the selection (or just the caret line with no selection).
// ============================================================
const LINE_COMMENT_MAP = {
  js: '//', jsx: '//', ts: '//', tsx: '//', jsonc: '//', java: '//', kotlin: '//',
  swift: '//', c: '//', cpp: '//', csharp: '//', php: '//', dart: '//', go: '//',
  rust: '//', scss: '//', less: '//',
  python: '#', ruby: '#', yaml: '#', toml: '#', ini: '#', shellscript: '#',
  powershell: '#', dotenv: '#', docker: '#', ignore: '#', graphql: '#',
  bat: '::',
  sql: '--'
};
const BLOCK_COMMENT_MAP = {
  html: ['<!--', '-->'], xml: ['<!--', '-->'], vue: ['<!--', '-->'], svelte: ['<!--', '-->'],
  md: ['<!--', '-->'], mdx: ['<!--', '-->'],
  css: ['/*', '*/']
};

function commentTokens(lang) {
  if (BLOCK_COMMENT_MAP[lang]) return { block: BLOCK_COMMENT_MAP[lang] };
  return { line: LINE_COMMENT_MAP[lang] || '//' };
}

function toggleLineComment(prefix) {
  const val = vwInput.value;
  const selStart = vwInput.selectionStart, selEnd = vwInput.selectionEnd;
  const lineStart = val.lastIndexOf('\n', selStart - 1) + 1;
  // exclude a trailing line whose selection only touches its column-0 start
  const effectiveEnd = (selEnd > selStart && val[selEnd - 1] === '\n') ? selEnd - 1 : selEnd;
  let lineEnd = val.indexOf('\n', effectiveEnd);
  if (lineEnd === -1) lineEnd = val.length;

  const lines = val.slice(lineStart, lineEnd).split('\n');
  const nonBlank = lines.filter(l => l.trim() !== '');
  const target = nonBlank.length ? nonBlank : lines;
  const escPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const commentRe = new RegExp('^(\\s*)' + escPrefix + ' ?');
  const allCommented = target.every(l => commentRe.test(l));

  let newLines;
  if (allCommented) {
    newLines = lines.map(l => l.replace(commentRe, '$1'));
  } else {
    const minIndent = Math.min(...nonBlank.map(l => (/^(\s*)/.exec(l))[1].length));
    newLines = lines.map(l => l.trim() === '' ? l : l.slice(0, minIndent) + prefix + ' ' + l.slice(minIndent));
  }
  const newBlock = newLines.join('\n');

  vwInput.setSelectionRange(lineStart, lineEnd);
  document.execCommand('insertText', false, newBlock);
  vwInput.setSelectionRange(lineStart, lineStart + newBlock.length);
}

function toggleBlockComment(tokens) {
  const [open, close] = tokens;
  const val = vwInput.value;
  let start = vwInput.selectionStart, end = vwInput.selectionEnd;
  let text = val.slice(start, end);
  const noSelection = start === end;
  if (noSelection) {
    // wrap the whole caret line, like VS Code does with no selection
    start = val.lastIndexOf('\n', start - 1) + 1;
    end = val.indexOf('\n', start);
    if (end === -1) end = val.length;
    text = val.slice(start, end);
  }

  const wrapped = new RegExp('^' + open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + ' ?([\\s\\S]*?) ?' + close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').exec(text);

  const newText = wrapped ? wrapped[1] : `${open} ${text} ${close}`;
  vwInput.setSelectionRange(start, end);
  document.execCommand('insertText', false, newText);
  vwInput.setSelectionRange(start, start + newText.length);
}

function toggleComment(f) {
  const tokens = commentTokens(f.lang);
  if (tokens.block) toggleBlockComment(tokens.block);
  else toggleLineComment(tokens.line);
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

  // Ctrl+/ — toggle line comment, VS Code style
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault();
    toggleComment(f);
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

// (the editor's own ✕ was removed — closing is done via the Console/Explorer
// chips at the top and each tab's ✕)
const _vwClose = document.getElementById('vw-close');
if (_vwClose) _vwClose.onclick = () => {
  paneOverride = 'console';
  viewer.classList.add('hidden');
  markOpenRows();
};

// ============================================================
// EDITOR FONT ZOOM — Ctrl+= / Ctrl+- to grow/shrink, Ctrl+0 to reset.
// Persists across sessions. Line-height tracks the font size (~1.36x).
// ============================================================
const EDITOR_ZOOM_KEY = 'editorFontSize';
const EDITOR_FONT_MIN = 8;
const EDITOR_FONT_MAX = 40;
const EDITOR_FONT_DEFAULT = 14;

function applyEditorFont(px) {
  const size = Math.max(EDITOR_FONT_MIN, Math.min(EDITOR_FONT_MAX, px));
  const line = Math.round(size * 1.36);
  document.documentElement.style.setProperty('--editor-font-size', size + 'px');
  document.documentElement.style.setProperty('--editor-line-height', line + 'px');
  localStorage.setItem(EDITOR_ZOOM_KEY, String(size));
  return size;
}

function currentEditorFont() {
  return parseInt(localStorage.getItem(EDITOR_ZOOM_KEY), 10) || EDITOR_FONT_DEFAULT;
}

// restore the saved size on load
applyEditorFont(currentEditorFont());

function zoomEditor(delta) {
  const size = applyEditorFont(currentEditorFont() + delta);
  if (window.toast) toast(`Editor font: ${size}px`, true);
  if (window.renderStatusBar) renderStatusBar();
}

// ============================================================
// IMAGE PREVIEW ZOOM — same Ctrl+=/-/0 and Ctrl+wheel gestures as the text
// editor, but scaling the <img> instead of the font. Not persisted — each
// image reopens at 100% (fit-to-pane).
// ============================================================
const IMAGE_ZOOM_MIN = 25, IMAGE_ZOOM_MAX = 800, IMAGE_ZOOM_STEP = 10;

function applyImageZoom(f, pct) {
  f.zoom = Math.max(IMAGE_ZOOM_MIN, Math.min(IMAGE_ZOOM_MAX, Math.round(pct)));
  applyImageTransform(f);
  if (window.toast) toast(`Image zoom: ${f.zoom}%`, true);
  if (window.renderStatusBar) renderStatusBar();
  return f.zoom;
}
function zoomImage(f, delta) { return applyImageZoom(f, (f.zoom || 100) + delta); }

// translate (pan) then scale (zoom) — combined so panning around a zoomed-in
// image works instead of the two fighting over the same style property
function applyImageTransform(f) {
  const zoom = (f.zoom || 100) / 100;
  const x = f.panX || 0, y = f.panY || 0;
  vwImageEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  // dragging only makes sense once the image is bigger than its fitted pane
  vwImage.classList.toggle('zoomed', (f.zoom || 100) > 100);
}
function resetImageView(f) {
  f.zoom = 100; f.panX = 0; f.panY = 0;
  applyImageTransform(f);
  if (window.toast) toast('Image zoom: 100%', true);
  if (window.renderStatusBar) renderStatusBar();
}

// drag with the left mouse button to pan a zoomed-in image around, VS
// Code/Photoshop-style — reveals whichever edge got cropped by the pane.
vwImageEl.draggable = false;
let imgDrag = null;
vwImageEl.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const f = activeF();
  if (!f || f.kind !== 'image' || (f.zoom || 100) <= 100) return;
  e.preventDefault();
  imgDrag = { startX: e.clientX, startY: e.clientY, panX: f.panX || 0, panY: f.panY || 0, f };
  vwImage.classList.add('dragging');
});
window.addEventListener('mousemove', e => {
  if (!imgDrag) return;
  imgDrag.f.panX = imgDrag.panX + (e.clientX - imgDrag.startX);
  imgDrag.f.panY = imgDrag.panY + (e.clientY - imgDrag.startY);
  applyImageTransform(imgDrag.f);
});
window.addEventListener('mouseup', () => {
  if (!imgDrag) return;
  imgDrag = null;
  vwImage.classList.remove('dragging');
});

// Ctrl/Cmd + = / - / 0 — only while the editor pane is visible
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (viewer.classList.contains('hidden')) return;
  const f = activeF();
  if (f && f.kind === 'image') {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomImage(f, IMAGE_ZOOM_STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomImage(f, -IMAGE_ZOOM_STEP); }
    else if (e.key === '0') { e.preventDefault(); resetImageView(f); }
    return;
  }
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomEditor(1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomEditor(-1); }
  else if (e.key === '0') { e.preventDefault(); applyEditorFont(EDITOR_FONT_DEFAULT); }
});

// Ctrl + mouse wheel over the editor also zooms, like VS Code
document.getElementById('vw-body').addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const f = activeF();
  if (f && f.kind === 'image') { zoomImage(f, e.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP); return; }
  zoomEditor(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// ============================================================
// SEND SELECTION TO AI — highlight code in the editor and a floating
// button appears; clicking attaches the selection to the main chatbox
// as a context chip (never dumped into the textarea, so the UI holds).
// ============================================================
const sendAiBtn = document.createElement('button');
sendAiBtn.id = 'code-send-ai';
sendAiBtn.className = 'code-send-btn hidden';
sendAiBtn.innerHTML = '✦ Send to AI';
document.body.appendChild(sendAiBtn);

function hideSendAi() { sendAiBtn.classList.add('hidden'); }

function selectionLineRange(f, start, end) {
  const before = f.value.slice(0, start);
  const startLine = before.split('\n').length;
  const endLine = startLine + f.value.slice(start, end).split('\n').length - 1;
  return { startLine, endLine };
}

// show the button just above the mouse-up point, clamped to the viewport
function showSendAiAt(x, y) {
  sendAiBtn.classList.remove('hidden');
  const w = sendAiBtn.offsetWidth || 110;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(8, y - 40);
  sendAiBtn.style.left = left + 'px';
  sendAiBtn.style.top = top + 'px';
}

function maybeShowSendAi(e) {
  const f = activeF();
  if (!f) { hideSendAi(); return; }
  const sel = vwInput.value.slice(vwInput.selectionStart, vwInput.selectionEnd);
  if (!sel.trim()) { hideSendAi(); return; }
  showSendAiAt(e.clientX, e.clientY);
}

vwInput.addEventListener('mouseup', e => setTimeout(() => maybeShowSendAi(e), 0));
// selecting with the keyboard (Shift+arrows) hides it — it needs a pointer anchor
vwInput.addEventListener('keyup', () => {
  const sel = vwInput.value.slice(vwInput.selectionStart, vwInput.selectionEnd);
  if (!sel.trim()) hideSendAi();
});
vwInput.addEventListener('scroll', hideSendAi);
document.addEventListener('mousedown', e => {
  if (e.target !== sendAiBtn) hideSendAi();
});

sendAiBtn.addEventListener('mousedown', e => e.preventDefault());  // keep selection
sendAiBtn.addEventListener('click', () => {
  const f = activeF();
  if (!f) return;
  const start = vwInput.selectionStart, end = vwInput.selectionEnd;
  const code = f.value.slice(start, end);
  if (!code.trim()) { hideSendAi(); return; }
  const { startLine, endLine } = selectionLineRange(f, start, end);
  if (window.addSnippetAttachment) {
    window.addSnippetAttachment({
      file: relPath(f.path), lang: f.lang, code, start: startLine, end: endLine
    });
  }
  hideSendAi();
  // surface the chip: make sure the AGENT tab (with the composer) is showing
  const agentTab = document.querySelector('.side-tab[data-tab="agent"]');
  if (agentTab && document.getElementById('tab-agent').classList.contains('hidden')) {
    agentTab.click();
  }
  if (window.toggleSidebar && document.getElementById('sidebar').classList.contains('collapsed')) {
    window.toggleSidebar();
  }
  const ci = document.getElementById('chat-input');
  if (ci) ci.focus();
  if (window.toast) toast('Selection attached as context', true);
});

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
// seed recent folders from any projects already open, then paint the rail
// and the Welcome screen (shown when the active project has no folder yet)
[...workspaces].reverse().forEach(w => { if (w.path) addRecentFolder(w.path); });
renderRail();
renderWelcome();
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
