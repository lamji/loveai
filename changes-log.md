# Changes Log

## 2026-07-21

### task-01: Explorer auto-sync after AI agent writes files
- **File**: renderer/app.js (run-done handler, ~1544-1550)
- **Symptom**: When an AI agent/pipeline run creates or edits a file on disk,
  the EXPLORER file tree did not update until the operator manually clicked
  the ↻ refresh button.
- **Root cause**: The run-done handler (`result-end` branch) called
  `gitRefresh()` to update the git panel, but never called `refreshWorkspace()`
  to rebuild the explorer tree. Every other disk-mutation path (git.js,
  commit.js) already pairs both calls.
- **Fix**: After `const doneWsId = wsForAgent(ev.agentId);` is computed
  (line ~1547), added a guarded call:
  ```
  if (typeof refreshWorkspace === 'function'
      && doneWsId === activeWorkspaceId) {
    refreshWorkspace();
  }
  ```
  Gated on `doneWsId === activeWorkspaceId` (mirrors the deploy-offer gate)
  because `refreshWorkspace()` reads the active `projectDir`/`openFiles` —
  background agents must not rebuild the on-screen project. Fire-and-forget
  (no await), same as all git.js call sites. Placement: after `doneWsId`
  exists, right before the deploy-offer logic block.
- **Impact**: New files/edits from agent runs now appear in Explorer instantly
  with no manual refresh. If Explorer was hidden, lazy exLoad picks them up
  when next opened; open editor tabs re-read changed files from disk.
- **Status**: ✅ Complete

### task-19: Cannot open notepad in terminal (git editor path mangling)
- **File**: main.js (`term-start`, ~3210-3227)
- **Symptom**: running `git pull`/merge in the embedded terminal (Git Bash
  PTY) hung waiting on an editor and errored `... notepad.exe: command not
  found` (backslashes stripped, e.g. `C:\WINDOWS\notepad.exe` →
  `C:WINDOWSnotepad.exe`), leaving the merge uncommitted.
- **Root cause**: the PTY inherited the user's raw `process.env` verbatim.
  If their global `core.editor`/`GIT_EDITOR` is a Windows backslash path
  (a common setup suggestion), MINGW's `sh -c "$GIT_EDITOR $1"` treats each
  backslash as an escape char and mangles the path before exec.
- **Fix (already present, verified working)**: `term-start` now spawns with
  `env: { ...process.env, GIT_EDITOR: 'notepad', GIT_SEQUENCE_EDITOR:
  'notepad' }` — a bare `notepad` resolves via PATH to Git for Windows'
  own `/usr/bin/notepad` wrapper (handles unix2dos/dos2unix + launches
  `notepad.exe` directly, no backslash path ever hits the shell), and
  `GIT_EDITOR` env takes precedence over any `core.editor` config, so a
  bad global setting can no longer break the in-app terminal. Override is
  scoped per-terminal-process only — no global git config is touched.
  Confirmed in Git Bash: `which notepad` → `/usr/bin/notepad`
  (the safe wrapper script), not a raw exe path.
- **Status**: ✅ Verified — no further code change needed.

## 2026-07-20

### task-18: Tree-sitter symbol store + symbol-level context (Step 1 — store)
- **Files**: main.js
- **Goal**: promote the existing tree-sitter code graph (task-17, reverse
  call/import edges only) into a full SYMBOL STORE so the AI can load individual
  symbols instead of whole files. Hybrid, graph-gated (falls back to today's
  whole-file front-load when the graph is cold). No RAG/embeddings.
- **main.js**: `extractFileGraph` now returns RICH def records, not just names:
  `{name, type, sl, el, parent, vis, doc, lang}` via new helpers `enclosingDecl`
  / `parentSymbol` / `visibilityOf` / `leadingDoc` / `defRecord` + `DECL_TYPES` /
  `CONTAINER_TYPES` / `TYPE_OF` maps. Source is NOT stored — read lazily by line
  range when packed (keeps the index small). `assembleGraph` / `addFileToGraph`
  stamp `rel`+`id` onto rich symbols (`stampSymbols`). Persisted schema bumped to
  `GRAPH_SCHEMA = 2`; `loadGraphDisk` rejects a v1 file so it rebuilds richer
  (ensureGraph / getGraphForQuery / codegraph-status all go through it). New
  `repoMapSymbols(graph)` — symbol-names-only map grouped by dir (spec format).
