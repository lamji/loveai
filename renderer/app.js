// ============================================================
// LoveAi — central console renderer + auto pipeline
// ============================================================

const RULES = {
  prompt: `You are the PROMPT ENGINEER of a 3-stage pipeline (Prompt Engineer -> Senior Engineer(s) -> Reviewer Engineer). The operator only tells you an ISSUE — never code the fix yourself.

YOUR JOB:
1. Search and read the codebase thoroughly to understand the issue: exact files, functions, line numbers, data flow, and root cause.
2. Produce ONE-TIME, EXACT, EXECUTABLE prompt file(s) for Senior Engineer agents. Write them to .loveai/pipeline/task-<NN>-<slug>.md in the project root (create the folder if missing).
3. Each prompt file MUST contain:
   - FIRST TWO LINES, exactly this format:
     COMPLEXITY: low | medium | high
     MODEL: claude-haiku-4-5-20251001 (for low) | claude-sonnet-5 (for medium) | claude-opus-4-8 (for high)
     Rate honestly by real difficulty: trivial/mechanical edits = low, typical feature/bugfix work = medium, tricky architecture/concurrency/security work = high. This routes each task to the cheapest model that can do it well.
   - CONTEXT: the issue, root cause, and relevant architecture (MVVM layers if applicable). Be complete but terse — no filler, the file must stand alone because engineers start with a FRESH context and only this file.
   - SCOPE: an explicit TO-DO checklist with exact file paths and what to change in each — and an explicit OUT-OF-SCOPE list (what must NOT be touched).
   - ACCEPTANCE CRITERIA: how to know the change is correct (commands to run, expected behavior).
4. If the work is large or parallelizable, split it into 2, 3, or 4 independent prompt files (one per Senior Engineer) with zero file overlap between them. Otherwise produce a single file.
5. Also write .loveai/pipeline/review-brief.md for the Reviewer: FIRST LINE must be "REVIEW-MODEL: claude-sonnet-5" (or claude-opus-4-8 only if the changes are high-risk); then summarize the task context, list every file expected to change, and the risks/regressions to watch for.
6. End your reply with a short summary of the prompt files created.

Never modify source code. You only read code and write files inside .loveai/pipeline/.

7. SPEED: FIRST read .loveai/index/PROJECT-MAP.md if it exists and use it to jump directly to the files relevant to the ISSUE — do NOT re-explore the whole codebase. Open only files the map marks as involved plus their direct dependents. Paste the relevant map excerpt into each task file's CONTEXT so the Senior Engineer needs zero additional exploration.

8. PLAN MODE: when you are asked to only PLAN (no files written), end your reply with a line in exactly this format so the app can route the implementation run to the cheapest adequate model:
IMPLEMENT-MODEL: claude-haiku-4-5-20251001 (mechanical edits) | claude-sonnet-5 (typical work) | claude-opus-4-8 (tricky architecture/concurrency/security)
Rate the OVERALL implementation complexity honestly.`,

  senior: `You are a SENIOR SOFTWARE ENGINEER in a 3-stage pipeline (Prompt Engineer -> you -> Reviewer Engineer).

YOUR JOB:
1. When assigned a task like "execute task-01-...", read that prompt file from .loveai/pipeline/ and follow it STRICTLY and LITERALLY.
2. NO OVERSCOPING: touch only the files listed in the SCOPE checklist. Do not refactor, rename, reformat, or "improve" anything outside it, even if you see problems — instead note them in your final summary.
3. Work through the TO-DO checklist in order. Verify against the ACCEPTANCE CRITERIA before finishing.
4. When done, append a short entry to .loveai/pipeline/changes-log.md: which task file you executed, every file you changed, and how you verified it.
5. If asked to "fix review findings", read .loveai/pipeline/review-findings.md, fix ONLY what is listed for your files, and update changes-log.md.

If the prompt file is ambiguous or impossible to follow without overscoping, stop and report the conflict instead of guessing.

6. SPEED: trust your task file's CONTEXT; read only the files it lists (plus .loveai/index/PROJECT-MAP.md for orientation if needed). Do not survey the repo. If you change what a file is responsible for, update its section in PROJECT-MAP.md.`,

  indexer: `You are the PROJECT INDEXER. Read the codebase (skip node_modules, dist, .git, .loveai) and write \`.loveai/index/PROJECT-MAP.md\`: purpose, tech stack, architecture overview, module map with EXACT file paths and each file's responsibilities/key symbols, data flow between modules, entry points, conventions. Max ~400 lines. If given a changed-file list, update ONLY the affected sections of the existing map in place. Never modify source code; write only inside .loveai/index/.`,

  reviewer: `You are the REVIEWER ENGINEER, the final gate of a 3-stage pipeline (Prompt Engineer -> Senior Engineer(s) -> you).

YOUR JOB:
1. Read .loveai/pipeline/review-brief.md (task context) and .loveai/pipeline/changes-log.md (what was done). CREATE YOUR OWN VALIDATION PLAN first: write it to .loveai/pipeline/validation-plan.md — how you will verify each change (reads, builds, tests, manual traces).
2. Review every changed file for:
   - Code quality and current best practices — use web search when unsure, ESPECIALLY MVVM architecture rules (views must not contain logic, viewmodels must not touch UI, models pure).
   - Dead code, unused imports, unused functions/variables.
   - Long files/functions that should be split (functions > ~50 lines or files > ~300 lines introduced/bloated by the change).
   - Suspicious code likely to cause a bug or regression: edge cases, null handling, async races, broken contracts with untouched callers.
   - Scope compliance: any change outside the task file's SCOPE is automatically a finding.
3. VERDICT — you MUST write .loveai/pipeline/review-findings.md and its FIRST LINE must be exactly "VERDICT: REJECTED" or "VERDICT: APPROVED".
   - REJECTED: list each finding (file, line, problem, required fix, which task file it belongs to).
   - APPROVED: summarize what you validated.
4. Never fix code yourself — you only review and report. You may run builds/tests to validate.

5. SPEED: scope validation to the files in review-brief.md and changes-log.md plus their direct callers per .loveai/index/PROJECT-MAP.md — do not re-audit the whole repo.`
};

// perm defaults to bypassPermissions: this GUI has no permission-prompt UI, and
// acceptEdits auto-approves file edits but STILL blocks on Bash/exec — so any
// agent that runs a shell command would hang forever waiting for an answer the
// app can't give. Bypass lets tools run unattended, as an autonomous runner needs.
// lean: true — the agent's session loads ONLY the project CLAUDE.md, not the
// user's global config/skills (big token saving; their rules string is their
// whole contract). GENERAL-OPS stays non-lean since it may rely on user skills.
const DEFAULT_AGENTS = [
  { id: 'def-prompt-eng', name: 'PROMPT-ENGINEER', role: 'prompt', model: 'claude-fable-5', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.prompt },
  { id: 'def-senior-eng-01', name: 'SENIOR-ENG-01', role: 'senior', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.senior },
  { id: 'def-reviewer-eng', name: 'REVIEWER-ENGINEER', role: 'reviewer', model: 'claude-opus-4-8', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.reviewer },
  // no rules — free-form helper for general tasks (fix git issues, merge conflicts, quick questions...)
  { id: 'def-general', name: 'GENERAL-OPS', role: 'custom', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: false, cwd: '', rules: '' }
];

const ROLE_ICON = { prompt: '🧠', senior: '🛠', reviewer: '🔍', custom: '⬡', indexer: '🗺' };
const MODEL_LABELS = {
  'claude-sonnet-5': 'SONNET 5',
  'claude-opus-4-8': 'OPUS 4.8',
  'claude-haiku-4-5-20251001': 'HAIKU 4.5',
  'claude-fable-5': 'FABLE 5'
};
const TOOL_ICON = {
  Bash: '⌨', PowerShell: '⌨', Read: '📄', Edit: '✏', Write: '✏', MultiEdit: '✏',
  Glob: '🔎', Grep: '🔎', WebSearch: '🌐', WebFetch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '☑'
};

// ===== State =====
let agents = JSON.parse(localStorage.getItem('agents') || '[]');
for (const d of DEFAULT_AGENTS) {
  const existing = agents.find(a => a.id === d.id);
  if (!existing) agents.push({ ...d });
  else {
    if (!existing.role) existing.role = d.role;
    // def-* agents are app-managed: keep their rules current with this build
    // (RULES gains new directives over time, e.g. IMPLEMENT-MODEL routing)
    if (d.rules) existing.rules = d.rules;
    if (existing.lean === undefined) existing.lean = d.lean;
  }
}
// agents saved by earlier builds have no lean flag — default by role
for (const a of agents) {
  if (a.lean === undefined) a.lean = ['prompt', 'senior', 'reviewer', 'indexer'].includes(a.role);
}
// one-time migration: earlier builds saved agents with perm:'acceptEdits', which
// hangs on the first Bash/exec (no permission-prompt UI to approve it). Upgrade
// any still on that mode to bypassPermissions so shell steps run unattended.
if (!localStorage.getItem('permMigrated')) {
  for (const a of agents) if (a.perm === 'acceptEdits') a.perm = 'bypassPermissions';
  localStorage.setItem('permMigrated', '1');
}
// one-time migration: the INDEXER agent was retired. Drop the app-managed default
// copy (the pipeline now skips the mapping stage gracefully when it's absent).
if (!localStorage.getItem('indexerRemoved')) {
  agents = agents.filter(a => a.id !== 'def-indexer');
  localStorage.setItem('indexerRemoved', '1');
}
localStorage.setItem('agents', JSON.stringify(agents));

// runtime per agent: { running, runId, sessionId, lastResult, status }
const rt = {};
let editingId = null;
let feedFilter = null; // agentId or null = all
const streamEls = {};  // agentId -> current streaming feed element

const modal = document.getElementById('modal');
const consoleFeed = document.getElementById('console-feed');

function save() { localStorage.setItem('agents', JSON.stringify(agents)); }
function uid() { return Math.random().toString(36).slice(2, 10); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function R(id) { return rt[id] || (rt[id] = { running: false, sessionId: null, status: 'standing by' }); }

// ===== Shared deck session (one Claude CLI session per project — context intact across agents) =====
function sessKey() { return 'deckSession:' + (projectDir || 'default'); }
function getSession() { return localStorage.getItem(sessKey()) || null; }
function setSession(id) { if (id) localStorage.setItem(sessKey(), id); }
function clearSession() { localStorage.removeItem(sessKey()); }

// ===== Per-project Prompt Engineer session reuse (warm context on repeat runs) =====
const PE_SESSIONS_KEY = 'loveai-pe-sessions';
function readPESessions() {
  try { return JSON.parse(localStorage.getItem(PE_SESSIONS_KEY) || '{}'); } catch { return {}; }
}
function savePESession(cwd, sessionId) {
  try {
    const map = readPESessions();
    map[cwd] = sessionId;
    localStorage.setItem(PE_SESSIONS_KEY, JSON.stringify(map));
  } catch {}
}
function getPESession(cwd) {
  try { return readPESessions()[cwd] || null; } catch { return null; }
}
function clearPESession(sessionId) {
  try {
    const map = readPESessions();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (map[k] === sessionId) { delete map[k]; changed = true; }
    }
    if (changed) localStorage.setItem(PE_SESSIONS_KEY, JSON.stringify(map));
  } catch {}
}

// ============================================================
// Rendering — chips (console head) + roster (sidebar)
// ============================================================
function render() {
  renderRoster();
  renderTargets();
}

const ROLE_LABEL = { prompt: 'PROMPT ENGINEER', senior: 'SENIOR ENGINEER', reviewer: 'REVIEWER', custom: 'OPERATIVE', indexer: 'INDEXER' };

