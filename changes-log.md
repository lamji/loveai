# Changes Log

## 2026-07-23

### fix: Stop button looked like it wasn't working
- **File**: renderer/app.js — `stopAgent()`, `ticker()`, `showThinking()`, `runAgent()`, `case 'done'`
- **Symptom (operator)**: clicking Stop on a running agent didn't visibly do
  anything — the thinking row / status pill kept reading "thinking…" or the
  latest tool narration for a while, as if the click had no effect.
- **Root cause**: `stopAgent()` sends the abort IPC and returns; it never
  touched the UI itself. Meanwhile the SDK subprocess can take a moment to
  actually die, so trailing `thinking`/`tool`/`text-delta` events kept
  arriving and calling `ticker()`/`showThinking()`, which overwrote the
  status straight back to "thinking…"/narration until the real `done` event
  finally landed.
- **Fix**: new `r.aborting` flag on the agent's runtime state (`R(agentId)`).
  `stopAgent()` now sets it immediately after requesting the abort and force-
  updates both the status pill (`ticker`) and the feed's thinking row
  (`showThinking`) to "aborting…". `ticker()`/`showThinking()` now pin their
  label to "aborting…" whenever `r.aborting` is set, ignoring whatever text
  a trailing event tries to set — so the UI can't flip back to "thinking…"
  mid-abort. The flag is cleared on `case 'done'` (the real end of the run)
  and reset to `false` at the top of `runAgent()` so a fresh run never
  inherits a stale flag. The existing "wedged, no session yet" recovery path
  in `stopAgent()` (pre-`init` abort) is unchanged — it already resets
  `running` synchronously and has no thinking row to fix.
- **Untouched**: `window.deck.stopAgent()` IPC / main-process abort logic,
  `setRunningUI()`, the init watchdog.
- **Status**: `node --check renderer/app.js` passes. Renderer-only → hot-
  reloads via Ctrl+R; operator asked NOT to restart the app.

### feat: console tool rows now read as steps + show their result
- **Files**: main.js, renderer/app.js, renderer/style.css
- **Why (operator)**: the central console listed bare tool calls
  (`Read <abs path>`, `Grep <abs path>`, `Bash git diff …`) with no outcome
  and no legible intent — you couldn't tell what a Read returned or why the
  agent kept reading/grepping.
- **Result of each call is now shown**: main.js was dropping tool_result
  entirely (only tool_use + result were forwarded). It now tracks each
  tool_use id→{name,input}, and on the following `user` message summarizes
  every tool_result and forwards a new `tool-result` event
  (`{id, tool, ok, summary}`). Summaries: Read → "N lines", Grep → "N
  matches"/"N files" (by output_mode), Glob → "N files", Bash/PowerShell →
  "N lines out"/"no output", errors → the first error line. The renderer
  lands that as a rounded chip on the exact tool row (matched by tool_use
  id via a `toolRowEls` map — buffer-safe), red on failure.
- **Intent now reads like commentary**: each row is a present-tense sentence
  instead of a raw tool name + absolute path — `Let me check renderer/app.js`,
  `Searching for "feedFilter" in renderer/app.js`, `Running git diff --stat
  HEAD`, `Looking for **/*.js`. Lead-ins rotate (READ_LEADS / FIND_LEADS via
  a `narrTick` counter) so a run of calls reads like a person working, not a
  list. Paths are relative to the agent's cwd; for Grep the pattern is
  surfaced (that pattern IS the "why it's searching"). New `toolNarration()`
  + `relToCwd()` + `toolTarget()` helpers. The agent's own streamed narration
  still renders above these rows unchanged.
- **Outcome wording softened** (main.js summarizeTool): Grep → `found 8
  matches` / `found in 3 files` / `nothing found`; Glob → `5 files` /
  `nothing found`; Read → `142 lines` / `empty file`; Bash → `done`;
  errors → the first error line. So a row reads
  `Searching for "x" in app.js   [found 8 matches]`.
- **Untouched**: edit tools keep their diff card (added/removed lines already
  convey the result); their tool-result is a no-op (no row stored).
- **Status**: `node --check` passes on main.js + renderer/app.js.
  ⚠ main.js changed → the result chips + softened wording only take effect
  after a FULL app restart (operator asked NOT to restart — applies on next
  launch); the renderer narration sentences hot-reload on Ctrl+R.

### fix: no live logs in CENTRAL CONSOLE for a chat targeting AUTO PIPELINE
- **File**: renderer/app.js
- **Symptom (operator)**: start a new chat and the central console shows
  nothing — no PIPELINE status, no agent output — even though a run is
  actually happening.
