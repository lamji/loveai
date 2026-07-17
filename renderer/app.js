// ============================================================
// LoveAi — central console renderer + auto pipeline
// ============================================================

// CONTEXT DISCIPLINE — appended to every pipeline agent's rules. One shared,
// static block (prompt-cache friendly) that enforces token-lean tool use.
const DISCIPLINE = `
CONTEXT DISCIPLINE (binding):
- Grep/Glob first; Read only files you must change or verify, with offset/limit for big files. Never re-read an unchanged file; never survey the repo.
- If .loveai/index/PROJECT-MAP.md exists, trust it for orientation instead of exploring.
- No speculative web searches. Don't paste back full file contents or dump large code blocks.
- CODE STYLE: keep lines SHORT and readable — no long lines (aim <= ~100 chars). Break long statements across lines, pull complex expressions into named variables, and extract helpers instead of writing one giant line/function. Match the file's existing formatting.
- DO THE WORK YOURSELF. Never delegate via the Task/Agent tool and never invoke the project's own subagents (its .claude/agents) — you ARE the engineer for this pipeline.
- Keep the reply focused, but ALWAYS explain your reasoning and decisions clearly — state what you did, what you found, and WHY. The operator reads this reply; never go silent or reply with just a status word.`;

const RULES = {
  prompt: `You are the PROMPT ENGINEER of a pipeline (you -> Senior Engineer(s) -> Reviewer). Operator gives an ISSUE; you never code fixes.

JOB:
1. Locate the exact files/functions/root cause (map-first, minimal reads).
2. Write executable task file(s) to .loveai/pipeline/task-<NN>-<slug>.md (create folder if missing). Each MUST start with exactly:
COMPLEXITY: low | medium | high
MODEL: claude-haiku-4-5-20251001 (low) | claude-sonnet-5 (medium) | claude-opus-4-8 (high)
Rate honestly: mechanical=low, typical=medium, architecture/concurrency/security=high.
Then: CONTEXT (issue, root cause, relevant architecture + the PROJECT-MAP excerpt so engineers need zero exploration — terse, standalone), SCOPE (TO-DO checklist with exact file paths + explicit OUT-OF-SCOPE), ACCEPTANCE CRITERIA (commands, expected behavior).
3. Split into 2-4 zero-file-overlap task files only when parallelizable; else one file.
4. Also write .loveai/pipeline/review-brief.md — FIRST LINE "REVIEW-MODEL: claude-sonnet-5" (opus only if high-risk); then context, expected changed files, regression risks.
5. Reply with a short summary of files created.

Never modify source code; write only inside .loveai/pipeline/.

PLAN MODE: when asked only to PLAN, end your reply with exactly:
IMPLEMENT-MODEL: claude-haiku-4-5-20251001 | claude-sonnet-5 | claude-opus-4-8
(one value, rating overall implementation complexity honestly)${DISCIPLINE}`,

  senior: `You are a SENIOR ENGINEER in a pipeline (Prompt Engineer -> you -> Reviewer).

JOB:
1. "execute task-NN-..." → read that file in .loveai/pipeline/ and follow it LITERALLY. Its CONTEXT is complete — do not re-explore.
2. NO OVERSCOPING: touch only SCOPE files. Problems outside scope go in your final summary, not in code.
3. Do the TO-DO in order; verify ACCEPTANCE CRITERIA before finishing.
4. Append to .loveai/pipeline/changes-log.md: task file, files changed, how verified.
5. "fix review findings" → read review-findings.md, fix ONLY findings for your files, update changes-log.md.
6. If the task file is ambiguous or forces overscoping, stop and report instead of guessing.
7. If you change a file's responsibility, update its PROJECT-MAP.md section.${DISCIPLINE}`,

  indexer: `You are the PROJECT INDEXER. Read the codebase (skip node_modules, dist, .git, .loveai) and write .loveai/index/PROJECT-MAP.md: purpose, tech stack, architecture, module map with EXACT paths + each file's responsibilities/key symbols, data flow, entry points, conventions. Max ~400 lines. Given a changed-file list, update ONLY affected sections in place. Never modify source; write only inside .loveai/index/.${DISCIPLINE}`,

  uiux: `You are the UI/UX SENIOR ENGINEER — the design authority for all interface work.

DESIGN AUTHORITY — you decide and enforce:
- Modern UI patterns: clean spacing scale (4/8px grid), clear hierarchy, purposeful motion, responsive layout.
- Theming: design tokens / CSS variables only — never hardcoded colors; both light+dark unless the app is single-theme; consistent radii/shadows.
- Typography: one type scale (e.g. 12/14/16/20/24), max 2 font families, proper weights/line-heights; readable contrast (WCAG AA).
- Components: consistent buttons/inputs/dialogs with hover, focus-visible, disabled and loading states; shadcn/ui when the project is React and uses it.
- Accessibility: keyboard nav, focus states, aria labels on icon-only buttons.

CODE RULES (strict):
- MVVM strictly: views render only (no logic); viewmodels/hooks hold logic (no UI); models pure. Match the project's existing structure.
- NO LONG CODE: functions <= ~40 lines, components/files <= ~250 lines, lines <= 120 chars — split into smaller components/helpers instead.
- Reuse existing components/tokens before creating new ones; delete dead styles you replace.

PIPELINE CONTRACT (same as Senior Engineer): "execute task-NN-..." → read the file in .loveai/pipeline/, follow it literally, no overscoping, append to changes-log.md when done; "fix review findings" → fix only your findings. If a request lacks design direction, choose the modern option and state your choice in one line.${DISCIPLINE}`,

  reviewer: `You are the REVIEWER, final gate of the pipeline.

JOB:
1. Read .loveai/pipeline/review-brief.md + changes-log.md. Write your validation plan to .loveai/pipeline/validation-plan.md first.
2. Review ONLY changed files + their direct callers for: correctness bugs/regressions (edge cases, null handling, async races, broken contracts), MVVM violations (views: no logic; viewmodels: no UI; models pure), dead code/unused imports, oversized additions (fn >~50 lines / file >~300), and scope compliance (out-of-SCOPE change = automatic finding).
3. Write .loveai/pipeline/review-findings.md — FIRST LINE exactly "VERDICT: REJECTED" or "VERDICT: APPROVED". REJECTED: each finding as file, line, problem, required fix, owning task file. APPROVED: one short validation summary.
   - HONOR JUSTIFICATIONS: if changes-log.md justifies a prior finding as a FALSE POSITIVE, verify it against the code — if the justification is correct, ACCEPT it and do NOT re-raise that finding. Only keep REJECTED for findings that are REAL and still unaddressed. Do not loop on issues that are fixed or legitimately dismissed.
4. Never fix code yourself. You may run builds/tests to validate.
5. IN YOUR CHAT REPLY (not only the file): narrate what you validated (files/checks/tests run), then state the VERDICT. If REJECTED, list each finding with a one-line reason WHY it fails — the operator must understand the decision from your reply alone, without opening the file. Never reply with just "REJECTED"/"APPROVED".${DISCIPLINE}`
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
  { id: 'def-uiux-eng', name: 'UIUX-ENGINEER', role: 'uiux', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.uiux },
  { id: 'def-reviewer-eng', name: 'REVIEWER-ENGINEER', role: 'reviewer', model: 'claude-opus-4-8', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.reviewer },
  // no rules — free-form helper for general tasks (fix git issues, merge conflicts, quick questions...)
  { id: 'def-general', name: 'GENERAL-OPS', role: 'custom', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: false, cwd: '', rules: '' }
];