function renderRoster() {
  const roster = document.getElementById('roster');
  roster.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'roster-card' + (R(a.id).running ? ' running' : '');
    const running = R(a.id).running;
    el.innerHTML = `
      <div class="rc-actions">
        <button class="icon-btn" data-act="stop" title="Stop" ${running ? '' : 'style="display:none"'}>■</button>
        <button class="icon-btn" data-act="edit" title="Configure">⚙</button>
        <button class="icon-btn" data-act="del" title="Remove">✕</button>
      </div>
      <div class="rc-avatar">${ROLE_ICON[a.role] || ROLE_ICON.custom}<span class="rc-dot"></span></div>
      <div class="rc-name">${esc(a.name)}</div>
      <div class="rc-role">${ROLE_LABEL[a.role] || ROLE_LABEL.custom}</div>
      <div class="rc-foot">
        <span class="rc-model">${MODEL_LABELS[a.model] || ''}</span>
        <span class="rc-status ${running ? 'run' : ''}">${running ? 'RUNNING' : 'IDLE'}</span>
      </div>`;
    el.querySelector('[data-act="stop"]').onclick = (e) => { e.stopPropagation(); stopAgent(a.id); };
    el.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); openModal(a.id); };
    el.querySelector('[data-act="del"]').onclick = (e) => {
      e.stopPropagation();
      if (R(a.id).running) stopAgent(a.id);
      agents = agents.filter(x => x.id !== a.id);
      if (feedFilter === a.id) feedFilter = null;
      save(); render(); applyFilter();
    };
    el.onclick = () => openChat(a.id);
    roster.appendChild(el);
  }
}

function renderTargets() {
  const sel = document.getElementById('chat-target');
  const current = sel.value;
  sel.innerHTML = '<option value="__pipeline__">⟢ AUTO PIPELINE</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${ROLE_ICON[a.role] || ROLE_ICON.custom} ${a.name}`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
}


// ============================================================
// Console feed
// ============================================================
function hideFeedEmpty() {
  const e = document.getElementById('feed-empty');
  if (e) e.remove();
}

