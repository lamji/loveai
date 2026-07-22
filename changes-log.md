# Changes Log

## 2026-07-21

### fix: persist conversation context when a resumed session goes stale
- **Files**: main.js, renderer/app.js
- **Symptom**: a follow-up in a shared chat sometimes printed "stored session
  was stale — starting a fresh context." and answered cold, losing the entire
  prior conversation (e.g. an ongoing git-branch/PR discussion).
- **Root cause**: `agent-run`'s stale-recovery retry (`res.missingSession` and
  the SDK-throw `catch` branch) rebuilt a session-less `fresh` options object
  but resent `cfg.prompt` verbatim — the dead session's transcript was never
  reattached.
- **Fix**: extracted the `session-load` IPC's disk-scan/JSONL parser into
  `readSessionTranscript(sessionId, limit=80)` (same `[{role,text}]` shape,
  `session-load` now delegates to it unchanged). Added `buildStalePrompt()`,
  which loads the last 40 messages of the dead session, renders a role-prefixed
  preamble capped at ~12000 chars (trims oldest lines first), and returns
  `{prompt, restored}`. `runOnce` now takes an optional 3rd `promptOverride`
  arg; both stale-recovery sites call `buildStalePrompt()` and pass
  `fp.prompt` into the fresh retry, and add `restored` to the `session-invalid`
  event. Renderer's `session-invalid` handler now branches the toast on
  `ev.restored` ("restored prior context into a fresh session." vs the
  original "starting a fresh context." message).
- **Impact**: `getSession`/`setSession`/`clearSession`/`sessKey` and the
  resume/fork decision in `runAgent` are untouched; `session-load`'s IPC shape
  is byte-for-byte identical.
- **Status**: ✅ Complete — `node -c main.js` and `node -c renderer/app.js`
  pass. Needs an app restart (main.js change) and manual verification: force a
  stale session (remove/rename its `<id>.jsonl` under
  `~/.claude/projects/*/`), send a context-dependent follow-up, confirm the
  toast reads "restored prior context…" and the reply uses prior context.

### fix: auto-bootstrap semantic vector index on project open
- **File**: main.js
- **Symptom**: opening a project (esp. a multi-project parent folder like
  `DigitalFuture2`) logs `RAG: no vector index for this project yet — lexical
  only` forever, until the user manually clicks the status-bar graph item.
- **Root cause**: `vectors.json` was only ever built by an explicit gesture
  (`codegraph-build` / `vector-build` IPC). The automatic open path
  (`symbol-ensure` / `symbol-watch` → `ensureGraph`) built the lexical index
  and code graph but never kicked a vector build.
- **Fix**: added `maybeBootstrapVectors(cwd, graph)` next to `buildVectorsBg`
  — no-op if no defs, an index already exists (`V.hasVectorIndex`), or a
  build is already running; otherwise fires the existing off-thread, deduped
  `buildVectorsBg`. Chained fire-and-forget onto the `ensureGraph(cwd)` kick
  in both `symbol-ensure` and `symbol-watch`, so a freshly opened (or
  watch-only) project self-bootstraps semantic RAG without blocking either
  handler's immediate return.
- **Impact**: first-time project open now builds `vectors.json` automatically
  (status bar shows progress); re-opens with an existing index are unchanged
  (guarded by `hasVectorIndex`); `symbol-ensure`/`symbol-watch` still return
  immediately, no UI block.
- **Status**: ✅ Complete — `node -c main.js` passes. Needs an app restart
  (main.js change) and manual verification: delete a project's
  `.loveai/index/vectors.json`, reopen it, confirm the status bar shows a
  vector build and the file reappears without any manual graph click.

### fix: session-level Chrome UA for sandbox browser (all-site OAuth login)
- **File**: main.js
- **Symptom**: "Sign in with Google" (and other OAuth) fails inside the
  in-app sandbox browser with Google's "This browser or app may not be
  secure" wall — for every site, not just Atlassian.
- **Root cause**: Google/Microsoft OAuth reject Electron's default user agent
  (contains `Electron/…`) as an embedded/insecure browser. task-01 already set
  a stripped Chrome UA via the per-`<webview useragent>` attribute in
  browser.js, but that attribute only reliably covers the top document — the
  OAuth **popup windows** the Google flow opens (and iframes/XHRs) could still
  present the raw Electron UA.