- **Root cause**: `openChatUI` → `openChatSession` → `openChat` filters the
  console (`feedFilter`) down to the chat's own hidden `chat-<id>` agent.
  A chat whose target is `__pipeline__` (AUTO PIPELINE — the first, default
  option in the dock's target dropdown) never runs under that id; it fans
  out to the real roster agents (indexer/PE/senior/reviewer). Their feed
  rows all got hidden by the mismatched filter, and `plog`'s `PIPELINE` tag
  is *also* silenced by design (`SILENT_FEED_TAGS`) — filtered + silenced
  left the console looking completely dead.
- **Fix**: `openChatUI` now clears `feedFilter` (shows the unfiltered
  console) whenever the chat's target is `__pipeline__`, covering both a
  brand-new pipeline chat and reopening one whose pipeline is still running.
- **Status**: `node --check renderer/app.js` passes. Renderer-only; operator
  asked NOT to restart — applies on next Ctrl+R / app launch.

### fix: sidebar chat click landed on an empty console (no history, no loading)
- **Files**: renderer/app.js, renderer/style.css
- Clicking a chat in the CHATS list (openChatUI) never replayed the chat's
  stored transcript — only the ticket/board flow (openChatSession) did. After
  an app restart a chat with an existing sdkSessionId opened onto an EMPTY
  console with no indication anything should be there.
- openChatUI now routes through openChatSession(chat agent, sdkSessionId).
- **Follow-up**: chat.sdkSessionId is only captured when a run COMPLETES
  (chatOnDone) — for older/interrupted chats it is null, so the replay
  silently bailed and the console stayed blank (the header's "session
  xxxxxxxx" is getSession(), the shared deck session, not the chat's).
  openChatUI now falls back to getSession(); an empty/missing transcript
  prints "no saved transcript found…" instead of silently showing nothing,
  and is retried on the next click instead of being marked hydrated.
- Loading state added while the transcript loads: the chat row's spinner
  runs (.chat-row.loading) and the feed shows a "loading previous
  conversation…" placeholder that is replaced by the replayed history.
- feed() now returns the created row so the placeholder can be removed.
- **Status**: syntax-checked; app NOT restarted (operator's running instance
  left alone — takes effect next launch/reload).

### feat: Chrome-style browser tabs
- **Files**: renderer/index.html, renderer/style.css, renderer/src/browser.js
- Tab strip redesigned to look like Google Chrome: tabs sit on a darker
  frame row with rounded tops; the active tab shares the toolbar background
  and merges into it with inverted (flared) bottom corners; thin separators
  between inactive tabs; close ✕ fades in on hover/active.
- Favicon per tab (page-favicon-updated → stored + persisted), spinner in
  the icon slot while loading, dim dot fallback.
- ＋ new-tab button moved from the toolbar into the tab bar (after the last
  tab, Chrome-style). Middle-click closes a tab.

### fix: terminal ctrl+click — reuse any empty tab + url bar stays blank
- **Files**: renderer/src/browser.js
- **Empty "New Tab" not reused**: openUrlInBrowser only reused an empty tab
  when it was the ACTIVE one; a non-active empty tab lingered while a fresh
  tab opened beside it (reproduced over the bridge). Now any empty tab in
  the active project is reused, active one first.
- **URL bar blank until refresh**: openBrowserView always focused the url
  bar, and syncUrlBar skips updates while the bar is focused — so after a
  ctrl+click every did-navigate sync was silently dropped and the bar stayed
  empty until a manual refresh. openBrowserView now focuses the bar only on
  an empty tab; openUrlInBrowser blurs the bar and shows the target url
  immediately; syncUrlBar falls back to the tab's stored url while the
  webview isn't attached yet.
- **Status**: ✅ both repro'd live over the bridge before the fix; app
  restarted after.

### feat: browser bridge — in-app Playwright (MCP + HTTP + browserctl CLI)
- **Files**: main.js, preload.js, renderer/src/bridge.js (new),
  renderer/src/browser.js, renderer/index.html, browserctl.js (new),
  docs/browser-bridge.md (new)
- **Why**: Playwright is painfully slow for debugging/e2e (browser spawn +
  CDP handshake per run) and can't see the app's OWN sandbox browser. The
  bridge drives the live `<webview>` guests directly — commands land in
  milliseconds on the tabs the user is already looking at.
- **main.js**: `bridgeDispatch()` relays ops to the renderer over
  bridge-cmd/bridge-reply IPC (per-op timeouts); passive webRequest network
  log for persist:sandbox (400-entry ring buffer, served without a renderer
  trip); screenshots decoded + saved to %TEMP%\loveai-shots; token-gated
  HTTP endpoint on 127.0.0.1 (random port, `POST /cmd`, `GET /health`) with
  port+token written to ~/.loveai/browser-bridge.json AND injected into every
  in-app terminal's env (LOVEAI_BRIDGE_PORT/TOKEN); `buildBrowserServer()` —
  an in-process `browser` MCP server (12 tools: tabs/open/navigate/snapshot/
  click/fill/press/eval/console/network/screenshot/wait_for) added to every
  agent run beside `deck`.
- **bridge.js**: executes each op on the right tab — injects an idempotent
  guest helper lib (`__lv`) for ref-based snapshots (headings + interactive
  elements as `ref=eN role "name"`), click by ref/selector/text, React-safe
  fill (native value setter + input/change), waitFor polling; real Chromium
  key events via sendInputEvent (Enter actually submits forms); capturePage
  screenshots; per-tab console ring buffer read-out; fast-fails with the real
  load error (e.g. ERR_CONNECTION_REFUSED) instead of a blind timeout.
- **browser.js**: exposes internals as `window.__bw`; buffers guest
  console-message (500/tab) for the bridge.
- **Status**: ✅ full e2e self-test over the HTTP bridge against a live app:
  open → snapshot (5 refs) → click by ref + by text → fill + select → real
  Enter submits form → waitFor late DOM (4ms) → console shows page error →
  network log shows 404 → screenshot verified visually → same-URL open
  reuses the tab → popup link became an in-app tab. App restarted.

### fix: sandbox browser bugs + flow gaps (terminal link → tab)
- **Files**: main.js, renderer/src/browser.js
- **Popups were broken (silent)**: browser.js listened for the webview
  `new-window` DOM event — REMOVED in Electron 22 (app runs 33). Any
  window.open/target=_blank opened a bare native window; OAuth popup routing
  was dead code. Now main.js handles `web-contents-created` for sandbox
  guests: `setWindowOpenHandler` denies + routes — AUTH_HOSTS → native
  shared-session window (opener reloaded after sign-in), other http(s) →
  `browser-popup` IPC → tab in the OPENER's project. Renderer-side auth
  list/openAuthPopup deleted (single source of truth in main).
- **localhost forced to https**: normalizeUrl("localhost:5173") produced
  https:// → SSL error on every dev server. Local hosts (localhost/127.x/
  0.0.0.0) now get http://.
- **Terminal ctrl+click spammed tabs**: every click opened a NEW tab (plus a
  stray empty "New Tab" when the project had none). openUrlInBrowser now
  reuses an existing tab with the same URL, navigates an empty active tab in
  place, else opens one tab.
- **Hotkeys died inside the page**: Esc/Ctrl+T/W never bubble out of a
  focused guest — you could get stuck in full view. main.js forwards them
  via before-input-event → `browser-hotkey` (adds Ctrl+L = focus url bar).
- **Crashes invisible**: render-process-gone now shows the error overlay
  ("The page crashed") with working Try again.
- **URL bar blank on first Enter**: with no active tab, the empty newTab
  cleared the input; now the tab opens directly onto the typed URL.
- **Status**: ✅ popup→tab and dedupe verified live over the bridge; rest
  code-reviewed + app restarted.

### feat: vector-build checkpoint/resume — close the app mid-build, lose ≤1000 symbols
- **Files**: vectors.js, vectors-worker.js, renderer/src/statusbar.js
- **Before**: both index builds only wrote to disk at the END. Closing the app
  mid-embed (minutes-long on big repos) lost everything; reopen restarted the
  vector build from 0%.
- **vectors.js**:
  - Every symbol doc gets a 32-bit FNV-1a `docHash`, stored alongside ids in
    vectors.json (and checkpoints). Same doc + same model ⇒ identical
    embedding, so a hash-validated row is losslessly reusable.
  - Long builds checkpoint to vectors.partial.{json,bin} every ~1000 embedded
    symbols (bin written before json; a torn pair is rejected on read).
  - `buildVectorIndex` first loads reusable rows from BOTH the completed index
    and any partial checkpoint, embeds only the missing/changed docs, then
    writes the final index and deletes the checkpoint. If nothing changed it
    finishes without even loading the model.
  - `syncFilesVectors` carries hashes through watcher syncs (0 = unknown).
- **statusbar.js**: a ≥5% first jump in the vectors phase is detected as a
  resume; the alternating label says "resumed previous embedding — continuing…".
- **Effect**: manual rebuilds on an unchanged repo are near-instant (measured
  15ms for the test index vs a full re-embed); a kill mid-build loses at most
  ~1000 symbols of work.
- **Status**: ✅ end-to-end test (real embedder): full build → unchanged
  rebuild (12/12 reused, 15ms) → one-doc-changed (11/12 reused) → simulated
  interruption via checkpoint (12/12 resumed, checkpoint cleaned up) → query
  returns correct top hit. App restarted.

### fix: build progress stuck at 0% + human "this takes time" messaging
- **Files**: main.js, codegraph-worker.js, codegraph-parse.js, vectors.js,
  renderer/src/statusbar.js
- **Root causes of the silent 0%**:
  1. BACKGROUND graph rebuilds (schema bump / first open) emitted NO progress
     events at all — codegraph-status said "building" so the bar appeared,
     then sat frozen at 0% until the build silently finished. A manual click
     during one returned "already building" and displayed nothing.
  2. resetGraphWorker race: the old worker's async 'exit' event fired AFTER a
     new worker spawned, clearing the fresh build's pending request — the
     replacement build died instantly with no UI feedback.
  3. Silent phases: file counting (seconds on big repos) and the embedding
     model load (tens of seconds) reported nothing.
- **main.js**: buildCodeGraph now streams `codegraph-progress` for EVERY build
  (phases init → count → parse → done|error, with the error text). fail() in
  cgWorker ignores superseded workers; resetGraphWorker detaches listeners
  before terminate and fails pending requests itself.
- **codegraph-worker/parse**: counting reports every 250 files (phase 'count');
  parse progress tagged phase 'parse'.
- **vectors.js**: buildVectorIndex reports 0/N BEFORE the slow model load.
- **statusbar.js**: while building, the label ALTERNATES every ~4s between the
  progress percentage and a plain-language note ("parsing code — large repos
  can take minutes…", "loading embedding model — can take a minute…", "still
  embedding — hang tight…"), stall-aware (>8s without progress switches to
  "still …" wording), repainted every 1s tick until the build truly finishes.
  'done'/'error' phases finalize the bar (background builds included);
  "already building" no longer records as an error — the background build's
  progress now streams into the same bar.
- **Status**: ✅ node --check on all five files; app restarted.

### refactor: unified walker + worker-side tree-sitter + retrieval eval loop
- **Files**: main.js, renderer/app.js, preload.js; NEW: walker.js,
  codegraph-parse.js, codegraph-worker.js
- **Unified walker (walker.js)**: the four hand-rolled tree walkers
  (projectFingerprint, buildSymbolIndex, countGraphFiles, buildCodeGraph) are
  now ONE `walkRepo(root, {exts}, onFile)` sharing skip rules
  (INDEX_SKIP_DIRS + .gitignore), the 5000-file cap, and event-loop yielding.
  `projectFingerprint` was the last SYNCHRONOUS walk on the main process
  (index-status hit it per call) — now async. Fingerprint keys switch to
  forward-slash rels: one-time staleness vs old backslash keys, self-heals on
  the next index-mark.
- **Tree-sitter off the main process**: the whole parse layer (runtime,
  grammars, queries, rich def records, extractFileGraph, importSpecs) moved
  verbatim from main.js into codegraph-parse.js and runs inside a persistent
  codegraph-worker.js (same protocol as vectors-worker). Main keeps assembly
  (edge linking), caches, persistence, reachability, packer. Full builds AND
  single-file re-parses (watcher) go through the worker; a manual rebuild
  respawns the worker to retry a failed tree-sitter init. main.js sheds ~360
  lines of parse code. Graph gains `truncated` flag from the build.
- **Retrieval eval loop (hit@k)**: runAgent records the pre-ranked file list
  (cold front-load and warm per-message); the tool-event handler collects
  Edit/MultiEdit/Write file paths; on done, `logRetrievalEval` writes one line
  {query, predicted, edited, hit5, hit10, warm} to
  .loveai/index/retrieval-eval.jsonl via new `eval-log` IPC. New `eval-stats`
  IPC returns run count + average hit@5/hit@10 + last 5 entries
  (window.deck.evalStats(cwd)). This is the ground truth for whether ranking
  changes help — check before/after tuning retrieval.
- Also: importSpecs regex excludes spaces (quoted prose in comments no longer
  produces junk spec entries); preload retrieveContext drops the dead
  withContent param.
- **Status**: ✅ node --check on all six files; smoke test (plain Node) ran the
  worker end-to-end on this repo: 27 files parsed, 841 defs, import specs
  extracted, single-file parse job OK, walker skip rules verified (0
  violations). ⚠ NOT activated — needs a full app restart (main + workers),
  deliberately not performed this round.

### fix: retrieval-engineering review round — correctness, accuracy, perf
- **Files**: main.js, vectors.js, vectors-worker.js, renderer/app.js
- **Correctness**:
  - `symbolBuilding` was one GLOBAL promise — with two projects building
    concurrently, project B received (and cached) project A's index. Now a
    per-cwd map like `graphBuilding`.
  - `fuseRetrieval` called `V.queryVectors` directly, lazily loading a second
    copy of the ONNX model ON THE MAIN THREAD (search_code hot path). Now all
    vector queries route through the persistent worker (`workerVectorHits`).
  - Symbol ids: same-named defs in one file were silently dropped (name-only
    dedupe) and `id = rel#name` collided. Dedupe is now name@line; ids get an
    `@line` suffix only on collision. GRAPH_SCHEMA 2→3 (stale graphs rebuild
    in the background on next open).
  - Deleted stray `undefined/vecbench/` artifact (unguarded cwd interpolation
    from a removed bench script).
- **Retrieval accuracy**:
  - `get_symbols`/`retrieve-symbols` now seed `packSymbols` with vector hits
    (`opts.vectorIds`) — meaning-only queries ("timezone bug") pack symbols
    even when no query token matches any name. Previously BM25+name-match only.
  - Import-scoped edge resolution: `linkEdges` resolves call/import names
    against the referrer's actual imports first (`importSpecs` regex + 
    `resolveSpec` path/ext/index guessing), falling back to global-by-name.
    Kills cross-module same-name blast-radius noise (`init`, `close`, …).
  - `defDoc` now appends up to 8 callee names — symbols without a doc comment
    were embedded as bare names (no semantic signal beyond fuzzy name match).
  - Indexing skips more junk: INDEX_SKIP_DIRS + out/target/vendor/venv/
    __pycache__/local_cache, PLUS simple dir entries from the root .gitignore
    (`ignoredDirs`/`skipDir`, applied to all 4 walkers + watcher filters).
  - Truncation surfaced: `idx.truncated` when the 5000-file cap hits; repo map
    and search_code output now say the index is PARTIAL instead of letting
    agents mistake a capped index for full coverage.