function feed(agentId, cls, text, ico, sameLine = false) {
  hideFeedEmpty();
  const s = streamEls[agentId];
  if (sameLine && s && s.isConnected) {
    s.querySelector('.body').textContent += text;
  } else {
    const a = agents.find(x => x.id === agentId);
    const el = document.createElement('div');
    el.className = 'ev';
    el.dataset.agent = agentId;
    el.innerHTML = `<span class="tag">${esc(a ? a.name : '?')}</span><span class="ico">${ico || ''}</span><span class="body ${cls}"></span>`;
    el.querySelector('.body').textContent = text;
    if (feedFilter && feedFilter !== agentId) el.style.display = 'none';
    consoleFeed.appendChild(el);
    if (sameLine) streamEls[agentId] = el;
    else delete streamEls[agentId];
  }
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

function endStream(agentId) { delete streamEls[agentId]; }

// After a plan-mode run finishes, drop an inline action card into the console.
// Primary action DELEGATES the plan to a Senior Engineer (the planner stays a
// planner); a secondary link lets the planner implement it itself instead.
// Both exit plan mode (uncheck the toggle) and resume the planner's session so
// the full plan is already in context.
function feedImplementCard(plannerId, planSessionId) {
  hideFeedEmpty();
  const planner = agents.find(x => x.id === plannerId);
  const senior = byRole('senior')[0];
  // the planner rates its own plan's complexity (IMPLEMENT-MODEL: line, per
  // RULES.prompt) — capture it now, before lastText gets overwritten
  const routeModel = parseModelLine(R(plannerId).lastText, 'IMPLEMENT-MODEL');
  const el = document.createElement('div');
  el.className = 'ev';
  el.innerHTML = `<span class="tag">${esc(planner ? planner.name : '?')}</span><span class="ico">▶</span>` +
    `<span class="body sys">plan ready — <button class="impl-btn">▶ IMPLEMENT THIS PLAN</button> ` +
    `<span class="impl-hint"></span></span>`;
  const btn = el.querySelector('.impl-btn');
  const hint = el.querySelector('.impl-hint');
  if (senior) {
    hint.innerHTML = `(hands off to ${esc(senior.name)}) · <a class="impl-alt" href="#">or let ${esc(planner ? planner.name : 'planner')} do it</a>`;
    hint.querySelector('.impl-alt').onclick = (e) => {
      e.preventDefault();
      lockImplCard(btn, hint, 'implementing directly…');
      implementPlan(plannerId, plannerId, planSessionId, routeModel);
    };
  } else {
    hint.textContent = '(no Senior Engineer on roster — the planner will implement it)';
  }
  btn.onclick = () => {
    const runnerId = senior ? senior.id : plannerId;
    if (R(runnerId).running) { plog('err', `${(agents.find(a => a.id === runnerId) || {}).name || 'agent'} is already running.`); return; }
    lockImplCard(btn, hint, senior ? `handing off to ${senior.name}…` : 'implementing…');
    implementPlan(runnerId, plannerId, planSessionId, routeModel);
  };
  consoleFeed.appendChild(el);
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

function lockImplCard(btn, hint, label) {
  btn.disabled = true;
  btn.textContent = label;
  const alt = hint.querySelector('.impl-alt');
  if (alt) alt.replaceWith(document.createTextNode(''));
}

// runnerId — who builds it (a Senior Engineer, or the planner itself).
// plannerId — whose plan we carry forward.
// routeModel — complexity-rated model from the plan's IMPLEMENT-MODEL: line;
// the build runs on the cheapest adequate model while planning stays premium.
//
// TOKEN-LEAN HANDOFF: we do NOT resume or fork the planning session (forking
// duplicates and re-replays the whole planning transcript — the exact thing that
// drained the plan limit). Instead we carry ONLY the plan text forward, inline,
// and start the builder on a FRESH context. One compact plan in, no history.
function implementPlan(runnerId, plannerId, planSessionId, routeModel) {
  const planBox = document.getElementById('chat-plan');
  if (planBox) planBox.checked = false;   // exit plan mode for future sends too
  const delegated = runnerId !== plannerId;
  const planText = (R(plannerId).lastText || '').trim();

  // if the plan text somehow didn't stream, fall back to resuming in place
  // (still no fork) so the plan isn't lost — rare, but safe.
  if (!planText) {
    const planner = agents.find(x => x.id === plannerId);
    const opts = planSessionId
      ? { resume: planSessionId, fork: false, cwd: planner && planner.cwd ? planner.cwd : undefined }
      : {};
    if (routeModel) opts.model = routeModel;
    runAgent(runnerId, delegated
      ? 'Implement the plan from the conversation above, in full — write every file and run any commands to complete and verify it.'
      : 'Proceed and implement the plan you just produced — make the changes for real, then verify.', false, false, opts);
    return;
  }

  const header = delegated
    ? 'A Prompt Engineer produced this plan. IMPLEMENT it now, in full — you have everything you need here; do not re-explore beyond what the plan calls for.'
    : 'IMPLEMENT the plan below in full — make the changes for real.';
  const prompt = `${header}

===== PLAN =====
${planText}
================

- Follow the plan; if anything is ambiguous, make the reasonable call and note it.
- If it's large or spans independent areas, split by complexity and delegate parts to sub-agents (Task/Agent tool), then integrate.
- Write every needed file and run any required commands to complete AND verify the work.`;

  // FRESH context — no resume, no fork, no transcript replay
  const opts = {};
  if (routeModel) opts.model = routeModel;
  runAgent(runnerId, prompt, false, false, opts);
}

function applyFilter() {
  consoleFeed.querySelectorAll('.ev').forEach(el => {
    el.style.display = (!feedFilter || el.dataset.agent === feedFilter) ? '' : 'none';
  });
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

// ===== Live activity strip — what every running agent is doing right now =====
const activityEl = document.getElementById('activity');
const STAGE_LABEL = {
  index: 'PIPELINE ▸ STAGE 0 — INDEXER MAPPING PROJECT',
  prompt: 'PIPELINE ▸ STAGE 1 — PROMPT ENGINEER ANALYZING',
  plan: 'PIPELINE ▸ STAGE 2 — AWAITING YOUR PLAN REVIEW',
  build: 'PIPELINE ▸ STAGE 3 — SENIOR ENGINEERS BUILDING',
  review: 'PIPELINE ▸ STAGE 4 — REVIEWER VALIDATING'
};

function elapsedText(since) {
  const s = Math.floor((Date.now() - since) / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function renderActivity() {
  const running = agents.filter(a => R(a.id).running);
  const stage = pipe.active ? STAGE_LABEL[pipe.stage] : null;
  if (!running.length && !stage) {
    activityEl.classList.add('hidden');
    activityEl.innerHTML = '';
    syncPane();
    return;
  }
  activityEl.classList.remove('hidden');
  activityEl.innerHTML = '';
  if (stage) {
    const s = document.createElement('div');
    s.className = 'act-stage';
    s.textContent = stage;
    activityEl.appendChild(s);
  }
  for (const a of running) {
    const r = R(a.id);
    const row = document.createElement('div');
    row.className = 'act-row';
    row.innerHTML = `<span class="act-name"></span><span class="act-spin"></span><span class="act-status"></span><span class="act-elapsed"></span><button class="act-stop" title="Abort this agent">■ STOP</button>`;
    row.querySelector('.act-name').textContent = a.name;
    row.querySelector('.act-status').textContent = r.status || 'working...';
    row.querySelector('.act-elapsed').textContent = r.startedAt ? elapsedText(r.startedAt) : '';
    row.querySelector('.act-stop').onclick = () => { stopAgent(a.id); feed(a.id, 'sys', 'stop requested — aborting…', '■'); };
    activityEl.appendChild(row);
  }
  syncPane();
}

// keep the elapsed counters moving so the console never looks frozen
setInterval(() => { if (!activityEl.classList.contains('hidden')) renderActivity(); }, 1000);

// ===== Console vs editor =====
// Agents working -> the console; nothing running -> back to the code you had open.
// An explicit click (open a file, or ✕ back to console) wins until the busy state
// next flips, so we never yank a pane out from under a deliberate choice.
let paneOverride = null;
let lastBusy = null;

function anyBusy() { return pipe.active || agents.some(a => R(a.id).running); }

function syncPane() {
  // the terminal view owns the pane while it's open
  if (!document.getElementById('term-view').classList.contains('hidden')) return;
  const busy = anyBusy();
  if (busy !== lastBusy) { paneOverride = null; lastBusy = busy; }
  const want = paneOverride || (busy ? 'console' : 'editor');
  viewer.classList.toggle('hidden', !(want === 'editor' && activeFile));
}

function ticker(agentId, text, idle = false) {
  R(agentId).status = text;
  renderActivity();
  updateChatModal();
}

// ============================================================
// Run / stop
// ============================================================
// opts.model — per-run override (pipeline routes by task complexity)
// opts.fresh — start with a clean context instead of the shared session; the run
//              also doesn't overwrite the shared session (token-lean pipeline runs)
// project-map hint cache: one indexStatus IPC per cwd per app session (the
// status call walks the tree to fingerprint it — too heavy to repeat every run)
const mapHintSeen = new Map();   // cwd -> boolean (PROJECT-MAP.md exists)
async function hasProjectMap(cwd) {
  if (!cwd) return false;
  if (!mapHintSeen.has(cwd)) {
    let st = { exists: false };
    try { st = await window.deck.indexStatus(cwd); } catch {}
    mapHintSeen.set(cwd, !!st.exists);
  }
  return mapHintSeen.get(cwd);
}

async function runAgent(agentId, prompt, fork = false, plan = false, opts = {}) {
  const a = agents.find(x => x.id === agentId);
  const r = R(agentId);
  if (!a || r.running) return;
  if (!prompt) { feed(agentId, 'err', 'no task assigned.', '⚠'); return; }

  const model = (opts.model && MODEL_LABELS[opts.model]) ? opts.model : a.model;
  r.running = true;
  r.runId = uid();
  r.planMode = plan;
  r.noShare = !!opts.fresh;
  r.startedAt = Date.now();
  r.lastText = '';
  setRunningUI(agentId, true);
  ticker(agentId, 'initializing session...');
  feed(agentId, 'sys', (plan ? 'PLAN ▸ ' : 'TASK ▸ ') + prompt, plan ? '🗺' : '🎯');
  if (model !== a.model) feed(agentId, 'sys', `model routed by complexity → ${MODEL_LABELS[model]}`, '⚖');

  // point the agent at the project map so it never re-explores the repo.
  // The indexer writes the map, so it never gets the hint itself.
  const cwd = opts.cwd || a.cwd;
  let fullPrompt = prompt;
  if (a.role !== 'indexer' && await hasProjectMap(cwd)) {
    fullPrompt += '\n\nOrientation: read .loveai/index/PROJECT-MAP.md first and open only the files relevant to this task — do not survey the repo.';
  }

  await window.deck.runAgent({
    runId: r.runId, agentId, prompt: fullPrompt,
    model, cwd, rules: a.rules,
    permissionMode: plan ? 'plan' : a.perm,
    leanContext: !!a.lean,
    addDirs: (a.dirs || '').split(',').map(s => s.trim()).filter(Boolean),
    // token-lean default: every run starts FRESH. Context only carries over on
    // explicit intent — opts.resume (a specific session) or opts.cont (the
    // shared session, via the CONTINUE toggle / follow-up chat). The old
    // behavior replayed the whole ever-growing shared transcript on every send.
    resumeSessionId: opts.resume ? opts.resume : (opts.cont ? getSession() : null),
    // no fork on shared-session continues: forking duplicates the transcript
    // and re-replays it; continuing in place gets prompt-cache hits instead
    forkSession: opts.resume ? (opts.fork !== false) : fork
  });
}

function stopAgent(agentId) {
  const r = R(agentId);
  if (r.running && r.runId) window.deck.stopAgent(r.runId);
}

function setRunningUI(agentId, running) {
  if (!running) ticker(agentId, 'standing by', true);
  renderRoster();
  renderActivity();
  updateChatModal();
}

// ============================================================
// Events from main process
// ============================================================
window.deck.onAgentEvent(ev => {
  // the skill-editor's private agent streams into its own modal, not the console
  if (ev.agentId === SKILL_AGENT) { skillAgentEvent(ev); return; }
  const r = R(ev.agentId);
  if (ev.runId !== r.runId) return;

  switch (ev.kind) {
    case 'init':
      r.sessionId = ev.sessionId;
      feed(ev.agentId, 'sys', `session ${ev.sessionId.slice(0, 8)} · ${ev.model}`, '⚡');
      ticker(ev.agentId, 'thinking...');
      break;
    case 'session-invalid':
      // the resumed session no longer exists on disk — forget it so it isn't
      // reused; the run auto-retries with a fresh context in the main process
      if (getSession() === ev.sessionId) clearSession();
      clearPESession(ev.sessionId);
      r.noShare = false;
      feed(ev.agentId, 'sys', 'stored session was stale — starting a fresh context.', '↺');
      break;
    case 'text-delta':
      // a delta with no open stream element starts a fresh assistant message —
      // keep only the latest one, it's the agent's closing summary
      if (!streamEls[ev.agentId]) { r.lastText = ''; ticker(ev.agentId, 'writing response...'); }
      r.lastText = (r.lastText || '') + ev.text;
      feed(ev.agentId, 'txt', ev.text, '', true);
      break;
    case 'text-end':
      endStream(ev.agentId);
      break;
    case 'tool': {
      endStream(ev.agentId);
      const ico = TOOL_ICON[ev.tool] || '⚙';
      let detail = '';
      try {
        const inp = JSON.parse(ev.input);
        detail = inp.file_path || inp.path || inp.command || inp.pattern || inp.query || inp.prompt || '';
      } catch { detail = ev.input; }
      detail = String(detail).slice(0, 120);
      feed(ev.agentId, 'tool', `${ev.tool} ${detail}`, ico);
      ticker(ev.agentId, `${ev.tool} ▸ ${detail}`);
      break;
    }
    case 'result': {
      r.sessionId = ev.sessionId || r.sessionId;
      if (ev.sessionId && !r.noShare) setSession(ev.sessionId);
      r.lastResult = ev.subtype;
      trackUsage(ev);
      const doneAgent = agents.find(x => x.id === ev.agentId);
      if (ev.sessionId && doneAgent && doneAgent.role === 'prompt' && pipe.cwd) savePESession(pipe.cwd, ev.sessionId);
      // token breakdown makes context bloat visible per run: high "in" with low
      // "cache" means the run re-sent everything fresh — a scoping regression
      const kTok = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);
      const tok = ev.usage
        ? ` · in ${kTok(ev.usage.input)} / out ${kTok(ev.usage.output)} / cache ${kTok(ev.usage.cacheRead)}`
        : '';
      feed(ev.agentId, ev.subtype === 'success' ? 'ok' : 'err',
        `${ev.subtype.toUpperCase()} · ${ev.numTurns} turns · ${(ev.durationMs / 1000).toFixed(1)}s · $${(ev.costUsd || 0).toFixed(4)}${tok}`, '◆');
      break;
    }
    case 'aborted':
      r.lastResult = 'aborted';
      feed(ev.agentId, 'err', 'aborted by operator.', '■');
      break;
    case 'error':
      r.lastResult = 'error';
      feed(ev.agentId, 'err', 'ERROR: ' + ev.error, '⚠');
      break;
    case 'done':
      r.running = false;
      endStream(ev.agentId);
      if (r.planMode && r.lastResult === 'success') {
        feed(ev.agentId, 'sys', 'plan complete — nothing was written yet.', '🗺');
        feedImplementCard(ev.agentId, r.sessionId);
      }
      r.planMode = false;
      setRunningUI(ev.agentId, false);
      if (typeof gitRefresh === 'function' && gitRepo) gitRefresh();
      onPipelineAgentDone(ev.agentId, r.lastResult)
        .then(() => { if (!pipe.active) cleanupSeniors(); });
      break;
  }
});

// ============================================================
// AUTO PIPELINE ORCHESTRATOR
// prompt -> PLAN REVIEW (operator gate) -> build -> review -> loop
// ============================================================
const pipe = { active: false, stage: null, cwd: '', iteration: 0, maxIter: 3, pending: new Set(), taskAssign: new Map(), planTasks: [], taskModels: new Map(), reviewModel: null };

// "MODEL: <id>" line written by the Prompt Engineer — routes each task to the
// cheapest model that fits its complexity
function parseModelLine(content, key = 'MODEL') {
  const m = new RegExp('^' + key + ':\\s*(\\S+)', 'mi').exec(content || '');
  return m && MODEL_LABELS[m[1]] ? m[1] : null;
}

// pipeline log lines go straight to the central console
function plog(cls, text) {
  const map = { ok: 'ok', err: 'err', info: 'sys' };
  feedRaw('PIPELINE', map[cls] || 'sys', text, '⟢');
}

function setStage(stage) {
  pipe.stage = stage;
  renderActivity();
}

function byRole(role) { return agents.filter(a => a.role === role); }

async function launchPipeline(issue) {
  const pe = byRole('prompt')[0];
  if (!pe) { plog('err', 'no Prompt Engineer agent on roster.'); return; }
  if (!pe.cwd) { plog('err', 'set a working directory on PROMPT-ENGINEER first (⚙), or import a project.'); return; }

  pipe.active = true;
  pipe.cwd = pe.cwd;
  pipe.iteration = 0;
  pipe.pending.clear();
  pipe.taskAssign.clear();
  document.getElementById('btn-pipeline-stop').classList.remove('hidden');
  hidePlanReview();

  await window.deck.pipelineReset(pipe.cwd);
  plog('info', 'pipeline dir reset.');

  let st = { exists: false, stale: false, changedFiles: [] };
  try { st = await window.deck.indexStatus(pipe.cwd); } catch {}

  if (st.exists && !st.stale) {
    plog('info', 'project index fresh — skipping Stage 0.');
    startStage1(issue);
    return;
  }

  const indexer = byRole('indexer')[0];
  if (!indexer) { plog('err', 'no Indexer agent on roster — skipping Stage 0.'); startStage1(issue); return; }
  if (!indexer.cwd) { indexer.cwd = pipe.cwd; save(); }

  pipe.pendingIssue = issue;
  setStage('index');
  const prompt = st.exists
    ? `These files changed since the last index: ${st.changedFiles.join(', ')}\nUpdate only the affected sections of .loveai/index/PROJECT-MAP.md per your rules.`
    : 'Index this project per your rules.';
  plog('info', st.exists ? 'project index stale — Stage 0: INDEXER updating map...' : 'no project index — Stage 0: INDEXER mapping project...');
  runAgent(indexer.id, prompt, false, false, { fresh: true });
}

function startStage1(issue) {
  const pe = byRole('prompt')[0];
  plog('info', 'Stage 1: PROMPT ENGINEER analyzing...');
  setStage('prompt');
  const resume = getPESession(pipe.cwd);
  const opts = resume ? { resume, fork: true } : {};
  if (resume) plog('info', `resuming Prompt Engineer session ${resume.slice(0, 8)} (warm context)`);
  runAgent(pe.id, `ISSUE: ${issue}\n\nAnalyze the codebase and produce the executable task prompt file(s) and review-brief.md per your pipeline rules.`, false, false, opts);
}

function abortPipeline(msg) {
  pipe.active = false;
  setStage(null);
  document.getElementById('btn-pipeline-stop').classList.add('hidden');
  hidePlanReview();
  for (const id of pipe.pending) stopAgent(id);
  const pr = byRole('prompt')[0]; if (pr && R(pr.id).running) stopAgent(pr.id);
  const rv = byRole('reviewer')[0]; if (rv && R(rv.id).running) stopAgent(rv.id);
  if (msg) plog('err', msg);
  cleanupSeniors();
}

function finishPipeline(msg) {
  pipe.active = false;
  setStage(null);
  document.getElementById('btn-pipeline-stop').classList.add('hidden');
  plog('ok', msg);
  cleanupSeniors();
}

// the pipeline may clone extra SENIOR-ENG agents for parallel builds — once the
// work is over, retire them so the roster returns to the default line-up
function cleanupSeniors() {
  const keep = agents.find(a => a.id === 'def-senior-eng-01') || byRole('senior')[0];
  let removed = 0;
  agents = agents.filter(a => {
    if (a.role !== 'senior' || (keep && a.id === keep.id)) return true;
    if (R(a.id).running) return true;   // retired later, on its done event
    if (feedFilter === a.id) feedFilter = null;
    removed++;
    return false;
  });
  if (removed) {
    save(); render(); applyFilter();
    plog('info', `auto-retired ${removed} extra senior engineer(s) — roster back to default.`);
  }
}

// ---------- Plan review gate ----------
// The plan lands as a summary card at the end of the console; the card opens
// the full result (task files + follow-up chatbox) in a scrollable modal.
const planModal = document.getElementById('plan-modal');
let planCardEl = null;

function openPlanModal() {
  planModal.classList.remove('hidden');
  document.getElementById('pr-revision').focus();
}
function hidePlanReview() { planModal.classList.add('hidden'); }

function feedPlanCard(summary, count) {
  hideFeedEmpty();
  const el = document.createElement('button');
  el.className = 'plan-result';
  el.innerHTML = `<div class="pl-head">🧠 PLAN READY <span class="pl-open">CLICK FOR FULL RESULT ▸</span></div>
    <div class="pl-summary"></div><div class="pl-meta"></div>`;
  el.querySelector('.pl-summary').textContent = summary;
  el.querySelector('.pl-meta').textContent = `${count} task file(s) · awaiting your review`;
  el.onclick = openPlanModal;
  consoleFeed.appendChild(el);
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
  planCardEl = el;
}

// retire the pending card once the plan is approved, discarded or superseded
function closePlanCard(note) {
  if (!planCardEl) return;
  planCardEl.classList.add('done');
  planCardEl.querySelector('.pl-meta').textContent = note;
  planCardEl.querySelector('.pl-open').textContent = 'VIEW ▸';
  planCardEl = null;
}

async function showPlanReview() {
  setStage('plan');
  const files = await window.deck.pipelineRead(pipe.cwd);
  const relevant = files.filter(f => /^task-\d+.*\.md$/i.test(f.name) || f.name === 'review-brief.md');
  const tabs = document.getElementById('pr-tabs');
  const content = document.getElementById('pr-content');
  tabs.innerHTML = '';
  relevant.forEach((f, i) => {
    const tab = document.createElement('button');
    tab.className = 'pr-tab' + (i === 0 ? ' active' : '');
    tab.textContent = f.name;
    tab.onclick = () => {
      tabs.querySelectorAll('.pr-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      content.textContent = f.content;
      content.scrollTop = 0;
    };
    tabs.appendChild(tab);
  });
  content.textContent = relevant.length ? relevant[0].content : '(no plan files found)';

  const pe = byRole('prompt')[0];
  const summary = (pe && (R(pe.id).lastText || '').trim()) || '(no summary returned — open the card for the full plan)';
  document.getElementById('pr-summary').textContent = summary;
  feedPlanCard(summary, pipe.planTasks.length);
  plog('info', `PLAN READY — ${pipe.planTasks.length} task file(s). Open the card above to review and pass to engineers.`);
}

document.getElementById('pr-close').onclick = hidePlanReview;
planModal.addEventListener('click', e => { if (e.target === planModal) hidePlanReview(); });

document.getElementById('pr-approve').onclick = async () => {
  if (!pipe.active || pipe.stage !== 'plan') return;
  hidePlanReview();
  closePlanCard('approved — passed to engineers');
  // pull the complexity-based model routing out of the plan files
  pipe.taskModels.clear();
  pipe.reviewModel = null;
  const files = await window.deck.pipelineRead(pipe.cwd);
  for (const f of files) {
    if (/^task-\d+.*\.md$/i.test(f.name)) {
      const m = parseModelLine(f.content);
      if (m) pipe.taskModels.set(f.name, m);
    } else if (f.name === 'review-brief.md') {
      pipe.reviewModel = parseModelLine(f.content, 'REVIEW-MODEL');
    }
  }
  const n = Math.min(pipe.planTasks.length, 4);
  plog('ok', `plan approved by operator. Deploying ${n} senior engineer(s)...`);
  const seniors = ensureSeniors(n);
  pipe.taskAssign.clear();
  pipe.planTasks.slice(0, 4).forEach((t, i) => pipe.taskAssign.set(seniors[i % seniors.length].id, t));
  plog('info', 'Stage 3: BUILD — seniors executing in parallel...');
  startBuild('execute');
};

document.getElementById('pr-discard').onclick = () => {
  if (!pipe.active) { hidePlanReview(); return; }
  closePlanCard('discarded by operator');
  abortPipeline('plan discarded by operator.');
};

function revisePlan() {
  const box = document.getElementById('pr-revision');
  const text = box.value.trim();
  if (!text || !pipe.active || pipe.stage !== 'plan') return;
  const pe = byRole('prompt')[0];
  if (!pe) return;
  box.value = '';
  hidePlanReview();
  closePlanCard('superseded by a revision request');
  setStage('prompt');
  plog('info', 'revision requested — Prompt Engineer updating the plan...');
  // resume the PE's own planning session so the plan (and the analysis behind
  // it) is still in context — runs no longer inherit the shared session
  const resume = getPESession(pipe.cwd) || R(pe.id).sessionId;
  runAgent(pe.id, `PLAN REVISION REQUEST: ${text}

Update the existing plan files in .loveai/pipeline/ accordingly. Modify ONLY the sections affected by this revision — keep every unaffected section exactly as it is. Edit the existing task-*.md / review-brief.md files in place (add or delete files only if the revision requires it), then summarize what changed.`,
    false, false, resume ? { resume, fork: false } : {});
}
document.getElementById('pr-revise-btn').onclick = revisePlan;
document.getElementById('pr-revision').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') revisePlan();
});

// ---------- Stages ----------
function ensureSeniors(n) {
  let seniors = byRole('senior');
  const template = seniors[0] || DEFAULT_AGENTS[1];
  while (seniors.length < n) {
    const idx = seniors.length + 1;
    const clone = {
      ...template,
      id: uid(),
      name: 'SENIOR-ENG-0' + idx,
      role: 'senior',
      cwd: pipe.cwd,
      rules: RULES.senior
    };
    agents.push(clone);
    seniors = byRole('senior');
  }
  for (const s of seniors) if (!s.cwd) s.cwd = pipe.cwd;
  save(); render();
  return seniors.slice(0, n);
}

function startBuild(taskCmd) {
  setStage('build');
  const entries = [...pipe.taskAssign.entries()];
  pipe.pending = new Set(entries.map(([agentId]) => agentId));
  for (const [agentId, taskFile] of entries) {
    const prompt = taskCmd === 'fix'
      ? `Fix review findings: read .loveai/pipeline/review-findings.md and fix ONLY the findings for your task file (${taskFile}), per your rules. Then update changes-log.md.`
      : `Execute ${taskFile}: read .loveai/pipeline/${taskFile} and follow it strictly per your pipeline rules.`;
    // token-lean: task files are self-contained, so each senior starts FRESH
    // (no replay of the whole planning conversation) on the model the Prompt
    // Engineer rated for that task's complexity
    const model = pipe.taskModels.get(taskFile);
    const a = agents.find(x => x.id === agentId);
    if (model) plog('info', `${a ? a.name : agentId} ▸ ${taskFile} on ${MODEL_LABELS[model]} (complexity-routed)`);
    runAgent(agentId, prompt, false, false, { model, fresh: true });
  }
}

function startReview() {
  setStage('review');
  const rv = byRole('reviewer')[0];
  if (!rv) { abortPipeline('no Reviewer agent on roster.'); return; }
  if (!rv.cwd) { rv.cwd = pipe.cwd; save(); }
  plog('info', `Stage 4: REVIEWER validating (pass ${pipe.iteration + 1})...`);
  // fresh + routed: the brief/changes-log on disk carry all needed context
  runAgent(rv.id, pipe.iteration === 0
    ? 'Review the pipeline changes per your rules. Write validation-plan.md first, then review-findings.md with a VERDICT first line.'
    : 'The Senior Engineers applied fixes for your previous findings. Re-review per your rules and write a fresh review-findings.md with a VERDICT first line.',
    false, false, { model: pipe.reviewModel, fresh: true });
}

async function onPipelineAgentDone(agentId, result) {
  if (!pipe.active) return;
  const a = agents.find(x => x.id === agentId);
  if (!a) return;

  if (pipe.stage === 'index' && a.role === 'indexer') {
    if (result === 'success') {
      try { await window.deck.indexMark(pipe.cwd); } catch {}
    } else {
      plog('err', `${a.name} ${result} building the index — continuing without it.`);
    }
    const issue = pipe.pendingIssue;
    pipe.pendingIssue = null;
    startStage1(issue);
    return;
  }

  if (result === 'error' || result === 'aborted') {
    abortPipeline(`${a.name} ${result} — pipeline halted.`);
    return;
  }

  if (pipe.stage === 'prompt' && a.role === 'prompt') {
    const scan = await window.deck.pipelineScan(pipe.cwd);
    if (!scan.tasks.length) { abortPipeline('Prompt Engineer produced no task files — halted.'); return; }
    pipe.planTasks = scan.tasks;
    await showPlanReview();
    return;
  }

  if (pipe.stage === 'build' && a.role === 'senior') {
    pipe.pending.delete(agentId);
    plog('ok', `${a.name} finished (${pipe.pending.size} still working).`);
    if (pipe.pending.size === 0) startReview();
    return;
  }

  if (pipe.stage === 'review' && a.role === 'reviewer') {
    const scan = await window.deck.pipelineScan(pipe.cwd);
    if (scan.verdict === 'APPROVED') {
      finishPipeline(`APPROVED after ${pipe.iteration + 1} review pass(es). Pipeline complete. ✔`);
    } else if (scan.verdict === 'REJECTED') {
      pipe.iteration++;
      if (pipe.iteration >= pipe.maxIter) {
        abortPipeline(`still REJECTED after ${pipe.maxIter} passes — manual attention needed (see review-findings.md).`);
      } else {
        plog('err', `REJECTED — sending findings back to senior engineer(s) (fix round ${pipe.iteration})...`);
        startBuild('fix');
      }
    } else {
      abortPipeline('reviewer produced no VERDICT — halted (check review-findings.md).');
    }
  }
}

document.getElementById('btn-pipeline-stop').onclick = () => abortPipeline('pipeline aborted by operator.');

// ============================================================
// Chatbox — routes to pipeline or a single agent
// ============================================================
// raw console line not tied to an agent (operator/shell output)
function feedRaw(tag, cls, text, ico) {
  hideFeedEmpty();
  const el = document.createElement('div');
  el.className = 'ev';
  el.innerHTML = `<span class="tag op">${esc(tag)}</span><span class="ico">${ico || ''}</span><span class="body ${cls}"></span>`;
  el.querySelector('.body').textContent = text;
  consoleFeed.appendChild(el);
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

// ===== Attachments (drag & drop or 📎) =====
let attachments = [];
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function renderAttach() {
  for (const boxId of ['attach-chips', 'cm-attach']) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    box.innerHTML = '';
    attachments.forEach((p, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.title = p;
      chip.innerHTML = `${IMG_RE.test(p) ? '🖼' : '📄'} <span></span> <b title="Remove">✕</b>`;
      chip.querySelector('span').textContent = p.split(/[\\/]/).pop();
      chip.querySelector('b').onclick = () => { attachments.splice(i, 1); renderAttach(); };
      box.appendChild(chip);
    });
  }
}

function addDroppedFiles(fileList) {
  for (const f of fileList) {
    const p = window.deck.fileToPath(f);
    if (p && !attachments.includes(p)) attachments.push(p);
  }
  renderAttach();
}

// consume attachments into a prompt suffix — Claude Code reads images/files from disk
function attachBlock() {
  if (!attachments.length) return '';
  const block = '\n\nAttached files (open and view/read them from disk):\n' + attachments.map(p => '- ' + p).join('\n');
  attachments = [];
  renderAttach();
  return block;
}

function enableDrop(el) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dropping'); });
  el.addEventListener('dragleave', () => el.classList.remove('dropping'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('dropping');
    if (e.dataTransfer && e.dataTransfer.files) addDroppedFiles(e.dataTransfer.files);
  });
}
enableDrop(document.getElementById('chat-input'));
enableDrop(document.getElementById('cm-input'));

const fileIn = document.getElementById('file-in');
document.getElementById('btn-attach').onclick = () => fileIn.click();
document.getElementById('cm-attach-btn').onclick = () => fileIn.click();
fileIn.onchange = () => { addDroppedFiles(fileIn.files); fileIn.value = ''; };

// ===== Slash menu — /skills and /commands, CLI style =====
const chatInput = document.getElementById('chat-input');
const slashMenu = document.getElementById('slash-menu');
let slashItems = [];      // { name, description, type, scope, path }
let slashMatches = [];
let slashSel = 0;

async function loadSlashItems() {
  const [skills, cmds] = await Promise.all([
    window.deck.skillsList(projectDir || ''),
    window.deck.commandsList(projectDir || '')
  ]);
  const seen = new Set();
  slashItems = [
    ...skills.map(s => ({ ...s, type: 'skill' })),
    ...cmds.map(c => ({ ...c, type: 'command' }))
  ].filter(i => { if (seen.has(i.name)) return false; seen.add(i.name); return true; })
   .sort((a, b) => a.name.localeCompare(b.name));
}

// the query is only live while the caret sits in a leading "/word"
function slashQuery() {
  const v = chatInput.value;
  const m = /^\/([\w-]*)$/.exec(v.slice(0, chatInput.selectionStart));
  return v.startsWith('/') && m ? m[1] : null;
}

function hideSlash() { slashMenu.classList.add('hidden'); slashMatches = []; }

function renderSlash() {
  const q = slashQuery();
  if (q === null || !slashItems.length) { hideSlash(); return; }
  slashMatches = slashItems.filter(i => i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  if (!slashMatches.length) { hideSlash(); return; }
  slashSel = Math.min(slashSel, slashMatches.length - 1);

  slashMenu.innerHTML = '';
  slashMatches.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slashSel ? ' sel' : '');
    row.innerHTML = '<span class="slash-name"></span><span class="slash-desc"></span><span class="slash-kind"></span>';
    row.querySelector('.slash-name').textContent = '/' + it.name;
    row.querySelector('.slash-desc').textContent = it.description || '';
    row.querySelector('.slash-kind').textContent = it.type === 'skill' ? 'SKILL·' + it.scope : 'CMD·' + it.scope;
    row.onmousedown = e => { e.preventDefault(); pickSlash(i); };
    row.onmouseenter = () => { slashSel = i; renderSlash(); };
    slashMenu.appendChild(row);
  });
  const foot = document.createElement('div');
  foot.className = 'slash-foot';
  foot.textContent = '↑↓ navigate · Tab/Enter select · Esc close';
  slashMenu.appendChild(foot);

  // sit right above the input, inside the chatbox
  const box = chatInput.closest('.chatbox');
  slashMenu.style.bottom = (box.clientHeight - chatInput.offsetTop + 6) + 'px';
  slashMenu.classList.remove('hidden');
  const sel = slashMenu.querySelector('.slash-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function pickSlash(i) {
  const it = slashMatches[i];
  if (!it) return;
  chatInput.value = '/' + it.name + ' ' + chatInput.value.replace(/^\/[\w-]*\s*/, '');
  const pos = it.name.length + 2;
  chatInput.setSelectionRange(pos, pos);
  hideSlash();
  chatInput.focus();
}

chatInput.addEventListener('input', () => { slashSel = 0; renderSlash(); });
chatInput.addEventListener('blur', () => setTimeout(hideSlash, 150));
chatInput.addEventListener('keydown', e => {
  if (slashMenu.classList.contains('hidden')) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % slashMatches.length; renderSlash(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + slashMatches.length) % slashMatches.length; renderSlash(); }
  else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) { e.preventDefault(); pickSlash(slashSel); }
  else if (e.key === 'Escape') { e.stopPropagation(); hideSlash(); }
});

