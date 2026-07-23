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
- Keep the reply focused, but ALWAYS explain your reasoning and decisions clearly — state what you did, what you found, and WHY. The operator reads this reply; never go silent or reply with just a status word.
- TOPIC MEMORY (shared brain at .loveai/memory/topics/<topic>.md, one file per feature): relevant topic(s) are inlined in your prompt. Trust fresh memory; for a [STALE] topic re-read ONLY its listed changed files. AFTER your work, if you touched or learned a feature's flow, create/update its topic file — Line1 "# <topic>", Line2 "keywords: ...", Line3 "files: <exact project-relative paths the feature depends on>", blank line, then a dot-by-dot flow (entry points, paths, key functions, steps, gotchas). Keep it ONE feature, <= ~150 lines, deduped; update the files: list when you change what the feature spans. This is how the whole team avoids re-exploring next time.`;

const RULES = {
  prompt: `You are the PROMPT ENGINEER of a pipeline (you -> Senior Engineer(s) -> Reviewer). Operator gives an ISSUE; you never code fixes.

TOPIC MEMORY (.loveai/memory/topics/<topic>.md) — your long-term brain, split by feature (login, booking, payments, ...):
- The topic(s) relevant to THIS issue are inlined below (with a MEMORY INDEX of all topics). TRUST fresh memory as your first source of truth — do NOT re-explore what it records; go straight to the few files it points to.
- If a topic is marked [STALE], the listed files changed since it was written: re-read ONLY those files, then refresh that topic. Do not re-read the rest.
- AFTER you finish: create or update the topic file for this feature. Format EXACTLY:
  Line 1: "# <topic>"  (e.g. "# login")
  Line 2: "keywords: <comma-separated terms an operator might use — login, sign in, auth, session, token>"
  Line 3: "files: <comma-separated EXACT project-relative paths this feature depends on>"
  Line 4: blank
  Then a dot-by-dot explanation: entry points, exact paths, key functions/symbols, the step-by-step flow, data shapes, and gotchas — enough that next time you need zero exploration.
- Keep each topic ONE feature and <= ~150 lines. Extend an existing topic instead of duplicating. The "files:" line is what powers staleness — list every file the feature truly depends on.

JOB:
1. Locate the exact files/functions/root cause (memory-first, then map, minimal reads).
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
2. Review ONLY changed files + their direct callers for: correctness bugs/regressions (edge cases, null handling, async races, broken contracts), MVVM violations (views: no logic; viewmodels: no UI; models pure), dead code/unused imports, oversized additions (fn >~50 lines / file >~300), and scope compliance (out-of-SCOPE change = automatic finding). If your task prompt gives a SCOPE checkpoint ref, determine "changed" from 'git diff <ref> -- <file>' — NOT from 'git diff HEAD' or the raw working tree. A dirty working tree can carry unrelated uncommitted edits left over from an earlier, unrelated session; anything already present at the checkpoint ref predates this task and is never a scope finding, even if a blanket diff shows it.
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
  { id: 'def-prompt-eng', name: 'BRAINX', role: 'prompt', model: 'claude-opus-4-8', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.prompt },
  { id: 'def-senior-eng-01', name: 'BACKEND', role: 'senior', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.senior },
  { id: 'def-uiux-eng', name: 'FRONTEND', role: 'uiux', model: 'claude-sonnet-5', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.uiux },
  { id: 'def-reviewer-eng', name: 'QA', role: 'reviewer', model: 'claude-opus-4-8', perm: 'bypassPermissions', lean: true, cwd: '', rules: RULES.reviewer },
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
// Global reasoning-effort setting — applies to the current session and every
// agent (read inside runAgent(), never per-agent) — see [[chat-composer]].
// The list of levels comes from Claude itself (the agent SDK reports the
// current model's supportedEffortLevels): if Claude changes its reasoning
// options, this dropdown follows. We only attach presentation (icon + blurb);
// the level VALUES are Claude's. 'auto' is our own "no override" entry — the
// agent then runs at Claude's own default.
const EFFORT_AUTO = { value: 'auto', dot: '◇', label: 'EFFORT: AUTO',
  sub: 'Claude default — model decides' };
// icon + one-line blurb per known level; unknown/new levels get a generic look
const EFFORT_META = {
  low:    { dot: '◔', label: 'LOW',    sub: 'minimal reasoning · fastest' },
  medium: { dot: '◑', label: 'MEDIUM', sub: 'moderate reasoning' },
  high:   { dot: '◕', label: 'HIGH',   sub: 'deep reasoning' },
  xhigh:  { dot: '◉', label: 'XHIGH',  sub: 'deeper — best for coding' },
  max:    { dot: '●', label: 'MAX',    sub: 'maximum reasoning' },
};
function effortMeta(v) {
  return EFFORT_META[v]
    || { dot: '◆', label: String(v).toUpperCase(), sub: 'reasoning effort' };
}
// fallback used only if the SDK query fails (offline / older CLI)
const EFFORT_FALLBACK = ['low', 'medium', 'high', 'xhigh', 'max'];
// built at startup from Claude's reported levels; 'auto' is always first
let EFFORT_LEVELS = [EFFORT_AUTO,
  ...EFFORT_FALLBACK.map(v => ({ value: v, ...effortMeta(v) }))];
// only these are passed to the agent as a real effort override ('auto' is not)
let EFFORT_VALUES = EFFORT_FALLBACK.slice();

// Claude's level list rarely changes, so we cache it and only re-ask the SDK
// once a week — spawning the CLI on every launch just to read a static list
// would be wasteful. Same idea as the CLI caching its model catalog.
const EFFORT_CACHE_KEY = 'effortLevels.cache';
const EFFORT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;   // 7 days

function applyEffortLevels(levels) {
  EFFORT_VALUES = levels.slice();
  EFFORT_LEVELS = [EFFORT_AUTO, ...levels.map(v => ({ value: v, ...effortMeta(v) }))];
}

// Rebuild the list from cache if it's fresh; otherwise re-fetch from Claude
// and refresh the cache (falling back to the built-in list on any failure).
async function loadEffortLevels() {
  try {
    const c = JSON.parse(localStorage.getItem(EFFORT_CACHE_KEY) || 'null');
    if (c && Array.isArray(c.levels) && c.levels.length
        && (Date.now() - c.at) < EFFORT_CACHE_TTL) {
      applyEffortLevels(c.levels);
      return;                                        // cache still fresh
    }
  } catch { /* bad cache — fall through and re-fetch */ }

  try {
    const r = await window.deck.effortLevels();
    if (r && r.ok && Array.isArray(r.levels) && r.levels.length) {
      applyEffortLevels(r.levels);
      localStorage.setItem(EFFORT_CACHE_KEY,
        JSON.stringify({ at: Date.now(), levels: r.levels }));
    }
  } catch { /* keep the fallback list */ }
}

function getEffort() { return localStorage.getItem('effortLevel') || 'auto'; }
function setEffort(v) { localStorage.setItem('effortLevel', v); }

const TOOL_ICON = {
  Bash: '⌨', PowerShell: '⌨', Read: '📄', Edit: '✏', Write: '✏', MultiEdit: '✏',
  Glob: '🔎', Grep: '🔎', WebSearch: '🌐', WebFetch: '🌐', Task: '🤖', Agent: '🤖', TodoWrite: '☑'
};
// rotating friendly lead-ins so a run of tool calls reads like a person
// narrating their work ("Let me check…", "Now looking at…") instead of a
// robotic "Read <path>" list. Rotated by narrTick for light variety.
const READ_LEADS = ['Let me check', 'Reading', 'Now looking at', 'Checking'];
const FIND_LEADS = ['Searching for', 'Looking for', 'Hunting for'];
let narrTick = 0;

// ===== State =====
// ============================================================
// WORKSPACES — each opened project is a workspace with its own
// roster + path + sessions. Phase 1 always has exactly one active
// workspace; the rail/switcher (Phase 2) lets you open more.
// The legacy globals `agents` and `projectDir` are kept as live
// references into the ACTIVE workspace, so the rest of the app reads
// and writes them exactly as before — every access sees the active
// project, and `save()` persists back through the workspace.
// ============================================================
const WS_COLORS = ['#6ea8fe', '#7ee787', '#ffa657', '#d2a8ff',
                   '#ff7b9c', '#79c0ff', '#f0a020', '#56d4bc'];
const WORKSPACES_KEY = 'workspaces';
const ACTIVE_WS_KEY = 'activeWorkspaceId';

// which built-in default an agent represents — matched by its stable `defId`
// tag, an exact id, or an id that was suffixed off a default id (freshRoster).
// Returns null for user-created (custom) agents.
const DEFAULT_IDS = DEFAULT_AGENTS.map(d => d.id);
function canonicalDefaultId(a) {
  if (a.defId && DEFAULT_IDS.includes(a.defId)) return a.defId;
  return DEFAULT_IDS.find(id => a.id === id || String(a.id).startsWith(id + '-')) || null;
}

// one-time roster rename: old stock name/model -> current DEFAULT_AGENTS
// name/model, so existing saved workspaces pick up a roster rename too.
// Only migrates agents still on their ORIGINAL stock value — an operator
// who already renamed/re-modeled the agent themselves is left alone.
const LEGACY_DEFAULTS = {
  'def-prompt-eng': { name: 'PROMPT-ENGINEER', model: 'claude-fable-5' },
  'def-senior-eng-01': { name: 'SENIOR-ENG-01' },
  'def-uiux-eng': { name: 'UIUX-ENGINEER' },
  'def-reviewer-eng': { name: 'REVIEWER-ENGINEER' },
};

// merge app-managed defaults into a roster + backfill flags. Reused when a new
// workspace is opened so every project starts from the same baseline line-up.
// De-duplicates managed defaults (heals the old clone-on-reload bug) and stamps
// each with a stable `defId` so its identity survives id-suffixing.
function normalizeRoster(roster) {
  const list = Array.isArray(roster) ? roster : [];
  const seen = new Map();   // canonical default id -> the kept agent
  const kept = [];
  for (const a of list) {
    const canon = canonicalDefaultId(a);
    if (canon) {
      if (seen.has(canon)) continue;   // a duplicate of a default we already kept
      a.defId = canon;                 // stamp identity for future loads
      seen.set(canon, a);
    }
    kept.push(a);
  }
  // ensure every default exists, and keep app-managed fields current
  for (const d of DEFAULT_AGENTS) {
    const existing = seen.get(d.id);
    if (existing) {
      if (!existing.role) existing.role = d.role;
      // def-* agents are app-managed: keep their rules current with this build
      // (RULES gains new directives over time, e.g. IMPLEMENT-MODEL routing)
      if (d.rules) existing.rules = d.rules;
      if (existing.lean === undefined) existing.lean = d.lean;
      // migrate stock name/model forward if the operator never customized it
      const legacy = LEGACY_DEFAULTS[d.id];
      if (legacy) {
        if (legacy.name && existing.name === legacy.name) existing.name = d.name;
        if (legacy.model && existing.model === legacy.model) existing.model = d.model;
      }
    } else {
      kept.push({ ...d, defId: d.id });
    }
  }
  // agents saved by earlier builds have no lean flag — default by role
  for (const a of kept) {
    if (a.lean === undefined) {
      a.lean = ['prompt', 'senior', 'uiux', 'reviewer', 'indexer'].includes(a.role);
    }
  }
  return kept;
}

function wsBaseName(p) {
  if (!p) return 'Workspace';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// Load the workspaces, or migrate the old single-project globals
// (`agents`, `projectDir`) into workspaces[0] the first time.
function loadWorkspaces() {
  let list = null;
  try { list = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || 'null'); } catch {}
  if (Array.isArray(list) && list.length) {
    for (const w of list) w.agents = normalizeRoster(w.agents);
    return list;
  }
  // ---- one-time migration from the legacy single-project keys ----
  let legacyAgents = [];
  try { legacyAgents = JSON.parse(localStorage.getItem('agents') || '[]'); } catch {}
  // earlier builds saved agents with perm:'acceptEdits', which hangs on the
  // first Bash/exec (no permission-prompt UI). Upgrade to bypassPermissions.
  if (!localStorage.getItem('permMigrated')) {
    for (const a of legacyAgents) if (a.perm === 'acceptEdits') a.perm = 'bypassPermissions';
    localStorage.setItem('permMigrated', '1');
  }
  // the INDEXER agent was retired — drop the app-managed default copy.
  if (!localStorage.getItem('indexerRemoved')) {
    legacyAgents = legacyAgents.filter(a => a.id !== 'def-indexer');
    localStorage.setItem('indexerRemoved', '1');
  }
  const legacyPath = localStorage.getItem('projectDir') || '';
  return [{
    id: uid(),
    name: wsBaseName(legacyPath),
    path: legacyPath,
    color: WS_COLORS[0],
    order: 0,
    agents: normalizeRoster(legacyAgents)
  }];
}

let workspaces = loadWorkspaces();
let activeWorkspaceId = localStorage.getItem(ACTIVE_WS_KEY) || workspaces[0].id;
if (!workspaces.some(w => w.id === activeWorkspaceId)) activeWorkspaceId = workspaces[0].id;
saveWorkspaces();   // persist any one-time migrations (name/model upgrades)

function ws() {
  return workspaces.find(w => w.id === activeWorkspaceId) || workspaces[0];
}
// persist all workspaces (ephemeral agents are never written to disk)
function saveWorkspaces() {
  try {
    const serial = workspaces.map(w => ({
      ...w,
      agents: (w.agents || []).filter(a => !a.ephemeral)
    }));
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(serial));
  } catch {}
  localStorage.setItem(ACTIVE_WS_KEY, activeWorkspaceId);
}
// reassign the active roster AND write it back through the workspace,
// so `agents = agents.filter(...)` style updates stay in sync.
function setAgents(next) {
  agents = next;
  ws().agents = next;
}

// legacy live references into the ACTIVE workspace
let agents = ws().agents;
let projectDir = ws().path || '';

// runtime per agent: { running, runId, sessionId, lastResult, status }
const rt = {};
let editingId = null;
let feedFilter = null; // agentId or null = all
const streamEls = {};  // agentId -> current streaming feed element
const toolRowEls = {}; // tool_use id -> its console row, so its result chip lands there
const runDoneCallbacks = {};  // runId -> one-shot (result, finalText) callback
const runEventSinks = {};     // runId -> per-event sink (streams a run into a modal)
// runId -> (sessionId) callback fired the INSTANT the session id is known (the
// 'init' event), NOT at graceful 'done'. A run killed mid-flight — the operator
// restarting the app because a stop button hung, a crash — never emits 'done',
// so an onDone-only persist would drop the session linkage and the next message
// would start cold with no context. Persisting on init keeps the thread intact.
const runSessionCallbacks = {};

const modal = document.getElementById('modal');
// the VISIBLE console — always shows the active workspace's feed. Background
// projects keep their .ev nodes in detached buffers (feedBuf) so their agents
// can stream off-screen and be restored intact when you switch back.
const consoleFeed = document.getElementById('console-feed');
// the "SYSTEMS NOMINAL" empty state, captured before anything removes it
const FEED_EMPTY_HTML = consoleFeed.innerHTML;

// Auto-scroll only while the user is at (or near) the bottom already — new
// activity must never yank the view out from under someone reading history.
// Scrolling up disengages the stick; scrolling back to the bottom re-engages it.
let feedStuck = true;
const FEED_STICK_PX = 40;
consoleFeed.addEventListener('scroll', () => {
  feedStuck = consoleFeed.scrollHeight - consoleFeed.scrollTop - consoleFeed.clientHeight
    < FEED_STICK_PX;
});
function pinFeedToBottom() {
  if (feedStuck) consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

// ---- Phase 3: route each run's output to the project that owns it ----
const feedBuf = {};   // wsId -> detached <div> holding that project's .ev nodes
const runWs = {};     // runId  -> wsId that started the run
const agentWs = {};   // agentId -> wsId (set when a run starts; survives cleanup)

// find an agent by id across ALL projects (the active `agents` array only
// holds the current project's roster, but a background run needs its name)
function findAgent(agentId) {
  for (const w of workspaces) {
    const a = (w.agents || []).find(x => x.id === agentId);
    if (a) return a;
  }
  return null;
}

// which workspace owns this agent's output — set at run start, else found in a
// roster, else the active project. Keeps a background agent's stream in its
// own console instead of leaking into whatever project is on screen.
function wsForAgent(agentId) {
  if (agentWs[agentId] && workspaces.some(w => w.id === agentWs[agentId])) {
    return agentWs[agentId];
  }
  const owner = workspaces.find(w => (w.agents || []).some(a => a.id === agentId));
  return owner ? owner.id : activeWorkspaceId;
}
// the detached buffer div for a workspace (created on first use)
function getFeedBuf(wsId) {
  if (!feedBuf[wsId]) feedBuf[wsId] = document.createElement('div');
  return feedBuf[wsId];
}
// the container a project's output should append to: the visible feed when
// it's the active project, otherwise its off-screen buffer.
function feedElForWs(wsId) {
  return wsId === activeWorkspaceId ? consoleFeed : getFeedBuf(wsId);
}
// the container an agent's output should append to: the visible feed when its
// project is active, otherwise that project's off-screen buffer.
function feedElFor(agentId) {
  return feedElForWs(wsForAgent(agentId));
}

function save() {
  ws().agents = agents;   // re-link in case the roster was reassigned
  saveWorkspaces();
  // mirror the active roster to the legacy key for safe rollback to a
  // single-project build (Phase 1 keeps both in sync)
  localStorage.setItem('agents', JSON.stringify(agents.filter(a => !a.ephemeral)));
}
function uid() { return Math.random().toString(36).slice(2, 10); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function R(id) { return rt[id] || (rt[id] = { running: false, sessionId: null, status: 'standing by' }); }

// ===== Shared deck session (one Claude CLI session per project — context intact across agents) =====
function sessKey() { return 'deckSession:' + (projectDir || 'default'); }
function getSession() { return localStorage.getItem(sessKey()) || null; }
function setSession(id) { if (id) localStorage.setItem(sessKey(), id); }
function clearSession() {
  localStorage.removeItem(sessKey());
  localStorage.removeItem(sessModelKey());
  localStorage.removeItem(sessCwdKey());
}

// model that owns the current shared session (for fork-on-switch, task-01)
function sessModelKey() { return 'deckSessionModel:' + (projectDir || 'default'); }
function getSessionModel() { return localStorage.getItem(sessModelKey()) || null; }
function setSessionModel(m) { if (m) localStorage.setItem(sessModelKey(), m); }

// cwd the shared session was CREATED under — the Agent SDK stores each session
// under a project slug derived from the run cwd, so a follow-up must resume with
// the SAME cwd or the CLI can't find the id and reports a spurious stale.
function sessCwdKey() { return 'deckSessionCwd:' + (projectDir || 'default'); }
function getSessionCwd() { return localStorage.getItem(sessCwdKey()) || null; }
function setSessionCwd(cwd) { if (cwd) localStorage.setItem(sessCwdKey(), cwd); }

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
  fillAdTarget();
  renderChatList();
}

const ROLE_LABEL = { prompt: 'PROMPT ENGINEER', senior: 'SENIOR ENGINEER', uiux: 'UI/UX ENGINEER', reviewer: 'REVIEWER', custom: 'OPERATIVE', indexer: 'INDEXER' };

function renderRoster() {
  const roster = document.getElementById('roster');
  roster.innerHTML = '';
  for (const a of agents) {
    if (a.ephemeral) continue;
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
      setAgents(agents.filter(x => x.id !== a.id));
      if (feedFilter === a.id) feedFilter = null;
      save(); render(); applyFilter();
    };
    el.onclick = () => openModal(a.id);   // in Settings the card configures, not chats
    roster.appendChild(el);
  }
}

// an on-demand, hidden agent that just runs a chosen model (no persona/roster
// entry). Reused across sends so it doesn't spawn duplicates.
function ensureModelAgent(model) {
  // namespaced per project — a bare-model id shared across workspaces would
  // make their "is it running" state collide (same id -> same rt[] entry),
  // showing every other project as busy the moment ANY of them used this model.
  const id = 'eph-model-' + activeWorkspaceId + '-' + model;
  let a = agents.find(x => x.id === id);
  if (!a) {
    a = {
      id, name: MODEL_LABELS[model] || model, role: 'custom', model,
      cwd: projectDir || '', perm: 'bypassPermissions', lean: true,
      rules: '', ephemeral: true
    };
    agents.push(a);
  } else {
    a.cwd = projectDir || a.cwd;
  }
  return id;
}

// ============================================================
// Chat sessions — ChatGPT-style, per-workspace, fully isolated.
// Each chat owns a UNIQUE hidden agent id ('chat-<id>'), so its feed rows,
// run state and SDK session never merge with another chat's. The chat's own
// sdkSessionId lives on the chat object (persisted), NOT in the shared store.
// ============================================================
let activeChatId = null;
// chat agent ids whose stored transcript is being replayed right now — the
// chat row shows its spinner while this is in flight (see openChatSession)
const hydratingChats = new Set();

function chatList() { return ws().chats || (ws().chats = []); }
function saveChats() { saveWorkspaces(); }
function findChat(id) { return chatList().find(c => c.id === id) || null; }

// the roster agent a chat clones its persona from (null for a bare-model chat)
function chatSourceAgent(chat) {
  if (!chat.target || chat.target.startsWith('model:') || chat.target === '__pipeline__') {
    return null;
  }
  return agents.find(x => x.id === chat.target && !x.ephemeral) || null;
}

// materialize (or refresh) a chat's hidden agent. Ephemeral agents are stripped
// on save, so this must run again on every load/switch to restore isolation.
function ensureChatAgent(chat) {
  const id = 'chat-' + chat.id;
  const src = chatSourceAgent(chat);
  const model = chat.model || (src && src.model) || 'claude-sonnet-5';
  let a = agents.find(x => x.id === id);
  if (!a) {
    a = {
      id, name: chat.title || 'Chat', model,
      role: src ? src.role : 'custom',
      cwd: projectDir || '', perm: 'bypassPermissions', lean: true,
      rules: src ? (src.rules || '') : '', ephemeral: true
    };
    if (src && src.extraRules) a.extraRules = src.extraRules;
    agents.push(a);
  } else {
    a.cwd = projectDir || a.cwd;
    a.model = model;
    a.name = chat.title || a.name;
  }
  return id;
}

function chatTargetLabel(chat) {
  if (chat.target && chat.target.startsWith('model:')) {
    const m = chat.target.slice('model:'.length);
    return MODEL_LABELS[m] || m;
  }
  const src = chatSourceAgent(chat);
  return src ? src.name : (MODEL_LABELS[chat.model] || chat.model || 'chat');
}

function renderChatList() {
  const box = document.getElementById('chat-list');
  if (!box) return;
  const chats = chatList();
  chats.forEach(ensureChatAgent);   // restore hidden agents after a reload
  box.innerHTML = '';
  for (const chat of chats) {
    const running = R('chat-' + chat.id).running;
    const loading = hydratingChats.has('chat-' + chat.id);
    const el = document.createElement('div');
    el.className = 'chat-row'
      + (running ? ' running' : '')
      + (loading ? ' loading' : '')
      + (chat.id === activeChatId ? ' active' : '');
    el.innerHTML = `
      <span class="cr-spin"></span>
      <span class="cr-body">
        <span class="cr-title"></span>
        <span class="cr-sub"></span>
      </span>
      <button class="cr-del icon-btn" title="Delete chat">✕</button>`;
    el.querySelector('.cr-title').textContent = chat.title || 'Chat';
    el.querySelector('.cr-sub').textContent = chatTargetLabel(chat);
    el.querySelector('.cr-del').onclick = (e) => { e.stopPropagation(); deleteChat(chat.id); };
    el.onclick = () => openChatUI(chat);
    box.appendChild(el);
  }
}

function deleteChat(id) {
  const aid = 'chat-' + id;
  if (R(aid).running) stopAgent(aid);
  ws().chats = chatList().filter(c => c.id !== id);
  setAgents(agents.filter(a => a.id !== aid));   // drop the hidden agent
  saveChats();
  if (activeChatId === id) { activeChatId = null; closeAgentView(); }
  renderChatList();
}

// one-shot done handler: capture the SDK session id the run just created/continued
function chatOnDone(chat) {
  return () => {
    const sid = R('chat-' + chat.id).sessionId;
    if (sid && sid !== chat.sdkSessionId) { chat.sdkSessionId = sid; saveChats(); }
    renderChatList();
  };
}

// open a chat in the center dock (reuses the roster dock, minus the close btn)
function openChatUI(chat) {
  activeChatId = chat.id;
  ensureChatAgent(chat);
  // replay the chat's stored transcript when its live feed is empty (post
  // app-restart) — openChatSession opens the dock view itself, async replay.
  // Fall back to the project's shared deck session: sdkSessionId is only
  // captured when a run completes (chatOnDone), so older/interrupted chats
  // have null and would land on a blank console.
  openChatSession('chat-' + chat.id, chat.sdkSessionId || getSession());
  // AUTO PIPELINE fans a chat out across many real agent ids (indexer, PE,
  // senior, reviewer...), never the chat's own hidden 'chat-<id>' agent —
  // openChatSession just filtered the console down to that lone id, which
  // hides every stage's real output (plog's PIPELINE tag is silenced by
  // design, so filtered + silenced left NOTHING visible at all). Show the
  // unfiltered console instead so the operator watches the run happen.
  if (chat.target === '__pipeline__') { feedFilter = null; applyFilter(); }
  document.getElementById('ad-name').textContent = chat.title || 'Chat';
  document.getElementById('ad-all').classList.add('hidden');   // a chat is persistent
  adInput.placeholder = 'Message…   @ files · / skills · ! shell · ⌃⏎ send';
  syncDockControls();
  renderChatList();
}

// send a message on the active chat, resuming ONLY that chat's own session
function sendChatMessage(text) {
  const chat = findChat(activeChatId);
  if (!chat) return;
  sendChatDispatch(chat, text);
}

// route a chat's message: AUTO PIPELINE → launchPipeline, else the chat's own
// isolated agent (resuming only that chat's session). PLAN comes from the chat.
function sendChatDispatch(chat, text) {
  if (chat.target === '__pipeline__') {
    if (pipeFor(activeWorkspaceId).active) {
      plog('err', 'pipeline already running for this project — abort it first.');
      return;
    }
    launchPipeline(text, null, activeWorkspaceId);
    return;
  }
  const id = 'chat-' + chat.id;
  const opts = {
    fresh: true, effort: chat.effort,
    // capture the session id the moment it exists, so an interrupted run still
    // leaves the chat resumable (onDone alone loses it on app restart / crash)
    onSession: sid => {
      if (sid && sid !== chat.sdkSessionId) { chat.sdkSessionId = sid; saveChats(); }
    },
    onDone: chatOnDone(chat)
  };
  if (chat.sdkSessionId) { opts.resume = chat.sdkSessionId; opts.fork = false; }
  runAgent(id, text, false, !!chat.plan, opts);
}

// DRAFT → real chat: auto-create a sidebar chat from the first message typed
// into the empty-state dock, using the dock controls for target/effort/plan.
function createChatFromText(titleText, message) {
  const t = document.getElementById('ad-target');
  const e = document.getElementById('ad-effort');
  const p = document.getElementById('ad-plan');
  const target = (t && t.value) || 'model:claude-sonnet-5';
  const effort = (e && e.value) || getEffort();
  const plan = !!(p && p.checked);
  const model = target.startsWith('model:')
    ? target.slice('model:'.length)
    : ((agents.find(a => a.id === target) || {}).model || 'claude-sonnet-5');
  const title = (titleText.split('\n')[0].trim().slice(0, 40)) || 'New chat';
  const chat = {
    id: uid(), title, target, model, effort, plan,
    origin: 'empty', ticketId: null, seedPrompt: '',
    sdkSessionId: null, createdAt: Date.now()
  };
  chatList().push(chat);
  saveChats();
  ensureChatAgent(chat);
  renderChatList();
  openChatUI(chat);
  activeChatId = chat.id;
  sendChatDispatch(chat, message || titleText);
}

// ---- New Chat: ChatGPT-style — no modal, just open an empty draft. The
// first message auto-creates the chat (createChatFromText) and titles it
// from that message.
document.getElementById('btn-new-chat').onclick = () => openDraftChat();

// effort select — persisted globally, mirrored into the wide composer. The
// native <select> is the data source but hidden; a themed custom dropdown
// drives it so the popup matches the app theme. Options come from
// EFFORT_LEVELS (single source of truth) — nothing is hardcoded in the HTML.

// fill an empty <select> from EFFORT_LEVELS so both composers stay in sync
function populateEffortSelect(sel) {
  if (!sel || sel.options.length) return;
  EFFORT_LEVELS.forEach(l => {
    const o = document.createElement('option');
    o.value = l.value;
    o.textContent = `${l.dot} ${l.label}`;
    sel.appendChild(o);
  });
}

// Turn a native <select> into a themed dropdown. Keeps the <select> as the
// data source (its .value and 'change' events keep working unchanged).
function enhanceThinkSelect(sel) {
  if (!sel || sel.classList.contains('enhanced')) return;
  populateEffortSelect(sel);
  const opts = Array.from(sel.options);
  const subFor = v => (EFFORT_LEVELS.find(l => l.value === v) || {}).sub || '';
  sel.classList.add('enhanced');

  const wrap = document.createElement('div');
  wrap.className = 'tsel';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tsel-btn';
  if (sel.dataset.tip) btn.dataset.tip = sel.dataset.tip;
  btn.innerHTML =
    '<span class="tsel-cur"></span>' +
    '<span class="tsel-caret">▾</span>';

  const menu = document.createElement('div');
  menu.className = 'tsel-menu';
  opts.forEach(o => {
    const item = document.createElement('div');
    item.className = 'tsel-opt';
    item.dataset.value = o.value;
    const dot = (o.textContent.trim().split(' ')[0]) || '●';
    const label = o.textContent.replace(dot, '').trim();
    item.innerHTML =
      `<span class="tsel-dot">${dot}</span>` +
      `<span class="tsel-txt"><span>${label}</span>` +
      `<span class="tsel-sub">${subFor(o.value)}</span></span>` +
      `<span class="tsel-check">✓</span>`;
    item.addEventListener('click', () => {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      close();
    });
    menu.appendChild(item);
  });

  function syncLabel() {
    const cur = opts.find(o => o.value === sel.value) || opts[0];
    btn.querySelector('.tsel-cur').textContent = cur ? cur.textContent : '';
    menu.querySelectorAll('.tsel-opt').forEach(el =>
      el.classList.toggle('sel', el.dataset.value === sel.value));
  }
  function close() { wrap.classList.remove('open'); }
  function open() {
    syncLabel();
    // flip upward when the button sits low in the viewport
    const r = btn.getBoundingClientRect();
    wrap.classList.toggle('up', r.bottom + 180 > window.innerHeight);
    wrap.classList.add('open');
  }
  btn.addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.contains('open') ? close() : open();
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) close();
  });
  // keep the trigger label in sync when .value is set programmatically
  sel.addEventListener('change', syncLabel);
  sel._tselSync = syncLabel;

  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  wrap.appendChild(sel);
  syncLabel();
}

(async function initEffortSelect() {
  const sel = document.getElementById('ad-effort');
  if (!sel) return;
  await loadEffortLevels();   // pull Claude's supported levels before building
  // restore the saved choice; if it's no longer a valid level, fall back to auto
  const saved = getEffort();
  sel.value = EFFORT_LEVELS.some(l => l.value === saved) ? saved : 'auto';
  setEffort(sel.value);
  sel.addEventListener('change', () => {
    setEffort(sel.value);
    const cx = document.getElementById('cx-think');
    if (cx) { cx.value = sel.value; cx._tselSync && cx._tselSync(); }
  });
  enhanceThinkSelect(sel);
  enhanceThinkSelect(document.getElementById('cx-think'));
})();


// ============================================================
// Minimal, safe Markdown → HTML for agent responses (no external lib).
// Everything is HTML-escaped first, then a small block/inline pass runs, so
// the feed shows headings/lists/code cleanly instead of raw # and *.
// ============================================================
function mdInline(s) {
  s = esc(s);                                            // escape <>&" first
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return s;
}
function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isSpecial = l => /^(#{1,6})\s/.test(l) || /^```/.test(l)
    || /^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) || /^\s*>\s?/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      i++; const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre class="md-pre"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const n = h[1].length; out.push(`<div class="md-h md-h${n}">${mdInline(h[2])}</div>`); i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote class="md-quote">${renderMarkdown(q.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      out.push('<ul class="md-ul">' + items.map(it => `<li>${mdInline(it)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol class="md-ol">' + items.map(it => `<li>${mdInline(it)}</li>`).join('') + '</ol>');
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
    out.push(`<div class="md-p">${mdInline(para.join(' '))}</div>`);
  }
  return out.join('');
}

// ============================================================
// Console feed
// ============================================================
function hideFeedEmpty() {
  const e = document.getElementById('feed-empty');
  if (e) e.remove();
}

function feed(agentId, cls, text, ico, sameLine = false) {
  const cont = feedElFor(agentId);
  if (cont === consoleFeed) hideFeedEmpty();
  const s = streamEls[agentId];
  // parentNode (not isConnected): the card is "live" even while its project is
  // off-screen in a detached buffer, so background streams keep the same card
  if (sameLine && s && s.parentNode) {
    s.querySelector('.body').textContent += text;
    if (cont === consoleFeed) pinFeedToBottom();
    return s;
  }
  const a = findAgent(agentId);
  const el = document.createElement('div');
  el.className = 'ev';
  el.dataset.agent = agentId;
  el.innerHTML = `<span class="tag">${esc(a ? a.name : '?')}</span><span class="ico">${ico || ''}</span><span class="body ${cls}"></span>`;
  el.querySelector('.body').textContent = text;
  if (feedFilter && feedFilter !== agentId) el.style.display = 'none';
  cont.appendChild(el);
  if (sameLine) { streamEls[agentId] = el; el.classList.add('streaming'); }
  else delete streamEls[agentId];
  if (cont === consoleFeed) pinFeedToBottom();
  return el;
}

function endStream(agentId) {
  const s = streamEls[agentId];
  if (s) s.classList.remove('streaming');   // drop the live typing caret
  delete streamEls[agentId];
}

// THINKING MODE — a live animated row at the bottom of the feed shown whenever
// an agent is running but not currently streaming text (between tool calls,
// before first output). Reuses one element per agent and floats to the bottom.
const thinkEls = {};
function showThinking(agentId, label) {
  const cont = feedElFor(agentId);
  if (cont === consoleFeed) hideFeedEmpty();
  let el = thinkEls[agentId];
  if (!el || !el.parentNode) {
    const a = findAgent(agentId);
    el = document.createElement('div');
    el.className = 'ev thinking-row';
    el.dataset.agent = agentId;
    el.innerHTML =
      `<span class="tag">${esc(a ? a.name : '?')}</span>` +
      `<span class="ico think-dots"><i></i><i></i><i></i></span>` +
      `<span class="body think-label"></span>`;
    if (feedFilter && feedFilter !== agentId) el.style.display = 'none';
    thinkEls[agentId] = el;
  }
  // once Stop is clicked, pin this to "aborting…" — later tool/thinking
  // events would otherwise flip it back and make Stop look like it failed
  const aborting = R(agentId).aborting;
  el.querySelector('.think-label').textContent = aborting ? 'aborting…' : (label || 'thinking…');
  cont.appendChild(el);                        // keep it as the last (current) line
  if (cont === consoleFeed) pinFeedToBottom();
}
function hideThinking(agentId) {
  const el = thinkEls[agentId];
  if (el && el.parentNode) el.parentNode.removeChild(el);
  delete thinkEls[agentId];
}

// REASSIGN indicator — bridges the dead air between a REJECTED verdict and the
// next engineer's TASK line while pickFixerByAI() (a real AI call) resolves.
let reassignEl = null;
function showReassigning() {
  hideFeedEmpty();
  reassignEl = document.createElement('div');
  reassignEl.className = 'ev thinking-row';
  reassignEl.innerHTML = `<span class="tag">PIPELINE</span>` +
    `<span class="ico think-dots"><i></i><i></i><i></i></span>` +
    `<span class="body think-label">REJECTED — reassigning to the right engineer…</span>`;
  consoleFeed.appendChild(reassignEl);
  pinFeedToBottom();
}
function hideReassigning() {
  if (reassignEl && reassignEl.parentNode) reassignEl.parentNode.removeChild(reassignEl);
  reassignEl = null;
}

// line-level diff: trim the shared head/tail, mark the rest removed/added.
// Good enough to read an edit at a glance without a full LCS.
function diffLines(oldStr, newStr) {
  const o = (oldStr || '').split('\n');
  const n = (newStr || '').split('\n');
  let s = 0;
  while (s < o.length && s < n.length && o[s] === n[s]) s++;
  let eo = o.length - 1, en = n.length - 1;
  while (eo >= s && en >= s && o[eo] === n[en]) { eo--; en--; }
  const rows = [];
  for (let i = 0; i < s; i++) rows.push(['ctx', o[i]]);
  for (let i = s; i <= eo; i++) rows.push(['del', o[i]]);
  for (let i = s; i <= en; i++) rows.push(['add', n[i]]);
  for (let i = eo + 1; i < o.length; i++) rows.push(['ctx', o[i]]);
  return rows;
}

// a file path shown relative to the agent's project (backslashes normalised)
function relToCwd(agentId, p) {
  if (!p) return '';
  const a = findAgent(agentId);
  const base = (a && a.cwd) || projectDir || '';
  let s = String(p);
  if (base && s.toLowerCase().startsWith(base.toLowerCase())) {
    s = s.slice(base.length).replace(/^[\\/]/, '');
  }
  return s.replace(/\\/g, '/');
}
// the legible target of a non-edit tool call — WHAT it acts on and, for a
// search, the pattern it's looking for (that pattern IS the "why")
function toolTarget(agentId, tool, inp, raw) {
  if (!inp) return String(raw || '');
  if (tool === 'Grep') {
    const where = inp.path ? ` in ${relToCwd(agentId, inp.path)}`
      : inp.glob ? ` in ${inp.glob}` : '';
    return `"${inp.pattern || ''}"${where}`;
  }
  if (tool === 'Glob') return inp.pattern || '';
  if (tool === 'Read') return relToCwd(agentId, inp.file_path || inp.path || '');
  if (tool === 'Bash' || tool === 'PowerShell') return inp.command || '';
  if (tool === 'WebFetch') return inp.url || '';
  if (tool === 'WebSearch') return inp.query || '';
  return inp.file_path || inp.path || inp.command || inp.pattern || inp.query || inp.prompt || '';
}
// a present-tense sentence for a tool call so the feed reads like someone
// narrating ("Let me check X", "Searching for Y") — the result chip added on
// 'tool-result' completes it ("… → 142 lines")
function toolNarration(agentId, tool, inp, raw) {
  const pick = arr => arr[(narrTick++) % arr.length];
  const t = toolTarget(agentId, tool, inp, raw);
  switch (tool) {
    case 'Read': return t ? `${pick(READ_LEADS)} ${t}` : 'Reading a file';
    case 'Grep': return `${pick(FIND_LEADS)} ${t}`;   // t = "pattern" in file
    case 'Glob': return t ? `Looking for ${t}` : 'Listing files';
    case 'Bash': case 'PowerShell': return t ? `Running ${t}` : 'Running a command';
    case 'WebFetch': return t ? `Fetching ${t}` : 'Fetching a page';
    case 'WebSearch': return `Searching the web for "${(inp && inp.query) || ''}"`;
    case 'Task': case 'Agent': return t ? `Handing off: ${t}` : 'Delegating a subtask';
    case 'TodoWrite': return 'Updating the plan';
    default: return t ? `${tool} ${t}` : tool;
  }
}

// diff card in the console feed for an edit tool call — Claude-Code style:
// "Update(path)" header, "└ Added N lines" summary, line-numbered gutter,
// OPEN by default so every change is visible without a click (the header
// still toggles it closed). startLines = per-hunk real file line numbers
// computed in the main process (null when the file couldn't be probed).
const MAX_DIFF_ROWS = 400;   // cap huge Writes; the tail is elided

function feedDiff(agentId, tool, inp, startLines) {
  const cont = feedElFor(agentId);
  if (cont === consoleFeed) hideFeedEmpty();
  const a = findAgent(agentId);
  const file = inp.file_path || inp.path || '';
  // show the path relative to the agent's project when possible
  const base = (a && a.cwd) || projectDir || '';
  let shown = file || tool;
  if (base && file.toLowerCase().startsWith(base.toLowerCase())) {
    shown = file.slice(base.length).replace(/^[\\/]/, '');
  }

  // hunks = [old, new] pairs; rows = [kind, text, lineNo] with real numbers
  const hunks = (tool === 'MultiEdit' && Array.isArray(inp.edits))
    ? inp.edits.map(e => [e.old_string, e.new_string])
    : (tool === 'Write')
      ? [['', inp.content || '']]
      : [[inp.old_string, inp.new_string]];
  const rows = [];
  hunks.forEach(([o, n], hi) => {
    if (hi) rows.push(['sep', '', '']);
    const start = (startLines && startLines[hi]) || null;
    let oldLn = start, newLn = start;
    for (const [k, text] of diffLines(o, n)) {
      let ln = '';
      if (start !== null) {
        if (k === 'del') ln = oldLn++;
        else if (k === 'add') ln = newLn++;
        else { ln = newLn++; oldLn++; }   // ctx advances both counters
      }
      rows.push([k, text, ln]);
    }
  });
  if (rows.length > MAX_DIFF_ROWS) {
    const extra = rows.length - MAX_DIFF_ROWS;
    rows.length = MAX_DIFF_ROWS;
    rows.push(['cut', `… ${extra} more lines`, '']);
  }

  const adds = rows.filter(r => r[0] === 'add').length;
  const dels = rows.filter(r => r[0] === 'del').length;
  const prefix = k => (k === 'add' ? '+' : k === 'del' ? '-' : ' ');

  // "└ Added 4 lines" / "└ Removed 2 lines" / "└ Added 4, removed 2 lines"
  const sum = adds && dels ? `Added ${adds}, removed ${dels} lines`
    : adds ? `Added ${adds} line${adds === 1 ? '' : 's'}`
    : dels ? `Removed ${dels} line${dels === 1 ? '' : 's'}`
    : 'No line changes';
  const verb = tool === 'Write' ? 'Write' : 'Update';

  const card = document.createElement('div');
  card.className = 'ev ev-diff';
  card.dataset.agent = agentId;
  card.innerHTML =
    `<span class="tag">${esc(a ? a.name : '?')}</span>` +
    `<div class="diff-card open">` +
      `<button class="diff-head">` +
        `<span class="diff-caret">▸</span>` +
        `<span class="diff-file"></span>` +
        `<span class="diff-stat"><b class="add">+${adds}</b> <b class="del">-${dels}</b></span>` +
      `</button>` +
      `<div class="diff-sum">└ ${esc(sum)}</div>` +
      `<div class="diff-body">` +
        rows.map(([k]) => (k === 'sep'
          ? `<div class="dl dl-sep"></div>`
          : `<div class="dl dl-${k}"><em></em><i>${prefix(k)}</i><span></span></div>`
        )).join('') +
      `</div>` +
    `</div>`;
  card.querySelector('.diff-file').textContent =
    `${verb}(${shown})` + (tool === 'Write' ? '  (new file)' : '');
  const lines = card.querySelectorAll('.diff-body .dl:not(.dl-sep)');
  rows.filter(r => r[0] !== 'sep').forEach((r, i) => {
    lines[i].querySelector('em').textContent = r[2];
    lines[i].querySelector('span').textContent = r[1];
  });
  const inner = card.querySelector('.diff-card');
  card.querySelector('.diff-head').onclick = () => inner.classList.toggle('open');
  if (feedFilter && feedFilter !== agentId) card.style.display = 'none';
  cont.appendChild(card);
  if (cont === consoleFeed) pinFeedToBottom();
}

// After a plan-mode run finishes, drop an inline action card into the console.
// Primary action DELEGATES the plan to a Senior Engineer (the planner stays a
// planner); a secondary link lets the planner implement it itself instead.
// Both exit plan mode (uncheck the toggle) and resume the planner's session so
// the full plan is already in context.
function feedImplementCard(plannerId, planSessionId) {
  const cont = feedElFor(plannerId);
  if (cont === consoleFeed) hideFeedEmpty();
  const planner = findAgent(plannerId);
  // UI-related plans hand off to the UI/UX engineer instead of a generic senior
  // — resolved from the PLANNER's own project roster, not whatever's on screen
  const planWsId = wsForAgent(plannerId);
  const planText = R(plannerId).lastText || '';
  const senior = (isUiTask(planText) && uiuxAgentIn(planWsId)) || byRoleIn(planWsId, 'senior')[0];
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
  cont.appendChild(el);
  if (cont === consoleFeed) pinFeedToBottom();
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
  const planBox = document.getElementById('ad-plan');
  if (planBox) planBox.checked = false;   // exit plan mode for future sends too
  const planChat = findChat(activeChatId);
  if (planChat) { planChat.plan = false; saveChats(); }
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
  // single-chat view: every row is the same agent — the repeated name column
  // is noise, so hide it (the ALL view keeps it to tell agents apart)
  consoleFeed.classList.toggle('one-agent', !!feedFilter);
  feedStuck = true;
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
  // the top strip AND the floating pill are both retired — the single source of
  // "what's happening" is now the status bar (see statusbar.js renderWork()).
  activityEl.classList.add('hidden');
  activityEl.innerHTML = '';
  if (window.renderStatusBar) window.renderStatusBar();
  syncPane();
}

// one place to stop whatever is running — used by the status-bar stop button.
// Scoped to the ACTIVE project only: aborts ITS pipeline (covers paused
// "awaiting review") AND its own loose agents — a background project's
// pipeline keeps running untouched.
function stopEverything() {
  const p = pipelines.get(activeWorkspaceId);
  if (p && p.active && typeof abortPipeline === 'function') {
    abortPipeline('pipeline aborted by operator.', activeWorkspaceId);
  }
  agents.filter(a => R(a.id).running).forEach(x => {
    stopAgent(x.id); feed(x.id, 'sys', 'stop requested — aborting…', '■');
  });
  if (window.renderStatusBar) window.renderStatusBar();
}
window.stopEverything = stopEverything;
window.pipeState = () => {
  const p = pipelines.get(activeWorkspaceId);
  return p ? { active: p.active, stage: p.stage, label: STAGE_LABEL[p.stage] } : { active: false, stage: null, label: null };
};

// keep the elapsed counters moving so the console never looks frozen
setInterval(() => { if (!activityEl.classList.contains('hidden')) renderActivity(); }, 1000);

// ===== Console vs editor =====
// Agents working -> the console; nothing running -> back to the code you had open.
// An explicit click (open a file, or ✕ back to console) wins until the busy state
// next flips, so we never yank a pane out from under a deliberate choice.
let paneOverride = null;
let lastBusy = null;

function anyBusy() {
  const p = pipelines.get(activeWorkspaceId);
  return (p && p.active) || agents.some(a => R(a.id).running);
}

function syncPane() {
  // the ticket workspace owns the center area while it's open
  if (window.tkIsOpen && tkIsOpen()) return;
  // the notes gallery screen also owns the center area while it's open
  if (window.notesViewOpen && notesViewOpen()) return;
  // the sandbox browser screen also owns the center area while it's open
  if (window.browserViewOpen && browserViewOpen()) return;
  // terminal now lives in the bottom panel and no longer owns the center —
  // console/editor swap independently of whether the panel is open
  // split mode: editor and console are shown side by side, so don't hide either
  if (document.getElementById('editor-area').classList.contains('split') && activeFile) {
    viewer.classList.remove('hidden');
    consoleFeed.classList.remove('hidden');
    renderConsoleChips();
    return;
  }
  const busy = anyBusy();
  // during a run → show the console; when it finishes → STAY on the console so
  // the result is visible (don't auto-flip back to the editor / explorer).
  if (busy !== lastBusy) { paneOverride = busy ? null : 'console'; lastBusy = busy; }
  const want = paneOverride || (busy ? 'console' : 'editor');
  const showEditor = want === 'editor' && activeFile;
  viewer.classList.toggle('hidden', !showEditor);
  consoleFeed.classList.toggle('hidden', showEditor);   // the other pane owns the area
  renderConsoleChips();
}

function ticker(agentId, text, idle = false) {
  const r = R(agentId);
  // once Stop is clicked, trailing tool/stream events must not overwrite the
  // status back to "thinking…"/tool narration — that reads as Stop doing nothing
  r.status = r.aborting ? 'aborting…' : text;
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
// warm-run target dedupe: agentId -> sorted rel-list key of the last TARGET
// FILES block injected. A follow-up about the same area used to re-append a
// near-identical ~0.5k block every message — cached-input cost every turn.
const lastTargets = new Map();
async function hasProjectMap(cwd) {
  if (!cwd) return false;
  if (!mapHintSeen.has(cwd)) {
    let st = { exists: false };
    try { st = await window.deck.indexStatus(cwd); } catch {}
    mapHintSeen.set(cwd, !!st.exists);
  }
  return mapHintSeen.get(cwd);
}

// TOPIC MEMORY retrieval — instead of front-loading one giant knowledge file
// (token-heavy), pull ONLY the 1-2 topic memories relevant to this issue, plus a
// one-line index of all topics. Each matched topic is flagged STALE when its
// covered files changed, so the PE refreshes just those files.
async function memoryInject(cwd, query) {
  try {
    const r = await window.deck.memoryList(cwd);
    if (!r.ok || !r.topics || !r.topics.length) return '';
    const q = String(query || '').toLowerCase();
    const qtokens = q.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const score = t => {
      const hay = `${t.title} ${t.keywords} ${t.files.join(' ')}`.toLowerCase();
      let s = 0;
      for (const w of qtokens) if (hay.includes(w)) s++;
      for (const kw of (t.keywords || '').toLowerCase().split(',')) {
        const k = kw.trim(); if (k && q.includes(k)) s += 2;   // phrase match boost
      }
      return s;
    };
    const ranked = r.topics.map(t => ({ t, s: score(t) }))
      .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2);
    const titles = r.topics.map(t => t.title || t.slug).join(', ');
    let out = `\n\nMEMORY INDEX (feature topics already on file — extend these, don't duplicate): ${titles}`;
    for (const { t } of ranked) {
      out += `\n\n=== MEMORY: ${t.title} ===`;
      if (t.stale) {
        out += `\n[STALE — these covered files changed since this memory was written: ${t.changed.join(', ')}. Re-read ONLY these, then refresh this topic before trusting the rest.]`;
      }
      out += `\n${t.body}`;
    }
    if (!ranked.length) {
      out += `\n(No topic matches this issue — after you solve it, create .loveai/memory/topics/<topic>.md for this feature.)`;
    }
    return out;
  } catch { return ''; }
}

// Best-effort context enrichment (code graph, vector job, index walk) must NEVER
// wedge the actual agent launch. These are IPC round-trips to native/child-process
// work that can stall; a try/catch does not catch a hang. So race each against a
// short timeout and fall back to the same empty value the catch path already
// yields — the agent just launches without that one enrichment instead of the
// whole run sitting at "initializing session..." forever.
function withTimeout(promise, ms, fallback) {
  let t;
  const guard = new Promise(res => { t = setTimeout(() => res(fallback), ms); });
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    guard,
  ]).finally(() => clearTimeout(t));
}

// ===== Retrieval eval (hit@k) — closes the measurement loop =====
// At launch we record what retrieval PREDICTED (the pre-ranked file list);
// during the run we record what the agent actually EDITED; on done this logs
// hit@5 / hit@10 to .loveai/index/retrieval-eval.jsonl via main. That file is
// the ground truth for whether a ranking change helped — check it (or
// window.deck.evalStats(cwd)) before and after tuning retrieval.
function logRetrievalEval(r, cwd) {
  try {
    if (!cwd || !r.evalPredicted || !r.evalPredicted.length) return;
    if (!r.evalEdited || !r.evalEdited.size) return;
    const rootFwd = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const norm = (p) => {
      let s = String(p).replace(/\\/g, '/');
      if (s.toLowerCase().startsWith(rootFwd.toLowerCase())) s = s.slice(rootFwd.length);
      return s;
    };
    const edited = [...new Set([...r.evalEdited].map(norm))];
    const top5 = new Set(r.evalPredicted.slice(0, 5));
    const top10 = new Set(r.evalPredicted.slice(0, 10));
    const frac = (set) => edited.filter(e => set.has(e)).length / edited.length;
    window.deck.evalLog(cwd, {
      at: Date.now(),
      warm: !!r.evalWarm,
      query: String(r.evalQuery || '').replace(/\s+/g, ' ').slice(0, 120),
      predicted: r.evalPredicted,
      edited,
      hit5: +frac(top5).toFixed(3),
      hit10: +frac(top10).toFixed(3),
    }).catch(() => {});
  } catch {}
  r.evalPredicted = null;
  r.evalEdited = null;
}

async function runAgent(agentId, prompt, fork = false, plan = false, opts = {}) {
  const a = findAgent(agentId);
  const r = R(agentId);
  if (!a || r.running) return;
  if (!prompt) { feed(agentId, 'err', 'no task assigned.', '⚠'); return; }

  const model = (opts.model && MODEL_LABELS[opts.model]) ? opts.model : a.model;
  r.running = true;
  r.runId = uid();
  // pin this run + agent to the project that owns them, so their output streams
  // into that project's console even if you switch away while it runs
  agentWs[agentId] = wsForAgent(agentId);
  runWs[r.runId] = agentWs[agentId];
  r.planMode = plan;
  r.noShare = !!opts.fresh;
  // optional one-shot completion callback, fired with (result, finalText) on done
  if (opts.onDone) runDoneCallbacks[r.runId] = opts.onDone;
  if (opts.onEvent) runEventSinks[r.runId] = opts.onEvent;
  if (opts.onSession) runSessionCallbacks[r.runId] = opts.onSession;
  r.startedAt = Date.now();
  r.lastText = '';
  r.aborting = false;   // clear any stale flag from a prior stopped run
  r.sessionId = null;   // per-run: set on the 'init' event; used by the watchdog
  r.curModel = model;   // for the background learner
  setRunningUI(agentId, true);
  ticker(agentId, 'initializing session...');
  // INIT WATCHDOG — the launch is a chain of awaited best-effort IPC calls
  // (below) followed by the subprocess spawn; the ticker sits at "initializing
  // session..." until the first agent-event arrives. If NOTHING arrives — a
  // stalled native call before the spawn, or a subprocess that never emits its
  // init — the run would otherwise hang forever with r.running stuck true. This
  // trips after a generous window, aborts anything that did spawn, resets the
  // agent, and tells the operator to retry. Cleared on the first event (line ~1416).
  clearTimeout(r.initWatch);
  const watchRunId = r.runId;
  r.initWatch = setTimeout(() => {
    if (r.runId !== watchRunId || !r.running || r.sessionId) return;
    feed(agentId, 'err',
      'launch stalled — no session after 120s (context assembly or spawn hung). ' +
      'Aborting; press ↑ to retry.', '⚠');
    try { if (r.runId) window.deck.stopAgent(r.runId); } catch {}
    r.running = false;
    r.initWatch = null;
    setRunningUI(agentId, false);
  }, 120000);
  feed(agentId, 'sys', (plan ? 'PLAN ▸ ' : 'TASK ▸ ') + prompt, plan ? '🗺' : '🎯');
  if (model !== a.model) feed(agentId, 'sys', `model routed by complexity → ${MODEL_LABELS[model]}`, '⚖');
  // opts.effort overrides the global session setting (e.g. a per-ticket choice)
  const effort = opts.effort || getEffort();
  if (effort !== 'auto') {
    feed(agentId, 'sys', `reasoning effort → ${effort.toUpperCase()}`, '🧠');
  }

  // point the agent at the project map so it never re-explores the repo.
  // The indexer writes the map, so it never gets the hint itself.
  const cwd = opts.cwd || a.cwd;
  // CHECKPOINT — one snapshot per task, not per stage: a pipeline run already
  // owns a checkpoint for its cwd, so a stage sharing that cwd joins it
  // instead of starting a redundant one. A stage in a different cwd (or any
  // standalone run) gets its own. Checked across ALL projects' pipelines, not
  // just the active one — a background pipeline still owns its checkpoint.
  r.cpStandalone = !pipelineActiveForCwd(cwd);
  if (r.cpStandalone && cwd) cpBeginTask(cwd, prompt);
  r.cpCwd = cwd;
  // WARM RUN — this run resumes a session (opts.resume) or continues the shared
  // one (opts.cont with a live session). That transcript already carries every
  // auto-inject below (orientation, memory, impact, retrieval front-load) from
  // its first run — re-attaching them would replay thousands of duplicate
  // tokens into an already-loaded context, so all injects are skipped.
  const warm = !!(opts.resume || (opts.cont && getSession()));
  // retrieval key — what the index/RAG is queried with. Defaults to the prompt,
  // but pipeline dispatches pass the TASK CONTENT here: their prompt is just
  // "Execute task-NN.md: read … per your rules", which ranked files against
  // "execute/read/pipeline" noise and made engineers re-research by hand.
  const rq = String(opts.retrievalQuery || prompt);
  // retrieval eval state — what we predicted at launch vs what gets edited
  r.evalEdited = new Set();
  r.evalPredicted = null;
  r.evalQuery = rq;
  let fullPrompt = prompt;
  const prepT0 = performance.now();   // how long context assembly holds the spawn
  // ---- COLD-RUN ENRICHMENT, kicked off in PARALLEL ----
  // These lookups (map check, topic memory, regression impact, lexical
  // retrieval, vector RAG, symbol pack) are independent of each other. They
  // used to be awaited one after another, so their timeouts could STACK to
  // ~38s of dead time before the agent spawned. Start them all at once here;
  // the awaits below then cost max(slowest), not the sum. Append order into
  // fullPrompt is unchanged (awaits happen in the original order).
  const isIdx = a.role === 'indexer';
  const heavyRole = a.role === 'prompt' || a.role === 'custom'
    || a.role === 'senior' || a.role === 'uiux';
  const frontLoad = !warm && heavyRole && cwd;
  // tight ceilings: a warm index answers in ms — only a busy/cold worker hits
  // these, and then the launch proceeds without that enrichment rather than wait
  const pMap = (!warm && !isIdx)
    ? withTimeout(hasProjectMap(cwd), 2000, false) : null;
  const pMem = (!warm && !isIdx && cwd)
    ? withTimeout(memoryInject(cwd, rq), 2000, '') : null;
  const pImp = (!warm && !isIdx && !heavyRole && cwd)
    ? withTimeout(window.deck.regressionImpact(cwd, rq), 3000, null) : null;
  // withContent=0: the push is a MAP now (file names + symbols), never code —
  // the agent PULLS code mid-task via the mcp__deck__* retrieval tools
  const pCtx = frontLoad
    ? withTimeout(window.deck.retrieveContext(cwd, rq, 12), 3500, null) : null;
  const pVec = frontLoad
    ? withTimeout(window.deck.vectorQuery(cwd, rq, 20), 3500, null) : null;

  if (pMap && await pMap) {
    fullPrompt += '\n\nOrientation: read .loveai/index/PROJECT-MAP.md first and open only the files relevant to this task — do not survey the repo.';
  }
  // TOPIC MEMORY — front-load only the feature memory relevant to this run so
  // the agent already knows the flow (paths, functions, step-by-step) without
  // re-exploring. Light by design: at most 1-2 topics, not the whole codebase.
  // Every role reads it and (per DISCIPLINE) every role maintains it.
  if (pMem) fullPrompt += await pMem;
  // REGRESSION IMPACT (global) — the native code graph's blast-radius, injected
  // for EVERY non-indexer run so any agent/model sees what a change touches. The
  // Prompt Engineer / custom already get a richer version inside the retrieval
  // front-load below, so they're excluded here to avoid a duplicate block.
  if (pImp) {
    try {
      const im = await pImp;
      if (im && im.ok && im.impact && im.impact.trim()) {
        fullPrompt += `\n\nREGRESSION IMPACT (auto, from the code graph — NOT ` +
          `exhaustive, verify): the symbols you may change and what calls/imports ` +
          `them. Before altering any symbol below, check EACH listed reference for ` +
          `breakage and prefer a minimal, backward-compatible change.\n${im.impact}`;
      }
    } catch {}
  }
  // SLIM FRONT-LOAD (map, not code): pre-rank the files most likely involved
  // (BM25 + vector) and hand over NAMES + SYMBOLS only. The agent pulls actual
  // code mid-task through the in-process mcp__deck__* retrieval tools (see
  // main.js buildDeckServer) — mid-task queries beat t=0 prompt-keyed guesses.
  // Given to the planner (PE/custom) AND build agents (seniors + UI/UX).
  if (frontLoad) {
    try {
      // top 12 ranked file names + symbols — the MAP the slim push is built from
      const rc = await pCtx;
      if (!rc) throw new Error('retrieve-context timed out');
      // SEMANTIC (RAG) retrieval — vector search over the tree-sitter symbols, so
      // the agent sees files whose MEANING matches even when no identifier does.
      // LOGGED so the operator can confirm the vector index is actually being used
      // (and is warned when it isn't built yet).
      let vhits = [];
      let vq = null;
      try {
        vq = await pVec;
        if (vq && vq.ready && Array.isArray(vq.hits)) vhits = vq.hits;
      } catch {}
      // id format is rel#symbol — guard the cut so an id without '#' (legacy
      // index rows) yields the raw id instead of a chopped/garbled path
      const relOfHit = (id) => {
        const cut = id.lastIndexOf('#');
        return cut > 0 ? id.slice(0, cut) : id;
      };
      const vTopFiles = [...new Set(vhits.map(h => relOfHit(h.id)))].slice(0, 6);
      // Say WHICH failure it is — a built index with a dead embedder is NOT the
      // same as no index, and telling the user to "build the graph" when the
      // vectors already exist just loops them (build succeeds, query still empty).
      let ragMsg;
      if (vhits.length) {
        ragMsg = `RAG query → "${rq.replace(/\s+/g, ' ').slice(0, 70)}" · ` +
          `${vhits.length} semantic hits · top: ${vTopFiles.join(', ')}`;
      } else if (vq && vq.indexed && vq.embedErr) {
        ragMsg = `RAG: vector index exists but the embedder won't load ` +
          `(${vq.embedErr}) — lexical only`;
      } else if (vq && vq.indexed) {
        ragMsg = `RAG: vector index built · 0 semantic matches for this query ` +
          `— lexical only`;
      } else {
        // vq is null (query timed out — worker likely busy on another project's
        // build) or !vq.indexed. Check disk directly: vectorStatus runs on the
        // MAIN thread, so it isn't blocked behind a queued worker job.
        let vs = null;
        try { vs = await window.deck.vectorStatus(cwd); } catch {}
        if (vs && vs.exists) {
          ragMsg = `RAG: vector index exists but the query didn't return ` +
            `(another build may be running) — lexical for now`;
        } else {
          ragMsg = `RAG: no vector index for this project yet — lexical only ` +
            `(build the graph to enable semantic retrieval)`;
        }
      }
      feed(agentId, 'sys', ragMsg, '🧬');
      if (rc.ok && rc.files && rc.files.length) {
        // fold semantic-only files into the ranked list so they're surfaced too
        const haveRel = new Set(rc.files.map(f => f.rel));
        for (const rel of vTopFiles) {
          if (!haveRel.has(rel)) { haveRel.add(rel); rc.files.push({ rel }); }
        }
        // record the prediction for the retrieval eval (logged on done)
        r.evalPredicted = rc.files.slice(0, 10).map(f => f.rel);
        r.evalWarm = false;
        // SLIM PUSH (Aider-style): a small MAP of where the task lives — file
        // names + symbols, never code. The heavy context (symbol packs, file
        // contents, blast radius) is PULLED by the agent mid-task via the
        // in-process mcp__deck__* tools, when it knows what it actually needs.
        // 1) repo map for orientation
        if (rc.repoMap) {
          fullPrompt += `\n\nREPO MAP (directories by file count + notable files — use this for orientation instead of exploring):\n${rc.repoMap}`;
        }
        // 2) ranked candidate files for this specific issue
        const lines = rc.files
          .map(f => `- ${f.rel}${f.symbols && f.symbols.length ? ' — ' + f.symbols.slice(0, 8).join(', ') : ''}`)
          .join('\n');
        fullPrompt += `\n\nPRE-RANKED RELEVANT FILES (lexical match on the issue):\n${lines}`;
        // semantic matches from the vector index — meaning-based, complements lexical
        if (vhits.length) {
          const symLines = vhits.slice(0, 12)
            .map(h => `- ${h.id} (${h.score.toFixed(2)})`).join('\n');
          fullPrompt += `\n\nSEMANTIC MATCHES (vector/RAG search — meaning-based, ` +
            `use alongside the lexical list):\n${symLines}`;
        }
        // 3) regression blast-radius — who references the symbols you may touch.
        // The planner bakes it into the task CONTEXT so seniors inherit it.
        if (rc.impact) {
          fullPrompt += `\n\nREGRESSION IMPACT (auto, computed from the index — NOT ` +
            `exhaustive, verify): symbols you may change and the files that reference ` +
            `them. Before altering any symbol below, check EACH listed reference for ` +
            `breakage, prefer a minimal backward-compatible change, and RECORD the ` +
            `affected files in your task's CONTEXT so the engineers inherit this.\n${rc.impact}`;
        }
        // 4) firm directive: pull code through the indexed tools, not tree surveys
        fullPrompt += `\n\nRETRIEVAL TOOLS (indexed, answer in milliseconds — ` +
          `PREFER these over Glob/Grep surveys):\n` +
          `- mcp__deck__search_code — hybrid ranked file/symbol search (lexical+semantic)\n` +
          `- mcp__deck__get_symbols — implementations + dependencies for a topic (actual code)\n` +
          `- mcp__deck__who_references — blast radius of a symbol/file before you change it\n` +
          `- mcp__deck__topic_memory — feature notes recorded by previous runs\n` +
          `Workflow: the lists above say WHERE the task lives → pull code with ` +
          `get_symbols/search_code → Read only the exact spans you will edit. ` +
          `Do not survey the tree.`;
      }
    } catch {}
  }
  // PER-MESSAGE RETRIEVAL (warm runs) — a resumed/continued session already
  // carries the FIRST message's front-load, but a follow-up about something
  // NEW used to arrive with zero targeting: the model then re-located the
  // code by hand (Glob/Grep loops over many turns), which is what actually
  // burned the turn ceiling. Every message now queries the index (vector RAG
  // + BM25 + tree-sitter symbol graph) and hands the model the exact files
  // to open — the search happens HERE, in one cheap local call, not in agent
  // turns. Kept lean on purpose: file list + symbol pack only, no repo map,
  // no whole-file dump (the transcript already holds the session's context).
  if (warm && cwd && a.role !== 'indexer') {
    try {
      // tight ceiling (was 6s): a follow-up should FEEL instant — if the index
      // worker is busy the message just goes out without per-message targeting.
      // No symbol-pack push here anymore: the agent pulls code via mcp__deck__*.
      const [rc, vq] = await Promise.all([
        withTimeout(window.deck.retrieveContext(cwd, rq, 10), 2500, null)
          .catch(() => null),
        withTimeout(window.deck.vectorQuery(cwd, rq, 12), 2500, null)
          .catch(() => null),
      ]);
      // ranked lexical files + semantic-only files folded in, name + symbols
      const files = [];
      if (rc && rc.ok && Array.isArray(rc.files)) {
        for (const f of rc.files) files.push({ rel: f.rel, symbols: f.symbols });
      }
      const vhits = (vq && vq.ready && Array.isArray(vq.hits)) ? vq.hits : [];
      for (const h of vhits) {
        const cut = h.id.lastIndexOf('#');
        const rel = cut > 0 ? h.id.slice(0, cut) : h.id;
        if (rel && !files.some(f => f.rel === rel)) files.push({ rel });
      }
      const shown = files.slice(0, 10);
      // eval prediction recorded even when the inject below gets deduped —
      // retrieval still ranked these files for this message
      if (files.length) {
        r.evalPredicted = shown.map(f => f.rel);
        r.evalWarm = true;
      }
      // keyed by the session being resumed — a different session's transcript
      // does NOT carry the previous block, so its dedupe must not apply
      const sess = opts.resume || getSession() || '';
      const targetKey = sess + '::' + shown.map(f => f.rel).sort().join('|');
      if (files.length && lastTargets.get(agentId) === targetKey) {
        // same target set as the previous message — the transcript already
        // carries the block; re-injecting it would just duplicate tokens
        feed(agentId, 'sys',
          `per-message retrieval: targets unchanged — inject skipped`, '🧬');
      } else if (files.length) {
        lastTargets.set(agentId, targetKey);
        const lines = shown.map(f =>
          `- ${f.rel}${f.symbols && f.symbols.length
            ? ' — ' + f.symbols.slice(0, 6).join(', ') : ''}`).join('\n');
        fullPrompt += `\n\nTARGET FILES for THIS message (auto-retrieved from ` +
          `the project index — this is where the request lives):\n${lines}`;
        fullPrompt += `\n\nEFFICIENCY: retrieval already located this ` +
          `message's code (list above). Pull implementations via ` +
          `mcp__deck__search_code / mcp__deck__get_symbols (indexed, instant) ` +
          `instead of Glob/Grep surveys; Read only the exact spans you will edit.`;
        feed(agentId, 'sys',
          `per-message retrieval: ${files.length} target files`, '🧬');
      }
    } catch {}
  }

  // launch transparency — attribute slow starts at a glance: this line is the
  // renderer-side prep cost; the Δ shown on the ⚡session line is the SDK
  // subprocess spawn + session-resume cost. Model latency is everything after.
  const prepMs = Math.round(performance.now() - prepT0);
  const injectedK = (fullPrompt.length - prompt.length) / 1000;
  if (prepMs > 300 || injectedK > 0.5) {
    feed(agentId, 'sys',
      `context assembled in ${prepMs}ms · +${injectedK.toFixed(1)}k chars injected · spawning…`, '⏱');
  }
  r.spawnT0 = Date.now();
  await window.deck.runAgent({
    runId: r.runId, agentId, prompt: fullPrompt,
    model, cwd, rules: effectiveRules(a),
    permissionMode: plan ? 'plan' : a.perm,
    leanContext: !!a.lean,
    // constrain OUTPUT tokens (~5x the cost of input) on executor roles; the
    // planner (prompt/custom) stays verbose so its plan stays complete
    concise: !!a.lean || ['senior', 'uiux', 'reviewer'].includes(a.role),
    // pass a real Claude effort level only when one is chosen ('auto' = none)
    effort: EFFORT_VALUES.includes(effort) ? effort : null,
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
    forkSession: opts.resume ? (opts.fork !== false) : fork,
    // resume under the cwd the session was created in (its SDK slug) so the CLI
    // finds it — the `cwd` field above stays project-scoped for context injection
    resumeCwd: opts.cont ? getSessionCwd() : (opts.resume ? opts.cwd : null)
  });
}

function stopAgent(agentId) {
  const r = R(agentId);
  if (!r.running || !r.runId) return;
  window.deck.stopAgent(r.runId);
  // If the run never reached its 'init' event it may still be wedged in the
  // pre-spawn context assembly, where NO main-process run exists to abort and
  // emit 'done' — so the stop above is a no-op and r.running would stay stuck
  // true, blocking any re-run. Recover locally: disarm the watchdog and reset.
  // (A real spawned run also emits 'done' shortly; that handler is idempotent.)
  if (!r.sessionId) {
    if (r.initWatch) { clearTimeout(r.initWatch); r.initWatch = null; }
    r.running = false;
    setRunningUI(agentId, false);
    return;
  }
  // The subprocess can take a moment to actually die, and trailing stream/tool
  // events keep landing in the meantime — without this they'd keep overwriting
  // the status/thinking row back to "thinking…"/tool narration, making Stop
  // look like it silently did nothing. Pin the UI to "aborting…" right away;
  // cleared when 'done' finally lands (see case 'done').
  r.aborting = true;
  ticker(agentId, 'aborting…');
  showThinking(agentId, 'aborting…');
}

function setRunningUI(agentId, running) {
  if (!running) ticker(agentId, 'standing by', true);
  renderRoster();
  renderChatList();      // per-chat row spinners follow run state
  renderActivity();
  renderRail();          // keep the rail's per-project running badges live
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

  // the launch produced an event → the run is alive, disarm the init watchdog
  if (r.initWatch) { clearTimeout(r.initWatch); r.initWatch = null; }

  // mirror this run's events into a modal, if one registered a sink for it
  if (runEventSinks[ev.runId]) { try { runEventSinks[ev.runId](ev); } catch {} }

  switch (ev.kind) {
    case 'init': {
      r.sessionId = ev.sessionId;
      // persist the session linkage NOW, before any work runs — a run the
      // operator interrupts (app restart, crash) never reaches 'done', so the
      // owning chat/ticket would otherwise forget which session to resume and
      // start the next message cold. Fires on every init (a missing-session
      // fresh-retry emits a new one) so the LATEST id always wins.
      if (runSessionCallbacks[ev.runId]) {
        try { runSessionCallbacks[ev.runId](ev.sessionId); } catch {}
      }
      // Δ = SDK subprocess spawn + transcript resume, the cost a persistent
      // CLI session doesn't pay — watch this to see where slow starts live
      const spawnS = r.spawnT0 ? ((Date.now() - r.spawnT0) / 1000).toFixed(1) : null;
      feed(ev.agentId, 'sys',
        `session ${ev.sessionId.slice(0, 8)} · ${ev.model}` +
        (spawnS ? ` · spawned in ${spawnS}s` : ''), '⚡');
      ticker(ev.agentId, 'thinking...');
      showThinking(ev.agentId, 'thinking…');
      break;
    }
    case 'session-invalid':
      // the resumed session no longer exists on disk — forget it so it isn't
      // reused; the run auto-retries with a fresh context in the main process
      if (getSession() === ev.sessionId) clearSession();
      clearPESession(ev.sessionId);
      r.noShare = false;
      feed(ev.agentId, 'sys', ev.restored
        ? 'stored session was stale — restored prior context into a fresh session.'
        : 'stored session was stale — starting a fresh context.', '↺');
      break;
    case 'text-delta':
      // a delta with no open stream element starts a fresh assistant message —
      // keep only the latest one, it's the agent's closing summary
      hideThinking(ev.agentId);                 // text is arriving — stop "thinking"
      if (!streamEls[ev.agentId]) { r.lastText = ''; ticker(ev.agentId, 'writing response...'); }
      r.lastText = (r.lastText || '') + ev.text;
      feed(ev.agentId, 'txt', ev.text, '', true);
      break;
    case 'text-end': {
      // the message is complete — swap the raw streamed text for rendered
      // markdown so headings/lists/code read cleanly instead of # and *.
      const sEl = streamEls[ev.agentId];
      const bodyEl = sEl && sEl.querySelector('.body');
      if (bodyEl) {
        bodyEl.innerHTML = renderMarkdown(bodyEl.textContent);
        bodyEl.classList.add('md-body');
      }
      endStream(ev.agentId);
      showThinking(ev.agentId, 'thinking…');     // may still call more tools
      break;
    }
    case 'tool': {
      endStream(ev.agentId);
      hideThinking(ev.agentId);
      const ico = TOOL_ICON[ev.tool] || '⚙';
      let inp = null;
      // editInput is the UNtruncated payload for edit tools (ev.input is
      // capped at 400 chars in main.js and won't parse for real edits)
      try { inp = JSON.parse(ev.editInput || ev.input); } catch {}
      // edits get a diff card instead of a bare log line
      if (inp && /^(Edit|MultiEdit|Write)$/.test(ev.tool)) {
        // retrieval eval: remember which files actually got edited this run
        const editedPath = inp.file_path || inp.path || '';
        if (editedPath && r.evalEdited) r.evalEdited.add(editedPath);
        feedDiff(ev.agentId, ev.tool, inp, ev.editLines);
        const fn = (inp.file_path || inp.path || '').split(/[\\/]/).pop();
        ticker(ev.agentId, `${ev.tool} ▸ ${fn}`);
        showThinking(ev.agentId, `${ev.tool} ▸ ${fn}`);
        break;
      }
      // a human sentence ("Let me check X", "Searching for Y…"); the result
      // chip is appended on 'tool-result' to complete it ("… 142 lines")
      const narr = String(toolNarration(ev.agentId, ev.tool, inp, ev.input)).slice(0, 160);
      const row = feed(ev.agentId, 'tool', narr, ico);
      if (row && ev.id) { row.dataset.toolId = ev.id; toolRowEls[ev.id] = row; }
      ticker(ev.agentId, narr);
      showThinking(ev.agentId, narr);
      break;
    }
    case 'tool-result': {
      // land the outcome (142 lines / 8 matches / ok / failed) on its tool row so
      // the operator sees WHAT the read/search/command returned, not just that it ran
      const row = toolRowEls[ev.id];
      if (row) {
        const chip = document.createElement('span');
        chip.className = 'tres' + (ev.ok ? '' : ' err');
        chip.textContent = ev.summary || (ev.ok ? 'done' : 'failed');
        row.appendChild(chip);
        delete toolRowEls[ev.id];
        if (feedElFor(ev.agentId) === consoleFeed) pinFeedToBottom();
      }
      break;
    }
    case 'result': {
      hideThinking(ev.agentId);
      r.sessionId = ev.sessionId || r.sessionId;
      if (ev.sessionId && !r.noShare) {
        setSession(ev.sessionId); setSessionModel(r.curModel);
        setSessionCwd(r.cpCwd);   // resume under this cwd so the SDK slug matches
      }
      r.lastResult = ev.subtype;
      trackUsage(ev);
      const doneAgent = findAgent(ev.agentId);
      // only remember this as "the pipeline's warm planning session" when it
      // actually WAS a pipeline planning run (Stage 1 / a plan revision) — a
      // manual chat or ticket run with the Prompt Engineer must never become
      // the session the NEXT auto-pipeline run resumes into.
      if (ev.sessionId && doneAgent && doneAgent.role === 'prompt' && doneAgent.cwd) {
        const pePipe = pipelines.get(wsForAgent(ev.agentId));
        if (pePipe && pePipe.active && pePipe.stage === 'prompt') savePESession(doneAgent.cwd, ev.sessionId);
      }
      if (ev.sessionId && doneAgent && doneAgent.role === 'reviewer') {
        const rvPipe = pipelines.get(wsForAgent(ev.agentId));
        if (rvPipe && rvPipe.active) rvPipe.reviewerSessionId = ev.sessionId;
      }
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
      hideThinking(ev.agentId);
      r.lastResult = 'aborted';
      feed(ev.agentId, 'err', 'aborted by operator.', '■');
      break;
    case 'error':
      hideThinking(ev.agentId);
      r.lastResult = 'error';
      feed(ev.agentId, 'err', 'ERROR: ' + ev.error, '⚠');
      break;
    case 'done': {
      r.running = false;
      r.aborting = false;
      endStream(ev.agentId);
      hideThinking(ev.agentId);
      // any agent may have written/updated topic memories — capture fingerprints
      // of their covered files so staleness detection works next time.
      const finishedAgent = findAgent(ev.agentId);
      const memCwd = (finishedAgent && finishedAgent.cwd) || projectDir;
      if (finishedAgent && finishedAgent.role !== 'indexer' && memCwd) {
        window.deck.memoryReindex(memCwd).catch(() => {});
      }
      // retrieval eval: did the pre-ranked list contain the edited files?
      logRetrievalEval(r, r.cpCwd || memCwd);
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
      delete runSessionCallbacks[ev.runId];
      if (r.cpStandalone && r.cpCwd) { cpEndTask(r.cpCwd); r.cpStandalone = false; }
      if (typeof gitRefresh === 'function' && gitRepo) gitRefresh();
      // a MANUAL Prompt Engineer run (outside the pipeline) that produced task
      // files → offer to deploy engineers, so the work doesn't just stop
      const doneWsId = wsForAgent(ev.agentId);
      if (typeof refreshWorkspace === 'function'
          && doneWsId === activeWorkspaceId) {
        refreshWorkspace();
      }
      const doneWsPipe = pipelines.get(doneWsId);
      if (!(doneWsPipe && doneWsPipe.active) && r.lastResult === 'success') {
        const da = findAgent(ev.agentId);
        // only prompt the deploy offer when its project is on screen — don't
        // pop a card into whatever project the operator is currently viewing
        if (da && da.role === 'prompt' && da.cwd && doneWsId === activeWorkspaceId) {
          maybeOfferDeploy(da.cwd, doneWsId, r.startedAt);
        }
      }
      onPipelineAgentDone(ev.agentId, r.lastResult)
        .then(() => {
          const afterPipe = pipelines.get(doneWsId);
          if (!afterPipe || !afterPipe.active) cleanupSeniors(doneWsId);
        });
      break;
    }
  }
});

// ============================================================
// AUTO PIPELINE ORCHESTRATOR
// prompt -> PLAN REVIEW (operator gate) -> build -> review -> loop
// ============================================================
// each project runs its own pipeline independently — state lives in a Map
// keyed by workspace id (not a single shared object), the same way each
// project already keeps its own agent roster.
function freshPipe() {
  return {
    active: false, stage: null, cwd: '', iteration: 0, maxIter: 5,
    pending: new Set(), taskAssign: new Map(), planTasks: [], taskModels: new Map(),
    taskContent: new Map(),
    reviewModel: null,
    // per-run reasoning-effort override (e.g. a workspace ticket's REASONING
    // choice) — null means "use the global session setting" as before
    effort: null,
    // Reviewer's own session for THIS run — resumed (not forked) on re-review
    // passes so it keeps everything it already read/validated in context instead
    // of re-reading unchanged files from scratch on every rejection loop.
    reviewerSessionId: null,
    pendingIssue: null,
    // plan-review data captured when the plan lands — the modal is a single
    // shared DOM element, so it's populated lazily (on open) from here instead
    // of at plan-ready time, which would clobber another project's open modal.
    planCardEl: null, planFiles: [], planSummary: '',
    // true once PASS TO ENGINEERS has been clicked for the current plan —
    // reopening the plan-review modal must show the button disabled instead
    // of allowing a second, duplicate deploy.
    engineersAssigned: false
  };
}
const pipelines = new Map();   // wsId -> pipe state
function pipeFor(wsId) {
  if (!pipelines.has(wsId)) pipelines.set(wsId, freshPipe());
  return pipelines.get(wsId);
}
// true if ANY project's pipeline (not just the active one) already owns cwd —
// used only to decide checkpoint co-location, so it must see every project.
function pipelineActiveForCwd(cwd) {
  for (const p of pipelines.values()) if (p.active && p.cwd === cwd) return true;
  return false;
}
// which project's plan is currently populated into the (single, shared)
// plan-review modal
let planReviewWsId = null;

// roster of a SPECIFIC project (not whichever one is on screen) — the pipeline
// orchestrator must always act on the project that owns it, even in the
// background, never the "currently displayed" `agents` pointer.
function rosterFor(wsId) {
  const w = workspaces.find(x => x.id === wsId);
  return (w && w.agents) || agents;
}
function byRoleIn(wsId, role) { return rosterFor(wsId).filter(a => a.role === role); }
function uiuxAgentIn(wsId) { return byRoleIn(wsId, 'uiux')[0]; }
// persist a roster mutation for a specific project — save() assumes it's
// mutating the ACTIVE roster (it re-links `agents` and mirrors a legacy key),
// so a background project's mutation goes straight to storage instead.
function saveRosterFor(wsId) {
  if (wsId === activeWorkspaceId) save();
  else saveWorkspaces();
}

// "MODEL: <id>" line written by the Prompt Engineer — routes each task to the
// cheapest model that fits its complexity
function parseModelLine(content, key = 'MODEL') {
  const m = new RegExp('^' + key + ':\\s*(\\S+)', 'mi').exec(content || '');
  return m && MODEL_LABELS[m[1]] ? m[1] : null;
}

// pipeline log lines go straight to the central console
function plog(cls, text, wsId) {
  const map = { ok: 'ok', err: 'err', info: 'sys' };
  feedRaw('PIPELINE', map[cls] || 'sys', text, '⟢',
    wsId === undefined ? activeWorkspaceId : wsId);
}

function setStage(wsId, stage) {
  pipeFor(wsId).stage = stage;
  if (wsId === activeWorkspaceId) renderActivity();
}

function byRole(role) { return agents.filter(a => a.role === role); }

async function launchPipeline(issue, effort, wsId) {
  const pe = byRoleIn(wsId, 'prompt')[0];
  if (!pe) { plog('err', 'no Prompt Engineer agent on roster.', wsId); return; }
  if (!pe.cwd) {
    plog('err',
      'set a working directory on PROMPT-ENGINEER first (⚙), or import a project.',
      wsId);
    return;
  }

  const p = pipeFor(wsId);
  p.active = true;
  p.cwd = pe.cwd;
  cpBeginTask(p.cwd, issue);
  p.iteration = 0;
  p.effort = effort || null;
  p.reviewerSessionId = null;
  p.pending.clear();
  p.taskAssign.clear();
  p.engineersAssigned = false;
  if (planReviewWsId === wsId) hidePlanReview();

  await window.deck.pipelineReset(p.cwd);
  plog('info', 'pipeline dir reset.', wsId);

  let st = { exists: false, stale: false, changedFiles: [] };
  try { st = await window.deck.indexStatus(p.cwd); } catch {}

  if (st.exists && !st.stale) {
    plog('info', 'project index fresh — skipping Stage 0.', wsId);
    startStage1(issue, wsId);
    return;
  }

  const indexer = byRoleIn(wsId, 'indexer')[0];
  if (!indexer) {
    plog('err', 'no Indexer agent on roster — skipping Stage 0.', wsId);
    startStage1(issue, wsId);
    return;
  }
  if (!indexer.cwd) { indexer.cwd = p.cwd; saveRosterFor(wsId); }

  p.pendingIssue = issue;
  setStage(wsId, 'index');
  const prompt = st.exists
    ? `These files changed since the last index: ${st.changedFiles.join(', ')}\nUpdate only the affected sections of .loveai/index/PROJECT-MAP.md per your rules.`
    : 'Index this project per your rules.';
  plog('info', st.exists
    ? 'project index stale — Stage 0: INDEXER updating map...'
    : 'no project index — Stage 0: INDEXER mapping project...', wsId);
  runAgent(indexer.id, prompt, false, false, { fresh: true, effort: p.effort });
}

async function startStage1(issue, wsId) {
  const p = pipeFor(wsId);
  const pe = byRoleIn(wsId, 'prompt')[0];
  plog('info', 'Stage 1: PROMPT ENGINEER analyzing...', wsId);
  setStage(wsId, 'prompt');
  // token-lean: every issue starts the PE FRESH. Topic memory + the retrieval
  // front-load ARE its warm context — resuming (and forking) the stored PE
  // session here replayed every PRIOR issue's full planning transcript (front-
  // loaded file contents, tool results, all of it) as paid input on each new
  // launch, growing without bound. The saved PE session remains in use where a
  // shared context is actually wanted: plan revisions and the post-run chat
  // bridge, both of which resume it explicitly.
  //
  // Context (semantic vector/RAG + lexical + regression impact) is injected by
  // runAgent's shared retrieval block for every role, so the PE gets it here too —
  // no separate injection needed. The directive keeps it from re-exploring.
  runAgent(pe.id,
    `ISSUE: ${issue}\n\nUsing the retrieved context provided, produce the executable ` +
    `task prompt file(s) and review-brief.md per your pipeline rules. Do AT MOST ` +
    `1-2 targeted reads only if a specific symbol you need is missing.`,
    false, false, { effort: p.effort });
}

// BRIDGE — hand the pipeline's own context to whatever you chat with next
// (bare model or a roster agent's follow-up), so asking a question right after
// a run doesn't land in an empty session. The Reviewer read the fullest picture
// of what changed (falls back to the Prompt Engineer's session); it's ONLY the
// shared-session pointer that moves — no pipeline agent's own run is touched,
// so every stage still runs exactly as fresh/token-lean as before. Only
// meaningful for the project you're actually looking at (setSession/getSession
// are keyed off the active project's directory), so a background project's
// pipeline ending never redirects your current chat session out from under you.
function bridgePipelineSession(wsId) {
  if (wsId !== activeWorkspaceId) return;
  const p = pipeFor(wsId);
  const sid = p.reviewerSessionId || getPESession(p.cwd);
  if (!sid) return;
  setSession(sid);
  feedRaw('SESSION', 'sys',
    'follow-up context bridged — chat with a model or agent below to continue from what the pipeline just did (↺ New session to start fresh instead).',
    '🔗', wsId);
}

function abortPipeline(msg, wsId) {
  const p = pipeFor(wsId);
  p.active = false;
  setStage(wsId, null);
  cpEndTask(p.cwd);
  if (wsId === activeWorkspaceId) hideReassigning();
  if (planReviewWsId === wsId) hidePlanReview();
  for (const id of p.pending) stopAgent(id);
  const pr = byRoleIn(wsId, 'prompt')[0]; if (pr && R(pr.id).running) stopAgent(pr.id);
  const rv = byRoleIn(wsId, 'reviewer')[0]; if (rv && R(rv.id).running) stopAgent(rv.id);
  if (msg) plog('err', msg, wsId);
  cleanupSeniors(wsId);
  bridgePipelineSession(wsId);
  if (window.wsPipelineEnded) window.wsPipelineEnded(wsId);
}

function finishPipeline(msg, wsId) {
  const p = pipeFor(wsId);
  p.active = false;
  setStage(wsId, null);
  cpEndTask(p.cwd);
  plog('ok', msg, wsId);
  cleanupSeniors(wsId);
  bridgePipelineSession(wsId);
  if (window.wsPipelineEnded) window.wsPipelineEnded(wsId);
}

// the pipeline may clone extra SENIOR-ENG agents for parallel builds — once the
// work is over, retire them so the roster returns to the default line-up.
// Operates directly on the OWNING project's roster (never the shared `agents`
// pointer), so cleaning up a background pipeline can't touch the roster of
// whatever project happens to be on screen.
function cleanupSeniors(wsId) {
  const w = workspaces.find(x => x.id === wsId);
  if (!w) return;
  const roster = w.agents || [];
  const keep = roster.find(a => a.id === 'def-senior-eng-01') || roster.find(a => a.role === 'senior');
  let removed = 0;
  const next = roster.filter(a => {
    if (a.role !== 'senior' || (keep && a.id === keep.id)) return true;
    if (R(a.id).running) return true;   // retired later, on its done event
    if (wsId === activeWorkspaceId && feedFilter === a.id) feedFilter = null;
    removed++;
    return false;
  });
  w.agents = next;
  if (wsId === activeWorkspaceId) agents = next;
  if (removed) {
    saveRosterFor(wsId);
    if (wsId === activeWorkspaceId) { render(); applyFilter(); }
    plog('info',
      `auto-retired ${removed} extra senior engineer(s) — roster back to default.`,
      wsId);
  }
}

// ---------- Plan review gate ----------
// The plan lands as a summary card at the end of the console; the card opens
// the full result (task files + follow-up chatbox) in a scrollable modal.
// The modal is a SINGLE shared DOM element (only one project's plan can be
// under review at a time) — its content is populated lazily on open from
// that project's own pipe.planFiles/planSummary, never at plan-ready time,
// so a background project's plan landing can't clobber a modal you have open.
const planModal = document.getElementById('plan-modal');

function openPlanModalFor(wsId) {
  planReviewWsId = wsId;
  const p = pipeFor(wsId);
  const tabs = document.getElementById('pr-tabs');
  const content = document.getElementById('pr-content');
  tabs.innerHTML = '';
  (p.planFiles || []).forEach((f, i) => {
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
  content.textContent = (p.planFiles && p.planFiles.length) ? p.planFiles[0].content : '(no plan files found)';
  document.getElementById('pr-summary').textContent = p.planSummary || '(no summary returned — open the card for the full plan)';
  const approveBtn = document.getElementById('pr-approve');
  approveBtn.disabled = !!p.engineersAssigned;
  approveBtn.textContent = p.engineersAssigned ? '✔ ASSIGNED TO ENGINEERS' : '✔ PASS TO ENGINEERS';
  planModal.classList.remove('hidden');
  document.getElementById('pr-revision').focus();
}
function hidePlanReview() { planModal.classList.add('hidden'); }

function feedPlanCard(wsId, summary, count) {
  const p = pipeFor(wsId);
  const cont = feedElForWs(wsId);
  if (cont === consoleFeed) hideFeedEmpty();
  const el = document.createElement('button');
  el.className = 'plan-result';
  el.innerHTML = `<div class="pl-head">🧠 PLAN READY <span class="pl-open">CLICK FOR FULL RESULT ▸</span></div>
    <div class="pl-summary"></div><div class="pl-meta"></div>`;
  const sum = el.querySelector('.pl-summary');
  sum.innerHTML = renderMarkdown(summary);
  sum.classList.add('md-body');
  el.querySelector('.pl-meta').textContent = `${count} task file(s) · awaiting your review`;
  el.onclick = () => openPlanModalFor(wsId);
  cont.appendChild(el);
  if (cont === consoleFeed) pinFeedToBottom();
  p.planCardEl = el;
}

// retire the pending card once the plan is approved, discarded or superseded
function closePlanCard(wsId, note) {
  const p = pipeFor(wsId);
  if (!p.planCardEl) return;
  p.planCardEl.classList.add('done');
  p.planCardEl.querySelector('.pl-meta').textContent = note;
  p.planCardEl.querySelector('.pl-open').textContent = 'VIEW ▸';
  p.planCardEl = null;
}

async function showPlanReview(wsId) {
  const p = pipeFor(wsId);
  setStage(wsId, 'plan');
  const files = await window.deck.pipelineRead(p.cwd);
  const relevant = files.filter(f => /^task-\d+.*\.md$/i.test(f.name) || f.name === 'review-brief.md');
  p.planFiles = relevant;

  const pe = byRoleIn(wsId, 'prompt')[0];
  const summary = (pe && (R(pe.id).lastText || '').trim()) || '(no summary returned — open the card for the full plan)';
  p.planSummary = summary;
  feedPlanCard(wsId, summary, p.planTasks.length);
  plog('info',
    `PLAN READY — ${p.planTasks.length} task file(s). Open the card above to review and pass to engineers.`,
    wsId);
}

document.getElementById('pr-close').onclick = hidePlanReview;

// Read the task files in .loveai/pipeline/, route each to an agent, and start the
// BUILD → REVIEW stages. Used both by the plan-approval gate AND when a manual
// (non-pipeline) Prompt Engineer run leaves task files that need executing.
async function deployEngineersFromDir(wsId) {
  const p = pipeFor(wsId);
  p.taskModels.clear();
  p.reviewModel = null;
  const uiTasks = new Set();
  const files = await window.deck.pipelineRead(p.cwd);
  p.taskContent = new Map();   // name → body, feeds each engineer's retrieval
  for (const f of files) {
    if (/^task-\d+.*\.md$/i.test(f.name)) {
      const m = parseModelLine(f.content);
      if (m) p.taskModels.set(f.name, m);
      p.taskContent.set(f.name, f.content);
      if (isUiTask(f.name + ' ' + f.content.slice(0, 2000))) uiTasks.add(f.name);
    } else if (f.name === 'review-brief.md') {
      p.reviewModel = parseModelLine(f.content, 'REVIEW-MODEL');
    }
  }
  const tasks = p.planTasks.slice(0, 4);
  const ui = uiuxAgentIn(wsId);
  const uiAssigned = ui ? tasks.filter(t => uiTasks.has(t)) : [];
  const genTasks = tasks.filter(t => !uiAssigned.includes(t));
  const n = Math.min(Math.max(genTasks.length, 1), 4);
  plog('ok',
    `deploying ${genTasks.length ? n + ' senior(s)' : 'engineers'}` +
    `${uiAssigned.length ? ' + UI/UX engineer' : ''}...`,
    wsId);
  const seniors = genTasks.length ? ensureSeniors(Math.min(genTasks.length, 4), wsId) : [];
  p.taskAssign.clear();
  genTasks.forEach((t, i) => p.taskAssign.set(seniors[i % seniors.length].id, t));
  uiAssigned.forEach((t, i) => {
    if (i === 0) {
      if (!ui.cwd) { ui.cwd = p.cwd; saveRosterFor(wsId); }
      p.taskAssign.set(ui.id, t);
      plog('info', `${t} ▸ routed to ${ui.name} (UI task)`, wsId);
    }
    else if (seniors.length) p.taskAssign.set(seniors[i % seniors.length].id, t);
    else { const s = ensureSeniors(1, wsId); p.taskAssign.set(s[0].id, t); }
  });
  plog('info', 'Stage 3: BUILD — engineers executing in parallel...', wsId);
  startBuild('execute', wsId);
}

document.getElementById('pr-approve').onclick = async () => {
  const wsId = planReviewWsId;
  if (wsId == null) return;
  const p = pipeFor(wsId);
  if (!p.active || p.stage !== 'plan' || p.engineersAssigned) return;
  p.engineersAssigned = true;
  hidePlanReview();
  closePlanCard(wsId, 'approved — passed to engineers');
  await deployEngineersFromDir(wsId);
};

// A manual Prompt Engineer run left task files but there's no live pipeline to run
// them — offer a one-click deploy so the work doesn't just stop.
// `sinceTs` is the run's start time: only task files this run actually wrote
// (mtime after the run started) qualify — stale files left by an earlier,
// unrelated session must not resurface as a deploy offer.
async function maybeOfferDeploy(cwd, wsId, sinceTs) {
  if (pipeFor(wsId).active) return;
  let scan; try { scan = await window.deck.pipelineScan(cwd); } catch { return; }
  if (!scan || !scan.tasks || !scan.tasks.length) return;
  const fresh = sinceTs
    ? scan.tasks.filter(t => (scan.taskMtimes?.[t] || 0) >= sinceTs)
    : scan.tasks;
  if (!fresh.length) return;
  feedDeployCard(cwd, fresh, wsId);
}

function feedDeployCard(cwd, taskNames, wsId) {
  const cont = feedElForWs(wsId);
  if (cont === consoleFeed) hideFeedEmpty();
  const el = document.createElement('button');
  el.className = 'plan-result';
  el.innerHTML = `<div class="pl-head">🚀 TASK FILES READY <span class="pl-open">▶ DEPLOY ENGINEERS</span></div>
    <div class="pl-summary"></div><div class="pl-meta"></div>`;
  el.querySelector('.pl-summary').textContent = taskNames.join(', ');
  el.querySelector('.pl-meta').textContent = `${taskNames.length} task file(s) — click to build + review with your roster`;
  el.onclick = async () => {
    const p = pipeFor(wsId);
    if (p.active) { plog('err', 'a pipeline is already running.', wsId); return; }
    el.classList.add('done');
    el.querySelector('.pl-meta').textContent = 'deploying…';
    p.active = true; p.cwd = cwd; p.iteration = 0;
    p.planTasks = taskNames;
    await deployEngineersFromDir(wsId);
  };
  cont.appendChild(el);
  if (cont === consoleFeed) pinFeedToBottom();
}

document.getElementById('pr-discard').onclick = () => {
  const wsId = planReviewWsId;
  if (wsId == null || !pipeFor(wsId).active) { hidePlanReview(); return; }
  closePlanCard(wsId, 'discarded by operator');
  abortPipeline('plan discarded by operator.', wsId);
};

function revisePlan() {
  const wsId = planReviewWsId;
  const box = document.getElementById('pr-revision');
  const text = box.value.trim();
  if (!text || wsId == null) return;
  const p = pipeFor(wsId);
  if (!p.active || p.stage !== 'plan') return;
  const pe = byRoleIn(wsId, 'prompt')[0];
  if (!pe) return;
  box.value = '';
  hidePlanReview();
  closePlanCard(wsId, 'superseded by a revision request');
  setStage(wsId, 'prompt');
  plog('info', 'revision requested — Prompt Engineer updating the plan...', wsId);
  // resume the PE's own planning session so the plan (and the analysis behind
  // it) is still in context — runs no longer inherit the shared session
  const resume = getPESession(p.cwd) || R(pe.id).sessionId;
  runAgent(pe.id, `PLAN REVISION REQUEST: ${text}

Update the existing plan files in .loveai/pipeline/ accordingly. Modify ONLY the sections affected by this revision — keep every unaffected section exactly as it is. Edit the existing task-*.md / review-brief.md files in place (add or delete files only if the revision requires it), then summarize what changed.`,
    false, false, resume ? { resume, fork: false } : {});
}
document.getElementById('pr-revise-btn').onclick = revisePlan;
document.getElementById('pr-revision').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') revisePlan();
});

// ---------- Stages ----------
// Clones/registers extra SENIOR-ENG agents directly on the OWNING project's
// roster (never the shared `agents` pointer) so a background pipeline can
// grow its own build team without touching whatever project is on screen.
function ensureSeniors(n, wsId) {
  const w = workspaces.find(x => x.id === wsId);
  const p = pipeFor(wsId);
  let seniors = (w.agents || []).filter(a => a.role === 'senior');
  const template = seniors[0] || DEFAULT_AGENTS[1];
  while (seniors.length < n) {
    const idx = seniors.length + 1;
    const clone = {
      ...template,
      id: uid(),
      name: 'SENIOR-ENG-0' + idx,
      role: 'senior',
      cwd: p.cwd,
      rules: RULES.senior
    };
    w.agents.push(clone);
    seniors = w.agents.filter(a => a.role === 'senior');
  }
  for (const s of seniors) if (!s.cwd) s.cwd = p.cwd;
  if (wsId === activeWorkspaceId) agents = w.agents;
  saveRosterFor(wsId);
  if (wsId === activeWorkspaceId) render();
  return seniors.slice(0, n);
}

function startBuild(taskCmd, wsId) {
  const p = pipeFor(wsId);
  setStage(wsId, 'build');
  const entries = [...p.taskAssign.entries()];
  p.pending = new Set(entries.map(([agentId]) => agentId));
  for (const [agentId, taskFile] of entries) {
    const prompt = taskCmd === 'fix'
      ? `Fix review findings: read .loveai/pipeline/review-findings.md and fix ONLY the findings for your task file (${taskFile}), per your rules. Then update changes-log.md.`
      : `Execute ${taskFile}: read .loveai/pipeline/${taskFile} and follow it strictly per your pipeline rules.`;
    // token-lean: task files are self-contained, so each senior starts FRESH
    // (no replay of the whole planning conversation) on the model the Prompt
    // Engineer rated for that task's complexity
    const model = learnedModel(p.taskModels.get(taskFile));   // learner may bump an unreliable model
    const a = findAgent(agentId);
    if (model) {
      plog('info',
        `${a ? a.name : agentId} ▸ ${taskFile} on ${MODEL_LABELS[model]} (complexity-routed)`,
        wsId);
    }
    // key retrieval on the TASK BODY (minus the routing header), not the
    // "Execute task-NN…" wrapper — so the engineer's front-load ranks the
    // files the task is actually about and it never re-researches the plan
    const body = (p.taskContent && p.taskContent.get(taskFile)) || '';
    const retrievalQuery = body
      ? body.replace(/^COMPLEXITY:.*$/m, '').replace(/^MODEL:.*$/m, '')
          .trim().slice(0, 2500)
      : null;
    runAgent(agentId, prompt, false, false,
      { model, fresh: true, effort: p.effort, retrievalQuery });
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
async function pickFixerByAI(findings, wsId) {
  const roster = rosterFor(wsId);
  const candidates = roster.filter(a => ['senior', 'uiux', 'custom'].includes(a.role));
  if (candidates.length <= 1) return candidates[0] || byRoleIn(wsId, 'senior')[0] || uiuxAgentIn(wsId);
  const list = candidates.map(a => `- ${a.name} [${a.role}]: ${ROLE_CAP[a.role] || 'general engineering'}`).join('\n');
  const prompt = `Route this code-review rejection to the SINGLE best engineer to IMPLEMENT the fixes. Judge by what the findings actually require (front-end vs backend vs mixed).

ENGINEERS:
${list}

REVIEW FINDINGS:
${String(findings).slice(0, 7000)}

Reply with ONLY the exact engineer name from the list above — one line, nothing else.`;
  try {
    const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', pipeFor(wsId).cwd);
    if (r.ok && r.text) {
      const name = r.text.trim().split('\n')[0].replace(/["'`.*_]/g, '').trim().toLowerCase();
      const hit = candidates.find(a => a.name.toLowerCase() === name)
        || candidates.find(a => name.includes(a.name.toLowerCase()))
        || candidates.find(a => name.includes(a.role));
      if (hit) return hit;
    }
  } catch {}
  return byRoleIn(wsId, 'senior')[0] || candidates[0] || uiuxAgentIn(wsId);   // safe fallback
}

async function startFixRound(wsId) {
  const p = pipeFor(wsId);
  setStage(wsId, 'build');
  const files = await window.deck.pipelineRead(p.cwd);
  const findings = (files.find(f => f.name === 'review-findings.md') || {}).content || '';
  const fixer = await pickFixerByAI(findings, wsId);
  if (wsId === activeWorkspaceId) hideReassigning();
  if (!fixer) { abortPipeline('no engineer available to fix findings — halted.', wsId); return; }
  if (!fixer.cwd) { fixer.cwd = p.cwd; saveRosterFor(wsId); }
  p.pending = new Set([fixer.id]);
  p.taskAssign = new Map([[fixer.id, 'review-findings.md']]);   // so onDone counts it
  plog('err',
    `REJECTED — fix round ${p.iteration}: AI routed ALL findings to ` +
    `${fixer.name} (${ROLE_LABEL[fixer.role] || fixer.role}).`,
    wsId);
  const prompt = `The Reviewer REJECTED this work. Read .loveai/pipeline/review-findings.md AND the original task file(s) in .loveai/pipeline/, then COMPLETE the feature so every finding is resolved and every acceptance criterion is met. You own ALL findings this round — do NOT skip any because it "belongs to another task".

IMPORTANT: findings that say a file is "untouched", a component/prop/filter/badge is "missing", or a criterion "doesn't exist" mean that work was NEVER DONE — you must IMPLEMENT it now (edit the real component/source files named in the findings; create code where it's missing). Do not just tweak what already changed.

For each finding: implement the fix in the actual files, OR — only if you are certain it is a FALSE POSITIVE — leave it and write an evidence-backed justification in changes-log.md. Then append everything you did to .loveai/pipeline/changes-log.md. Verify against the acceptance criteria before finishing.`;
  // key retrieval on the findings themselves (they name the broken files/symbols)
  runAgent(fixer.id, prompt, false, false, {
    fresh: true, effort: p.effort,
    retrievalQuery: findings ? findings.slice(0, 2500) : null
  });
}

// the Prompt Engineer is supposed to write review-brief.md. If a run skipped it
// (e.g. a manual/partial plan), synthesize a fallback so the Reviewer always has
// proper scope instead of guessing from a lone task file.
async function ensureReviewBrief(wsId) {
  const p = pipeFor(wsId);
  const cwd = p.cwd;
  const files = await window.deck.pipelineRead(cwd);
  if (files.some(f => f.name === 'review-brief.md')) return;
  const tasks = files.filter(f => /^task-\d+.*\.md$/i.test(f.name));
  const changes = (files.find(f => f.name === 'changes-log.md') || {}).content || '';
  const model = p.reviewModel || 'claude-sonnet-5';
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
  plog('info', 'no review-brief.md found — generated a fallback brief for the Reviewer.', wsId);
  if (!p.reviewModel) p.reviewModel = model;
}

async function startReview(wsId) {
  const p = pipeFor(wsId);
  setStage(wsId, 'review');
  const rv = byRoleIn(wsId, 'reviewer')[0];
  if (!rv) { abortPipeline('no Reviewer agent on roster.', wsId); return; }
  if (!rv.cwd) { rv.cwd = p.cwd; saveRosterFor(wsId); }
  await ensureReviewBrief(wsId);   // guarantee the Reviewer has a brief
  plog('info', `Stage 4: REVIEWER validating (pass ${p.iteration + 1})...`, wsId);
  // Resume (never fork) the reviewer's OWN session from the previous pass so it
  // keeps every file it already read/validated in context — a fresh session
  // every pass forced a full from-scratch re-read even when only one file
  // changed. Only the very first pass runs fresh (nothing to resume yet).
  const resume = p.reviewerSessionId;
  const opts = resume
    ? { model: p.reviewModel, fresh: true, resume, fork: false, effort: p.effort }
    : { model: p.reviewModel, fresh: true, effort: p.effort };
  // point the Reviewer at THIS task's checkpoint ref so it can diff against its
  // own pre-task baseline instead of `git diff HEAD` / the raw working tree —
  // the working tree may still carry unrelated uncommitted edits left over from
  // an earlier, unrelated session, and those must not be misread as in-scope.
  const cp = await cpActiveRef(p.cwd);
  const scopeHint = cp
    ? `\n\nSCOPE: this task's pre-task checkpoint is git ref ${cp.ref} (repo: ${cp.repo}). To see ONLY what THIS task changed, run \`git diff ${cp.ref} -- <file>\` per changed file — do NOT judge scope from \`git diff HEAD\` or the raw working tree. Anything already present at that checkpoint ref predates this task; it is not this task's change and must not be flagged as out-of-scope, even if a blanket working-tree diff shows it.`
    : '';
  runAgent(rv.id, p.iteration === 0
    ? `Review the pipeline changes per your rules. Write validation-plan.md first, then review-findings.md with a VERDICT first line.${scopeHint}`
    : `The Senior Engineers applied fixes for the findings you listed last round (see the newest entries in changes-log.md). You already have full context from your last review still loaded — do NOT re-read files you already validated and found fine; re-check ONLY the files touched by this fix round against those specific findings, then write a fresh review-findings.md with a VERDICT first line.${scopeHint}`,
    false, false, opts);
}

async function onPipelineAgentDone(agentId, result) {
  const wsId = wsForAgent(agentId);
  const p = pipelines.get(wsId);
  if (!p || !p.active) return;
  const a = findAgent(agentId);
  if (!a) return;

  if (p.stage === 'index' && a.role === 'indexer') {
    if (result === 'success') {
      try { await window.deck.indexMark(p.cwd); } catch {}
    } else {
      plog('err', `${a.name} ${result} building the index — continuing without it.`, wsId);
    }
    const issue = p.pendingIssue;
    p.pendingIssue = null;
    startStage1(issue, wsId);
    return;
  }

  if (result === 'error' || result === 'aborted') {
    abortPipeline(`${a.name} ${result} — pipeline halted.`, wsId);
    return;
  }

  if (p.stage === 'prompt' && a.role === 'prompt') {
    const scan = await window.deck.pipelineScan(p.cwd);
    if (!scan.tasks.length) { abortPipeline('Prompt Engineer produced no task files — halted.', wsId); return; }
    p.planTasks = scan.tasks;
    await showPlanReview(wsId);
    return;
  }

  if (p.stage === 'build' && (a.role === 'senior' || a.role === 'uiux')) {
    p.pending.delete(agentId);
    plog('ok', `${a.name} finished (${p.pending.size} still working).`, wsId);
    if (p.pending.size === 0) startReview(wsId);
    return;
  }

  if (p.stage === 'review' && a.role === 'reviewer') {
    const scan = await window.deck.pipelineScan(p.cwd);
    if (scan.verdict === 'APPROVED') {
      finishPipeline(`APPROVED after ${p.iteration + 1} review pass(es). Pipeline complete. ✔`, wsId);
    } else if (scan.verdict === 'REJECTED') {
      p.iteration++;
      if (p.iteration >= p.maxIter) {
        abortPipeline(`still REJECTED after ${p.maxIter} passes — manual attention needed (see review-findings.md).`, wsId);
      } else {
        // learner: a rejection counts against the model that produced each task
        for (const [, taskFile] of p.taskAssign) learnMark(p.taskModels.get(taskFile), true);
        if (wsId === activeWorkspaceId) showReassigning();   // bridge the gap while pickFixerByAI() resolves
        await startFixRound(wsId);   // reassign ALL findings to the right agent (UI/UX for UI)
      }
    } else {
      abortPipeline('reviewer produced no VERDICT — halted (check review-findings.md).', wsId);
    }
  }
}

// ============================================================
// Chatbox — routes to pipeline or a single agent
// ============================================================
// Infrastructure/status chatter that should NOT clutter the console — the
// central console is reserved for AI activity. These still go to devtools for
// debugging, and live status is shown in the activity strip instead.
const SILENT_FEED_TAGS = new Set(['PIPELINE', 'EXPLORER', 'EDITOR']);

// raw console line not tied to an agent (operator/shell output). wsId lets a
// background project's system message land in ITS buffer instead of leaking
// into whatever project is currently on screen; defaults to the active one.
function feedRaw(tag, cls, text, ico, wsId = activeWorkspaceId) {
  if (SILENT_FEED_TAGS.has(tag)) {
    (cls === 'err' ? console.warn : console.debug)(`[${tag}] ${text}`);
    return;
  }
  const cont = feedElForWs(wsId);
  if (cont === consoleFeed) hideFeedEmpty();
  const el = document.createElement('div');
  el.className = 'ev';
  el.innerHTML = `<span class="tag op">${esc(tag)}</span><span class="ico">${ico || ''}</span><span class="body ${cls}"></span>`;
  el.querySelector('.body').textContent = text;
  cont.appendChild(el);
  if (cont === consoleFeed) pinFeedToBottom();
}

// ===== Attachments (drag & drop or 📎) =====
let attachments = [];
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

// an attachment is either a file path (string) or a code snippet object:
//   { kind: 'snippet', file, lang, code, start, end }
function isSnippet(a) { return a && typeof a === 'object' && a.kind === 'snippet'; }

function renderAttach() {
  for (const boxId of ['attach-chips', 'cm-attach', 'cx-attach', 'ad-attach']) {
    const box = document.getElementById(boxId);
    if (!box) continue;
    box.innerHTML = '';
    attachments.forEach((p, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      if (isSnippet(p)) {
        const name = p.file ? p.file.split(/[\\/]/).pop() : 'selection';
        const label = `${name}:${p.start}-${p.end}`;
        chip.title = `${label}\n\n${p.code}`;
        chip.innerHTML = `✦ <span></span> <b title="Remove">✕</b>`;
        chip.querySelector('span').textContent = label;
      } else {
        chip.title = p;
        chip.innerHTML = `${IMG_RE.test(p) ? '🖼' : '📄'} <span></span> <b title="Remove">✕</b>`;
        chip.querySelector('span').textContent = p.split(/[\\/]/).pop();
      }
      chip.querySelector('b').onclick = () => { attachments.splice(i, 1); renderAttach(); };
      box.appendChild(chip);
    });
  }
}

// attach a highlighted code selection as context (a chip, never text in the box)
function addSnippetAttachment(snip) {
  attachments.push({ kind: 'snippet', ...snip });
  renderAttach();
}
window.addSnippetAttachment = addSnippetAttachment;

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
  const files = attachments.filter(a => !isSnippet(a));
  const snippets = attachments.filter(isSnippet);
  let block = '';
  if (files.length) {
    block += '\n\nAttached files (open and view/read them from disk):\n'
      + files.map(p => '- ' + p).join('\n');
  }
  for (const s of snippets) {
    const loc = s.file ? `${s.file} (lines ${s.start}-${s.end})` : 'selection';
    block += `\n\nSelected code from ${loc}:\n\`\`\`${s.lang || ''}\n${s.code}\n\`\`\``;
  }
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
enableDrop(document.getElementById('cm-input'));

const fileIn = document.getElementById('file-in');
document.getElementById('cm-attach-btn').onclick = () => fileIn.click();
fileIn.onchange = () => { addDroppedFiles(fileIn.files); fileIn.value = ''; };

// ===== Slash menu — /skills and /commands, CLI style (reusable per textarea) =====
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
  // trigger on the CURRENT LINE, not the whole field — a single-line chat
  // message has only one line so this behaves exactly as before there, but it
  // also makes "/skill" work inside a multi-line field (e.g. a ticket's
  // acceptance criteria list), where "/" is never at position 0 of the value.
  const lineStart = () => {
    const v = textarea.value;
    return v.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
  };
  const query = () => {
    const v = textarea.value;
    const m = /^\/([\w-]*)$/.exec(v.slice(lineStart(), textarea.selectionStart));
    return m ? m[1] : null;
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
    const start = lineStart();
    const before = textarea.value.slice(0, start);
    const rest = textarea.value.slice(start).replace(/^\/[\w-]*\s*/, '/' + it.name + ' ');
    textarea.value = before + rest;
    const pos = start + it.name.length + 2;
    textarea.setSelectionRange(pos, pos); hide(); textarea.focus();
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
// short label for the agent currently focused in the dock — used in the
// "new session" confirmation so the operator sees what will run next under
// the shared session (chat sessions are isolated and unaffected by this).
function currentTargetLabel() {
  if (!chatAgentId) return 'no agent focused';
  const a = agents.find(x => x.id === chatAgentId);
  return a ? `${a.name} (${MODEL_LABELS[a.model] || a.model})` : 'no agent focused';
}

// a leading /name becomes an explicit directive so the Prompt Engineer (or the
// single agent) loads that skill/command and builds its output around it
function slashDirective(text) {
  const m = /^\/([\w-]+)/.exec(text);
  if (!m) return '';
  const it = slashItems.find(i => i.name === m[1]);
  if (!it) return '';
  return `\n\n[OPERATOR DIRECTIVE] The request invokes "/${it.name}" — a ${it.type === 'skill' ? 'skill' : 'custom command'} defined at ${it.path}. Read that file FIRST and treat its instructions as binding for this task: follow its protocol, structure and constraints when producing your output (task prompt files included — they must tell the engineers to comply with it too).`;
}

// visible confirmation that a leading /name was recognized and attached — the
// directive itself is invisible (injected text), so without this a skill send
// looks identical to a plain message ("no warning that skill is loaded").
function noteSlashAttached(text) {
  const m = /^\/([\w-]+)/.exec(text);
  if (!m) return;
  const it = slashItems.find(i => i.name === m[1]);
  if (!it) return;
  const kind = it.type === 'skill' ? 'skill' : 'command';
  feedRaw('OPERATOR', 'sys', `${kind} "/${it.name}" attached — instructions from ${it.path}`, '🧩');
}

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

// ===== Wide chat composer: the dock's input in a roomier view =====
const chatExpandModal = document.getElementById('chat-expand-modal');
const cxInput = document.getElementById('cx-input');
setupMention(cxInput, document.getElementById('cx-mention'));
setupSlash(cxInput, document.getElementById('cx-slash'));
enableDrop(cxInput);
document.getElementById('cx-attach-btn').onclick = () => fileIn.click();

// full-screen for the DOCK: mirror the dock input + controls into the wide modal
function openDockExpand() {
  const adt = document.getElementById('ad-target');
  const cxt = document.getElementById('cx-target');
  cxt.innerHTML = adt.innerHTML;
  cxt.value = adt.value;
  document.getElementById('cx-plan').checked = document.getElementById('ad-plan').checked;
  const cx2 = document.getElementById('cx-think');
  populateEffortSelect(cx2);
  cx2.value = document.getElementById('ad-effort').value;
  cx2._tselSync && cx2._tselSync();
  cxInput.value = adInput.value;
  chatExpandModal.classList.remove('hidden');
  renderAttach();
  cxInput.focus();
  cxInput.setSelectionRange(cxInput.value.length, cxInput.value.length);
}

function closeChatExpand() {
  adInput.value = cxInput.value;   // keep the dock box in sync on close
  chatExpandModal.classList.add('hidden');
}
document.getElementById('cx-close').onclick = closeChatExpand;
document.getElementById('cx-send').onclick = () => {
  // push the modal's values back into the dock controls, then send via the dock
  const adt = document.getElementById('ad-target');
  const ade = document.getElementById('ad-effort');
  const adp = document.getElementById('ad-plan');
  adt.value = document.getElementById('cx-target').value;
  adp.checked = document.getElementById('cx-plan').checked;
  ade.value = document.getElementById('cx-think').value;
  const chat = findChat(activeChatId);
  if (chat) {
    chat.target = adt.value;
    chat.model = adt.value.startsWith('model:')
      ? adt.value.slice('model:'.length)
      : ((agents.find(a => a.id === adt.value) || {}).model || chat.model);
    chat.effort = ade.value;
    chat.plan = adp.checked;
    const ag = agents.find(a => a.id === 'chat-' + chat.id);
    if (ag) ag.model = chat.model;
    saveChats();
  }
  adInput.value = cxInput.value;
  chatExpandModal.classList.add('hidden');
  cxInput.value = '';
  sendAgentFollowup();
};
cxInput.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') document.getElementById('cx-send').click();
  else if (e.key === 'Escape' && document.getElementById('cx-mention').classList.contains('hidden') && document.getElementById('cx-slash').classList.contains('hidden')) closeChatExpand();
});

document.getElementById('btn-new-session').onclick = () => {
  // a real assistant's "new chat" ALWAYS works — force-stop every run instead of
  // refusing. Covers a wedged flag (running stuck true with no live process to
  // abort), the exact trap where the operator couldn't reset a stale session.
  const runningIds = Object.keys(rt).filter(id => rt[id].running);
  runningIds.forEach(id => { try { stopAgent(id); } catch {} });
  Object.keys(rt).forEach(id => {
    if (rt[id].running) { rt[id].running = false; setRunningUI(id, false); }
  });
  clearSession();
  // wipe this project's visible feed (background workspaces keep their own
  // buffers untouched — see stashFeed/restoreFeed) so the reset is obvious.
  feedContentNodes().forEach(n => n.remove());
  closeAgentView();
  // 'SESSION' isn't in SILENT_FEED_TAGS (unlike 'PIPELINE'), so this actually
  // renders — the old plog('info', ...) call here used the silenced tag and
  // never showed up, leaving the operator with no confirmation.
  const stopped = runningIds.length
    ? ` (stopped ${runningIds.length} running agent(s))` : '';
  feedRaw('SESSION', 'ok',
    `new session started — console cleared${stopped}. ` +
    `next run (${currentTargetLabel()}) starts with a fresh context.`,
    '↺');
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
  // roster/ticket callers get the ✕ ALL close button; openChatUI re-hides it
  document.getElementById('ad-all').classList.remove('hidden');
  agentDock.classList.remove('hidden');
  document.getElementById('console-feed').classList.add('has-dock');
  syncConsoleChat();       // a per-chat dock replaces the default console chatbox
  updateChatModal();
  renderAttach();
  adInput.focus();
  // ensure the console surface is what's visible, and every other center
  // screen / the terminal dock is hidden so the run is unmistakably visible
  if (typeof focusConsoleForTask === 'function') focusConsoleForTask();
  else if (typeof showSurface === 'function') showSurface('console');
}
function closeAgentView() {
  chatAgentId = null;
  activeChatId = null;
  feedFilter = null;
  applyFilter();
  agentDock.classList.add('hidden');
  document.getElementById('console-feed').classList.remove('has-dock');
  renderChatList();        // drop the active-row highlight
  syncConsoleChat();       // restore the default console chatbox
}

// The default console chatbox is visible whenever a project is open and no
// per-chat dock has taken over the console. It is the primary send surface now
// that the sidebar chatbox is gone.
function syncConsoleChat() {
  // the global "square" composer is retired — the per-chat dock is the ONLY
  // chatbox. Keep it permanently hidden (its shared wiring still lives in DOM).
  const cc = document.getElementById('console-chat');
  if (cc) cc.classList.add('hidden');
  // default composer = the DRAFT dock, shown when a project is open, the
  // console feed is the visible surface, and no chat/agent dock is focused.
  const feed = document.getElementById('console-feed');
  const feedVisible = feed && !feed.classList.contains('hidden');
  if (projectDir && feedVisible && agentDock.classList.contains('hidden')) {
    openDraftChat();
  }
}

// sessions whose stored transcript we've already replayed into the feed, so
// navigating back to the same ticket doesn't stack duplicate history blocks
const hydratedSessions = new Set();

// open an agent's console view AND, when its live feed has nothing for that
// agent this launch, replay the stored transcript of `sessionId` so a ticket
// resumed from the board (whose run happened in a prior session/app launch)
// doesn't land on a blank console. Used by the workspace ticket flows.
async function openChatSession(agentId, sessionId) {
  openChat(agentId);
  if (!sessionId || hydratedSessions.has(sessionId)) return;
  // already has live entries for this agent this launch → nothing to backfill
  const hasLive = [...consoleFeed.querySelectorAll('.ev')]
    .some(el => el.dataset.agent === agentId);
  if (hasLive) return;
  if (hydratingChats.has(agentId)) return;   // double-click while loading
  // loading state: spinner on the chat row + a placeholder line in the feed
  hydratingChats.add(agentId);
  renderChatList();
  const ph = feed(agentId, 'sys', 'loading previous conversation…', '🕘');
  let msgs = [];
  try { msgs = await window.deck.sessionLoad(sessionId); } catch {}
  hydratingChats.delete(agentId);
  renderChatList();
  if (ph && ph.parentNode) ph.remove();
  if (!msgs || !msgs.length) {
    // say so instead of a silent blank console; NOT marked hydrated, so a
    // later click retries (the transcript may still be being written)
    feed(agentId, 'sys',
      `no saved transcript found for session ${String(sessionId).slice(0, 8)}`, '🕘');
    return;
  }
  hydratedSessions.add(sessionId);
  // still the same agent's view? (operator may have clicked away while loading)
  if (feedFilter && feedFilter !== agentId) return;
  feed(agentId, 'sys', `— previous conversation (${msgs.length} entries) —`, '🕘');
  for (const m of msgs) {
    if (m.role === 'user') feed(agentId, 'sys', m.text, '🗣');
    else if (m.role === 'tool') feed(agentId, 'tool', m.text, '⚙');
    else feed(agentId, 'txt', m.text, '');
  }
}
window.openChatSession = openChatSession;

// kept name — called from setRunningUI/ticker/events to refresh the dock header
function updateChatModal() {
  if (!chatAgentId || agentDock.classList.contains('hidden')) return;
  const a = agents.find(x => x.id === chatAgentId);
  if (!a) return;
  const r = R(chatAgentId);
  const sess = getSession();
  // AUTO PIPELINE chats never run on their own hidden agent (chat.target ===
  // '__pipeline__' fans out to the real roster agents instead), so R(chatAgentId)
  // stays idle for the whole run. Fold in the pipeline's own busy state so the
  // dock (status text + stop control) reflects reality for those chats too.
  const chat = findChat(activeChatId);
  const pipeSt = (chat && chat.target === '__pipeline__' && window.pipeState)
    ? window.pipeState() : { active: false };
  const pipeBusy = !!pipeSt.active;
  const busy = pipeBusy || r.running;
  const busyLabel = pipeBusy ? (pipeSt.label || 'pipeline running') : (r.status || 'running');
  document.getElementById('ad-status').innerHTML =
    `<span class="${busy ? 'run' : ''}">${busy ? '● ' + esc(busyLabel) : '○ idle'}</span>` +
    ` · ${MODEL_LABELS[a.model] || a.model} · ${sess ? 'session ' + esc(sess.slice(0, 8)) : 'new session'}`;
  // ChatGPT-style: the send arrow morphs into a red STOP square while the
  // agent (or, for AUTO PIPELINE, the pipeline itself) runs — click aborts.
  // During plan-review the pipeline is paused awaiting the plan card, not
  // abortable from here, so the control just shows busy without turning stop.
  const stoppable = pipeBusy ? pipeSt.stage !== 'plan' : r.running;
  const sendBtn = document.getElementById('ad-send');
  sendBtn.disabled = pipeBusy && !stoppable;
  sendBtn.classList.toggle('stop', !!stoppable);
  sendBtn.title = stoppable ? 'Stop this run'
    : (sendBtn.disabled ? 'Awaiting plan review — use the review card' : 'Send  (Ctrl+Enter)');
  document.getElementById('ad-stop').classList.add('hidden');
}

function sendAgentFollowup() {
  const text = adInput.value.trim();
  if (!text) return;
  // "!" shell like the main box (works in draft too)
  if (text.startsWith('!')) {
    const cmd = text.slice(1).trim(); if (!cmd) return;
    adInput.value = '';
    feedRaw('OPERATOR', 'tool', '$ ' + cmd, '⌨');
    window.deck.exec(cmd, projectDir || '').then(r => feedRaw('SHELL', r.ok ? 'txt' : 'err', (r.out || '').trim() || '(no output)'));
    return;
  }
  // DRAFT (empty-state dock, no chat/agent focused): auto-create a chat and send
  if (!chatAgentId && !activeChatId) {
    const draftFull = text + attachBlock() + slashDirective(text);
    adInput.value = '';
    adInput.style.height = 'auto';
    noteSlashAttached(text);
    createChatFromText(text, draftFull);
    return;
  }
  if (!chatAgentId || R(chatAgentId).running) return;
  const full = text + attachBlock() + slashDirective(text);
  noteSlashAttached(text);
  adInput.value = '';
  adInput.style.height = 'auto';
  const fa = agents.find(x => x.id === chatAgentId);
  if (fa && fa.role === 'uiux') learnUiWords(text);
  learnMaybeCorrection(chatAgentId, text);
  // an isolated chat resumes ONLY its own sdkSessionId — never the shared store
  if (activeChatId && chatAgentId === 'chat-' + activeChatId) {
    sendChatMessage(full);
    return;
  }
  // continuity: resume the shared session in place (no fork)
  runAgent(chatAgentId, full, false, false, { cont: true });
}

document.getElementById('ad-send').onclick = () => {
  // while running the arrow is a stop button — abort instead of sending.
  // AUTO PIPELINE chats run on the roster agents, not chatAgentId, so route
  // the abort through the pipeline itself (skip during plan-review — that
  // pause is resolved via the plan card, not a hard abort).
  const chat = findChat(activeChatId);
  if (chat && chat.target === '__pipeline__') {
    const p = pipeFor(activeWorkspaceId);
    if (p.active) {
      if (p.stage !== 'plan') abortPipeline('pipeline aborted by operator.', activeWorkspaceId);
      return;
    }
  }
  if (chatAgentId && R(chatAgentId).running) { stopAgent(chatAgentId); return; }
  sendAgentFollowup();
};
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
// Dock control row: agent/model · reasoning · PLAN · full-screen.
// Relocated here from the retired global composer so the per-chat dock is the
// single chatbox. In a chat these drive that chat; in DRAFT they set the
// defaults used when the first message auto-creates a chat.
// ============================================================
function fillAdTarget() {
  const sel = document.getElementById('ad-target');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  const pipe = document.createElement('option');
  pipe.value = '__pipeline__';
  pipe.textContent = '⟢ AUTO PIPELINE';
  sel.appendChild(pipe);
  for (const a of agents) {
    if (a.ephemeral) continue;
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${ROLE_ICON[a.role] || ROLE_ICON.custom} ${a.name}`;
    sel.appendChild(o);
  }
  const grp = document.createElement('optgroup');
  grp.label = 'MODELS';
  for (const [mid, label] of Object.entries(MODEL_LABELS)) {
    const o = document.createElement('option');
    o.value = 'model:' + mid;
    o.textContent = `✦ ${label}`;
    grp.appendChild(o);
  }
  sel.appendChild(grp);
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

// reflect the active chat (or draft defaults) into the dock controls
function syncDockControls() {
  const t = document.getElementById('ad-target');
  const e = document.getElementById('ad-effort');
  const p = document.getElementById('ad-plan');
  if (!t || !e || !p) return;
  fillAdTarget();
  populateEffortSelect(e);
  const chat = findChat(activeChatId);
  if (chat) {
    if ([...t.options].some(o => o.value === chat.target)) t.value = chat.target;
    e.value = chat.effort || getEffort();
    p.checked = !!chat.plan;
  } else {
    if (!t.value) t.value = 'model:claude-sonnet-5';
    e.value = getEffort();
    p.checked = false;
  }
}

// the empty-state chatbox: the dock with no chat focused. The first send here
// auto-creates a real chat (createChatFromText via sendAgentFollowup).
function openDraftChat() {
  activeChatId = null;
  chatAgentId = null;
  feedFilter = '__draft__';   // matches no rows → a clean, empty feed
  applyFilter();
  document.getElementById('ad-avatar').textContent = '✦';
  document.getElementById('ad-name').textContent = 'New chat';
  document.getElementById('ad-status').textContent = '';
  document.getElementById('ad-all').classList.add('hidden');
  document.getElementById('ad-stop').classList.add('hidden');
  agentDock.classList.remove('hidden');
  document.getElementById('console-feed').classList.add('has-dock');
  syncDockControls();
  renderChatList();
  adInput.placeholder = 'Start a new chat…   @ files · / skills · ! shell · ⌃⏎ send';
  // make sure the console surface is visible even when + NEW is clicked
  // from another screen (editor, board, …)
  if (typeof focusConsoleForTask === 'function') focusConsoleForTask();
  else if (typeof showSurface === 'function') showSurface('console');
  adInput.focus();
}

(function wireDockControls() {
  const t = document.getElementById('ad-target');
  const e = document.getElementById('ad-effort');
  const p = document.getElementById('ad-plan');
  const x = document.getElementById('ad-expand');
  if (!t || !e || !p) return;
  populateEffortSelect(e);
  t.onchange = () => {
    const chat = findChat(activeChatId);
    if (!chat) return;   // draft: the value is read at create time
    chat.target = t.value;
    chat.model = t.value.startsWith('model:')
      ? t.value.slice('model:'.length)
      : ((agents.find(a => a.id === t.value) || {}).model || chat.model);
    const ag = agents.find(a => a.id === 'chat-' + chat.id);
    if (ag) ag.model = chat.model;
    saveChats();
    renderChatList();
  };
  e.onchange = () => {
    const chat = findChat(activeChatId);
    if (chat) { chat.effort = e.value; saveChats(); }
  };
  p.onchange = () => {
    const chat = findChat(activeChatId);
    if (chat) { chat.plan = p.checked; saveChats(); }
  };
  if (x) x.onclick = openDockExpand;
})();

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
  return Math.min(90, Math.round(base * (1 + 0.15 * Math.min(hits, 3))));
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
// projectDir is declared in the workspace block above (mirrors ws().path)

function renderProject() {
  const el = document.getElementById('project-path');
  el.textContent = projectDir || 'no project imported';
  el.classList.toggle('none', !projectDir);
  el.title = projectDir;
  // the close button only makes sense once a folder is open
  const closeBtn = document.getElementById('btn-close-project');
  if (closeBtn) closeBtn.classList.toggle('hidden', !projectDir);
}

// ============================================================
// WORKSPACE RAIL (Phase 2) — open / switch / close projects
// ============================================================
// clone the default line-up with unique ids for a NEW workspace, so runtime
// state (rt, streamEls, feed) never collides across projects. Ids keep the
// `def-` prefix so the agents stay permanent + app-managed.
function freshRoster(cwd) {
  return DEFAULT_AGENTS.map(d =>
    ({ ...d, id: d.id + '-' + uid(), defId: d.id, cwd: cwd || '' }));
}

function wsRunningCount(w) {
  let n = 0;
  for (const a of (w.agents || [])) if (rt[a.id] && rt[a.id].running) n++;
  return n;
}

// ---- per-workspace console feed (move nodes between the visible feed and
// each project's detached buffer, so background streams survive a switch) ----
function showFeedEmpty() {
  if (!document.getElementById('feed-empty')) {
    consoleFeed.insertAdjacentHTML('afterbegin', FEED_EMPTY_HTML);
  }
}
// all feed content nodes (.ev log/stream/diff rows + .plan-result pipeline
// cards) — everything in #console-feed except the #feed-empty placeholder.
function feedContentNodes() {
  return consoleFeed.querySelectorAll(':scope > *:not(#feed-empty)');
}
// active project → move its live nodes into its buffer (keeps streaming there)
function stashFeed(wsId) {
  const buf = getFeedBuf(wsId);
  feedContentNodes().forEach(n => buf.appendChild(n));
}
// incoming project → pull its buffered nodes into the visible feed
function restoreFeed(wsId) {
  feedContentNodes().forEach(n => n.remove());
  const buf = feedBuf[wsId];
  if (buf && buf.children.length) {
    hideFeedEmpty();
    while (buf.firstChild) consoleFeed.appendChild(buf.firstChild);
  } else {
    showFeedEmpty();
  }
  feedStuck = true;
  consoleFeed.scrollTop = consoleFeed.scrollHeight;
}

function renderRail() {
  const rail = document.getElementById('ws-rail');
  if (!rail) return;
  rail.innerHTML = '';
  workspaces.forEach((w, i) => {
    const tile = document.createElement('button');
    tile.className = 'ws-tile' + (w.id === activeWorkspaceId ? ' active' : '');
    tile.style.setProperty('--ws-color', w.color || WS_COLORS[i % WS_COLORS.length]);
    const initial = ((w.name || '?').trim().charAt(0) || '?').toUpperCase();
    const running = wsRunningCount(w);
    tile.innerHTML =
      `<span class="ws-tile-badge">${esc(initial)}</span>` +
      (running ? `<span class="ws-run-dot" title="${running} agent(s) running">${running}</span>` : '') +
      ((workspaces.length > 1 || w.path)
        ? '<span class="ws-close" title="Close project">✕</span>' : '');
    tile.title = w.name + (w.path ? ' — ' + w.path : ' (no folder yet)');
    tile.onclick = (e) => {
      if (e.target.classList.contains('ws-close')) {
        e.stopPropagation(); closeWorkspace(w.id); return;
      }
      switchWorkspace(w.id);
    };
    rail.appendChild(tile);
  });
  // + open another project
  const add = document.createElement('button');
  add.className = 'ws-tile ws-add';
  add.innerHTML = '<span class="ws-tile-badge">+</span>';
  add.title = 'Open another project';
  add.onclick = newWorkspace;
  rail.appendChild(add);
  // ★ Mission Control (Phase 4 — placeholder for the all-projects dashboard)
  const spacer = document.createElement('div');
  spacer.className = 'ws-rail-spacer';
  rail.appendChild(spacer);
  const mc = document.createElement('button');
  mc.className = 'ws-tile ws-mc';
  mc.innerHTML = '<span class="ws-tile-badge">★</span>';
  mc.title = 'Mission Control — all agents across projects (Phase 4)';
  mc.onclick = () =>
    plog('info', 'Mission Control lands in Phase 4 — the all-projects live dashboard.');
  rail.appendChild(mc);
  // sandbox browser groups its tabs by project — keep those groups in sync
  // (projects added / removed / renamed / recolored all flow through here)
  if (window.browserProjectsChanged) window.browserProjectsChanged();
}

// re-bind every project-scoped view to the active workspace
function refreshProjectBindings() {
  render();          // roster + composer targets
  renderProject();   // project header path
  renderWelcome();   // Get Started screen when there's no folder
  applyFilter();     // console filter
  gitDetect();       // source control for this repo
  if (typeof exExpandedDirs !== 'undefined') exExpandedDirs.clear();   // new project, fresh tree
  exReset();         // file explorer
  loadSlashItems();  // project skills / commands
  // ticket workspace is per-project — rebind (or close if no folder)
  if (window.tkProjectChanged) tkProjectChanged();
  // notes are per-project — close the modal on switch (already saved)
  if (window.notesProjectChanged) notesProjectChanged();
  // terminals are per-project too — show this project's, hide the others
  if (typeof syncTermsToWorkspace === 'function') syncTermsToWorkspace();
  // re-sync stop button / status bar / console-vs-editor pane for this workspace
  renderActivity();
  if (projectDir) {
    window.deck.symbolEnsure(projectDir)
      .then(r => { if (r && r.ok) window.deck.symbolWatch(projectDir).catch(() => {}); })
      .catch(() => {});
  }
}

function switchWorkspace(id) {
  if (id === activeWorkspaceId) return;
  const target = workspaces.find(w => w.id === id);
  if (!target) return;
  stashFeed(activeWorkspaceId);            // keep the old project's console
  activeWorkspaceId = id;
  agents = ws().agents;                    // re-point the live references
  projectDir = ws().path || '';
  feedFilter = null;
  chatAgentId = null;
  activeChatId = null;
  document.getElementById('agent-dock').classList.add('hidden');
  saveWorkspaces();
  restoreFeed(id);                         // show the new project's console
  renderRail();
  refreshProjectBindings();
}

// open a fresh blank project tab — the Welcome screen takes it from here
function newWorkspace() {
  const w = {
    id: uid(),
    name: 'New Project',
    path: '',
    color: WS_COLORS[workspaces.length % WS_COLORS.length],
    order: workspaces.length,
    agents: freshRoster('')
  };
  workspaces.push(w);
  saveWorkspaces();
  switchWorkspace(w.id);   // path is empty → Welcome shows
}

// ---- recent folders (VS Code style) ----
const RECENT_KEY = 'recentFolders';
function getRecentFolders() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function addRecentFolder(dir) {
  if (!dir) return;
  let list = getRecentFolders().filter(d => d && d !== dir);
  list.unshift(dir);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}
function removeRecentFolder(dir) {
  localStorage.setItem(RECENT_KEY,
    JSON.stringify(getRecentFolders().filter(d => d && d !== dir)));
}

// point the ACTIVE (blank) workspace at a folder — from Open Folder or a recent
function setWorkspaceFolder(dir) {
  if (!dir) return;
  // already open in another tab? switch there and drop the blank one we're on
  const existing = workspaces.find(w => w.path === dir && w.id !== activeWorkspaceId);
  if (existing) {
    const blankId = ws().path ? null : activeWorkspaceId;
    switchWorkspace(existing.id);
    addRecentFolder(dir);
    if (blankId && blankId !== existing.id) {
      workspaces = workspaces.filter(w => w.id !== blankId);
      delete feedBuf[blankId];
      saveWorkspaces(); renderRail();
    }
    return;
  }
  ws().path = dir;
  ws().name = wsBaseName(dir);
  for (const a of ws().agents) a.cwd = dir;
  agents = ws().agents;
  projectDir = dir;
  addRecentFolder(dir);
  localStorage.setItem('projectDir', dir);   // legacy mirror
  saveWorkspaces();
  renderRail();
  refreshProjectBindings();
  plog('info', 'folder opened: ' + dir);
}

// Welcome / Get Started — shown whenever the active project has no folder
function renderWelcome() {
  const wel = document.getElementById('welcome');
  if (!wel) return;
  wel.classList.toggle('hidden', !!projectDir);
  syncConsoleChat();       // hide the console chatbox on the Welcome screen
  if (projectDir) return;
  const recents = getRecentFolders().filter(Boolean);
  const wrap = document.getElementById('wel-recent-wrap');
  const list = document.getElementById('wel-recent');
  if (!recents.length) { wrap.classList.add('hidden'); list.innerHTML = ''; return; }
  wrap.classList.remove('hidden');
  list.innerHTML = recents.map(d =>
    `<div class="wel-recent-item" data-dir="${esc(d)}">
       <span class="wel-rec-name">${esc(wsBaseName(d))}</span>
       <span class="wel-rec-path">${esc(d)}</span>
       <span class="wel-rec-x" data-x="1" title="Remove from recent">✕</span>
     </div>`).join('');
  list.querySelectorAll('.wel-recent-item').forEach(el => {
    el.onclick = (e) => {
      if (e.target.dataset.x) {
        e.stopPropagation(); removeRecentFolder(el.dataset.dir); renderWelcome(); return;
      }
      setWorkspaceFolder(el.dataset.dir);
    };
  });
}

async function closeWorkspace(id) {
  const w = workspaces.find(x => x.id === id);
  if (!w) return;
  const running = wsRunningCount(w);
  const isLast = workspaces.length <= 1;
  const ok = await showAlert({
    title: 'CLOSE PROJECT',
    message: `Close "${esc(w.name)}"?` +
      (running ? ` ${running} running agent(s) will be stopped.` : '') +
      (isLast ? " You'll return to the Welcome screen." : ''),
    okText: 'CLOSE', cancelText: 'CANCEL', kind: 'warn'
  });
  if (!ok) return;
  for (const a of (w.agents || [])) {
    if (rt[a.id] && rt[a.id].running) stopAgent(a.id);
  }
  delete feedBuf[id];
  if (typeof killWorkspaceTerms === 'function') killWorkspaceTerms(id);

  if (isLast) {
    // the only project — reset it in place back to a blank Welcome state
    w.path = '';
    w.name = 'New Project';
    w.agents = freshRoster('');
    agents = w.agents;
    projectDir = '';
    feedFilter = null;
    localStorage.removeItem('projectDir');
    restoreFeed(w.id);
    saveWorkspaces();
    renderRail();
    refreshProjectBindings();   // shows the Welcome screen
    return;
  }

  workspaces = workspaces.filter(x => x.id !== id);
  if (activeWorkspaceId === id) {
    activeWorkspaceId = workspaces[0].id;
    agents = ws().agents;
    projectDir = ws().path || '';
    feedFilter = null;
    restoreFeed(activeWorkspaceId);
    refreshProjectBindings();
  }
  saveWorkspaces();
  renderRail();
}

// close the current project (used by the command palette)
function closeActiveWorkspace() { closeWorkspace(activeWorkspaceId); }

// Welcome screen actions (project import now lives here — no toolbar button)
document.getElementById('wel-open').onclick = async () => {
  const dir = await window.deck.pickFolder();
  if (dir) setWorkspaceFolder(dir);
};
document.getElementById('wel-new').onclick = newWorkspace;
document.getElementById('btn-close-project').onclick = closeActiveWorkspace;

// ============================================================
// ACCOUNT / USAGE
// ============================================================
let auth = { loggedIn: false };
const todayKey = () => new Date().toISOString().slice(0, 10);
let usage = JSON.parse(localStorage.getItem('usage') || 'null');
if (!usage || usage.date !== todayKey()) usage = { date: todayKey(), runs: 0, in: 0, out: 0, cost: 0 };

function trackUsage(ev) {
  if (usage.date !== todayKey()) usage = { date: todayKey(), runs: 0, in: 0, out: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
  usage.runs++;
  usage.cost += ev.costUsd || 0;
  if (ev.usage) {
    usage.in += ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite;
    usage.out += ev.usage.output;
    usage.cacheRead += ev.usage.cacheRead || 0;
    usage.cacheWrite += ev.usage.cacheWrite || 0;
  }
  localStorage.setItem('usage', JSON.stringify(usage));
  renderUsage();
}

function fmtK(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }

function renderUsage() {
  document.getElementById('u-runs').textContent = usage.runs;
  const cr = usage.cacheRead || 0;
  const hit = usage.in ? Math.round(100 * cr / usage.in) : 0;
  document.getElementById('u-in').textContent = fmtK(usage.in) + (cr ? ` (${hit}% cached)` : '');
  document.getElementById('u-out').textContent = fmtK(usage.out);
  document.getElementById('u-cost').textContent = '$' + usage.cost.toFixed(2);
}

async function refreshAuth() {
  auth = await window.deck.authStatus();
  const on = !!auth.loggedIn;
  // Claude account now lives in the status bar; the header shows the LoveAi profile
  if (window.renderStatusBar) window.renderStatusBar();
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
// absolute date + time for a session's last-touched timestamp, so a session
// from a few days ago (where "3 d ago" isn't precise enough for follow-up)
// can still be pinned to an exact moment.
function sessionTimeLabel(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
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
      <div class="hp-top"><span class="hp-proj">${esc(s.project)}</span><span class="hp-ago" title="${esc(sessionTimeLabel(s.mtime))}">${esc(agoText(s.mtime))}</span></div>
      <div class="hp-snippet">${esc(s.snippet || '(no prompt found)')}</div>
      <div class="hp-id">${esc(sessionTimeLabel(s.mtime))} · ${esc(s.id.slice(0, 8))}${s.id === current ? ' · ACTIVE' : ''}</div>`;
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