- **Performance / tokens**:
  - vectors.json v2: raw Float32 sidecar `vectors.bin` + small metadata JSON
    (was ~35MB base64-in-JSON stringify per watcher sync at 17k symbols).
    v1 files remain readable; writes migrate to v2. `hasVectorIndex` now
    validates loadability so a schema-stale index triggers a rebuild.
  - Watcher vector-sync ships the changed files' defs to the worker — no more
    full codegraph.json read+parse per save burst (fallback kept).
  - `lexicalImpact` inverted map cached per index (WeakMap; invalidated on
    file change/delete) — was rebuilt from ALL tokens on every agent launch
    while the graph was cold.
  - Warm-run TARGET FILES inject deduped per session (`lastTargets`) — same
    target set no longer re-appends the ~0.5k block every follow-up.
  - Removed the dead `withContent` file-inlining branch from retrieve-context
    (renderer always passes 0 since the pull-model change).
- **Status**: ✅ `node --check` passes on all four files. Graph + vector
  indexes rebuild themselves in the background on next project open (schema
  bumps). Needs full app restart (main.js + worker changed).

### feat: pull-model retrieval — in-process mcp__deck__* tools + slim push
- **Files**: main.js, renderer/app.js (research: docs/context-retrieval-research.md)
- **Architecture change**: context moves from PUSH (pre-computed ~12k-char
  blob injected into the first prompt, keyed on the raw user text) to PULL
  (the agent queries the local index MID-TASK, when it knows what it needs).