// a leading /name becomes an explicit directive so the Prompt Engineer (or the
// single agent) loads that skill/command and builds its output around it
function slashDirective(text) {
  const m = /^\/([\w-]+)/.exec(text);
  if (!m) return '';
  const it = slashItems.find(i => i.name === m[1]);
  if (!it) return '';
  return `\n\n[OPERATOR DIRECTIVE] The request invokes "/${it.name}" — a ${it.type === 'skill' ? 'skill' : 'custom command'} defined at ${it.path}. Read that file FIRST and treat its instructions as binding for this task: follow its protocol, structure and constraints when producing your output (task prompt files included — they must tell the engineers to comply with it too).`;
}

async function sendChat() {
  const target = document.getElementById('chat-target').value;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // "!" prefix — quick shell command in the project dir, like the CLI
  if (text.startsWith('!')) {
    const cmd = text.slice(1).trim();
    if (!cmd) return;
    input.value = '';
    feedRaw('OPERATOR', 'tool', '$ ' + cmd, '⌨');
    const r = await window.deck.exec(cmd, projectDir || '');
    feedRaw('SHELL', r.ok ? 'txt' : 'err', (r.out || '').trim() || (r.ok ? '(no output)' : '(command failed)'));
    return;
  }

  const plan = document.getElementById('chat-plan').checked;
  const full = text + attachBlock() + slashDirective(text);
  if (target === '__pipeline__') {
    if (pipe.active) { plog('err', 'pipeline already running — abort it first.'); return; }
    launchPipeline(full);
  } else {
    // always a fresh, token-lean context — no transcript replay, no fork.
    // continuity comes from carried-forward summaries (plan text, follow-up chat),
    // never from re-sending the whole conversation.
    runAgent(target, full, false, plan);
  }
  input.value = '';
}