const ROLE_ICON = { prompt: '🧠', senior: '🛠', uiux: '🎨', reviewer: '🔍', custom: '⬡', indexer: '🗺' };
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
  if (a.lean === undefined) a.lean = ['prompt', 'senior', 'uiux', 'reviewer', 'indexer'].includes(a.role);
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
const runDoneCallbacks = {};  // runId -> one-shot (result, finalText) callback
const runEventSinks = {};     // runId -> per-event sink (streams a run into a modal)

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

const ROLE_LABEL = { prompt: 'PROMPT ENGINEER', senior: 'SENIOR ENGINEER', uiux: 'UI/UX ENGINEER', reviewer: 'REVIEWER', custom: 'OPERATIVE', indexer: 'INDEXER' };

function renderRoster() {
  const roster = document.getElementById('roster');
  roster.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'roster-card' + (R(a.id).running ? ' running' : '');
    const running = R(a.id).running;
    // the 5 built-in def-* agents are permanent — no remove button for them
    const isDefault = String(a.id).startsWith('def-');
    el.innerHTML = `
      <div class="rc-actions">
        <button class="icon-btn" data-act="stop" title="Stop" ${running ? '' : 'style="display:none"'}>■</button>
        <button class="icon-btn" data-act="edit" title="Configure">⚙</button>
        ${isDefault ? '' : '<button class="icon-btn" data-act="del" title="Remove">✕</button>'}
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
    const delBtn = el.querySelector('[data-act="del"]');
    if (delBtn) delBtn.onclick = (e) => {
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
  // UI-related plans hand off to the UI/UX engineer instead of a generic senior
  const planText = R(plannerId).lastText || '';
  const senior = (isUiTask(planText) && uiuxAgent()) || byRole('senior')[0];
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
    if (routeModel) opts.model = learnedModel(routeModel);
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
  if (routeModel) opts.model = learnedModel(routeModel);
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
  renderConsoleChips();
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
  // optional one-shot completion callback, fired with (result, finalText) on done
  if (opts.onDone) runDoneCallbacks[r.runId] = opts.onDone;
  if (opts.onEvent) runEventSinks[r.runId] = opts.onEvent;
  r.startedAt = Date.now();
  r.lastText = '';
  r.curModel = model;   // for the background learner
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
  // LEXICAL RETRIEVAL: pre-rank the files most likely involved (symbol + BM25)
  // and hand them to the Prompt Engineer so it reads a few instead of grepping
  // the whole repo. Cheap local call, no LLM, big latency win.
  if ((a.role === 'prompt' || a.role === 'custom') && cwd) {
    try {
      // top 12 ranked; full CONTENT for the top 5 so the agent barely needs to Read
      const r = await window.deck.retrieveContext(cwd, prompt, 12, 5);
      if (r.ok && r.files && r.files.length) {
        // 1) repo map for instant orientation (no exploring the tree)
        if (r.repoMap) {
          fullPrompt += `\n\nREPO MAP (directories by file count + notable files — use this for orientation instead of exploring):\n${r.repoMap}`;
        }
        // 2) ranked candidate files for this specific issue
        const lines = r.files
          .map(f => `- ${f.rel}${f.symbols && f.symbols.length ? ' — ' + f.symbols.slice(0, 8).join(', ') : ''}`)
          .join('\n');
        fullPrompt += `\n\nPRE-RANKED RELEVANT FILES (lexical match on the issue):\n${lines}`;
        // 3) inline the actual code of the top files (front-loaded context)
        let budget = 16000;
        const blocks = [];
        for (const f of r.files) {
          if (budget <= 0 || !f.content) continue;
          const chunk = f.content.slice(0, budget);
          budget -= chunk.length;
          blocks.push(`\n===== ${f.rel} =====\n${chunk}`);
        }
        if (blocks.length) {
          fullPrompt += `\n\nTOP FILE CONTENTS (already loaded — read here, do NOT re-open with Read):\n${blocks.join('\n')}`;
        }
        // 4) firm directive so it trusts the above and stops exploring
        fullPrompt += `\n\nEFFICIENCY: The repo map + ranked files + inlined contents above ARE your context. Do AT MOST 2-3 extra targeted reads/greps only if something specific is missing. Do not survey the tree, do not re-read the inlined files, and go straight to producing the output.`;
      }
    } catch {}
  }

  await window.deck.runAgent({
    runId: r.runId, agentId, prompt: fullPrompt,
    model, cwd, rules: effectiveRules(a),
    permissionMode: plan ? 'plan' : a.perm,
    leanContext: !!a.lean,
    // pipeline agents must do the work THEMSELVES — never delegate to the
    // project's own .claude/agents subagents (that loops and ignores our roster)
    noSubagents: ['prompt', 'senior', 'uiux', 'reviewer', 'indexer'].includes(a.role),
    maxTurns: learnedMaxTurns(a.role),
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

  // mirror this run's events into a modal, if one registered a sink for it
  if (runEventSinks[ev.runId]) { try { runEventSinks[ev.runId](ev); } catch {} }

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
      // background learner: outcome per model + turn-cap kills per role
      learnMark(r.curModel, ev.subtype !== 'success');
      if (/max_turns/i.test(ev.subtype || '') && doneAgent) {
        LEARN.turnCapHits[doneAgent.role] = (LEARN.turnCapHits[doneAgent.role] || 0) + 1;
        saveLearn();
        plog('info', `learning: ${doneAgent.name} hit its turn ceiling — raising ${doneAgent.role} cap to ${learnedMaxTurns(doneAgent.role)} next run.`);
      }
      lastRunMeta[ev.agentId] = { model: r.curModel, at: Date.now() };
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
      // fire any one-shot completion callback registered for this run
      if (runDoneCallbacks[ev.runId]) {
        const cb = runDoneCallbacks[ev.runId];
        delete runDoneCallbacks[ev.runId];
        try { cb(r.lastResult, r.lastText || ''); } catch {}
      }
      delete runEventSinks[ev.runId];
      if (typeof gitRefresh === 'function' && gitRepo) gitRefresh();
      // a MANUAL Prompt Engineer run (outside the pipeline) that produced task
      // files → offer to deploy engineers, so the work doesn't just stop
      if (!pipe.active && r.lastResult === 'success') {
        const da = agents.find(x => x.id === ev.agentId);
        if (da && da.role === 'prompt' && da.cwd) maybeOfferDeploy(da.cwd);
      }
      onPipelineAgentDone(ev.agentId, r.lastResult)
        .then(() => { if (!pipe.active) cleanupSeniors(); });
      break;
  }
});

// ============================================================
// AUTO PIPELINE ORCHESTRATOR
// prompt -> PLAN REVIEW (operator gate) -> build -> review -> loop
// ============================================================
const pipe = { active: false, stage: null, cwd: '', iteration: 0, maxIter: 5, pending: new Set(), taskAssign: new Map(), planTasks: [], taskModels: new Map(), reviewModel: null };

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

// Read the task files in .loveai/pipeline/, route each to an agent, and start the
// BUILD → REVIEW stages. Used both by the plan-approval gate AND when a manual
// (non-pipeline) Prompt Engineer run leaves task files that need executing.
async function deployEngineersFromDir() {
  pipe.taskModels.clear();
  pipe.reviewModel = null;
  const uiTasks = new Set();
  const files = await window.deck.pipelineRead(pipe.cwd);
  for (const f of files) {
    if (/^task-\d+.*\.md$/i.test(f.name)) {
      const m = parseModelLine(f.content);
      if (m) pipe.taskModels.set(f.name, m);
      if (isUiTask(f.name + ' ' + f.content.slice(0, 2000))) uiTasks.add(f.name);
    } else if (f.name === 'review-brief.md') {
      pipe.reviewModel = parseModelLine(f.content, 'REVIEW-MODEL');
    }
  }
  const tasks = pipe.planTasks.slice(0, 4);
  const ui = uiuxAgent();
  const uiAssigned = ui ? tasks.filter(t => uiTasks.has(t)) : [];
  const genTasks = tasks.filter(t => !uiAssigned.includes(t));
  const n = Math.min(Math.max(genTasks.length, 1), 4);
  plog('ok', `deploying ${genTasks.length ? n + ' senior(s)' : 'engineers'}${uiAssigned.length ? ' + UI/UX engineer' : ''}...`);
  const seniors = genTasks.length ? ensureSeniors(Math.min(genTasks.length, 4)) : [];
  pipe.taskAssign.clear();
  genTasks.forEach((t, i) => pipe.taskAssign.set(seniors[i % seniors.length].id, t));
  uiAssigned.forEach((t, i) => {
    if (i === 0) { if (!ui.cwd) { ui.cwd = pipe.cwd; save(); } pipe.taskAssign.set(ui.id, t); plog('info', `${t} ▸ routed to ${ui.name} (UI task)`); }
    else if (seniors.length) pipe.taskAssign.set(seniors[i % seniors.length].id, t);
    else { const s = ensureSeniors(1); pipe.taskAssign.set(s[0].id, t); }
  });
  plog('info', 'Stage 3: BUILD — engineers executing in parallel...');
  startBuild('execute');
}

document.getElementById('pr-approve').onclick = async () => {
  if (!pipe.active || pipe.stage !== 'plan') return;
  hidePlanReview();
  closePlanCard('approved — passed to engineers');
  await deployEngineersFromDir();
};

// A manual Prompt Engineer run left task files but there's no live pipeline to run
// them — offer a one-click deploy so the work doesn't just stop.
async function maybeOfferDeploy(cwd) {
  if (pipe.active) return;
  let scan; try { scan = await window.deck.pipelineScan(cwd); } catch { return; }
  if (!scan || !scan.tasks || !scan.tasks.length) return;
  feedDeployCard(cwd, scan.tasks);
}

function feedDeployCard(cwd, taskNames) {
  hideFeedEmpty();
  const el = document.createElement('button');
  el.className = 'plan-result';
  el.innerHTML = `<div class="pl-head">🚀 TASK FILES READY <span class="pl-open">▶ DEPLOY ENGINEERS</span></div>
    <div class="pl-summary"></div><div class="pl-meta"></div>`;
  el.querySelector('.pl-summary').textContent = taskNames.join(', ');
  el.querySelector('.pl-meta').textContent = `${taskNames.length} task file(s) — click to build + review with your roster`;
  el.onclick = async () => {
    if (pipe.active) { plog('err', 'a pipeline is already running.'); return; }
    el.classList.add('done');
    el.querySelector('.pl-meta').textContent = 'deploying…';
    pipe.active = true; pipe.cwd = cwd; pipe.iteration = 0;
    document.getElementById('btn-pipeline-stop').classList.remove('hidden');
    pipe.planTasks = taskNames;
    await deployEngineersFromDir();
  };
  consoleFeed.appendChild(el);
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

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
    const model = learnedModel(pipe.taskModels.get(taskFile));   // learner may bump an unreliable model
    const a = agents.find(x => x.id === agentId);
    if (model) plog('info', `${a ? a.name : agentId} ▸ ${taskFile} on ${MODEL_LABELS[model]} (complexity-routed)`);
    runAgent(agentId, prompt, false, false, { model, fresh: true });
  }
}

// FIX ROUND — on a rejection, assign ALL findings to a SINGLE owner so nothing
// falls through the "not my task file" gap. UI findings go to the UI/UX engineer;
// everything else to a senior. The fixer must fix every finding or justify false
// positives in changes-log.md for the Reviewer to verify — no silent "not mine".
// short capability line per role — helps the AI router pick the right engineer
const ROLE_CAP = {
  senior: 'backend, APIs, database, server logic, general full-stack implementation',
  uiux: 'front-end UI/UX: components, styling, layout, typography, React/Vue/Angular, design systems, accessibility',
  custom: 'free-form general engineering across the stack',
  prompt: 'planning/analysis (last resort as an implementer)'
};

// DYNAMIC ROUTING: an AI (cheap Haiku) reads the findings and the actual roster,
// then names the best engineer to implement the fixes. No brittle keyword regex —
// it reasons about the work, and adapts to whatever agents are on the roster.
async function pickFixerByAI(findings) {
  const candidates = agents.filter(a => ['senior', 'uiux', 'custom'].includes(a.role));
  if (candidates.length <= 1) return candidates[0] || byRole('senior')[0] || uiuxAgent();
  const roster = candidates.map(a => `- ${a.name} [${a.role}]: ${ROLE_CAP[a.role] || 'general engineering'}`).join('\n');
  const prompt = `Route this code-review rejection to the SINGLE best engineer to IMPLEMENT the fixes. Judge by what the findings actually require (front-end vs backend vs mixed).

ENGINEERS:
${roster}

REVIEW FINDINGS:
${String(findings).slice(0, 7000)}

Reply with ONLY the exact engineer name from the list above — one line, nothing else.`;
  try {
    const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', pipe.cwd);
    if (r.ok && r.text) {
      const name = r.text.trim().split('\n')[0].replace(/["'`.*_]/g, '').trim().toLowerCase();
      const hit = candidates.find(a => a.name.toLowerCase() === name)
        || candidates.find(a => name.includes(a.name.toLowerCase()))
        || candidates.find(a => name.includes(a.role));
      if (hit) return hit;
    }
  } catch {}
  return byRole('senior')[0] || candidates[0] || uiuxAgent();   // safe fallback
}

