// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// EXPLORER — read-only project tree
// ============================================================
const exTree = document.getElementById('ex-tree');
let exLoaded = false;

// git status decoration for the tree: normalized-absolute path -> 'conflict' |
// 'modified' | 'untracked'. Built from every repo's status in gitRefresh.
const exStatus = new Map();
const exDirtyDirs = new Set();   // folders (normalized) that contain uncommitted changes
function exNorm(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function buildExStatus(all) {
  exStatus.clear();
  exDirtyDirs.clear();
  const rootN = exNorm(projectDir || '');
  const markAncestors = (key) => {
    let p = key;
    while (true) {
      const cut = p.lastIndexOf('/');
      if (cut <= 0) break;
      p = p.slice(0, cut);
      if (rootN && p.length < rootN.length) break;   // don't climb above the project
      exDirtyDirs.add(p);
      if (p === rootN) break;
    }
  };
  const set = (repo, rel, cls, force) => {
    const key = exNorm(repo + '/' + String(rel).replace(/"/g, ''));
    if (force || !exStatus.has(key)) exStatus.set(key, cls);
    markAncestors(key);
  };
  for (const { repo, st } of all) {
    if (!st.ok) continue;
    for (const f of st.conflicts || []) set(repo, f, 'conflict', true);   // wins
    for (const { f } of st.staged) set(repo, f, 'modified');
    for (const { f } of st.unstaged) set(repo, f, 'modified');
    for (const f of st.untracked) set(repo, f, 'untracked');
  }
}
// paint status classes onto the currently-rendered rows (no disk re-read)
function decorateExplorer() {
  // files: exact status (modified / untracked / conflict)
  exTree.querySelectorAll('.ex-row.is-file').forEach(row => {
    row.classList.remove('gs-conflict', 'gs-modified', 'gs-untracked');
    const badge = row.querySelector('.ex-gs'); if (badge) badge.remove();
    const cls = exStatus.get(exNorm(row.dataset.file || row.dataset.path || row.title));
    if (!cls) return;
    row.classList.add('gs-' + cls);
    const b = document.createElement('span');
    b.className = 'ex-gs gs-' + cls;
    b.textContent = cls === 'conflict' ? '!' : cls === 'untracked' ? 'U' : 'M';
    row.appendChild(b);
  });
  // folders: green if they contain any uncommitted change (VS Code style)
  exTree.querySelectorAll('.ex-row.is-dir').forEach(row => {
    row.classList.remove('gs-dir-changed');
    const dot = row.querySelector('.ex-gs'); if (dot) dot.remove();
    if (exDirtyDirs.has(exNorm(row.dataset.path || row.title))) {
      row.classList.add('gs-dir-changed');
      const b = document.createElement('span');
      b.className = 'ex-gs gs-dir-changed';
      b.textContent = '●';
      row.appendChild(b);
    }
  });
}

// drill into a folder's changed content: expand the first dirty subfolder chain
// until a changed file, then scroll to it (VS Code "reveal changes")
async function exDrillToChange(container) {
  const kids = [...container.querySelectorAll(':scope > .ex-row')];
  const changed = kids.find(r => r.classList.contains('is-file') && exStatus.has(exNorm(r.dataset.path)));
  if (changed) {
    changed.scrollIntoView({ block: 'nearest' });
    changed.classList.add('ex-flash');
    setTimeout(() => changed.classList.remove('ex-flash'), 1200);
    return;
  }
  const dirtyDir = kids.find(r => r.classList.contains('is-dir') && exDirtyDirs.has(exNorm(r.dataset.path)));
  if (!dirtyDir) return;
  const sub = dirtyDir.nextElementSibling;
  if (sub && sub.classList.contains('ex-children')) {
    sub.classList.remove('hidden');
    dirtyDir.querySelector('.ex-caret').textContent = '▾';
    dirtyDir.querySelector('.ex-ico').textContent = '🗁';
    if (!sub.dataset.loaded) { sub.dataset.loaded = '1'; await exRenderDir(dirtyDir.dataset.path, sub); }
    await exDrillToChange(sub);
  }
}

async function exRenderDir(dir, container) {
  const r = await window.deck.fsList(projectDir, dir);
  container.innerHTML = '';
  if (!r.ok) { container.innerHTML = `<div class="ex-msg">${esc(r.error)}</div>`; return; }
  if (!r.items.length) { container.innerHTML = '<div class="ex-msg">(empty)</div>'; return; }

  for (const item of r.items) {
    const row = document.createElement('div');
    row.className = 'ex-row ' + (item.dir ? 'is-dir' : 'is-file') + (item.ignored ? ' is-ignored' : '');
    row.dataset.path = item.path;
    row.dataset.dir = item.dir ? '1' : '';
    row.innerHTML = `<span class="ex-caret">${item.dir ? '▸' : ''}</span><span class="ex-ico">${item.dir ? '🗀' : '📄'}</span><span class="ex-name"></span>`;
    row.querySelector('.ex-name').textContent = item.name;
    row.oncontextmenu = (e) => {
      e.preventDefault();
      if (!exSelectedPaths.has(item.path)) exSelect(row, item);   // keep an existing multi-selection
      exContextMenu(e, item);
    };
    exBindDrag(row, item);
    container.appendChild(row);

    if (item.dir) {
      const kids = document.createElement('div');
      kids.className = 'ex-children hidden';
      container.appendChild(kids);
      row.dataset.kids = '1';
      row.onclick = async (e) => {
        exSelect(row, item, e);
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // multi-select click — don't toggle expand
        const collapsed = kids.classList.toggle('hidden');
        row.querySelector('.ex-caret').textContent = collapsed ? '▸' : '▾';
        row.querySelector('.ex-ico').textContent = collapsed ? '🗀' : '🗁';
        // children load on first expand — keeps big trees (node_modules) cheap
        if (!collapsed && !kids.dataset.loaded) {
          kids.dataset.loaded = '1';
          kids.innerHTML = '<div class="ex-msg">loading...</div>';
          await exRenderDir(item.path, kids);
        }
        // NOTE: normal single-level toggle — the user decides what to open next.
        // (green marking still shows which folders contain uncommitted changes.)
      };
      exBindDropTarget(row, item.path);
    } else {
      row.dataset.file = item.path;
      row.onclick = (e) => {
        exSelect(row, item, e);
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // multi-select click — don't open
        openFile(item.path);
      };
    }
  }
  markOpenRows();
  decorateExplorer();
  exApplySelClasses();
}

// ----- selection (multi, VS Code style) + create/rename/delete -----
let exSelected = null;               // last-focused item — used by New File/Folder placement
const exSelectedPaths = new Set();   // full multi-selection (ctrl+click toggles, shift+click ranges)
let exAnchorPath = null;             // shift-range anchor

function exApplySelClasses() {
  exTree.querySelectorAll('.ex-row').forEach(r => {
    r.classList.toggle('sel', exSelectedPaths.has(r.dataset.path));
  });
}
// `e` is the originating click event — ctrlKey toggles one item in/out of the
// selection, shiftKey selects the visible range from the last anchor, plain
// click resets to just this one (all VS Code conventions).
function exSelect(row, item, e) {
  if (!item) { exSelectedPaths.clear(); exSelected = null; exApplySelClasses(); return; }
  const ctrl = e && (e.ctrlKey || e.metaKey);
  const shift = e && e.shiftKey;
  if (shift && exAnchorPath) {
    const rows = [...exTree.querySelectorAll('.ex-row')];
    const a = rows.findIndex(r => r.dataset.path === exAnchorPath);
    const b = rows.findIndex(r => r.dataset.path === item.path);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      exSelectedPaths.clear();
      for (let i = lo; i <= hi; i++) exSelectedPaths.add(rows[i].dataset.path);
    }
  } else if (ctrl) {
    if (exSelectedPaths.has(item.path)) exSelectedPaths.delete(item.path);
    else exSelectedPaths.add(item.path);
    exAnchorPath = item.path;
  } else {
    exSelectedPaths.clear();
    exSelectedPaths.add(item.path);
    exAnchorPath = item.path;
  }
  exSelected = { path: item.path, isDir: item.dir };
  exApplySelClasses();
}

// ----- drag to move (VS Code style: drag the selection, drop on a folder) -----
const EX_DRAG_MIME = 'application/x-ex-move';

function exBindDrag(row, item) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // dragging a row outside the current selection replaces it; dragging a
    // row that's already part of a multi-selection carries the whole group
    if (!exSelectedPaths.has(item.path)) exSelect(row, item);
    e.dataTransfer.setData(EX_DRAG_MIME, JSON.stringify([...exSelectedPaths]));
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => {
      exTree.querySelectorAll('.ex-row').forEach(r => {
        if (exSelectedPaths.has(r.dataset.path)) r.classList.add('ex-dragging');
      });
    });
  });
  row.addEventListener('dragend', () => {
    exTree.querySelectorAll('.ex-row.ex-dragging').forEach(r => r.classList.remove('ex-dragging'));
    exTree.querySelectorAll('.ex-row.drag-over').forEach(r => r.classList.remove('drag-over'));
  });
}