document.getElementById('btn-send').onclick = sendChat;
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') sendChat();
});

document.getElementById('btn-new-session').onclick = () => {
  if (Object.values(rt).some(r => r.running)) { plog('err', 'stop all agents before resetting the session.'); return; }
  clearSession();
  plog('info', 'shared session reset — next run starts with a fresh context.');
};

// ============================================================
// Follow-up chat modal (per agent, shared session context)
// ============================================================
const chatModal = document.getElementById('chat-modal');
let chatAgentId = null;

function openChat(agentId) {
  const a = agents.find(x => x.id === agentId);
  if (!a) return;
  chatAgentId = agentId;
  document.getElementById('cm-title').textContent = `${ROLE_ICON[a.role] || ROLE_ICON.custom} ${a.name} — FOLLOW-UP`;
  updateChatModal();
  // focus the console feed on this agent so its reply is easy to follow
  feedFilter = agentId;
  applyFilter();
  chatModal.classList.remove('hidden');
  document.getElementById('cm-input').focus();
}

function updateChatModal() {
  if (!chatAgentId) return;
  const a = agents.find(x => x.id === chatAgentId);
  if (!a) return;
  const r = R(chatAgentId);
  const sess = getSession();
  document.getElementById('cm-status').innerHTML =
    `<span class="${r.running ? 'run' : ''}">${r.running ? '● RUNNING — ' + esc(r.status) : '○ IDLE'}</span>` +
    ` · ${MODEL_LABELS[a.model] || a.model} · session ${sess ? esc(sess.slice(0, 8)) : '(new)'}`;
  document.getElementById('cm-send').disabled = r.running;
}

function sendChatModal() {
  const input = document.getElementById('cm-input');
  const text = input.value.trim();
  if (!text || !chatAgentId || R(chatAgentId).running) return;
  input.value = '';
  chatModal.classList.add('hidden');
  // the follow-up modal's whole purpose is continuity — resume the shared
  // session in place (no fork: forking re-replays the transcript from scratch)
  runAgent(chatAgentId, text + attachBlock(), false, false, { cont: true });
}

document.getElementById('cm-send').onclick = sendChatModal;
document.getElementById('cm-close').onclick = () => chatModal.classList.add('hidden');
document.getElementById('cm-input').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') sendChatModal();
});
chatModal.addEventListener('click', e => { if (e.target === chatModal) chatModal.classList.add('hidden'); });

// ============================================================
// Modal
// ============================================================
function openModal(id) {
  editingId = id || null;
  const a = id ? agents.find(x => x.id === id) : null;
  document.getElementById('modal-title').textContent = a ? 'CONFIGURE AGENT' : 'DEPLOY NEW AGENT';
  document.getElementById('f-name').value = a ? a.name : '';
  document.getElementById('f-model').value = a ? a.model : 'claude-sonnet-5';
  document.getElementById('f-role').value = a ? (a.role || 'custom') : 'custom';
  document.getElementById('f-perm').value = a ? a.perm : 'acceptEdits';
  document.getElementById('f-cwd').value = a ? (a.cwd || '') : (projectDir || '');
  document.getElementById('f-dirs').value = a ? (a.dirs || '') : '';
  document.getElementById('f-lean').checked = a ? !!a.lean : false;
  document.getElementById('f-rules').value = a ? (a.rules || '') : '';
  document.getElementById('f-save').textContent = a ? 'SAVE' : 'DEPLOY';
  modal.classList.remove('hidden');
  document.getElementById('f-name').focus();
}

document.getElementById('f-role').onchange = e => {
  const role = e.target.value;
  if (RULES[role]) document.getElementById('f-rules').value = RULES[role];
  // pipeline roles never need the user-global config — default them lean
  document.getElementById('f-lean').checked = ['prompt', 'senior', 'reviewer', 'indexer'].includes(role);
};
document.getElementById('btn-new-agent').onclick = () => openModal(null);
document.getElementById('f-cancel').onclick = () => modal.classList.add('hidden');
document.getElementById('f-browse').onclick = async () => {
  const dir = await window.deck.pickFolder();
  if (dir) document.getElementById('f-cwd').value = dir;
};
document.getElementById('f-save').onclick = () => {
  const name = document.getElementById('f-name').value.trim() || 'AGENT-' + uid().toUpperCase().slice(0, 4);
  const data = {
    name,
    model: document.getElementById('f-model').value,
    role: document.getElementById('f-role').value,
    perm: document.getElementById('f-perm').value,
    cwd: document.getElementById('f-cwd').value.trim(),
    dirs: document.getElementById('f-dirs').value.trim(),
    lean: document.getElementById('f-lean').checked,
    rules: document.getElementById('f-rules').value.trim()
  };
  if (editingId) Object.assign(agents.find(x => x.id === editingId), data);
  else agents.push({ id: uid(), ...data });
  save();
  modal.classList.add('hidden');
  render();
};
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // the alert is modal on purpose — Escape answers it, nothing else
    if (!alertModal.classList.contains('hidden')) { closeAlert(false); return; }
    modal.classList.add('hidden');
    document.getElementById('acct-modal').classList.add('hidden');
    document.getElementById('chat-modal').classList.add('hidden');
    document.getElementById('plan-modal').classList.add('hidden');
    document.getElementById('settings-modal').classList.add('hidden');
    if (!skillPage.classList.contains('hidden')) document.getElementById('ske-back').onclick();
    document.getElementById('git-panel').classList.add('hidden');
    document.getElementById('history-panel').classList.add('hidden');
  }
});

// ============================================================
// PROJECT IMPORT — one directory applied to all agents
// ============================================================
let projectDir = localStorage.getItem('projectDir') || '';

function renderProject() {
  const el = document.getElementById('project-path');
  el.textContent = projectDir || 'no project imported';
  el.classList.toggle('none', !projectDir);
  el.title = projectDir;
}

document.getElementById('btn-import').onclick = async () => {
  const dir = await window.deck.pickFolder();
  if (!dir) return;
  projectDir = dir;
  localStorage.setItem('projectDir', dir);
  for (const a of agents) a.cwd = dir;
  save(); render(); renderProject();
  gitDetect();
  exReset();
  loadSlashItems();   // project skills/commands may differ per project
  plog('info', 'project imported: all agents now work in ' + dir);
};

// ============================================================
// ACCOUNT / USAGE
// ============================================================
let auth = { loggedIn: false };
const todayKey = () => new Date().toISOString().slice(0, 10);
let usage = JSON.parse(localStorage.getItem('usage') || 'null');
if (!usage || usage.date !== todayKey()) usage = { date: todayKey(), runs: 0, in: 0, out: 0, cost: 0 };

function trackUsage(ev) {
  if (usage.date !== todayKey()) usage = { date: todayKey(), runs: 0, in: 0, out: 0, cost: 0 };
  usage.runs++;
  usage.cost += ev.costUsd || 0;
  if (ev.usage) {
    usage.in += ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite;
    usage.out += ev.usage.output;
  }
  localStorage.setItem('usage', JSON.stringify(usage));
  renderUsage();
}

function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }

function renderUsage() {
  document.getElementById('u-runs').textContent = usage.runs;
  document.getElementById('u-in').textContent = fmtK(usage.in);
  document.getElementById('u-out').textContent = fmtK(usage.out);
  document.getElementById('u-cost').textContent = '$' + usage.cost.toFixed(2);
}

async function refreshAuth() {
  auth = await window.deck.authStatus();
  const on = !!auth.loggedIn;
  document.getElementById('acct-dot').className = 'acct-dot ' + (on ? 'on' : 'off');
  document.getElementById('acct-email').textContent = on ? (auth.email || 'logged in') : 'NOT LOGGED IN — click to sign in';
  document.getElementById('acct-plan').textContent = on ? (auth.subscriptionType || auth.authMethod || '') + ' plan' : 'offline';
  document.getElementById('ac-status').textContent = on ? 'LOGGED IN ●' : 'LOGGED OUT ○';
  document.getElementById('ac-status').style.color = on ? 'var(--green)' : 'var(--red)';
  document.getElementById('ac-email').textContent = auth.email || '—';
  document.getElementById('ac-plan').textContent = (auth.subscriptionType || '—').toUpperCase();
  document.getElementById('ac-method').textContent = auth.authMethod || '—';
  document.getElementById('ac-org').textContent = auth.orgName || '—';
  document.getElementById('ac-logout').classList.toggle('hidden', !on);
  document.getElementById('ac-login').classList.toggle('hidden', on);
  return on;
}

// plan usage limits (session / weekly bars, like claude.ai settings > usage)
function fmtReset(iso) {
  const d = new Date(iso);
  const ms = d - Date.now();
  if (isNaN(ms)) return '';
  if (ms <= 0) return 'resets soon';
  const h = Math.floor(ms / 3.6e6), m = Math.round((ms % 3.6e6) / 6e4);
  if (h >= 24) return 'resets ' + d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `resets in ${h} hr ${m} min`;
}

let puCache = null;

function puDonut(pct, sev) {
  const r = 26, c = 2 * Math.PI * r;
  const used = Math.min(100, Math.max(0, pct)) / 100 * c;
  const color = sev === 'crit' ? 'var(--red)' : sev === 'warn' ? 'var(--amber)' : 'var(--cyan)';
  return `<svg viewBox="0 0 64 64" class="pu-donut" role="img" aria-label="${pct}% used">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(120,150,255,0.15)" stroke-width="7"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${used} ${c - used}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="36" text-anchor="middle" class="pu-donut-txt">${pct}%</text>
  </svg>`;
}