async function startFixRound() {
  setStage('build');
  const files = await window.deck.pipelineRead(pipe.cwd);
  const findings = (files.find(f => f.name === 'review-findings.md') || {}).content || '';
  const fixer = await pickFixerByAI(findings);
  if (!fixer) { abortPipeline('no engineer available to fix findings — halted.'); return; }
  if (!fixer.cwd) { fixer.cwd = pipe.cwd; save(); }
  pipe.pending = new Set([fixer.id]);
  pipe.taskAssign = new Map([[fixer.id, 'review-findings.md']]);   // so onDone counts it
  plog('err', `REJECTED — fix round ${pipe.iteration}: AI routed ALL findings to ${fixer.name} (${ROLE_LABEL[fixer.role] || fixer.role}).`);
  const prompt = `The Reviewer REJECTED this work. Read .loveai/pipeline/review-findings.md AND the original task file(s) in .loveai/pipeline/, then COMPLETE the feature so every finding is resolved and every acceptance criterion is met. You own ALL findings this round — do NOT skip any because it "belongs to another task".

IMPORTANT: findings that say a file is "untouched", a component/prop/filter/badge is "missing", or a criterion "doesn't exist" mean that work was NEVER DONE — you must IMPLEMENT it now (edit the real component/source files named in the findings; create code where it's missing). Do not just tweak what already changed.

For each finding: implement the fix in the actual files, OR — only if you are certain it is a FALSE POSITIVE — leave it and write an evidence-backed justification in changes-log.md. Then append everything you did to .loveai/pipeline/changes-log.md. Verify against the acceptance criteria before finishing.`;
  runAgent(fixer.id, prompt, false, false, { fresh: true });
}