- **Fix**: added `configureSandboxSession()` (called in `app.whenReady()`
  before `createWindow()`): computes the same clean UA
  (`session.defaultSession.getUserAgent()` minus the `agent-deck|LoveAi/…` and
  `Electron/…` tokens) and applies it to the whole `persist:sandbox` partition
  via `session.fromPartition('persist:sandbox').setUserAgent(ua)`. Session-level
  covers EVERY request in that session — top doc, popups, iframes, XHR — so the
  Electron UA never leaks on any provider. Same regex as browser.js's
  `CHROME_UA`, so the header UA and the guest's `navigator.userAgent` match.
- **Impact**: Google/Microsoft/GitHub OAuth sign-in works across the board in
  the sandbox browser; sessions still persist via the existing
  `persist:sandbox` partition (unchanged). Requires an app restart (session UA
  is read at partition creation).
- **Status**: ✅ Complete — `node --check main.js` passes. Live login not
  exercised here (needs a fresh Electron process; packaged build must be
  rebuilt via `electron-builder` or run from source with `electron .`).

### fix: bare-model switch in composer wiped chat context (task-01)
- **File**: renderer/app.js
- **Symptom**: chatting to a bare model in the composer, then switching the
  MODEL dropdown to a different model, lost all prior context — the app
  silently started a fresh session instead of continuing the conversation.
- **Root cause**: the shared per-project session (`sessKey()`) is
  model-agnostic, but the bare-model send path always used `{cont:true}`,
  which resumes that session **in place** under the newly selected
  `options.model`. Resuming a session under a different model than the one
  it was created with is rejected by the SDK/CLI, which fires
  `session-invalid` → renderer `clearSession()` → next send starts empty.