- **main.js**: new `buildDeckServer(cwd)` — an in-process MCP server
  (SDK `tool()` + `createSdkMcpServer`, zod schemas) registered per run via
  `options.mcpServers = { deck }` + `allowedTools: ['mcp__deck__*']`. Tools
  (all readOnlyHint, handlers reuse existing index functions):
  - `search_code(query,k)` — fuseRetrieval (BM25+vector RRF) ranked files + symbol hits
  - `get_symbols(query,budget)` — tree-sitter symbol pack (actual code)
  - `who_references(query)` — regression blast-radius from the code graph
  - `topic_memory(query)` — .loveai/memory topic bodies (same scoring as memoryInject)
  Also: SDK import now captures `tool`/`createSdkMcpServer`; zod required.
- **renderer/app.js**: cold front-load slimmed to an Aider-style MAP — repo
  map + ranked file names/symbols + semantic list + impact + a directive
  naming the mcp__deck__* tools. REMOVED: whole-file TOP FILE CONTENTS
  inlining, the 12k symbol-pack inject (cold AND warm), thinPack logic,
  `packSig`/`lastPackSig`. `retrieveContext` now called with withContent=0.
  Warm per-message retrieval is a 2-call trio→duo (files list only).
- **⚠ Activation**: main.js + renderer must go together — a Ctrl+R alone
  would tell agents to call tools the running main process hasn't
  registered. Needs a FULL app restart (not performed; operator is testing).
