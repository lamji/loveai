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
  const schModeSel = document.getElementById('tk-f-sched-mode');
  const schDateWrap = document.getElementById('tk-sched-datewrap');
  const schTimeWrap = document.getElementById('tk-sched-timewrap');
  const schIntervalWrap = document.getElementById('tk-sched-intervalwrap');
  const schDateIn = document.getElementById('tk-f-sched-date');
  const schHourIn = document.getElementById('tk-f-sched-hour');
  const schMinIn = document.getElementById('tk-f-sched-min');
  const schAmpmIn = document.getElementById('tk-f-sched-ampm');
  const schIntervalIn = document.getElementById('tk-f-sched-interval');

  const TK_IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  const DEFAULT_PROMPT =
    'Follow the acceptance criteria. Only modify files related to this task.';
  // future: users will be able to add custom statuses — keep them in data
  const DEFAULT_STATUSES = [
    { id: 'todo', label: 'TODO' },
    { id: 'inprogress', label: 'IN PROGRESS' },
    { id: 'inreview', label: 'IN REVIEW' },
    { id: 'done', label: 'DONE' }
  ];
  // how far ahead of a schedule's next run to start showing a live countdown
  const SCHED_TIMER_WINDOW_MS = 20 * 60000;
  // how far ahead of a schedule's next run to raise the top-right "starting
  // soon" toast — separate from SCHED_TIMER_WINDOW_MS, which just drives the
  // on-card countdown once it's already showing
  const SCHED_ALERT_WINDOW_MS = 5 * 60000;

  // ---------- 12h time picker (hour/min/AM-PM selects — explicit AM/PM so a
  // 24h-locale OS never silently swallows it, which used to make "9 PM" get
  // stored/read as 09:00 and fire immediately since that time had already
  // passed) ----------
  function time24To12(hhmm) {
    const [h, m] = (hhmm || '09:00').split(':').map(Number);
    const hour = ((h % 12) || 12);
    return { hour, min: m || 0, ampm: h >= 12 ? 'PM' : 'AM' };
  }
  function time12To24(hour, min, ampm) {
    let h = Number(hour) % 12;
    if (ampm === 'PM') h += 12;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  function fmtTime12(hhmm) {
    const { hour, min, ampm } = time24To12(hhmm);
    return `${hour}:${String(min).padStart(2, '0')} ${ampm}`;
  }
  (function populateTimePicker() {
    for (let h = 1; h <= 12; h++) {
      const o = document.createElement('option');
      o.value = String(h); o.textContent = String(h);
      schHourIn.appendChild(o);
    }
    for (let m = 0; m < 60; m++) {
      const o = document.createElement('option');
      o.value = String(m); o.textContent = String(m).padStart(2, '0');
      schMinIn.appendChild(o);
    }
  })();
  function setTimePicker(hhmm) {
    const { hour, min, ampm } = time24To12(hhmm);
    schHourIn.value = String(hour);
    schMinIn.value = String(min);
    schAmpmIn.value = ampm;
  }
  function getTimePicker() {
    return time12To24(schHourIn.value, schMinIn.value, schAmpmIn.value);
  }

  let tk = null;          // active project's workspace data
  let isOpen = false;
  let editingId = null;   // ticket id being edited, null = new
  let draftAtt = [];      // attachments in the open editor (committed on Save)

  // ---------- running tickets (ephemeral — not persisted) ----------
  // ticketId -> { kind: 'agent'|'pipeline', agentId?, startedAt }
  const tkRun = new Map();

  // ---------- "starting soon" top-right alerts (ephemeral) ----------
  // ticketId -> the sch.nextRun value already alerted for, so a recurring
  // schedule re-alerts on its next run instead of just once, ever
  const tkAlerted = new Map();

  function schedAlertsEl() {
    let el = document.getElementById('tk-sched-alerts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tk-sched-alerts';
      document.body.appendChild(el);
    }
    return el;
  }
  function showSchedAlert(t) {
    const stack = schedAlertsEl();
    dismissSchedAlert(t.id); // replace, don't stack duplicates for the same ticket
    const mins = Math.max(1, Math.round((t.schedule.nextRun - Date.now()) / 60000));
    const card = document.createElement('div');
    card.className = 'tk-sched-alert';
    card.dataset.id = t.id;
    card.innerHTML = `
      <span class="tk-sched-alert-ico">⏰</span>
      <div class="tk-sched-alert-body">
        <div class="tk-sched-alert-title">${esc(t.num || '')} ${esc(t.title)}</div>
        <div class="tk-sched-alert-sub">starting in ${mins} min</div>
      </div>
      <button class="tk-sched-alert-close" title="Dismiss">✕</button>`;
    card.querySelector('.tk-sched-alert-close').onclick = () => card.remove();
    stack.appendChild(card);
    requestAnimationFrame(() => card.classList.add('show'));
  }
  function dismissSchedAlert(id) {
    const el = schedAlertsEl().querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  }

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
    // boards saved before IN REVIEW existed — splice it in ahead of DONE
    if (!d.statuses.some(s => s.id === 'inreview')) {
      const doneIdx = d.statuses.findIndex(s => s.id === 'done');
      const inreview = { id: 'inreview', label: 'IN REVIEW' };
      if (doneIdx === -1) d.statuses.push(inreview);
      else d.statuses.splice(doneIdx, 0, inreview);
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

  // first few acceptance-criteria lines, for the card preview — real criteria
  // only, never padded/fabricated when a ticket has fewer than 3.
  function acLines(t) {
    return (t.acceptance || '')
      .split('\n')
      .map(l => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  // ---------- schedule (each ticket runs on its own, independent of the others) ----------
  function computeNextRun(sch, from) {
    const base = from || Date.now();
    if (sch.mode === 'daily') {
      const [hh, mm] = (sch.time || '09:00').split(':').map(Number);
      const d = new Date(base);
      d.setHours(hh || 0, mm || 0, 0, 0);
      if (d.getTime() <= base) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (sch.mode === 'interval') {
      const hours = Math.max(1, Number(sch.intervalHours) || 1);
      return base + hours * 3600000;
    }
    if (sch.mode === 'once') {
      const d = new Date(`${sch.date}T${sch.time || '09:00'}:00`);
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    return null;
  }

  function schLabel(sch) {
    if (!sch || !sch.enabled) return '';
    if (sch.mode === 'daily') return `daily ${fmtTime12(sch.time)}`;
    if (sch.mode === 'interval') return `every ${sch.intervalHours}h`;
    if (sch.mode === 'once') return `${sch.date} ${fmtTime12(sch.time)}`;
    return '';
  }

  // ms → "m:ss", for the on-card countdown once a schedule is coming up soon
  function fmtCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // remaining ms until this ticket's schedule fires, or null if not due soon
  // (used both for the initial render and the 1s ticker that keeps it live)
  function schedRemaining(sch, now) {
    if (!sch || !sch.enabled || !sch.nextRun) return null;
    const remain = sch.nextRun - now;
    return remain > 0 && remain <= SCHED_TIMER_WINDOW_MS ? remain : null;
  }

  // checked periodically for the ACTIVE project only — same scoping every
  // other ticket action already uses (agents/runAgent are bound to whichever
  // workspace is currently active), so a schedule fires while its own
  // project is open, exactly like clicking Start would.
  function tkSchedulerTick() {
    if (!projectDir) return;
    if (!tk) tk = tkLoad();
    if (!tk || !Array.isArray(tk.tickets)) return;
    const now = Date.now();
    let dirty = false;
    for (const t of tk.tickets) {
      const sch = t.schedule;
      // "starting soon" heads-up — keyed on nextRun so a recurring (daily/
      // interval) schedule re-alerts on its NEXT run instead of only once ever
      if (sch && sch.enabled && sch.nextRun) {
        const remain = sch.nextRun - now;
        if (remain > 0 && remain <= SCHED_ALERT_WINDOW_MS) {
          if (tkAlerted.get(t.id) !== sch.nextRun) {
            tkAlerted.set(t.id, sch.nextRun);
            showSchedAlert(t);
          }
        } else if (tkAlerted.has(t.id)) {
          tkAlerted.delete(t.id);
        }
      } else {
        tkAlerted.delete(t.id);
      }
      if (!sch || !sch.enabled || !sch.nextRun || sch.nextRun > now) continue;
      if (!t.agentId || tkRun.has(t.id) || t.status === 'inprogress') continue;
      dismissSchedAlert(t.id);
      startTicket(t.id, '');
      dirty = true;
      if (sch.mode === 'once') { sch.enabled = false; sch.nextRun = null; }
      else sch.nextRun = computeNextRun(sch, now);
    }
    if (dirty) tkSave();
  }
  setInterval(tkSchedulerTick, 20000);

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
    // stamped so the card can keep showing a "done" check-circle instead of
    // just reverting straight back to START/chat with no trace it ran
    const t = ticketById(id);
    if (t) { t.lastFinishedAt = Date.now(); tkSave(); }
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

  // persist the ticket's session linkage the INSTANT the run gets a session id
  // (runAgent's onSession, fired on 'init'), not only at graceful onDone — a run
  // the operator kills by restarting the app never reaches onDone, and the
  // follow-up would then start cold with no context. Store agentId too so the
  // resume guard (t.lastAgentId === aid) still matches on the next run.
  function onTicketSession(id, agentId, sid) {
    const t = ticketById(id);
    if (t && sid) {
      t.lastAgentId = agentId;
      t.lastSessionId = sid;
      tkSave();
    }
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
    // set below for model/agent runs so we can jump the console over to it
    // once it's launched — pipeline runs have no single agent chat to land on
    let navAgentId = null;

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
      // re-starting the SAME agent that ran this ticket before anchors back
      // onto its own session instead of losing prior context
      const resume = (t.lastAgentId === aid && t.lastSessionId) || null;
      tkRun.set(id, { kind: 'agent', agentId: aid, startedAt: Date.now() });
      runAgent(aid, prompt, false, false, {
        effort,
        resume: resume || undefined,
        fork: resume ? false : undefined,
        onSession: sid => onTicketSession(id, aid, sid),
        onDone: () => onTicketAgentDone(id, aid)
      });
      navAgentId = aid;
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
      const resume = (t.lastAgentId === a.id && t.lastSessionId) || null;
      tkRun.set(id, { kind: 'agent', agentId: a.id, startedAt: Date.now() });
      runAgent(a.id, prompt, false, false, {
        effort,
        resume: resume || undefined,
        fork: resume ? false : undefined,
        onSession: sid => onTicketSession(id, a.id, sid),
        onDone: () => onTicketAgentDone(id, a.id)
      });
      navAgentId = a.id;
    }

    t.status = inProgressStatusId();
    t.updatedAt = Date.now();
    tkSave();
    render();
    // a message typed into the card's own chatbox means the operator wants to
    // watch/continue it live — follow the run into the console right away
    // instead of leaving them staring at the board
    if (navAgentId && message && typeof openChat === 'function') openChat(navAgentId);
    // surface the console immediately so the operator sees the run — closes
    // the board itself + notes/browser/terminal, matching the chat-start flow
    if (typeof focusConsoleForTask === 'function') focusConsoleForTask();
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
        onSession: sid => onTicketSession(id, agentId, sid),
        onDone: () => onTicketAgentDone(id, agentId)
      });
      // follow the resumed session into the console instead of leaving the
      // operator parked on the board
      if (typeof openChat === 'function') openChat(agentId);
    } else {
      if (input) input.value = '';
      startTicket(id, text);
    }
  }

  // keep running cards' elapsed time + live status ticking without a full
  // board/list re-render (which would tear down drag listeners every second)
  setInterval(() => {
    if (!isOpen || !tk) return;
    for (const [id, run] of tkRun) {
      const label = (boardEl.querySelector(`.tk-card-item[data-id="${id}"] .tk-run-label`))
        || (listEl.querySelector(`.tk-row[data-id="${id}"] .tk-run-label`));
      if (label) label.textContent = runLabel(run);
    }
    const now = Date.now();
    for (const t of tk.tickets) {
      const timerEl = boardEl.querySelector(`.tk-card-item[data-id="${t.id}"] .tk-sched-timer`)
        || listEl.querySelector(`.tk-row[data-id="${t.id}"] .tk-sched-timer`);
      if (!timerEl) continue;
      const remain = schedRemaining(t.schedule, now);
      timerEl.classList.toggle('hidden', remain === null);
      if (remain !== null) {
        const cd = timerEl.querySelector('.tk-sched-countdown');
        if (cd) cd.textContent = `starts in ${fmtCountdown(remain)}`;
      }
      if (!tkRun.has(t.id) && t.lastFinishedAt) {
        const doneLabel = (boardEl.querySelector(`.tk-card-item[data-id="${t.id}"] .tk-done-label`))
          || (listEl.querySelector(`.tk-row[data-id="${t.id}"] .tk-done-label`));
        if (doneLabel) doneLabel.textContent = `done ${timeAgo(t.lastFinishedAt)}`;
      }
    }
  }, 1000);

  // ---------- open / close (center area swap — sidebar stays) ----------
  function openTk() {
    if (!projectDir) {
      if (window.toast) toast('Open a project folder first', false);
      return;
    }
    // only one center screen at a time — leave the notes gallery first
    if (window.closeNotesView) window.closeNotesView();
    if (window.closeBrowserView) window.closeBrowserView();
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
  window.closeTicketWs = closeTk;

  // project switched (or its folder changed) — the board is a transient UI
  // mode, not per-project state, so a switch always leaves it (no-op if
  // it was already closed)
  window.tkProjectChanged = () => {
    tk = null;   // reload fresh for whichever project is active now (scheduler included)
    if (!isOpen) return;
    closeTk();
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

  // statuses that have actually run something worth tracing back to
  const SESSION_VISIBLE_STATUSES = ['inprogress', 'inreview', 'done'];

  // short session-id badge — only once a run has actually stamped one, and
  // only past TODO (nothing to resume before a ticket has ever started)
  function sessionIdChip(t) {
    if (!t.lastSessionId || !SESSION_VISIBLE_STATUSES.includes(t.status)) return '';
    return `<span class="tk-chip tk-chip-sid" title="session ${esc(t.lastSessionId)}">
      ${esc(t.lastSessionId.slice(0, 8))}
    </span>`;
  }

  // schedule chip, rendered on its OWN row below the ticket number — kept
  // separate from cardMeta() so it never gets crowded out by agent/attachment
  // chips sharing the top row
  function schChip(t) {
    const sl = schLabel(t.schedule);
    if (!sl) return '';
    return `<span class="tk-chip tk-chip-sched"><span class="tk-chip-ico">⏰</span>${esc(sl)}</span>`;
  }

  // relative time since a ticket last finished running, for the "done" badge
  function timeAgo(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
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
    // once a run finishes it stays marked "done" (check-circle) instead of
    // silently disappearing back to START/chat with no trace it ever ran
    const justFinished = !run && !!t.lastFinishedAt;
    const criteria = acLines(t);
    const schRemain = schedRemaining(t.schedule, Date.now());
    const sched = schChip(t);
    el.className = 'tk-card-item' + (run ? ' tk-running' : '');
    el.draggable = true;
    el.dataset.id = t.id;
    el.dataset.status = t.status;
    el.innerHTML = `
      <div class="tk-card-top">
        <span class="tk-num">${esc(t.num || '')}</span>
        <span class="tk-card-chips">${cardMeta(t)}</span>
      </div>
      ${sched ? `<div class="tk-card-sched-row">${sched}</div>` : ''}
      <div class="tk-card-title">${esc(t.title)}</div>
      <div class="tk-sched-timer ${schRemain === null ? 'hidden' : ''}">
        <span class="tk-sched-ico">⏰</span><span class="tk-sched-countdown"></span>
      </div>
      ${criteria.length ? `
      <div class="tk-card-criteria">
        ${criteria.slice(0, 3).map(c => `<div class="tk-cr-line">☐ ${esc(c)}</div>`).join('')}
        ${criteria.length > 3 ? `<div class="tk-cr-more">+${criteria.length - 3} more</div>` : ''}
      </div>` : ''}
      ${sessionIdChip(t) ? `<div class="tk-card-sid-row">${sessionIdChip(t)}</div>` : ''}
      <div class="tk-card-run ${run ? '' : 'hidden'}">
        <span class="think-dots"><i></i><i></i><i></i></span>
        <span class="tk-run-label"></span>
        <button class="tk-run-stop" title="Stop">■</button>
      </div>
      <div class="tk-card-done ${justFinished ? '' : 'hidden'}">
        <span class="tk-done-ico">✓</span>
        <span class="tk-done-label"></span>
      </div>
      <div class="tk-card-chat ${showChat ? '' : 'hidden'}">
        <input class="tk-chat-input" placeholder="${everRun ? 'Follow up…' : 'Start with a message…'}" />
        <button class="tk-chat-send" title="${everRun ? 'Send — continues its last session' : 'Start'}">➤</button>
      </div>
      <div class="tk-card-start ${showStart ? '' : 'hidden'}">
        <button class="tk-start-btn" title="Start this task">▶ START</button>
      </div>`;
    if (run) el.querySelector('.tk-run-label').textContent = runLabel(run);
    if (justFinished) el.querySelector('.tk-done-label').textContent = `done ${timeAgo(t.lastFinishedAt)}`;
    if (schRemain !== null) {
      el.querySelector('.tk-sched-countdown').textContent = `starts in ${fmtCountdown(schRemain)}`;
    }
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
      const schRemain = schedRemaining(t.schedule, Date.now());
      const sched = schChip(t);
      const justFinished = !run && !!t.lastFinishedAt;
      const row = document.createElement('div');
      row.className = 'tk-row' + (run ? ' tk-running' : '');
      row.dataset.id = t.id;
      row.innerHTML = `
        <span class="tk-cell-num">${esc(t.num || '')}</span>
        <span class="tk-cell-title">
          <span class="tk-cell-title-text">${esc(t.title)}</span>
          ${sched ? `<span class="tk-cell-sched-row">${sched}</span>` : ''}
          ${desc ? `<span class="tk-cell-desc">${esc(desc)}</span>` : ''}
          <span class="tk-sched-timer ${schRemain === null ? 'hidden' : ''}">
            <span class="tk-sched-ico">⏰</span><span class="tk-sched-countdown"></span>
          </span>
        </span>
        <span class="tk-cell-status">
          <span class="tk-status-pill ${esc(t.status)}">${esc(st.label)}</span>
        </span>
        <span class="tk-cell-agent">${run
          ? `<span class="think-dots"><i></i><i></i><i></i></span> <span class="tk-run-label"></span>`
          : `${esc(agentLabel(t) || '—')}${sessionIdChip(t)}${justFinished
              ? '<span class="tk-cell-done"><span class="tk-done-ico">✓</span><span class="tk-done-label"></span></span>'
              : ''}`}</span>
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
      if (justFinished) row.querySelector('.tk-done-label').textContent = timeAgo(t.lastFinishedAt);
      if (schRemain !== null) {
        row.querySelector('.tk-sched-countdown').textContent = `starts in ${fmtCountdown(schRemain)}`;
      }
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
    const sch = (t && t.schedule) || null;
    schModeSel.value = sch ? sch.mode : 'off';
    schDateIn.value = (sch && sch.date) || '';
    setTimePicker((sch && sch.time) || '09:00');
    schIntervalIn.value = (sch && sch.intervalHours) || '';
    showSchFields(schModeSel.value);
    document.getElementById('tk-f-del').classList.toggle('hidden', !t);
    document.getElementById('tk-f-gosession').classList.toggle(
      'hidden', !(t && t.lastAgentId && t.lastSessionId)
    );
    modal.classList.remove('hidden');
    document.getElementById('tk-f-title').focus();
  }
  // jump straight to that ticket's last conversation in the console — same
  // per-agent dock the roster card click opens (openChat, app.js), so
  // resuming here and resuming via the roster land in the same place
  document.getElementById('tk-f-gosession').onclick = () => {
    const t = editingId ? ticketById(editingId) : null;
    if (!t || !t.lastAgentId) return;
    closeModal();
    goToTicketSession(t);
  };

  // jump to a ticket's console view, replaying its stored transcript when the
  // feed has nothing live for that agent (openChatSession handles the backfill;
  // falls back to plain openChat if app.js hasn't defined it)
  function goToTicketSession(t) {
    if (typeof openChatSession === 'function') {
      openChatSession(t.lastAgentId, t.lastSessionId || null);
    } else if (typeof openChat === 'function') {
      openChat(t.lastAgentId);
    }
  }
  function closeModal() {
    modal.classList.add('hidden');
    editingId = null;
    draftAtt = [];
  }

  function showSchFields(mode) {
    schDateWrap.classList.toggle('hidden', mode !== 'once');
    schTimeWrap.classList.toggle('hidden', mode !== 'once' && mode !== 'daily');
    schIntervalWrap.classList.toggle('hidden', mode !== 'interval');
  }
  schModeSel.onchange = () => showSchFields(schModeSel.value);

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
    const schMode = schModeSel.value;
    let schedule = null;
    if (schMode !== 'off') {
      if (!agentId) {
        if (window.toast) toast('Pick RUN WITH before scheduling this ticket', false);
        return;
      }
      if (schMode === 'once' && !schDateIn.value) {
        if (window.toast) toast('Pick a date for the one-time schedule', false);
        return;
      }
      if (schMode === 'interval' && !(Number(schIntervalIn.value) > 0)) {
        if (window.toast) toast('Pick how many hours between runs', false);
        return;
      }
      schedule = {
        enabled: true, mode: schMode,
        date: schDateIn.value || null,
        time: getTimePicker(),
        intervalHours: Number(schIntervalIn.value) || null
      };
      schedule.nextRun = computeNextRun(schedule, Date.now());
      // a one-time schedule for a moment that's already gone by would fire
      // the instant it's saved — same trap as the AM/PM mixup, so block it
      // outright instead of silently running the task right away
      if (schMode === 'once' && schedule.nextRun !== null && schedule.nextRun <= Date.now()) {
        if (window.toast) {
          toast(`That's already passed — ${schDateIn.value} ${fmtTime12(schedule.time)} is in the past`, false);
        }
        return;
      }
    }
    const fields = {
      title,
      acceptance: acField.value,
      status: document.getElementById('tk-f-status').value,
      agentId,
      agentName: ag ? ag.name : null,   // survives roster changes
      effort: (efSel && efSel.value) || 'auto',
      attachments: draftAtt,
      schedule,
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
