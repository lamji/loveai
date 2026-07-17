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
    row.className = 'ex-row ' + (item.dir ? 'is-dir' : 'is-file');
    row.title = item.path;
    row.dataset.path = item.path;
    row.dataset.dir = item.dir ? '1' : '';
    row.innerHTML = `<span class="ex-caret">${item.dir ? '▸' : ''}</span><span class="ex-ico">${item.dir ? '🗀' : '📄'}</span><span class="ex-name"></span>`;
    row.querySelector('.ex-name').textContent = item.name;
    row.oncontextmenu = (e) => { e.preventDefault(); exSelect(row, item); exContextMenu(e, item); };
    container.appendChild(row);

    if (item.dir) {
      const kids = document.createElement('div');
      kids.className = 'ex-children hidden';
      container.appendChild(kids);
      row.dataset.kids = '1';
      row.onclick = async () => {
        exSelect(row, item);
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
    } else {
      row.dataset.file = item.path;
      row.onclick = () => { exSelect(row, item); openFile(item.path); };
    }
  }
  markOpenRows();
  decorateExplorer();
}

// ----- selection + VS Code-style create/rename/delete -----
let exSelected = null;   // { path, isDir }
function exSelect(row, item) {
  exTree.querySelectorAll('.ex-row.sel').forEach(r => r.classList.remove('sel'));
  if (row) row.classList.add('sel');
  exSelected = item ? { path: item.path, isDir: item.dir } : null;
}
// the folder new items land in: selected folder, or a file's parent, or root
function exTargetDir() {
  if (!exSelected) return projectDir;
  return exSelected.isDir ? exSelected.path : exSelected.path.replace(/[\\/][^\\/]+$/, '');
}
function exStartCreate(isDir) {
  if (!projectDir) { toast('import a project first', false); return; }
  const dir = exTargetDir();
  const rel = dir === projectDir ? 'root' : dir.slice(projectDir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  const wrap = document.createElement('div');
  wrap.className = 'ex-newrow';
  wrap.innerHTML = `<span class="ex-ico">${isDir ? '🗀' : '📄'}</span><input class="ex-newinput" spellcheck="false" placeholder="${isDir ? 'new folder' : 'new file'} in ${esc(rel)}/…" />`;
  exTree.prepend(wrap);
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
      await exLoad();
      if (!isDir) openFile(res.path);
    } else if (e.key === 'Escape') close();
  });
  inp.addEventListener('blur', () => setTimeout(close, 120));
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
  add('🗋 New File', () => exStartCreate(false));
  add('🗀 New Folder', () => exStartCreate(true));
  const sep = document.createElement('div'); sep.className = 'ex-ctx-sep'; exMenu.appendChild(sep);
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

