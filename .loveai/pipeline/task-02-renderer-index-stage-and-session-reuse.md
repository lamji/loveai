# task-02 — Renderer: INDEXER stage 0, index-driven scoping rules, per-project session reuse (renderer/app.js only)

MODEL: claude-opus-4-8

## CONTEXT

LoveAi's auto pipeline (`renderer/app.js`) runs: Stage 1 Prompt Engineer → Stage 2 plan review → Stage 3 Seniors build → Stage 4 Reviewer. Goal: make follow-up runs fast like Cursor/base44 via three mechanisms, all in this file:

1. **Stage 0 INDEXER** — a one-shot Haiku agent that writes/updates `.loveai/index/PROJECT-MAP.md` only when the backend says the index is missing or stale.
2. **Index-driven context scoping** — rule-prompt edits so PE/Seniors/Reviewer read only relevant files, guided by the map.
3. **Per-project session reuse** — persist the Prompt Engineer's session ID per project cwd and resume (fork) it on the next pipeline run.

Task-01 (another engineer, already assigned) adds the backend bridge you will call: `window.deck.indexStatus(cwd)` → `{ exists, stale, changedFiles: [] }` and `window.deck.indexMark(cwd)` → boolean. Assume these exist; do NOT edit main.js/preload.js.

Key existing code in `renderer/app.js` (read all of these before editing):
- `RULES` object (~line 5–50): prompt/senior/reviewer system-prompt appendices.
- `parseModelLine` (~line 397), `pipe` state object (~line 393).
- `launchPipeline(issue)` (~line 415): resets pipeline dir then runs PE ("Stage 1").
- `runAgent(agentId, prompt, ..., opts)` (~line 270): `opts.model` overrides, `opts.fresh: true` skips session resume; result handler stores `r.sessionId` and calls `setSession(ev.sessionId)` (~line 359).
- `onPipelineAgentDone(agentId, result)` (~line 642): stage transitions keyed on `pipe.stage` + agent role.
- `session-invalid` event handling (~line 331).

## SCOPE — TO-DO (all in renderer/app.js)

### 1. RULES.indexer (new)

- [ ] Add `RULES.indexer`: "You are the PROJECT INDEXER. Read the codebase (skip node_modules, dist, .git, .loveai) and write `.loveai/index/PROJECT-MAP.md`: purpose, tech stack, architecture overview, module map with EXACT file paths and each file's responsibilities/key symbols, data flow between modules, entry points, conventions. Max ~400 lines. If given a changed-file list, update ONLY the affected sections of the existing map in place. Never modify source code; write only inside .loveai/index/."

### 2. Stage 0 in launchPipeline + orchestration

- [ ] Extend `pipe` state with nothing new except allowing `pipe.stage === 'index'`; add a `STAGE_BANNER`-style label for it (see the `prompt/plan/build/review` label map ~line 199): `index: 'PIPELINE ▸ STAGE 0 — INDEXER MAPPING PROJECT'`.
- [ ] In `launchPipeline(issue)`, after `pipelineReset` and before running the PE:
  - `const st = await window.deck.indexStatus(pipe.cwd)`.
  - If `st.exists && !st.stale`: `plog('info', 'project index fresh — skipping Stage 0.')` and proceed straight to Stage 1 (current behavior).
  - Else: stash the issue (e.g. `pipe.pendingIssue = issue`), set `pipe.stage = 'index'`, and run a one-shot indexer using the GENERAL-OPS agent slot pattern — cleanest: create/find a dedicated roster agent `{ id: 'def-indexer', name: 'INDEXER', role: 'indexer', model: 'claude-haiku-4-5-20251001', rules: RULES.indexer }` (add to `DEFAULT_AGENTS` and an icon in `ROLE_ICON`/`ROLE_LABEL`, e.g. 🗺 / 'INDEXER'). Run it with `runAgent(id, prompt, false, false, { fresh: true })` where prompt is either "Index this project per your rules." or, when `st.stale`, "These files changed since the last index: <changedFiles joined>\nUpdate only the affected sections of .loveai/index/PROJECT-MAP.md per your rules."