function renderPlanUsageView() {
  const box = document.getElementById('plan-usage');
  const r = puCache;
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="pu-loading">${esc(r.error || 'unavailable')}</div>`; return; }
  const names = { session: 'Current session', weekly_all: 'Weekly — all models' };
  box.innerHTML = '';
  box.classList.add('pie');
  for (const l of r.limits || []) {
    const label = l.kind === 'weekly_scoped'
      ? 'Weekly — ' + ((l.scope && l.scope.model && l.scope.model.display_name) || 'model')
      : (names[l.kind] || l.kind);
    const sev = l.percent >= 90 ? 'crit' : l.percent >= 70 ? 'warn' : '';
    const row = document.createElement('div');
    row.className = 'pu-cell';
    row.innerHTML = `
      ${puDonut(l.percent, sev)}
      <div class="pu-cell-label">${esc(label)}</div>
      <div class="pu-reset">${esc(fmtReset(l.resets_at))}</div>`;
    box.appendChild(row);
  }
  if (r.extra) {
    const row = document.createElement('div');
    row.className = 'pu-cell pu-extra';
    row.innerHTML = `<div class="pu-head"><span>Usage credits</span><span class="pu-pct">${r.extra.is_enabled ? (r.extra.utilization ?? 0) + '% used' : 'off'}</span></div>`;
    box.appendChild(row);
  }
}

async function renderPlanUsage() {
  const box = document.getElementById('plan-usage');
  if (!puCache) box.innerHTML = '<div class="pu-loading">loading...</div>';
  puCache = await window.deck.planUsage();
  renderPlanUsageView();
  if (puCache.ok) document.getElementById('pu-updated').textContent = '(updated ' + new Date().toLocaleTimeString() + ')';
}

// ============================================================
// Session history drawer (like `claude --resume` list)
// ============================================================
const historyPanel = document.getElementById('history-panel');

function agoText(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' hr ago';
  return Math.round(s / 86400) + ' d ago';
}

async function openHistory() {
  historyPanel.classList.remove('hidden');
  const list = document.getElementById('hp-list');
  list.innerHTML = '<div class="pu-loading">loading sessions...</div>';
  const sessions = await window.deck.sessionsList();
  list.innerHTML = '';
  if (!sessions.length) { list.innerHTML = '<div class="pu-loading">no sessions found</div>'; return; }
  const current = getSession();
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'hp-item' + (s.id === current ? ' current' : '');
    row.innerHTML = `
      <div class="hp-top"><span class="hp-proj">${esc(s.project)}</span><span class="hp-ago">${esc(agoText(s.mtime))}</span></div>
      <div class="hp-snippet">${esc(s.snippet || '(no prompt found)')}</div>
      <div class="hp-id">${esc(s.id.slice(0, 8))}${s.id === current ? ' · ACTIVE' : ''}</div>`;
    row.onclick = async () => {
      setSession(s.id);
      historyPanel.classList.add('hidden');
      // replay the stored transcript so the operator sees what this context contains
      const msgs = await window.deck.sessionLoad(s.id);
      if (msgs.length) {
        feedRaw('SESSION', 'sys', `— previous conversation of ${s.id.slice(0, 8)} (${msgs.length} entries) —`, '🕘');
        for (const m of msgs) {
          if (m.role === 'user') feedRaw('YOU', 'sys', m.text, '🗣');
          else if (m.role === 'tool') feedRaw('AGENT', 'tool', m.text, '⚙');
          else feedRaw('AGENT', 'txt', m.text);
        }
      } else {
        feedRaw('SESSION', 'sys', '(no stored logs found for this session)', '🕘');
      }
      feedRaw('SESSION', 'ok', `resumed session ${s.id.slice(0, 8)} (${s.project}) — next agent run continues this context.`, '🕘');
    };
    list.appendChild(row);
  }
}

document.getElementById('btn-history').onclick = (e) => {
  e.stopPropagation();
  if (historyPanel.classList.contains('hidden')) openHistory();
  else historyPanel.classList.add('hidden');
};
document.getElementById('hp-close').onclick = () => historyPanel.classList.add('hidden');
document.addEventListener('click', e => {
  if (!historyPanel.classList.contains('hidden') &&
      !historyPanel.contains(e.target) && e.target.id !== 'btn-history') {
    historyPanel.classList.add('hidden');
  }
});

const acctModal = document.getElementById('acct-modal');
document.getElementById('account-bar').onclick = () => { acctModal.classList.remove('hidden'); refreshAuth(); renderUsage(); renderPlanUsage(); };
document.getElementById('ac-close').onclick = () => acctModal.classList.add('hidden');
// live: re-fetch plan usage every 60s while the modal is open
setInterval(() => { if (!acctModal.classList.contains('hidden')) renderPlanUsage(); }, 60000);
acctModal.addEventListener('click', e => { if (e.target === acctModal) acctModal.classList.add('hidden'); });
document.getElementById('ac-refresh').onclick = () => { refreshAuth(); renderPlanUsage(); };
document.getElementById('ac-reset').onclick = () => {
  usage = { date: todayKey(), runs: 0, in: 0, out: 0, cost: 0 };
  localStorage.setItem('usage', JSON.stringify(usage));
  renderUsage();
};
document.getElementById('ac-logout').onclick = async () => {
  await window.deck.authLogout();
  await refreshAuth();
};
document.getElementById('ac-login').onclick = async () => {
  await window.deck.authLogin();
  const poll = setInterval(async () => {
    if (await refreshAuth()) clearInterval(poll);
  }, 4000);
  setTimeout(() => clearInterval(poll), 180000);
};

// gate agent runs when logged out
const _runAgent = runAgent;
runAgent = async function (agentId, prompt, fork = false, plan = false, opts = {}) {
  if (!auth.loggedIn) {
    const on = await refreshAuth();
    if (!on) {
      feed(agentId, 'err', 'not logged in — open the account panel (bottom-left) and sign in first.', '🔒');
      acctModal.classList.remove('hidden');
      return;
    }
  }
  return _runAgent(agentId, prompt, fork, plan, opts);
};

// ============================================================
// GIT — VS Code-style source control
// ============================================================
let repos = [], gitRepo = null;
const gitPanel = document.getElementById('git-panel');
const GIT_STATUS_LABEL = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' };

async function gitDetect() {
  repos = projectDir ? await window.deck.gitRepos(projectDir) : [];
  const sel = document.getElementById('git-repo-sel');
  sel.innerHTML = '';
  for (const r of repos) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r === projectDir ? r.split(/[\\/]/).pop() + ' (root)' : r.split(/[\\/]/).pop();
    o.title = r;
    sel.appendChild(o);
  }
  // single repo: automatic. multiple: menu to choose.
  sel.classList.toggle('hidden', repos.length < 2);
  if (!repos.includes(gitRepo)) gitRepo = repos[0] || null;
  if (gitRepo) sel.value = gitRepo;
  await gitRefresh();
}

async function gitRefresh() {
  const badge = document.getElementById('git-badge');
  if (!gitRepo) { badge.classList.add('hidden'); return; }

  // status of every repo — badge shows the TOTAL across all (like VS Code multi-root)
  const all = await Promise.all(repos.map(async r => ({ repo: r, st: await window.deck.gitStatus(r) })));
  const valid = all.filter(x => x.st.ok);
  if (!valid.length) { badge.classList.add('hidden'); return; }
  repos = valid.map(x => x.repo);
  if (!repos.includes(gitRepo)) { gitRepo = repos[0]; document.getElementById('git-repo-sel').value = gitRepo; }

  const countOf = st => st.staged.length + st.unstaged.length + st.untracked.length;
  const total = valid.reduce((n, x) => n + countOf(x.st), 0);
  const sel = valid.find(x => x.repo === gitRepo);

  badge.classList.remove('hidden');
  badge.classList.toggle('dirty', total > 0);
  const countEl = document.getElementById('git-count');
  countEl.textContent = total > 99 ? '99+' : total;
  // 3 chars can't sit in an 18px circle — fall back to a pill for 99+
  countEl.classList.toggle('wide', total > 99);
  document.getElementById('git-sel-count').textContent = countOf(sel.st) || '';

  // per-repo counts in the picker
  const selEl = document.getElementById('git-repo-sel');
  [...selEl.options].forEach(o => {
    const x = valid.find(v => v.repo === o.value);
    if (!x) return;
    const base = o.value === projectDir ? o.value.split(/[\\/]/).pop() + ' (root)' : o.value.split(/[\\/]/).pop();
    const n = countOf(x.st);
    o.textContent = n ? `${base}  ●${n}` : base;
  });

  renderGitModal(sel.st);
}

function gitFileRow(f, statusChar, staged) {
  const parts = f.replace(/"/g, '').split('/');
  const base = parts.pop();
  const dir = parts.join('/');
  const row = document.createElement('div');
  row.className = 'git-file';
  row.title = f;
  row.innerHTML = `<span class="gf-name">${esc(base)}</span><span class="gf-dir">${esc(dir)}</span><button class="mini-btn">${staged ? '−' : '+'}</button><span class="gf-status s-${GIT_STATUS_LABEL[statusChar] || 'M'}">${GIT_STATUS_LABEL[statusChar] || statusChar}</span>`;
  row.querySelector('button').onclick = async () => {
    await window.deck.gitCmd(gitRepo, staged ? 'unstage' : 'stage', f);
    gitRefresh();
  };
  return row;
}

function renderGitModal(st) {
  document.getElementById('git-branch-line').textContent = `${gitRepo}  ·  ⎇ ${st.branch}`;
  const stagedBox = document.getElementById('git-staged');
  const unstagedBox = document.getElementById('git-unstaged');
  stagedBox.innerHTML = ''; unstagedBox.innerHTML = '';
  for (const { s, f } of st.staged) stagedBox.appendChild(gitFileRow(f, s, true));
  for (const { s, f } of st.unstaged) unstagedBox.appendChild(gitFileRow(f, s, false));
  for (const f of st.untracked) unstagedBox.appendChild(gitFileRow(f, '?', false));
  // like VS Code: staged section only appears when something is staged
  document.getElementById('sec-staged').classList.toggle('hidden', !st.staged.length);
  document.getElementById('staged-count').textContent = st.staged.length || '';
  document.getElementById('changes-count').textContent = st.unstaged.length + st.untracked.length || '';
  if (!st.unstaged.length && !st.untracked.length) unstagedBox.innerHTML = '<div class="git-none">working tree clean</div>';
}

function gitOut(text, ok = true) {
  const el = document.getElementById('git-out');
  el.textContent = text || '';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
}

async function gitDo(op, arg) {
  gitOut('working...', true);
  const r = await window.deck.gitCmd(gitRepo, op, arg);
  gitOut(r.out.split('\n').slice(-3).join(' · ') || (r.ok ? 'done' : 'failed'), r.ok);
  gitRefresh();
  return r;
}

document.getElementById('git-badge').onclick = async (e) => {
  e.stopPropagation();
  if (gitPanel.classList.contains('hidden')) {
    await gitDetect();
    gitPanel.classList.remove('hidden');
  } else {
    gitPanel.classList.add('hidden');
  }
};
// close the dropdown on any click outside it
document.addEventListener('click', e => {
  if (!gitPanel.classList.contains('hidden') && !document.getElementById('git-wrap').contains(e.target)) {
    gitPanel.classList.add('hidden');
  }
});
document.getElementById('git-repo-sel').onchange = e => { gitRepo = e.target.value; gitRefresh(); };
document.getElementById('git-refresh').onclick = gitRefresh;
// git panel ⌨: open a bash terminal in the CURRENTLY SELECTED repo — reuse a live
// tab already sitting in that repo, otherwise start a fresh one there
document.getElementById('git-bash').onclick = () => {
  gitPanel.classList.add('hidden');
  const repo = gitRepo || projectDir || '';
  termView.classList.remove('hidden');
  consoleFeed.classList.add('hidden');
  viewer.classList.add('hidden');
  const existing = termTabs.find(t => !t.dead && t.cwd === repo);
  if (existing) activateTerm(existing.id);
  else newTerm('bash', repo);
};

// ===== Tabbed interactive terminal — real PTYs + xterm.js =====
const termView = document.getElementById('term-view');
const tvTabs = document.getElementById('tv-tabs');
const tvBody = document.getElementById('tv-body');
const termTabs = [];        // { id, shell, title, xterm, fit, pane, dead }
let termActive = null;      // id
let termSeq = 0;

function termOpen() { return !termView.classList.contains('hidden'); }
function tabOf(id) { return termTabs.find(t => t.id === id); }

// one dispatcher for every tab's PTY output
window.deck.onTermData(p => {
  const t = tabOf(p.termId);
  if (!t) return;
  t.xterm.write(p.data);
  if (p.exited) { t.dead = true; renderTermTabs(); }
});

function renderTermTabs() {
  tvTabs.innerHTML = '';
  for (const t of termTabs) {
    const el = document.createElement('div');
    el.className = 'tv-tab' + (t.id === termActive ? ' active' : '') + (t.dead ? ' dead' : '');
    el.innerHTML = '<span></span><b title="Close tab">✕</b>';
    el.querySelector('span').textContent = t.title;
    el.onclick = () => activateTerm(t.id);
    el.querySelector('b').onclick = e => { e.stopPropagation(); closeTerm(t.id); };
    tvTabs.appendChild(el);
  }
}

function activateTerm(id) {
  termActive = id;
  for (const t of termTabs) t.pane.classList.toggle('hidden', t.id !== id);
  renderTermTabs();
  const t = tabOf(id);
  if (t) { try { t.fit.fit(); } catch {} t.xterm.focus(); }
}

// hover tooltip for terminal links — VS Code-style "ctrl+click to open"
const linkTip = document.createElement('div');
linkTip.id = 'link-tip';
linkTip.className = 'hidden';
document.body.appendChild(linkTip);

function showLinkTip(e, uri) {
  linkTip.textContent = '⌨ Hold Ctrl + click to open  ·  ' + uri;
  linkTip.classList.remove('hidden');
  linkTip.style.left = Math.max(8, Math.min(e.clientX + 14, window.innerWidth - linkTip.offsetWidth - 8)) + 'px';
  linkTip.style.top = (e.clientY + 18) + 'px';
}
function hideLinkTip() { linkTip.classList.add('hidden'); }

async function newTerm(shell, cwd) {
  const id = 'tab-' + (++termSeq) + '-' + uid();
  const pane = document.createElement('div');
  pane.className = 'tv-pane';
  tvBody.appendChild(pane);

  const xt = new Terminal({
    fontSize: 12.5,
    fontFamily: "'Cascadia Code', Consolas, monospace",
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme()
  });
  const fit = new FitAddon.FitAddon();
  xt.loadAddon(fit);
  // URLs in the terminal become real links: ctrl+click opens the OS browser
  xt.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => {
    if (e.ctrlKey || e.metaKey) { hideLinkTip(); window.deck.openExternal(uri); }
  }, { hover: showLinkTip, leave: hideLinkTip }));
  xt.open(pane);
  xt.onData(d => {
    window.deck.termInput(id, d);
    if (d === '\r') setTimeout(gitRefresh, 1500); // refresh badge after each command
  });
  xt.onResize(({ cols, rows }) => window.deck.termResize(id, cols, rows));
  new ResizeObserver(() => {
    if (termOpen() && termActive === id) { try { fit.fit(); } catch {} }
  }).observe(pane);

  const startCwd = cwd || gitRepo || projectDir || '';
  const t = { id, shell, cwd: startCwd, title: '', xterm: xt, fit, pane, dead: false };
  termTabs.push(t);
  activateTerm(id);
  try { fit.fit(); } catch {}

  const r = await window.deck.termStart(id, startCwd, xt.cols, xt.rows, shell);
  // bash silently falls back to powershell when git-bash isn't installed
  t.title = (r.shell === 'git bash' ? 'BASH' : 'PS') + ' ' + termSeq;
  if (!r.ok) {
    t.title = '✕ ' + t.title;
    t.dead = true;
    xt.writeln('\x1b[31m' + (r.error || 'failed to start shell') + '\x1b[0m');
  }
  renderTermTabs();
}

function closeTerm(id) {
  const i = termTabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = termTabs[i];
  window.deck.termKill(id);
  t.xterm.dispose();
  t.pane.remove();
  termTabs.splice(i, 1);
  if (termActive === id) {
    termActive = termTabs.length ? termTabs[Math.max(0, i - 1)].id : null;
    if (termActive) activateTerm(termActive);
  }
  renderTermTabs();
}

function openTerminal() {
  termView.classList.remove('hidden');
  consoleFeed.classList.add('hidden');
  viewer.classList.add('hidden');
  if (!termTabs.length) newTerm('bash');
  else activateTerm(termActive || termTabs[0].id);
}

function closeTerminalView() {
  // tabs keep their PTYs alive in the background — this only swaps the pane
  termView.classList.add('hidden');
  consoleFeed.classList.remove('hidden');
  syncPane();
}

document.getElementById('btn-term').onclick = () => (termOpen() ? closeTerminalView() : openTerminal());
document.getElementById('tv-close').onclick = closeTerminalView;
document.getElementById('tv-new-bash').onclick = () => newTerm('bash');
document.getElementById('tv-new-ps').onclick = () => newTerm('powershell');
document.getElementById('git-stage-all').onclick = () => gitDo('stage', '*');
document.getElementById('git-unstage-all').onclick = () => gitDo('unstage', '*');
document.getElementById('git-pull').onclick = () => gitDo('pull');

// commit like VS Code: if nothing is staged, stage everything first
async function doCommit(kind) {
  const msgBox = document.getElementById('git-msg');
  const msg = msgBox.value.trim();
  if (!msg && kind !== 'amend') { gitOut('commit message required', false); return; }
  gitOut('working...', true);
  const st = await window.deck.gitStatus(gitRepo);
  if (st.ok && !st.staged.length && (st.unstaged.length || st.untracked.length)) {
    await window.deck.gitCmd(gitRepo, 'stage', '*');
  }
  let r = await window.deck.gitCmd(gitRepo, kind === 'amend' ? 'amend' : 'commit', msg);
  if (r.ok) {
    msgBox.value = '';
    if (kind === 'sync') { await window.deck.gitCmd(gitRepo, 'pull'); r = await window.deck.gitCmd(gitRepo, 'push'); }
    else if (kind === 'push') r = await window.deck.gitCmd(gitRepo, 'push');
  }
  gitOut(r.out.split('\n').slice(-2).join(' · ') || (r.ok ? 'done' : 'failed'), r.ok);
  gitRefresh();
}

const commitMenu = document.getElementById('commit-menu');
document.getElementById('git-commit').onclick = () => doCommit('plain');
document.getElementById('git-commit-more').onclick = (e) => {
  e.stopPropagation();
  commitMenu.classList.toggle('hidden');
};
commitMenu.querySelectorAll('.cm-item').forEach(item => {
  item.onclick = () => { commitMenu.classList.add('hidden'); doCommit(item.dataset.kind); };
});
document.addEventListener('click', () => commitMenu.classList.add('hidden'));
document.getElementById('git-msg').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') doCommit('plain');
});
// keep the badge fresh: poll + refresh after every agent run
setInterval(() => { if (gitRepo && !gitPanel.classList.contains('hidden')) gitRefresh(); }, 10000);
setInterval(() => { if (gitRepo) gitRefresh(); }, 30000);

// ============================================================
// Themed alert / confirm — never the native dialog, which ignores the theme
// ============================================================
const alertModal = document.getElementById('alert-modal');
let alertResolve = null;

function closeAlert(result) {
  alertModal.classList.add('hidden');
  const r = alertResolve;
  alertResolve = null;
  if (r) r(result);
}

// returns true if the user confirmed. Omit cancelText for a plain notice.
function showAlert({ title, message, okText = 'OK', cancelText = null, kind = 'warn' }) {
  const card = alertModal.querySelector('.modal-card');
  card.className = 'modal-card alert-card ' + kind;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-msg').textContent = message;

  const ok = document.getElementById('alert-ok');
  const cancel = document.getElementById('alert-cancel');
  ok.textContent = okText;
  ok.className = 'btn ' + (kind === 'danger' ? 'btn-danger' : 'btn-launch');
  cancel.textContent = cancelText || 'CANCEL';
  cancel.classList.toggle('hidden', !cancelText);

  alertModal.classList.remove('hidden');
  ok.focus();
  return new Promise(res => { alertResolve = res; });
}

document.getElementById('alert-ok').onclick = () => closeAlert(true);
document.getElementById('alert-cancel').onclick = () => closeAlert(false);
alertModal.addEventListener('click', e => { if (e.target === alertModal) closeAlert(false); });

// ============================================================
// SKILL EDITOR — hand-edit SKILL.md or have an agent improve it
// ============================================================
const SKILL_AGENT = '__skill__';
const skillPage = document.getElementById('skill-page');
const skeMsgs = document.getElementById('ske-msgs');
const ske = {
  path: null, runId: null, running: false, bubble: null,
  status(text, cls) {
    const el = document.getElementById('ske-status');
    el.textContent = text || '';
    el.className = 'set-status ' + (cls || '');
  }
};

function skeMsg(role, text) {
  const empty = document.getElementById('ske-empty');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = 'skp-msg ' + role;
  wrap.innerHTML = '<div class="skp-who"></div><div class="skp-bubble"></div>';
  wrap.querySelector('.skp-who').textContent = role === 'user' ? 'YOU' : 'SKILL AGENT';
  wrap.querySelector('.skp-bubble').textContent = text || '';
  skeMsgs.appendChild(wrap);
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
  return wrap.querySelector('.skp-bubble');
}

function skeNote(text) {
  const empty = document.getElementById('ske-empty');
  if (empty) empty.remove();
  const n = document.createElement('div');
  n.className = 'skp-note';
  n.textContent = text;
  skeMsgs.appendChild(n);
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

// stream into the current assistant bubble, creating it on the first token
function skeAssistant(text) {
  if (!ske.bubble || !ske.bubble.isConnected) ske.bubble = skeMsg('assistant', '');
  ske.bubble.textContent += text;
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

// The reply interleaves conversation with the file body between <SKILL_MD>
// markers. Recomputing the visible text from the whole buffer (instead of
// appending chunks) is the only way to keep raw markdown out of the bubble —
// a chunk can straddle a marker boundary.
function skeRenderBubble() {
  if (!ske.bubble) return;
  const b = ske.buffer || '';
  const open = b.indexOf('<SKILL_MD>');
  const close = b.indexOf('</SKILL_MD>');
  let text;
  if (open === -1) {
    text = b;
  } else {
    const pre = b.slice(0, open).trim();
    const post = close === -1 ? '' : b.slice(close + '</SKILL_MD>'.length).trimStart();
    text = pre + (pre && post ? '\n\n' : '') + post;
    if (!text.trim() && close === -1) text = '✍ rewriting the skill file...';
  }
  ske.bubble.textContent = text;
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

async function openSkillEditor(sk) {
  const r = await window.deck.skillRead(sk.path);
  if (!r.ok) { await showAlert({ title: 'CANNOT OPEN', message: r.error, okText: 'CLOSE', kind: 'danger' }); return; }
  ske.path = sk.path;
  ske.bubble = null;
  document.getElementById('ske-title').textContent = '/' + sk.name;
  document.getElementById('ske-path').textContent = sk.path + ' · ' + sk.scope;
  document.getElementById('ske-content').value = r.content;
  skeMsgs.innerHTML = `<div class="skp-empty" id="ske-empty">
    <div class="skp-empty-mark"></div>
    <div>Ask the agent to improve this skill — tighten steps, add checks, restructure...</div></div>`;
  ske.status('');
  skillPage.classList.remove('hidden');
  document.getElementById('ske-chat').focus();
}

async function skeReload() {
  const r = await window.deck.skillRead(ske.path);
  if (r.ok) document.getElementById('ske-content').value = r.content;
}

function skeSetRunning(on) {
  ske.running = on;
  document.getElementById('ske-send').disabled = on;
  document.getElementById('ske-stop').classList.toggle('hidden', !on);
  document.getElementById('ske-save').disabled = on;
}

document.getElementById('ske-save').onclick = async () => {
  const r = await window.deck.skillSave(ske.path, document.getElementById('ske-content').value);
  ske.status(r.ok ? 'saved' : r.error, r.ok ? 'ok' : 'err');
  if (r.ok) loadSettings();
};

async function skeSend() {
  const box = document.getElementById('ske-chat');
  const ask = box.value.trim();
  if (!ask || ske.running || !ske.path) return;
  box.value = '';
  box.style.height = 'auto';
  skeSetRunning(true);
  ske.status('agent working...');
  skeMsg('user', ask);
  ske.bubble = skeMsg('assistant', '');
  ske.bubble.classList.add('thinking');

  // The agent must NOT edit the file itself: Claude Code guards ~/.claude
  // behind a permission prompt this modal can't answer. Instead it returns the
  // full improved file in its reply and the app writes it via skillSave.
  ske.buffer = '';
  ske.runId = uid();
  const current = document.getElementById('ske-content').value;
  await window.deck.runAgent({
    runId: ske.runId, agentId: SKILL_AGENT,
    model: document.getElementById('ske-model').value,
    cwd: ske.path.replace(/[\\/]SKILL\.md$/, ''),
    // no tools are needed (the file travels in the prompt/reply); default mode
    // auto-denies any tool call, so ~/.claude's permission guard never trips
    permissionMode: 'default',
    leanContext: true,   // the whole task travels in the prompt — skip global config
    rules: '',
    prompt: `You are improving a Claude Code skill definition (a SKILL.md file). Do not use any tools — everything you need is below.

CURRENT SKILL.MD:
<<<SKILL
${current}
SKILL>>>

USER REQUEST: ${ask}

Reply with the COMPLETE improved file between <SKILL_MD> and </SKILL_MD> markers, then a 1-2 sentence summary of what you changed. Keep the YAML frontmatter valid: it must retain "name" and a one-line "description" (rewrite the description only if the request affects it).`
  });
}

// pull the improved file out of the agent's reply and write it ourselves
async function skeApplyReply() {
  const m = /<SKILL_MD>\s*\n?([\s\S]*?)\n?\s*<\/SKILL_MD>/.exec(ske.buffer || '');
  if (!m) { ske.status('agent produced no file update', 'err'); return; }
  const r = await window.deck.skillSave(ske.path, m[1].trimEnd() + '\n');
  if (!r.ok) { ske.status('save failed: ' + r.error, 'err'); return; }
  ske.status('improved & saved', 'ok');
  skeNote('✔ SKILL.md updated');
  await skeReload();
  loadSettings();
}

function skillAgentEvent(ev) {
  if (ev.runId !== ske.runId) return;
  switch (ev.kind) {
    case 'text-delta': {
      ske.buffer += ev.text;
      if (ske.bubble) ske.bubble.classList.remove('thinking');
      skeRenderBubble();
      break;
    }
    case 'tool': skeNote('⚙ ' + ev.tool); break;
    case 'result': ske.lastResult = ev.subtype; break;
    case 'error':
      ske.lastResult = 'error';
      ske.status('error: ' + ev.error, 'err');
      skeAssistant('\n⚠ ' + ev.error);
      break;
    case 'aborted': ske.lastResult = 'aborted'; ske.status('stopped', 'err'); break;
    case 'done': {
      skeSetRunning(false);
      if (ske.bubble) {
        ske.bubble.classList.remove('thinking');
        skeRenderBubble();
        // a reply that was only the file body leaves an empty bubble — drop it
        if (!ske.bubble.textContent.trim() || ske.bubble.textContent === '✍ rewriting the skill file...') {
          ske.bubble.closest('.skp-msg').remove();
        }
      }
      if (ske.lastResult === 'success') skeApplyReply();
      ske.bubble = null;
      break;
    }
  }
}

document.getElementById('ske-send').onclick = skeSend;
const skeChat = document.getElementById('ske-chat');
// GPT-style: Enter sends, Shift+Enter is a newline
skeChat.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); skeSend(); }
});
// composer grows with the message, capped by CSS max-height
skeChat.addEventListener('input', () => {
  skeChat.style.height = 'auto';
  skeChat.style.height = skeChat.scrollHeight + 'px';
});
document.getElementById('ske-stop').onclick = () => { if (ske.runId) window.deck.stopAgent(ske.runId); };
document.getElementById('ske-back').onclick = () => {
  if (ske.running && ske.runId) window.deck.stopAgent(ske.runId);
  skillPage.classList.add('hidden');
};

// ============================================================
// SETTINGS — MCP servers, skills, skill creator
// ============================================================
const settingsModal = document.getElementById('settings-modal');

document.querySelectorAll('.set-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.set-tab').forEach(t => t.classList.toggle('active', t === tab));
    for (const pane of ['mcp', 'skills', 'creator']) {
      document.getElementById('set-' + pane).classList.toggle('hidden', pane !== tab.dataset.set);
    }
  };
});

function setRow({ name, sub, chip, chipClass, onDelete, onClick }) {
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `<div class="set-row-body"><div class="set-row-name"></div><div class="set-row-sub"></div></div><span class="set-chip"></span>`;
  row.querySelector('.set-row-name').textContent = name;
  row.querySelector('.set-row-sub').textContent = sub;
  const c = row.querySelector('.set-chip');
  c.textContent = chip;
  if (chipClass) c.classList.add(chipClass);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'Delete skill';
    del.textContent = '✕';
    del.onclick = e => { e.stopPropagation(); onDelete(); };
    row.appendChild(del);
  }
  if (onClick) { row.style.cursor = 'pointer'; row.onclick = onClick; }
  return row;
}

async function loadSettings() {
  loadSlashItems();   // keep the chatbox / menu in sync with skill changes
  window.deck.cliVersion().then(v => {
    document.getElementById('set-meta').textContent = v ? 'Claude Code — ' + v : 'Claude Code CLI not found on PATH';
  });

  const mcpBox = document.getElementById('mcp-list');
  mcpBox.innerHTML = '<div class="set-empty">loading...</div>';
  const servers = await window.deck.mcpList(projectDir || '');
  mcpBox.innerHTML = '';
  if (!servers.length) mcpBox.innerHTML = '<div class="set-empty">No MCP servers configured. Add one with: claude mcp add &lt;name&gt; ...</div>';
  for (const s of servers) {
    mcpBox.appendChild(setRow({
      name: s.name,
      sub: `${s.transport} · ${s.target || '(no target)'}`,
      chip: s.scope, chipClass: s.scope === 'user' ? '' : 'proj'
    }));
  }

  const skBox = document.getElementById('skills-list');
  skBox.innerHTML = '<div class="set-empty">loading...</div>';
  const skills = await window.deck.skillsList(projectDir || '');
  skBox.innerHTML = '';
  if (!skills.length) skBox.innerHTML = '<div class="set-empty">No skills found. Create one in the SKILL CREATOR tab.</div>';
  for (const sk of skills) {
    skBox.appendChild(setRow({
      name: '/' + sk.name,
      sub: sk.description,
      chip: sk.scope, chipClass: sk.scope === 'user' ? '' : 'proj',
      onClick: () => openSkillEditor(sk),
      onDelete: sk.scope === 'user' ? async () => {
        const yes = await showAlert({
          title: 'DELETE SKILL',
          message: `Remove /${sk.name} from this account? The whole skill folder is deleted.`,
          okText: 'DELETE', cancelText: 'KEEP', kind: 'danger'
        });
        if (!yes) return;
        const r = await window.deck.skillDelete(sk.path);
        if (!r.ok) await showAlert({ title: 'DELETE FAILED', message: r.error, okText: 'CLOSE', kind: 'danger' });
        loadSettings();
      } : null
    }));
  }
}

function skStatus(text, cls) {
  const el = document.getElementById('sk-status');
  el.textContent = text;
  el.className = 'set-status ' + (cls || '');
}

document.getElementById('sk-create').onclick = async () => {
  const name = document.getElementById('sk-name').value.trim();
  const description = document.getElementById('sk-desc').value.trim();
  const instructions = document.getElementById('sk-body').value.trim();
  if (!name || !description || !instructions) { skStatus('name, description and instructions are all required', 'err'); return; }
  skStatus('creating...');
  const r = await window.deck.skillCreate({ name, description, instructions });
  if (!r.ok) { skStatus(r.error, 'err'); return; }
  skStatus(`created /${r.slug} — live for all agents`, 'ok');
  for (const id of ['sk-name', 'sk-desc', 'sk-body']) document.getElementById(id).value = '';
  loadSettings();
};

document.getElementById('btn-settings').onclick = () => { settingsModal.classList.remove('hidden'); loadSettings(); };
document.getElementById('set-close').onclick = () => settingsModal.classList.add('hidden');
document.getElementById('set-refresh').onclick = loadSettings;
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// ============================================================
// THEME — dark / light
// ============================================================
let theme = localStorage.getItem('theme') || 'dark';

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  // in dark mode show the sun (what you'd switch to), in light the moon
  document.getElementById('theme-sun').classList.toggle('hidden', theme !== 'dark');
  document.getElementById('theme-moon').classList.toggle('hidden', theme === 'dark');
  document.getElementById('btn-theme').title = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
  for (const t of termTabs) t.xterm.options.theme = termTheme();
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = n => css.getPropertyValue(n).trim();
  return {
    background: v('--editor-bg'), foreground: v('--editor-fg'),
    cursor: v('--fg'), selectionBackground: v('--editor-sel')
  };
}

// shiki has a matching light theme; open files are re-tokenised on switch
function shikiTheme() { return theme === 'dark' ? 'dark-plus' : 'light-plus'; }

async function rehighlightOpenFiles() {
  for (const f of openFiles) {
    const r = await window.deck.fsHighlight(f.value, f.lang, shikiTheme());
    if (!r.ok) continue;
    f.html = shikiInner(r.html);
    if (f.path === activeFile) paintCode(f);
  }
}

document.getElementById('btn-theme').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme();
  rehighlightOpenFiles();
};

// ============================================================
// SIDEBAR TABS — AGENT / EXPLORER
// ============================================================
document.querySelectorAll('.side-tab').forEach(tab => {
  tab.onclick = () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.side-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('tab-agent').classList.toggle('hidden', which !== 'agent');
    document.getElementById('tab-explorer').classList.toggle('hidden', which !== 'explorer');
    if (which === 'explorer' && !exLoaded) exLoad();
  };
});

// ============================================================
// EXPLORER — read-only project tree
// ============================================================
const exTree = document.getElementById('ex-tree');
let exLoaded = false;

async function exRenderDir(dir, container) {
  const r = await window.deck.fsList(projectDir, dir);
  container.innerHTML = '';
  if (!r.ok) { container.innerHTML = `<div class="ex-msg">${esc(r.error)}</div>`; return; }
  if (!r.items.length) { container.innerHTML = '<div class="ex-msg">(empty)</div>'; return; }

  for (const item of r.items) {
    const row = document.createElement('div');
    row.className = 'ex-row ' + (item.dir ? 'is-dir' : 'is-file');
    row.title = item.path;
    row.innerHTML = `<span class="ex-caret">${item.dir ? '▸' : ''}</span><span class="ex-ico">${item.dir ? '🗀' : '📄'}</span><span class="ex-name"></span>`;
    row.querySelector('.ex-name').textContent = item.name;
    container.appendChild(row);

    if (item.dir) {
      const kids = document.createElement('div');
      kids.className = 'ex-children hidden';
      container.appendChild(kids);
      row.onclick = async () => {
        const collapsed = kids.classList.toggle('hidden');
        row.querySelector('.ex-caret').textContent = collapsed ? '▸' : '▾';
        row.querySelector('.ex-ico').textContent = collapsed ? '🗀' : '🗁';
        // children load on first expand — keeps big trees (node_modules) cheap
        if (!collapsed && !kids.dataset.loaded) {
          kids.dataset.loaded = '1';
          kids.innerHTML = '<div class="ex-msg">loading...</div>';
          await exRenderDir(item.path, kids);
        }
      };
    } else {
      row.dataset.file = item.path;
      row.onclick = () => openFile(item.path);
    }
  }
  markOpenRows();
}

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

document.getElementById('ex-refresh').onclick = exLoad;
document.getElementById('ex-filter').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  exTree.querySelectorAll('.ex-row.is-file').forEach(r => {
    const name = r.querySelector('.ex-name').textContent.toLowerCase();
    r.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
};

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
  renderViewer();
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
