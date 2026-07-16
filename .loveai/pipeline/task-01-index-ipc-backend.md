# task-01 — Project-index IPC backend (main.js + preload.js)

MODEL: claude-sonnet-5

## CONTEXT

LoveAi is an Electron app (`main.js` = main process / IPC backend, `preload.js` = contextBridge, `renderer/app.js` = UI + pipeline orchestrator). We are adding a persistent per-project code index so follow-up pipeline runs are fast: a Haiku "INDEXER" agent (implemented in task-02, renderer side) writes `.loveai/index/PROJECT-MAP.md`, and the backend decides whether that index is missing/stale/fresh using a cheap file fingerprint.

Your job is ONLY the backend plumbing: two IPC handlers in `main.js` and their bridge exposure in `preload.js`. The renderer that calls them is task-02 — do not touch it.

Existing patterns to follow (read them first):
- `main.js:122` `pipelineDir(cwd)` — helper returning `<cwd>/.loveai/pipeline`. Mirror it with `indexDir(cwd)` → `<cwd>/.loveai/index`.
- `main.js:138` `ipcMain.handle('pipeline-scan', ...)` — style for a sync read-only handler with try/catch swallowing.
- `main.js:127` `ensureGitignore(cwd)` already ignores `.loveai/` — no gitignore work needed.
- `preload.js` — see how existing channels like `pipelineScan` are exposed on the `deck` bridge; add the two new ones in identical style.

## SCOPE — TO-DO

### 1. `main.js` — add near the pipeline handlers (after `pipeline-reset`, ~line 180)

- [ ] `function indexDir(cwd)` → `path.join(cwd || process.env.USERPROFILE, '.loveai', 'index')`.
- [ ] `function projectFingerprint(cwd)`:
  - Recursively walk `cwd`, skipping directories named `node_modules`, `.git`, `dist`, `build`, `.loveai`, `.next`, `coverage`, and any dot-directory.
  - Only include files with source-like extensions (js, mjs, cjs, jsx, ts, tsx, json, html, css, scss, md, py, go, rs, java, cs, php, rb, vue, svelte, yml, yaml, toml, sql) — reuse the spirit of `LANG_BY_EXT` (main.js:214) but a simple Set literal is fine.
  - Cap the walk at 5000 files (stop descending once reached) so huge repos can't hang the main process.
  - For each file record `relativePath -> ${mtimeMs}:${size}` in a plain object. Wrap all fs calls in try/catch like the rest of the file.
  - Return that object.
- [ ] `ipcMain.handle('index-status', (_e, cwd) => ...)`:
  - Compute the current fingerprint.
  - Read `<indexDir>/fingerprint.json` (use the existing `readJson` helper, main.js:287) and check `<indexDir>/PROJECT-MAP.md` exists.
  - Return `{ exists: <map file exists>, stale: <exists but fingerprints differ>, changedFiles: [...] }` where `changedFiles` = relative paths added/removed/modified vs. the stored fingerprint, capped at 50 entries.
  - If no stored fingerprint or no map file: `{ exists: false, stale: false, changedFiles: [] }`.
- [ ] `ipcMain.handle('index-mark', (_e, cwd) => ...)`:
  - `fs.mkdirSync(indexDir(cwd), { recursive: true })`, write the CURRENT fingerprint to `fingerprint.json` (pretty-printed), return `true`. Try/catch → return `false` on error.

### 2. `preload.js`

- [ ] Expose on the existing `deck` bridge, matching the surrounding style exactly:
  - `indexStatus: (cwd) => ipcRenderer.invoke('index-status', cwd)`
  - `indexMark: (cwd) => ipcRenderer.invoke('index-mark', cwd)`

## OUT OF SCOPE — must NOT touch

- `renderer/app.js`, `renderer/index.html`, `renderer/style.css` (task-02 owns app.js).
- Any existing IPC handler, the agent-run logic, pipeline handlers, git/terminal/skills code.
- `package.json`, no new dependencies.

## ACCEPTANCE CRITERIA

- `node -e "require('./main.js')"` is NOT a valid check (Electron app) — instead verify syntax with `node --check main.js` and `node --check preload.js` (both must pass).
- `index-status` on a folder with no `.loveai/index` returns `{ exists:false, stale:false, changedFiles:[] }` (verify by reading your code path, and if possible a small node harness that stubs the two pure helpers `projectFingerprint`/diff logic).
- After `index-mark`, a second `index-status` with no file changes yields `exists:true, stale:false` (assuming PROJECT-MAP.md exists).
- Changing one file's mtime flips `stale:true` and lists that relative path in `changedFiles`.
- Append your entry to `.loveai/pipeline/changes-log.md` when done.
