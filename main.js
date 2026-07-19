const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
let query;
const sdkReady = import('@anthropic-ai/claude-agent-sdk').then(m => { query = m.query; });

// The Claude Code native binary (claude.exe) ships as a sibling package of the
// SDK. Inside a packaged app it lives under app.asar — but a binary can't be
// SPAWNED from inside an asar archive, so electron-builder unpacks it to
// app.asar.unpacked. We locate the real file and hand its path to the SDK.
function resolveClaudeExecutable() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const plat = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const bases = [__dirname, path.join(__dirname, '..')];
  const rels = [
    ['node_modules', '@anthropic-ai', plat, exe],
    ['node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', '@anthropic-ai', plat, exe]
  ];
  for (const base of bases) {
    for (const rel of rels) {
      const packed = path.join(base, ...rel);
      // ALWAYS prefer the app.asar.unpacked copy: a binary can't be spawned from
      // inside the archive, and Electron's asar layer makes fs.existsSync() return
      // true for the packed path too — so we must test the unpacked one FIRST.
      const unpacked = packed.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      for (const cand of [unpacked, packed]) {
        // reject any candidate still sitting inside app.asar — it isn't spawnable
        if (cand.includes(`app.asar${path.sep}`) && !cand.includes('app.asar.unpacked')) continue;
        try { if (fs.existsSync(cand)) return cand; } catch {}
      }
    }
  }
  return null;
}
const CLAUDE_EXE = resolveClaudeExecutable();
const saas = require('./auth');
const config = require('./config');

let win;
// runId -> { abortController }
const runs = new Map();

// ===== SaaS deep link (loveai://) — Google OAuth returns through here =====
// Dev runs (`electron .`) must register exe + args or Windows launches a bare
// electron; packaged builds also get the registry key from build.protocols.
if (process.defaultApp) {
  app.setAsDefaultProtocolClient(config.PROTOCOL, process.execPath,
    [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(config.PROTOCOL);
}

function deepLinkIn(argv) {
  return (argv || []).find(a => typeof a === 'string' && a.startsWith(config.PROTOCOL + '://'));
}

// Windows delivers the URL to a SECOND instance's argv — keep one instance and
// route the link to it.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', (_e, argv) => {
  const url = deepLinkIn(argv);
  if (url) saas.handleDeepLink(url);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0A2947',
    autoHideMenuBar: true,
    title: 'LoveAi',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('renderer/index.html');
}

app.whenReady().then(() => {
  saas.init(send);
  createWindow();
  // cold start via the protocol link (app wasn't running): URL is in OUR argv
  const url = deepLinkIn(process.argv);
  if (url) saas.handleDeepLink(url);
});
app.on('window-all-closed', () => app.quit());

// ===== SaaS IPC — Supabase session + per-user data =====
ipcMain.handle('saas-session', () => saas.getSession());
ipcMain.handle('saas-login-start', () => saas.startLogin());
ipcMain.handle('saas-logout', () => saas.logout());
ipcMain.handle('saas-profile', () => saas.fetchProfile());
ipcMain.handle('saas-settings-get', () => saas.fetchSettings());
ipcMain.handle('saas-settings-set', (_e, s) => saas.saveSettings(s));
ipcMain.handle('saas-roster-get', () => saas.fetchRoster());
ipcMain.handle('saas-roster-set', (_e, a) => saas.saveRoster(a));

// ===== Skills sync — ~/.claude/skills/<name>/SKILL.md ↔ user_skills table =====
function userSkillsDir() {
  return path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'skills');
}

function snapshotUserSkills() {
  const out = {};
  try {
    const base = userSkillsDir();
    for (const dir of fs.readdirSync(base)) {
      const fp = path.join(base, dir, 'SKILL.md');
      try { out[dir] = fs.readFileSync(fp, 'utf8'); } catch {}
    }
  } catch {}
  return out;
}

// disk snapshot → cloud (source of truth for deletes: the whole map is replaced)
ipcMain.handle('saas-skills-push', () => saas.saveSkills(snapshotUserSkills()));