// the Prompt Engineer is supposed to write review-brief.md. If a run skipped it
// (e.g. a manual/partial plan), synthesize a fallback so the Reviewer always has
// proper scope instead of guessing from a lone task file.
async function ensureReviewBrief(cwd) {
  const files = await window.deck.pipelineRead(cwd);
  if (files.some(f => f.name === 'review-brief.md')) return;
  const tasks = files.filter(f => /^task-\d+.*\.md$/i.test(f.name));
  const changes = (files.find(f => f.name === 'changes-log.md') || {}).content || '';
  const model = pipe.reviewModel || 'claude-sonnet-5';
  const scope = tasks.map(t => {
    const ctx = (t.content.match(/SCOPE[\s\S]{0,600}/i) || [t.content.slice(0, 400)])[0];
    return `### ${t.name}\n${ctx.trim()}`;
  }).join('\n\n');
  const body =
`REVIEW-MODEL: ${model}

(Auto-generated fallback — the Prompt Engineer did not write a review-brief.)

CONTEXT: Review the work implemented for the task file(s) below. Validate every file listed in changes-log.md plus its direct callers, against each task file's SCOPE and ACCEPTANCE CRITERIA. Any change outside a task's SCOPE is a finding.

TASK SCOPE(S):
${scope || '(no task files found)'}

CHANGES LOG (what the engineers did):
${changes.slice(0, 4000) || '(changes-log.md not found — infer from git diff)'}
`;
  await window.deck.pipelineWrite(cwd, 'review-brief.md', body);
  plog('info', 'no review-brief.md found — generated a fallback brief for the Reviewer.');
  if (!pipe.reviewModel) pipe.reviewModel = model;
}

