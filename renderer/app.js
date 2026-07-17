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
      const r = await window.deck.retrieveContext(cwd, prompt, 10);
      if (r.ok && r.files && r.files.length) {
        const lines = r.files.map(f => `- ${f.rel}${f.symbols && f.symbols.length ? ' — ' + f.symbols.slice(0, 8).join(', ') : ''}`).join('\n');
        fullPrompt += `\n\nPRE-RANKED RELEVANT FILES (lexical match on the issue — START HERE, open the top few, verify, and only widen if they don't cover it. Do NOT grep the whole repo):\n${lines}`;
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
  // build the lexical index in the background so the PE gets pre-ranked files fast
  window.deck.symbolBuild(dir).then(r => {
    if (r && r.ok) plog('info', `lexical index built: ${r.files} files ranked for fast Prompt Engineer retrieval.`);
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

// ============================================================
// GIT — VS Code-style source control
// ============================================================
let repos = [], gitRepo = null;
const gitPanel = document.getElementById('git-panel');
const GIT_STATUS_LABEL = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' };

const loveaiIgnored = new Set();   // repos already gitignored+untracked this session
async function ensureLoveaiIgnored() {
  for (const r of repos) {
    if (loveaiIgnored.has(r)) continue;
    loveaiIgnored.add(r);
    try {
      const res = await window.deck.gitIgnoreLoveai(r);
      if (res && res.untracked) plog('info', `.loveai untracked and gitignored in ${r.split(/[\\/]/).pop()}`);
    } catch {}
  }
}

async function gitDetect() {
  repos = projectDir ? await window.deck.gitRepos(projectDir) : [];
  await ensureLoveaiIgnored();
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

  const countOf = st => st.staged.length + st.unstaged.length + st.untracked.length + (st.conflicts ? st.conflicts.length : 0);
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
  buildExStatus(valid);
  decorateExplorer();
}

function gitFileRow(f, statusChar, staged) {
  const parts = f.replace(/"/g, '').split('/');
  const base = parts.pop();
  const dir = parts.join('/');
  const row = document.createElement('div');
  row.className = 'git-file';
  row.title = f;
  const discardBtn = staged ? '' : `<button class="mini-btn gf-discard" title="${statusChar === '?' ? 'Delete untracked file' : 'Discard changes'}">↩</button>`;
  row.innerHTML = `<span class="gf-name" title="View diff">${esc(base)}</span><span class="gf-dir">${esc(dir)}</span>${discardBtn}<button class="mini-btn gf-stage">${staged ? '−' : '+'}</button><span class="gf-status s-${GIT_STATUS_LABEL[statusChar] || 'M'}">${GIT_STATUS_LABEL[statusChar] || statusChar}</span>`;
  row.querySelector('.gf-stage').onclick = async () => {
    await window.deck.gitCmd(gitRepo, staged ? 'unstage' : 'stage', f);
    gitRefresh();
  };
  const disc = row.querySelector('.gf-discard');
  if (disc) disc.onclick = async () => {
    const untracked = statusChar === '?';
    const ok = await showAlert({
      title: untracked ? 'DELETE FILE' : 'DISCARD CHANGES',
      message: untracked ? `Permanently delete untracked "${base}"?` : `Discard all changes to "${base}"? This cannot be undone.`,
      okText: untracked ? 'DELETE' : 'DISCARD', cancelText: 'CANCEL', kind: 'danger'
    });
    if (!ok) return;
    await window.deck.gitCmd(gitRepo, untracked ? 'clean' : 'discard', f);
    gitRefresh(); refreshWorkspace();
  };
  // click the name → diff view (untracked files have no diff, so open them instead)
  row.querySelector('.gf-name').onclick = () => {
    if (statusChar === '?') openFile(joinPath(gitRepo, f.replace(/"/g, '')));
    else openDiff({ file: f, staged });
  };
  return row;
}

function renderGitModal(st) {
  document.getElementById('git-branch-line').textContent = gitRepo;
  document.getElementById('git-branch-name').textContent = st.branch || '(detached)';
  // ahead/behind vs upstream, VS Code-style ↑n ↓n
  const syncEl = document.getElementById('git-sync-state');
  if (st.upstream) {
    const bits = [];
    if (st.behind) bits.push(`↓${st.behind}`);
    if (st.ahead) bits.push(`↑${st.ahead}`);
    syncEl.textContent = bits.join(' ') || '✓ up to date';
    syncEl.classList.toggle('behind', !!st.behind);
  } else {
    syncEl.textContent = 'no upstream';
    syncEl.classList.remove('behind');
  }

  const stagedBox = document.getElementById('git-staged');
  const unstagedBox = document.getElementById('git-unstaged');
  const conflictBox = document.getElementById('git-conflicts');
  stagedBox.innerHTML = ''; unstagedBox.innerHTML = ''; conflictBox.innerHTML = '';

  // merge conflicts get their own section with a Resolve action per file
  const conflicts = st.conflicts || [];
  for (const f of conflicts) {
    const row = gitConflictRow(f);
    conflictBox.appendChild(row);
  }
  document.getElementById('sec-conflicts').classList.toggle('hidden', !conflicts.length);
  document.getElementById('conflicts-count').textContent = conflicts.length || '';

  for (const { s, f } of st.unstaged) unstagedBox.appendChild(gitFileRow(f, s, false));
  for (const f of st.untracked) unstagedBox.appendChild(gitFileRow(f, '?', false));
  for (const { s, f } of st.staged) stagedBox.appendChild(gitFileRow(f, s, true));
  // like VS Code: staged section only appears when something is staged
  document.getElementById('sec-staged').classList.toggle('hidden', !st.staged.length);
  document.getElementById('staged-count').textContent = st.staged.length || '';
  document.getElementById('changes-count').textContent = (st.unstaged.length + st.untracked.length) || '';
  if (!st.unstaged.length && !st.untracked.length) unstagedBox.innerHTML = '<div class="git-none">working tree clean</div>';
}

// a conflicted file: click the name to resolve it VS Code-style; ↗ opens the raw
// file in the editor; ✓ marks it resolved as-is
function gitConflictRow(f) {
  const base = f.replace(/"/g, '').split('/').pop();
  const row = document.createElement('div');
  row.className = 'git-file gf-conflict';
  row.title = 'Click to resolve conflicts';
  row.innerHTML = `<span class="gf-name">${esc(base)}</span><button class="mini-btn gf-open" title="Open raw file">↗</button><button class="mini-btn gf-resolve" title="Mark resolved as-is (stage)">✓</button><span class="gf-status s-U">!</span>`;
  row.querySelector('.gf-name').onclick = () => openConflictResolver(f);
  row.querySelector('.gf-open').onclick = () => { if (gitRepo) openFile(joinPath(gitRepo, f.replace(/"/g, ''))); };
  row.querySelector('.gf-resolve').onclick = async () => {
    await window.deck.gitCmd(gitRepo, 'resolve', f);
    gitRefresh();
  };
  return row;
}

// ============================================================
// MERGE CONFLICT RESOLVER — VS Code-style accept current/incoming/both,
// plus an AI pass that recommends which side to take per conflict
// ============================================================
const conflictModal = document.getElementById('conflict-modal');
let cf = null;   // { rel, abs, segments, choices: Map(idx -> 'current'|'incoming'|'both') }

// split file text into alternating text/conflict segments
function parseConflicts(text) {
  const lines = text.split('\n');
  const segs = [];
  let plain = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) {
      if (plain.length) { segs.push({ type: 'text', lines: plain }); plain = []; }
      const seg = { type: 'conflict', curLabel: lines[i].slice(7).trim() || 'HEAD', current: [], incoming: [], incLabel: 'incoming' };
      i++;
      while (i < lines.length && !lines[i].startsWith('=======')) seg.current.push(lines[i++]);
      i++;   // skip =======
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) seg.incoming.push(lines[i++]);
      if (i < lines.length) seg.incLabel = lines[i].slice(7).trim() || 'incoming';
      segs.push(seg);
    } else plain.push(lines[i]);
  }
  if (plain.length) segs.push({ type: 'text', lines: plain });
  return segs;
}

async function openConflictResolver(relFile, opts = {}) {
  const rel = relFile.replace(/"/g, '');
  const abs = joinPath(gitRepo, rel);
  const r = await window.deck.fsRead(gitRepo, abs, shikiTheme());
  if (!r.ok) { toast('✗ cannot read ' + rel + ': ' + r.error, false); return; }
  const segments = parseConflicts(r.content);
  if (!segments.some(s => s.type === 'conflict')) {
    // no markers — treat as already resolved; advance a PR flow if present
    if (opts.after) { opts.after(); return; }
    toast('no conflict markers found — opening the file instead', false);
    openFile(abs);
    return;
  }
  // opts.after: called after this file is saved+staged (PR conflict chaining)
  // opts.aiRule: extra guidance appended to the AI analyzer prompt
  cf = { rel, abs, segments, choices: new Map(), after: opts.after || null, aiRule: opts.aiRule || '' };
  document.getElementById('cf-title').textContent = 'RESOLVE CONFLICTS · ' + rel.split('/').pop();
  document.getElementById('cf-status').textContent = opts.progress || '';
  gitPanel.classList.add('hidden');
  renderConflicts();
  conflictModal.classList.remove('hidden');
}

function renderConflicts() {
  const body = document.getElementById('cf-body');
  body.innerHTML = '';
  let confIdx = 0, total = 0, resolved = 0;
  for (const seg of cf.segments) {
    if (seg.type === 'text') {
      // context: show a few surrounding lines, collapse the middle
      const pre = document.createElement('pre');
      pre.className = 'cf-ctx';
      const ls = seg.lines;
      pre.textContent = ls.length > 7 ? [...ls.slice(0, 3), '        · · ·', ...ls.slice(-3)].join('\n') : ls.join('\n');
      body.appendChild(pre);
      continue;
    }
    const i = confIdx++;
    total++;
    const choice = cf.choices.get(i);
    const box = document.createElement('div');
    box.className = 'cf-conf';
    if (choice) {
      resolved++;
      const chosen = choice === 'current' ? seg.current : choice === 'incoming' ? seg.incoming : [...seg.current, ...seg.incoming];
      box.innerHTML = `<div class="cf-done-head">✓ resolved — accepted ${choice} <a href="#" class="cf-undo">undo</a></div><pre class="cf-chosen"></pre>`;
      box.querySelector('.cf-chosen').textContent = chosen.join('\n') || '(empty)';
      box.querySelector('.cf-undo').onclick = (e) => { e.preventDefault(); cf.choices.delete(i); renderConflicts(); };
    } else {
      // VS Code look: action links sit inside the conflict block, above Current
      box.innerHTML = `
        <div class="cf-actions">
          <a href="#" data-c="current">Accept Current Change</a><span>|</span>
          <a href="#" data-c="incoming">Accept Incoming Change</a><span>|</span>
          <a href="#" data-c="both">Accept Both Changes</a>
          <span class="cf-reco" data-reco="${i}"></span>
        </div>
        <div class="cf-cur"><div class="cf-label cur">&lt;&lt;&lt;&lt;&lt;&lt;&lt; ${esc(seg.curLabel)} (Current Change)</div><pre></pre></div>
        <div class="cf-sep">=======</div>
        <div class="cf-inc"><pre></pre><div class="cf-label inc">&gt;&gt;&gt;&gt;&gt;&gt;&gt; ${esc(seg.incLabel)} (Incoming Change)</div></div>`;
      box.querySelector('.cf-cur pre').textContent = seg.current.join('\n') || '(empty)';
      box.querySelector('.cf-inc pre').textContent = seg.incoming.join('\n') || '(empty)';
      box.querySelectorAll('.cf-actions a').forEach(aEl => {
        aEl.onclick = (e) => { e.preventDefault(); cf.choices.set(i, aEl.dataset.c); renderConflicts(); };
      });
      if (cf.reco && cf.reco[i]) {
        const el = box.querySelector('.cf-reco');
        el.textContent = `🤖 suggests: ${cf.reco[i].pick}${cf.reco[i].why ? ' — ' + cf.reco[i].why : ''}`;
      }
    }
    body.appendChild(box);
  }
  document.getElementById('cf-count').textContent = `${resolved}/${total} resolved`;
  document.getElementById('cf-save').disabled = resolved !== total;
}

// rebuild the file from segments + choices and finish the resolution
document.getElementById('cf-save').onclick = async () => {
  if (!cf) return;
  const btn = document.getElementById('cf-save');
  btn.disabled = true; const prev = btn.textContent; btn.textContent = '⏳ SAVING…';
  const out = [];
  let i = 0;
  for (const seg of cf.segments) {
    if (seg.type === 'text') { out.push(...seg.lines); continue; }
    const c = cf.choices.get(i++);
    if (c === 'current') out.push(...seg.current);
    else if (c === 'incoming') out.push(...seg.incoming);
    else out.push(...seg.current, ...seg.incoming);
  }
  const w = await window.deck.fsWrite(gitRepo, cf.abs, out.join('\n'));
  if (!w.ok) { btn.textContent = prev; btn.disabled = false; toast('✗ save failed: ' + w.error, false); return; }
  await window.deck.gitCmd(gitRepo, 'resolve', cf.rel);
  btn.textContent = prev;
  toast(`✓ ${cf.rel.split('/').pop()} resolved & staged`);
  const after = cf.after;
  conflictModal.classList.add('hidden');
  cf = null;
  gitRefresh(); refreshWorkspace();
  if (after) after();   // PR conflict chain: open the next file / finish
};

async function cfCancel() {
  conflictModal.classList.add('hidden'); cf = null;
  if (prConflictCtx) {   // abort the merge we started for the PR flow
    prConflictCtx = null;
    await window.deck.prAbortMerge(gitRepo);
    toast('merge aborted — PR not created.', false);
    gitRefresh(); refreshWorkspace();
  }
}
document.getElementById('cf-cancel').onclick = cfCancel;
conflictModal.addEventListener('click', e => { if (e.target === conflictModal) cfCancel(); });

// AI pass: an agent reads every conflict and recommends a side per conflict
document.getElementById('cf-ai').onclick = async () => {
  if (!cf) return;
  const agent = byRole('reviewer')[0] || byRole('senior')[0] || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { toast('✗ ' + agent.name + ' is busy', false); return; }
  const confs = cf.segments.filter(s => s.type === 'conflict');
  const blocks = confs.map((s, i) =>
    `CONFLICT ${i}\n<<< CURRENT (${s.curLabel})\n${s.current.join('\n')}\n=== INCOMING (${s.incLabel})\n${s.incoming.join('\n')}\n>>>`).join('\n\n');
  const status = document.getElementById('cf-status');
  status.textContent = '🤖 analyzing…';
  const rule = cf.aiRule
    ? cf.aiRule
    : 'Pick the side that preserves correct, complete behavior; use BOTH when the two changes are independent and both needed.';
  const prompt = `Merge conflicts in ${cf.rel}. For EACH conflict decide which side to accept. Do not use tools.

DECISION RULE: ${rule}

Output EXACTLY one line per conflict, nothing else:
CONFLICT <n>: CURRENT | INCOMING | BOTH — <reason, max 12 words>

${blocks.slice(0, 40000)}`;
  const applyAuto = !!cf.aiRule;   // PR flow: auto-apply the AI's picks so you can just Save
  runAgent(agent.id, prompt, false, false, {
    fresh: true, model: 'claude-sonnet-5',
    onDone: (result, text) => {
      if (!cf) return;
      if (result !== 'success') { status.textContent = 'analysis ' + result; return; }
      cf.reco = {};
      for (const m of text.matchAll(/CONFLICT\s+(\d+)\s*:\s*(CURRENT|INCOMING|BOTH)\s*(?:—|-)?\s*(.*)/gi)) {
        const idx = +m[1], pick = m[2].toUpperCase();
        cf.reco[idx] = { pick, why: (m[3] || '').trim().slice(0, 80) };
        if (applyAuto) cf.choices.set(idx, pick === 'CURRENT' ? 'current' : pick === 'INCOMING' ? 'incoming' : 'both');
      }
      status.textContent = Object.keys(cf.reco).length ? (applyAuto ? '🤖 applied — review & Save' : '🤖 recommendations ready') : 'no recommendations parsed';
      renderConflicts();
    }
  });
};

// forward-slash join for repo + git-relative path (git always emits '/')
function joinPath(repo, rel) { return (repo.replace(/[\\/]+$/, '') + '/' + rel).replace(/\//g, sepChar()); }
function sepChar() { return navigator.platform.startsWith('Win') ? '\\' : '/'; }

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
  // pull/merge rewrite files on disk — refresh the tree and open editors
  if (op === 'pull') refreshWorkspace();
  return r;
}

document.getElementById('git-badge').onclick = async (e) => {
  e.stopPropagation();
  if (gitPanel.classList.contains('hidden')) {
    await gitDetect();
    gitPanel.classList.remove('hidden');
    ciRefresh();   // CI status is fetched only when the panel is opened (gh call)
    ghprRefresh();
  } else {
    gitPanel.classList.add('hidden');
  }
};
// close the dropdown on any click outside it — but NOT when the click lands in a
// modal/dialog (discard confirm, branch prompt, etc.) that the panel itself opened
document.addEventListener('click', e => {
  if (e.target.closest('.modal')) return;
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

// ---------- lightweight text prompt (branch name, remote url, ...) ----------
// work: async fn(value) — runs INSIDE the dialog after OK (buttons lock, OK shows
// workingText); the promise then resolves { value, res } instead of just value.
function askText({ title, placeholder = '', value = '', work = null, workingText = '⏳ WORKING…' }) {
  return new Promise(res => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `<div class="modal-card alert-card"><div class="modal-title"></div>
      <input class="ask-input" spellcheck="false" />
      <div class="modal-actions"><button class="btn ask-cancel">CANCEL</button><button class="btn btn-launch ask-ok">OK</button></div></div>`;
    ov.querySelector('.modal-title').textContent = title;
    const inp = ov.querySelector('.ask-input');
    const okBtn = ov.querySelector('.ask-ok');
    const cancelBtn = ov.querySelector('.ask-cancel');
    inp.placeholder = placeholder; inp.value = value;
    document.body.appendChild(ov);
    inp.focus(); inp.select();
    let busy = false;
    const done = v => { if (busy) return; ov.remove(); res(v); };
    const submit = async () => {
      const v = inp.value.trim() || null;
      if (v === null) { done(null); return; }
      if (!work) { done(v); return; }
      busy = true;
      inp.disabled = true; okBtn.disabled = true; cancelBtn.disabled = true;
      okBtn.textContent = workingText; okBtn.classList.add('btn-working');
      let r;
      try { r = await work(v); } catch (e) { r = { ok: false, error: String(e && e.message ? e.message : e) }; }
      busy = false;
      ov.remove();
      res({ value: v, res: r });
    };
    okBtn.onclick = submit;
    cancelBtn.onclick = () => done(null);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') done(null);
    });
    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
  });
}

// ---------- branch switcher ----------
const branchMenu = document.getElementById('branch-menu');
const branchFetchedRepos = new Set();   // repos already `git fetch`ed this session
document.getElementById('git-branch-btn').onclick = async (e) => {
  e.stopPropagation();
  if (!branchMenu.classList.contains('hidden')) { branchMenu.classList.add('hidden'); return; }
  if (!gitRepo) return;
  // remotes only show up after a fetch — do it once per repo per session (or on
  // demand via the ⟳ button), with a loading state so it never looks empty
  if (!branchFetchedRepos.has(gitRepo)) {
    branchMenu.innerHTML = '<div class="cm-item">⟳ fetching remotes…</div>';
    branchMenu.classList.remove('hidden');
    fitDropUp(branchMenu, document.getElementById('git-branch-btn'));
    await window.deck.gitCmd(gitRepo, 'fetch');
    branchFetchedRepos.add(gitRepo);
  }
  const r = await window.deck.gitBranches(gitRepo);
  branchMenu.innerHTML = '';
  if (!r.ok) { branchMenu.innerHTML = `<div class="cm-item">${esc(r.error || 'failed')}</div>`; }
  else {
    // search box (pinned, doesn't scroll)
    const search = document.createElement('input');
    search.className = 'branch-search';
    search.placeholder = '🔎 filter branches…';
    search.spellcheck = false;
    branchMenu.appendChild(search);

    // checking a box filters OUT that category
    const toggles = document.createElement('div');
    toggles.className = 'branch-toggles';
    toggles.innerHTML = `
      <label><input type="checkbox" class="bt-local"> hide local</label>
      <label><input type="checkbox" class="bt-remote"> hide remote</label>
      <button class="bt-fetch" title="Fetch remotes again">⟳ fetch</button>`;
    branchMenu.appendChild(toggles);
    const cbLocal = toggles.querySelector('.bt-local');
    const cbRemote = toggles.querySelector('.bt-remote');
    toggles.querySelector('.bt-fetch').onclick = async (ev) => {
      ev.stopPropagation();
      branchFetchedRepos.delete(gitRepo);          // force a fresh fetch
      branchMenu.classList.add('hidden');
      document.getElementById('git-branch-btn').click();   // reopen → refetch + rerender
    };

    const list = document.createElement('div');
    list.className = 'branch-list';
    branchMenu.appendChild(list);

    const rows = [];   // { name, el, section, header? }
    const addHeader = (label) => {
      const h = document.createElement('div');
      h.className = 'branch-sec'; h.textContent = label;
      list.appendChild(h);
      rows.push({ header: true, el: h, section: label });
    };

    // ---- LOCAL (sorted, current pinned first) ----
    const locals = r.local.slice().sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)));
    addHeader('LOCAL');
    for (const b of locals) {
      const it = document.createElement('div');
      it.className = 'cm-item' + (b.current ? ' cm-current' : '');
      it.innerHTML = `<span>${b.current ? '● ' : ''}${esc(b.name)}</span>${b.current ? '' : '<span class="cm-del" title="Delete">🗑</span>'}`;
      it.querySelector('span').onclick = async () => {
        branchMenu.classList.add('hidden');
        if (!b.current) { await gitDo('checkout', b.name); refreshWorkspace(); }
      };
      const del = it.querySelector('.cm-del');
      if (del) del.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await showAlert({ title: 'DELETE BRANCH', message: `Delete branch "${b.name}"? Unmerged commits on it will be lost.`, okText: 'DELETE', cancelText: 'CANCEL', kind: 'danger' });
        if (ok) { await gitDo('delete-branch', b.name); document.getElementById('git-branch-btn').click(); document.getElementById('git-branch-btn').click(); }
      };
      list.appendChild(it);
      rows.push({ name: b.name.toLowerCase(), el: it, kind: 'local' });
    }

    // ---- REMOTE (sorted; hides ones already checked out locally) ----
    const localNames = new Set(r.local.map(b => b.name));
    const remotes = (r.remote || [])
      .filter(rb => !/\/HEAD$|->/.test(rb))                 // skip origin/HEAD pointers
      .map(rb => ({ full: rb, short: rb.replace(/^[^/]+\//, '') }))
      .filter(rb => !localNames.has(rb.short))              // no dup of a local branch
      .sort((a, b) => a.full.localeCompare(b.full));
    if (remotes.length) {
      addHeader('REMOTE');
      for (const rb of remotes) {
        const it = document.createElement('div');
        it.className = 'cm-item branch-remote';
        it.innerHTML = `<span>${esc(rb.full)}</span><span class="branch-co" title="Check out (creates a local tracking branch)">⤓</span>`;
        // selecting a remote branch auto-branches out: creates a local tracking branch
        it.onclick = async () => {
          branchMenu.classList.add('hidden');
          await gitDo('checkout', rb.short);
          refreshWorkspace();
        };
        list.appendChild(it);
        rows.push({ name: rb.full.toLowerCase(), el: it, kind: 'remote' });
      }
    }

    const noHit = document.createElement('div');
    noHit.className = 'git-none'; noHit.textContent = 'no match'; noHit.style.display = 'none';
    list.appendChild(noHit);

    const applyBranchFilter = () => {
      const q = search.value.trim().toLowerCase();
      const hideLocal = cbLocal.checked, hideRemote = cbRemote.checked;
      let hits = 0;
      for (const row of rows) {
        if (row.header) continue;
        const kindHidden = (row.kind === 'local' && hideLocal) || (row.kind === 'remote' && hideRemote);
        const show = !kindHidden && (!q || row.name.includes(q));
        row.el.style.display = show ? '' : 'none';
        if (show) hits++;
      }
      // hide a section header when nothing under it is visible
      let curHeader = null, curCount = 0;
      const flush = () => { if (curHeader) curHeader.style.display = curCount ? '' : 'none'; };
      for (const row of rows) {
        if (row.header) { flush(); curHeader = row.el; curCount = 0; }
        else if (row.el.style.display !== 'none') curCount++;
      }
      flush();
      noHit.style.display = hits ? 'none' : '';
    };
    search.oninput = applyBranchFilter;
    cbLocal.onchange = applyBranchFilter;
    cbRemote.onchange = applyBranchFilter;
    search.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); branchMenu.classList.add('hidden'); } };

    const create = document.createElement('div');
    create.className = 'cm-item branch-create'; create.textContent = '＋ Create branch…';
    create.onclick = async () => {
      branchMenu.classList.add('hidden');
      const name = await askText({ title: 'NEW BRANCH', placeholder: 'branch name' });
      if (name) { await gitDo('create-branch', name); refreshWorkspace(); }
    };
    branchMenu.appendChild(create);
  }
  branchMenu.classList.remove('hidden');
  fitDropUp(branchMenu, document.getElementById('git-branch-btn'));
  const sb = branchMenu.querySelector('.branch-search'); if (sb) sb.focus();
};

// Anchor a dropdown to its button using fixed positioning off the button's
// on-screen rect — so it always hangs from the button (not some ancestor) and
// stays inside the viewport, flipping above when there's no room below.
function fitDropUp(menu, anchor) {
  const a = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  // keep the left edge on-screen
  const width = menu.offsetWidth || 200;
  menu.style.left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8)) + 'px';
  const below = window.innerHeight - a.bottom - 12;
  const above = a.top - 12;
  if (below < 200 && above > below) {
    menu.style.top = 'auto';
    menu.style.bottom = (window.innerHeight - a.top + 4) + 'px';   // hang upward from the button
    menu.style.maxHeight = Math.min(340, above) + 'px';
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = (a.bottom + 4) + 'px';
    menu.style.maxHeight = Math.min(340, Math.max(140, below)) + 'px';
  }
}
document.addEventListener('click', e => {
  if (!branchMenu.classList.contains('hidden') && !branchMenu.contains(e.target) && e.target.id !== 'git-branch-btn') {
    branchMenu.classList.add('hidden');
  }
});

document.getElementById('git-fetch').onclick = () => gitDo('fetch');
document.getElementById('git-merge-abort').onclick = async () => {
  const ok = await showAlert({ title: 'ABORT MERGE', message: 'Abort the in-progress merge and restore the pre-merge state?', okText: 'ABORT MERGE', cancelText: 'CANCEL', kind: 'danger' });
  if (ok) { await gitDo('merge-abort'); refreshWorkspace(); }
};

// ---------- history + diff modal ----------
const gitModal = document.getElementById('git-modal');
function closeGitModal() { gitModal.classList.add('hidden'); }
document.getElementById('git-modal-close').onclick = closeGitModal;
gitModal.addEventListener('click', e => { if (e.target === gitModal) closeGitModal(); });

function renderDiff(container, diffText) {
  container.innerHTML = '';
  if (!diffText || !diffText.trim()) { container.innerHTML = '<div class="git-none">no changes to show</div>'; return; }
  const pre = document.createElement('pre');
  pre.className = 'diff-pre';
  for (const line of diffText.split('\n')) {
    const span = document.createElement('span');
    const c = line[0];
    span.className = 'dl ' + (c === '+' && !line.startsWith('+++') ? 'add'
      : c === '-' && !line.startsWith('---') ? 'del'
      : c === '@' ? 'hunk'
      : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') ? 'meta' : 'ctx');
    span.textContent = line + '\n';
    pre.appendChild(span);
  }
  container.appendChild(pre);
}

async function openDiff({ file, staged, commit }) {
  gitPanel.classList.add('hidden');
  gitModal.querySelector('.git-modal-card').classList.add('diff-only');
  document.getElementById('git-modal-title').textContent = commit ? 'DIFF · ' + commit.slice(0, 8) : 'DIFF · ' + (file || '').replace(/"/g, '').split('/').pop() + (staged ? ' (staged)' : '');
  const diffView = document.getElementById('git-diff-view');
  diffView.innerHTML = '<div class="git-none">loading…</div>';
  gitModal.classList.remove('hidden');
  const r = await window.deck.gitDiff(gitRepo, { file, staged, commit });
  renderDiff(diffView, r.diff);
}

async function openGitHistory() {
  gitPanel.classList.add('hidden');
  gitModal.querySelector('.git-modal-card').classList.remove('diff-only');
  document.getElementById('git-modal-title').textContent = 'HISTORY';
  const list = document.getElementById('git-hist-list');
  const diffView = document.getElementById('git-diff-view');
  list.innerHTML = '<div class="git-none">loading…</div>';
  diffView.innerHTML = '<div class="git-none">select a commit</div>';
  gitModal.classList.remove('hidden');
  const r = await window.deck.gitLog(gitRepo, 60);
  list.innerHTML = '';
  if (!r.ok || !r.commits.length) { list.innerHTML = `<div class="git-none">${esc(r.error || 'no commits')}</div>`; return; }
  for (const c of r.commits) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<div class="hist-subj"></div><div class="hist-meta"><span class="hist-hash">${esc(c.short)}</span> · ${esc(c.author)} · ${esc(c.date)}${c.refs ? ' · <span class="hist-refs"></span>' : ''}</div>`;
    row.querySelector('.hist-subj').textContent = c.subject;
    if (c.refs) row.querySelector('.hist-refs').textContent = c.refs;
    row.onclick = async () => {
      list.querySelectorAll('.hist-row').forEach(x => x.classList.remove('sel'));
      row.classList.add('sel');
      diffView.innerHTML = '<div class="git-none">loading…</div>';
      const d = await window.deck.gitDiff(gitRepo, { commit: c.hash });
      renderDiff(diffView, d.diff);
    };
    list.appendChild(row);
  }
}
document.getElementById('git-history').onclick = openGitHistory;

// ---------- GitHub Actions CI ----------
function parseGh(url) {
  const m = /github[^:/]*[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? { owner: m[1], repo: m[2] } : null;
}
function ciClass(run) {
  return run.status !== 'completed' ? 'run'
    : run.conclusion === 'success' ? 'ok'
    : run.conclusion === 'failure' ? 'fail' : 'warn';
}
function ciLabel(run) {
  return run.status !== 'completed' ? '● running'
    : run.conclusion === 'success' ? '✓ passing'
    : run.conclusion === 'failure' ? '✗ failing' : (run.conclusion || '?');
}

async function ciRefresh() {
  const section = document.getElementById('git-ci');
  const body = document.getElementById('ci-body');
  const state = document.getElementById('ci-state');
  if (!gitRepo) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  state.className = 'ci-state';

  const list = await window.deck.ciList(gitRepo);
  if (!list.files.length) {
    state.textContent = 'not set up';
    body.innerHTML = '<button class="mini-btn ci-scaffold-btn">＋ Add CI workflow</button>';
    body.querySelector('.ci-scaffold-btn').onclick = ciScaffold;
    return;
  }
  state.textContent = 'checking…';
  const st = await window.deck.ciStatus(gitRepo);
  if (!st.ok) { state.textContent = ''; body.innerHTML = `<div class="git-none">${esc(st.error)}</div>`; return; }
  if (!st.runs.length) { state.textContent = 'no runs yet'; body.innerHTML = '<div class="git-none">push to trigger the workflow</div>'; return; }

  state.textContent = ciLabel(st.runs[0]);
  state.className = 'ci-state ' + ciClass(st.runs[0]);
  body.innerHTML = '';
  for (const run of st.runs.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'ci-row';
    row.title = 'Open run in browser';
    row.innerHTML = `<span class="ci-dot ${ciClass(run)}"></span><span class="ci-title"></span><span class="ci-branch"></span>`;
    row.querySelector('.ci-title').textContent = `${run.workflowName}: ${run.displayTitle}`;
    row.querySelector('.ci-branch').textContent = run.headBranch || '';
    row.onclick = () => run.url && window.deck.openExternal(run.url);
    body.appendChild(row);
  }
}

async function ciScaffold() {
  const r = await window.deck.ciScaffold(gitRepo);
  if (!r.ok) { gitOut(r.error, false); return; }
  gitOut('CI created: .github/workflows/ci.yml — commit & push to activate', true);
  exReset(); gitRefresh(); ciRefresh();
}

document.getElementById('ci-refresh').onclick = (e) => { e.stopPropagation(); ciRefresh(); };
document.getElementById('ci-open').onclick = async (e) => {
  e.stopPropagation();
  const r = await window.deck.gitRemotes(gitRepo);
  const origin = (r.remotes || []).find(x => x.name === 'origin') || (r.remotes || [])[0];
  const gh = origin && parseGh(origin.url);
  if (gh) window.deck.openExternal(`https://github.com/${gh.owner}/${gh.repo}/actions`);
  else gitOut('no GitHub remote found', false);
};

// ---------- Pull requests: accordion section (list → diff/comments → review → merge) ----------
const PR_DECISION = {
  APPROVED: { txt: '✓ approved', cls: 'ok', rank: 0 },
  CHANGES_REQUESTED: { txt: '✗ changes requested', cls: 'fail', rank: 2 },
  REVIEW_REQUIRED: { txt: '• review required', cls: 'run', rank: 1 }
};
function prDec(pr) {
  return PR_DECISION[pr.reviewDecision] || { txt: pr.isDraft ? 'draft' : (pr.state || '').toLowerCase(), cls: 'warn', rank: 3 };
}
let ghprExpanded = null;   // number of the currently expanded PR

async function ghprRefresh() {
  const body = document.getElementById('ghpr-body-list') || document.getElementById('ghpr-body');
  const count = document.getElementById('ghpr-count');
  if (!gitRepo) { document.getElementById('git-pr-sec').classList.add('hidden'); return; }
  document.getElementById('git-pr-sec').classList.remove('hidden');
  body.innerHTML = '<div class="git-none">loading…</div>';
  const r = await window.deck.prList(gitRepo);
  if (!r.ok) { count.textContent = ''; body.innerHTML = `<div class="git-none">${esc(r.error)}</div>`; return; }
  const prs = r.prs.slice().sort((a, b) => prDec(a).rank - prDec(b).rank || a.number - b.number);  // approved first
  count.textContent = prs.length || '';
  if (!prs.length) { body.innerHTML = '<div class="git-none">no open pull requests</div>'; return; }
  body.innerHTML = '';
  for (const pr of prs) body.appendChild(ghprRow(pr));
}

function ghprRow(pr) {
  const dec = prDec(pr);
  const wrap = document.createElement('div');
  wrap.className = 'ghpr-item';
  wrap.innerHTML = `
    <div class="ghpr-row">
      <div class="ghpr-main">
        <div class="ghpr-title-line"><span class="ghpr-num">#${pr.number}</span> <span class="ghpr-title-txt"></span></div>
        <div class="ghpr-meta"><span class="ghpr-branch"></span> → <span class="ghpr-base"></span> · <span class="ghpr-dec ${dec.cls}">${dec.txt}</span></div>
      </div>
      <span class="ghpr-open-arrow">›</span>
    </div>`;
  wrap.querySelector('.ghpr-title-txt').textContent = pr.title;
  wrap.querySelector('.ghpr-branch').textContent = pr.headRefName;
  wrap.querySelector('.ghpr-base').textContent = pr.baseRefName;
  wrap.querySelector('.ghpr-row').onclick = () => ghprOpenDetail(pr);
  return wrap;
}

// ---- toast: confirmation feedback for background git/gh actions ----
let toastEl = null, toastTimer = null;
function toast(msg, ok = true) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = ok ? 'ok' : 'err';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hide'), 3200);
}

// put a button (and its siblings) into a busy state; returns a restore fn
function btnBusy(btn, label) {
  if (!btn) return () => {};
  const bar = btn.parentElement;
  const prev = btn.textContent;
  const disabled = [];
  if (bar) for (const b of bar.querySelectorAll('button')) { if (!b.disabled) { b.disabled = true; disabled.push(b); } }
  btn.textContent = label;
  btn.classList.add('btn-working');
  return () => {
    btn.textContent = prev;
    btn.classList.remove('btn-working');
    for (const b of disabled) b.disabled = false;
  };
}

// full-page PR view: header + actions + diff (left) + description/comments (right)
const ghprPage = document.getElementById('ghpr-page');
let ghprCurrent = null;
let ghprLastReview = '';   // last AI-review text captured for the current PR
document.getElementById('ghpr-back').onclick = () => ghprPage.classList.add('hidden');

function ghprOpenDetail(pr) {
  ghprCurrent = pr;
  ghprLastReview = '';
  gitPanel.classList.add('hidden');
  const dec = prDec(pr);
  const approved = pr.reviewDecision === 'APPROVED';
  document.getElementById('ghpr-dt-num').textContent = '#' + pr.number;
  document.getElementById('ghpr-dt-titletxt').textContent = pr.title;
  document.getElementById('ghpr-dt-branch').textContent = pr.headRefName;
  document.getElementById('ghpr-dt-base').textContent = pr.baseRefName;
  const decEl = document.getElementById('ghpr-dt-dec');
  decEl.textContent = dec.txt; decEl.className = 'ghpr-dec ' + dec.cls;

  const actions = document.getElementById('ghpr-dt-actions');
  actions.innerHTML = `
    <button class="mini-btn" data-a="review">🤖 AI Review</button>
    <button class="mini-btn" data-a="fix">🔧 Fix from review</button>
    <button class="mini-btn" data-a="approve">✓ Approve</button>
    <button class="mini-btn" data-a="request">✗ Request changes</button>
    <button class="mini-btn" data-a="merge" ${approved ? '' : 'disabled title="merge enabled once approved"'}>⧉ Merge</button>
    <button class="mini-btn" data-a="open">↗ Browser</button>`;
  actions.querySelector('[data-a="open"]').onclick = () => pr.url && window.deck.openExternal(pr.url);
  actions.querySelector('[data-a="approve"]').onclick = (e) => ghprReview(pr.number, 'approve', e.currentTarget);
  actions.querySelector('[data-a="request"]').onclick = (e) => ghprReview(pr.number, 'request', e.currentTarget);
  actions.querySelector('[data-a="review"]').onclick = () => openAiModal('review', pr);
  actions.querySelector('[data-a="fix"]').onclick = () => openAiModal('fix', pr);
  const mergeBtn = actions.querySelector('[data-a="merge"]');
  mergeBtn.onclick = (e) => { if (!mergeBtn.disabled) ghprMerge(pr.number, e.currentTarget); };

  document.getElementById('ghpr-dt-diff').innerHTML = '<div class="git-none">loading diff…</div>';
  document.getElementById('ghpr-dt-desc').textContent = '';
  document.getElementById('ghpr-dt-comments').innerHTML = '<div class="git-none">loading…</div>';
  document.getElementById('ghpr-dt-cmt').value = '';
  ghprPage.classList.remove('hidden');
  ghprLoadDetail(pr);
}

async function ghprLoadDetail(pr) {
  // diff
  window.deck.prDiff(gitRepo, pr.number, pr.baseRefName, pr.headRefName).then(d => {
    const box = document.getElementById('ghpr-dt-diff');
    if (!d.ok) { box.innerHTML = `<div class="git-none">${esc(d.error)}</div>`; return; }
    renderDiff(box, d.diff);
  });
  // description + comments + reviews
  window.deck.prView(gitRepo, pr.number).then(v => {
    const cbox = document.getElementById('ghpr-dt-comments');
    const desc = document.getElementById('ghpr-dt-desc');
    if (!v.ok) { cbox.innerHTML = `<div class="git-none">${esc(v.error)}</div>`; return; }
    desc.textContent = (v.pr.body || '').trim() || '(no description)';
    const items = [];
    for (const rv of (v.pr.reviews || [])) if (rv.body || rv.state) items.push({ who: rv.author && rv.author.login, when: rv.submittedAt, body: (rv.state ? `[${rv.state}] ` : '') + (rv.body || '') });
    for (const c of (v.pr.comments || [])) items.push({ who: c.author && c.author.login, when: c.createdAt, body: c.body });
    if (!items.length) { cbox.innerHTML = '<div class="git-none">no comments yet</div>'; return; }
    cbox.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'ghpr-cmt-item';
      el.innerHTML = `<div class="ghpr-cmt-who"></div><div class="ghpr-cmt-body"></div>`;
      el.querySelector('.ghpr-cmt-who').textContent = (it.who || '?') + (it.when ? ' · ' + new Date(it.when).toLocaleString() : '');
      el.querySelector('.ghpr-cmt-body').textContent = it.body || '';
      cbox.appendChild(el);
    }
  });
}

const ghprSend = document.getElementById('ghpr-dt-send');
const ghprCmtInput = document.getElementById('ghpr-dt-cmt');
async function ghprDoComment() {
  if (!ghprCurrent) return;
  const text = ghprCmtInput.value.trim();
  if (!text) return;
  ghprSend.disabled = true; ghprSend.textContent = '…';
  const r = await window.deck.prComment(gitRepo, ghprCurrent.number, text);
  ghprSend.disabled = false; ghprSend.textContent = 'Comment';
  if (!r.ok) { await showAlert({ title: 'COMMENT FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  ghprCmtInput.value = '';
  ghprLoadDetail(ghprCurrent);
}
ghprSend.onclick = ghprDoComment;
ghprCmtInput.addEventListener('keydown', e => { if (e.key === 'Enter') ghprDoComment(); });

async function ghprReview(number, action) {
  let r;
  if (action === 'request') {
    // the reason dialog itself shows the processing state while gh runs
    const out = await askText({
      title: 'REQUEST CHANGES', placeholder: 'what needs changing?',
      work: (v) => window.deck.prReview(gitRepo, number, 'request', v),
      workingText: '⏳ SUBMITTING…'
    });
    if (out === null) return;
    r = out.res;
  } else {
    // confirm modal doubles as the progress indicator
    const res = await showAlert({
      title: `APPROVE PR #${number}`, message: 'Submit an approving review for this pull request?',
      okText: 'APPROVE', cancelText: 'CANCEL',
      work: () => window.deck.prReview(gitRepo, number, 'approve', ''),
      workingText: '⏳ APPROVING…'
    });
    if (res === false) return;
    r = res;
  }
  if (!r || !r.ok) { toast(`✗ review failed: ${((r && (r.error || r.out)) || '').slice(0, 120)}`, false); return; }
  toast(action === 'approve' ? `✓ PR #${number} approved` : `✓ changes requested on PR #${number}`);
  await ghprRefresh();
  // re-open the detail with fresh state so Approve flips the Merge button on
  if (ghprCurrent && ghprCurrent.number === number && !ghprPage.classList.contains('hidden')) {
    const list = await window.deck.prList(gitRepo);
    const fresh = list.ok && list.prs.find(p => p.number === number);
    if (fresh) ghprOpenDetail(fresh);
  }
}

async function ghprMerge(number) {
  // the confirm modal stays open and shows MERGING… while gh works
  const res = await showAlert({
    title: `MERGE PR #${number}`, message: 'Squash-merge this PR and delete its branch?',
    okText: 'MERGE', cancelText: 'CANCEL', kind: 'danger',
    work: () => window.deck.prMerge(gitRepo, number, 'squash'),
    workingText: '⏳ MERGING…'
  });
  if (res === false) return;
  if (!res || !res.ok) { toast(`✗ merge failed: ${((res && (res.error || res.out)) || '').slice(0, 120)}`, false); return; }
  toast(`✓ PR #${number} squash-merged · branch deleted`);
  ghprPage.classList.add('hidden');   // PR is gone now
  ghprRefresh(); gitRefresh(); refreshWorkspace();
}

// ---------- AI Review / Fix modal (agent + model picker, live activity, result) ----------
const aiModal = document.getElementById('ai-modal');
const aiState = { mode: null, pr: null, running: false, streamEl: null, resultText: '', runAgentId: null, thinkEl: null };

// toggle the Start button into an Abort button while a run is live, and show a
// pulsing "thinking…" indicator at the bottom of the activity log
function aiSetRunning(on) {
  aiState.running = on;
  const btn = document.getElementById('ai-start');
  document.getElementById('ai-agent').disabled = on;
  document.getElementById('ai-model').disabled = on;
  if (on) {
    btn.textContent = '■ Abort';
    btn.classList.add('ai-abort');
    const live = document.getElementById('ai-live');
    aiState.thinkEl = document.createElement('div');
    aiState.thinkEl.className = 'ai-line ai-thinking';
    aiState.thinkEl.textContent = '⏳ thinking';
    live.appendChild(aiState.thinkEl);
  } else {
    btn.textContent = '▶ Start';
    btn.classList.remove('ai-abort');
    if (aiState.thinkEl) { aiState.thinkEl.remove(); aiState.thinkEl = null; }
  }
}

function aiPopulate(mode) {
  const agSel = document.getElementById('ai-agent');
  agSel.innerHTML = '';
  for (const a of agents) {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = `${ROLE_ICON[a.role] || ''} ${a.name}`;
    agSel.appendChild(o);
  }
  const mdSel = document.getElementById('ai-model');
  mdSel.innerHTML = '';
  for (const [id, label] of Object.entries(MODEL_LABELS)) {
    const o = document.createElement('option'); o.value = id; o.textContent = label; mdSel.appendChild(o);
  }
  // consistency: reuse the LAST agent+model chosen for this mode; otherwise a
  // strong default (Opus) so reviews don't silently vary by model each run
  const savedAg = localStorage.getItem('ai_' + mode + '_agent');
  const savedMd = localStorage.getItem('ai_' + mode + '_model');
  const defAg = (savedAg && agents.find(a => a.id === savedAg)) ? savedAg : (byRole(mode === 'review' ? 'reviewer' : 'senior')[0] || {}).id;
  if (defAg) agSel.value = defAg;
  const defMd = (savedMd && MODEL_LABELS[savedMd]) ? savedMd : 'claude-opus-4-8';
  mdSel.value = defMd;
}
function aiSaveChoice() {
  if (!aiState.mode) return;
  localStorage.setItem('ai_' + aiState.mode + '_agent', document.getElementById('ai-agent').value);
  localStorage.setItem('ai_' + aiState.mode + '_model', document.getElementById('ai-model').value);
}
document.getElementById('ai-agent').onchange = aiSaveChoice;
document.getElementById('ai-model').onchange = aiSaveChoice;

function openAiModal(mode, pr) {
  aiState.mode = mode; aiState.pr = pr; aiState.running = false; aiState.streamEl = null; aiState.resultText = '';
  document.getElementById('ai-modal-title').textContent = (mode === 'review' ? 'AI REVIEW' : 'FIX FROM REVIEW') + ` · PR #${pr.number}`;
  document.getElementById('ai-sub').textContent = mode === 'review'
    ? 'The agent reads the PR diff and reports findings + a verdict.'
    : 'The agent validates the PR review/comments against the diff, then plans a fix.';
  aiPopulate(mode);
  document.getElementById('ai-live').innerHTML = '<div class="git-none">pick an agent + model, then press Start</div>';
  document.getElementById('ai-final-wrap').classList.add('hidden');
  document.getElementById('ai-final').textContent = '';
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-post').classList.add('hidden');
  document.getElementById('ai-start').disabled = false;
  aiModal.classList.remove('hidden');
}
document.getElementById('ai-close').onclick = () => aiModal.classList.add('hidden');

function aiLiveLine(text, cls) {
  const live = document.getElementById('ai-live');
  const el = document.createElement('div');
  el.className = 'ai-line ' + (cls || '');
  el.textContent = text;
  live.appendChild(el);
  if (aiState.thinkEl) live.appendChild(aiState.thinkEl);   // keep it pinned to the bottom
  live.scrollTop = live.scrollHeight;
  return el;
}
function aiOnEvent(ev) {
  const live = document.getElementById('ai-live');
  if (ev.kind === 'init') { aiState.streamEl = null; aiLiveLine(`▸ session ${String(ev.sessionId).slice(0, 8)} · ${ev.model}`, 'sys'); }
  else if (ev.kind === 'tool') {
    aiState.streamEl = null;
    let detail = ''; try { const i = JSON.parse(ev.input); detail = i.file_path || i.path || i.command || i.pattern || i.query || ''; } catch {}
    aiLiveLine(`⚙ ${ev.tool} ${String(detail).slice(0, 100)}`, 'tool');
  } else if (ev.kind === 'text-delta') {
    if (!aiState.streamEl) aiState.streamEl = aiLiveLine('', 'txt');
    aiState.streamEl.textContent += ev.text;
    live.scrollTop = live.scrollHeight;
  } else if (ev.kind === 'text-end') { aiState.streamEl = null; }
  else if (ev.kind === 'result') { aiLiveLine(`◆ ${String(ev.subtype).toUpperCase()} · ${ev.numTurns} turns · ${(ev.durationMs / 1000).toFixed(1)}s`, 'ok'); }
  else if (ev.kind === 'error') { aiLiveLine('⚠ ' + ev.error, 'err'); }
}

document.getElementById('ai-start').onclick = async () => {
  if (aiState.running) {                       // Abort
    if (aiState.runAgentId) stopAgent(aiState.runAgentId);
    aiLiveLine('■ abort requested…', 'err');
    return;
  }
  const agentId = document.getElementById('ai-agent').value;
  const model = document.getElementById('ai-model').value;
  const a = agents.find(x => x.id === agentId);
  if (!a) return;
  if (R(agentId).running) { await showAlert({ title: 'AGENT BUSY', message: `${a.name} is already running.`, okText: 'OK' }); return; }
  const pr = aiState.pr;
  const d = await window.deck.prDiff(gitRepo, pr.number, pr.baseRefName, pr.headRefName);
  if (!d.ok || !d.diff.trim()) { await showAlert({ title: 'NO DIFF', message: d.error || 'this PR has no diff.', okText: 'OK' }); return; }

  aiSaveChoice();   // remember this agent+model for next time (consistency)
  let prompt, plan = false;
  if (aiState.mode === 'review') {
    // strict rubric + fixed output schema → different models produce comparable,
    // repeatable reviews instead of free-form prose that varies by model
    prompt = `You are a code reviewer. Review ONLY the diff below against this fixed rubric. Be deterministic and terse — output ONLY the format specified, no preamble or prose.

PR #${pr.number}: ${pr.title}  (${pr.headRefName} → ${pr.baseRefName})

Check these categories IN THIS ORDER, and report only issues actually present in the diff:
1. CORRECTNESS — bugs, logic errors, unhandled edge cases, broken contracts
2. SECURITY — injection, auth, secrets, unsafe input
3. PERFORMANCE — needless work, N+1, blocking calls
4. MAINTAINABILITY — dead code, naming, duplication

OUTPUT FORMAT — one line per finding, nothing else:
[SEVERITY] path:line — <issue in <=15 words> — fix: <suggested fix in <=15 words>
SEVERITY is exactly one of: BLOCKER, MAJOR, MINOR, NIT.
Sort findings by severity (BLOCKER first). If a category has none, output nothing for it.

Then a blank line, then EXACTLY one final line:
VERDICT: APPROVE
— or —
VERDICT: REQUEST CHANGES — <one sentence why>
(Use REQUEST CHANGES if and only if there is at least one BLOCKER or MAJOR.)

=== DIFF ===
${d.diff.slice(0, 60000)}`;
  } else {
    const v = await window.deck.prView(gitRepo, pr.number);
    const notes = [];
    if (v.ok) {
      for (const rv of (v.pr.reviews || [])) if (rv.body || rv.state) notes.push(`- [${rv.state || 'review'}] ${(rv.author && rv.author.login) || '?'}: ${rv.body || ''}`);
      for (const c of (v.pr.comments || [])) notes.push(`- ${(c.author && c.author.login) || '?'}: ${c.body || ''}`);
    }
    if (!notes.length) { await showAlert({ title: 'NO REVIEW/COMMENTS', message: 'This PR has no review or comments yet. Run AI Review and post it (or add a comment) first.', okText: 'OK' }); return; }
    prompt = `You are a fixer AI working on pull request #${pr.number} (${pr.title}), branch ${pr.headRefName}.

Below are the REVIEW COMMENTS on this PR. Your job:
1. VALIDATE each point against the actual diff — is it a real, correct concern? Note any you disagree with and why.
2. For valid ones, produce a concrete FIX PLAN: exact files, the change, and how you'll verify it.
Do NOT write code yet — this is plan mode. Present the validated findings and the plan.

=== REVIEW / COMMENTS ===
${notes.join('\n')}

=== PR DIFF ===
${(d.diff || '').slice(0, 55000)}`;
    plan = true;
  }

  document.getElementById('ai-live').innerHTML = '';
  document.getElementById('ai-final-wrap').classList.add('hidden');
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-post').classList.add('hidden');
  document.getElementById('ai-approve').classList.add('hidden');
  document.getElementById('ai-fullview-btn').classList.add('hidden');
  aiState.streamEl = null; aiState.runAgentId = agentId;
  aiSetRunning(true);
  aiLiveLine(`starting ${a.name} on ${MODEL_LABELS[model]}…`, 'sys');

  runAgent(agentId, prompt, false, plan, {
    fresh: true, model,
    onEvent: aiOnEvent,
    onDone: (result, text) => {
      aiSetRunning(false);
      aiState.resultText = (text || '').trim();
      const fw = document.getElementById('ai-final-wrap');
      document.getElementById('ai-final-label').textContent = aiState.mode === 'review' ? 'REVIEW RESULT' : 'FIX PLAN';
      document.getElementById('ai-final').textContent = aiState.resultText || '(no text returned)';
      fw.classList.remove('hidden');
      if (result === 'aborted') { aiLiveLine('■ aborted by operator.', 'err'); return; }
      if (result !== 'success' || !aiState.resultText) return;
      document.getElementById('ai-fullview-btn').classList.remove('hidden');
      if (aiState.mode === 'review') {
        document.getElementById('ai-post').classList.remove('hidden');
        document.getElementById('ai-approve').classList.remove('hidden');
      } else {
        document.getElementById('ai-apply').classList.remove('hidden');
      }
    }
  });
};

// ---- full-screen result view (with approve/apply) ----
const aiFullview = document.getElementById('ai-fullview');
document.getElementById('aifv-back').onclick = () => aiFullview.classList.add('hidden');
function openAiFullview() {
  document.getElementById('aifv-title').textContent = (aiState.mode === 'review' ? 'AI REVIEW' : 'FIX PLAN') + ` · PR #${aiState.pr.number}`;
  document.getElementById('aifv-body').textContent = aiState.resultText || '(no result)';
  const acts = document.getElementById('aifv-actions');
  acts.innerHTML = aiState.mode === 'review'
    ? '<button class="mini-btn" data-a="post">💬 Post as comment</button><button class="mini-btn" data-a="approve">✓ Approve PR</button>'
    : '<button class="mini-btn" data-a="apply">🔧 Apply Fix</button>';
  const post = acts.querySelector('[data-a="post"]'); if (post) post.onclick = () => document.getElementById('ai-post').click();
  const appr = acts.querySelector('[data-a="approve"]'); if (appr) appr.onclick = () => document.getElementById('ai-approve').click();
  const apply = acts.querySelector('[data-a="apply"]'); if (apply) apply.onclick = () => { aiFullview.classList.add('hidden'); document.getElementById('ai-apply').click(); };
  aiFullview.classList.remove('hidden');
}
document.getElementById('ai-fullview-btn').onclick = openAiFullview;
document.getElementById('ai-approve').onclick = async (e) => {
  await ghprReview(aiState.pr.number, 'approve', e.currentTarget);
  aiFullview.classList.add('hidden');
  aiModal.classList.add('hidden');
};

// review mode: post the result as a PR comment
document.getElementById('ai-post').onclick = async () => {
  if (!aiState.resultText) return;
  const btn = document.getElementById('ai-post');
  btn.disabled = true; btn.textContent = 'posting…';
  const r = await window.deck.prComment(gitRepo, aiState.pr.number, `### 🤖 AI Review\n\n${aiState.resultText}`);
  btn.disabled = false; btn.textContent = '💬 Post as comment';
  if (!r.ok) { await showAlert({ title: 'POST FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  plog('ok', `AI review posted on PR #${aiState.pr.number}.`);
  if (ghprCurrent && ghprCurrent.number === aiState.pr.number) ghprLoadDetail(ghprCurrent);
};

// fix mode: apply the plan — the same agent implements it for real, then we refresh
document.getElementById('ai-apply').onclick = async () => {
  if (!aiState.resultText) return;
  const agentId = document.getElementById('ai-agent').value;
  const model = document.getElementById('ai-model').value;
  const a = agents.find(x => x.id === agentId);
  if (R(agentId).running) { await showAlert({ title: 'AGENT BUSY', message: `${a.name} is already running.`, okText: 'OK' }); return; }
  document.getElementById('ai-live').innerHTML = '';
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-fullview-btn').classList.add('hidden');
  aiState.streamEl = null; aiState.runAgentId = agentId;
  aiSetRunning(true);
  aiLiveLine('applying the fix plan…', 'sys');
  const prompt = `Implement the following fix plan for real (you are out of plan mode). Make the edits, then verify.

=== FIX PLAN ===
${aiState.resultText}`;
  runAgent(agentId, prompt, false, false, {
    fresh: true, model,
    onEvent: aiOnEvent,
    onDone: (result) => {
      aiSetRunning(false);
      aiLiveLine(result === 'success' ? '✔ fix applied — review the changes in Source Control, then commit/push.' : (result === 'aborted' ? '■ aborted.' : '✗ fix run ended: ' + result), result === 'success' ? 'ok' : 'err');
      gitRefresh(); refreshWorkspace();
    }
  });
};

// create-PR dialog
const ghprModal = document.getElementById('ghpr-modal');
document.getElementById('ghpr-close').onclick = () => ghprModal.classList.add('hidden');
ghprModal.addEventListener('click', e => { if (e.target === ghprModal) ghprModal.classList.add('hidden'); });
document.getElementById('ghpr-refresh').onclick = (e) => { e.stopPropagation(); ghprRefresh(); };
// searchable head-branch picker for the New PR dialog
let ghprHead = '';   // chosen source branch
let ghprBranchList = [];   // all branch short-names (local + remote, deduped)
const ghprHeadMenu = document.getElementById('ghpr-head-menu');
function ghprRenderHeadList(q) {
  const list = document.getElementById('ghpr-head-list');
  list.innerHTML = '';
  const ql = (q || '').toLowerCase();
  const hits = ghprBranchList.filter(b => !ql || b.toLowerCase().includes(ql));
  if (!hits.length) { list.innerHTML = '<div class="git-none">no match</div>'; return; }
  for (const b of hits.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'sbranch-item' + (b === ghprHead ? ' sel' : '');
    row.textContent = b;
    row.onclick = () => {
      ghprHead = b;
      document.getElementById('ghpr-head-btn').textContent = '⎇ ' + b;
      ghprHeadMenu.classList.add('hidden');
    };
    list.appendChild(row);
  }
}
document.getElementById('ghpr-head-btn').onclick = (e) => {
  e.stopPropagation();
  const open = ghprHeadMenu.classList.toggle('hidden');
  if (!open) { const s = document.getElementById('ghpr-head-search'); s.value = ''; ghprRenderHeadList(''); s.focus(); }
};
document.getElementById('ghpr-head-search').oninput = (e) => ghprRenderHeadList(e.target.value);
document.getElementById('ghpr-head-search').onclick = (e) => e.stopPropagation();
document.addEventListener('click', (e) => { if (!ghprHeadMenu.classList.contains('hidden') && !e.target.closest('.sbranch')) ghprHeadMenu.classList.add('hidden'); });

document.getElementById('ghpr-new').onclick = async (e) => {
  e.stopPropagation();
  const st = await window.deck.gitStatus(gitRepo);
  const cur = st.ok ? st.branch : '';
  // gather every branch (local + remote short names, deduped), current first
  const b = await window.deck.gitBranches(gitRepo);
  const seen = new Set(); ghprBranchList = [];
  const add = n => { if (n && !seen.has(n)) { seen.add(n); ghprBranchList.push(n); } };
  if (cur) add(cur);
  for (const l of (b.ok ? b.local : [])) add(l.name);
  for (const rb of (b.ok ? b.remote : [])) if (!/\/HEAD$|->/.test(rb)) add(rb.replace(/^[^/]+\//, ''));
  ghprHead = cur;
  document.getElementById('ghpr-head-btn').textContent = cur ? '⎇ ' + cur : 'select branch…';
  // base options (everything except the head), default main/master/qa
  const sel = document.getElementById('ghpr-base-sel');
  sel.innerHTML = '';
  for (const name of ghprBranchList.filter(x => x !== cur)) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  const def = ghprBranchList.find(x => x === 'main') || ghprBranchList.find(x => x === 'master') || ghprBranchList.find(x => x === 'qa') || sel.options[0]?.value;
  if (def) sel.value = def;
  document.getElementById('ghpr-title').value = '';
  document.getElementById('ghpr-body').value = '';
  ghprHeadMenu.classList.add('hidden');
  ghprModal.classList.remove('hidden');
  document.getElementById('ghpr-title').focus();
};
// ---- PR conflict resolve flow: merge base→head, resolve, commit+push, create ----
let prConflictCtx = null;   // { base, head, title, body, files: [] }

function openNextPrConflict() {
  if (!prConflictCtx) return;
  if (!prConflictCtx.files.length) { finishPrConflict(); return; }
  const rel = prConflictCtx.files[0];
  const n = prConflictCtx.total - prConflictCtx.files.length + 1;
  openConflictResolver(rel, {
    progress: `PR conflict ${n}/${prConflictCtx.total} · ${prConflictCtx.head} ← ${prConflictCtx.base}`,
    aiRule: `This is a MERGE of "${prConflictCtx.base}" (INCOMING/theirs) into "${prConflictCtx.head}" (CURRENT/ours). For each conflict: if it touches OUR intended change on ${prConflictCtx.head}, keep CURRENT (ours win). If it is unrelated to our change (only their base update), take INCOMING (theirs). If both changes are needed and independent, take BOTH.`,
    after: () => { prConflictCtx.files.shift(); openNextPrConflict(); }
  });
}

async function finishPrConflict() {
  const ctx = prConflictCtx; prConflictCtx = null;
  toast('conflicts resolved — committing merge & pushing…');
  const c = await window.deck.gitCmd(gitRepo, 'commit', `Merge ${ctx.base} into ${ctx.head} (resolve conflicts)`);
  if (!c.ok) { await showAlert({ title: 'MERGE COMMIT FAILED', message: c.out, okText: 'OK' }); return; }
  const p = await pushOrPublish();
  if (!p.ok) { await showAlert({ title: 'PUSH FAILED', message: p.out, okText: 'OK' }); return; }
  const r = await window.deck.prCreate(gitRepo, { title: ctx.title, body: ctx.body, base: ctx.base, head: ctx.head });
  if (!r.ok) { await showAlert({ title: 'CREATE FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  toast(`✓ resolved + pushed + PR created: ${ctx.head} → ${ctx.base}`);
  gitRefresh(); ghprRefresh(); refreshWorkspace();
}

document.getElementById('ghpr-create-btn').onclick = async () => {
  const title = document.getElementById('ghpr-title').value.trim();
  if (!ghprHead) { await showAlert({ title: 'PICK A BRANCH', message: 'Choose the source branch to open the PR from.', okText: 'OK' }); return; }
  if (!title) { document.getElementById('ghpr-title').focus(); return; }
  const body = document.getElementById('ghpr-body').value;
  const base = document.getElementById('ghpr-base-sel').value;
  const btn = document.getElementById('ghpr-create-btn');
  btn.disabled = true; btn.textContent = 'checking conflicts…';
  const chk = await window.deck.prConflictCheck(gitRepo, base, ghprHead);
  if (chk.ok && chk.conflict) {
    btn.disabled = false; btn.textContent = 'Create PR';
    const proceed = await showAlert({
      title: 'MERGE CONFLICTS',
      message: `This PR (${ghprHead} → ${base}) has merge conflicts in ${chk.files.length} file(s). Merge ${base} into ${ghprHead} now so you can resolve them (AI or manual), then it auto-commits, pushes, and creates the PR.`,
      okText: 'RESOLVE NOW', cancelText: 'CANCEL', kind: 'warn',
      work: () => window.deck.prStartMerge(gitRepo, base, ghprHead)
    });
    if (proceed === false) return;
    if (!proceed || !proceed.ok) { toast('✗ ' + ((proceed && proceed.error) || 'could not start the merge'), false); return; }
    ghprModal.classList.add('hidden');
    if (!proceed.conflict) {   // merged clean unexpectedly — just commit/push/create
      prConflictCtx = { base, head: ghprHead, title, body, files: [], total: 0 };
      finishPrConflict();
    } else {
      prConflictCtx = { base, head: ghprHead, title, body, files: proceed.files.slice(), total: proceed.files.length };
      plog('info', `PR conflicts: ${proceed.files.length} file(s) to resolve, then commit + push + create.`);
      openNextPrConflict();
    }
    return;
  }
  // no conflict → create directly
  btn.textContent = 'creating…';
  const r = await window.deck.prCreate(gitRepo, { title, body, base, head: ghprHead });
  btn.disabled = false; btn.textContent = 'Create PR';
  if (!r.ok) { await showAlert({ title: 'CREATE FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  toast(`✓ PR created: ${ghprHead} → ${base}`);
  ghprModal.classList.add('hidden');
  ghprRefresh();
};

// collapsible sections (Staged / Changes / Conflicts / CI): click the header to
// hide or show its children. Action buttons inside the header keep working.
document.querySelectorAll('#git-panel .git-section > .git-sec-head').forEach(head => {
  head.classList.add('accordion');
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // let stage-all / refresh / etc. through
    head.parentElement.classList.toggle('collapsed');
  });
});

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
  renderConsoleChips();
}

function activateTerm(id) {
  termActive = id;
  for (const t of termTabs) t.pane.classList.toggle('hidden', t.id !== id);
  renderTermTabs();
  const t = tabOf(id);
  if (t) { try { t.fit.fit(); } catch {} t.xterm.focus(); }
}

// ===== "Analyze with AI" — floating button over a terminal selection =====
// highlight an error in the terminal → the button appears → one click sends the
// selection to GENERAL-OPS with simple diagnose-and-fix rules
const termAiBtn = document.createElement('button');
termAiBtn.id = 'term-ai-btn';
termAiBtn.className = 'hidden';
termAiBtn.textContent = '✨ Analyze with AI';
document.body.appendChild(termAiBtn);
let termAiSel = '';

function hideTermAi() { termAiBtn.classList.add('hidden'); }
function showTermAi(x, y) {
  termAiBtn.style.left = Math.max(8, Math.min(x, window.innerWidth - 160)) + 'px';
  termAiBtn.style.top = Math.max(8, y - 38) + 'px';
  termAiBtn.classList.remove('hidden');
}
document.addEventListener('mousedown', e => { if (e.target !== termAiBtn) hideTermAi(); });

termAiBtn.onclick = () => {
  const text = termAiSel;
  hideTermAi();
  if (!text.trim()) return;
  const agent = agents.find(a => a.id === 'def-general') || byRole('custom')[0] || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { toast('✗ ' + agent.name + ' is busy — try again shortly', false); return; }
  const prompt = `Analyze this terminal output the operator highlighted. Simple rules:
1) WHAT: the error/issue in one line (or "not an error" + what it means).
2) WHY: root cause in 1-2 lines.
3) FIX: the exact command(s) or edit to run, ready to copy. Prefer the smallest fix.
Do not explore the project unless strictly necessary. Max 10 lines total.

=== TERMINAL OUTPUT ===
${text.slice(0, 6000)}`;
  closeTerminalView();   // bring the console forward so the answer is visible
  plog('info', `✨ analyzing highlighted terminal output on ${agent.name}…`);
  runAgent(agent.id, prompt, false, false, { fresh: true, model: 'claude-sonnet-5' });
};

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
  // Clipboard, terminal-style: Ctrl+C copies the SELECTION (and falls through to
  // SIGINT when nothing is selected); Ctrl+V pastes. Ctrl+Shift+C/V also work.
  // cache the live selection — some keydowns fire after xterm clears it
  let lastSel = '';
  xt.onSelectionChange(() => { const s = xt.getSelection(); if (s) lastSel = s; });
  // selection made with the mouse → offer the AI analyzer right there
  pane.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      const s = xt.getSelection();
      if (s && s.trim().length >= 8) { termAiSel = s; showTermAi(e.clientX, e.clientY); }
      else hideTermAi();
    }, 30);
  });
  xt.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const c = e.ctrlKey || e.metaKey;
    if (!c) return true;
    // Ctrl+C / Ctrl+Shift+C: copy the selection; plain Ctrl+C with no selection
    // falls through so it still interrupts the running process.
    if (e.code === 'KeyC') {
      const sel = xt.getSelection() || lastSel;
      if (sel) { window.deck.clipboardWrite(sel); lastSel = ''; xt.clearSelection(); return false; }
      return !e.shiftKey;
    }
    // Ctrl+V: xterm's textarea receives the native paste event and feeds it
    // through onData already — injecting the clipboard here too pasted twice.
    // Just let the native path handle it.
    if (e.code === 'KeyV') return true;
    return true;
  });
  // right-click: copy selection if any, else paste — a mouse fallback that always works
  pane.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const sel = xt.getSelection() || lastSel;
    if (sel) { window.deck.clipboardWrite(sel); lastSel = ''; xt.clearSelection(); }
    else { const t = await window.deck.clipboardRead(); if (t) window.deck.termInput(id, t); }
  });
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
  setTermIconActive(true);
  renderConsoleChips();
}

function closeTerminalView() {
  // tabs keep their PTYs alive in the background — this only swaps the pane
  termView.classList.add('hidden');
  consoleFeed.classList.remove('hidden');
  setTermIconActive(false);
  syncPane();
  renderConsoleChips();
}

// #2 — reflect terminal-open in the top-right icon
function setTermIconActive(on) { document.getElementById('btn-term').classList.toggle('ico-active', on); }

// ===== Surface chips beside CENTRAL CONSOLE =====
// The main area shows ONE surface at a time (no split). When more than one is
// active — Console + Terminal + Explorer — chips let you switch and close each.
const SURFACE_META = {
  console: { icon: '◈', label: 'Console', closable: false },
  editor: { icon: '📄', label: 'Explorer', closable: true },
  terminal: { icon: '⌨', label: 'Terminal', closable: true }
};
function activeSurfaces() {
  const arr = ['console'];
  if (openFiles.length) arr.push('editor');
  if (termTabs.length) arr.push('terminal');
  return arr;
}
function currentSurface() {
  if (termOpen()) return 'terminal';
  if (!viewer.classList.contains('hidden')) return 'editor';
  return 'console';
}
function showSurface(name) {
  if (name === 'terminal') { openTerminal(); return; }
  termView.classList.add('hidden');
  setTermIconActive(false);
  if (name === 'editor' && openFiles.length) {
    paneOverride = 'editor';
    viewer.classList.remove('hidden');
    consoleFeed.classList.add('hidden');
  } else {
    paneOverride = 'console';
    viewer.classList.add('hidden');
    consoleFeed.classList.remove('hidden');
  }
  renderConsoleChips();
}
async function closeSurface(name) {
  if (name === 'terminal') {
    for (const t of [...termTabs]) closeTerm(t.id);
    closeTerminalView();
  } else if (name === 'editor') {
    for (const f of [...openFiles]) await closeFile(f.path);
    showSurface('console');
  }
  renderConsoleChips();
}
function renderConsoleChips() {
  const bar = document.getElementById('console-chips');
  if (!bar) return;
  const surfaces = activeSurfaces();
  if (surfaces.length <= 1) { bar.innerHTML = ''; bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const cur = currentSurface();
  bar.innerHTML = '';
  for (const s of surfaces) {
    const m = SURFACE_META[s];
    const chip = document.createElement('div');
    chip.className = 'cc-chip' + (s === cur ? ' active' : '');
    chip.innerHTML = `<span class="cc-label">${m.icon} ${m.label}</span>${m.closable ? '<b class="cc-x" title="Close">✕</b>' : ''}`;
    chip.querySelector('.cc-label').onclick = () => showSurface(s);
    const x = chip.querySelector('.cc-x');
    if (x) x.onclick = (e) => { e.stopPropagation(); closeSurface(s); };
    bar.appendChild(chip);
  }
}

document.getElementById('btn-term').onclick = () => (termOpen() ? closeTerminalView() : openTerminal());
document.getElementById('tv-close').onclick = closeTerminalView;
document.getElementById('tv-new-bash').onclick = () => newTerm('bash');
document.getElementById('tv-new-ps').onclick = () => newTerm('powershell');
document.getElementById('git-stage-all').onclick = () => gitDo('stage', '*');
document.getElementById('git-unstage-all').onclick = () => gitDo('unstage', '*');
document.getElementById('git-pull').onclick = () => gitDo('pull');

// commit like VS Code: if nothing is staged, stage everything first
// push; if the branch has no upstream yet, publish it (push -u origin <branch>)
async function pushOrPublish() {
  let r = await window.deck.gitCmd(gitRepo, 'push');
  if (!r.ok && /no upstream branch|set-upstream/i.test(r.out)) {
    const st = await window.deck.gitStatus(gitRepo);
    r = await window.deck.gitCmd(gitRepo, 'publish', st.branch || 'HEAD');
  }
  return r;
}

// ============================================================
// COMMIT FLOW — stateful modal that survives hook rejections:
// commit → (hook/check error shown inline) → 🔧 Fix with AI (streams live with a
// thinking indicator) → commit message again → retry. Only closes on success.
// ============================================================
const CMT_LABEL = { plain: 'COMMIT', amend: 'COMMIT (AMEND)', push: 'COMMIT & PUSH', sync: 'COMMIT & SYNC' };
const cmtModal = document.getElementById('cmt-modal');
const cmt = { kind: 'plain', running: false, aiAgentId: null, streamEl: null, thinkEl: null, gitEl: null, lastError: '', streamId: null, autoPush: false };

function cmtEl(id) { return document.getElementById(id); }
function cmtStepMark(step, cls) {
  const el = cmtModal.querySelector(`.cmt-step[data-step="${step}"]`);
  if (el) el.className = 'cmt-step ' + (cls || '');
}

// pull a diff to feed the message/PR generators (staged first, else all changes)
async function cmtChangeDiff() {
  let d = await window.deck.gitDiff(gitRepo, { staged: true });
  if (d.ok && d.diff && d.diff.trim()) return d.diff;
  d = await window.deck.gitDiff(gitRepo, {});
  return (d.ok && d.diff) ? d.diff : '';
}

// ✨ generate a concise commit message from the diff (Haiku)
async function cmtGenMessage() {
  const btn = cmtEl('cmt-gen-msg');
  const overlay = cmtEl('cmt-gen-overlay');
  const prev = btn.textContent; btn.disabled = true; btn.textContent = '⏳';
  overlay.classList.remove('hidden');            // spinner over the input
  cmtEl('cmt-msg').classList.add('generating');
  const end = () => { btn.disabled = false; btn.textContent = prev; overlay.classList.add('hidden'); cmtEl('cmt-msg').classList.remove('generating'); };
  const diff = await cmtChangeDiff();
  if (!diff.trim()) { end(); cmtEl('cmt-summary').textContent = 'no changes to summarize'; return; }
  const prompt = `Write a git commit message for this diff. One imperative subject line (<72 chars). If the change is non-trivial, add a blank line then 1-3 short bullet lines. Output ONLY the commit message — no quotes, no preamble.

=== DIFF ===
${diff.slice(0, 30000)}`;
  const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', gitRepo);
  end();
  if (r.ok && r.text) cmtEl('cmt-msg').value = r.text.replace(/^["'`]|["'`]$/g, '').trim();
  else cmtEl('cmt-summary').textContent = '✗ generate failed: ' + (r.error || 'no text');
}
document.getElementById('cmt-gen-msg').onclick = cmtGenMessage;

async function openCommitModal(kind) {
  cmt.kind = kind; cmt.running = false; cmt.lastError = ''; cmt.gitEl = null;
  cmt.autoPush = (kind === 'push' || kind === 'sync');
  const st = await window.deck.gitStatus(gitRepo);
  cmt.willStageAll = st.ok && !st.staged.length && (st.unstaged.length || st.untracked.length);
  cmt.branch = st.branch || '';
  const fileCount = cmt.willStageAll ? (st.unstaged.length + st.untracked.length) : (st.ok ? st.staged.length : 0);
  cmtEl('cmt-title').textContent = 'COMMIT · ' + (st.branch || '');
  cmtEl('cmt-summary').textContent = `${fileCount} file(s)${cmt.willStageAll ? ' — will stage all first' : ' staged'}`;
  cmtEl('cmt-msg').value = cmtEl('git-msg').value.trim();
  cmtEl('cmt-msg-block').classList.remove('hidden');
  cmtEl('cmt-pr-row').classList.add('hidden');
  cmtEl('cmt-error-wrap').classList.add('hidden');
  cmtEl('cmt-live-wrap').classList.add('hidden');
  cmtEl('cmt-live').innerHTML = '';
  for (const s of ['commit', 'push', 'pr']) cmtStepMark(s, '');
  cmtSetState('compose');
  cmtModal.classList.remove('hidden');
  cmtEl('cmt-msg').focus();
  // auto-generate the commit message from the changes when none was typed
  if (!cmtEl('cmt-msg').value.trim() && kind !== 'amend') cmtGenMessage();
}

// visible buttons per state
function cmtSetState(state) {
  cmt.state = state;
  const show = (id, on) => cmtEl(id).classList.toggle('hidden', !on);
  const dis = (id, on) => { cmtEl(id).disabled = on; };
  const busy = ['committing', 'pushing', 'fixing', 'creating'].includes(state);
  cmtEl('cmt-commit').classList.remove('btn-working');
  show('cmt-commit', state === 'compose' || state === 'error');
  show('cmt-push', state === 'committed');
  show('cmt-pr', state === 'pushed');
  show('cmt-close', state === 'done');
  show('cmt-fix', state === 'error');
  show('cmt-abort', state === 'fixing');
  show('cmt-cancel', state !== 'done');
  dis('cmt-cancel', busy);
  cmtEl('cmt-msg').disabled = busy || state !== 'compose' && state !== 'error';
  if (state === 'error') cmtEl('cmt-commit').textContent = '↻ Retry commit';
  if (state === 'compose') cmtEl('cmt-commit').textContent = '✓ ' + (CMT_LABEL[cmt.kind] || 'COMMIT');
}

// ----- live log (git process + AI process share the same panel) -----
function cmtLive(text, cls) {
  const live = cmtEl('cmt-live');
  const el = document.createElement('div');
  el.className = 'ai-line ' + (cls || '');
  el.textContent = text;
  live.appendChild(el);
  if (cmt.thinkEl) live.appendChild(cmt.thinkEl);
  live.scrollTop = live.scrollHeight;
  return el;
}
function cmtShowLive(label) {
  cmtEl('cmt-live-wrap').classList.remove('hidden');
  cmtEl('cmt-live-label').textContent = label;
}
// stream a git op's stdout/stderr live into the panel
async function cmtGitStream(op, arg) {
  cmt.streamId = uid(); cmt.gitEl = null;
  cmtLive(`$ git ${op}${arg && arg !== '*' ? ' ' + arg : ''}`, 'sys');
  const r = await window.deck.gitStream(gitRepo, op, arg, cmt.streamId);
  cmt.streamId = null; cmt.gitEl = null;
  return r;
}
// append raw git output as it arrives (routed from the global listener)
function cmtAppendGit(data) {
  const live = cmtEl('cmt-live');
  if (!cmt.gitEl) { cmt.gitEl = document.createElement('div'); cmt.gitEl.className = 'ai-line git'; live.appendChild(cmt.gitEl); }
  cmt.gitEl.textContent += String(data).replace(/\r(?!\n)/g, '\n');
  if (cmt.thinkEl) live.appendChild(cmt.thinkEl);
  live.scrollTop = live.scrollHeight;
}
window.deck.onGitStream(p => { if (p.streamId && p.streamId === cmt.streamId) cmtAppendGit(p.data); });

function cmtOnEvent(ev) {
  if (ev.kind === 'init') { cmt.streamEl = null; cmtLive(`▸ session ${String(ev.sessionId).slice(0, 8)} · ${ev.model}`, 'sys'); }
  else if (ev.kind === 'tool') {
    cmt.streamEl = null;
    let d = ''; try { const i = JSON.parse(ev.input); d = i.file_path || i.path || i.command || i.pattern || ''; } catch {}
    cmtLive(`⚙ ${ev.tool} ${String(d).slice(0, 90)}`, 'tool');
  } else if (ev.kind === 'text-delta') {
    if (!cmt.streamEl) cmt.streamEl = cmtLive('', 'txt');
    cmt.streamEl.textContent += ev.text;
    cmtEl('cmt-live').scrollTop = cmtEl('cmt-live').scrollHeight;
  } else if (ev.kind === 'text-end') { cmt.streamEl = null; }
  else if (ev.kind === 'result') { cmtLive(`◆ ${String(ev.subtype).toUpperCase()} · ${ev.numTurns} turns`, 'ok'); }
  else if (ev.kind === 'error') { cmtLive('⚠ ' + ev.error, 'err'); }
}

// ===== STEP 1: COMMIT (streams hook/test output live) =====
cmtEl('cmt-commit').onclick = async () => {
  if (cmt.running) return;
  const msg = cmtEl('cmt-msg').value.trim();
  if (!msg && cmt.kind !== 'amend') { cmtEl('cmt-summary').textContent = '⚠ commit message required'; cmtEl('cmt-msg').focus(); return; }
  cmt.running = true;
  cmtEl('cmt-error-wrap').classList.add('hidden');
  cmtEl('cmt-live').innerHTML = '';
  cmtShowLive('COMMIT PROCESS (hooks / tests run here)');
  cmtStepMark('commit', 'active');
  cmtSetState('committing');
  if (cmt.willStageAll) await cmtGitStream('stage', '*');
  const r = await cmtGitStream(cmt.kind === 'amend' ? 'amend' : 'commit', msg);
  cmt.running = false;
  if (!r.ok) {
    cmt.lastError = r.out || 'commit failed';
    cmtEl('cmt-error').textContent = cmt.lastError;
    cmtEl('cmt-error-wrap').classList.remove('hidden');
    cmtStepMark('commit', 'fail');
    cmtSetState('error');
    return;
  }
  cmtEl('git-msg').value = '';
  cmtLive('✔ committed', 'ok');
  cmtStepMark('commit', 'done');
  gitRefresh();
  if (cmt.autoPush) { cmtEl('cmt-push').click(); return; }   // Commit & Push / Sync
  cmtSetState('committed');   // shows the PUSH button
};

// ===== STEP 2: PUSH (streamed) =====
cmtEl('cmt-push').onclick = async () => {
  if (cmt.running) return;
  cmt.running = true;
  cmtShowLive('PUSH PROCESS');
  cmtStepMark('push', 'active');
  cmtSetState('pushing');
  if (cmt.kind === 'sync') await cmtGitStream('pull');
  let r = await cmtGitStream('push');
  if (!r.ok && /no upstream branch|set-upstream/i.test(r.out)) r = await cmtGitStream('publish', cmt.branch || 'HEAD');
  cmt.running = false;
  if (!r.ok) {
    cmt.lastError = r.out || 'push failed';
    cmtEl('cmt-error').textContent = cmt.lastError;
    cmtEl('cmt-error-wrap').classList.remove('hidden');
    cmtStepMark('push', 'fail');
    cmtLive('✗ push failed — fix and press Push again', 'err');
    cmtSetState('committed');   // let them retry Push
    return;
  }
  cmtLive('✔ pushed', 'ok');
  cmtStepMark('push', 'done');
  gitRefresh();
  await cmtPreparePR();
};

// ===== STEP 3: CREATE PR (pick base branch, AI-written description) =====
async function cmtPreparePR() {
  cmtEl('cmt-msg-block').classList.add('hidden');
  const msg = cmtEl('cmt-msg').value || '';
  cmtEl('cmt-pr-title').value = msg.split('\n')[0] || cmt.branch;
  cmtEl('cmt-pr-head').textContent = cmt.branch;
  const sel = cmtEl('cmt-pr-base-sel');
  sel.innerHTML = '<option>loading…</option>';
  cmtEl('cmt-pr-row').classList.remove('hidden');
  cmtStepMark('pr', 'active');
  cmtSetState('pushed');
  const b = await window.deck.gitBranches(gitRepo);
  const bases = [];
  const seen = new Set();
  for (const rb of (b.ok ? b.remote : [])) {
    const short = rb.replace(/^[^/]+\//, '');
    if (!/\/HEAD$|->/.test(rb) && short !== cmt.branch && !seen.has(short)) { seen.add(short); bases.push(short); }
  }
  for (const l of (b.ok ? b.local : [])) if (l.name !== cmt.branch && !seen.has(l.name)) { seen.add(l.name); bases.push(l.name); }
  sel.innerHTML = '';
  for (const name of bases) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  // default base: main → master → qa → first
  const def = bases.find(x => x === 'main') || bases.find(x => x === 'master') || bases.find(x => x === 'qa') || bases[0];
  if (def) sel.value = def;
  // auto-write the PR description from the branch's changes (editable)
  cmtGenPRDesc();
}

// ✨ AI-write the PR description (Haiku). Bug → "Issue:/Fix:", feature → explain.
async function cmtGenPRDesc() {
  const status = cmtEl('cmt-desc-status');
  const box = cmtEl('cmt-pr-desc');
  // lock the PR inputs + show a spinner overlay while the AI writes
  const locked = ['cmt-pr-desc', 'cmt-pr-title', 'cmt-pr-base-sel', 'cmt-gen-desc', 'cmt-pr'];
  const setLocked = on => locked.forEach(id => { const e = cmtEl(id); if (e) e.disabled = on; });
  setLocked(true);
  cmtEl('cmt-desc-overlay').classList.remove('hidden');
  box.classList.add('generating');
  status.textContent = '';
  const done = () => { setLocked(false); cmtEl('cmt-desc-overlay').classList.add('hidden'); box.classList.remove('generating'); };
  const base = cmtEl('cmt-pr-base-sel').value || 'main';
  // diff of this branch vs the base gives the reviewer-facing change set
  let d = await window.deck.gitDiff(gitRepo, { commit: `${base}...HEAD` });
  let diff = (d.ok && d.diff) ? d.diff : '';
  if (!diff.trim()) diff = await cmtChangeDiff();
  const prompt = `Write a pull-request description for these changes.

Decide the type from the diff and branch name "${cmt.branch}":
- If it is a BUG FIX, use EXACTLY this format:
Issue: <what was broken, 1-2 lines>
Fix: <what you changed to fix it, 1-2 lines>
- If it is a FEATURE, do NOT use that format — just explain the feature clearly in 2-4 lines (what it does, how to use it).

Keep it concise. Output ONLY the description, no title, no preamble, no markdown headers.

=== DIFF (${cmt.branch} vs ${base}) ===
${diff.slice(0, 30000)}`;
  const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', gitRepo);
  done();
  if (r.ok && r.text) { box.value = r.text.trim(); status.textContent = '✓ AI draft — edit freely'; }
  else { status.textContent = '✗ ' + (r.error || 'generation failed'); }
}
document.getElementById('cmt-gen-desc').onclick = cmtGenPRDesc;

cmtEl('cmt-pr').onclick = async () => {
  if (cmt.running) return;
  const title = cmtEl('cmt-pr-title').value.trim() || cmt.branch;
  const bodyDesc = cmtEl('cmt-pr-desc').value.trim();
  const base = cmtEl('cmt-pr-base-sel').value;
  if (!base) { cmtLive('✗ pick a base branch', 'err'); return; }
  cmt.running = true;
  cmtShowLive('CREATE PR PROCESS');
  cmtSetState('creating');
  // gh pr create isn't streamed — show a thinking indicator while it runs
  cmt.thinkEl = document.createElement('div'); cmt.thinkEl.className = 'ai-line ai-thinking'; cmt.thinkEl.textContent = '⏳ creating PR';
  cmtEl('cmt-live').appendChild(cmt.thinkEl);
  cmtLive(`$ gh pr create --base ${base} --head ${cmt.branch}`, 'sys');
  const r = await window.deck.prCreate(gitRepo, { title, body: bodyDesc, base });
  if (cmt.thinkEl) { cmt.thinkEl.remove(); cmt.thinkEl = null; }
  cmt.running = false;
  if (!r.ok) {
    cmtLive('✗ ' + (r.error || r.out || 'PR create failed'), 'err');
    cmtStepMark('pr', 'fail');
    cmtSetState('pushed');   // retry
    return;
  }
  cmt.prUrl = (r.out.match(/https?:\/\/\S+/) || [])[0] || '';
  cmtLive('✔ PR created' + (cmt.prUrl ? ' · ' + cmt.prUrl : ''), 'ok');
  cmtStepMark('pr', 'done');
  ghprRefresh();
  cmtSetState('done');
};

// 🔧 Fix with AI — reads the failure output, fixes it, streams here with thinking
cmtEl('cmt-fix').onclick = async () => {
  const agent = byRole('senior')[0] || agents.find(a => a.id === 'def-general') || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { cmtLive('✗ ' + agent.name + ' is busy', 'err'); return; }
  cmt.aiAgentId = agent.id; cmt.streamEl = null;
  cmtShowLive(`🔧 FIXING WITH AI · ${agent.name}`);
  cmtLive('— analyzing the failure —', 'sys');
  cmtSetState('fixing');
  cmt.thinkEl = document.createElement('div');
  cmt.thinkEl.className = 'ai-line ai-thinking';
  cmt.thinkEl.textContent = '⏳ thinking';
  cmtEl('cmt-live').appendChild(cmt.thinkEl);
  const prompt = `A git commit was BLOCKED by a pre-commit hook (lint/tests/etc). Below is the FULL output, including any failing test details. Diagnose the cause and FIX it so the hook passes — write or repair the required tests, satisfy the linter, whatever it demands. Do NOT run "git commit" yourself; the app retries after you finish. Keep changes minimal and in scope.

=== HOOK / TEST OUTPUT ===
${cmt.lastError.slice(0, 9000)}`;
  runAgent(agent.id, prompt, false, false, {
    fresh: true,
    onEvent: cmtOnEvent,
    onDone: (result) => {
      if (cmt.thinkEl) { cmt.thinkEl.remove(); cmt.thinkEl = null; }
      cmt.aiAgentId = null;
      if (result === 'aborted') { cmtLive('■ fix aborted.', 'err'); cmtSetState('error'); return; }
      cmtLive(result === 'success' ? '✔ fix complete — press ↻ Retry commit.' : '✗ fix ended: ' + result, result === 'success' ? 'ok' : 'err');
      cmtEl('cmt-summary').textContent = 'AI applied a fix — retry the commit';
      cmtSetState('error');
      gitRefresh();
    }
  });
};

cmtEl('cmt-abort').onclick = () => { if (cmt.aiAgentId) stopAgent(cmt.aiAgentId); };
cmtEl('cmt-close').onclick = () => cmtModal.classList.add('hidden');
cmtEl('cmt-cancel').onclick = () => { if (!cmt.running && !cmt.aiAgentId) cmtModal.classList.add('hidden'); };
cmtModal.addEventListener('click', e => { if (e.target === cmtModal && !cmt.running && !cmt.aiAgentId) cmtModal.classList.add('hidden'); });

const commitMenu = document.getElementById('commit-menu');
document.getElementById('git-commit').onclick = () => openCommitModal('plain');
document.getElementById('git-commit-more').onclick = (e) => {
  e.stopPropagation();
  commitMenu.classList.toggle('hidden');
  if (!commitMenu.classList.contains('hidden')) fitDropUp(commitMenu, document.getElementById('git-commit-more'));
};
commitMenu.querySelectorAll('.cm-item').forEach(item => {
  item.onclick = async () => {
    commitMenu.classList.add('hidden');
    if (item.dataset.act) { await gitDo(item.dataset.act); refreshWorkspace(); return; }   // stash
    openCommitModal(item.dataset.kind);
  };
});
document.addEventListener('click', () => commitMenu.classList.add('hidden'));
document.getElementById('git-msg').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') openCommitModal('plain');
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
// work: async fn — run INSIDE the modal on OK: buttons lock, the OK button shows
// workingText until it finishes, then the modal closes resolving work's result.
let alertBusy = false;
function showAlert({ title, message, okText = 'OK', cancelText = null, kind = 'warn', work = null, workingText = '⏳ WORKING…' }) {
  const card = alertModal.querySelector('.modal-card');
  card.className = 'modal-card alert-card ' + kind;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-msg').textContent = message;

  const ok = document.getElementById('alert-ok');
  const cancel = document.getElementById('alert-cancel');
  ok.textContent = okText;
  ok.disabled = false; cancel.disabled = false;
  ok.className = 'btn ' + (kind === 'danger' ? 'btn-danger' : 'btn-launch');
  cancel.textContent = cancelText || 'CANCEL';
  cancel.classList.toggle('hidden', !cancelText);

  ok.onclick = async () => {
    if (!work) { closeAlert(true); return; }
    alertBusy = true;
    ok.disabled = true; cancel.disabled = true;
    ok.textContent = workingText;
    ok.classList.add('btn-working');
    let res;
    try { res = await work(); } catch (e) { res = { ok: false, error: String(e && e.message ? e.message : e) }; }
    alertBusy = false;
    ok.classList.remove('btn-working');
    closeAlert(res === undefined ? true : res);
  };
  cancel.onclick = () => { if (!alertBusy) closeAlert(false); };

  alertModal.classList.remove('hidden');
  ok.focus();
  return new Promise(res => { alertResolve = res; });
}

alertModal.addEventListener('click', e => { if (e.target === alertModal && !alertBusy) closeAlert(false); });

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

// git status decoration for the tree: normalized-absolute path -> 'conflict' |
// 'modified' | 'untracked'. Built from every repo's status in gitRefresh.
const exStatus = new Map();
function exNorm(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function buildExStatus(all) {
  exStatus.clear();
  const set = (repo, rel, cls, force) => {
    const key = exNorm(repo + '/' + String(rel).replace(/"/g, ''));
    if (force || !exStatus.has(key)) exStatus.set(key, cls);
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
  exTree.querySelectorAll('.ex-row.is-file').forEach(row => {
    row.classList.remove('gs-conflict', 'gs-modified', 'gs-untracked');
    const badge = row.querySelector('.ex-gs'); if (badge) badge.remove();
    const cls = exStatus.get(exNorm(row.dataset.file || row.title));
    if (!cls) return;
    row.classList.add('gs-' + cls);
    const b = document.createElement('span');
    b.className = 'ex-gs gs-' + cls;
    b.textContent = cls === 'conflict' ? '!' : cls === 'untracked' ? 'U' : 'M';
    row.appendChild(b);
  });
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
  decorateExplorer();
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
  setTermIconActive(false);
  termView.classList.add('hidden');
  renderViewer();
  renderConsoleChips();
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