// cloud → disk. Only writes skills MISSING locally (never clobbers local edits —
// the local copy is pushed right back after edits anyway). Returns what it added.
ipcMain.handle('saas-skills-pull', async () => {
  const r = await saas.fetchSkills();
  if (!r.ok) return r;
  const added = [];
  const local = snapshotUserSkills();
  const remote = r.skills || {};
  try {
    for (const [name, content] of Object.entries(remote)) {
      if (local[name] !== undefined || typeof content !== 'string') continue;
      if (!/^[\w][\w-]*$/.test(name)) continue;   // path-safe slugs only
      const dir = path.join(userSkillsDir(), name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
      added.push(name);
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  // first sync from this machine: cloud empty but local has skills → seed cloud
  const localCount = Object.keys(local).length;
  if (!Object.keys(remote).length && localCount) await saas.saveSkills(local);
  return { ok: true, added };
});

// ===== Claude CLI onboarding check — { installed, hasGlobalCli, version, loggedIn }
// installed counts the SDK-bundled claude.exe too; hasGlobalCli is the real
// `claude` on PATH (what the setup terminal installs so login works anywhere).
ipcMain.handle('claude-setup-check', async () => {
  const version = await new Promise((resolve) => {
    execFile('claude', ['--version'], { shell: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
  const hasGlobalCli = !!version;
  const installed = hasGlobalCli || !!resolveClaudeExecutable();
  let loggedIn = false;
  try {
    const credPath = path.join(process.env.USERPROFILE || '', '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')).claudeAiOauth;
    loggedIn = !!(creds && creds.accessToken);
  } catch {}
  if (!loggedIn && hasGlobalCli) {
    try {
      const r = await claudeCli(['auth', 'status']);
      const j = JSON.parse(r.stdout);
      loggedIn = !!j.loggedIn;
    } catch {}
  }
  return { installed, hasGlobalCli, version, loggedIn };
});

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ctrl+click on a terminal link — only ever http(s), opened in the OS browser
ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  return true;
});

// clipboard lives in the main process — a sandboxed preload can't touch it directly
ipcMain.handle('clipboard-read', () => { try { return clipboard.readText(); } catch { return ''; } });
ipcMain.handle('clipboard-write', (_e, text) => { try { clipboard.writeText(String(text || '')); return true; } catch { return false; } });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// used by Explorer's right-click "Add File(s)" / "Add Image(s)" — imports
// picked paths the same way an OS drag-and-drop does (see fs-import)
ipcMain.handle('pick-files', async (_e, { images } = {}) => {
  const filters = images
    ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }]
    : undefined;
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
  return r.canceled ? [] : r.filePaths;
});

function claudeCli(args) {
  return new Promise((resolve) => {
    execFile('claude', args, { shell: true, timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

ipcMain.handle('auth-status', async () => {
  const r = await claudeCli(['auth', 'status']);
  try { return { ok: true, ...JSON.parse(r.stdout) }; }
  catch { return { ok: false, loggedIn: false, raw: r.stdout + r.stderr }; }
});

// plan usage limits — same OAuth endpoint the Claude Code CLI's /usage screen uses
ipcMain.handle('plan-usage', async () => {
  try {
    const credPath = path.join(process.env.USERPROFILE || '', '.claude', '.credentials.json');
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')).claudeAiOauth;
    if (!creds || !creds.accessToken) return { ok: false, error: 'no credentials — sign in first' };
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 401 ? 'token expired — run any agent task once to refresh it' : 'usage endpoint returned ' + res.status };
    }
    const j = await res.json();
    return { ok: true, limits: j.limits || [], spend: j.spend || null, extra: j.extra_usage || null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// Reasoning-effort options straight from Claude. We ask the agent SDK which
// effort levels the current model supports (ModelInfo.supportedEffortLevels)
// so the composer dropdown tracks whatever Claude offers — if Claude changes
// its reasoning levels, this changes too, with nothing hardcoded here.
// The input is a never-yielding stream so init happens but no turn runs.
ipcMain.handle('effort-levels', async () => {
  await sdkReady;
  let q;
  try {
    const idle = (async function* () { await new Promise(() => {}); })();
    const opts = { settingSources: ['user', 'project', 'local'] };
    if (CLAUDE_EXE) opts.pathToClaudeCodeExecutable = CLAUDE_EXE;
    q = query({ prompt: idle, options: opts });
    // don't let a stalled init block the composer from rendering its dropdown
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('effort-levels timed out')), 8000));
    const models = await Promise.race([q.supportedModels(), timeout]);
    // effort levels for the default (first) model that supports effort
    const withEffort = models.find(m => m.supportsEffort && m.supportedEffortLevels)
      || models.find(m => m.supportedEffortLevels);
    const levels = (withEffort && withEffort.supportedEffortLevels) || [];
    return { ok: true, levels };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    try { q && q.close(); } catch {}
  }
});

ipcMain.handle('auth-logout', async () => {
  const r = await claudeCli(['auth', 'logout']);
  return { ok: r.ok, out: r.stdout + r.stderr };
});

ipcMain.handle('auth-login', async () => {
  // login is interactive (browser OAuth + terminal confirm) — open a real console for it
  spawn('cmd.exe', ['/c', 'start', '"Claude Login"', 'cmd', '/k', 'claude auth login'], { detached: true, shell: false });
  return { ok: true };
});

function pipelineDir(cwd) {
  return path.join(cwd || process.env.USERPROFILE, '.loveai', 'pipeline');
}

// keep .loveai/ out of the project's git history
function ensureGitignore(cwd) {
  try {
    if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return;
    const gi = path.join(cwd, '.gitignore');
    const txt = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!/^\.loveai\/?\s*$/m.test(txt)) {
      fs.appendFileSync(gi, (txt && !txt.endsWith('\n') ? '\n' : '') + '.loveai/\n');
    }
  } catch {}
}

ipcMain.handle('pipeline-scan', (_e, cwd) => {
  const out = { tasks: [], taskMtimes: {}, verdict: null, brief: false };
  try {
    const dir = pipelineDir(cwd);
    const files = fs.readdirSync(dir);
    out.tasks = files.filter(f => /^task-\d+.*\.md$/i.test(f)).sort();
    for (const f of out.tasks) {
      try { out.taskMtimes[f] = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    }
    out.brief = files.includes('review-brief.md');
    if (files.includes('review-findings.md')) {
      const first = fs.readFileSync(path.join(pipelineDir(cwd), 'review-findings.md'), 'utf8').split('\n')[0];
      if (/APPROVED/i.test(first)) out.verdict = 'APPROVED';
      else if (/REJECTED/i.test(first)) out.verdict = 'REJECTED';
    }
  } catch {}
  return out;
});

ipcMain.handle('pipeline-read', (_e, cwd) => {
  const files = [];
  try {
    const dir = pipelineDir(cwd);
    for (const f of fs.readdirSync(dir)) {
      if (/\.md$/i.test(f)) files.push({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  } catch {}
  return files;
});

// create-or-overwrite a file in .loveai/pipeline/ (used for fallback briefs)
ipcMain.handle('pipeline-write', (_e, { cwd, name, content }) => {
  try {
    const dir = pipelineDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(name)), String(content || ''), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

ipcMain.handle('pipeline-reset', (_e, cwd) => {
  ensureGitignore(cwd);
  const dir = pipelineDir(cwd);
  try {
    if (fs.existsSync(dir)) {
      // preserve every planning doc: move it into archive/<timestamp>/ instead of deleting
      const docs = fs.readdirSync(dir).filter(f => /\.md$/i.test(f));
      if (docs.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const arch = path.join(dir, 'archive', stamp);
        fs.mkdirSync(arch, { recursive: true });
        for (const f of docs) fs.renameSync(path.join(dir, f), path.join(arch, f));
      }
    }
  } catch {}
  return true;
});

function indexDir(cwd) {
  return path.join(cwd || process.env.USERPROFILE, '.loveai', 'index');
}

const INDEX_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.loveai', '.next', 'coverage']);
const INDEX_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'html', 'css', 'scss', 'md', 'py', 'go', 'rs', 'java', 'cs', 'php', 'rb', 'vue', 'svelte', 'yml', 'yaml', 'toml', 'sql']);
const INDEX_MAX_FILES = 5000;

function projectFingerprint(cwd) {
  const root = cwd || process.env.USERPROFILE;
  const fp = {};
  let count = 0;

  function walk(dir) {
    if (count >= INDEX_MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (count >= INDEX_MAX_FILES) return;
      if (d.isDirectory()) {
        if (d.name.startsWith('.') || INDEX_SKIP_DIRS.has(d.name)) continue;
        walk(path.join(dir, d.name));
      } else if (d.isFile()) {
        const ext = path.extname(d.name).slice(1).toLowerCase();
        if (!INDEX_EXTS.has(ext)) continue;
        const full = path.join(dir, d.name);
        try {
          const stat = fs.statSync(full);
          const rel = path.relative(root, full);
          fp[rel] = `${stat.mtimeMs}:${stat.size}`;
          count++;
        } catch {}
      }
    }
  }

  try { walk(root); } catch {}
  return fp;
}

ipcMain.handle('index-status', (_e, cwd) => {
  try {
    const dir = indexDir(cwd);
    const mapExists = fs.existsSync(path.join(dir, 'PROJECT-MAP.md'));
    const stored = readJson(path.join(dir, 'fingerprint.json'));
    if (!stored || !mapExists) return { exists: false, stale: false, changedFiles: [] };

    const current = projectFingerprint(cwd);
    const changedFiles = [];
    for (const rel of Object.keys(current)) {
      if (stored[rel] !== current[rel]) changedFiles.push(rel);
      if (changedFiles.length >= 50) break;
    }
    if (changedFiles.length < 50) {
      for (const rel of Object.keys(stored)) {
        if (!(rel in current)) {
          changedFiles.push(rel);
          if (changedFiles.length >= 50) break;
        }
      }
    }
    return { exists: true, stale: changedFiles.length > 0, changedFiles };
  } catch {
    return { exists: false, stale: false, changedFiles: [] };
  }
});

ipcMain.handle('index-mark', (_e, cwd) => {
  try {
    const dir = indexDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const fp = projectFingerprint(cwd);
    fs.writeFileSync(path.join(dir, 'fingerprint.json'), JSON.stringify(fp, null, 2), 'utf8');
    buildSymbolIndexOnce(cwd).catch(() => {});   // rebuild lexical index in background (non-blocking)
    return true;
  } catch {
    return false;
  }
});

// ===== Lexical retrieval — symbol index + BM25 (no embeddings, no Python) =====
// Gives the Prompt Engineer the files most likely involved in an issue up front,
// so it reads a handful instead of grepping the whole repo. Pure Node, offline.
const SYMBOL_MAX_BYTES = 400 * 1024;
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then', 'not', 'but', 'you', 'are', 'was', 'will', 'add', 'fix', 'use', 'get', 'set', 'new', 'now', 'has', 'have', 'should', 'need', 'want', 'make', 'change', 'update', 'issue', 'bug', 'feature', 'file', 'code', 'function', 'const', 'let', 'var', 'return', 'import', 'export']);

function tokenize(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // split camelCase
    .split(/[^A-Za-z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 3 && t.length <= 40 && !STOP.has(t));
}
function extractSymbols(text) {
  const syms = new Set();
  const res = [
    /(?:function|class|interface|type|enum|struct)\s+([A-Za-z_$][\w$]*)/g,
    /(?:export\s+(?:default\s+)?(?:async\s+)?function\s+)([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g,
    /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\([^)]*\)\s*=>/g,   // arrow fns/methods
    /\bdef\s+([A-Za-z_][\w]*)/g,          // python
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g   // go
  ];
  for (const re of res) { let m; while ((m = re.exec(text)) && syms.size < 400) syms.add(m[1]); }
  return [...syms];
}
// ASYNC + yielding: reads files with fs.promises and hands control back to the
// event loop every batch, so indexing a big repo NEVER freezes the main process
// (which froze the whole window — "Not Responding" — when this ran synchronously).
let symbolBuilding = null;   // in-flight build per app (dedupe concurrent calls)
const symbolCache = {};      // cwd -> index kept in memory (fast reuse + incremental updates)
const symbolWatchers = {};   // cwd -> { watcher, timer, pending:Set }
async function buildSymbolIndex(cwd) {
  const root = cwd || process.env.USERPROFILE;
  const files = {};
  let count = 0, sinceYield = 0;
  const yieldSoon = () => new Promise((r) => setImmediate(r));
  async function walk(dir) {
    if (count >= INDEX_MAX_FILES) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (count >= INDEX_MAX_FILES) return;
      if (d.isDirectory()) {
        if (!d.name.startsWith('.') && !INDEX_SKIP_DIRS.has(d.name)) await walk(path.join(dir, d.name));
        continue;
      }
      const ext = path.extname(d.name).slice(1).toLowerCase();
      if (!INDEX_EXTS.has(ext) || ext === 'json') continue;   // json rarely useful to rank
      const full = path.join(dir, d.name);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.size > SYMBOL_MAX_BYTES) continue;
        const text = await fs.promises.readFile(full, 'utf8');
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const symbols = extractSymbols(text);
        const tf = {};
        const bump = (s, w) => { for (const t of tokenize(s)) tf[t] = (tf[t] || 0) + w; };
        for (const s of symbols) bump(s, 4);          // symbol names weigh most
        bump(rel.replace(/[\/.]/g, ' '), 3);          // path + filename
        const ids = text.match(/[A-Za-z_$][\w$]{2,}/g) || [];
        let len = 0;
        for (const id of ids) { for (const t of tokenize(id)) { tf[t] = (tf[t] || 0) + 1; len++; } }
        files[rel] = { symbols: symbols.slice(0, 30), tf, len: len || 1 };
        count++;
        if (++sinceYield >= 30) { sinceYield = 0; await yieldSoon(); }   // keep UI responsive
      } catch {}
    }
  }
  await walk(root);
  const idx = { built: Date.now(), avgLen: 1, files };
  recomputeAvgLen(idx);
  symbolCache[cwd] = idx;
  await persistIndex(cwd, idx);
  return idx;
}
function recomputeAvgLen(idx) {
  const lens = Object.values(idx.files).map((f) => f.len);
  idx.avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 1;
}
// write both the machine index (symbols.json) and a human-readable map (repo-map.md)
async function persistIndex(cwd, idx) {
  const dir = indexDir(cwd);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'symbols.json'), JSON.stringify(idx), 'utf8');
  const md = `# Project Map (auto-generated by LoveAi)\n\n` +
    `Files indexed: ${Object.keys(idx.files).length} · updated ${new Date().toISOString()}\n\n` +
    repoMapFromIndex(idx, cwd) + '\n';
  await fs.promises.writeFile(path.join(dir, 'repo-map.md'), md, 'utf8');
}
// dedupe: never run two builds for the same import at once
function buildSymbolIndexOnce(cwd) {
  if (symbolBuilding) return symbolBuilding;
  symbolBuilding = buildSymbolIndex(cwd).finally(() => { symbolBuilding = null; });
  return symbolBuilding;
}
// use the cached index (memory → disk → build) — the "check if available, else create"
async function loadOrBuildIndex(cwd) {
  if (symbolCache[cwd]) return symbolCache[cwd];
  let idx = readJson(path.join(indexDir(cwd), 'symbols.json'));
  if (!idx || !idx.files) idx = await buildSymbolIndexOnce(cwd);
  symbolCache[cwd] = idx;
  return idx;
}
// (re)index a single file into the in-memory index — used by the watcher
async function indexOneFile(cwd, abs) {
  const idx = symbolCache[cwd]; if (!idx) return false;
  const rel = path.relative(cwd, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return false;
  if (rel.split('/').some((p) => p.startsWith('.') || INDEX_SKIP_DIRS.has(p))) return false;
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!INDEX_EXTS.has(ext) || ext === 'json') return false;
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile() || stat.size > SYMBOL_MAX_BYTES) return false;
    const text = await fs.promises.readFile(abs, 'utf8');
    const symbols = extractSymbols(text);
    const tf = {};
    const bump = (s, w) => { for (const t of tokenize(s)) tf[t] = (tf[t] || 0) + w; };
    for (const s of symbols) bump(s, 4);
    bump(rel.replace(/[\/.]/g, ' '), 3);
    const ids = text.match(/[A-Za-z_$][\w$]{2,}/g) || [];
    let len = 0;
    for (const id of ids) { for (const t of tokenize(id)) { tf[t] = (tf[t] || 0) + 1; len++; } }
    idx.files[rel] = { symbols: symbols.slice(0, 30), tf, len: len || 1 };
    return true;
  } catch { return false; }
}
// ===== Purpose blurbs for repoMapFromIndex — offline heuristics only =====
// Tokens too common to ever describe a directory's purpose on their own.
const GENERIC = new Set([
  'index', 'main', 'app', 'src', 'lib', 'data', 'item', 'value', 'list',
  'key', 'val', 'obj', 'props', 'params', 'err', 'res', 'req', 'str', 'num',
  'tmp', 'util', 'utils', 'test', 'spec', 'page', 'node', 'module',
  'default', 'string', 'number', 'object', 'options', 'config', 'result'
]);
// last path segment (or 2nd-to-last, for these generic container names) -> phrase
const GENERIC_SEGMENT = new Set(['src', 'lib', 'v1', 'v2', 'app', 'source']);
const DIR_PURPOSE = {
  services: 'business logic services',
  components: 'UI components',
  utils: 'shared utility helpers',
  helpers: 'shared utility helpers',
  models: 'data models',
  entities: 'data models',
  schemas: 'data models',
  routes: 'route definitions',
  router: 'route definitions',
  controllers: 'request handlers',
  handlers: 'request handlers',
  middleware: 'request middleware',
  hooks: 'reusable hooks',
  migrations: 'database migrations',
  tests: 'tests',
  __tests__: 'tests',
  spec: 'tests',
  e2e: 'tests',
  api: 'API endpoints',
  config: 'configuration',
  types: 'shared type definitions',
  store: 'app state management',
  state: 'app state management',
  styles: 'styling',
  css: 'styling',
  assets: 'static assets',
  public: 'static assets',
  static: 'static assets',
  docs: 'documentation',
  scripts: 'dev scripts',
  tools: 'dev scripts',
  pages: 'page views',
  views: 'page views',
  screens: 'page views',
  auth: 'authentication logic'
};

function sanitizeBlurb(s) {
  let t = String(s || '').replace(/\s+/g, ' ').replace(/[—|]/g, '').trim();
  if (!t) return '';
  const words = t.split(' ');
  if (words.length > 15) t = words.slice(0, 15).join(' ');
  if (t.length > 90) {
    t = t.slice(0, 90);
    const cut = t.lastIndexOf(' ');
    if (cut > 0) t = t.slice(0, cut);
  }
  return t.trim();
}

// first-party doc text for a dir: package.json description, else first
// real line of README/AGENTS.md. Every read is sync + guarded — this only
// runs over the ≤30 dirs shown in the map, so the cost is negligible.
function docBlurb(absDir) {
  try {
    const pkgPath = path.join(absDir, 'package.json');
    const st = fs.statSync(pkgPath);
    if (st.size <= 64 * 1024) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && typeof pkg.description === 'string' && pkg.description.trim()) {
        return sanitizeBlurb(pkg.description);
      }
    }
  } catch {}
  for (const name of ['README.md', 'AGENTS.md', 'readme.md']) {
    try {
      const p = path.join(absDir, name);
      const st = fs.statSync(p);
      if (st.size > 64 * 1024) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('![')) continue;
        const cleaned = line
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/^#+\s*/, '')
          .replace(/`/g, '')
          .trim();
        if (!cleaned) continue;
        return sanitizeBlurb(cleaned);
      }
    } catch {}
  }
  return '';
}

function dictPhrase(dir) {
  const segs = dir.split('/').filter(Boolean);
  if (!segs.length) return '';
  let last = segs[segs.length - 1].toLowerCase();
  if (GENERIC_SEGMENT.has(last) && segs.length > 1) {
    last = segs[segs.length - 2].toLowerCase();
  }
  return DIR_PURPOSE[last] || '';
}

// top domain tokens for a dir by DOCUMENT frequency (files containing the
// token, not raw tf weight — keeps one big file from dominating).
function domainTokens(dir, list, idx) {
  const pathTokens = new Set(tokenize(dir.replace(/\//g, ' ')));
  const df = {};
  for (const f of list) {
    const tf = (idx.files[f.rel] && idx.files[f.rel].tf) || {};
    for (const t of Object.keys(tf)) {
      if (STOP.has(t) || GENERIC.has(t) || pathTokens.has(t)) continue;
      df[t] = (df[t] || 0) + 1;
    }
  }
  const threshold = Math.max(2, Math.ceil(list.length * 0.3));
  return Object.entries(df)
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
}

// per-directory purpose blurb, first confident source wins: on-disk docs,
// then a name-dictionary phrase (optionally extended with domain tokens),
// then domain tokens alone. Returns '' when nothing is confident enough —
// callers must omit the blurb segment entirely in that case.
function dirPurpose(dir, list, idx, cwd) {
  if (cwd) {
    const absDir = dir === '.' ? cwd : path.join(cwd, dir);
    const doc = docBlurb(absDir);
    if (doc) return doc;
  }
  const dict = dictPhrase(dir);
  const tokens = domainTokens(dir, list, idx);
  if (dict && tokens.length) return sanitizeBlurb(`${dict} for ${tokens.join(', ')}`);
  if (dict) return sanitizeBlurb(dict);
  if (tokens.length >= 2) return sanitizeBlurb(`mostly ${tokens.join(', ')} logic`);
  return '';
}

// compact repo map from the index (dirs by file count + top files by symbol
// density) — gives the agent instant orientation without exploring the tree
function repoMapFromIndex(idx, cwd) {
  const dirs = {};
  for (const rel of Object.keys(idx.files)) {
    const cut = rel.lastIndexOf('/');
    const dir = cut >= 0 ? rel.slice(0, cut) : '.';
    (dirs[dir] = dirs[dir] || []).push({ rel, syms: (idx.files[rel].symbols || []).length });
  }
  const entries = Object.entries(dirs)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 30);
  return entries.map(([dir, list]) => {
    const top = list.sort((a, b) => b.syms - a.syms).slice(0, 3)
      .map(f => f.rel.slice(f.rel.lastIndexOf('/') + 1)).join(', ');
    const purpose = dirPurpose(dir, list, idx, cwd);
    return `${dir}/ (${list.length} files)` +
      (purpose ? ' — ' + purpose : '') +
      (top ? ' — ' + top : '');
  }).join('\n');
}

function retrieve(idx, query, k) {
  const qterms = [...new Set(tokenize(query))];
  if (!qterms.length) return [];
  const rels = Object.keys(idx.files);
  const N = rels.length || 1;
  const df = {}; for (const t of qterms) df[t] = 0;
  for (const rel of rels) { const tf = idx.files[rel].tf; for (const t of qterms) if (tf[t]) df[t]++; }
  const k1 = 1.5, b = 0.75;
  const out = [];
  for (const rel of rels) {
    const f = idx.files[rel];
    let s = 0;
    for (const t of qterms) {
      const freq = f.tf[t]; if (!freq) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      s += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * f.len / idx.avgLen));
    }
    if (s > 0) out.push({ rel, score: +s.toFixed(2), symbols: f.symbols });
  }
  out.sort((a, b2) => b2.score - a.score);
  return out.slice(0, k || 8);
}

ipcMain.handle('symbol-build', async (_e, cwd) => {
  try { const idx = await buildSymbolIndexOnce(cwd); return { ok: true, files: Object.keys(idx.files).length }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// on import: use the cached map if .loveai has it, else build one. Returns
// whether it was already cached so the renderer can log accordingly.
ipcMain.handle('symbol-ensure', async (_e, cwd) => {
  try {
    const existed = !!readJson(path.join(indexDir(cwd), 'symbols.json'));
    const idx = await loadOrBuildIndex(cwd);
    return { ok: true, cached: existed, files: Object.keys(idx.files).length };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// watch the project for new/removed files and keep the map fresh (incrementally).
// Debounced; skips node_modules/.git/etc. One recursive watcher per repo.
ipcMain.handle('symbol-watch', async (_e, cwd) => {
  try {
    if (symbolWatchers[cwd]) return { ok: true, already: true };
    await loadOrBuildIndex(cwd);
    const state = { timer: null, pending: new Set() };
    const flush = async () => {
      const idx = symbolCache[cwd]; if (!idx) { state.pending.clear(); return; }
      const paths = [...state.pending]; state.pending.clear();
      let changed = 0;
      for (const abs of paths) {
        const rel = path.relative(cwd, abs).replace(/\\/g, '/');
        try {
          const st = await fs.promises.stat(abs);
          if (st.isFile()) { if (await indexOneFile(cwd, abs)) changed++; }
        } catch {                      // gone → remove from index
          if (idx.files[rel]) { delete idx.files[rel]; changed++; }
        }
      }
      if (changed) {
        recomputeAvgLen(idx);
        await persistIndex(cwd, idx);
        send('symbol-updated', { cwd, files: Object.keys(idx.files).length, changed });
      }
    };
    let watcher;
    try {
      watcher = fs.watch(cwd, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (rel.split('/').some((p) => p.startsWith('.') || INDEX_SKIP_DIRS.has(p))) return;
        const ext = path.extname(rel).slice(1).toLowerCase();
        if (ext && !INDEX_EXTS.has(ext)) return;   // ignore non-indexable file types
        state.pending.add(path.join(cwd, filename));
        clearTimeout(state.timer);
        state.timer = setTimeout(flush, 1500);     // debounce bursts (git checkout etc.)
      });
    } catch (e) {
      return { ok: false, error: 'watch unsupported here: ' + String(e && e.message ? e.message : e) };
    }
    symbolWatchers[cwd] = { watcher, state };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

app.on('before-quit', () => {
  for (const k of Object.keys(symbolWatchers)) { try { symbolWatchers[k].watcher.close(); } catch {} }
});

// ===== Open-file watcher — notify the renderer when a file it has OPEN in the
// editor changes on disk (e.g. an agent edits it). Distinct from the symbol
// watcher: no indexable-only filter, keyed to the exact set of open paths. =====
const openWatch = { watcher: null, root: null, files: new Set(), timer: null, pending: new Set() };

function stopOpenWatch() {
  if (openWatch.watcher) { try { openWatch.watcher.close(); } catch {} }
  openWatch.watcher = null; openWatch.root = null;
  clearTimeout(openWatch.timer); openWatch.pending.clear();
}

ipcMain.handle('watch-files', (_e, { root, files }) => {
  openWatch.files = new Set((files || []).map(f => path.resolve(f)));
  if (!root || !openWatch.files.size) { stopOpenWatch(); return { ok: true, watching: 0 }; }
  // (re)create the recursive watcher only when the root changes
  if (openWatch.root !== root) {
    stopOpenWatch();
    openWatch.root = root;
    try {
      openWatch.watcher = fs.watch(root, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const abs = path.resolve(root, filename);
        if (!openWatch.files.has(abs)) return;      // only files the editor has open
        openWatch.pending.add(abs);
        clearTimeout(openWatch.timer);
        openWatch.timer = setTimeout(() => {
          const hits = [...openWatch.pending]; openWatch.pending.clear();
          for (const p of hits) send('file-disk-change', { path: p });
        }, 300);
      });
    } catch (e) {
      return { ok: false, error: 'watch unsupported: ' + String(e && e.message || e) };
    }
  }
  return { ok: true, watching: openWatch.files.size };
});

// return the top-ranked files for an issue (builds the index lazily if missing).
// withContent = N → also read and attach the content of the top N files, so the
// agent gets the actual code up front and skips most Read round-trips.
ipcMain.handle('retrieve-context', async (_e, { cwd, query, k, withContent }) => {
  try {
    const idx = await loadOrBuildIndex(cwd);
    const files = retrieve(idx, query, k || 8);
    if (withContent > 0) {
      for (const f of files.slice(0, withContent)) {
        try {
          const abs = path.join(cwd, f.rel);
          const stat = await fs.promises.stat(abs);
          if (stat.size <= 80 * 1024) f.content = await fs.promises.readFile(abs, 'utf8');
        } catch {}
      }
    }
    return { ok: true, files, repoMap: repoMapFromIndex(idx, cwd) };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), files: [] }; }
});

// flat list of all project files (for Ctrl+P quick-open). Skips heavy dirs,
// capped so huge repos stay responsive. Returns relative POSIX paths.
ipcMain.handle('list-files', async (_e, root) => {
  const out = [];
  const CAP = 20000;
  async function walk(dir) {
    if (out.length >= CAP) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= CAP) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (INDEX_SKIP_DIRS.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        out.push(path.relative(root, abs).replace(/\\/g, '/'));
      }
    }
  }
  try { await walk(root); return { ok: true, files: out }; }
  catch (e) { return { ok: false, error: String(e && e.message || e), files: [] }; }
});

// ===== File explorer (read-only — browse and copy project code) =====
// every path is validated against the imported project root before any read
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

ipcMain.handle('fs-list', async (_e, { root, dir }) => {
  try {
    if (!root || !dir || !insideRoot(root, dir)) return { ok: false, error: 'outside the project root' };
    const items = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      items.push({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() });
    }
    // directories first, then files — each alphabetical, like VS Code
    items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    // flag gitignored entries so the explorer can render them distinctly. Safe
    // to ignore any failure here (not a git repo, git missing, etc.) — the
    // listing itself still works, just without the ignored decoration.
    if (items.length) {
      try {
        // -C dir (not root): git auto-discovers the nearest .git upward from
        // there, which still resolves correctly even when `root` itself is
        // just a parent folder (multi-repo workspace) rather than a repo —
        // and it correctly picks up nested .gitignore files per app folder
        // too (that's just how git resolves ignores, nothing extra needed).
        //
        // Pass bare NAMES (relative to -C dir), never the absolute Windows
        // path: a backslash is git's own quoting escape character, so an
        // absolute "C:\foo\bar" argument makes git echo it back wrapped in
        // quotes with every backslash doubled ("C:\\foo\\bar") — no amount
        // of slash/case normalization matches that against the original
        // path, so this silently flagged nothing before, every time.
        const r = await git(dir, ['check-ignore', '-v', '--no-index', ...items.map(i => i.name)]);
        const ignored = new Set();
        for (const line of (r.out || '').split('\n')) {
          const t = line.trim();
          if (!t || /^fatal:/i.test(t)) continue;
          // -v format: <source>:<line>:<pattern>\t<pathname> — name is after the last tab
          let p = t.includes('\t') ? t.split('\t').pop() : t;
          p = p.replace(/^"|"$/g, '');   // git may still quote a name with odd characters
          if (p) ignored.add(p);
        }
        for (const it of items) if (ignored.has(it.name)) it.ignored = true;
      } catch {}
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_HIGHLIGHT_BYTES = 400 * 1024;   // above this, highlighting costs more than it's worth

// shiki renders with VS Code's own TextMate grammars + the real dark-plus theme
let shiki;
const shikiReady = import('shiki')
  .then(m => { shiki = m; })
  .catch(e => console.error('shiki unavailable — viewer falls back to plain text:', e.message));

const LANG_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  json: 'json', jsonc: 'jsonc', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'md', markdown: 'md', mdx: 'mdx', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', dart: 'dart', vue: 'vue', svelte: 'svelte', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  env: 'dotenv', gitignore: 'ignore', dockerfile: 'docker'
};

function langFor(file) {
  const base = path.basename(file).toLowerCase();
  if (base === 'dockerfile') return 'docker';
  if (base === '.gitignore' || base === '.npmignore') return 'ignore';
  if (base.startsWith('.env')) return 'dotenv';
  return LANG_BY_EXT[path.extname(file).slice(1).toLowerCase()] || 'text';
}

const THEMES = { 'dark-plus': 1, 'light-plus': 1 };

async function highlight(code, lang, theme) {
  if (!shiki) return null;
  const t = THEMES[theme] ? theme : 'dark-plus';
  for (const l of [lang, 'text']) {
    try { return await shiki.codeToHtml(code, { lang: l, theme: t }); } catch {}
  }
  return null;
}

ipcMain.handle('fs-read', async (_e, { root, file, theme }) => {
  try {
    if (!root || !file || !insideRoot(root, file)) return { ok: false, error: 'outside the project root' };
    const stat = fs.statSync(file);
    if (stat.size > MAX_VIEW_BYTES) {
      return { ok: false, error: `file is ${(stat.size / 1048576).toFixed(1)} MB — too large to display (limit 2 MB)` };
    }
    const buf = fs.readFileSync(file);
    // NUL byte in the first 8 KB is the usual binary tell
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, error: 'binary file — cannot display' };
    const content = buf.toString('utf8');
    const lang = langFor(file);
    await shikiReady;
    const html = stat.size <= MAX_HIGHLIGHT_BYTES ? await highlight(content, lang, theme) : null;
    return { ok: true, content, html, lang, size: stat.size };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.apng': 'image/apng', '.tif': 'image/tiff', '.tiff': 'image/tiff'
};

// read an image as a data URL for Explorer's preview — unlike fs-read, this
// doesn't assume text and doesn't reject binary content
ipcMain.handle('fs-read-image', (_e, { root, file }) => {
  try {
    if (!root || !file || !insideRoot(root, file)) return { ok: false, error: 'outside the project root' };
    const stat = fs.statSync(file);
    if (stat.size > MAX_VIEW_BYTES) {
      return { ok: false, error: `image is ${(stat.size / 1048576).toFixed(1)} MB — too large to preview (limit 2 MB)` };
    }
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const b64 = fs.readFileSync(file).toString('base64');
    return { ok: true, dataUrl: `data:${mime};base64,${b64}`, size: stat.size };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('fs-write', (_e, { root, file, content }) => {
  try {
    if (!root || !file || !insideRoot(root, file)) return { ok: false, error: 'outside the project root' };
    if (!fs.existsSync(file)) return { ok: false, error: 'file no longer exists' };
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, size: Buffer.byteLength(content, 'utf8') };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// ===== Project knowledge memory — per-topic, retrievable, staleness-tracked =====
// Each topic lives in .loveai/memory/topics/<slug>.md and starts with a tiny
// header: "# <title>", "keywords: ...", "files: <exact paths this topic covers>".
// index.json stores a fingerprint (size:mtime) per covered file so we can tell a
// topic is STALE when its code changed — the PE then refreshes only those files.
function memParseTopic(md) {
  const idx = md.indexOf('\n\n');
  const head = idx >= 0 ? md.slice(0, idx) : md;
  const body = idx >= 0 ? md.slice(idx + 2).trim() : '';
  let title = '', keywords = '', files = [];
  for (const l of head.split(/\r?\n/)) {
    if (/^#\s+/.test(l) && !title) title = l.replace(/^#\s+/, '').trim();
    const mk = /^keywords:\s*(.*)$/i.exec(l); if (mk) keywords = mk[1].trim();
    const mf = /^files:\s*(.*)$/i.exec(l);
    if (mf) files = mf[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { title, keywords, files, body };
}
function memFileSig(cwd, rel) {
  try { const st = fs.statSync(path.join(cwd, rel)); return st.size + ':' + Math.round(st.mtimeMs); }
  catch { return 'missing'; }
}
function memReadIndex(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, '.loveai', 'memory', 'index.json'), 'utf8')) || {}; }
  catch { return {}; }
}

// list topics with their body + a staleness flag (which covered files changed)
ipcMain.handle('memory-list', (_e, { cwd }) => {
  try {
    if (!cwd) return { ok: false };
    const dir = path.join(cwd, '.loveai', 'memory', 'topics');
    if (!fs.existsSync(dir)) return { ok: true, topics: [] };
    const idx = memReadIndex(cwd);
    const topics = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const slug = f.replace(/\.md$/, '');
      const t = memParseTopic(fs.readFileSync(path.join(dir, f), 'utf8'));
      const stored = (idx[slug] && idx[slug].files) || {};
      const changed = t.files.filter(rel => memFileSig(cwd, rel) !== stored[rel]);
      topics.push({
        slug, title: t.title || slug, keywords: t.keywords, files: t.files,
        body: t.body, updated: (idx[slug] && idx[slug].updated) || null,
        stale: changed.length > 0, changed
      });
    }
    return { ok: true, topics };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// after the PE writes/updates topics, capture fingerprints of their covered
// files so future runs can detect staleness. Cheap; runs off the main path.
ipcMain.handle('memory-reindex', (_e, { cwd }) => {
  try {
    if (!cwd) return { ok: false };
    const dir = path.join(cwd, '.loveai', 'memory', 'topics');
    if (!fs.existsSync(dir)) return { ok: true, count: 0 };
    const prev = memReadIndex(cwd);
    const now = new Date().toISOString();
    const idx = {};
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const slug = f.replace(/\.md$/, '');
      const t = memParseTopic(fs.readFileSync(path.join(dir, f), 'utf8'));
      const files = {}; let changed = false;
      for (const rel of t.files) {
        const sig = memFileSig(cwd, rel);
        files[rel] = sig;
        if (!prev[slug] || !prev[slug].files || prev[slug].files[rel] !== sig) changed = true;
      }
      idx[slug] = { files, updated: (changed || !prev[slug]) ? now : prev[slug].updated };
    }
    fs.writeFileSync(path.join(cwd, '.loveai', 'memory', 'index.json'),
      JSON.stringify(idx, null, 2), 'utf8');
    return { ok: true, count: Object.keys(idx).length };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// create a new file or folder (VS Code-style). `rel` may include subfolders,
// e.g. "components/Button.tsx" — intermediate dirs are created.
ipcMain.handle('fs-create', (_e, { root, dir, rel, isDir }) => {
  try {
    if (!root || !dir || !insideRoot(root, dir)) return { ok: false, error: 'outside the project root' };
    const clean = String(rel || '').replace(/^[\\/]+|[\\/]+$/g, '').trim();
    if (!clean) return { ok: false, error: 'name required' };
    const target = path.join(dir, clean);
    if (!insideRoot(root, target)) return { ok: false, error: 'outside the project root' };
    if (fs.existsSync(target)) return { ok: false, error: 'already exists' };
    if (isDir) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '', 'utf8');
    }
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// rename / move (drag or F2)
ipcMain.handle('fs-rename', (_e, { root, from, to }) => {
  try {
    if (!root || !insideRoot(root, from) || !insideRoot(root, to)) return { ok: false, error: 'outside the project root' };
    if (!fs.existsSync(from)) return { ok: false, error: 'source no longer exists' };
    if (fs.existsSync(to)) return { ok: false, error: 'target already exists' };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true, path: to };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// delete a file or folder (recursive)
ipcMain.handle('fs-delete', (_e, { root, target }) => {
  try {
    if (!root || !insideRoot(root, target) || target === root) return { ok: false, error: 'not allowed' };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// copy a file or folder (recursive) — used by Explorer's Copy/Paste and Duplicate
ipcMain.handle('fs-copy', (_e, { root, from, to }) => {
  try {
    if (!root || !insideRoot(root, from) || !insideRoot(root, to)) return { ok: false, error: 'outside the project root' };
    if (!fs.existsSync(from)) return { ok: false, error: 'source no longer exists' };
    if (fs.existsSync(to)) return { ok: false, error: 'target already exists' };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    return { ok: true, path: to };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// import a file/folder dragged in from outside the app (OS file drag) — like
// fs-copy but `from` is expected to live outside the project root
ipcMain.handle('fs-import', (_e, { root, from, to }) => {
  try {
    if (!root || !insideRoot(root, to)) return { ok: false, error: 'outside the project root' };
    if (!from || !fs.existsSync(from)) return { ok: false, error: 'source no longer exists' };
    if (fs.existsSync(to)) return { ok: false, error: 'target already exists' };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    return { ok: true, path: to };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// re-highlight on demand as the user edits
ipcMain.handle('fs-highlight', async (_e, { content, lang, theme }) => {
  await shikiReady;
  if (content.length > MAX_HIGHLIGHT_BYTES) return { ok: false };
  const html = await highlight(content, lang || 'text', theme);
  return { ok: !!html, html };
});

// ===== Settings — MCP servers + skills from the same config Claude Code uses =====
const HOME = process.env.USERPROFILE || process.env.HOME || '';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

ipcMain.handle('mcp-list', (_e, projectDir) => {
  const servers = [];
  const push = (obj, scope) => {
    for (const [name, cfg] of Object.entries(obj || {})) {
      servers.push({
        name, scope,
        transport: cfg.type || (cfg.url ? 'http' : 'stdio'),
        target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ')
      });
    }
  };
  const global = readJson(path.join(HOME, '.claude.json'));
  push(global && global.mcpServers, 'user');
  if (projectDir) {
    const proj = global && global.projects && global.projects[projectDir];
    push(proj && proj.mcpServers, 'project (local)');
    const mcpJson = readJson(path.join(projectDir, '.mcp.json'));
    push(mcpJson && mcpJson.mcpServers, 'project (.mcp.json)');
  }
  return servers;
});

function scanSkills(dir, scope) {
  const out = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const fp = path.join(dir, d.name, 'SKILL.md');
      if (!fs.existsSync(fp)) continue;
      const txt = fs.readFileSync(fp, 'utf8');
      const desc = /^description:\s*(.+)$/m.exec(txt);
      out.push({ name: d.name, scope, path: fp, description: desc ? desc[1].trim().slice(0, 200) : '(no description)' });
    }
  } catch {}
  return out;
}

ipcMain.handle('skills-list', (_e, projectDir) => {
  const skills = scanSkills(path.join(HOME, '.claude', 'skills'), 'user');
  if (projectDir) skills.push(...scanSkills(path.join(projectDir, '.claude', 'skills'), 'project'));
  return skills;
});

// custom slash commands (~/.claude/commands/*.md), like the CLI's / menu
ipcMain.handle('commands-list', (_e, projectDir) => {
  const out = [];
  const scan = (dir, scope) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        const d = /^description:\s*(.+)$/m.exec(txt);
        const firstLine = txt.split('\n').find(l => l.trim() && !l.startsWith('---') && !/^\w+:/.test(l)) || '';
        out.push({
          name: f.slice(0, -3), scope, path: path.join(dir, f),
          description: (d ? d[1].trim() : firstLine.replace(/^#+\s*/, '')).slice(0, 200)
        });
      }
    } catch {}
  };
  scan(path.join(HOME, '.claude', 'commands'), 'user');
  if (projectDir) scan(path.join(projectDir, '.claude', 'commands'), 'project');
  return out;
});

ipcMain.handle('skill-read', (_e, fp) => {
  try {
    // only ever serve SKILL.md files from a .claude/skills folder
    if (!/[\\/]\.claude[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(fp)) return { ok: false, error: 'not a skill file' };
    return { ok: true, content: fs.readFileSync(fp, 'utf8') };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('skill-create', (_e, { name, description, instructions }) => {
  try {
    const slug = String(name || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slug) return { ok: false, error: 'a skill needs a name' };
    const dir = path.join(HOME, '.claude', 'skills', slug);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return { ok: false, error: `skill "${slug}" already exists` };
    fs.mkdirSync(dir, { recursive: true });
    const md = `---\nname: ${slug}\ndescription: ${String(description || '').replace(/\n/g, ' ').trim()}\n---\n\n# ${slug}\n\n${String(instructions || '').trim()}\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
    return { ok: true, slug, path: path.join(dir, 'SKILL.md') };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('skill-save', (_e, { fp, content }) => {
  try {
    // same shape rule as skill-read: only SKILL.md inside a .claude/skills folder
    if (!/[\\/]\.claude[\\/]skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(fp)) return { ok: false, error: 'not a skill file' };
    if (!fs.existsSync(fp)) return { ok: false, error: 'skill no longer exists' };
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('skill-delete', (_e, fp) => {
  try {
    // same shape check as skill-read, and only within the user's own skills dir
    if (!fp.startsWith(path.join(HOME, '.claude', 'skills') + path.sep) || !fp.endsWith('SKILL.md')) {
      return { ok: false, error: 'only user skills can be removed here' };
    }
    fs.rmSync(path.dirname(fp), { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('cli-version', () => {
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { shell: true, timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
});

// ===== Session history — reads Claude Code's own session store (~/.claude/projects) =====
ipcMain.handle('sessions-list', () => {
  const out = [];
  try {
    const base = path.join(process.env.USERPROFILE || '', '.claude', 'projects');
    for (const dir of fs.readdirSync(base)) {
      let files;
      try { files = fs.readdirSync(path.join(base, dir)).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(base, dir, f);
        try {
          const stat = fs.statSync(fp);
          out.push({
            id: f.replace('.jsonl', ''),
            project: dir.split('-').filter(Boolean).pop() || dir,
            projectDir: dir,
            mtime: stat.mtimeMs,
            file: fp
          });
        } catch {}
      }
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  const top = out.slice(0, 40);
  for (const s of top) {
    try {
      const fd = fs.openSync(s.file, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, 65536, 0);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.type === 'summary' && j.summary) { s.snippet = String(j.summary).slice(0, 140); break; }
          if (j.type === 'user' && j.message && j.message.content) {
            const c = j.message.content;
            const text = typeof c === 'string' ? c : ((c.find(x => x.type === 'text') || {}).text || '');
            if (text) { s.snippet = text.slice(0, 140); break; }
          }
          if (j.cwd && !s.cwd) s.cwd = j.cwd;
        } catch {}
      }
    } catch {}
    delete s.file;
  }
  return top;
});

// full transcript of one stored session — used when the operator resumes it
ipcMain.handle('session-load', (_e, sessionId) => {
  const msgs = [];
  try {
    if (!/^[\w-]+$/.test(String(sessionId))) return msgs;
    const base = path.join(process.env.USERPROFILE || '', '.claude', 'projects');
    let file = null;
    for (const dir of fs.readdirSync(base)) {
      const fp = path.join(base, dir, sessionId + '.jsonl');
      if (fs.existsSync(fp)) { file = fp; break; }
    }
    if (!file) return msgs;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j.message || !j.message.content) continue;
      const content = j.message.content;
      if (j.type === 'user') {
        const text = typeof content === 'string'
          ? content
          : content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text.trim()) msgs.push({ role: 'user', text: text.slice(0, 2000) });
      } else if (j.type === 'assistant' && Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text' && c.text.trim()) msgs.push({ role: 'assistant', text: c.text.slice(0, 2000) });
          else if (c.type === 'tool_use') msgs.push({ role: 'tool', text: c.name + ' ' + JSON.stringify(c.input || {}).slice(0, 120) });
        }
      }
    }
  } catch {}
  // a long session would flood the console — keep the most recent exchanges
  return msgs.slice(-80);
});

// ===== Git integration (VS Code-style source control) =====
// Every app-issued git command for a repo runs through a per-repo queue, so the
// app can never race itself into "Unable to create .git/index.lock". Locks held
// by OTHER processes (an agent's shell, an editor, a crashed git) are handled
// by retrying with backoff and removing a lock that's provably stale.
const gitQueues = new Map();   // repo -> tail of that repo's command chain
const GIT_LOCK_RE = /index\.lock['"]?: File exists|Another git process seems to be running/i;

function enqueueGit(repo, fn) {
  const key = String(repo || '');
  const tail = gitQueues.get(key) || Promise.resolve();
  const p = tail.then(fn, fn);
  gitQueues.set(key, p.then(() => {}, () => {}));
  return p;
}

// a lock untouched for 15s while git already errored on it = crashed leftover
function clearStaleGitLock(repo) {
  try {
    const lock = path.join(repo, '.git', 'index.lock');
    if (Date.now() - fs.statSync(lock).mtimeMs > 15000) {
      fs.unlinkSync(lock);
      return true;
    }
  } catch {}
  return false;
}

function gitExec(repo, args) {
  return new Promise((resolve) => {
    // 90s: commit/push can run pre-commit hooks (lint, tests) that exceed 30s.
    // GIT_TERMINAL_PROMPT=0 + core.editor=true: any auth or editor prompt fails
    // fast with a readable error instead of hanging the panel forever.
    execFile('git', ['-c', 'core.editor=true', '-C', repo, ...args], {
      timeout: 90000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    }, (err, stdout, stderr) => {
      const out = (String(stdout || '') + String(stderr || '')).trim();
      resolve({ ok: !err, out: out || (err && err.killed ? 'timed out after 90s (interactive prompt or slow hook?)' : out) });
    });
  });
}

async function gitWithLockRetry(repo, args) {
  let r = await gitExec(repo, args);
  for (let i = 0; i < 3 && !r.ok && GIT_LOCK_RE.test(r.out); i++) {
    if (!clearStaleGitLock(repo)) {
      // someone is genuinely mid-operation — give them a moment to finish
      await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
    r = await gitExec(repo, args);
  }
  if (!r.ok && GIT_LOCK_RE.test(r.out)) {
    r.out += '\n\n(LoveAi retried 3× — the repo stayed locked by another git ' +
      'process. Close other git tools, or delete .git/index.lock if nothing is running.)';
  }
  return r;
}

function git(repo, args) {
  return enqueueGit(repo, () => gitWithLockRetry(repo, args));
}

// detect repo(s): the folder itself, or first-level subfolders (multi-repo workspaces).
// a .git folder alone isn't proof (can be empty/leftover) — validate with git itself.
ipcMain.handle('git-repos', async (_e, root) => {
  const candidates = [];
  try {
    if (!root) return [];
    if (fs.existsSync(path.join(root, '.git'))) candidates.push(root);
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.') &&
          fs.existsSync(path.join(root, d.name, '.git'))) {
        candidates.push(path.join(root, d.name));
      }
    }
  } catch {}
  const repos = [];
  for (const c of candidates) {
    const r = await git(c, ['rev-parse', '--is-inside-work-tree']);
    if (r.ok && /true/.test(r.out)) repos.push(c);
  }
  return repos;
});

ipcMain.handle('git-status', async (_e, repo) => {
  // -uall: list every untracked file individually (not collapsed dirs) — matches VS Code's count
  const r = await git(repo, ['status', '--porcelain=v1', '-b', '-uall']);
  if (!r.ok) return { ok: false, error: r.out };
  let branch = '', upstream = '', ahead = 0, behind = 0;
  const staged = [], unstaged = [], untracked = [], conflicts = [];
  // porcelain conflict codes: both sides touched the path during a merge
  const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (const l of r.out.split('\n')) {
    if (!l) continue;
    if (l.startsWith('##')) {
      // e.g. "## main...origin/main [ahead 1, behind 2]"
      const bl = l.slice(3);
      branch = (bl.split('...')[0] || bl).split(' ')[0];
      const up = /\.\.\.(\S+)/.exec(bl); if (up) upstream = up[1];
      const a = /ahead (\d+)/.exec(bl); if (a) ahead = +a[1];
      const b = /behind (\d+)/.exec(bl); if (b) behind = +b[1];
      continue;
    }
    const x = l[0], y = l[1], f = l.slice(3);
    if (x === '?' && y === '?') { untracked.push(f); continue; }
    if (CONFLICT.has(x + y)) { conflicts.push(f); continue; }   // not stage-able until resolved
    if (x !== ' ') staged.push({ s: x, f });
    if (y !== ' ') unstaged.push({ s: y, f });
  }
  return { ok: true, branch, upstream, ahead, behind, staged, unstaged, untracked, conflicts };
});

function gitArgs(op, arg) {
  const ops = {
    stage: arg === '*' ? ['add', '-A'] : ['add', '--', arg],
    unstage: arg === '*' ? ['reset'] : ['reset', '--', arg],
    commit: ['commit', '-m', arg || 'update'],
    amend: arg ? ['commit', '--amend', '-m', arg] : ['commit', '--amend', '--no-edit'],
    // arg: an array of extra flags picked from the push-flags menu (e.g.
    // ['--force-with-lease', '--no-verify']), or undefined for a plain push
    push: ['push', ...(Array.isArray(arg) ? arg : [])],
    // first push of a new branch needs an upstream; arg = branch name string,
    // or { branch, flags } to carry the same push-flags selection through
    // this auto-upstream fallback
    publish: ['push', '-u', 'origin',
      (arg && typeof arg === 'object') ? (arg.branch || 'HEAD') : (arg || 'HEAD'),
      ...((arg && typeof arg === 'object' && Array.isArray(arg.flags)) ? arg.flags : [])
    ],
    pull: ['pull'],
    'pull-rebase': ['pull', '--rebase'],
    // rebase conflict strategy is inverted from merge's: "ours" during a
    // rebase means the branch being rebased ONTO (the incoming/remote side),
    // "theirs" means the commits being replayed (the local side). -X ours
    // here is what actually makes the incoming/remote content win.
    'pull-rebase-incoming': ['pull', '--rebase', '-X', 'ours'],
    fetch: ['fetch', '--all', '--prune'],
    // branches
    checkout: ['checkout', arg],
    // arg: 'name' or [name, startPoint] — create from a chosen base branch
    'create-branch': Array.isArray(arg) ? ['checkout', '-b', ...arg] : ['checkout', '-b', arg],
    'delete-branch': ['branch', '-D', arg],
    merge: ['merge', '--no-edit', arg],
    'merge-abort': ['merge', '--abort'],
    'rebase-abort': ['rebase', '--abort'],
    // conflict resolution: staging a conflicted file marks it resolved
    resolve: ['add', '--', arg],
    // working tree
    discard: ['checkout', '--', arg],          // revert a tracked file to HEAD
    clean: ['clean', '-fd', '--', arg],        // remove an untracked file/dir
    stash: ['stash', 'push', '-u'],
    'stash-pop': ['stash', 'pop']
  };
  return ops[op] || null;
}
const NET_OPS = new Set(['pull', 'pull-rebase', 'pull-rebase-incoming', 'push', 'publish', 'fetch']);
const NET_ERR = /could not resolve hostname|connection timed out|could not read from remote|unable to access|early eof|connection reset/i;

ipcMain.handle('git-cmd', async (_e, { repo, op, arg }) => {
  const args = gitArgs(op, arg);
  if (!args) return { ok: false, out: 'unknown git op' };
  let r = await git(repo, args);
  if (!r.ok && NET_OPS.has(op) && NET_ERR.test(r.out)) {
    await new Promise(res => setTimeout(res, 2000));
    const retry = await git(repo, args);
    if (retry.ok) retry.out += '\n(recovered after a transient network error)';
    else retry.out += '\n(failed twice — check your network/VPN; github.com is unreachable)';
    r = retry;
  }
  return r;
});

// streaming git: runs the op and pushes stdout/stderr live via 'git-stream-data'
// events (streamId), so hook/test output shows in the modal as it happens.
ipcMain.handle('git-stream', (_e, { repo, op, arg, streamId }) => {
  const args = gitArgs(op, arg);
  if (!args) return Promise.resolve({ ok: false, out: 'unknown git op' });
  // same per-repo queue as git() — a streamed commit/push can't race a status
  // poll (or another command) into an index.lock collision
  return enqueueGit(repo, () => new Promise((resolve) => {
    let out = '';
    const p = spawn('git', ['-c', 'core.editor=true', '-C', repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    });
    const onData = (d) => { const s = d.toString(); out += s; send('git-stream-data', { streamId, data: s }); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { const s = String(e && e.message ? e.message : e); out += s; send('git-stream-data', { streamId, data: s + '\n' }); });
    const to = setTimeout(() => { try { p.kill(); } catch {} send('git-stream-data', { streamId, data: '\n[timed out after 180s]\n' }); }, 180000);
    p.on('close', (code) => { clearTimeout(to); resolve({ ok: code === 0, out: out.trim(), code }); });
  }));
});

// list local + remote branches, marking the current one. Each ref also carries
// its tip commit (short hash, relative date, subject) for VS Code-style pickers.
ipcMain.handle('git-branches', async (_e, repo) => {
  const SEP = '\x1f';
  // NOTE: %(refname:short) strips remotes/ (origin/x), so local-vs-remote must
  // be decided from the FULL %(refname) (refs/heads/ vs refs/remotes/)
  const fmt = ['%(HEAD)', '%(refname)', '%(refname:short)', '%(upstream:short)',
    '%(objectname:short)', '%(committerdate:relative)', '%(subject)'].join(SEP);
  const r = await git(repo, ['branch', '-a', `--format=${fmt}`]);
  if (!r.ok) return { ok: false, error: r.out };
  const local = [], remote = [], remoteInfo = [];
  let current = '';
  for (const l of r.out.split('\n')) {
    if (!l.trim()) continue;
    const [head, ref, name, upstream, hash, date, subject] = l.split(SEP);
    if (!name) continue;
    if ((ref || '').startsWith('refs/remotes/')) {
      remote.push(name);    // kept as strings — existing consumers rely on it
      remoteInfo.push({ name, hash: hash || '', date: date || '', subject: subject || '' });
      continue;
    }
    if (head === '*') current = name;
    local.push({ name, upstream: upstream || '', current: head === '*',
      hash: hash || '', date: date || '', subject: subject || '' });
  }
  return { ok: true, current, local, remote, remoteInfo };
});

// recent commit history (compact, machine-parseable)
ipcMain.handle('git-log', async (_e, { repo, limit }) => {
  const fmt = '%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D';
  const r = await git(repo, ['log', `-n${Math.min(limit || 40, 200)}`, `--pretty=format:${fmt}`]);
  if (!r.ok) return { ok: false, error: r.out };
  const commits = r.out.split('\n').filter(Boolean).map(l => {
    const [hash, short, author, date, subject, refs] = l.split('\x1f');
    return { hash, short, author, date, subject, refs: refs || '' };
  });
  return { ok: true, commits };
});

// diff for one file (working tree vs index/HEAD), a single whole commit, or a
// revision range (e.g. "base...HEAD" for "everything this branch adds over base").
// `commit` and `range` are deliberately separate: `commit` always gets `^!`
// appended (git's "just this one commit" shorthand) — correct for a single
// hash, but nonsense appended to an already-a-range string like "qa...HEAD".
ipcMain.handle('git-diff', async (_e, { repo, file, staged, commit, range }) => {
  const args = ['diff', '--no-color'];
  if (range) args.push(range);
  else if (commit) args.push(commit + '^!');
  else if (staged) args.push('--staged');
  // exactly one trailing "--", never two — a second "--" is itself parsed as
  // a literal pathspec and silently breaks any file filter that follows it
  args.push('--');
  if (file) args.push(file);
  const r = await git(repo, args);
  return { ok: r.ok, diff: r.out };
});

// ============================================================
// CHECKPOINTS — snapshot a repo the instant a task starts, then let the
// user revert exactly the files that task touched back to that snapshot.
// Everything here goes through git() so it inherits the same per-repo
// queueing + stale-lock retry as the rest of source control.
// ============================================================

// resolve the true repo root for any cwd (handles monorepo subfolders)
ipcMain.handle('git-repo-root', async (_e, cwd) => {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? { ok: true, repo: r.out.trim() } : { ok: false, error: r.out };
});

// snapshot the current index+worktree without touching HEAD/branch/stage.
// `stash create` returns nothing when the tree is already clean — fall back
// to HEAD so a checkpoint always resolves to a valid ref. Also records the
// untracked files that already exist at this instant, so a later diff can
// tell "task created this file" apart from "this junk was already there."
ipcMain.handle('checkpoint-create', async (_e, repo) => {
  const s = await git(repo, ['stash', 'create']);
  let ref = s.ok ? s.out.trim() : '';
  if (!ref) {
    const h = await git(repo, ['rev-parse', 'HEAD']);
    ref = h.ok ? h.out.trim() : '';
  }
  const u = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  const untracked = u.ok ? u.out.split('\n').filter(Boolean) : [];
  return { ok: !!ref, ref, untracked };
});

// which files actually changed since the checkpoint — computed from git
// itself (not from watching individual tool calls), so it catches edits
// made ANY way: Edit/Write/MultiEdit, Bash (rm/mv/sed/redirects), whatever.
// - tracked files: `git diff --name-only <ref>` catches any content change
//   or deletion to a file that existed at the checkpoint, regardless of tool.
// - untracked files: anything untracked now that wasn't in the checkpoint's
//   untracked baseline is new-since-checkpoint.
ipcMain.handle('checkpoint-touched', async (_e, { repo, ref, baselineUntracked }) => {
  const d = await git(repo, ['diff', '--name-only', ref]);
  const trackedChanged = d.ok ? d.out.split('\n').filter(Boolean) : [];
  const u = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  const curUntracked = u.ok ? u.out.split('\n').filter(Boolean) : [];
  const baseSet = new Set(baselineUntracked || []);
  const newUntracked = curUntracked.filter(f => !baseSet.has(f));
  return { ok: true, files: [...new Set([...trackedChanged, ...newUntracked])] };
});

// diff one touched file against its checkpoint snapshot (panel preview)
ipcMain.handle('checkpoint-diff', async (_e, { repo, ref, file }) => {
  const r = await git(repo, ['diff', '--no-color', ref, '--', file]);
  return { ok: r.ok, diff: r.out };
});

// revert touched files to their exact checkpoint content. A file missing
// from the snapshot was created by the task itself — delete it; one present
// gets its pre-task bytes restored via checkout.
ipcMain.handle('checkpoint-revert', async (_e, { repo, ref, files }) => {
  const results = [];
  for (const f of files || []) {
    const exists = await git(repo, ['cat-file', '-e', `${ref}:${f}`]);
    if (exists.ok) {
      const co = await git(repo, ['checkout', ref, '--', f]);
      results.push({ file: f, ok: co.ok, action: 'restored', out: co.out });
    } else {
      try {
        fs.unlinkSync(path.join(repo, f));
        results.push({ file: f, ok: true, action: 'deleted' });
      } catch (e) {
        results.push({ file: f, ok: false, action: 'delete-failed', out: String(e && e.message ? e.message : e) });
      }
    }
  }
  return { ok: results.every(r => r.ok), results };
});

// checkpoint history, kept per-repo under .loveai/ (already gitignored)
function checkpointsPath(repo) { return path.join(repo, '.loveai', 'checkpoints.json'); }

ipcMain.handle('checkpoints-load', (_e, repo) => {
  try {
    const p = checkpointsPath(repo);
    return { ok: true, list: fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [] };
  } catch (e) {
    return { ok: false, list: [], error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('checkpoints-save', (_e, { repo, list }) => {
  try {
    const dir = path.join(repo, '.loveai');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(checkpointsPath(repo), JSON.stringify((list || []).slice(-30), null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// remotes: name -> url
// keep .loveai/ out of version control in every project: add it to .gitignore
// and untrack it if an earlier commit already captured it. Safe to call repeatedly.
ipcMain.handle('git-ignore-loveai', async (_e, repo) => {
  try {
    ensureGitignore(repo);   // appends ".loveai/" to .gitignore if missing
    // is anything under .loveai currently tracked?
    const tracked = await git(repo, ['ls-files', '--error-unmatch', '.loveai']);
    let untracked = false;
    if (tracked.ok) {
      // stop tracking it (leaves the files on disk), so it drops out of Changes
      await git(repo, ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '.loveai']);
      untracked = true;
    }
    return { ok: true, untracked };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('git-remotes', async (_e, repo) => {
  const r = await git(repo, ['remote', '-v']);
  if (!r.ok) return { ok: false, error: r.out };
  const seen = {}, list = [];
  for (const l of r.out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)/.exec(l);
    if (m && !seen[m[1]]) { seen[m[1]] = 1; list.push({ name: m[1], url: m[2] }); }
  }
  return { ok: true, remotes: list };
});

ipcMain.handle('git-remote-cmd', async (_e, { repo, op, name, url }) => {
  const ops = {
    add: ['remote', 'add', name, url],
    'set-url': ['remote', 'set-url', name, url],
    remove: ['remote', 'remove', name]
  };
  if (!ops[op]) return { ok: false, out: 'unknown remote op' };
  return git(repo, ops[op]);
});

// ===== GitHub Actions CI =====
// owner/repo from any GitHub remote URL (ssh, https, or a Host alias like github-lamji)
function ghRepoFromUrl(url) {
  const m = /github[^:/]*[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

const WORKFLOW_CI = `name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Syntax check
        run: |
          node --check main.js
          node --check preload.js
          node --check renderer/app.js
`;

ipcMain.handle('ci-list', (_e, repo) => {
  try {
    const dir = path.join(repo, '.github', 'workflows');
    const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f));
    return { ok: true, files };
  } catch { return { ok: true, files: [] }; }
});

ipcMain.handle('ci-scaffold', (_e, repo) => {
  try {
    const dir = path.join(repo, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ci.yml');
    if (fs.existsSync(file)) return { ok: false, error: '.github/workflows/ci.yml already exists' };
    fs.writeFileSync(file, WORKFLOW_CI, 'utf8');
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// ===== Pull requests (via gh CLI) =====
// run gh with a fully-quoted command line so titles/bodies with spaces survive
function ghRun(repo, args) {
  const line = 'gh ' + args.map(a => {
    const s = String(a);
    return /[\s"']/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
  }).join(' ');
  return new Promise((resolve) => {
    execFile(line, { cwd: repo, shell: true, timeout: 45000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}
function ghErr(r) {
  const s = (r.err || r.out || '').trim();
  if (/not recognized|not found|command not found|no such file/i.test(s)) return 'gh CLI not installed';
  if (/gh auth login|authentication|not logged/i.test(s)) return 'gh not authenticated — run "gh auth login"';
  return s || 'gh command failed';
}
// a body may contain newlines/quotes — hand it to gh via a temp --body-file
function bodyFile(text) {
  const p = path.join(os.tmpdir(), `loveai-pr-${Date.now()}.md`);
  fs.writeFileSync(p, String(text || ''), 'utf8');
  return p;
}

ipcMain.handle('pr-list', async (_e, repo) => {
  const r = await ghRun(repo, ['pr', 'list', '--limit', '30', '--json',
    'number,title,headRefName,baseRefName,state,url,isDraft,reviewDecision,mergeable']);
  if (!r.ok) return { ok: false, error: ghErr(r) };
  try { return { ok: true, prs: JSON.parse(r.out || '[]') }; }
  catch { return { ok: false, error: 'could not parse gh output' }; }
});

ipcMain.handle('pr-create', async (_e, { repo, title, body, base, head }) => {
  const args = ['pr', 'create', '--title', title || 'update'];
  const bf = bodyFile(body);
  args.push('--body-file', bf);
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);   // PR from a chosen branch, not just current
  const r = await ghRun(repo, args);
  try { fs.unlinkSync(bf); } catch {}
  return { ok: r.ok, out: (r.out + r.err).trim(), error: r.ok ? null : ghErr(r) };
});

ipcMain.handle('pr-review', async (_e, { repo, number, action, body }) => {
  const flag = { approve: '--approve', request: '--request-changes', comment: '--comment' }[action] || '--comment';
  const args = ['pr', 'review', String(number), flag];
  let bf = null;
  if (body) { bf = bodyFile(body); args.push('--body-file', bf); }
  const r = await ghRun(repo, args);
  if (bf) try { fs.unlinkSync(bf); } catch {}
  return { ok: r.ok, out: (r.out + r.err).trim(), error: r.ok ? null : ghErr(r) };
});

// Would a PR from head→base conflict? Non-destructive check via merge-tree.
ipcMain.handle('pr-conflict-check', async (_e, { repo, base, head }) => {
  await git(repo, ['fetch', 'origin', base, head]);
  // git 2.38+: `merge-tree --write-tree` exits non-zero on conflict and prints
  // "CONFLICT" lines / conflicted paths after the tree oid
  const r = await git(repo, ['merge-tree', '--write-tree', `origin/${base}`, `origin/${head}`]);
  if (r.ok) return { ok: true, conflict: false, files: [] };
  const files = [...new Set((r.out.match(/CONFLICT[^\n]*?in (\S+)/g) || []).map(l => l.replace(/.*in /, '').trim()))];
  return { ok: true, conflict: true, files };
});

// Start resolving: checkout head, merge base in → leaves conflict markers in the
// working tree so the resolver (and commit/push) can finish it.
ipcMain.handle('pr-start-merge', async (_e, { repo, base, head }) => {
  const dirty = await git(repo, ['status', '--porcelain']);
  if (dirty.ok && dirty.out.trim()) return { ok: false, error: 'Working tree not clean — commit or stash your changes first.' };
  await git(repo, ['fetch', 'origin', base, head]);
  const co = await git(repo, ['checkout', head]);
  if (!co.ok) return { ok: false, error: 'checkout ' + head + ' failed: ' + co.out };
  const m = await git(repo, ['merge', '--no-ff', '--no-edit', `origin/${base}`]);
  if (m.ok) return { ok: true, conflict: false, out: m.out };   // merged clean
  const st = await git(repo, ['diff', '--name-only', '--diff-filter=U']);
  const files = st.ok ? st.out.split('\n').filter(Boolean) : [];
  return { ok: true, conflict: true, files, merging: true };
});
ipcMain.handle('pr-abort-merge', (_e, repo) => git(repo, ['merge', '--abort']));

ipcMain.handle('pr-diff', async (_e, { repo, number, base, head }) => {
  // Prefer a LOCAL git diff (base...head) — no GitHub API, so it survives 503s.
  if (base && head) {
    const local = await git(repo, ['diff', '--no-color', `origin/${base}...origin/${head}`]);
    if (local.ok && local.out.trim()) return { ok: true, diff: local.out };
    // refs might be stale — fetch once, then retry the local diff
    await git(repo, ['fetch', 'origin', base, head]);
    const retry = await git(repo, ['diff', '--no-color', `origin/${base}...origin/${head}`]);
    if (retry.ok && retry.out.trim()) return { ok: true, diff: retry.out };
  }
  // fall back to the API via gh
  const r = await ghRun(repo, ['pr', 'diff', String(number)]);
  if (r.ok) return { ok: true, diff: r.out };
  const e = ghErr(r);
  return { ok: false, diff: '', error: /HTTP 5\d\d|service unavailable/i.test(r.err + r.out) ? 'GitHub API is down (503) — and the local branches for this PR aren’t fetched. Fetch, then retry.' : e };
});

// body + threaded comments + review summaries for one PR
ipcMain.handle('pr-view', async (_e, { repo, number }) => {
  const r = await ghRun(repo, ['pr', 'view', String(number), '--json',
    'number,title,body,comments,reviews,url,headRefName,baseRefName,reviewDecision']);
  if (!r.ok) return { ok: false, error: ghErr(r) };
  try { return { ok: true, pr: JSON.parse(r.out || '{}') }; }
  catch { return { ok: false, error: 'could not parse gh output' }; }
});

ipcMain.handle('pr-comment', async (_e, { repo, number, body }) => {
  const bf = bodyFile(body);
  const r = await ghRun(repo, ['pr', 'comment', String(number), '--body-file', bf]);
  try { fs.unlinkSync(bf); } catch {}
  return { ok: r.ok, out: (r.out + r.err).trim(), error: r.ok ? null : ghErr(r) };
});

ipcMain.handle('pr-merge', async (_e, { repo, number, method }) => {
  const flag = { squash: '--squash', merge: '--merge', rebase: '--rebase' }[method] || '--squash';
  const r = await ghRun(repo, ['pr', 'merge', String(number), flag, '--delete-branch']);
  return { ok: r.ok, out: (r.out + r.err).trim(), error: r.ok ? null : ghErr(r) };
});

// latest workflow runs via the gh CLI (it carries its own auth — no PAT to manage)
ipcMain.handle('ci-status', (_e, repo) => {
  return new Promise((resolve) => {
    execFile('gh', ['run', 'list', '--limit', '10', '--json',
      'displayTitle,status,conclusion,headBranch,workflowName,createdAt,url'],
      { cwd: repo, shell: true, timeout: 20000 }, (err, stdout, stderr) => {
        if (err) {
          const s = String(stderr || err.message || '');
          const missing = /not recognized|not found|command not found|no such file/i.test(s);
          const noauth = /gh auth login|authentication|not logged/i.test(s);
          // 5xx / timeouts are GitHub's side, not ours — say so plainly
          const gh5xx = /HTTP 5\d\d|service unavailable|bad gateway|gateway time-?out/i.test(s);
          return resolve({
            ok: false,
            transient: gh5xx,
            error: missing ? 'gh CLI not installed'
              : noauth ? 'gh not authenticated — run "gh auth login"'
              : gh5xx ? "GitHub is having a moment (server error) — this is on GitHub's side, not the app. Retry shortly."
              : (s.trim() || 'gh run list failed')
          });
        }
        try { resolve({ ok: true, runs: JSON.parse(stdout || '[]') }); }
        catch { resolve({ ok: false, error: 'could not parse gh output' }); }
      });
  });
});

// ===== Inline terminal (real PTY — full interactive CLI) =====
let nodePty = null;
try { nodePty = require('@lydell/node-pty'); } catch (e) { console.error('node-pty unavailable:', e.message); }
const terms = new Map();

ipcMain.handle('term-start', (_e, { termId, cwd, cols, rows, shell }) => {
  if (terms.has(termId)) return { ok: true, running: true };
  if (!nodePty) return { ok: false, error: 'PTY module not available' };
  // shell: 'bash' (default, falls back to powershell if git-bash is missing) or 'powershell'
  const bash = shell === 'powershell' ? null : [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
  ].find(p => p && fs.existsSync(p));
  const p = nodePty.spawn(bash || 'powershell.exe', bash ? ['--login', '-i'] : [], {
    name: 'xterm-256color',
    cols: cols || 100,
    rows: rows || 24,
    cwd: cwd || process.env.USERPROFILE,
    env: process.env
  });
  terms.set(termId, p);
  p.onData(d => send('term-data', { termId, data: d }));
  p.onExit(({ exitCode }) => {
    terms.delete(termId);
    send('term-data', { termId, data: `\r\n[terminal exited ${exitCode}]\r\n`, exited: true });
  });
  return { ok: true, shell: bash ? 'git bash' : 'powershell' };
});

ipcMain.handle('term-input', (_e, { termId, data }) => {
  const t = terms.get(termId);
  if (t) t.write(data);
  return !!t;
});

ipcMain.handle('term-resize', (_e, { termId, cols, rows }) => {
  const t = terms.get(termId);
  try { if (t && cols > 0 && rows > 0) t.resize(cols, rows); } catch {}
  return !!t;
});

ipcMain.handle('term-kill', (_e, termId) => {
  const t = terms.get(termId);
  if (t) t.kill();
  terms.delete(termId);
  return true;
});

app.on('before-quit', () => { for (const t of terms.values()) t.kill(); });

// quick "!" shell commands from the command box, like the CLI's ! prefix
ipcMain.handle('exec', (_e, { command, cwd }) => {
  return new Promise((resolve) => {
    execFile(command, [], { shell: true, cwd: cwd || process.env.USERPROFILE, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
});

ipcMain.handle('agent-stop', (_e, runId) => {
  const run = runs.get(runId);
  if (run) run.abortController.abort();
  return true;
});

// one-shot text generation (commit messages, PR descriptions) — no tools, no
// events, returns just the text. Cheap + quiet (defaults to Haiku).
ipcMain.handle('ai-generate', async (_e, { prompt, model, cwd }) => {
  await sdkReady;
  try {
    const opts = {
      model: model || 'claude-haiku-4-5-20251001',
      cwd: cwd || process.env.USERPROFILE,
      permissionMode: 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: [],
      // pure text-gen: forbid ALL tools so it can't try to explore the repo and
      // burn turns (that caused "reached maximum number of turns"). One-shot.
      allowedTools: [],
      maxTurns: 6
    };
    if (CLAUDE_EXE) opts.pathToClaudeCodeExecutable = CLAUDE_EXE;
    let text = '';
    for await (const msg of query({ prompt, options: opts })) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content || []) if (b.type === 'text') text += b.text;
      }
    }
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('agent-run', async (_e, cfg) => {
  // cfg: { runId, agentId, prompt, model, cwd, rules, permissionMode, resumeSessionId }
  await sdkReady;
  const abortController = new AbortController();
  runs.set(cfg.runId, { abortController });

  const options = {
    model: cfg.model,
    cwd: cfg.cwd || process.env.USERPROFILE,
    permissionMode: cfg.permissionMode || 'acceptEdits',
    abortController,
    systemPrompt: cfg.rules
      ? { type: 'preset', preset: 'claude_code', append: cfg.rules }
      : { type: 'preset', preset: 'claude_code' },
    includePartialMessages: true,
    autoCompact: true,
    // token-lean agents load only the project CLAUDE.md — the user's global
    // config (skills inventory, personal instructions) costs thousands of
    // system-prompt tokens per run and pipeline agents never need it
    settingSources: cfg.leanContext ? ['project'] : ['user', 'project', 'local']
  };
  // runaway guard: cap agentic turns per run (renderer sets a per-role ceiling)
  if (cfg.maxTurns > 0) options.maxTurns = cfg.maxTurns;
  // reasoning effort — global setting from the composer EFFORT dropdown. These
  // are Claude's own effort levels (low|medium|high|xhigh|max); omitted when the
  // user leaves it on AUTO so the model runs at its default. Replaces the old
  // maxThinkingTokens budget, which the agent SDK now deprecates.
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (cfg.effort && EFFORTS.includes(cfg.effort)) options.effort = cfg.effort;
  else if (cfg.maxThinkingTokens > 0) options.maxThinkingTokens = cfg.maxThinkingTokens;
  // block the Task tool so pipeline agents can't delegate to the PROJECT's own
  // .claude/agents subagents — they must do the work with our roster themselves
  if (cfg.noSubagents) options.disallowedTools = ['Task'];
  // packaged app: spawn the unpacked binary, never the one inside app.asar
  if (CLAUDE_EXE) options.pathToClaudeCodeExecutable = CLAUDE_EXE;
  if (Array.isArray(cfg.addDirs) && cfg.addDirs.length) options.additionalDirectories = cfg.addDirs;
  if (cfg.resumeSessionId) {
    options.resume = cfg.resumeSessionId;
    if (cfg.forkSession) options.forkSession = true;
  }

  const isMissingSession = (s) => /no conversation found with session id/i.test(String(s || ''));

  // one pass over the SDK stream. Returns {missingSession, errored} so the caller
  // can retry from scratch when a resume points at a session that no longer exists.
  async function runOnce(opts, forwardEvents) {
    let missingSession = false, errored = false;
    for await (const msg of query({ prompt: cfg.prompt, options: opts })) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (forwardEvents) send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'init', sessionId: msg.session_id, model: msg.model });
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'text-delta', text: ev.delta.text });
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content || []) {
          if (block.type === 'tool_use') {
            send('agent-event', {
              runId: cfg.runId, agentId: cfg.agentId, kind: 'tool',
              tool: block.name,
              input: JSON.stringify(block.input).slice(0, 400)
            });
          }
        }
        send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'text-end' });
      } else if (msg.type === 'result') {
        // a resume against a vanished session fails immediately with this result
        if (msg.subtype !== 'success' && (isMissingSession(msg.result) || isMissingSession(msg.error))) {
          missingSession = true;
          break;   // don't forward — the caller retries fresh
        }
        if (msg.subtype !== 'success') errored = true;
        send('agent-event', {
          runId: cfg.runId, agentId: cfg.agentId, kind: 'result',
          subtype: msg.subtype,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          sessionId: msg.session_id,
          usage: msg.usage ? {
            input: msg.usage.input_tokens || 0,
            output: msg.usage.output_tokens || 0,
            cacheRead: msg.usage.cache_read_input_tokens || 0,
            cacheWrite: msg.usage.cache_creation_input_tokens || 0
          } : null
        });
      }
    }
    return { missingSession, errored };
  }

  (async () => {
    try {
      let res = await runOnce(options, true);
      if (res.missingSession) {
        // the stored session ID is dead — drop it and start clean, once
        send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'session-invalid', sessionId: cfg.resumeSessionId });
        const fresh = { ...options };
        delete fresh.resume;
        delete fresh.forkSession;
        await runOnce(fresh, true);
      }
    } catch (err) {
      const aborted = abortController.signal.aborted;
      const msg = String(err && err.message ? err.message : err);
      // same recovery when the SDK throws instead of returning a result
      if (!aborted && cfg.resumeSessionId && isMissingSession(msg)) {
        send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'session-invalid', sessionId: cfg.resumeSessionId });
        try {
          const fresh = { ...options };
          delete fresh.resume;
          delete fresh.forkSession;
          await runOnce(fresh, true);
        } catch (err2) {
          send('agent-event', {
            runId: cfg.runId, agentId: cfg.agentId,
            kind: abortController.signal.aborted ? 'aborted' : 'error',
            error: String(err2 && err2.message ? err2.message : err2)
          });
        }
      } else {
        send('agent-event', {
          runId: cfg.runId, agentId: cfg.agentId,
          kind: aborted ? 'aborted' : 'error',
          error: msg
        });
      }
    } finally {
      runs.delete(cfg.runId);
      send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'done' });
    }
  })();

  return { started: true };
});