async function startReview() {
  setStage('review');
  const rv = byRole('reviewer')[0];
  if (!rv) { abortPipeline('no Reviewer agent on roster.'); return; }
  if (!rv.cwd) { rv.cwd = pipe.cwd; save(); }
  await ensureReviewBrief(pipe.cwd);   // guarantee the Reviewer has a brief
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

  if (pipe.stage === 'build' && (a.role === 'senior' || a.role === 'uiux')) {
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
        // learner: a rejection counts against the model that produced each task
        for (const [, taskFile] of pipe.taskAssign) learnMark(pipe.taskModels.get(taskFile), true);
        await startFixRound();   // reassign ALL findings to the right agent (UI/UX for UI)
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
  for (const boxId of ['attach-chips', 'cm-attach', 'cx-attach', 'ad-attach']) {
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

// ===== Slash menu — /skills and /commands, CLI style (reusable per textarea) =====
const chatInput = document.getElementById('chat-input');
let slashItems = [];      // { name, description, type, scope, path }

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

function setupSlash(textarea, menu) {
  let matches = [], sel = 0;
  const query = () => {
    const v = textarea.value;
    const m = /^\/([\w-]*)$/.exec(v.slice(0, textarea.selectionStart));
    return v.startsWith('/') && m ? m[1] : null;
  };
  const hide = () => { menu.classList.add('hidden'); matches = []; };
  function render() {
    const q = query();
    if (q === null || !slashItems.length) { hide(); return; }
    matches = slashItems.filter(i => i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
    if (!matches.length) { hide(); return; }
    sel = Math.min(sel, matches.length - 1);
    menu.innerHTML = '';
    matches.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'slash-item' + (i === sel ? ' sel' : '');
      row.innerHTML = '<span class="slash-name"></span><span class="slash-desc"></span><span class="slash-kind"></span>';
      row.querySelector('.slash-name').textContent = '/' + it.name;
      row.querySelector('.slash-desc').textContent = it.description || '';
      row.querySelector('.slash-kind').textContent = it.type === 'skill' ? 'SKILL·' + it.scope : 'CMD·' + it.scope;
      row.onmousedown = e => { e.preventDefault(); pick(i); };
      row.onmouseenter = () => { sel = i; render(); };
      menu.appendChild(row);
    });
    const foot = document.createElement('div');
    foot.className = 'slash-foot'; foot.textContent = '↑↓ navigate · Tab/Enter select · Esc close';
    menu.appendChild(foot);
    menu.classList.remove('hidden');
    anchorMenu(menu, textarea);
    const s = menu.querySelector('.slash-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const it = matches[i]; if (!it) return;
    textarea.value = '/' + it.name + ' ' + textarea.value.replace(/^\/[\w-]*\s*/, '');
    const pos = it.name.length + 2; textarea.setSelectionRange(pos, pos); hide(); textarea.focus();
  }
  textarea.addEventListener('input', () => { sel = 0; render(); });
  textarea.addEventListener('blur', () => setTimeout(hide, 150));
  textarea.addEventListener('keydown', e => {
    if (menu.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
  });
}
setupSlash(chatInput, document.getElementById('slash-menu'));

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
    // background learner: manual UI/UX sends grow the UI vocabulary; a quick
    // corrective follow-up counts against the model of the previous run
    const tAgent = agents.find(x => x.id === target);
    if (tAgent && tAgent.role === 'uiux') learnUiWords(text);
    learnMaybeCorrection(target, text);
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

// ===== @ file navigator — browse folders → files, arrow keys + Enter =====
// Attaches to a textarea + a menu element. The path lives in the "@token" text,
// so typing filters and Enter descends folders until you pick a file.
// place a dropdown relative to a textarea: for a SHORT input, above it; for a
// TALL textarea, overlay just under its top edge growing down (so it never spills
// off the top of the container, which is what made it cramped in the wide modal).
function anchorMenu(menu, textarea) {
  const box = menu.offsetParent || textarea.parentElement;
  if (!box || !box.contains(textarea)) return;
  if (textarea.offsetHeight > 160) {
    menu.style.top = (textarea.offsetTop + 4) + 'px';
    menu.style.bottom = 'auto';
    menu.style.maxHeight = Math.min(300, textarea.offsetHeight - 20) + 'px';
  } else {
    menu.style.bottom = (box.clientHeight - textarea.offsetTop + 6) + 'px';
    menu.style.top = 'auto';
    menu.style.maxHeight = '';
  }
}

function setupMention(textarea, menu) {
  let items = [], sel = 0, tokenStart = -1, open = false;

  function tokenBeforeCaret() {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);   // @ then non-space path
    return m ? { start: textarea.selectionStart - m[2].length - 1, rel: m[2] } : null;
  }
  function hide() { open = false; menu.classList.add('hidden'); }
  function positionMenu() { anchorMenu(menu, textarea); }

  async function refresh() {
    const tok = tokenBeforeCaret();
    if (!tok) { hide(); return; }
    const root = projectDir || gitRepo;
    if (!root) {
      menu.innerHTML = '<div class="mention-head">import a project first (AGENT tab → ⇩ IMPORT)</div>';
      open = true; menu.classList.remove('hidden'); positionMenu();
      return;
    }
    const slash = tok.rel.lastIndexOf('/');
    const dirRel = slash >= 0 ? tok.rel.slice(0, slash) : '';
    const query = (slash >= 0 ? tok.rel.slice(slash + 1) : tok.rel).toLowerCase();
    const dir = dirRel ? joinPath(root, dirRel) : root;
    const r = await window.deck.fsList(root, dir);
    if (!r.ok) { menu.innerHTML = `<div class="mention-head">${esc(r.error || 'cannot list folder')}</div>`; open = true; menu.classList.remove('hidden'); positionMenu(); return; }
    let list = r.items.filter(i => i.name !== 'node_modules' && !(i.name.startsWith('.') && i.name !== '.github'));
    if (query) list = list.filter(i => i.name.toLowerCase().includes(query));
    list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    items = [];
    if (dirRel) items.push({ up: true, name: '.. (up)', dir: true });
    items.push(...list.slice(0, 80));
    tokenStart = tok.start; sel = 0; open = true;
    render(dirRel);
  }

  function render(dirRel) {
    if (!items.length) { hide(); return; }
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'mention-head';
    head.textContent = '📂 ' + (dirRel ? '/' + dirRel : '(project root)');
    menu.appendChild(head);
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'mention-item' + (i === sel ? ' sel' : '');
      row.innerHTML = `<span class="mi-ico">${it.up ? '↑' : it.dir ? '📁' : '📄'}</span><span class="mi-name"></span>${it.dir && !it.up ? '<span class="mi-arrow">›</span>' : ''}`;
      row.querySelector('.mi-name').textContent = it.name;
      row.onmousedown = (e) => { e.preventDefault(); sel = i; activate(dirRel); };
      row.onmouseenter = () => { sel = i; [...menu.querySelectorAll('.mention-item')].forEach((r2, j) => r2.classList.toggle('sel', j === sel)); };
      menu.appendChild(row);
    });
    const foot = document.createElement('div');
    foot.className = 'mention-foot';
    foot.textContent = '↑↓ move · Enter open/pick · Esc close';
    menu.appendChild(foot);
    menu.classList.remove('hidden');
    positionMenu();
    const s = menu.querySelector('.mention-item.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }

  function setToken(newRel, close) {
    const v = textarea.value;
    const after = v.slice(textarea.selectionStart);
    textarea.value = v.slice(0, tokenStart) + '@' + newRel + (close ? ' ' : '') + after;
    const caret = tokenStart + 1 + newRel.length + (close ? 1 : 0);
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
    if (close) hide(); else refresh();
  }
  function activate(dirRel) {
    const it = items[sel]; if (!it) return;
    const base = dirRel ? dirRel + '/' : '';
    if (it.up) { const parent = dirRel.split('/').slice(0, -1).join('/'); setToken(parent ? parent + '/' : '', false); }
    else if (it.dir) setToken(base + it.name + '/', false);
    else setToken(base + it.name, true);
  }

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; render(currentDirRel()); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; render(currentDirRel()); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); activate(currentDirRel()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
  }, true);
  textarea.addEventListener('blur', () => setTimeout(hide, 150));
  function currentDirRel() {
    const tok = tokenBeforeCaret(); if (!tok) return '';
    const slash = tok.rel.lastIndexOf('/'); return slash >= 0 ? tok.rel.slice(0, slash) : '';
  }
}
setupMention(document.getElementById('chat-input'), document.getElementById('chat-mention'));

// ===== Themed tooltips — hijack native `title` so hints match the theme =====
const ttip = document.createElement('div');
ttip.id = 'ttip'; ttip.className = 'hidden';
document.body.appendChild(ttip);
let ttipTimer = null;
function showTtip(el) {
  const text = el.getAttribute('data-tip');
  if (!text) return;
  ttip.textContent = text;
  ttip.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  ttip.style.left = '0px'; ttip.style.top = '0px';   // measure first
  const tw = ttip.offsetWidth, th = ttip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = r.bottom + 8;
  if (top + th > window.innerHeight - 8) top = r.top - th - 8;   // flip above near edges
  ttip.style.left = left + 'px';
  ttip.style.top = Math.max(8, top) + 'px';
  requestAnimationFrame(() => ttip.classList.add('show'));
}
function hideTtip() { ttip.classList.remove('show'); ttip.classList.add('hidden'); }
document.addEventListener('mouseover', (e) => {
  // migrate any native title to data-tip once, so the OS tooltip never shows
  const t = e.target.closest && e.target.closest('[title]');
  if (t) { t.setAttribute('data-tip', t.getAttribute('title')); t.removeAttribute('title'); }
  const el = e.target.closest && e.target.closest('[data-tip]');
  clearTimeout(ttipTimer);
  if (!el) { hideTtip(); return; }
  ttipTimer = setTimeout(() => showTtip(el), 320);
});
document.addEventListener('mouseout', () => { clearTimeout(ttipTimer); hideTtip(); });
document.addEventListener('mousedown', hideTtip);

// ===== Wide chat composer: same input, roomier view =====
const chatExpandModal = document.getElementById('chat-expand-modal');
const cxInput = document.getElementById('cx-input');
setupMention(cxInput, document.getElementById('cx-mention'));
setupSlash(cxInput, document.getElementById('cx-slash'));
enableDrop(cxInput);
document.getElementById('cx-attach-btn').onclick = () => fileIn.click();
function openChatExpand() {
  // mirror target options + current values into the modal
  const tgt = document.getElementById('chat-target');
  const cxt = document.getElementById('cx-target');
  cxt.innerHTML = tgt.innerHTML;
  cxt.value = tgt.value;
  document.getElementById('cx-plan').checked = document.getElementById('chat-plan').checked;
  cxInput.value = chatInput.value;
  chatExpandModal.classList.remove('hidden');
  renderAttach();   // show any pending attachments in the modal too
  cxInput.focus();
  cxInput.setSelectionRange(cxInput.value.length, cxInput.value.length);
}
function closeChatExpand() {
  chatInput.value = cxInput.value;   // keep the small box in sync on close
  chatExpandModal.classList.add('hidden');
}
document.getElementById('btn-chat-expand').onclick = openChatExpand;
document.getElementById('cx-close').onclick = closeChatExpand;
chatExpandModal.addEventListener('click', e => { if (e.target === chatExpandModal) closeChatExpand(); });
document.getElementById('cx-send').onclick = () => {
  // push the modal's values into the real controls, then reuse sendChat()
  document.getElementById('chat-target').value = document.getElementById('cx-target').value;
  document.getElementById('chat-plan').checked = document.getElementById('cx-plan').checked;
  chatInput.value = cxInput.value;
  chatExpandModal.classList.add('hidden');
  sendChat();
  cxInput.value = '';
};
cxInput.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') document.getElementById('cx-send').click();
  else if (e.key === 'Escape' && document.getElementById('cx-mention').classList.contains('hidden') && document.getElementById('cx-slash').classList.contains('hidden')) closeChatExpand();
});