- [ ] In `onPipelineAgentDone`: when `pipe.stage === 'index'` and the indexer finishes successfully, `await window.deck.indexMark(pipe.cwd)`, then start Stage 1 with the stashed issue (the same PE-launch code currently in `launchPipeline` — factor it into a small `startStage1(issue)` helper so it's not duplicated). On indexer error, `plog('err', ...)` but STILL continue to Stage 1 (index is an optimization, never a blocker).
- [ ] Also call `window.deck.indexMark(pipe.cwd)` when a fresh index was just built the first time (covered by the same path above).

### 3. Context-scoping rule edits (surgical text additions, keep everything else verbatim)

- [ ] `RULES.prompt` — append a numbered rule: "SPEED: FIRST read `.loveai/index/PROJECT-MAP.md` if it exists and use it to jump directly to the files relevant to the ISSUE — do NOT re-explore the whole codebase. Open only files the map marks as involved plus their direct dependents. Paste the relevant map excerpt into each task file's CONTEXT so the Senior Engineer needs zero additional exploration."
- [ ] `RULES.senior` — append: "SPEED: trust your task file's CONTEXT; read only the files it lists (plus `.loveai/index/PROJECT-MAP.md` for orientation if needed). Do not survey the repo. If you change what a file is responsible for, update its section in PROJECT-MAP.md."
- [ ] `RULES.reviewer` — append: "SPEED: scope validation to the files in review-brief.md and changes-log.md plus their direct callers per `.loveai/index/PROJECT-MAP.md` — do not re-audit the whole repo."

### 4. Per-project Prompt Engineer session reuse

- [ ] Persist: in the result handler where `r.sessionId = ev.sessionId` / `setSession(...)` runs (~line 359), when the finishing agent's role is `prompt` and a pipeline `cwd` is set, store it: `localStorage` key `loveai-pe-sessions` holding a JSON object `{ [cwd]: sessionId }` (read-modify-write with try/catch).
- [ ] Resume: in `startStage1(issue)`, look up the stored session for `pipe.cwd`; if found, run the PE with `{ resumeSessionId: <id>, forkSession: true }`-equivalent options. NOTE how `runAgent` builds cfg (~line 293–296): it derives `resumeSessionId` from `getSession()` / `opts.fresh`. Extend `runAgent`'s opts to accept an explicit `opts.resume` (session id) and `opts.fork` flag, passed through to the cfg it sends (`resumeSessionId`, `forkSession`) — main.js already supports `cfg.forkSession` (main.js:642). Keep all existing call sites behaving identically.
- [ ] Invalidate: in the `session-invalid` event handler (~line 331), also delete any `loveai-pe-sessions` entry whose value equals `ev.sessionId`.
- [ ] Log it: `plog('info', 'resuming Prompt Engineer session <first8> (warm context)')` when a resume is used.

## OUT OF SCOPE — must NOT touch

- `main.js`, `preload.js` (task-01 owns them), `renderer/index.html`, `renderer/style.css`, `package.json`.
- Model-routing logic (`parseModelLine`, `pipe.taskModels`), plan-review flow, senior cloning (`ensureSeniors`), git/terminal/file-explorer/skills UI code.
- Do not rename or restructure existing functions beyond the minimal `startStage1` extraction and the `runAgent` opts extension described above.

## ACCEPTANCE CRITERIA

- `node --check renderer/app.js` passes.
- Trace-verify (code reading) all four flows: fresh index skip; missing index → Stage 0 → indexMark → Stage 1; stale index → incremental indexer prompt with changed-file list; PE session stored on first run and passed as resume+fork on the next `launchPipeline` for the same cwd; `session-invalid` clears the stored entry.
- Indexer failure does not abort the pipeline (Stage 1 still starts).
- No existing pipeline behavior changes when `.loveai/index` machinery is unavailable (e.g. `window.deck.indexStatus` throwing must be caught → behave exactly as today).
- Append your entry to `.loveai/pipeline/changes-log.md` when done.