function exBindDropTarget(row, dirPath) {
  row.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes(EX_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', (e) => {
    if (![...e.dataTransfer.types].includes(EX_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drag-over');
    let paths; try { paths = JSON.parse(e.dataTransfer.getData(EX_DRAG_MIME)); } catch { return; }
    exMoveItems(paths, dirPath);
  });
}

// drop on empty tree space (below the last row) — moves to the project root
exTree.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes(EX_DRAG_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
exTree.addEventListener('drop', (e) => {
  if (![...e.dataTransfer.types].includes(EX_DRAG_MIME)) return;
  e.preventDefault();
  let paths; try { paths = JSON.parse(e.dataTransfer.getData(EX_DRAG_MIME)); } catch { return; }
  exMoveItems(paths, projectDir);
});

// find a row by its exact stored path (not a CSS attribute selector — a raw
// Windows path has backslashes, which are selector escape characters)
function exFindRow(path) {
  for (const r of exTree.querySelectorAll('.ex-row')) if (r.dataset.path === path) return r;
  return null;
}

// re-sort a container's row(+optional .ex-children) pairs: dirs first, then
// alphabetical — same order the initial render uses
function exSortContainer(container) {
  const groups = [];
  for (const child of [...container.children]) {
    if (child.classList.contains('ex-row')) groups.push({ row: child, kids: null });
    else if (child.classList.contains('ex-children') && groups.length) groups[groups.length - 1].kids = child;
  }
  groups.sort((a, b) => {
    const aDir = a.row.classList.contains('is-dir'), bDir = b.row.classList.contains('is-dir');
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.row.querySelector('.ex-name').textContent.localeCompare(b.row.querySelector('.ex-name').textContent);
  });
  for (const g of groups) { container.appendChild(g.row); if (g.kids) container.appendChild(g.kids); }
}

// force a folder open (unhide + fresh load) — used after a move so the
// target's new content (the item that just landed there) actually shows,
// even if the target was collapsed or its stale cached listing was loaded
// before the move happened.
async function exAutoExpand(row, kids, path) {
  kids.classList.remove('hidden');
  row.querySelector('.ex-caret').textContent = '▾';
  row.querySelector('.ex-ico').textContent = '🗁';
  kids.dataset.loaded = '1';
  kids.innerHTML = '<div class="ex-msg">loading...</div>';
  await exRenderDir(path, kids);
}

// relocate an already-rendered row (and its loaded children, if a folder) to
// its new parent WITHOUT touching anything else in the tree — no full
// reload, no other folder collapsing. If the target isn't currently open,
// auto-open it so the move is actually visible instead of vanishing.
async function exRelocateRow(oldPath, newPath, targetDir) {
  const row = exFindRow(oldPath);
  if (!row) return;   // wasn't visible (inside a collapsed folder) — nothing to patch
  const isDir = row.classList.contains('is-dir');
  const kids = isDir ? row.nextElementSibling : null;

  row.dataset.path = newPath;
  if (row.dataset.file) row.dataset.file = newPath;
  // a moved folder's already-loaded descendants keep their OWN absolute
  // paths in dataset — rewrite the prefix so future moves/menu actions on
  // them still target the right place
  if (isDir && kids) {
    const oldPrefix = oldPath + exSepOf(oldPath), newPrefix = newPath + exSepOf(newPath);
    kids.querySelectorAll('.ex-row').forEach(d => {
      if (d.dataset.path && d.dataset.path.startsWith(oldPrefix)) {
        d.dataset.path = newPrefix + d.dataset.path.slice(oldPrefix.length);
        if (d.dataset.file) d.dataset.file = d.dataset.path;
      }
    });
  }

  if (targetDir === projectDir) {
    // root is always "open" — relocate straight into it
    row.classList.add('ex-move-in');
    exTree.appendChild(row);
    if (kids) exTree.appendChild(kids);
    requestAnimationFrame(() => row.classList.remove('ex-move-in'));
    exSortContainer(exTree);
    return;
  }

  const targetRow = exFindRow(targetDir);
  if (!targetRow) {
    // target folder isn't rendered at all right now (inside a collapsed
    // ancestor) — nothing to auto-open toward; just fade the row away
    row.classList.add('ex-move-out');
    setTimeout(() => { row.remove(); if (kids) kids.remove(); }, 150);
    return;
  }
  const targetKids = targetRow.nextElementSibling;
  const alreadyOpen = targetKids && targetKids.classList.contains('ex-children')
    && !targetKids.classList.contains('hidden') && targetKids.dataset.loaded;

  if (alreadyOpen) {
    row.classList.add('ex-move-in');
    targetKids.appendChild(row);
    if (kids) targetKids.appendChild(kids);
    requestAnimationFrame(() => row.classList.remove('ex-move-in'));
    exSortContainer(targetKids);
    return;
  }

  // target isn't open — fade the old row away and auto-expand the target so
  // its fresh listing (the file is already moved on disk) shows the result
  row.classList.add('ex-move-out');
  setTimeout(() => { row.remove(); if (kids) kids.remove(); }, 150);
  await exAutoExpand(targetRow, targetKids, targetDir);
}

// confirm, then move each dropped path into `targetDir`
async function exMoveItems(paths, targetDir) {
  if (!paths || !paths.length) return;
  const targetLabel = targetDir === projectDir ? '(project root)' : exNameOf(targetDir);
  // if a folder AND something inside it are both selected, moving the folder
  // already carries its contents — drop the redundant descendant, otherwise
  // each would be renamed independently into two different places
  const topLevel = paths.filter(p =>
    !paths.some(q => q !== p && p.startsWith(q + (exSepOf(q) || '\\'))));

  const movable = [];
  for (const p of topLevel) {
    if (exDirOf(p) === targetDir) continue;                       // already there — silently skip
    const sep = exSepOf(p) || '\\';
    if (targetDir === p || targetDir.startsWith(p + sep)) {
      toast(`✗ can't move "${exNameOf(p)}" into itself`, false);
      continue;
    }
    movable.push(p);
  }
  if (!movable.length) return;

  const list = movable.map(p => `• ${exNameOf(p)}`).join('\n');
  const ok = await showAlert({
    title: 'MOVE',
    message: `Move ${movable.length === 1 ? `"${exNameOf(movable[0])}"` : movable.length + ' items'} to "${targetLabel}"?\n\n${list}`,
    okText: 'MOVE', cancelText: 'CANCEL', kind: 'warn'
  });
  if (!ok) return;

  let moved = 0;
  for (const p of movable) {
    const sep = exSepOf(targetDir) || exSepOf(projectDir) || '\\';
    const to = `${targetDir}${sep}${exNameOf(p)}`;
    const r = await window.deck.fsRename(projectDir, p, to);
    if (!r.ok) { toast(`✗ ${exNameOf(p)}: ${r.error}`, false); continue; }
    moved++;
    await exRelocateRow(p, to, targetDir);   // patch the DOM in place — no exLoad()
  }
  if (moved) toast(`✓ moved ${moved} item(s) to ${targetLabel}`);
  exSelectedPaths.clear(); exSelected = null;
  exApplySelClasses();
}

// the folder new items land in: selected folder, or a file's parent, or root
function exTargetDir() {
  if (!exSelected) return projectDir;
  return exSelected.isDir ? exSelected.path : exSelected.path.replace(/[\\/][^\\/]+$/, '');
}
// find the container the new-item input (and later the created item) should
// land in: the selected folder's own child list, expanding/loading it first
// if it isn't already open — falls back to the tree root.
async function exResolveCreateContainer(dir) {
  if (dir === projectDir) return exTree;
  const row = exFindRow(dir);
  const kids = row && row.nextElementSibling;
  if (!row || !kids || !kids.classList.contains('ex-children')) return exTree;
  if (kids.classList.contains('hidden')) {
    kids.classList.remove('hidden');
    row.querySelector('.ex-caret').textContent = '▾';
    row.querySelector('.ex-ico').textContent = '🗁';
  }
  if (!kids.dataset.loaded) {
    kids.dataset.loaded = '1';
    kids.innerHTML = '<div class="ex-msg">loading...</div>';
    await exRenderDir(dir, kids);
  }
  return kids;
}

async function exStartCreate(isDir) {
  if (!projectDir) { toast('import a project first', false); return; }
  const dir = exTargetDir();
  const rel = dir === projectDir ? 'root' : dir.slice(projectDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  const container = await exResolveCreateContainer(dir);
  const wrap = document.createElement('div');
  wrap.className = 'ex-newrow';
  wrap.innerHTML = `<span class="ex-ico">${isDir ? '🗀' : '📄'}</span><input class="ex-newinput" spellcheck="false" placeholder="${isDir ? 'new folder' : 'new file'} in ${esc(rel)}/…" />`;
  container.prepend(wrap);
  const inp = wrap.querySelector('.ex-newinput');
  inp.focus();
  let done = false;
  const close = () => { if (!done) { done = true; wrap.remove(); } };
  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const name = inp.value.trim();
      if (!name) { close(); return; }
      done = true; wrap.remove();
      const res = await window.deck.fsCreate(projectDir, dir, name, isDir);
      if (!res.ok) { toast('✗ ' + res.error, false); return; }
      toast(`✓ created ${name}`);
      await exRenderDir(dir, container);
      if (!isDir) openFile(res.path);
    } else if (e.key === 'Escape') close();
  });
  inp.addEventListener('blur', () => setTimeout(close, 120));
}