document.getElementById('btn-new-session').onclick = () => {
  if (Object.values(rt).some(r => r.running)) { plog('err', 'stop all agents before resetting the session.'); return; }
  clearSession();
  plog('info', 'shared session reset — next run starts with a fresh context.');
};

// ============================================================
// Follow-up chat modal (per agent, shared session context)
// ============================================================
// ===== Per-agent isolated view (GPT-style dock) — replaces the follow-up modal =====
// Clicking an agent filters the console to that agent's log and docks a composer
// at the bottom. Watch it work, or follow up right here — no popup.
const agentDock = document.getElementById('agent-dock');
const adInput = document.getElementById('ad-input');
let chatAgentId = null;   // the focused agent (kept name for existing callers)

function openChat(agentId) {   // called by the roster card click
  const a = agents.find(x => x.id === agentId);
  if (!a) return;
  chatAgentId = agentId;
  feedFilter = agentId;
  applyFilter();
  document.getElementById('ad-avatar').textContent = ROLE_ICON[a.role] || ROLE_ICON.custom;
  document.getElementById('ad-name').textContent = a.name;
  agentDock.classList.remove('hidden');
  document.getElementById('console-feed').classList.add('has-dock');
  updateChatModal();
  renderAttach();
  adInput.focus();
  // ensure the console surface is what's visible (not editor/terminal)
  if (typeof showSurface === 'function') showSurface('console');
}
function closeAgentView() {
  chatAgentId = null;
  feedFilter = null;
  applyFilter();
  agentDock.classList.add('hidden');
  document.getElementById('console-feed').classList.remove('has-dock');
}