- **Reverse-edge behavior (regression impact) unchanged** — `calls`/`imps` name
  lists still feed `linkEdges`; only the def record shape got richer.
- **Verified**: `node --check main.js` passes. Fixture (scratchpad
  ts-symbols-fixture.js) parses a real TS sample with web-tree-sitter and asserts
  14 properties: function/class/interface/enum/method typing, `login` parent =
  `AuthService`, exported/public/private visibility, leading-comment docs, and
  line ranges. ALL PASS. App NOT restarted (per task).
- **Status**: ✅ Step 1 complete.

### task-18: Tree-sitter symbol context — Step 2 (forward deps) + Step 3 (packer)
- **Files**: main.js, preload.js, renderer/app.js
- **Step 2 (forward/dependency edges), main.js**:
  - Added `(new_expression constructor:(identifier)@n)` to the JS/TS call query so
    `new Foo()` counts as a dependency (spec: constructor dependencies).
  - `extractFileGraph` now buckets each call/new capture into the INNERMOST
    enclosing def by line range → per-symbol `calls` (forward edges). A class then
    absorbs its constructor's (and methods') calls, so reaching a class via
    `new Class()` expands to what the constructor builds.
  - `forwardReach(graph, startId, depth, cap)` — bounded, depth-limited BFS over
    per-def `calls`, name-resolved to def ids (skips ambiguous >25). Default call
    depth 2. This is context EXPANSION (complements the existing reverseReach).
- **Step 3 (symbol packer + prompt wiring)**:
  - main.js: `packSymbols` = the token-optimizer. Ranks files with BM25
    `retrieve()` (reused — no embeddings), `selectSymbols` picks query-matched
    seeds in the top files (else exported/public top-level symbols), expands via
    `forwardReach`, then reads each symbol's SOURCE lazily by line range
    (`symbolSource` / `readLinesCached`), applies `optimizeSource` (collapse blank
    lines; strip whole-line comments unless requested), keeps seed implementations
    full and demotes over-budget dependencies to `signatureOf` lines.
    `formatSymbolContext` renders in the spec's order: symbol repo map →
    signatures → implementations → dependencies. Graph-gated: returns null when the
    graph is cold. New IPC `retrieve-symbols` (warms the graph in the background).
  - preload.js: `retrieveSymbols(cwd, query, budget, comments)` bridge.
  - renderer/app.js `runAgent` front-load (PE/custom/senior/uiux): tries the symbol
    pack FIRST; when `ready`, injects it and SKIPS the whole-file content dump +
    lexical dir-map (the pack carries its own symbol map), logging
    `🌳 symbol context: N symbols + M deps …`. When not ready (cold graph / nothing
    relevant), falls back to today's whole-file front-load unchanged (hybrid). Kept
    the ranked-file list, regression-impact block, and efficiency directive (now
    worded for either context type).
- **Verified**:
  - `node --check` passes for main.js, renderer/app.js, preload.js.
  - End-to-end fixture (scratchpad pack-e2e-fixture.js) builds a real graph from a
    mini repo (auth.ts/user.ts/database.ts) with web-tree-sitter and runs the
    packer for "optimize the login function". 8/8 assertions pass: `login` seed;
    deps validatePassword, find, UserRepository, query, AND DatabaseClient
    (reached at depth 2 through UserRepository's constructor — the spec's
    login→validatePassword→UserRepository→DatabaseClient chain); login body
    present; comments stripped; pack smaller than whole-file load.
  - Additive graph fields only — all existing consumers (regression impact,
    watchers, status) use id/rel/name and are unaffected. Reverse-edge behavior
    unchanged. App NOT restarted (per task); live in-app injection is code-verified.
- **Status**: ✅ Steps 1–3 complete. Remaining refinement: inheritance/interface
  expansion (extends/implements) as forward edges — call/constructor chains done.

### task-17: Global regression-impact context (native tree-sitter code graph)
- **Files**: package.json, main.js, renderer/app.js
- **package.json**: added deps `web-tree-sitter@^0.25.10` +
  `tree-sitter-wasms@^0.1.13`; asarUnpack now ships web-tree-sitter,
  tree-sitter-wasms and all `**/*.wasm` so grammars load in a packaged build.