- **Fix**: added a parallel `deckSessionModel:<dir>` localStorage key
  (`sessModelKey`/`getSessionModel`/`setSessionModel`) tracking which model
  owns the current shared session, set alongside `setSession()` in the
  `result` handler and cleared alongside it in `clearSession()`. In
  `sendChat()`'s bare-model branch, compare the owner model to the newly
  selected one: same model → `{cont:true}` (in-place, cheap/prompt-cache
  hit, unchanged behavior); different model → `{resume: sess, fork:true}`
  (forks a new session seeded with the full prior transcript under the new
  model, so context carries and no model-mismatch wipe occurs).
  AUTO PIPELINE, roster-agent sends, and `sendAgentFollowup` are untouched
  (they don't go through this branch).
- **Impact**: switching the composer's bare-model target now preserves
  chat context across models; same-model repeat sends are unaffected.
- **Status**: ✅ Complete — `node --check renderer/app.js` passes; smoke-
  launched the app (`npm start`) to confirm no startup errors. Full manual
  click-through of the 5 ACCEPTANCE scenarios (switch Sonnet→Opus→Sonnet,
  confirm no "stored session was stale" message, confirm same-model sends
  don't fork, confirm pipeline unaffected) was **not** driven end-to-end by
  me — this app has no GUI automation hook, so that step needs the operator
  to click through in the running window. Logic was traced statically
  against the exact runAgent/result-handler code paths and matches the
  task's acceptance criteria line for line.

### task-01 (browser-error-page-and-google-login): real error page + Google login
- **Files**: renderer/src/browser.js, renderer/index.html, renderer/style.css
- **Goal**: (1) load failures should show a centered, human-readable in-viewport
  error page like a real browser instead of a header toast; (2) Google/Gmail
  sign-in should be accepted and persist across restarts.
- **Change**:
  - index.html: added `#bw-error` overlay inside `#bw-stack` (after `#bw-empty`)
    with icon/title/message/url/retry-button, mirroring `#bw-empty`'s structure.
  - style.css: `.bw-error` (absolute, centered column flex, `var(--bg)`,
    `z-index:2` so it covers the guest's default Chromium error page) plus
    `.bw-error-icon/-title/-msg/-url/-retry`, all theme-var based.
  - browser.js: grabbed the new elements (`errBox/errTitle/errMsg/errUrl/
    errRetry`); added `ERROR_MESSAGES` map keyed by `errorDescription`
    (ERR_CONNECTION_REFUSED / ERR_NAME_NOT_RESOLVED / ERR_INTERNET_DISCONNECTED /
    ERR_CONNECTION_TIMED_OUT / ERR_CONNECTION_RESET / ERR_CONNECTION_CLOSED,
    default falls back to a generic message + raw code). Per-webview error state
    `wv._error = { url, desc }` set on main-frame `did-fail-load` (guards both
    `errorCode === -3` aborted and `isMainFrame === false` sub-resource),
    cleared on `did-start-loading`/`did-navigate`. New helpers `showError(wv)`,
    `hideError()`, `refreshErrorOverlay()` (called from `setActiveTab()` after
    the visibility swap, so switching tabs shows the correct tab's error state).
    Removed the `toast(...)` call from `did-fail-load` entirely. `errRetry`
    reloads the stored `wv._error.url` via `load()`.
  - browser.js: added module-level `CHROME_UA` = `navigator.userAgent` with the
    `Electron/…` and `agent-deck|LoveAi/…` tokens stripped; `ensureWv()` now
    calls `wv.setAttribute('useragent', CHROME_UA)` before `stack.appendChild
    (wv)`, so the guest presents a standard desktop Chrome UA from its first
    load. `partition="persist:sandbox"` left unchanged (already persisted
    cookies/storage — the UA was the actual login blocker).
- **Impact**: broken pages now show a real in-viewport error card per tab
  instead of a floating header toast; Google/Gmail sign-in is accepted and the
  session persists across app restarts via the existing sandbox partition.
- **Status**: ✅ Complete
  - Syntax verified: `node --check renderer/src/browser.js` passes.
  - Requires an Electron app restart (webview `useragent` attribute is read at
    guest creation) — manual in-app verification of the ACCEPTANCE CRITERIA in
    task-01-browser-error-page-and-google-login.md not performed here.

### task-01 (browser-per-project-isolation): Sandbox browser isolated per project
- **Files**: renderer/src/browser.js, renderer/index.html (comment only)
- **Goal**: match notes/board — the browser strip and its "active tab" must be
  scoped to the ACTIVE project only, not global across every open project.
- **Change** (renderer/src/browser.js):
  - `renderTabs()` now renders a FLAT strip of only `tabs.filter(t => t.wsId
    === activeWorkspaceId)` — no per-project group headers. `groupEl()` and
    the group-add branch of `addBtn()` removed (now `addBtn(label, title)`,
    always creates a tab in `activeWorkspaceId`); `wsColor()` removed
    (unused after groups were dropped). `#bw-empty` toggles on the active
    project's tab count, not the global total.
  - Replaced the single global `activeTabId`/`browserActiveTab` with a
    per-workspace map `activeByWs` (`{ [wsId]: tabId }`, persisted as JSON
    under `browserActiveByWs`); helper `curActiveId()` reads
    `activeByWs[activeWorkspaceId]`. All former `activeTabId` reads
    (`activeWv`, `tabChip` highlight, url-bar/Ctrl+W guards, `wireWebview`
    `isActive`) now go through `curActiveId()`. `loadActiveByWs()`
    best-effort migrates the old `browserActiveTab` value into the map for
    whichever project owns that tab, then deletes the legacy key.
  - `setActiveTab(id)` now writes `activeByWs[activeWorkspaceId]`.
  - `newTab(wsId, url)`: when the new tab belongs to the CURRENT project it
    still calls `setActiveTab` as before; when it's spawned by a background
    project's hidden webview (a `new-window` popup fired while another
    project is on screen) it sets that project's `activeByWs` entry directly
    instead, so a background popup can no longer hijack the on-screen
    project's active tab or leak a foreign tab into the current strip.
  - `closeTab()`: sibling fallback is `tabs.find(t => t.wsId === groupWs) ||
    null` — no longer falls back to another project's tab.
  - `pruneTabs()`: still drops tabs for removed projects, and now also
    clears/reassigns `activeByWs` entries per remaining project (fallback
    tab chosen within that same project) instead of one global fallback.
  - `openBrowserView()`: opens the active project's own active tab (or its
    first tab, or creates one if it has none) instead of the last globally
    active tab.
  - `browserProjectsChanged()`: `pruneTabs()` → if open, `setActiveTab
    (curActiveId())` to swap the visible `<webview>` to the newly active
    project's tab (other projects' guests stay alive+hidden — never
    destroyed on switch) → `renderTabs()`.
  - Top-of-file doc comment updated to describe per-project isolation
    instead of grouping.
  - index.html:484 comment updated to match (strip shows only the active
    project's tabs).
- **Impact**: switching projects now shows only that project's browser tabs
  (like notes/board); each project remembers its own active tab; background
  projects' dev-server tabs keep running hidden and can't bleed into the
  visible strip.
- **Status**: ✅ Complete
  - Syntax verified: `node --check renderer/src/browser.js` passes.
  - Manual in-app verification (multi-project tab switch/close/prune) not
    performed here — requires the operator to restart the Electron app
    (per pipeline rules, not done automatically) and exercise the ACCEPTANCE
    CRITERIA in task-01-browser-per-project-isolation.md by hand.

### task-03: Sandbox browser — multiple tabs grouped by project
- **Files**: renderer/index.html, renderer/src/browser.js, renderer/app.js,
  renderer/style.css
- **Goal**: let the sandbox browser hold MULTIPLE tabs and GROUP those tabs
  by the app's projects (workspaces), so e.g. localhost:3000 for project A
  and localhost:5000 for project B live in separate, labelled groups.
- **Change**:
  - browser.js rewritten from a single fixed `<webview>` to a tab model:
    persistent `tabs` array (localStorage `browserTabs`), each tab
    `{ id, wsId, url, title }`; one `<webview>` per tab created lazily in
    `#bw-stack` and kept alive (hidden) when inactive so dev servers keep
    running across tab switches. `#bw-tabs` strip renders one GROUP per
    workspace (in rail order) — a color-dot + name header, its tabs, and a
    per-group ＋; plus a global ＋ New tab. New tabs default to the active
    project; target=_blank / `new-window` popups open as new tabs in the
    same group. Ctrl/⌘+T new tab, Ctrl/⌘+W close tab, Esc close screen.
    Toolbar (back/fwd/reload/home/devtools/url) now targets the active
    tab's webview. Tab labels use page title → hostname → "New Tab", all
    via textContent (XSS-safe). Closing a project prunes its tabs +
    destroys their webviews.
  - index.html: `#browser-view` now has `#bw-tabs` + `#bw-stack`
    (`#bw-empty` placeholder) instead of the single inline `<webview>`.
  - app.js: `renderRail()` (the single point hit on every workspace
    switch/add/close/folder-open) calls `window.browserProjectsChanged()`
    so groups re-sync and closed-project tabs are pruned. ONE line.
  - style.css: `.bw-tabs/.bw-group/.bw-tab/.bw-stack/.bw-empty` etc.,
    theme-var based (light + dark), mirroring the existing browser styles.
- **Impact**: multi-tab browsing/debugging with tabs organized by project;
  each project's dev-server tabs stay grouped and keep running in the
  background. No main.js change — `webviewTag` was already enabled, so a
  normal restart/reload picks this up.
- **Status**: ✅ Complete
  - Syntax verified: `node --check renderer/src/browser.js`,
    `node --check renderer/app.js` pass; all lines ≤ 100 chars.

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

### task-02: In-app sandbox browser (light, for browsing & debugging)
- **Files**: main.js; renderer/index.html; renderer/src/browser.js (new);
  renderer/app.js (syncPane); renderer/src/notes.js; renderer/src/workspace.js;
  renderer/style.css
- **Goal**: a lightweight in-app browser — top-right header globe button
  opens a full center screen with a URL bar, back/forward/reload/home/
  devtools/close controls, wrapping an Electron `<webview>` (isolated
  `persist:sandbox` partition, no node integration) — not an iframe or a
  separate BrowserWindow.
- **Fix**: added `webviewTag: true` to `createWindow()` webPreferences
  (main.js, `contextIsolation`/`nodeIntegration` unchanged); added
  `#btn-browser` header button and `#browser-view` screen markup
  (index.html); new renderer/src/browser.js implements open/close, URL
  normalization + navigation, back/forward/reload/home/devtools, URL-bar
  sync (skipped while focused), a loading bar, and popup/`target=_blank`
  routing back into the same webview; exposes `window.browserViewOpen()` /
  `window.closeBrowserView()`. Wired the existing each-opener-closes-the-
  others pattern: openBrowserView() closes tickets/notes first; one mirror
  line `if (window.closeBrowserView) closeBrowserView();` added at the top
  of `openNotesView()` (notes.js) and the ticket open fn (workspace.js);
  syncPane() (app.js) gets a matching `browserViewOpen()` guard. Styles in
  style.css mirror `.notes-view` (theme-var based, light+dark).
- **Impact**: casual browsing / local dev-server debugging without leaving
  the app; only one center screen owns the area at a time. Requires a
  MANUAL app restart (webviewTag is read at BrowserWindow creation) — not
  performed here per pipeline rules.
- **Review fixes** (2026-07-21): review found 2 correctness bugs in
  renderer/src/browser.js, both fixed:
  1. openBrowserView() cleared the URL bar based on the static `wv.src`
     DOM attribute (never mutated on normal nav) → the bar wrongly reset to
     empty on every reopen. Now calls `syncUrlBar()`, which reads the live
     `wv.getURL()` and shows empty only for a blank/`about:blank` guest.
  2. A `will-navigate` listener re-issued `load(e.url)` without
     `preventDefault()`, duplicating the guest's own in-webview navigation
     (double GETs; POST form bodies dropped by re-issuing as GET). Removed —
     `new-window` already handles popup/target=_blank routing.
- **Status**: ✅ Complete (review-approved after fixes)
  - Syntax verified: `node --check main.js`,
    `node --check renderer/src/browser.js`, `node --check renderer/app.js`,
    `node --check renderer/src/notes.js`, `node --check renderer/src/workspace.js`
    all pass.

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

### fix: explorer visibly collapsed the active folder on every add/edit refresh
- **File**: renderer/src/explorer.js — `exReset()`
- **Symptom**: adding/editing a file (AI agent write, git op, etc.) refreshed
  the explorer and visibly closed whatever folder was expanded, instead of the
  VS Code-style smooth in-place refresh.
- **Root cause**: `exExpandedDirs` + `exRenderDir`'s per-folder atomic swap
  (fetch first, clear+repaint only after data arrives) already existed to make
  refreshes flicker-free, but `exReset()` blanked `#ex-tree` synchronously
  BEFORE calling `exLoad()`. That made `exLoad()`'s own
  `if (!exTree.children.length) exTree.innerHTML='loading...'` guard trip on
  every refresh (not just the true first load), so the whole tree flashed
  empty/"loading..." — reading as "the folder closed" — before the atomic
  swap reopened it.
- **Fix**: `exReset()` no longer clears `#ex-tree`; it just flips
  `exLoaded=false` and calls `exLoad()`, which leaves the old tree on screen
  until `exRenderDir` does its own fetch-then-swap. No behavior change to
  what gets refreshed — only removes the premature blank-out.
- **Impact**: `exLoad`/`exRenderDir`/`exExpandedDirs`/`refreshWorkspace`
  untouched; double-click-to-reopen-same-tab in `openFile` (editor.js) was
  already correct, no change needed there.
- **Status**: ✅ Complete — `node --check renderer/src/explorer.js` passes.
  App not restarted (per task); needs a manual check: expand a folder, edit a
  file inside it (or let an agent write one), confirm the folder stays open
  with no visible flash.

### fix: renaming/deleting a file or folder still looked like a full explorer refresh
- **File**: renderer/src/explorer.js — `exRename()`, `exDelete()`
- **Symptom**: after the prior flash fix, typing a new name (context menu
  Rename → Enter) or deleting an item still visibly rebuilt the WHOLE tree —
  every row got fresh DOM nodes even though only one row actually changed.
- **Root cause**: `exRename`/`exDelete` called `await exLoad()` (full root
  rebuild via `exRenderDir(projectDir, exTree)`) after a successful
  `fsRename`/`fsDelete`, unlike `exStartCreate` (new file/folder), which
  already only refreshes the local target container, and `exMoveItems`,
  which already patches the DOM in place via `exRelocateRow` — rename/delete
  were the two remaining call sites still doing a tree-wide reload.
- **Fix**: added `exRenameRowInPlace(oldPath, newPath, newName)` and
  `exRemoveRowInPlace(path)` (next to `exRelocateRow`, same pattern —
  `exFindRow` the row, patch `dataset.path`/name or `.remove()` it and its
  `.ex-children`, remap any loaded descendants' path prefixes for a dir
  rename, `exSortContainer` the row's own parent to re-alphabetize). Both
  return `false` if the row isn't currently rendered (e.g. inside a
  collapsed ancestor), in which case the callers fall back to `exLoad()` —
  same safety net as before, just no longer the common path.
- **Impact**: only the renamed/deleted row (and, for a dir rename, its
  already-loaded descendants' path prefixes) changes — no other row in the
  tree is torn down, so no visible refresh. Matches existing parity: like
  `exMoveItems`, this does NOT remap `openFiles`/`activeFile` paths for a
  renamed item that's currently open in an editor tab — that gap already
  existed for drag-move and is unchanged/out of scope here.
- **Status**: ✅ Complete — `node --check renderer/src/explorer.js` passes.
  App not restarted (per task); needs a manual check: rename a file and a
  folder (with the folder expanded) via the context menu, and delete one,
  confirming the rest of the tree doesn't visibly refresh/collapse.

## task-01-oauth-native-window — Google sign-in via shared-session native window (2026-07-22)
- **Why**: "Sign in with Google" popups (`window.open`) in the sandbox browser
  were re-hosted as embedded `<webview>` tabs, which Google rejects. Route auth
  popups to a native child `BrowserWindow` sharing `persist:sandbox` so cookies
  land where the webview can see them.
- **main.js**: new `AUTH_HOSTS` Set + `isAuthHost()` + `AUTH_WEBPREFS`, and
  `ipcMain.handle('open-auth-window', { url, returnOrigin })` — guarded child
  BrowserWindow (parent=win, 520×680, persist:sandbox, no preload, sandbox:true);
  nested popups via `setWindowOpenHandler` share the partition (deny non-https);
  closes when a nav returns to `returnOrigin` or the page self-closes; resolves
  `{ ok:true }` on `closed`, `{ ok:false, error }` on failure.
- **preload.js**: `openAuthWindow(url, returnOrigin)` on `window.deck`.
- **renderer/src/browser.js**: `AUTH_HOSTS`/`isAuthUrl()`/`openAuthPopup()`
  helpers; `new-window` handler now branches — auth URL → `openAuthPopup()`
  (opens native window then reloads active webview); everything else unchanged
  (still opens as an in-app tab).
- **Untouched**: `configureSandboxSession`, the partition string, the per-webview
  `useragent` attr. No `will-navigate` listener added. No app.js/UI changes.
- **Status**: ✅ Complete — `node --check` passes on all three files. main.js
  changed → manual app restart required to verify Google popup sign-in.

## task-01-session-no-stale — Prevent spurious session staling + always-clickable New Session (2026-07-22)
- **Why**: Follow-ups kept hitting "stored session was stale — restored prior
  context…" instead of just continuing, and once wedged the operator was
  trapped (New Session refused while any run flagged running). Root cause: the
  Agent SDK keys each session by a project slug derived from the run cwd; we
  stored the shared id keyed only by projectDir but resumed it under whatever
  cwd the dispatching agent had (default roster agents ship cwd:'' → USERPROFILE
  slug), so a projectDir-cwd follow-up looked in a different slug → not found.
- **renderer/app.js**:
  - New session-cwd helpers next to the id/model ones: `sessCwdKey()` =
    `'deckSessionCwd:'+projectDir`, `getSessionCwd()`, `setSessionCwd(cwd)`.
    `clearSession()` now also removes `sessCwdKey()` (lock-step with id+model).
  - `case 'result'` (~1548): inside the existing `if (ev.sessionId && !r.noShare)`
    block, also `setSessionCwd(r.cpCwd)` — records the run's real cwd.
  - runAgent cfg: new `resumeCwd: opts.cont ? getSessionCwd() : (opts.resume ?
    opts.cwd : null)`. The project-scoped `cwd` field (context injection) is
    unchanged.
  - `btn-new-session.onclick`: removed the hard refusal. Now force-stops every
    running agent (`stopAgent(id)`), then force-clears any still-`running` flag
    (`running=false` + `setRunningUI(id,false)`) — covers a wedged flag with no
    live process. Confirmation line appends " (stopped N running agent(s))" when
    N>0. clearSession + feed wipe unchanged.
- **main.js** resume block (~3479): when resuming, `if (typeof cfg.resumeCwd ===
  'string' && cfg.resumeCwd) options.cwd = cfg.resumeCwd;` — forces the run cwd
  to the session's home so the slug matches. Fresh-retry paths delete cfg.resume
  → untouched, keep original options.cwd.
- **Untouched (out of scope)**: stale-RECOVERY net (runOnce / buildStalePrompt /
  session-invalid / readSessionTranscript), getSession/setSession signatures and
  key formats, the model-switch fork path, the plan-resume path.
- **Status**: ✅ Complete — `node --check` passes on both files. main.js +
  renderer changed → manual app restart required (see [[rerun-app-after-changes]])
  to verify: follow-up continues same 8-char session id (no stale line);
  New Session resets mid-run and when a rt[id].running flag is wedged.