// kept name — called from setRunningUI/ticker/events to refresh the dock header
function updateChatModal() {
  if (!chatAgentId || agentDock.classList.contains('hidden')) return;
  const a = agents.find(x => x.id === chatAgentId);
  if (!a) return;
  const r = R(chatAgentId);
  const sess = getSession();
  document.getElementById('ad-status').innerHTML =
    `<span class="${r.running ? 'run' : ''}">${r.running ? '● ' + esc(r.status || 'running') : '○ idle'}</span>` +
    ` · ${MODEL_LABELS[a.model] || a.model} · ${sess ? 'session ' + esc(sess.slice(0, 8)) : 'new session'}`;
  document.getElementById('ad-send').disabled = r.running;
  document.getElementById('ad-stop').classList.toggle('hidden', !r.running);
}

function sendAgentFollowup() {
  const text = adInput.value.trim();
  if (!text || !chatAgentId || R(chatAgentId).running) return;
  // "!" shell like the main box
  if (text.startsWith('!')) {
    const cmd = text.slice(1).trim(); if (!cmd) return;
    adInput.value = '';
    feedRaw('OPERATOR', 'tool', '$ ' + cmd, '⌨');
    window.deck.exec(cmd, projectDir || '').then(r => feedRaw('SHELL', r.ok ? 'txt' : 'err', (r.out || '').trim() || '(no output)'));
    return;
  }
  const full = text + attachBlock() + slashDirective(text);
  adInput.value = '';
  adInput.style.height = 'auto';
  const fa = agents.find(x => x.id === chatAgentId);
  if (fa && fa.role === 'uiux') learnUiWords(text);
  learnMaybeCorrection(chatAgentId, text);
  // continuity: resume the shared session in place (no fork)
  runAgent(chatAgentId, full, false, false, { cont: true });
}

document.getElementById('ad-send').onclick = sendAgentFollowup;
document.getElementById('ad-all').onclick = closeAgentView;
document.getElementById('ad-stop').onclick = () => { if (chatAgentId) stopAgent(chatAgentId); };
document.getElementById('ad-attach-btn').onclick = () => fileIn.click();
adInput.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') sendAgentFollowup(); });
setupSlash(adInput, document.getElementById('ad-slash'));
setupMention(adInput, document.getElementById('ad-mention'));
enableDrop(adInput);
// ChatGPT-style auto-grow: the input expands with its content, capped by CSS max-height
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
adInput.addEventListener('input', () => autoGrow(adInput));

// ============================================================
// Modal
// ============================================================
// a "managed" agent is one of the built-in def-* roster whose base rules the app
// owns (updated every build). The operator never edits that base — they only add
// EXTRA rules that get appended. GENERAL-OPS (role 'custom', no base) is not managed.
function isManaged(a) { return !!(a && typeof a.id === 'string' && a.id.startsWith('def-') && RULES[a.role]); }

// the full rule text an agent actually runs with
function effectiveRules(a) {
  if (isManaged(a)) {
    const base = RULES[a.role];
    const extra = (a.extraRules || '').trim();
    return extra ? `${base}\n\n--- OPERATOR ADDITIONS ---\n${extra}` : base;
  }
  // GENERAL-OPS with no custom rules still gets the token discipline block
  if (a && a.id === 'def-general' && !(a.rules || '').trim()) return DISCIPLINE.trim();
  return a.rules || '';
}

// runaway-loop guard: generous per-role turn ceilings — normal work never hits
// them, but a confused run can't silently burn tokens for 100+ turns
const MAX_TURNS = { prompt: 40, senior: 80, uiux: 80, reviewer: 50, indexer: 40, custom: 60 };

// UI-task detector: routes interface work to the UI/UX engineer automatically
const UI_TASK_RE = /\b(ui|ux|design|theme|theming|style|styling|css|scss|tailwind|layout|responsive|typography|font|color|colour|button|modal|dialog|dropdown|navbar|sidebar|icon|animation|dark.?mode|light.?mode|component library|shadcn|accessib)/i;
function isUiTask(text) {
  const s = String(text || '');
  if (UI_TASK_RE.test(s)) return true;
  // learned vocabulary: words that repeatedly showed up in tasks the operator
  // sent to the UI/UX agent by hand
  const lower = s.toLowerCase();
  return (LEARN.uiWords || []).some(w => lower.includes(w));
}
function uiuxAgent() { return byRole('uiux')[0]; }

// ============================================================
// SELF-LEARNING (background, zero tokens — pure local heuristics)
// The app watches its own runs: results, turns, pipeline rejections and the
// operator's quick corrective follow-ups. It learns per-model reliability and
// adjusts complexity routing / turn ceilings automatically. No LLM involved.
// ============================================================
const LEARN = JSON.parse(localStorage.getItem('learn') || '{}');
LEARN.models = LEARN.models || {};       // model -> { runs, bad } (bad = error/abort/reject/correction)
LEARN.turnCapHits = LEARN.turnCapHits || {};  // role -> count of runs killed by the turn cap
LEARN.uiWordCounts = LEARN.uiWordCounts || {}; // word -> times seen in manual UI/UX sends
LEARN.uiWords = LEARN.uiWords || [];     // promoted words (seen >= 3 times)
function saveLearn() { localStorage.setItem('learn', JSON.stringify(LEARN)); }

function learnMark(model, bad) {
  if (!model) return;
  const m = LEARN.models[model] || (LEARN.models[model] = { runs: 0, bad: 0 });
  m.runs++; if (bad) m.bad++;
  saveLearn();
}