- **Status**: ✅ `node --check` passes on both; SDK exports verified
  (tool/createSdkMcpServer present); zod loads.

### change: composer send arrow morphs into a stop button while running
- **Files**: renderer/index.html, renderer/style.css, renderer/app.js
- **What**: ChatGPT-style — while the active chat's agent runs, the ↑ send
  button turns into a red ■ stop square that aborts the run; it reverts to
  the arrow when the run ends. Previously the arrow just went disabled and
  stopping required the small header ■.
- **How**: two SVGs inside `#ad-send` toggled by a `.stop` class (set in
  `updateChatModal` from `r.running`); click handler stops when running,
  sends otherwise. Ctrl+Enter still can't double-send (existing running
  guard in `sendAgentFollowup`). The dock-head `#ad-stop` is now always
  hidden (superseded); the top-toolbar global stop is untouched.
- **Status**: ✅ `node --check` passes. Renderer-only; no restart per
  operator — applies on next Ctrl+R / app launch.

### perf: tighter enrichment ceilings + launch timing instrumentation
- **File**: renderer/app.js
- **Why**: operator compared launch feel vs Claude Code CLI. Same SDK, but the
  deck pays three costs the interactive CLI doesn't: (1) pre-spawn IPC
  enrichment, (2) a NEW `query()` subprocess per message (node boot + CLI
  init), (3) session RESUME (CLI re-reads the whole transcript JSONL; if the
  5-min prompt cache expired, the full input reprocesses server-side).
- **Timeouts cut**: cold map/memory 4s→2s, impact 6s→3s, retrieval/vector/
  symbols 8s→3.5s; warm per-message trio 6s→2.5s. A warm index answers in
  ms; only a busy worker hits the ceiling, and then the run just launches
  without that enrichment.
