REVIEW-MODEL: claude-sonnet-5

# Review brief — pipeline speed: persistent index, context scoping, session reuse

## Task context

LoveAi (Electron console orchestrating a Prompt Engineer → Seniors → Reviewer pipeline) gains three speed mechanisms so follow-up fixes are fast like Cursor/base44:
1. **Stage 0 INDEXER**: Haiku agent writes/updates `.loveai/index/PROJECT-MAP.md`; backend fingerprint (`fingerprint.json`, per-file `mtimeMs:size`) decides missing/stale/fresh so it only runs when needed.
2. **Context scoping**: RULES prompt appendices tell PE/Senior/Reviewer to navigate via the map and read only issue-relevant files.
3. **Session reuse**: PE's session ID persisted per project cwd in `localStorage` (`loveai-pe-sessions`) and resumed with `forkSession: true` on later runs; cleared on `session-invalid`.

Model tiering already existed (MODEL:/REVIEW-MODEL: routing) and must be untouched.

## Expected changed files

- `main.js` — new helpers `indexDir`, `projectFingerprint`; new IPC handlers `index-status`, `index-mark`. Nothing else in the file.
- `preload.js` — two new bridge methods `indexStatus`, `indexMark`.
- `renderer/app.js` — `RULES.indexer` + appendices to `RULES.prompt/senior/reviewer`; INDEXER roster agent + `pipe.stage === 'index'` handling in `launchPipeline`/`onPipelineAgentDone` (with `startStage1` extraction); `runAgent` opts extended with explicit resume/fork; localStorage PE-session persistence + invalidation.
- `.loveai/pipeline/changes-log.md` — engineer entries.

No other files may change. No new npm dependencies.

## Risks / regressions to watch

1. **Main-process hangs**: `projectFingerprint` is synchronous — verify the directory-skip list and the 5000-file cap actually prevent walking `node_modules`/huge repos; verify dot-directories are skipped.
2. **Pipeline regression when the bridge is missing/throws**: `launchPipeline` must degrade to exactly today's behavior if `indexStatus` rejects (try/catch), and an indexer FAILURE must still proceed to Stage 1, never abort.
3. **Stage machine**: new `pipe.stage === 'index'` must not break `abortPipeline`/`finishPipeline`/`cleanupSeniors`, plan-review transitions, or the fix-round loop (`pipe.iteration`). Check `onPipelineAgentDone` ordering — indexer completion must call `indexMark` before Stage 1.
4. **runAgent opts extension**: existing call sites (`fresh: true` senior/reviewer runs, model routing) must behave byte-identically; the new explicit resume must not overwrite the shared-session logic (`getSession`/`setSession`, `noShare`).
5. **Session persistence**: localStorage read-modify-write wrapped in try/catch (corrupt JSON must not crash); `session-invalid` must clear the matching cwd entry; resumed runs must pass `forkSession: true` (main.js:641–643 supports it) so history doesn't balloon.
6. **Fingerprint correctness**: added AND deleted files must flip `stale`; `index-mark` must write the CURRENT fingerprint (recompute at mark time, not a stale cached one).
7. **Prompt edits**: RULES text changes are append-only — the original numbered instructions (task-file format, MODEL: line contract, verdict contract) must remain intact, since the orchestrator parses them (`parseModelLine`, VERDICT first line).
8. **Syntax**: `node --check` on all three JS files.
