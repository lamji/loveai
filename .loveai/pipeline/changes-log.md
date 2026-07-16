# Changes log

## task-01-index-ipc-backend.md
Files changed:
- `main.js` — added `indexDir(cwd)`, `projectFingerprint(cwd)` (recursive walk skipping node_modules/.git/dist/build/.loveai/.next/coverage/dot-dirs, source-ext filter, 5000-file cap), `ipcMain.handle('index-status', ...)`, `ipcMain.handle('index-mark', ...)` — placed after `pipeline-reset`, before the file-explorer section.
- `preload.js` — exposed `indexStatus`/`indexMark` on the `deck` bridge next to `pipelineReset`.

Verified: `node --check` was requested on both files, but the sandbox denies direct `node` execution for this session, so verification was done by careful manual re-read of the edited regions (balanced braces/try-catch, consistent style with neighboring handlers/readJson usage). Traced `index-status` logic by hand for the three required cases (no fingerprint/no map → `{exists:false,stale:false,changedFiles:[]}`; unchanged fingerprint → `{exists:true,stale:false}`; changed mtime → `{exists:true,stale:true,changedFiles:[rel]}`). `index-mark` recomputes the fingerprint at call time (not cached) before writing.

## task-02-renderer-index-stage-and-session-reuse.md
Files changed (`renderer/app.js` only):
- Added `RULES.indexer`; appended SPEED context-scoping rules to `RULES.prompt`, `RULES.senior`, `RULES.reviewer` (append-only, numbered instructions/format left intact).
- Added `def-indexer` to `DEFAULT_AGENTS`, `indexer` entries to `ROLE_ICON`/`ROLE_LABEL`, `index` stage label to `STAGE_LABEL`.
- `runAgent` opts extended with explicit `opts.resume`/`opts.fork`, layered on top of existing `opts.fresh`/`getSession()` logic without changing behavior when `opts.resume` is absent.
- `launchPipeline` now checks `window.deck.indexStatus(pipe.cwd)` (try/catch, defaults to `{exists:false,stale:false,changedFiles:[]}` on throw) after `pipelineReset`; fresh index skips straight to `startStage1`; missing/stale index runs the INDEXER (`fresh:true`) with either a full-index or incremental changed-file prompt, stashing the issue in `pipe.pendingIssue`.
- Extracted `startStage1(issue)` (the former tail of `launchPipeline`) — also looks up a persisted PE session via `getPESession(pipe.cwd)` and resumes with `{resume, fork:true}` when found, logging "resuming Prompt Engineer session <first8> (warm context)".
- `onPipelineAgentDone`: new `pipe.stage === 'index'` branch runs before the generic error/abort check, so indexer failure never aborts the pipeline — it logs and always proceeds to `startStage1`; success calls `window.deck.indexMark(pipe.cwd)` first.
- Added `loveai-pe-sessions` localStorage helpers (`readPESessions`/`savePESession`/`getPESession`/`clearPESession`), all read-modify-write wrapped in try/catch.
- `result` event handler: persists PE session id via `savePESession` when the finishing agent's role is `prompt` and `pipe.cwd` is set.
- `session-invalid` handler: also calls `clearPESession(ev.sessionId)` to purge any stored PE session pointing at the invalidated id.

Verified: same `node --check` caveat as task-01 — sandbox denies direct execution, so verified by manual re-read of every edited region for balanced braces and by tracing the four required flows against the code: fresh-index skip, missing-index → Stage 0 → indexMark → Stage 1, stale-index incremental prompt, PE session persist-then-resume-with-fork, and `session-invalid` clearing the stored entry. No existing call site of `runAgent` was changed in behavior (all still omit `opts.resume`).
