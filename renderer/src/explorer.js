// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// EXPLORER — read-only project tree
// ============================================================
const exTree = document.getElementById('ex-tree');
let exLoaded = false;
// dirs (full path) currently expanded — survives exLoad()/refreshWorkspace() rebuilds
// so an add/edit under the active project doesn't collapse the tree back to root
// (VS Code keeps expanded folders open across a refresh).
const exExpandedDirs = new Set();

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
      const wasExpanded = exExpandedDirs.has(item.path);
      const kids = document.createElement('div');
      kids.className = 'ex-children' + (wasExpanded ? '' : ' hidden');
      container.appendChild(kids);
      row.dataset.kids = '1';
      if (wasExpanded) {
        row.querySelector('.ex-caret').textContent = '▾';
        row.querySelector('.ex-ico').textContent = '🗁';
      }
      row.onclick = async (e) => {
        exSelect(row, item, e);
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // multi-select click — don't toggle expand
        const collapsed = kids.classList.toggle('hidden');
        row.querySelector('.ex-caret').textContent = collapsed ? '▸' : '▾';
        row.querySelector('.ex-ico').textContent = collapsed ? '🗀' : '🗁';
        if (collapsed) exExpandedDirs.delete(item.path); else exExpandedDirs.add(item.path);
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
      // rebuild an already-expanded folder eagerly so a refresh doesn't visibly
      // collapse it back to the root — recurses into its own expanded children too
      if (wasExpanded) {
        kids.dataset.loaded = '1';
        await exRenderDir(item.path, kids);
      }
    } else {
      row.dataset.file = item.path;
      row.onclick = (e) => {
        exSelect(row, item, e);
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;   // multi-select click — don't open
        openFile(item.path);
      };
      exBindDropTarget(row, exDirOf(item.path));   // OS files dropped on a file land beside it
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

// a row (file or folder) accepts drops from two sources: an in-app move
// (EX_DRAG_MIME) or an OS file/image dragged in from outside the app
// ('Files') — hovering either a file or a folder row highlights it as the
// target; for a file row the target directory is the file's own parent.
function exBindDropTarget(row, dirPath) {
  row.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    const external = types.includes('Files');
    if (!external && !types.includes(EX_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = external ? 'copy' : 'move';
    row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', (e) => {
    const types = [...e.dataTransfer.types];
    row.classList.remove('drag-over');
    if (types.includes('Files') && e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      exImportExternalFiles(e.dataTransfer.files, dirPath);
      return;
    }
    if (!types.includes(EX_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    let paths; try { paths = JSON.parse(e.dataTransfer.getData(EX_DRAG_MIME)); } catch { return; }
    exMoveItems(paths, dirPath);
  });
}

// import absolute external path(s) (OS drag or the native file picker) into
// `targetDir`, refreshing just that folder's already-rendered listing after.
async function exImportPaths(srcs, targetDir) {
  if (!srcs || !srcs.length) return 0;
  let count = 0;
  for (const src of srcs) {
    const target = await exUniqueImportTarget(targetDir, exNameOf(src));
    const r = await window.deck.fsImport(projectDir, src, target);
    if (!r.ok) { toast(`✗ ${exNameOf(src)}: ${r.error}`, false); continue; }
    count++;
  }
  if (count) {
    toast(`✓ added ${count} item(s)`);
    const container = await exResolveCreateContainer(targetDir);
    await exRenderDir(targetDir, container);
  }
  return count;
}

// OS drag-and-drop of file(s)/folder(s) from outside the app
async function exImportExternalFiles(fileList, targetDir) {
  if (!projectDir) { toast('import a project first', false); return; }
  const srcs = [...fileList].map(f => window.deck.fileToPath(f)).filter(Boolean);
  await exImportPaths(srcs, targetDir);
}

// right-click "Add File(s)" / "Add Image(s)" — native picker into the
// selected folder (or the selected file's parent), same target rule New
// File/New Folder use.
async function exAddViaPicker(images) {
  if (!projectDir) { toast('import a project first', false); return; }
  const dir = exTargetDir();
  const srcs = await window.deck.pickFiles(images);
  await exImportPaths(srcs, dir);
}

// drop on empty tree space (below the last row) — moves/imports to the project root
exTree.addEventListener('dragover', (e) => {
  const types = [...e.dataTransfer.types];
  if (!types.includes('Files') && !types.includes(EX_DRAG_MIME)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
});
exTree.addEventListener('drop', (e) => {
  const types = [...e.dataTransfer.types];
  if (types.includes('Files') && e.dataTransfer.files.length) {
    e.preventDefault();
    exImportExternalFiles(e.dataTransfer.files, projectDir);
    return;
  }
  if (!types.includes(EX_DRAG_MIME)) return;
  e.preventDefault();
  let paths; try { paths = JSON.parse(e.dataTransfer.getData(EX_DRAG_MIME)); } catch { return; }
  exMoveItems(paths, projectDir);
});

// dragging an OS file/image over the EXPLORER sidebar tab while another tab
// is active switches to it automatically (VS Code-style hover-to-activate),
// so the user can keep dragging straight down into the tree.
(() => {
  const tab = document.querySelector('.side-tab[data-tab="explorer"]');
  if (!tab) return;
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  tab.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files') || tab.classList.contains('active')) return;
    e.preventDefault();
    cancel();
    timer = setTimeout(() => { tab.click(); cancel(); }, 500);
  });
  tab.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  tab.addEventListener('dragleave', cancel);
  tab.addEventListener('drop', cancel);
})();

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

// rename an already-rendered row in place — no full exLoad(), so nothing
// else in the tree collapses/flickers. Falls back to a full reload only if
// the row isn't currently rendered (e.g. renamed via a stale reference).
function exRenameRowInPlace(oldPath, newPath, newName) {
  const row = exFindRow(oldPath);
  if (!row) return false;
  const isDir = row.classList.contains('is-dir');
  const kids = isDir ? row.nextElementSibling : null;

  row.dataset.path = newPath;
  if (row.dataset.file) row.dataset.file = newPath;
  row.querySelector('.ex-name').textContent = newName;

  if (isDir && kids) {
    const oldPrefix = oldPath + exSepOf(oldPath), newPrefix = newPath + exSepOf(newPath);
    kids.querySelectorAll('.ex-row').forEach(d => {
      if (d.dataset.path && d.dataset.path.startsWith(oldPrefix)) {
        d.dataset.path = newPrefix + d.dataset.path.slice(oldPrefix.length);
        if (d.dataset.file) d.dataset.file = d.dataset.path;
      }
    });
    if (exExpandedDirs.delete(oldPath)) exExpandedDirs.add(newPath);
  }
  exSortContainer(row.parentElement);   // name changed — re-sort into its new spot
  markOpenRows(); decorateExplorer(); exApplySelClasses();
  return true;
}

// remove an already-rendered row (and its children container, if a folder)
// in place — no full exLoad().
function exRemoveRowInPlace(path) {
  const row = exFindRow(path);
  if (!row) return false;
  const kids = row.classList.contains('is-dir') ? row.nextElementSibling : null;
  row.remove();
  if (kids) kids.remove();
  exExpandedDirs.delete(path);
  return true;
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
// pick a target path for an IMPORTED item (drag-in / picker): keeps the
// original name when it's free, only disambiguating on an actual collision —
// unlike exUniqueTarget above, which always forces a "copy" suffix.
async function exUniqueImportTarget(dir, name) {
  const sep = exSepOf(dir) || exSepOf(projectDir) || '/';
  const listing = await window.deck.fsList(projectDir, dir);
  const existing = new Set((listing.ok ? listing.items : []).map(i => i.name));
  if (!existing.has(name)) return `${dir}${sep}${name}`;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  let outName = `${base} (2)${ext}`, n = 3;
  while (existing.has(outName)) { outName = `${base} (${n})${ext}`; n++; }
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

// ----- send a reference into the main chat composer (the dock), like typing @path -----
function exSendToChat(item) {
  const ci = document.getElementById('ad-input');
  if (!ci) return;
  const rel = exRelPath(item.path);
  const sep = ci.value && !/\s$/.test(ci.value) ? ' ' : '';
  ci.value += sep + '@' + rel + ' ';
  ci.focus();
  ci.setSelectionRange(ci.value.length, ci.value.length);
  toast(`✓ added @${rel} to chat`);
}

// stroke-style icon set for the right-click menu (same visual language as the
// composer's attach/send buttons — 24x24 viewBox, currentColor stroke — so
// the menu doesn't fall back to the OS's flat monochrome emoji glyphs)
const EX_CTX_ICONS = {
  newFile: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  newFolder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  attach: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  cornerUpRight: '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  message: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
};
function exCtxSvg(name) {
  return `<svg class="ex-ctx-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EX_CTX_ICONS[name]}</svg>`;
}

// right-click menu
let exMenu = null;
function exContextMenu(e, item) {
  if (exMenu) exMenu.remove();
  exMenu = document.createElement('div');
  exMenu.className = 'ex-ctx';
  const add = (icon, label, fn) => {
    const it = document.createElement('div'); it.className = 'ex-ctx-item';
    it.innerHTML = exCtxSvg(icon) + `<span>${esc(label)}</span>`;
    it.onclick = () => { exMenu.remove(); exMenu = null; fn(); };
    exMenu.appendChild(it);
  };
  const sep = () => { const s = document.createElement('div'); s.className = 'ex-ctx-sep'; exMenu.appendChild(s); };
  add('newFile', 'New File', () => exStartCreate(false));
  add('newFolder', 'New Folder', () => exStartCreate(true));
  add('attach', 'Add File(s)…', () => exAddViaPicker(false));
  add('image', 'Add Image(s)…', () => exAddViaPicker(true));
  sep();
  add('copy', 'Copy', () => exCopy(item));
  add('layers', 'Duplicate', () => exDuplicate(item));
  if (item.dir && exClipboard) add('clipboard', 'Paste', () => exPaste(item));
  sep();
  add('link', 'Copy Path', () => exCopyPath(item));
  add('cornerUpRight', 'Copy Relative Path', () => exCopyRelativePath(item));
  sep();
  add('message', 'Send to Chat', () => exSendToChat(item));
  sep();
  add('edit', 'Rename', () => exRename(item));
  add('trash', 'Delete', () => exDelete(item));
  document.body.appendChild(exMenu);
  exMenu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  exMenu.style.top = Math.min(e.clientY, window.innerHeight - exMenu.offsetHeight - 8) + 'px';
}
document.addEventListener('click', () => { if (exMenu) { exMenu.remove(); exMenu = null; } });

async function exRename(item) {
  const cur = item.path.split(/[\\/]/).pop();
  const out = await askText({ title: 'RENAME', value: cur, placeholder: 'new name' });
  if (!out || out === cur) return;
  const from = item.path;
  const to = from.replace(/[^\\/]+$/, out);
  const r = await window.deck.fsRename(projectDir, from, to);
  if (!r.ok) { toast('✗ ' + r.error, false); return; }
  toast(`✓ renamed to ${out}`);
  if (exSelected && exSelected.path === from) exSelected = { ...exSelected, path: to };
  if (!exRenameRowInPlace(from, to, out)) await exLoad();
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
  if (!exRemoveRowInPlace(item.path)) await exLoad();
}
document.getElementById('ex-new-file').onclick = () => exStartCreate(false);
document.getElementById('ex-new-folder').onclick = () => exStartCreate(true);

async function exLoad() {
  document.getElementById('ex-root').textContent = projectDir || 'no project imported';
  if (!projectDir) {
    exTree.innerHTML = '<div class="ex-msg">Import a project first (AGENT tab → ⇩ IMPORT).</div>';
    return;
  }
  // only show the loading placeholder on a true first load — a refresh (add/edit
  // file, rename, etc.) rebuilds in place via exExpandedDirs so it doesn't flash
  if (!exTree.children.length) exTree.innerHTML = '<div class="ex-msg">loading...</div>';
  await exRenderDir(projectDir, exTree);
  exLoaded = true;
}

function exReset() {
  exLoaded = false;
  // don't blank exTree here — that's what caused the visible "close then
  // reopen" flash on every add/edit. exLoad()/exRenderDir already swap the
  // DOM atomically (fetch first, replace after), so leave the old tree on
  // screen until the fresh one is ready (VS Code-style in-place refresh).
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
    if (f.dirty || f.kind === 'image') continue;
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