// ----- path helpers (renderer has no `path` module — work from the raw string) -----
function exSepOf(p) { return String(p).includes('\\') ? '\\' : '/'; }
function exDirOf(p) {
  const sep = exSepOf(p);
  const i = p.lastIndexOf(sep);
  return i === -1 ? '' : p.slice(0, i);
}
function exNameOf(p) {
  const sep = exSepOf(p);
  const i = p.lastIndexOf(sep);
  return i === -1 ? p : p.slice(i + 1);
}
function exRelPath(p) {
  return p.slice(projectDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
}
// pick a name that doesn't already exist in `dir` — "name copy.ext", "name copy 2.ext"...
async function exUniqueTarget(dir, name) {
  const sep = exSepOf(dir) || exSepOf(projectDir) || '/';
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const listing = await window.deck.fsList(projectDir, dir);
  const existing = new Set((listing.ok ? listing.items : []).map(i => i.name));
  let outName = `${base} copy${ext}`, n = 2;
  while (existing.has(outName)) { outName = `${base} copy ${n}${ext}`; n++; }
  return `${dir}${sep}${outName}`;
}

// ----- Copy / Duplicate / Paste (clipboard here is our own, in-app only) -----
let exClipboard = null;   // { path, isDir }
function exCopy(item) {
  exClipboard = { path: item.path, isDir: item.dir };
  toast(`✓ copied ${exNameOf(item.path)} — right-click a folder → Paste`);
}
async function exDuplicate(item) {
  const target = await exUniqueTarget(exDirOf(item.path), exNameOf(item.path));
  const r = await window.deck.fsCopy(projectDir, item.path, target);
  if (!r.ok) { toast('✗ ' + r.error, false); return; }
  toast(`✓ duplicated ${exNameOf(item.path)}`);
  await exLoad();
}
async function exPaste(dirItem) {
  if (!exClipboard) return;
  const dir = dirItem ? dirItem.path : projectDir;
  const target = await exUniqueTarget(dir, exNameOf(exClipboard.path));
  const r = await window.deck.fsCopy(projectDir, exClipboard.path, target);
  if (!r.ok) { toast('✗ ' + r.error, false); return; }
  toast(`✓ pasted ${exNameOf(target)}`);
  await exLoad();
}

// ----- clipboard text (OS clipboard, via main process) -----
async function exCopyPath(item) {
  await window.deck.clipboardWrite(item.path);
  toast('✓ path copied');
}
async function exCopyRelativePath(item) {
  await window.deck.clipboardWrite(exRelPath(item.path));
  toast('✓ relative path copied');
}

// ----- send a reference into the main chat composer, like typing @path -----
function exSendToChat(item) {
  const ci = document.getElementById('chat-input');
  if (!ci) return;
  const rel = exRelPath(item.path);
  const sep = ci.value && !/\s$/.test(ci.value) ? ' ' : '';
  ci.value += sep + '@' + rel + ' ';
  ci.focus();
  ci.setSelectionRange(ci.value.length, ci.value.length);
  toast(`✓ added @${rel} to chat`);
}

// right-click menu
let exMenu = null;
function exContextMenu(e, item) {
  if (exMenu) exMenu.remove();
  exMenu = document.createElement('div');
  exMenu.className = 'ex-ctx';
  const add = (label, fn) => {
    const it = document.createElement('div'); it.className = 'ex-ctx-item'; it.textContent = label;
    it.onclick = () => { exMenu.remove(); exMenu = null; fn(); };
    exMenu.appendChild(it);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'ex-ctx-sep'; exMenu.appendChild(s); };
  add('🗋 New File', () => exStartCreate(false));
  add('🗀 New Folder', () => exStartCreate(true));
  sep();
  add('⧉ Copy', () => exCopy(item));
  add('❐ Duplicate', () => exDuplicate(item));
  if (item.dir && exClipboard) add('📋 Paste', () => exPaste(item));
  sep();
  add('⎘ Copy Path', () => exCopyPath(item));
  add('⎘ Copy Relative Path', () => exCopyRelativePath(item));
  sep();
  add('💬 Send to Chat', () => exSendToChat(item));
  sep();
  add('✎ Rename', () => exRename(item));
  add('🗑 Delete', () => exDelete(item));
  document.body.appendChild(exMenu);
  exMenu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  exMenu.style.top = Math.min(e.clientY, window.innerHeight - exMenu.offsetHeight - 8) + 'px';
}
document.addEventListener('click', () => { if (exMenu) { exMenu.remove(); exMenu = null; } });

async function exRename(item) {
  const cur = item.path.split(/[\\/]/).pop();
  const out = await askText({ title: 'RENAME', value: cur, placeholder: 'new name' });
  if (!out || out === cur) return;
  const to = item.path.replace(/[^\\/]+$/, out);
  const r = await window.deck.fsRename(projectDir, item.path, to);
  if (!r.ok) { toast('✗ ' + r.error, false); return; }
  toast(`✓ renamed to ${out}`);
  await exLoad();
}
async function exDelete(item) {
  const name = item.path.split(/[\\/]/).pop();
  const ok = await showAlert({ title: 'DELETE', message: `Delete "${name}"${item.dir ? ' and everything in it' : ''}? This can't be undone.`, okText: 'DELETE', cancelText: 'CANCEL', kind: 'danger' });
  if (!ok) return;
  const r = await window.deck.fsDelete(projectDir, item.path);
  if (!r.ok) { toast('✗ ' + r.error, false); return; }
  toast(`✓ deleted ${name}`);
  if (exSelected && exSelected.path === item.path) exSelected = null;
  exSelectedPaths.delete(item.path);
  await exLoad();
}
document.getElementById('ex-new-file').onclick = () => exStartCreate(false);
document.getElementById('ex-new-folder').onclick = () => exStartCreate(true);

async function exLoad() {
  document.getElementById('ex-root').textContent = projectDir || 'no project imported';
  if (!projectDir) {
    exTree.innerHTML = '<div class="ex-msg">Import a project first (AGENT tab → ⇩ IMPORT).</div>';
    return;
  }
  exTree.innerHTML = '<div class="ex-msg">loading...</div>';
  await exRenderDir(projectDir, exTree);
  exLoaded = true;
}

function exReset() {
  exLoaded = false;
  exTree.innerHTML = '';
  if (!document.getElementById('tab-explorer').classList.contains('hidden')) exLoad();
}

// Something changed the files on disk out from under us (git pull/merge/checkout,
// an agent run). Rebuild the explorer tree and re-read every OPEN, unmodified file
// so the editor shows the new content instead of a stale buffer. Files with unsaved
// edits are left alone (we don't clobber the operator's work).
async function refreshWorkspace() {
  exReset();
  let activeChanged = false;
  for (const f of openFiles) {
    if (f.dirty) continue;
    const r = await window.deck.fsRead(projectDir, f.path, shikiTheme());
    if (!r.ok) continue;
    if (r.content !== f.content) {
      f.content = r.content;
      f.value = r.content;
      f.html = shikiInner(r.html);
      f.indent = detectIndent(r.content);
      if (f.path === activeFile) activeChanged = true;
    }
  }
  if (activeChanged) renderViewer();
}

document.getElementById('ex-refresh').onclick = exLoad;
document.getElementById('ex-filter').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  exTree.querySelectorAll('.ex-row.is-file').forEach(r => {
    const name = r.querySelector('.ex-name').textContent.toLowerCase();
    r.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
};

