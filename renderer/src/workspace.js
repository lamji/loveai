// ============================================================
// WORKSPACE (TICKETS) — lightweight Jira-style board per project.
// Classic script, shared global scope (loaded after app.js/editor.js).
// Data is isolated per project folder in localStorage under
// `ticketWs:<projectDir>` and is designed to be extended later
// (custom statuses, priorities, labels, comments, subtasks…).
// ============================================================
(() => {
  const view = document.getElementById('tkws');
  const boardEl = document.getElementById('tk-board');
  const listEl = document.getElementById('tk-listview');
  const headBtn = document.getElementById('btn-tickets');
  const modal = document.getElementById('tk-modal');
  const fileIn = document.getElementById('tk-file-in');
  const acField = document.getElementById('tk-f-ac');
  const acView = document.getElementById('tk-ac-view');
  const attPreview = document.getElementById('tk-att-preview');
  const attPreviewImg = document.getElementById('tk-att-preview-img');
  const attPreviewFile = document.getElementById('tk-att-preview-file');
  const attPreviewName = document.getElementById('tk-att-preview-name');
  const attPreviewPath = document.getElementById('tk-att-preview-path');

  const TK_IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const DEFAULT_PROMPT =
    'Follow the acceptance criteria. Only modify files related to this task.';
  // future: users will be able to add custom statuses — keep them in data
  const DEFAULT_STATUSES = [
    { id: 'todo', label: 'TODO' },
    { id: 'inprogress', label: 'IN PROGRESS' },
    { id: 'done', label: 'DONE' }
  ];

  let tk = null;          // active project's workspace data
  let isOpen = false;
  let editingId = null;   // ticket id being edited, null = new
  let draftAtt = [];      // attachments in the open editor (committed on Save)

  // ---------- running tickets (ephemeral — not persisted) ----------
  // ticketId -> { kind: 'agent'|'pipeline', agentId?, startedAt }
  const tkRun = new Map();

  // ---------- storage (per project folder) ----------
  function tkKey() { return 'ticketWs:' + (projectDir || ''); }

  function freshData() {
    return {
      version: 1, view: 'board', seq: 1,
      statuses: DEFAULT_STATUSES.map(s => ({ ...s })),
      tickets: []
    };
  }
  function tkLoad() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(tkKey()) || 'null'); } catch {}
    if (!d || !Array.isArray(d.tickets)) d = freshData();
    if (!Array.isArray(d.statuses) || !d.statuses.length) {
      d.statuses = DEFAULT_STATUSES.map(s => ({ ...s }));
    }
    return d;
  }
  function tkSave() {
    if (!tk) return;
    try { localStorage.setItem(tkKey(), JSON.stringify(tk)); } catch {}
  }

  function ticketById(id) { return tk.tickets.find(t => t.id === id) || null; }
  function statusById(id) {
    return tk.statuses.find(s => s.id === id) || tk.statuses[0];
  }
  function agentById(id) {
    return (agents || []).find(a => a.id === id && !a.ephemeral) || null;
  }
  function agentLabel(t) {
    const id = t.agentId;
    if (!id) return '';
    if (id === '__pipeline__') return '⟢ AUTO PIPELINE';
    if (id.startsWith('model:')) {
      const model = id.slice('model:'.length);
      return '✦ ' + (typeof MODEL_LABELS !== 'undefined' && MODEL_LABELS[model] || model);
    }
    const a = agentById(id);
    return a ? a.name : (t.agentName || '');
  }
  function fileUrl(p) {
    return encodeURI('file:///' + String(p).replace(/\\/g, '/'));
  }

  // ---------- run a ticket (Start / Stop) ----------
  // `message` is whatever was typed into the card's chatbox when starting it —
  // falls back to a legacy ticket.prompt (older tickets that still have one)
  // or a generic instruction if neither is given.
  function ticketPrompt(t, message) {
    let p = `TASK: ${t.title}`;
    if (t.description) p += `\n\n${t.description}`;
    if (t.acceptance) p += `\n\nACCEPTANCE CRITERIA:\n${t.acceptance}`;
    p += `\n\n${(message && message.trim()) || t.prompt || DEFAULT_PROMPT}`;
    if ((t.attachments || []).length) {
      p += `\n\nATTACHMENTS:\n` + t.attachments.map(a => `- ${a.path}`).join('\n');
    }
    return p;
  }

  function inProgressStatusId() {
    const s = tk.statuses.find(s => s.id === 'inprogress') || tk.statuses[1] || tk.statuses[0];
    return s.id;
  }

  function agentDisplayName(agentId) {
    const a = (agents || []).find(x => x.id === agentId);
    return a ? a.name : agentId;
  }

  function runLabel(run) {
    if (run.kind === 'pipeline') {
      const p = window.pipeState ? window.pipeState() : null;
      const stage = (p && p.label) || 'pipeline running…';
      return `${stage} · ${elapsedText(run.startedAt)}`;
    }
    const st = R(run.agentId).status;
    const name = agentDisplayName(run.agentId);
    return `${name}${st ? ' · ' + String(st).slice(0, 40) : ''} · ${elapsedText(run.startedAt)}`;
  }

  // called once a ticket's run is really over (agent 'done', or pipeline end)
  function finishTicketRun(id) {
    if (!tkRun.delete(id)) return;
    if (isOpen) render();
  }

  // agent/model runs (not pipeline — no single stable session there) end here:
  // remember WHO ran it and its resulting session, so a follow-up later can be
  // resumed in place instead of starting the conversation over from scratch.
  function onTicketAgentDone(id, agentId) {
    const t = ticketById(id);
    if (t) {
      t.lastAgentId = agentId;
      const sid = R(agentId).sessionId;
      if (sid) t.lastSessionId = sid;
      tkSave();
    }
    finishTicketRun(id);
  }

  // each project's pipeline is independent — when ONE ends, only clear the
  // ticket(s) that were waiting on THAT project's pipeline, not every
  // pipeline-driven ticket across every open project.
  window.wsPipelineEnded = function (wsId) {
    for (const [id, run] of tkRun) if (run.kind === 'pipeline' && run.wsId === wsId) finishTicketRun(id);
  };

  function startTicket(id, message) {
    const t = ticketById(id);
    if (!t || tkRun.has(id)) return;
    const target = t.agentId;
    if (!target) {
      if (window.toast) toast('Pick what runs this ticket first (RUN WITH)', false);
      return;
    }
    const prompt = ticketPrompt(t, message);

    const effort = t.effort || 'auto';

    if (target === '__pipeline__') {
      if (typeof pipeFor === 'function' && pipeFor(activeWorkspaceId).active) {
        if (window.toast) toast('A pipeline is already running for this project — stop it first', false);
        return;
      }
      tkRun.set(id, { kind: 'pipeline', startedAt: Date.now(), wsId: activeWorkspaceId });
      launchPipeline(prompt, effort, activeWorkspaceId);
    } else if (target.startsWith('model:')) {
      const model = target.slice('model:'.length);
      const aid = ensureModelAgent(model);
      if (R(aid).running) {
        if (window.toast) toast(`${MODEL_LABELS[model] || model} is already running`, false);
        return;
      }
      tkRun.set(id, { kind: 'agent', agentId: aid, startedAt: Date.now() });
      runAgent(aid, prompt, false, false, { effort, onDone: () => onTicketAgentDone(id, aid) });
    } else {
      const a = agentById(target);
      if (!a) {
        if (window.toast) toast('Assigned agent no longer exists', false);
        return;
      }
      if (R(a.id).running) {
        if (window.toast) toast(`${a.name} is already running`, false);
        return;
      }
      tkRun.set(id, { kind: 'agent', agentId: a.id, startedAt: Date.now() });
      runAgent(a.id, prompt, false, false, { effort, onDone: () => onTicketAgentDone(id, a.id) });
    }

    t.status = inProgressStatusId();
    t.updatedAt = Date.now();
    tkSave();
    render();
  }

  function stopTicket(id) {
    const run = tkRun.get(id);
    if (!run) return;
    if (run.kind === 'pipeline') {
      if (typeof abortPipeline === 'function') abortPipeline('pipeline aborted from workspace card.', run.wsId);
    } else if (run.agentId && typeof stopAgent === 'function') {
      stopAgent(run.agentId);
    }
    // stay in tkRun (shows "stopping…") until the real done/pipeline-end event
  }

  // single send action on the card's chatbox — Start (first time) or follow-up
  // (already run before), same box either way. A follow-up resumes ITS OWN
  // last session (never the global shared one, so concurrent tickets on
  // different agents/models never bleed into each other's context).
  function sendTicketChat(id) {
    const t = ticketById(id);
    if (!t || tkRun.has(id)) return;
    const card = boardEl.querySelector(`.tk-card-item[data-id="${id}"]`)
      || listEl.querySelector(`.tk-row[data-id="${id}"]`);
    const input = card && card.querySelector('.tk-chat-input');
    const text = input ? input.value.trim() : '';

    if (t.lastAgentId) {
      if (!text || R(t.lastAgentId).running) return;
      if (input) input.value = '';
      const agentId = t.lastAgentId;
      tkRun.set(id, { kind: 'agent', agentId, startedAt: Date.now() });
      render();
      runAgent(agentId, text, false, false, {
        resume: t.lastSessionId || undefined,
        fork: false,
        onDone: () => onTicketAgentDone(id, agentId)
      });
    } else {
      if (input) input.value = '';
      startTicket(id, text);
    }
  }

  // keep running cards' elapsed time + live status ticking without a full
  // board/list re-render (which would tear down drag listeners every second)
  setInterval(() => {
    if (!isOpen || !tk || !tkRun.size) return;
    for (const [id, run] of tkRun) {
      const label = (boardEl.querySelector(`.tk-card-item[data-id="${id}"] .tk-run-label`))
        || (listEl.querySelector(`.tk-row[data-id="${id}"] .tk-run-label`));
      if (label) label.textContent = runLabel(run);
    }
  }, 1000);

  // ---------- open / close (center area swap — sidebar stays) ----------
  function openTk() {
    if (!projectDir) {
      if (window.toast) toast('Open a project folder first', false);
      return;
    }
    tk = tkLoad();
    isOpen = true;
    view.classList.remove('hidden');
    document.getElementById('viewer').classList.add('hidden');
    document.getElementById('console-feed').classList.add('hidden');
    document.getElementById('agent-dock').classList.add('hidden');
    headBtn.classList.add('ico-active');
    render();
  }
  function closeTk() {
    isOpen = false;
    view.classList.add('hidden');
    headBtn.classList.remove('ico-active');
    closeModal();
    // hand the center area back to the console/editor logic
    if (typeof syncPane === 'function') syncPane();
  }

  window.tkIsOpen = () => isOpen;
  window.openTicketWs = openTk;

  // project switched (or its folder changed) — rebind to the new project's data
  window.tkProjectChanged = () => {
    if (!isOpen) return;
    closeModal();
    if (!projectDir) { closeTk(); return; }
    tk = tkLoad();
    render();
  };

  headBtn.onclick = () => (isOpen ? closeTk() : openTk());
  document.getElementById('tk-close').onclick = closeTk;

  // opening a file or an agent chat leaves the workspace — same center area
  for (const name of ['openFile', 'openChat']) {
    const orig = window[name];
    if (typeof orig === 'function') {
      window[name] = function (...args) {
        if (isOpen) closeTk();
        return orig.apply(this, args);
      };
    }
  }

  // ---------- render ----------
  function render() {
    if (!tk) return;
    document.getElementById('tk-proj').textContent =
      (typeof ws === 'function' && ws().name) ? ws().name : '';
    const board = tk.view !== 'list';
    document.getElementById('tk-view-board').classList.toggle('active', board);
    document.getElementById('tk-view-list').classList.toggle('active', !board);
    boardEl.classList.toggle('hidden', !board);
    listEl.classList.toggle('hidden', board);
    if (board) renderBoard(); else renderList();
  }

  function cardMeta(t) {
    const bits = [];
    const ag = agentLabel(t);
    // pipeline/model labels already carry their own icon (⟢ / ✦); plain agent
    // names get the generic ⬡ marker
    if (ag) {
      const icon = /^[⟢✦]/.test(ag) ? '' : '⬡ ';
      bits.push(`<span class="tk-chip tk-chip-agent">${icon}${esc(ag)}</span>`);
    }
    if ((t.attachments || []).length) {
      bits.push(`<span class="tk-chip">📎 ${t.attachments.length}</span>`);
    }
    return bits.join('');
  }

  function renderBoard() {
    boardEl.innerHTML = '';
    for (const st of tk.statuses) {
      const items = tk.tickets.filter(t => t.status === st.id);
      const col = document.createElement('div');
      col.className = 'tk-col';
      col.dataset.status = st.id;
      col.innerHTML = `
        <div class="tk-col-head">
          <span class="tk-col-dot ${st.id}"></span>
          <span class="tk-col-label">${esc(st.label)}</span>
          <span class="tk-col-count">${items.length}</span>
          <button class="mini-btn icon-only tk-col-add" title="New ticket here">＋</button>
        </div>
        <div class="tk-col-body"></div>`;
      col.querySelector('.tk-col-add').onclick = () => openModal(null, st.id);
      const body = col.querySelector('.tk-col-body');
      for (const t of items) body.appendChild(cardEl(t));
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'tk-col-empty';
        empty.textContent = 'drop tickets here';
        body.appendChild(empty);
      }
      bindDropZone(body, col, st.id);
      boardEl.appendChild(col);
    }
  }

  function cardEl(t) {
    const el = document.createElement('div');
    const run = tkRun.get(t.id);
    // one chatbox does both jobs: first message Starts the ticket, every one
    // after that is a follow-up anchored to its own last session
    const everRun = !!t.lastAgentId;
    const inProg = t.status === 'inprogress';
    const isDone = t.status === 'done';
    const showChat = !run && !!t.agentId && inProg;
    const showStart = !run && !!t.agentId && !inProg && !isDone;
    el.className = 'tk-card-item' + (run ? ' tk-running' : '');
    el.draggable = true;
    el.dataset.id = t.id;
    el.dataset.status = t.status;
    el.innerHTML = `
      <div class="tk-card-top">
        <span class="tk-num">${esc(t.num || '')}</span>
        <span class="tk-card-chips">${cardMeta(t)}</span>
      </div>
      <div class="tk-card-title">${esc(t.title)}</div>
      <div class="tk-card-run ${run ? '' : 'hidden'}">
        <span class="think-dots"><i></i><i></i><i></i></span>
        <span class="tk-run-label"></span>
        <button class="tk-run-stop" title="Stop">■</button>
      </div>
      <div class="tk-card-chat ${showChat ? '' : 'hidden'}">
        <input class="tk-chat-input" placeholder="${everRun ? 'Follow up…' : 'Start with a message…'}" />
        <button class="tk-chat-send" title="${everRun ? 'Send — continues its last session' : 'Start'}">➤</button>
      </div>
      <div class="tk-card-start ${showStart ? '' : 'hidden'}">
        <button class="tk-start-btn" title="Start this task">▶ START</button>
      </div>`;
    if (run) el.querySelector('.tk-run-label').textContent = runLabel(run);
    el.querySelector('.tk-run-stop').onclick = (e) => { e.stopPropagation(); stopTicket(t.id); };
    if (showChat) {
      const chatInput = el.querySelector('.tk-chat-input');
      const chatSend = el.querySelector('.tk-chat-send');
      chatInput.onclick = (e) => e.stopPropagation();
      chatInput.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); sendTicketChat(t.id); }
      };
      chatSend.onclick = (e) => { e.stopPropagation(); sendTicketChat(t.id); };
    }
    if (showStart) {
      el.querySelector('.tk-start-btn').onclick = (e) => {
        e.stopPropagation();
        startTicket(t.id, '');
      };
    }
    el.onclick = () => openModal(t.id);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/tk-id', t.id);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      boardEl.querySelectorAll('.tk-col.drag-over')
        .forEach(c => c.classList.remove('drag-over'));
    });
    return el;
  }

  function bindDropZone(body, col, statusId) {
    body.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/tk-id')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    body.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      boardEl.querySelectorAll('.tk-col.drag-over')
        .forEach(c => c.classList.remove('drag-over'));
      const id = e.dataTransfer.getData('text/tk-id');
      const t = ticketById(id);
      if (!t || t.status === statusId) return;
      t.status = statusId;                  // status updates immediately
      t.updatedAt = Date.now();
      tkSave();
      renderBoard();
      const moved = boardEl.querySelector(`.tk-card-item[data-id="${id}"]`);
      if (moved) moved.classList.add('tk-pop');
    });
  }

  function renderList() {
    listEl.innerHTML = `
      <div class="tk-row tk-row-head">
        <span class="tk-cell-num">#</span>
        <span class="tk-cell-title">TITLE</span>
        <span class="tk-cell-status">STATUS</span>
        <span class="tk-cell-agent">AGENT</span>
        <span class="tk-cell-actions"></span>
      </div>`;
    if (!tk.tickets.length) {
      const empty = document.createElement('div');
      empty.className = 'tk-list-empty';
      empty.textContent = 'No tickets yet — create one with ＋ NEW TICKET.';
      listEl.appendChild(empty);
      return;
    }
    for (const t of tk.tickets) {
      const st = statusById(t.status);
      const run = tkRun.get(t.id);
      const inProg = t.status === 'inprogress';
      const isDone = t.status === 'done';
      const everRun = !!t.lastAgentId;
      const showChat = !run && !!t.agentId && inProg;
      const showStart = !run && !!t.agentId && !inProg && !isDone;
      const desc = (t.description || '').trim();
      const row = document.createElement('div');
      row.className = 'tk-row' + (run ? ' tk-running' : '');
      row.dataset.id = t.id;
      row.innerHTML = `
        <span class="tk-cell-num">${esc(t.num || '')}</span>
        <span class="tk-cell-title">
          <span class="tk-cell-title-text">${esc(t.title)}</span>
          ${desc ? `<span class="tk-cell-desc">${esc(desc)}</span>` : ''}
        </span>
        <span class="tk-cell-status">
          <span class="tk-status-pill ${esc(t.status)}">${esc(st.label)}</span>
        </span>
        <span class="tk-cell-agent">${run
          ? `<span class="think-dots"><i></i><i></i><i></i></span> <span class="tk-run-label"></span>`
          : esc(agentLabel(t) || '—')}</span>
        <span class="tk-cell-actions">
          ${showStart
            ? '<button class="tk-start-btn" title="Start this task">▶ START</button>'
            : ''}
          ${showChat ? `
            <input class="tk-chat-input"
              placeholder="${everRun ? 'Follow up…' : 'Start with a message…'}" />
            <button class="tk-chat-send"
              title="${everRun ? 'Send — continues its last session' : 'Start'}">➤</button>
          ` : ''}
        </span>`;
      if (run) row.querySelector('.tk-run-label').textContent = runLabel(run);
      if (showStart) {
        row.querySelector('.tk-start-btn').onclick = (e) => {
          e.stopPropagation();
          startTicket(t.id, '');
        };
      }
      if (showChat) {
        const chatInput = row.querySelector('.tk-chat-input');
        const chatSend = row.querySelector('.tk-chat-send');
        chatInput.onclick = (e) => e.stopPropagation();
        chatInput.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); sendTicketChat(t.id); }
        };
        chatSend.onclick = (e) => { e.stopPropagation(); sendTicketChat(t.id); };
      }
      row.onclick = () => openModal(t.id);
      listEl.appendChild(row);
    }
  }

  document.getElementById('tk-view-board').onclick = () => {
    tk.view = 'board'; tkSave(); render();
  };
  document.getElementById('tk-view-list').onclick = () => {
    tk.view = 'list'; tkSave(); render();
  };
  document.getElementById('tk-new').onclick = () => openModal(null);

  // ---------- ticket editor (create / edit / delete) ----------
  function fillSelects(ticket) {
    const stSel = document.getElementById('tk-f-status');
    stSel.innerHTML = '';
    for (const s of tk.statuses) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      stSel.appendChild(o);
    }
    const agSel = document.getElementById('tk-f-agent');
    agSel.innerHTML = '<option value="">— unassigned —</option>' +
      '<option value="__pipeline__">⟢ AUTO PIPELINE</option>';
    for (const a of (agents || [])) {
      if (a.ephemeral) continue;
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = `${(typeof ROLE_ICON !== 'undefined' && ROLE_ICON[a.role]) || '⬡'} ${a.name}`;
      agSel.appendChild(o);
    }
    if (typeof MODEL_LABELS !== 'undefined') {
      const grp = document.createElement('optgroup');
      grp.label = 'MODELS';
      for (const [id, label] of Object.entries(MODEL_LABELS)) {
        const o = document.createElement('option');
        o.value = 'model:' + id; o.textContent = `✦ ${label}`;
        grp.appendChild(o);
      }
      agSel.appendChild(grp);
    }
    if (ticket && ticket.agentId &&
        ![...agSel.options].some(o => o.value === ticket.agentId)) {
      // agent was removed from the roster — keep the assignment visible
      const o = document.createElement('option');
      o.value = ticket.agentId;
      o.textContent = (ticket.agentName || 'removed agent') + ' (gone)';
      agSel.appendChild(o);
    }

    const efSel = document.getElementById('tk-f-effort');
    if (efSel && typeof populateEffortSelect === 'function') {
      populateEffortSelect(efSel);
      if (typeof enhanceThinkSelect === 'function') enhanceThinkSelect(efSel);
    }
  }

  function openModal(id, presetStatus) {
    if (!tk) return;
    editingId = id;
    const t = id ? ticketById(id) : null;
    if (id && !t) return;
    fillSelects(t);
    document.getElementById('tk-m-title').textContent =
      t ? `TICKET ${t.num || ''}` : 'NEW TICKET';
    document.getElementById('tk-f-title').value = t ? t.title : '';
    const acText = t ? (t.acceptance || '') : '';
    acField.value = acText;
    if (acText.trim()) showAcView(acText); else showAcEdit();
    document.getElementById('tk-f-status').value =
      t ? t.status : (presetStatus || tk.statuses[0].id);
    document.getElementById('tk-f-agent').value = t ? (t.agentId || '') : '';
    const efSel = document.getElementById('tk-f-effort');
    if (efSel) {
      efSel.value = (t && t.effort) || 'auto';
      if (efSel._tselSync) efSel._tselSync();
    }
    draftAtt = t ? (t.attachments || []).map(a => ({ ...a })) : [];
    renderDraftAtt();
    document.getElementById('tk-f-del').classList.toggle('hidden', !t);
    modal.classList.remove('hidden');
    document.getElementById('tk-f-title').focus();
  }
  function closeModal() {
    modal.classList.add('hidden');
    editingId = null;
    draftAtt = [];
  }

  document.getElementById('tk-f-cancel').onclick = closeModal;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!attPreview.classList.contains('hidden')) { closeAttPreview(); return; }
    if (!modal.classList.contains('hidden')) closeModal();
  });

  // ACCEPTANCE CRITERIA gets the same @ file/folder mention and / skill menus
  // as the main chat composer — same setupMention/setupSlash from app.js —
  // plus a # trigger (below) that attaches an image/file right where typed.
  if (typeof setupMention === 'function') {
    setupMention(acField, document.getElementById('tk-ac-mention'));
  }
  if (typeof setupSlash === 'function') {
    setupSlash(acField, document.getElementById('tk-ac-slash'));
  }

  // once a ticket has saved acceptance criteria, show it read-only (a plain
  // checklist look) instead of a bare textarea — click it to edit again.
  function showAcEdit() {
    acView.classList.add('hidden');
    acField.classList.remove('hidden');
    acField.focus();
    const end = acField.value.length;
    acField.setSelectionRange(end, end);
  }
  function showAcView(text) {
    acField.classList.add('hidden');
    acView.innerHTML = text.split('\n').map(line => {
      const clean = line.replace(/^[-*]\s*/, '').trim();
      return clean ? `<div class="tk-ac-line">☐ ${esc(clean)}</div>` : '';
    }).join('');
    acView.classList.remove('hidden');
  }
  acView.onclick = showAcEdit;

  // committing the field (clicking/tabbing away) swaps it back to the
  // read-only view — but not while the # attach file dialog is opening
  // (that steals focus too, and hashTarget stays set until it resolves).
  acField.addEventListener('blur', () => {
    if (hashTarget) return;
    setTimeout(() => {
      if (document.activeElement === acField) return;
      if (acField.value.trim()) showAcView(acField.value);
    }, 150);
  });

  document.getElementById('tk-f-save').onclick = () => {
    const title = document.getElementById('tk-f-title').value.trim();
    if (!title) {
      if (window.toast) toast('Ticket needs a title', false);
      document.getElementById('tk-f-title').focus();
      return;
    }
    const agentId = document.getElementById('tk-f-agent').value || null;
    const ag = agentById(agentId);
    const efSel = document.getElementById('tk-f-effort');
    const fields = {
      title,
      acceptance: acField.value,
      status: document.getElementById('tk-f-status').value,
      agentId,
      agentName: ag ? ag.name : null,   // survives roster changes
      effort: (efSel && efSel.value) || 'auto',
      attachments: draftAtt,
      updatedAt: Date.now()
    };
    if (editingId) {
      Object.assign(ticketById(editingId), fields);
    } else {
      tk.tickets.push({
        id: uid(), num: 'WS-' + tk.seq++,
        createdAt: Date.now(),
        // future-expansion fields — stored now so old data upgrades cleanly
        priority: null, labels: [], comments: [], subtasks: [],
        ...fields
      });
    }
    tkSave();
    closeModal();
    render();
  };

  document.getElementById('tk-f-del').onclick = async () => {
    const t = editingId ? ticketById(editingId) : null;
    if (!t) return;
    const ok = await showAlert({
      title: 'DELETE TICKET',
      message: `Delete "${esc(t.title)}"? This can't be undone.`,
      okText: 'DELETE', cancelText: 'CANCEL', kind: 'danger'
    });
    if (!ok) return;
    tk.tickets = tk.tickets.filter(x => x.id !== t.id);
    tkSave();
    closeModal();
    render();
  };

  // ---------- attachments (basic: keep the file's path, preview images) ----------
  // returns the names actually added, so a # trigger can insert them inline
  function addAttachmentFiles(fileList) {
    const added = [];
    for (const f of fileList) {
      const p = window.deck.fileToPath(f);
      if (!p || draftAtt.some(a => a.path === p)) continue;
      const name = p.split(/[\\/]/).pop();
      draftAtt.push({ path: p, name });
      added.push(name);
    }
    renderDraftAtt();
    return added;
  }

  function renderDraftAtt() {
    const box = document.getElementById('tk-f-att');
    box.innerHTML = '';
    draftAtt.forEach((a, i) => {
      const item = document.createElement('div');
      item.className = 'tk-att-item';
      item.title = a.path;
      if (TK_IMG_RE.test(a.path)) {
        item.innerHTML = `<img src="${fileUrl(a.path)}" alt="" />` +
          `<span class="tk-att-name"></span><b title="Remove">✕</b>`;
      } else {
        item.innerHTML = `<span class="tk-att-ico">📄</span>` +
          `<span class="tk-att-name"></span><b title="Remove">✕</b>`;
      }
      item.querySelector('.tk-att-name').textContent = a.name;
      item.querySelector('b').onclick = (e) => {
        e.stopPropagation();
        draftAtt.splice(i, 1);
        renderDraftAtt();
      };
      item.addEventListener('click', () => openAttPreview(a));
      box.appendChild(item);
    });
  }

  // ---------- # trigger — attaches a file/image right where it was typed,
  // same spirit as the @ mention and / skill triggers on this same field ----------
  let hashTarget = null; // { textarea, start } — caret position that opened the picker
  function setupHashAttach(textarea) {
    textarea.addEventListener('input', (e) => {
      if (e.data !== '#') return;
      const pos = textarea.selectionStart;
      const before = textarea.value.slice(0, pos - 1);
      if (before && !/[\s\n]$/.test(before)) return; // only at start of a word
      hashTarget = { textarea, start: pos - 1 };
      fileIn.click();
    });
  }
  setupHashAttach(acField);

  function insertHashTokens({ textarea, start }, names) {
    const v = textarea.value;
    const token = names.map(n => '#' + n).join(' ') + ' ';
    textarea.value = v.slice(0, start) + token + v.slice(start + 1);
    const caret = start + token.length;
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
  }

  fileIn.onchange = () => {
    const target = hashTarget; hashTarget = null;
    const added = addAttachmentFiles(fileIn.files);
    fileIn.value = '';
    if (target && added.length) insertHashTokens(target, added);
  };
  const attBox = document.getElementById('tk-f-att');
  attBox.addEventListener('dragover', (e) => {
    e.preventDefault();
    attBox.classList.add('dropping');
  });
  attBox.addEventListener('dragleave', () => attBox.classList.remove('dropping'));
  attBox.addEventListener('drop', (e) => {
    e.preventDefault();
    attBox.classList.remove('dropping');
    if (e.dataTransfer && e.dataTransfer.files) addAttachmentFiles(e.dataTransfer.files);
  });

  // ---------- attachment preview (image lightbox / file info card) ----------
  function openAttPreview(a) {
    const isImg = TK_IMG_RE.test(a.path);
    attPreviewImg.classList.toggle('hidden', !isImg);
    attPreviewFile.classList.toggle('hidden', isImg);
    if (isImg) {
      attPreviewImg.src = fileUrl(a.path);
    } else {
      attPreviewName.textContent = a.name;
      attPreviewPath.textContent = a.path;
    }
    attPreview.classList.remove('hidden');
  }
  function closeAttPreview() {
    attPreview.classList.add('hidden');
    attPreviewImg.src = '';
  }
  document.getElementById('tk-att-preview-close').onclick = closeAttPreview;
  attPreview.addEventListener('click', (e) => {
    if (e.target === attPreview) closeAttPreview();
  });
})();
