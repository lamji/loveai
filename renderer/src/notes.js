// ============================================================
// NOTES — Notion-style per-project notes.
// Classic script, shared global scope (loaded after workspace.js).
// Data is isolated per project folder in localStorage under
// `notes:<projectDir>` — a COLLECTION of notes (v2). The GALLERY is a
// center SCREEN (#notes-view, like the ticket board); the per-note block
// EDITOR is a MODAL (#notes-modal) that floats over that screen.
// Pure renderer: NO IPC / main.js — textarea + textContent only (never
// innerHTML for user text), so note content can never execute as HTML.
// ============================================================
(() => {
  const modal = document.getElementById('notes-modal');    // editor modal
  const body = document.getElementById('notes-body');
  const titleInput = document.getElementById('notes-title');
  const headBtn = document.getElementById('btn-notes');
  const slashMenu = document.getElementById('notes-slash');
  // gallery SCREEN (#notes-view) — a center overlay like the ticket board
  const view = document.getElementById('notes-view');
  const grid = document.getElementById('notes-grid');
  const emptyEl = document.getElementById('notes-empty');
  const emptyTitleEl = document.getElementById('notes-empty-title');
  const emptyMsgEl = document.getElementById('notes-empty-text');
  const emptyNewBtn = document.getElementById('notes-empty-new');
  const searchInput = document.getElementById('notes-search');
  const sortSel = document.getElementById('notes-sort');

  // block formats offered by the "/" menu (icon shown as the kind badge)
  const TYPES = [
    { type: 'text', icon: '¶', label: 'Text', hint: 'Plain paragraph' },
    { type: 'h1', icon: 'H1', label: 'Heading 1', hint: 'Large heading' },
    { type: 'h2', icon: 'H2', label: 'Heading 2', hint: 'Medium heading' },
    { type: 'h3', icon: 'H3', label: 'Heading 3', hint: 'Small heading' },
    { type: 'bullet', icon: '•', label: 'Bulleted list', hint: 'Simple bullet' },
    { type: 'numbered', icon: '1.', label: 'Numbered list', hint: 'Ordered list' },
    { type: 'todo', icon: '☑', label: 'To-do list', hint: 'Checkbox item' },
    { type: 'quote', icon: '❝', label: 'Quote', hint: 'Callout quote' },
    { type: 'code', icon: '</>', label: 'Code', hint: 'Monospace block' },
    { type: 'divider', icon: '―', label: 'Divider', hint: 'Horizontal line' }
  ];
  const LIST_TYPES = ['bullet', 'numbered', 'todo'];

  let store = null;     // v2 collection { version, notes:[…] }
  let note = null;      // note open in the editor modal, or null when closed
  let docDir = '';      // projectDir the store was loaded under (save target)
  let viewOpen = false; // is the gallery SCREEN showing?
  let saveTimer = null;

  // slash-menu state (one active textarea at a time)
  let slMatches = [], slSel = 0, slTa = null, slBlock = null;
  let activeTa = null;

  const uid = () => 'b' + Math.random().toString(36).slice(2, 9);

  // ---------- storage (per project folder) ----------
  const saveKey = () => 'notes:' + (docDir || projectDir || '');
  const now = () => Date.now();
  function blankBlock() {
    return { id: uid(), type: 'text', text: '', checked: false };
  }
  function freshNote() {
    const t = now();
    return { id: uid(), title: '', blocks: [blankBlock()], createdAt: t, updatedAt: t };
  }
  function normBlock(b) {
    if (!b || typeof b !== 'object') return null;
    const known = TYPES.some(t => t.type === b.type);
    return {
      id: typeof b.id === 'string' ? b.id : uid(),
      type: known ? b.type : 'text',
      text: typeof b.text === 'string' ? b.text : '',
      checked: b.checked === true
    };
  }
  function normNote(n) {
    if (!n || typeof n !== 'object') return null;
    const blocks = Array.isArray(n.blocks) ? n.blocks.map(normBlock).filter(Boolean) : [];
    const t = now();
    return {
      id: typeof n.id === 'string' ? n.id : uid(),
      title: typeof n.title === 'string' ? n.title : '',
      blocks: blocks.length ? blocks : [blankBlock()],
      createdAt: typeof n.createdAt === 'number' ? n.createdAt : t,
      updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : t
    };
  }
  // load + migrate: v1 single-doc → one v2 note; v2 → normalized collection.
  function notesLoad() {
    try {
      const raw = localStorage.getItem('notes:' + (projectDir || ''));
      if (!raw) return { version: 2, notes: [] };
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.notes)) {          // v2 collection
        return { version: 2, notes: d.notes.map(normNote).filter(Boolean) };
      }
      if (d && Array.isArray(d.blocks)) {         // v1 single doc → wrap
        return { version: 2, notes: [normNote(d)] };
      }
      return { version: 2, notes: [] };
    } catch (_) { return { version: 2, notes: [] }; }
  }
  function notesSave() {
    if (!docDir && !projectDir) return;
    try { localStorage.setItem(saveKey(), JSON.stringify(store)); } catch (_) {}
  }
  function touch() { if (note) note.updatedAt = now(); }
  function scheduleSave() {
    touch();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(notesSave, 400);
  }
  function flushSave() { clearTimeout(saveTimer); notesSave(); }

  // ---------- open / close ----------
  // GALLERY = a center SCREEN (#notes-view, like the ticket board).
  // EDITOR  = a MODAL (#notes-modal) that floats over that screen.
  const modalOpen = () => !modal.classList.contains('hidden');

  function openNotesView() {
    if (!projectDir) {
      if (window.toast) toast('Open a project folder first', false);
      return;
    }
    // only one center screen at a time — leave the ticket board first
    if (window.tkIsOpen && window.tkIsOpen() && window.closeTicketWs) {
      window.closeTicketWs();
    }
    docDir = projectDir;
    store = notesLoad();
    note = null;
    viewOpen = true;
    view.classList.remove('hidden');
    document.getElementById('viewer').classList.add('hidden');
    document.getElementById('console-feed').classList.add('hidden');
    document.getElementById('agent-dock').classList.add('hidden');
    headBtn.classList.add('ico-active');
    renderGallery();
    searchInput.focus();
  }
  function closeNotesView() {
    if (!viewOpen) return;
    closeNote();                     // drop the editor modal if it's up
    flushSave();
    viewOpen = false;
    view.classList.add('hidden');
    headBtn.classList.remove('ico-active');
    // hand the center area back to the console/editor logic
    if (typeof syncPane === 'function') syncPane();
  }
  function openNote(id) {
    const n = store.notes.find(x => x.id === id);
    if (!n) return;
    note = n;
    modal.classList.remove('hidden');    // visible first so textareas can size
    titleInput.value = note.title || '';
    render();
    const first = note.blocks[0];
    if (!note.title) titleInput.focus();
    else focusBlock(first.id, (first.text || '').length);
  }
  function closeNote() {
    if (!modalOpen()) return;
    flushSave();
    slashHide();
    note = null;
    modal.classList.add('hidden');
    renderGallery();                     // titles/previews may have changed
  }
  function newNote() {
    const n = freshNote();
    store.notes.unshift(n);
    notesSave();
    openNote(n.id);
  }
  async function deleteNote(id) {
    const target = store.notes.find(x => x.id === id);
    if (!target) return;
    const label = target.title || 'this note';
    const ok = window.showAlert
      ? await window.showAlert({
          title: 'DELETE NOTE',
          message: `Delete "${label}"? This can't be undone.`,
          okText: 'DELETE', cancelText: 'CANCEL', kind: 'danger'
        })
      : confirm(`Delete "${label}"?`);
    if (!ok) return;
    const wasOpen = note && note.id === id;
    store.notes = store.notes.filter(x => x.id !== id);
    notesSave();
    if (wasOpen) closeNote();            // closeNote re-renders the gallery
    else renderGallery();
  }

  window.openNotes = openNotesView;
  window.notesViewOpen = () => viewOpen;
  window.closeNotesView = closeNotesView;
  // project switched — close editor + screen (data saved under old dir)
  window.notesProjectChanged = () => { closeNote(); closeNotesView(); };

  headBtn.onclick = () => (viewOpen ? closeNotesView() : openNotesView());
  document.getElementById('notes-close').onclick = closeNote;
  document.getElementById('notes-view-close').onclick = closeNotesView;
  document.getElementById('notes-delete').onclick = () => note && deleteNote(note.id);
  document.getElementById('notes-new').onclick = newNote;
  document.getElementById('notes-empty-new').onclick = newNote;
  searchInput.addEventListener('input', renderGallery);
  sortSel.addEventListener('change', renderGallery);
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeNote(); });

  // editor modal Esc: close the slash menu first, else close the modal
  // (back to the still-present gallery screen). Slash Esc is caught earlier
  // on the textarea with stopPropagation, so this runs only once it's closed.
  modal.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!slashMenu.classList.contains('hidden')) { slashHide(); return; }
    closeNote();
  });
  // gallery screen Esc (only when the editor modal isn't up): leave the screen
  view.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modalOpen()) closeNotesView();
  });

  // opening a file or an agent chat leaves the notes screen (same center area)
  for (const name of ['openFile', 'openChat']) {
    const orig = window[name];
    if (typeof orig === 'function') {
      window[name] = function (...args) {
        if (viewOpen) closeNotesView();
        return orig.apply(this, args);
      };
    }
  }

  titleInput.addEventListener('input', () => {
    if (!note) return;
    note.title = titleInput.value;
    scheduleSave();
  });
  titleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); focusBlock(note.blocks[0].id, 0); }
  });

  // ---------- gallery ----------
  function firstText(n) {
    for (const b of n.blocks) {
      const t = (b.text || '').trim();
      if (b.type !== 'divider' && t) return t;
    }
    return '';
  }
  function relDate(ms) {
    const diff = now() - ms, day = 86400000;
    if (diff < 60000) return 'just now';
    if (diff < day) return new Date(ms).toLocaleTimeString([],
      { hour: 'numeric', minute: '2-digit' });
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function matchNote(n, q) {
    if (!q) return true;
    if ((n.title || '').toLowerCase().includes(q)) return true;
    return n.blocks.some(b => (b.text || '').toLowerCase().includes(q));
  }
  function sortNotes(list, mode) {
    const arr = list.slice();
    if (mode === 'title') {
      arr.sort((a, b) =>
        (a.title || 'Untitled').localeCompare(b.title || 'Untitled'));
    } else {
      const key = mode === 'created' ? 'createdAt' : 'updatedAt';
      arr.sort((a, b) => b[key] - a[key]);
    }
    return arr;
  }
  function galleryCard(n) {
    const card = document.createElement('div');
    card.className = 'notes-card-item';
    card.onclick = () => openNote(n.id);
    const h = document.createElement('div');
    h.className = 'nc-title';
    h.textContent = n.title || 'Untitled';         // textContent — never HTML
    const p = document.createElement('div');
    p.className = 'nc-preview';
    p.textContent = firstText(n).slice(0, 120) || 'No content';
    const foot = document.createElement('div');
    foot.className = 'nc-foot';
    const d = document.createElement('span');
    d.className = 'nc-date';
    d.textContent = relDate(n.updatedAt);
    const del = document.createElement('button');
    del.className = 'nc-del';
    del.title = 'Delete note';
    del.textContent = '🗑';
    del.onclick = e => { e.stopPropagation(); deleteNote(n.id); };
    foot.append(d, del);
    card.append(h, p, foot);
    return card;
  }
  function renderGallery() {
    const q = (searchInput.value || '').trim().toLowerCase();
    const list = sortNotes(store.notes.filter(n => matchNote(n, q)), sortSel.value);
    grid.innerHTML = '';
    list.forEach(n => grid.appendChild(galleryCard(n)));
    const empty = list.length === 0;
    const noSearch = q === '';
    emptyEl.classList.toggle('hidden', !empty);
    grid.classList.toggle('hidden', empty);
    if (empty) {
      emptyTitleEl.textContent = noSearch ? 'No notes yet' : 'No matching notes';
      emptyMsgEl.textContent = noSearch
        ? 'Create your first note to get started.'
        : `No notes match "${searchInput.value.trim()}".`;
      emptyNewBtn.classList.toggle('hidden', !noSearch);
    }
  }

  // ---------- render ----------
  function render(focus) {
    body.innerHTML = '';
    let num = 0;
    for (const b of note.blocks) {
      num = b.type === 'numbered' ? num + 1 : 0;
      body.appendChild(buildRow(b, num));
    }
    body.querySelectorAll('textarea').forEach(autoResize);
    if (focus) focusBlock(focus.id, focus.caret);
  }
  function buildRow(block, num) {
    const row = document.createElement('div');
    row.className = 'notes-block nb-' + block.type;
    row.dataset.id = block.id;
    if (block.type === 'divider') {
      row.appendChild(document.createElement('hr'));
      return row;
    }
    if (block.type === 'todo') row.appendChild(makeCheckbox(block, row));
    else { const p = prefixFor(block, num); if (p) row.appendChild(prefixEl(p)); }
    row.appendChild(buildInput(block));
    if (block.type === 'todo' && block.checked) row.classList.add('nb-done');
    return row;
  }
  function prefixFor(block, num) {
    if (block.type === 'bullet') return '•';
    if (block.type === 'numbered') return num + '.';
    return '';
  }
  function prefixEl(text) {
    const s = document.createElement('span');
    s.className = 'nb-prefix';
    s.textContent = text;
    return s;
  }
  function makeCheckbox(block, row) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'nb-check';
    box.checked = !!block.checked;
    box.addEventListener('change', () => {
      block.checked = box.checked;
      row.classList.toggle('nb-done', box.checked);
      scheduleSave();
    });
    return box;
  }
  function buildInput(block) {
    const ta = document.createElement('textarea');
    ta.className = 'nb-input';
    ta.rows = 1;
    ta.spellcheck = false;
    ta.value = block.text || '';            // plain text only — never innerHTML
    wireBlock(ta, block);
    return ta;
  }
  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  // ---------- per-block wiring ----------
  function wireBlock(ta, block) {
    ta.addEventListener('input', () => {
      block.text = ta.value;
      autoResize(ta);
      slashRender(ta, block);
      scheduleSave();
    });
    ta.addEventListener('keydown', e => onKey(e, ta, block));
    ta.addEventListener('focus', () => {
      activeTa = ta;
      // only the focused block shows the hint — not every empty line
      if (block.type === 'text') ta.placeholder = "Type '/' for commands";
    });
    ta.addEventListener('blur', () => {
      ta.placeholder = '';
      setTimeout(() => {
        if (slTa === ta && activeTa !== ta) slashHide();
      }, 150);
    });
  }
  function onKey(e, ta, block) {
    if (!slashMenu.classList.contains('hidden') && slTa === ta) {
      if (handleSlashKey(e)) return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEnter(ta, block); }
    else if (e.key === 'Backspace') maybeBackspace(e, ta, block);
    else if (e.key === 'ArrowUp') maybeCross(e, ta, block, -1);
    else if (e.key === 'ArrowDown') maybeCross(e, ta, block, 1);
  }
  function onEnter(ta, block) {
    if (LIST_TYPES.includes(block.type) && block.text === '') {
      block.type = 'text';                  // empty list item → back to text
      render({ id: block.id, caret: 0 });
      scheduleSave();
      return;
    }
    const idx = note.blocks.indexOf(block);
    const keep = LIST_TYPES.includes(block.type) && block.text !== '';
    const nb = blankBlock();
    if (keep) nb.type = block.type;         // continue the list naturally
    note.blocks.splice(idx + 1, 0, nb);
    render({ id: nb.id, caret: 0 });
    scheduleSave();
  }
  function maybeBackspace(e, ta, block) {
    if (ta.selectionStart !== 0 || ta.selectionEnd !== 0) return;
    const idx = note.blocks.indexOf(block);
    if (idx <= 0) {                         // first block: demote to text
      if (block.type !== 'text') {
        e.preventDefault();
        block.type = 'text';
        render({ id: block.id, caret: 0 });
        scheduleSave();
      }
      return;
    }
    e.preventDefault();
    const prev = note.blocks[idx - 1];
    if (prev.type === 'divider') {          // eat the divider, keep the block
      note.blocks.splice(idx - 1, 1);
      render({ id: block.id, caret: 0 });
      scheduleSave();
      return;
    }
    const caret = prev.text.length;         // merge into end of previous
    prev.text += block.text;
    note.blocks.splice(idx, 1);
    render({ id: prev.id, caret });
    scheduleSave();
  }
  function maybeCross(e, ta, block, dir) {
    const v = ta.value, c = ta.selectionStart;
    if (dir < 0 && v.lastIndexOf('\n', c - 1) !== -1) return;   // not line 0
    if (dir > 0 && v.indexOf('\n', c) !== -1) return;           // not last line
    const target = editableNeighbor(block, dir);
    if (!target) return;
    e.preventDefault();
    const caret = dir < 0 ? target.text.length : 0;
    focusBlock(target.id, caret);
  }
  function editableNeighbor(block, dir) {
    let i = note.blocks.indexOf(block) + dir;
    while (i >= 0 && i < note.blocks.length) {
      if (note.blocks[i].type !== 'divider') return note.blocks[i];
      i += dir;
    }
    return null;
  }
  function focusBlock(id, caret) {
    const row = body.querySelector('[data-id="' + id + '"]');
    const ta = row && row.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    const p = caret == null ? ta.value.length : caret;
    ta.setSelectionRange(p, p);
    autoResize(ta);
  }

  // ---------- slash menu (imitates app.js setupSlash) ----------
  const lineStart = ta => ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  function slashQuery(ta) {
    const line = ta.value.slice(lineStart(ta), ta.selectionStart);
    const m = /^\/([\w-]*)$/.exec(line);
    return m ? m[1] : null;
  }
  function matchType(t, q) {
    if (!q) return true;
    const s = q.toLowerCase();
    return t.label.toLowerCase().includes(s) || t.type.includes(s);
  }
  function slashRender(ta, block) {
    const q = slashQuery(ta);
    if (q === null) { slashHide(); return; }
    slMatches = TYPES.filter(t => matchType(t, q));
    if (!slMatches.length) { slashHide(); return; }
    slSel = Math.min(slSel, slMatches.length - 1);
    slTa = ta; slBlock = block;
    drawSlash();
  }
  function drawSlash() {
    slashMenu.innerHTML = '';
    slMatches.forEach((t, i) => slashMenu.appendChild(slashRow(t, i)));
    const foot = document.createElement('div');
    foot.className = 'slash-foot';
    foot.textContent = '↑↓ navigate · Tab/Enter select · Esc close';
    slashMenu.appendChild(foot);
    slashMenu.classList.remove('hidden');
    anchorSlash(slTa);
    const s = slashMenu.querySelector('.slash-item.sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function slashRow(t, i) {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slSel ? ' sel' : '');
    row.innerHTML = '<span class="slash-name"></span>' +
      '<span class="slash-desc"></span><span class="slash-kind"></span>';
    row.querySelector('.slash-name').textContent = t.label;
    row.querySelector('.slash-desc').textContent = t.hint;
    row.querySelector('.slash-kind').textContent = t.icon;
    row.onmousedown = e => { e.preventDefault(); slashPick(i); };
    row.onmouseenter = () => { slSel = i; drawSlash(); };
    return row;
  }
  function anchorSlash(ta) {
    const r = ta.getBoundingClientRect();
    slashMenu.style.position = 'fixed';
    slashMenu.style.width = '280px';
    slashMenu.style.right = 'auto';
    slashMenu.style.left = Math.min(r.left, window.innerWidth - 296) + 'px';
    let top = r.bottom + 4;
    const h = Math.min(260, slashMenu.offsetHeight || 260);
    if (top + h > window.innerHeight - 8) top = r.top - 4 - h;
    slashMenu.style.top = Math.max(8, top) + 'px';
  }
  function handleSlashKey(e) {
    const n = slMatches.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); slSel = (slSel + 1) % n; drawSlash(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); slSel = (slSel - 1 + n) % n; drawSlash(); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) {
      e.preventDefault(); slashPick(slSel);
    } else if (e.key === 'Escape') { e.stopPropagation(); slashHide(); }
    else return false;
    return true;
  }
  function slashHide() {
    slashMenu.classList.add('hidden');
    slMatches = []; slBlock = null; slTa = null;
  }
  function slashPick(i) {
    const t = slMatches[i], block = slBlock, ta = slTa;
    if (!t || !block || !ta) return;
    const start = lineStart(ta);
    const before = ta.value.slice(0, start);
    const rest = ta.value.slice(start).replace(/^\/[\w-]*\s*/, '');
    slashHide();
    if (t.type === 'divider') { convertToDivider(block, before + rest); return; }
    block.type = t.type;
    block.text = before + rest;             // drop the "/query", keep the rest
    if (t.type === 'todo') block.checked = block.checked === true;
    render({ id: block.id, caret: before.length });
    scheduleSave();
  }
  function convertToDivider(block, leftover) {
    block.type = 'divider';
    block.text = '';
    const idx = note.blocks.indexOf(block);
    let after = note.blocks[idx + 1];
    if (leftover.trim() !== '' || !after || after.type === 'divider') {
      after = { id: uid(), type: 'text', text: leftover, checked: false };
      note.blocks.splice(idx + 1, 0, after);
    }
    render({ id: after.id, caret: 0 });
    scheduleSave();
  }
})();