- **Instrumentation**: before spawn, feed logs
  `⏱ context assembled in Xms · +Y.Yk chars injected · spawning…`; the
  ⚡session line now appends `· spawned in Z.Zs` (= subprocess + resume cost).
  Slow starts are now attributable at a glance: prep vs spawn vs model.
- **Not done (needs main.js + restart, proposed)**: persistent streaming-input
  SDK session per chat so follow-ups reuse the live process like Claude Code
  does, instead of spawn+resume per message.
- **Status**: ✅ `node --check` passes. Renderer-only; operator asked not to
  restart — applies on next Ctrl+R.

### fix: theme-follow for native dropdowns, feed tag column, parallel enrichment
- **Files**: renderer/style.css, renderer/app.js
- **Native select popup was white in dark theme**: Chromium renders the OS
  popup for `<select>` (the dock's target picker) using `color-scheme`, which
  was never set. Added `color-scheme: dark` to the dark root and
  `color-scheme: light` to the light root — popups (and native scrollbars)
  now follow the app theme.
- **Repeated chat-title column removed in chat view**: `applyFilter()` now
  toggles `one-agent` on `#console-feed` whenever a single-agent filter is
  active; CSS hides `.tag` there. The ALL view keeps tags (they tell agents
  apart in the mixed feed).
- **Launch latency — enrichment now parallel**: runAgent's cold-run context
  chain (hasProjectMap 4s, memoryInject 4s, regressionImpact 6s,
  retrieveContext 8s, vectorQuery 8s, retrieveSymbols 8s) was awaited
  SEQUENTIALLY — worst case ~38s stacked before the SDK spawn. All six now
  kick off together and are awaited in the original order, so the cost is
  max(slowest) ≈ 8s worst case. Prompt append order unchanged.
- **Latent bug fixed while in there**: the front-load block's `const r`
  (retrieveContext result) shadowed the agent-runtime `r`, so
  `r.lastPackSig` was written to the throwaway result — warm follow-ups
  always re-sent an identical symbol pack. Renamed the result to `rc`;
  `r.lastPackSig` now really persists on the runtime.
- **Status**: ✅ `node --check renderer/app.js` passes. Renderer-only —
  operator asked NOT to restart; hot-reload via Ctrl+R when convenient.

### feat: Claude-Code-style diff cards in the feed for every agent edit
- **Files**: main.js, renderer/app.js, renderer/style.css
- **Why it never showed**: `feedDiff` already existed, but main.js truncated
  every tool_use input to 400 chars (`JSON.stringify(...).slice(0,400)`), so
  `JSON.parse` failed for any real Edit/Write and the feed fell back to a
  bare one-line log. And when it did show, it was collapsed, unnumbered,
  filename-only.
- **main.js**: edit tools (Edit/MultiEdit/Write) now also send `editInput`
  (full input, 400k cap) plus `editLines` — each hunk's real start line,
  found by reading the target file and locating old_string (new_string as
  the already-applied fallback). Non-edit tools unchanged.
- **renderer/app.js** (`feedDiff` rewrite): renders `Update(rel\path)` /
  `Write(rel\path)` header, `└ Added N lines` summary, a line-number gutter
  with real file numbers, +/- markers, green/red rows — and the card is
  OPEN by default (header still toggles). Paths shown relative to the
  agent's cwd. Huge Writes capped at 400 rows with a "… N more lines" tail.
- **renderer/style.css**: `.dl > em` gutter, `.diff-sum`, `.dl-cut`,
  colored gutter numbers on add/del rows; dropped the unused `.diff-ico`.
- **Status**: ✅ `node --check` passes on both files. main.js changed →
  full app restart required.

### change: + NEW chat is now ChatGPT-style — no config modal
- **Files**: renderer/app.js, renderer/index.html
- **What**: clicking `+ NEW` no longer opens the NEW CHAT modal (title / seed /
  reasoning / target form). It now calls `openDraftChat()` — the same empty
  draft state the console already uses — and the first message auto-creates
  the chat via `createChatFromText`, titling it from that message's first line
  (≤40 chars), exactly like ChatGPT.
- **Removed**: the whole `#newchat-modal` block in index.html and its JS in
  app.js (`openNewChat`, `createChat`, `ncSyncOrigin`, `fillTargetSelect`,
  `chatBoardTickets`, `ticketSeedPrompt`, `nc-*` wiring) — all were used only
  by the modal.
- **Added**: `openDraftChat()` now calls `focusConsoleForTask()` so `+ NEW`
  works from any surface (editor, board, terminal), matching `openChat`.
- **Status**: ✅ `node --check renderer/app.js` passes.

### fix: engineers re-researched BRAINX's plan — retrieval was keyed on the
### dispatch wrapper, not the task
- **File**: renderer/app.js
- **Symptom (operator)**: BRAINX (PE) writes task files with full CONTEXT, yet
  the assigned engineer still does its own research; RAG hits looked like
  junk ("lots of folders").
- **Root cause**: `startBuild` dispatches engineers with the prompt
  `"Execute task-NN.md: read .loveai/pipeline/… per your pipeline rules."` and
  `runAgent` fed THAT string to every retrieval layer (BM25 retrieveContext,
  vectorQuery/RAG, retrieveSymbols, memoryInject, regressionImpact). The
  front-load therefore ranked files matching "execute/read/pipeline/rules" —
  noise — and the EFFICIENCY directive then pinned the engineer to the wrong
  files, so it had to ignore them and re-locate the real work by hand.
  Same flaw in `startFixRound` ("Fix review findings: read …").
- **Fix**:
  - `runAgent` now takes `opts.retrievalQuery`: `const rq = opts.retrievalQuery
    || prompt` and ALL retrieval calls (cold + warm blocks, RAG feed line,
    memory, impact) query on `rq`. Default unchanged for chats/PE (their
    prompt IS the issue).
  - `deployEngineersFromDir` keeps each task file's body in `p.taskContent`
    (name → content; pipelineRead already loaded it, it was just discarded).
  - `startBuild` passes the task body (COMPLEXITY/MODEL header stripped,
    ≤2500 chars) as `retrievalQuery` — engineers' front-load now ranks the
    files the task is actually about.
  - `startFixRound` passes the review findings text as `retrievalQuery`.
  - Vector-hit file extraction hardened in both blocks: `id.lastIndexOf('#')`
    guarded (`cut > 0`), so a legacy id without `#` no longer yields a
    chopped/garbled path in TARGET FILES / `top:` feed lines.
- **Not the cause (checked)**: the user-level SessionStart WORKFLOW hook does
  NOT reach pipeline agents — they run `lean:true` → `settingSources:
  ['project']`; only non-lean GENERAL-OPS inherits user settings.
- **Status**: ✅ `node --check renderer/app.js` passes; app restarted. Verify:
  run a pipeline, the senior's feed should read `RAG query → "<task text…>"`
  (not "Execute task-…") with sensible top files.

### fix: agents hit max turns searching — retrieval now runs on EVERY message
- **File**: renderer/app.js (runAgent)
- **Symptom**: despite the tree-sitter graph + vector RAG, agents kept hitting
  their turn ceiling on lots of Glob/Grep searches.
- **Root cause**: the RAG/symbol front-load only ran on COLD runs (`!warm`).
  Any resumed/continued run (`opts.resume` — every chat follow-up — or
  `opts.cont` — shared-session sends) skipped ALL retrieval on the theory that
  "the transcript already carries it". True only for the FIRST message's
  topic: a follow-up about something new arrived with zero file targeting, so
  the model re-located the code by hand over many turns — that search loop is
  what burned the ceiling.
- **Fix**: new warm-run block in `runAgent` (after the cold front-load): every
  warm message runs `retrieveSymbols` (7k budget) + `retrieveContext` (10
  files, names/symbols only, no content) + `vectorQuery` (12 hits) in
  parallel (6s timeouts), then injects a "TARGET FILES for THIS message" list
  (lexical + semantic-only files folded in) and the symbol pack, plus a firm
  directive: Read the listed paths directly, do NOT search the repo. Kept
  lean by design — no repo map, no whole-file dump on warm runs. New
  `packSig(sym)` helper: the pack's signature is remembered per agent
  (`r.lastPackSig`, also set by the cold path) so a same-topic follow-up
  doesn't replay an identical pack into a transcript that already has it —
  then only the file list + directive go out. Feed line: `per-message
  retrieval: N target files …` (🧬). MAX_TURNS untouched per operator.
- **Status**: ✅ `node --check renderer/app.js` passes. Renderer-only change;
  app restarted. Verify: send a chat follow-up about a different file than
  the first message — the feed should show `per-message retrieval: …` and the
  run should Read the listed files directly instead of Glob/Grep loops.

### fix: boot crash — dead wiring for the retired global composer broke the whole app
- **Files**: renderer/app.js, renderer/src/editor.js, renderer/src/explorer.js
- **Symptom**: app booted to a dead shell — empty project rail, no chats, no
  composer. DevTools: `Uncaught TypeError: Cannot read properties of null
  (reading 'addEventListener')` at app.js:2651, plus cascading
  `usage`/`auth` ReferenceErrors (declared later in app.js, never reached).
- **Root cause**: the chats redesign removed the global composer markup
  (`#chat-input`, `#btn-attach`, `#btn-chat-expand`, `#chat-target`,
  `#chat-plan`, `#chat-think`, `#chat-mention`) from index.html — the per-chat
  dock (`ad-*`) is now the only chatbox — but app.js still wired those ids at
  top level. The first null deref (enableDrop on `#chat-input`) threw and
  killed everything after line 2651: renderRail, chat list, dock wiring, boot.
- **Fix (renderer/app.js)**: removed the dead top-level wiring — `enableDrop`
  + `setupMention` on `#chat-input`, the `#btn-attach` handler, the unused
  `chatInput` const, `openChatExpand`, the `#btn-chat-expand` binding, and
  `cxDockMode` with its legacy (non-dock) branches in `closeChatExpand` /
  `cx-send` (which also called the removed `sendChat()`). The wide composer
  is now dock-only: open via `ad-expand` → `openDockExpand`, close syncs back
  to `adInput`, send pushes values into the `ad-*` controls and reuses
  `sendAgentFollowup()`.
- **renderer/src/editor.js + explorer.js**: "Send to AI" focus and
  `exSendToChat` retargeted from the deleted `#chat-input` to `#ad-input`
  (they were null-guarded no-ops after the redesign).
- **Status**: ✅ `node --check` passes on all three files; id-sweep confirms
  no remaining references to removed ids; app restarted via `npm start`.

## 2026-07-22

### task-01-chatbox-in-console — Move the main chatbox into the console, drop the sidebar one
- **Why**: Continue the ChatGPT-style redesign (sidebar CHATS list + agents in
  Settings). The main composer belonged in the center console by default, not in
  the left sidebar. "the chatbox by default should be in console, remove the left
  main chat."
- **renderer/index.html**:
  - Removed the `<section class="side-block chatbox">` from the AGENT sidebar.
    The CHATS section (`grow`) now fills the sidebar.
  - Added `<section id="console-chat" class="console-chat hidden">` inside
    `#editor-area`, right after `#agent-dock`. It carries the SAME control ids
    (`chat-input`, `chat-target`, `btn-send`, `chat-plan`, `chat-think`,
    `btn-chat-expand`, `btn-new-session`, `slash-menu`, `chat-mention`,
    `attach-chips`, `file-in`, `btn-attach`, `btn-pipeline-stop`), so every
    existing JS binding (`sendChat`, slash/mention setup, wide composer,
    `initThinkSelect`, `buildTargetDropdown`, editor "Send to AI") works unchanged.
    Header pills moved into a `.cc-actions` row with a `.cc-spacer`.
- **renderer/style.css**:
  - `#console-chat` — centered column (`--console-col`/max), `flex:none`, docked
    at the bottom of the console; `.cc-actions` / `.cc-spacer` for the pill row.
  - `#editor-area.split > #console-chat { display:none !important; }` — hidden in
    editor-split, mirroring `#agent-dock` (the split row layout can't host it).
  - Absolute `inset:0` overlays (welcome z4, tkws/notes/browser z5) cover the
    console chatbox automatically — no JS needed to hide it under a center screen.
- **renderer/app.js**:
  - New `syncConsoleChat()` — shows `#console-chat` only when a project is open
    AND no per-chat dock is active (`!projectDir || dockOpen` → hidden).
  - Called from `openChat` (hide when a chat dock takes over), `closeAgentView`
    (restore + `renderChatList()` to drop the active-row highlight), and
    `renderWelcome` (hidden on the Welcome screen). Boot path
    (editor.js `renderWelcome()`) sets the initial state; `switchWorkspace`
    inherits it via `refreshProjectBindings → renderWelcome`.
- **Untouched**: `sendChat` dispatch logic (pipeline/model/roster), the per-chat
  `sendChatMessage`/`agent-dock` flow, session persistence, the `.chatbox` CSS
  rules (now dead but harmless).
- **Known edge**: in editor-split mode the console chatbox is hidden (matches
  agent-dock); "Send to AI" while split focuses a hidden input (chip still
  attaches). Acceptable — split already hid the per-agent composer.
- **Status**: ✅ `node --check renderer/app.js` passes; index.html div/section
  tags balance; all moved ids are unique. Renderer-only → hot-reloads with
  Ctrl+R. App restart skipped per user request.

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

## task-01-rag-line-accuracy — Fix wrong "no vector index" RAG line (2026-07-22)
- **Why**: `vectors-worker.js` serializes build/sync/query on one thread. While
  Project B's vector build occupies it, a Project A `vectorQuery` queues behind
  it and blows the renderer's 8s timeout → `vq === null`, which the old code
  treated as "no index" even though A's `vectors.json` exists on disk — false
  diagnosis that loops the user into an unnecessary rebuild.
- **renderer/app.js** (runAgent RAG block, ~1331-1348): split the old catch-all
  `else` into two real states. `vq && vq.indexed` (no embedErr) now reads
  "vector index built · 0 semantic matches for this query — lexical only"
  instead of "no vector index". The true fallback (`vq` null or `!vq.indexed`)
  calls `window.deck.vectorStatus(cwd)` (main-thread IPC, not blocked by the
  busy worker; wrapped in try/catch) — if it reports `exists: true`, prints
  "vector index exists but the query didn't return (another build may be
  running) — lexical for now"; only when the index is genuinely absent does it
  keep the original "no vector index for this project yet" wording.
- **Untouched**: main.js, vectors.js, vectors-worker.js, preload.js, the 8000ms
  timeout, the vectorQuery k argument, the status-bar progress bar (task-02).
- **Status**: ✅ Complete — `node --check renderer/app.js` passes. Renderer-only
  → hot-reloads via Ctrl+R, no app restart needed. Manual verification still
  pending (needs two projects, one mid-build, to exercise the timeout path).
