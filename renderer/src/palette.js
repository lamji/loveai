// ============================================================
// COMMAND PALETTE / QUICK OPEN / GO TO LINE — VS Code style.
//   Ctrl+Shift+P  → commands
//   Ctrl+P        → files (fuzzy)
//   Ctrl+G        → go to line
// Centered overlay; Arrow/Enter/Esc nav. Classic script, shared scope.
// ============================================================
(() => {
  const overlay = document.createElement('div');
  overlay.id = 'palette';
  overlay.className = 'palette hidden';
  overlay.innerHTML = `
    <div class="pal-box">
      <input id="pal-input" spellcheck="false" autocomplete="off" />
      <div id="pal-list" class="pal-list"></div>
      <div id="pal-empty" class="pal-empty hidden">No matches</div>
    </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('pal-input');
  const list = document.getElementById('pal-list');
  const emptyEl = document.getElementById('pal-empty');

  let mode = 'command';   // 'command' | 'file' | 'line'
  let items = [];         // current source: [{ title, hint, run }]
  let filtered = [];
  let sel = 0;
  let fileCache = { dir: null, files: [] };

  // ----- command registry (built fresh each open so it reflects live state) -----
  function click(id) { const e = document.getElementById(id); if (e) e.click(); }
  function commandItems() {
    const cmds = [
      { title: 'Go to File…', hint: 'Ctrl+P', run: () => open('file') },
      { title: 'Go to Line…', hint: 'Ctrl+G', run: () => open('line') },
      { title: 'Toggle Theme (Light / Dark)', hint: 'View', run: () => click('btn-theme') },
      { title: 'Open Terminal', hint: 'View', run: () => openTerminal() },
      { title: 'Show Console', hint: 'View', run: () => showSurface('console') },
      { title: 'Show Editor', hint: 'View', run: () => { if (openFiles.length) showSurface('editor'); } },
      { title: 'Toggle Split (Editor | Console)', hint: 'View', run: () => { if (window.toggleSplit) toggleSplit(); } },
      { title: 'Import Project…', hint: 'Project', run: () => click('btn-import') },
      { title: 'Deploy New Agent…', hint: 'Agents', run: () => click('btn-new-agent') },
      { title: 'Commit…', hint: 'Git', run: () => openCommitModal('plain') },
      { title: 'Commit & Push…', hint: 'Git', run: () => openCommitModal('push') },
      { title: 'Session History', hint: 'View', run: () => click('btn-history') },
      { title: 'Settings', hint: 'View', run: () => click('btn-settings') }
    ];
    if (window.openRecentProjects) cmds.push({ title: 'Open Recent Project…', hint: 'Project', run: () => window.openRecentProjects() });
    // every open file → a quick-switch command
    for (const f of openFiles) {
      cmds.push({ title: 'Switch to ' + baseName(f.path), hint: 'Open editor', run: () => { activeFile = f.path; showSurface('editor'); renderViewer(); } });
    }
    return cmds;
  }

  // ----- fuzzy subsequence scorer (lower = better; -1 = no match) -----
  function score(text, q) {
    if (!q) return 0;
    const t = text.toLowerCase(); q = q.toLowerCase();
    let ti = 0, qi = 0, first = -1, gaps = 0, prev = -1;
    while (ti < t.length && qi < q.length) {
      if (t[ti] === q[qi]) {
        if (first < 0) first = ti;
        if (prev >= 0 && ti - prev > 1) gaps += ti - prev - 1;
        prev = ti; qi++;
      }
      ti++;
    }
    if (qi < q.length) return -1;
    return first + gaps;               // early + contiguous wins
  }

  function refresh() {
    const q = mode === 'line' ? '' : input.value.trim();
    if (mode === 'line') { filtered = []; renderLine(); return; }
    const scored = [];
    for (const it of items) {
      const s = score(it.title, q);
      if (s >= 0) scored.push({ it, s });
    }
    scored.sort((a, b) => a.s - b.s);
    filtered = scored.slice(0, 200).map(x => x.it);
    sel = 0;
    render();
  }

  function render() {
    list.innerHTML = '';
    emptyEl.classList.toggle('hidden', filtered.length > 0);
    filtered.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'pal-item' + (i === sel ? ' sel' : '');
      row.innerHTML = `<span class="pal-title"></span><span class="pal-hint"></span>`;
      row.querySelector('.pal-title').textContent = it.title;
      row.querySelector('.pal-hint').textContent = it.hint || '';
      row.onclick = () => { sel = i; choose(); };
      list.appendChild(row);
    });
    const cur = list.querySelector('.pal-item.sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderLine() {
    list.innerHTML = '';
    const f = activeF && activeF();
    const total = f ? f.value.split('\n').length : 0;
    emptyEl.classList.add('hidden');
    const hint = document.createElement('div');
    hint.className = 'pal-item static';
    hint.innerHTML = `<span class="pal-title">Go to line 1–${total}</span><span class="pal-hint">Enter</span>`;
    list.appendChild(hint);
  }

  function choose() {
    if (mode === 'line') { gotoLine(parseInt(input.value, 10)); close(); return; }
    const it = filtered[sel];
    if (!it) return;
    close();
    try { it.run(); } catch (e) { console.error('palette action failed', e); }
  }

  function gotoLine(n) {
    const f = activeF && activeF();
    if (!f || !n || n < 1) return;
    showSurface('editor');
    const lines = f.value.split('\n');
    n = Math.min(n, lines.length);
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    vwInput.focus();
    vwInput.setSelectionRange(pos, pos + (lines[n - 1] || '').length);
    const lineH = parseFloat(getComputedStyle(document.getElementById('vw-body')).lineHeight) || 19;
    const body = document.getElementById('vw-body');
    body.scrollTop = Math.max(0, (n - 1) * lineH - body.clientHeight / 2);
  }
  window.paletteGoToLine = () => open('line');

  // ----- open / close -----
  async function open(which) {
    mode = which;
    overlay.classList.remove('hidden');
    input.value = '';
    if (which === 'command') {
      input.placeholder = 'Type a command…';
      items = commandItems();
      refresh();
    } else if (which === 'file') {
      input.placeholder = 'Go to file…';
      items = [];
      render();
      await loadFiles();
      refresh();
    } else if (which === 'line') {
      input.placeholder = ':line number';
      renderLine();
    }
    input.focus();
  }
  function close() { overlay.classList.add('hidden'); }

  async function loadFiles() {
    if (typeof projectDir === 'undefined' || !projectDir) { items = []; return; }
    if (fileCache.dir !== projectDir) {
      const r = await window.deck.listFiles(projectDir);
      fileCache = { dir: projectDir, files: r.ok ? r.files : [] };
    }
    items = fileCache.files.map(rel => ({
      title: rel, hint: '',
      run: () => openFile(joinPath(projectDir, rel))
    }));
  }

  // ----- keyboard -----
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  // global shortcuts
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k === 'p' && e.shiftKey) { e.preventDefault(); open('command'); }
    else if (k === 'p') { e.preventDefault(); open('file'); }
    else if (k === 'g') { e.preventDefault(); open('line'); }
  }, true);   // capture: beat element-level handlers
})();