// the cheap→capable ladder used when a model proves unreliable for routed work
const MODEL_LADDER = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8'];
// if a routed model's bad-rate is >30% over >=6 observed runs, route one step up
function learnedModel(model) {
  if (!model) return model;
  const m = LEARN.models[model];
  const i = MODEL_LADDER.indexOf(model);
  if (m && m.runs >= 6 && m.bad / m.runs > 0.3 && i >= 0 && i < MODEL_LADDER.length - 1) {
    const up = MODEL_LADDER[i + 1];
    plog('info', `learning: ${MODEL_LABELS[model]} failed ${Math.round(100 * m.bad / m.runs)}% of routed runs — bumping to ${MODEL_LABELS[up]}.`);
    return up;
  }
  return model;
}

// roles that repeatedly die at the turn ceiling get +25% per strike (max 120)
function learnedMaxTurns(role) {
  const base = MAX_TURNS[role] || 60;
  const hits = LEARN.turnCapHits[role] || 0;
  return Math.min(120, Math.round(base * (1 + 0.25 * Math.min(hits, 3))));
}

// operator manually sent a task to the UI/UX agent → grow the UI vocabulary
const UI_STOPWORDS = new Set(['this', 'that', 'with', 'from', 'make', 'have', 'should', 'when', 'then', 'file', 'files', 'code', 'please', 'update', 'change', 'need', 'want', 'like', 'also', 'more', 'less', 'very', 'just', 'will', 'must', 'them', 'they', 'what', 'where', 'agent', 'task']);
function learnUiWords(text) {
  for (const w of String(text || '').toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) {
    if (UI_STOPWORDS.has(w) || UI_TASK_RE.test(w)) continue;
    LEARN.uiWordCounts[w] = (LEARN.uiWordCounts[w] || 0) + 1;
    if (LEARN.uiWordCounts[w] === 3 && !LEARN.uiWords.includes(w)) {
      LEARN.uiWords.push(w);
      if (LEARN.uiWords.length > 40) LEARN.uiWords.shift();   // bounded memory
    }
  }
  saveLearn();
}

// a corrective follow-up right after a "successful" run means it wasn't really
// good — count it against the model that produced it
const CORRECTIVE_RE = /\b(wrong|not working|didn'?t|doesn'?t|broken|still|instead|revert|undo|fix it|no[,.! ]|incorrect|bad)\b/i;
const lastRunMeta = {};   // agentId -> { model, at }
function learnMaybeCorrection(agentId, text) {
  const meta = lastRunMeta[agentId];
  if (meta && Date.now() - meta.at < 5 * 60 * 1000 && CORRECTIVE_RE.test(text)) {
    learnMark(meta.model, true);
  }
}

function openModal(id) {
  editingId = id || null;
  const a = id ? agents.find(x => x.id === id) : null;
  const managed = isManaged(a);
  document.getElementById('modal-title').textContent = a ? 'CONFIGURE AGENT' : 'DEPLOY NEW AGENT';
  document.getElementById('f-name').value = a ? a.name : '';
  document.getElementById('f-model').value = a ? a.model : 'claude-sonnet-5';
  document.getElementById('f-role').value = a ? (a.role || 'custom') : 'custom';
  document.getElementById('f-perm').value = a ? a.perm : 'acceptEdits';
  document.getElementById('f-cwd').value = a ? (a.cwd || '') : (projectDir || '');
  document.getElementById('f-dirs').value = a ? (a.dirs || '') : '';
  document.getElementById('f-lean').checked = a ? !!a.lean : false;
  const rulesBox = document.getElementById('f-rules');
  if (managed) {
    // hide the built-in prompt; show only the operator's own additions
    rulesBox.value = a.extraRules || '';
    rulesBox.placeholder = 'This role already has built-in rules (hidden). Anything you type here is APPENDED to them. Leave empty to use the defaults as-is.';
  } else {
    rulesBox.value = a ? (a.rules || '') : '';
    rulesBox.placeholder = '';
  }
  document.getElementById('f-save').textContent = a ? 'SAVE' : 'DEPLOY';
  modal.classList.remove('hidden');
  document.getElementById('f-name').focus();
}

document.getElementById('f-role').onchange = e => {
  const role = e.target.value;
  const a = editingId ? agents.find(x => x.id === editingId) : null;
  // for a managed def-* agent the base is hidden, so never dump it into the box
  if (!isManaged(a) && RULES[role]) document.getElementById('f-rules').value = RULES[role];
  // pipeline roles never need the user-global config — default them lean
  document.getElementById('f-lean').checked = ['prompt', 'senior', 'uiux', 'reviewer', 'indexer'].includes(role);
};
document.getElementById('btn-new-agent').onclick = () => openModal(null);
document.getElementById('f-cancel').onclick = () => modal.classList.add('hidden');
document.getElementById('f-browse').onclick = async () => {
  const dir = await window.deck.pickFolder();
  if (dir) document.getElementById('f-cwd').value = dir;
};
document.getElementById('f-save').onclick = () => {
  const name = document.getElementById('f-name').value.trim() || 'AGENT-' + uid().toUpperCase().slice(0, 4);
  const editing = editingId ? agents.find(x => x.id === editingId) : null;
  const rulesVal = document.getElementById('f-rules').value.trim();
  const data = {
    name,
    model: document.getElementById('f-model').value,
    role: document.getElementById('f-role').value,
    perm: document.getElementById('f-perm').value,
    cwd: document.getElementById('f-cwd').value.trim(),
    dirs: document.getElementById('f-dirs').value.trim(),
    lean: document.getElementById('f-lean').checked
  };
  // managed agents keep their app-owned base rules; the box only sets ADDITIONS
  if (isManaged(editing)) data.extraRules = rulesVal;
  else data.rules = rulesVal;
  if (editingId) Object.assign(editing, data);
  else agents.push({ id: uid(), ...data });
  save();
  modal.classList.add('hidden');
  render();
};
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // the alert is modal on purpose — Escape answers it, nothing else
    if (!alertModal.classList.contains('hidden')) { if (!alertBusy) closeAlert(false); return; }
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
  // project map: use the cached one under .loveai if present, else build it —
  // then watch for new/removed files and keep it fresh through the session
  window.deck.symbolEnsure(dir).then(r => {
    if (!r || !r.ok) return;
    plog('info', r.cached
      ? `project map loaded from cache: ${r.files} files.`
      : `project map built: ${r.files} files ranked for fast retrieval.`);
    window.deck.symbolWatch(dir).catch(() => {});
  }).catch(() => {});
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