- **main.js** (after `retrieve()`, ~751): NATIVE in-process code knowledge
  graph (GitNexus-style, NOT MCP, NOT a graph DB). LANG_GRAMMAR ext→grammar
  map (js/ts/tsx/jsx/py/go/rust/java); TS_QUERIES per grammar (def/call/imp);
  lazy tsInit/loadLang/compiledQueries (Parser cached, grammars loaded only
  for langs present); extractFileGraph parses one file → {defs,calls,imps}.
  buildCodeGraph walks the repo (reusing INDEX_SKIP_DIRS/SYMBOL_MAX_BYTES +
  the setImmediate-yield pattern), assembleGraph builds REVERSE adjacency
  (def→{callers,importers}) resolving refs by NAME. graphCache per cwd,
  persisted `.loveai/index/codegraph.json`; ensureGraph (background, deduped)
  + getGraphForQuery (sync read only). Incremental reparseFileInGraph /
  removeFileFromGraph wired into the symbol-watch flush. regressionImpact
  (graph,idx,files) reverse-BFSes (depth 3, bounded) the top ranked files'
  defs → lean block `<sym> (defined in a.ts) ← used by: b, c (+N)` (≤8 lines,
  ≤6 refs, ≤90 chars); FALLS BACK to lexicalImpact (tf token→files inverted
  map) when the graph is cold / a grammar missing; '' only when truly empty.
- **main.js** `retrieve-context` handler (~874): adds
  `impact: regressionImpact(getGraphForQuery(cwd), idx, files)` to the
  returned object; kicks `ensureGraph(cwd)` in the background (never a sync
  build on the query path). File selection/ranking unchanged. `symbol-ensure`
  + `symbol-watch` also warm the graph in the background.
- **renderer/app.js** runAgent front-load (~1252, PE/custom-gated, inside the
  `r.ok && r.files.length` block): if `r.impact`, appends a "REGRESSION
  IMPACT (auto … verify)" section + ~3-line directive (check each reference,
  prefer a minimal backward-compatible change, RECORD affected files in the
  task CONTEXT). Placed after TOP FILE CONTENTS, before the EFFICIENCY line.
  Not injected into senior/reviewer/model/follow-up runs.
- **Why**: a change to a gating symbol (e.g. resolvePaymentStatus) regressed
  hidden consumers no one flagged. The PE now sees a deterministic
  (script-computed, not AI-guessed) blast radius before writing task files.
- **Verified**:
  - `node --check main.js` + `node --check renderer/app.js` pass.
  - `require('web-tree-sitter')` + `Parser.init()` + grammar load + queries
    run in Node (Electron main is a Node context); asar/locateFile fallback
    added for packaged builds; failures set tsBroken → lexical fallback.
  - Fixture repo (a.ts defines resolvePaymentStatus; b.tsx/c.tsx call+import
    it; d.ts imports Badge from b.tsx): graph records b.tsx & c.tsx as
    callers AND importers; regressionImpact emits
    `resolvePaymentStatus (defined in a.ts) ← used by: b.tsx, c.tsx, d.ts`
    — d.ts is a TRANSITIVE (depth-2) dependent. AST-based, not token match.
  - lexicalImpact returns the same lean format from a tf index and '' on
    empty idx (graceful fallback proven).
  - App NOT restarted (per task). Live PE injection (criterion 7) is code-
    verified but not exercised in the running app.
- **Status**: ✅ Complete

### task-16: Terminal cursor invisible in light mode
- **File**: renderer/src/settings.js (line 329)
- **Change**: `termTheme()` cursor token changed from `v('--fg')` to `v('--editor-fg')`
- **Why**: Terminal text caret was white/near-white (global --fg token) on white light-mode background (--editor-bg #FFFFFF), making it invisible. Fixed by using the terminal's own text color (--editor-fg), which by definition contrasts with --editor-bg in both themes.
- **Impact**: Terminal cursor now visible in light mode; dark mode unaffected (uses same --editor-fg token as text).
- **Status**: ✅ Complete
  - Syntax verified: `node --check renderer/src/settings.js` passes
  - applyTheme() already re-applies termTheme() on theme toggle (live cursor update)
  - New terminals and onboarding setup terminal inherit the fix
