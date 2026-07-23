const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } =
  require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
let query, sdkTool, createSdkMcpServer;
const sdkReady = import('@anthropic-ai/claude-agent-sdk').then(m => {
  query = m.query;
  sdkTool = m.tool;                            // in-process MCP tool builder
  createSdkMcpServer = m.createSdkMcpServer;   // in-process MCP server wrapper
});
// zod — schema lib the SDK's tool() helper requires (ships with the SDK)
let z = null;
try { ({ z } = require('zod')); } catch {}

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
const V = require('./vectors');   // semantic vector index over the tree-sitter graph
const { Worker } = require('worker_threads');

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
      nodeIntegration: false,
      webviewTag: true
    }
  });
  win.loadFile('renderer/index.html');
}

// Google (and Microsoft/other) OAuth sign-in rejects Electron's default user
// agent (it contains "Electron/…") as an insecure/embedded browser — the
// "This browser or app may not be secure" wall. Present the sandbox browser as
// plain desktop Chrome by stripping the Electron + app tokens from the UA for
// the whole persist:sandbox partition. Session-level covers EVERY request in
// that session (OAuth popup windows, iframes, XHRs) — the per-<webview>
// `useragent` attribute only reliably covers the top document, so popups the
// Google flow opens could still leak the Electron UA. Doing both is belt +
// suspenders and yields the same string for every site, not just Atlassian.
function configureSandboxSession() {
  try {
    const base = session.defaultSession.getUserAgent();
    const chromeUa = base
      .replace(/\s?(agent-deck|LoveAi)\/\S+/gi, '')
      .replace(/\s?Electron\/\S+/gi, '')
      .trim();
    session.fromPartition('persist:sandbox').setUserAgent(chromeUa);
  } catch (e) {
    console.error('sandbox UA setup failed', e);
  }
}

app.whenReady().then(() => {
  saas.init(send);
  configureSandboxSession();
  wireNetworkLog();
  startBridgeServer();
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

// OAuth providers we allow into a native shared-session window. Exact hostname
// match only. Keep small + extend deliberately (mirror in browser.js isAuthUrl).
const AUTH_HOSTS = new Set([
  'accounts.google.com', 'accounts.youtube.com', 'oauth.googleusercontent.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
]);
function isAuthHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AUTH_HOSTS.has(u.hostname);
  } catch { return false; }
}
// Shared-session webPreferences for the auth window + any nested popup: same
// persist:sandbox partition so cookies land where the <webview> can see them,
// NO preload so the auth page can't reach the app/node.
const AUTH_WEBPREFS = {
  partition: 'persist:sandbox',
  contextIsolation: true, nodeIntegration: false, sandbox: true,
};

// "Sign in with Google" popups need a REAL desktop-Chrome window (Google
// rejects embedded webviews). We share persist:sandbox so the session cookie
// it sets is visible to the sandbox <webview> after the window closes.
function openAuthWindow(url, returnOrigin) {
  if (!isAuthHost(url)) return Promise.resolve({ ok: false });
  return new Promise(resolve => {
    try {
      const w = new BrowserWindow({
        parent: win, width: 520, height: 680,
        autoHideMenuBar: true, title: 'Sign in',
        webPreferences: AUTH_WEBPREFS,
      });
      // Nested auth popups (Google sometimes chains them) also share the jar.
      w.webContents.setWindowOpenHandler(({ url: u }) => {
        if (!/^https:\/\//i.test(String(u))) return { action: 'deny' };
        return { action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: AUTH_WEBPREFS } };
      });
      const backToSite = target => {
        try { if (returnOrigin && new URL(target).origin === returnOrigin) w.close(); }
        catch {}
      };
      w.webContents.on('did-navigate', (_ev, u) => backToSite(u));
      w.webContents.on('did-navigate-in-page', (_ev, u) => backToSite(u));
      w.on('closed', () => resolve({ ok: true }));
      w.loadURL(url);
    } catch (error) { resolve({ ok: false, error: String(error) }); }
  });
}
ipcMain.handle('open-auth-window', (_e, { url, returnOrigin } = {}) =>
  openAuthWindow(url, returnOrigin));

// ===== Sandbox popup routing + guest hotkeys ==============================
// The <webview> `new-window` DOM event was REMOVED in Electron 22, so popup
// handling must live here. window.open / target=_blank from a sandbox guest:
// OAuth hosts get the native shared-session window; other http(s) URLs become
// an in-app tab in the opener's project (renderer maps openerId → tab).
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  let sandbox = false;
  try {
    sandbox = contents.session === session.fromPartition('persist:sandbox');
  } catch {}
  if (!sandbox) return;
  contents.setWindowOpenHandler(({ url }) => {
    if (isAuthHost(url)) {
      let origin = '';
      try { origin = new URL(contents.getURL()).origin; } catch {}
      // after sign-in the shared cookie is set — reload so the page sees it
      openAuthWindow(url, origin).then(() => {
        try { contents.reload(); } catch {}
      });
    } else if (/^https?:\/\//i.test(String(url))) {
      send('browser-popup', { url, openerId: contents.id });
    }
    return { action: 'deny' };
  });
  // keys pressed while the guest page has focus never reach the host DOM —
  // forward the browser screen's few shortcuts (Esc, Ctrl+T/W/L)
  contents.on('before-input-event', (_ev, input) => {
    if (input.type !== 'keyDown') return;
    const mod = !!(input.control || input.meta);
    const key = String(input.key || '').toLowerCase();
    if (key === 'escape' || (mod && ['t', 'w', 'l'].includes(key))) {
      send('browser-hotkey', { key, mod });
    }
  });
});

// ===== BROWSER BRIDGE =====================================================
// In-app Playwright alternative: drives the sandbox browser's REAL <webview>
// guests through the renderer (renderer/src/bridge.js executes each command
// against the live page — no separate browser spawn, so it's near-instant).
// Exposed two ways:
//   1. an in-process MCP server for agent runs (buildBrowserServer below)
//   2. a token-gated localhost HTTP endpoint for CLIs (browserctl.js) — the
//      port/token land in every in-app terminal's env and in
//      ~/.loveai/browser-bridge.json for external Claude Code sessions.
const bridgePending = new Map();   // id → { resolve, timer }
let bridgeSeq = 0;

function browserCmd(cmd, timeoutMs) {
  return new Promise(resolve => {
    if (!win || win.isDestroyed()) {
      return resolve({ ok: false, error: 'app window not available' });
    }
    const id = ++bridgeSeq;
    const timer = setTimeout(() => {
      bridgePending.delete(id);
      resolve({ ok: false, error: `bridge timeout on "${cmd && cmd.op}"` });
    }, timeoutMs || 15000);
    bridgePending.set(id, { resolve, timer });
    win.webContents.send('bridge-cmd', { id, cmd });
  });
}
ipcMain.on('bridge-reply', (_e, { id, result } = {}) => {
  const p = bridgePending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  bridgePending.delete(id);
  p.resolve(result || { ok: false, error: 'empty bridge reply' });
});

// passive network log for the sandbox partition (ring buffer, newest last) —
// served straight from main, no renderer round-trip
const NET_LOG_MAX = 400;
const netLog = [];
const netStarts = new Map();       // requestId → start ts
function pushNet(entry) {
  netLog.push(entry);
  if (netLog.length > NET_LOG_MAX) netLog.splice(0, netLog.length - NET_LOG_MAX);
}
function wireNetworkLog() {
  try {
    const wr = session.fromPartition('persist:sandbox').webRequest;
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    wr.onBeforeRequest(filter, (d, cb) => {
      netStarts.set(d.id, Date.now());
      cb({});
    });
    wr.onCompleted(filter, d => {
      const t0 = netStarts.get(d.id);
      netStarts.delete(d.id);
      pushNet({
        ts: Date.now(), method: d.method, url: d.url, status: d.statusCode,
        type: d.resourceType, ms: t0 ? Date.now() - t0 : null,
        fromCache: !!d.fromCache
      });
    });
    wr.onErrorOccurred(filter, d => {
      const t0 = netStarts.get(d.id);
      netStarts.delete(d.id);
      pushNet({
        ts: Date.now(), method: d.method, url: d.url, error: d.error,
        type: d.resourceType, ms: t0 ? Date.now() - t0 : null
      });
    });
  } catch (e) { console.error('bridge network log failed', e); }
}

// single entry point used by BOTH the MCP tools and the HTTP endpoint
async function bridgeDispatch(cmd) {
  const op = cmd && cmd.op;
  if (!op) return { ok: false, error: 'missing op' };
  if (op === 'network') {
    const q = String(cmd.filter || '').toLowerCase();
    let list = netLog.slice();
    if (q) list = list.filter(e => e.url.toLowerCase().includes(q));
    if (cmd.since > 0) list = list.filter(e => e.ts >= cmd.since);
    return { ok: true, now: Date.now(), requests: list.slice(-(cmd.limit || 50)) };
  }
  // per-op IPC timeouts: waitFor polls up to its own timeout in the renderer,
  // open/navigate can wait attach (10s) + load settle (8s) on a cold tab
  const timeout = op === 'waitFor' ? (Number(cmd.timeoutMs) || 15000) + 5000
    : (op === 'open' || op === 'navigate' || op === 'screenshot') ? 30000
    : undefined;
  const r = await browserCmd(cmd, timeout);
  if (r && r.ok && op === 'screenshot' && r.dataUrl) {
    try {
      const b64 = String(r.dataUrl).split(',')[1] || '';
      const file = (cmd.path && path.isAbsolute(String(cmd.path)))
        ? String(cmd.path)
        : path.join(os.tmpdir(), 'loveai-shots', `shot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      delete r.dataUrl;
      r.path = file;
    } catch (e) {
      return { ok: false, error: 'screenshot save failed: ' + (e.message || e) };
    }
  }
  return r;
}

// ---- localhost HTTP endpoint (token-gated, loopback only) ----------------
const BRIDGE_TOKEN = crypto.randomBytes(16).toString('hex');
let BRIDGE_PORT = 0;
const bridgeInfoFile = () =>
  path.join(os.homedir(), '.loveai', 'browser-bridge.json');

function startBridgeServer() {
  const server = http.createServer((req, res) => {
    const respond = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const u = new URL(req.url, 'http://127.0.0.1');
    const token = req.headers['x-bridge-token'] || u.searchParams.get('token');
    if (token !== BRIDGE_TOKEN) return respond(401, { ok: false, error: 'bad token' });
    if (req.method === 'GET' && u.pathname === '/health') {
      return respond(200, { ok: true, app: 'loveai', pid: process.pid });
    }
    if (req.method !== 'POST') {
      return respond(405, { ok: false, error: 'POST a JSON command to /cmd' });
    }
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 2e6) req.destroy();
    });
    req.on('end', async () => {
      let cmd;
      try { cmd = JSON.parse(body || '{}'); }
      catch { return respond(400, { ok: false, error: 'invalid JSON' }); }
      try { respond(200, await bridgeDispatch(cmd)); }
      catch (e) { respond(500, { ok: false, error: String(e.message || e) }); }
    });
  });
  server.on('error', e => console.error('bridge server error', e));
  server.listen(0, '127.0.0.1', () => {
    BRIDGE_PORT = server.address().port;
    try {
      fs.mkdirSync(path.dirname(bridgeInfoFile()), { recursive: true });
      fs.writeFileSync(bridgeInfoFile(), JSON.stringify({
        port: BRIDGE_PORT, token: BRIDGE_TOKEN, pid: process.pid,
        started: Date.now()
      }, null, 2));
    } catch (e) { console.error('bridge info write failed', e); }
  });
}

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

// Walk rules (skip dirs, gitignore awareness, caps) + the UNIFIED traversal
// live in walker.js — shared with the codegraph parse worker so every indexer
// skips and caps identically instead of four hand-rolled walkers drifting.
const {
  INDEX_SKIP_DIRS, INDEX_EXTS, INDEX_MAX_FILES, SYMBOL_MAX_BYTES,
  skipDir, walkRepo,
} = require('./walker');

// ASYNC (unified walker) — this was the one remaining SYNCHRONOUS tree walk
// on the main process; index-status hit it per call. Keys are forward-slash
// rels now (one-time staleness vs old backslash-keyed fingerprints, which
// self-heals on the next index-mark).
async function projectFingerprint(cwd) {
  const root = cwd || process.env.USERPROFILE;
  const fp = {};
  await walkRepo(root, { exts: INDEX_EXTS }, async ({ full, rel }) => {
    const stat = await fs.promises.stat(full);
    fp[rel] = `${stat.mtimeMs}:${stat.size}`;
  });
  return fp;
}

ipcMain.handle('index-status', async (_e, cwd) => {
  try {
    const dir = indexDir(cwd);
    const mapExists = fs.existsSync(path.join(dir, 'PROJECT-MAP.md'));
    const stored = readJson(path.join(dir, 'fingerprint.json'));
    if (!stored || !mapExists) return { exists: false, stale: false, changedFiles: [] };

    const current = await projectFingerprint(cwd);
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

ipcMain.handle('index-mark', async (_e, cwd) => {
  try {
    const dir = indexDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const fp = await projectFingerprint(cwd);
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
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'then', 'not', 'but', 'you', 'are', 'was', 'will', 'add', 'fix', 'use', 'get', 'set', 'new', 'now', 'has', 'have', 'should', 'need', 'want', 'make', 'change', 'update', 'issue', 'bug', 'feature', 'file', 'code', 'function', 'const', 'let', 'var', 'return', 'import', 'export']);

// null-prototype map for identifier-keyed lookups. Source symbols are OFTEN
// named after Object.prototype members (constructor, toString, valueOf, ...)
// and a plain {} then returns the INHERITED function instead of "absent" —
// which crashed the graph build ("byName[name].push is not a function") and
// silently corrupted tf/inv maps. dict() has no prototype, so lookups of any
// identifier are honest. hasOwn() guards reads of JSON.parse'd maps (those
// come back WITH Object.prototype attached).
const dict = () => Object.create(null);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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
const symbolBuilding = {};   // cwd -> in-flight build promise (dedupe per PROJECT —
                             // a single global here handed project B project A's index)
const symbolCache = {};      // cwd -> index kept in memory (fast reuse + incremental updates)
const symbolWatchers = {};   // cwd -> { watcher, timer, pending:Set }
async function buildSymbolIndex(cwd) {
  const root = cwd || process.env.USERPROFILE;
  const files = {};
  const count = await walkRepo(root, { exts: INDEX_EXTS }, async ({ full, rel, ext }) => {
    if (ext === 'json') return false;   // json rarely useful to rank
    const stat = await fs.promises.stat(full);
    if (stat.size > SYMBOL_MAX_BYTES) return false;
    const text = await fs.promises.readFile(full, 'utf8');
    const symbols = extractSymbols(text);
    const tf = dict();
    const bump = (s, w) => { for (const t of tokenize(s)) tf[t] = (tf[t] || 0) + w; };
    for (const s of symbols) bump(s, 4);          // symbol names weigh most
    bump(rel.replace(/[\/.]/g, ' '), 3);          // path + filename
    const ids = text.match(/[A-Za-z_$][\w$]{2,}/g) || [];
    let len = 0;
    for (const id of ids) { for (const t of tokenize(id)) { tf[t] = (tf[t] || 0) + 1; len++; } }
    files[rel] = { symbols: symbols.slice(0, 30), tf, len: len || 1 };
  });
  // surfaced in the repo map + search_code so agents never mistake a capped
  // index for full coverage on a big repo
  const idx = { built: Date.now(), avgLen: 1, truncated: count >= INDEX_MAX_FILES, files };
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
// dedupe: never run two builds for the same PROJECT at once (keyed by cwd —
// different projects may build concurrently and must never share a promise)
function buildSymbolIndexOnce(cwd) {
  if (symbolBuilding[cwd]) return symbolBuilding[cwd];
  symbolBuilding[cwd] = buildSymbolIndex(cwd)
    .finally(() => { delete symbolBuilding[cwd]; });
  return symbolBuilding[cwd];
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
  if (rel.split('/').some((p) => skipDir(cwd, p))) return false;
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!INDEX_EXTS.has(ext) || ext === 'json') return false;
  try {
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile() || stat.size > SYMBOL_MAX_BYTES) return false;
    const text = await fs.promises.readFile(abs, 'utf8');
    const symbols = extractSymbols(text);
    const tf = dict();
    const bump = (s, w) => { for (const t of tokenize(s)) tf[t] = (tf[t] || 0) + w; };
    for (const s of symbols) bump(s, 4);
    bump(rel.replace(/[\/.]/g, ' '), 3);
    const ids = text.match(/[A-Za-z_$][\w$]{2,}/g) || [];
    let len = 0;
    for (const id of ids) { for (const t of tokenize(id)) { tf[t] = (tf[t] || 0) + 1; len++; } }
    idx.files[rel] = { symbols: symbols.slice(0, 30), tf, len: len || 1 };
    invCache.delete(idx);   // file contents changed → cached inverted map is stale
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
  const df = dict();
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
  const capNote = idx.truncated
    ? `[PARTIAL INDEX — capped at ${INDEX_MAX_FILES} files; unlisted areas exist. ` +
      `Fall back to Glob/Grep for anything not shown.]\n`
    : '';
  const dirs = dict();
  for (const rel of Object.keys(idx.files)) {
    const cut = rel.lastIndexOf('/');
    const dir = cut >= 0 ? rel.slice(0, cut) : '.';
    (dirs[dir] = dirs[dir] || []).push({ rel, syms: (idx.files[rel].symbols || []).length });
  }
  const entries = Object.entries(dirs)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 30);
  return capNote + entries.map(([dir, list]) => {
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
  const df = dict(); for (const t of qterms) df[t] = 0;
  for (const rel of rels) { const tf = idx.files[rel].tf; for (const t of qterms) if (hasOwn(tf, t)) df[t]++; }
  const k1 = 1.5, b = 0.75;
  const out = [];
  for (const rel of rels) {
    const f = idx.files[rel];
    let s = 0;
    for (const t of qterms) {
      // hasOwn: a JSON-loaded tf has Object.prototype, so 'constructor' etc.
      // would read the inherited function; the typeof guard drops corrupted
      // (string) counts persisted by builds from before the dict() fix
      const freq = hasOwn(f.tf, t) ? f.tf[t] : 0;
      if (!freq || typeof freq !== 'number') continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      s += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * f.len / idx.avgLen));
    }
    if (s > 0) out.push({ rel, score: +s.toFixed(2), symbols: f.symbols });
  }
  out.sort((a, b2) => b2.score - a.score);
  return out.slice(0, k || 8);
}

// ===== NATIVE code knowledge graph — tree-sitter, parsed in a WORKER =====
// "If you change this symbol, what references it?" A deterministic blast-radius
// the Prompt Engineer sees BEFORE editing. WASM tree-sitter parses each source
// file into def nodes + call/import edges resolved by NAME. Parsing lives in
// codegraph-parse.js and runs inside codegraph-worker.js (pure CPU — it used to
// stutter the main process even with yielding); main keeps assembly, the
// in-memory REVERSE adjacency (def -> {callers, importers}), caches and
// persistence (codegraph.json). If the worker/runtime/grammar is unavailable it
// degrades to the lexical tf reverse-map — a run NEVER blocks on the graph.
const { LANG_GRAMMAR } = require('./codegraph-parse');

// mirrors of the worker's tree-sitter health, surfaced via codegraph-status
let tsBroken = false;          // runtime/grammar totally unavailable → skip tree-sitter
let tsInitError = '';          // last real init failure, shown in the status bar
let tsInitErrorLogged = false; // log a given failure once per session, not per build
const graphCache = {};        // cwd -> in-memory graph
const graphBuilding = {};     // cwd -> in-flight build promise (dedupe)

// ----- persistent PARSE worker (same protocol/pattern as the vectors worker) -----
let _cgWorker = null;
const _cgReqs = new Map();
let _cgReqId = 0;
function cgWorker() {
  if (_cgWorker) return _cgWorker;
  const w = new Worker(path.join(__dirname, 'codegraph-worker.js'));
  w.on('message', (m) => {
    const req = _cgReqs.get(m.id);
    if (!req) return;
    if (m.type === 'progress') { if (req.onProgress) req.onProgress(m.done, m.total, m.phase); }
    else if (m.type === 'done') { _cgReqs.delete(m.id); req.resolve(m); }
  });
  const fail = (err) => {
    // a superseded worker (resetGraphWorker respawned a new one) must NOT
    // clobber the new worker's state — its exit event arrives late and used
    // to clear the FRESH build's pending request, killing it at 0%
    if (_cgWorker !== w) return;
    for (const [, req] of _cgReqs) req.resolve({ ok: false, error: String(err) });
    _cgReqs.clear(); _cgWorker = null;   // allow a fresh spawn next request
  };
  w.on('error', (e) => fail(e && e.message || e));
  w.on('exit', () => fail('codegraph worker exited'));
  _cgWorker = w;
  return w;
}
function runGraphJob(payload, onProgress) {
  return new Promise((resolve) => {
    const id = ++_cgReqId;
    _cgReqs.set(id, { resolve, onProgress });
    try { cgWorker().postMessage({ id, ...payload }); }
    catch (e) { _cgReqs.delete(id); resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}
// a manual rebuild is the retry gesture — kill the worker so a fresh spawn
// re-attempts tree-sitter init instead of staying broken for the session.
// Detach BEFORE terminating: the old worker's async 'exit' event must never
// fire into state that now belongs to the replacement worker.
function resetGraphWorker() {
  const w = _cgWorker;
  _cgWorker = null;
  for (const [, req] of _cgReqs) req.resolve({ ok: false, error: 'parse worker restarted' });
  _cgReqs.clear();
  if (w) {
    try { w.removeAllListeners(); } catch {}
    try { w.terminate(); } catch {}
  }
}

// persisted codegraph schema version. Bumped to 2 when def records became RICH
// symbols (type/lines/parent/visibility/doc/lang); to 3 for collision-safe ids
// (rel#name@line on duplicates) + import-scoped edge resolution. A stale file
// on disk is ignored (treated as absent) so it gets rebuilt in the background.
const GRAPH_SCHEMA = 3;
function emptyGraph() { return { v: GRAPH_SCHEMA, built: 0, defs: [], callers: {}, importers: {} }; }
// read a persisted graph only if it matches the current schema, else null
function loadGraphDisk(cwd) {
  const disk = readJson(path.join(indexDir(cwd), 'codegraph.json'));
  if (disk && disk.v === GRAPH_SCHEMA && disk.defs) return disk;
  return null;
}
// rebuild the derived lookup indices (defById / fileDefs / byName) from graph.defs —
// run after a build and after loading a persisted graph (only defs/edges are stored)
function indexGraph(graph) {
  graph.defById = dict();
  graph.fileDefs = dict();
  graph.byName = dict();
  for (const d of graph.defs) {
    graph.defById[d.id] = d;
    (graph.fileDefs[d.rel] = graph.fileDefs[d.rel] || []).push(d.id);
    (graph.byName[d.name] = graph.byName[d.name] || []).push(d.id);
  }
  graph.callers = graph.callers || {};
  graph.importers = graph.importers || {};
  return graph;
}
// resolve one import specifier to a repo rel path (extension/index guessing).
// Relative specs resolve against the importing file's dir; bare dotted names
// try the python module layout. Returns null when it isn't a repo file.
function resolveSpec(fromRel, spec, fileSet) {
  if (spec.startsWith('.') && !spec.startsWith('..') && !spec.startsWith('./') &&
      !spec.startsWith('.\\')) {
    // python relative `from .mod import x` → sibling module
    const base = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
    const p = base + spec.replace(/^\.+/, '').replace(/\./g, '/') + '.py';
    return fileSet.has(p) ? p : null;
  }
  if (spec.startsWith('.')) {
    const base = fromRel.slice(0, fromRel.lastIndexOf('/') + 1);
    const norm = path.posix.normalize(base + spec);
    const tries = [norm];
    for (const ext of ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'py']) tries.push(`${norm}.${ext}`);
    for (const ext of ['js', 'ts', 'tsx', 'jsx']) tries.push(`${norm}/index.${ext}`);
    for (const t of tries) if (fileSet.has(t)) return t;
    return null;
  }
  // bare dotted python module (`from a.b import c`) → a/b.py from the root
  if (/^[\w.]+$/.test(spec) && spec.includes('.')) {
    const p = spec.replace(/\./g, '/') + '.py';
    if (fileSet.has(p)) return p;
  }
  return null;
}
// resolve one file's call/import names to def ids by NAME (GitNexus-style) and record
// the referring file on each def's reverse edge list. Skips self-references, overly
// ambiguous names (>25 defs), and caps each edge list so a common name can't explode.
// IMPORT-SCOPED: when the referrer's resolved imports include files that define the
// name, only those defs get the edge — a bare-name match across unrelated modules
// (`init`, `close`, …) no longer inflates the blast radius.
function linkEdges(graph, byName, raw) {
  const relOf = (id) => id.slice(0, id.lastIndexOf('#'));
  const addEdge = (map, id) => {
    if (relOf(id) === raw.rel) return;
    const arr = (map[id] = map[id] || []);
    if (arr.length < 50 && !arr.includes(raw.rel)) arr.push(raw.rel);
  };
  const link = (names, map) => {
    for (const name of names) {
      let ids = byName[name];
      if (!ids) continue;
      if (raw.impRels && raw.impRels.size && ids.length > 1) {
        const scoped = ids.filter((id) => raw.impRels.has(relOf(id)));
        if (scoped.length) ids = scoped;
      }
      if (ids.length > 25) continue;
      for (const id of ids) addEdge(map, id);
    }
  };
  link(raw.calls, graph.callers);
  link(raw.imps, graph.importers);
}
// stamp rel + id onto a raw file's rich symbols. Ids are rel#name, with an @line
// suffix ONLY when the file has same-named defs — keeps common ids stable while
// making every id unique (the packer/vectors key on it).
function stampSymbols(raw) {
  const counts = dict();
  for (const s of raw.symbols) counts[s.name] = (counts[s.name] || 0) + 1;
  for (const s of raw.symbols) {
    s.rel = raw.rel;
    s.id = raw.rel + '#' + s.name + (counts[s.name] > 1 ? '@' + s.sl : '');
  }
  return raw.symbols;
}
// full assembly: all defs first (so edges can resolve against the whole repo), then edges
function assembleGraph(graph, raws) {
  const byName = dict();
  const fileSet = new Set(raws.map((r) => r.rel));
  for (const r of raws) {
    for (const s of stampSymbols(r)) {
      graph.defs.push(s);
      (byName[s.name] = byName[s.name] || []).push(s.id);
    }
  }
  for (const r of raws) {
    r.impRels = new Set((r.specs || [])
      .map((s) => resolveSpec(r.rel, s, fileSet)).filter(Boolean));
    linkEdges(graph, byName, r);
  }
}
async function persistGraph(cwd, graph) {
  try {
    const dir = indexDir(cwd);
    await fs.promises.mkdir(dir, { recursive: true });
    const data = { v: GRAPH_SCHEMA, built: graph.built, defs: graph.defs,
      callers: graph.callers, importers: graph.importers };
    await fs.promises.writeFile(path.join(dir, 'codegraph.json'), JSON.stringify(data), 'utf8');
  } catch {}
}
// build via the PARSE WORKER, then assemble/persist here. The main process only
// does cheap assembly (name→id edge linking) on the returned raws — all WASM
// parsing (and the pre-count for the progress bar) happens off-thread.
async function buildCodeGraph(cwd, onProgress) {
  const root = cwd || process.env.USERPROFILE;
  const graph = emptyGraph();
  // EVERY build streams progress to the status bar — including background
  // rebuilds (schema bump, first open), which used to run completely silent
  // and read as "stuck at 0%". Phases: init → count → parse → done|error.
  const report = (done, total, phase) => {
    send('codegraph-progress', { cwd, done, total, phase: phase || 'parse' });
    if (onProgress) onProgress(done, total);
  };
  report(0, 0, 'init');
  const m = await runGraphJob({ job: 'build', root, countFirst: true }, report);
  if (!m.ok) {
    tsBroken = true;
    tsInitError = m.error || 'tree-sitter unavailable';
    if (!tsInitErrorLogged) {
      console.error('[codegraph] build failed:', tsInitError);
      tsInitErrorLogged = true;
    }
    send('codegraph-progress', { cwd, done: 0, total: 0, phase: 'error', error: tsInitError });
    return graph;
  }
  tsBroken = false; tsInitError = '';
  assembleGraph(graph, m.raws || []);
  graph.built = Date.now();
  graph.truncated = !!m.truncated;
  indexGraph(graph);
  graphCache[cwd] = graph;
  await persistGraph(cwd, graph);
  const n = (m.raws || []).length;
  send('codegraph-progress', { cwd, done: n, total: n, phase: 'done' });
  return graph;
}
// background build/refresh — memory → disk → build, deduped. NEVER awaited on a hot path.
function ensureGraph(cwd) {
  if (graphCache[cwd]) return Promise.resolve(graphCache[cwd]);
  if (graphBuilding[cwd]) return graphBuilding[cwd];
  const disk = loadGraphDisk(cwd);
  if (disk) { indexGraph(disk); graphCache[cwd] = disk; return Promise.resolve(disk); }
  if (tsBroken) return Promise.resolve(null);
  graphBuilding[cwd] = buildCodeGraph(cwd)
    .catch(() => null)
    .finally(() => { delete graphBuilding[cwd]; });
  return graphBuilding[cwd];
}
// synchronous cached read for the query path — memory or disk only, NEVER a build
function getGraphForQuery(cwd) {
  if (graphCache[cwd]) return graphCache[cwd];
  const disk = loadGraphDisk(cwd);
  if (disk) { indexGraph(disk); graphCache[cwd] = disk; return disk; }
  return null;
}
// add one file's defs + outgoing edges to an existing graph (incremental re-parse)
function addFileToGraph(graph, raw) {
  const byName = dict();
  const fileSet = new Set([raw.rel]);
  for (const d of graph.defs) {
    (byName[d.name] = byName[d.name] || []).push(d.id);
    fileSet.add(d.rel);
  }
  for (const s of stampSymbols(raw)) {
    graph.defs.push(s);
    (byName[s.name] = byName[s.name] || []).push(s.id);
  }
  raw.impRels = new Set((raw.specs || [])
    .map((s) => resolveSpec(raw.rel, s, fileSet)).filter(Boolean));
  linkEdges(graph, byName, raw);
}
// drop everything a file contributed: its own defs and its appearances as a referrer
function removeFileFromGraph(graph, rel) {
  const kept = [];
  const removed = new Set();
  for (const d of graph.defs) {
    if (d.rel === rel) removed.add(d.id);
    else kept.push(d);
  }
  graph.defs = kept;
  for (const id of removed) { delete graph.callers[id]; delete graph.importers[id]; }
  for (const map of [graph.callers, graph.importers]) {
    for (const id of Object.keys(map)) {
      if (map[id].includes(rel)) map[id] = map[id].filter((r) => r !== rel);
    }
  }
}
// re-parse a single changed file into the in-memory graph — mirrors indexOneFile.
// Parsing happens in the worker; only remove/add/re-index run here.
async function reparseFileInGraph(cwd, abs) {
  const graph = graphCache[cwd];
  if (!graph || tsBroken) return false;
  const rel = path.relative(cwd, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return false;
  if (rel.split('/').some((p) => skipDir(cwd, p))) return false;
  if (!LANG_GRAMMAR[path.extname(abs).slice(1).toLowerCase()]) return false;
  const m = await runGraphJob({ job: 'parse', abs, rel });
  if (!m.ok || !m.raw) return false;
  removeFileFromGraph(graph, rel);
  addFileToGraph(graph, m.raw);
  indexGraph(graph);
  return true;
}

// reverse-reachability: files that (transitively, ≤depth hops) reference a def, via
// callers ∪ importers. Bounded so a hub symbol can't blow up the BFS.
function reverseReach(graph, startId, depth) {
  const startRel = graph.defById[startId] ? graph.defById[startId].rel : null;
  const files = new Set();
  const visited = new Set([startId]);
  let frontier = [startId];
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      const refs = [...(graph.callers[id] || []), ...(graph.importers[id] || [])];
      for (const rel of refs) {
        if (rel === startRel) continue;
        files.add(rel);
        if (files.size >= 200) return files;
        for (const nid of (graph.fileDefs[rel] || [])) {
          if (!visited.has(nid)) { visited.add(nid); next.push(nid); }
        }
      }
    }
    frontier = next;
  }
  return files;
}
// forward-reachability: def ids a start symbol DEPENDS ON (transitively, ≤depth
// hops) via its per-def `calls`, resolved to defs by NAME. Skips ambiguous names
// (>25 defs) and is bounded so a fan-out symbol can't explode the pack. Returns
// def ids (the packer reads their source). This drives context expansion:
// login() → validatePassword() → UserRepository → DatabaseClient (depth-limited).
function forwardReach(graph, startId, depth, cap) {
  const out = new Set();
  const visited = new Set([startId]);
  let frontier = [startId];
  const limit = cap || 60;
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = [];
    for (const id of frontier) {
      const d = graph.defById[id];
      if (!d || !d.calls) continue;
      for (const name of d.calls) {
        const ids = graph.byName[name];
        if (!ids || ids.length > 25) continue;   // ambiguous → skip (name-resolution limit)
        for (const nid of ids) {
          if (visited.has(nid)) continue;
          visited.add(nid);
          out.add(nid);
          next.push(nid);
          if (out.size >= limit) return out;
        }
      }
    }
    frontier = next;
  }
  return out;
}
const impactBase = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
// one lean line: `symbol (defined in a.ts) ← used by: b.tsx, c.tsx (+N)`, ≤~90 chars
function fmtImpactLine(name, rel, users) {
  const shown = users.slice(0, 6).map(impactBase);
  const extra = users.length > 6 ? ` (+${users.length - 6})` : '';
  let line = `${name} (defined in ${impactBase(rel)}) ← used by: ${shown.join(', ')}${extra}`;
  if (line.length > 90) line = line.slice(0, 89) + '…';
  return line;
}
// LEXICAL FALLBACK — token→files inverted map when the graph is cold or a grammar is
// missing. A symbol is "used by" any OTHER file whose tf contains all of its tokens.
// The inverted map is O(all tokens × all files) to build and this runs on every
// agent launch while the graph is cold — cache it per index object (WeakMap so a
// rebuilt index gets a fresh map without explicit invalidation on replace).
const invCache = new WeakMap();   // idx -> token→Set(files)
function lexicalImpact(idx, files) {
  if (!idx || !idx.files) return '';
  let inv = invCache.get(idx);
  if (!inv) {
    inv = dict();
    for (const rel of Object.keys(idx.files)) {
      for (const t of Object.keys(idx.files[rel].tf)) (inv[t] = inv[t] || new Set()).add(rel);
    }
    invCache.set(idx, inv);
  }
  const lines = [];
  const seen = new Set();
  for (const f of files.slice(0, 6)) {
    const syms = (idx.files[f.rel] && idx.files[f.rel].symbols) || [];
    for (const sym of syms) {
      if (lines.length >= 8) break;
      if (seen.has(sym)) continue;
      seen.add(sym);
      const toks = tokenize(sym);
      if (!toks.length) continue;
      let inter = null;
      for (const t of toks) {
        const s = inv[t];
        if (!s) { inter = null; break; }
        inter = inter ? inter.filter((r) => s.has(r)) : [...s];
      }
      if (!inter) continue;
      const users = inter.filter((r) => r !== f.rel);
      if (users.length) lines.push(fmtImpactLine(sym, f.rel, users));
    }
    if (lines.length >= 8) break;
  }
  return lines.join('\n');
}
// GLOBAL regression impact for an issue: seed with the def nodes of the top ranked
// files, reverse-BFS the graph, and emit the highest-impact symbols. Falls back to the
// lexical reverse-map when the AST graph isn't ready. Query-cheap: lookups + BFS only.
function regressionImpact(graph, idx, files) {
  if (graph && graph.defs && graph.defs.length) {
    const seeds = [];
    const seenKey = new Set();
    for (const f of (files || []).slice(0, 6)) {
      for (const id of (graph.fileDefs[f.rel] || [])) {
        const d = graph.defById[id];
        if (!d || seenKey.has(id)) continue;
        seenKey.add(id);
        seeds.push(d);
      }
    }
    const scored = [];
    for (const d of seeds) {
      const users = [...reverseReach(graph, d.id, 3)];
      if (users.length) scored.push({ d, users });
    }
    scored.sort((a, b) => b.users.length - a.users.length);
    const lines = scored.slice(0, 8).map((s) => fmtImpactLine(s.d.name, s.d.rel, s.users));
    if (lines.length) return lines.join('\n');
  }
  return lexicalImpact(idx, files);
}

// ===== Symbol-level repository map (tree-sitter) — names only, no bodies =====
// Spec: a lightweight overview listing ONLY symbol names per file, grouped by
// directory. Built from the code graph's rich defs (falls back to '' when the
// graph is cold — callers then use the lexical dir-map). Token-lean by design:
// caps files, and symbols-per-file, and prefers files that carry more symbols.
function repoMapSymbols(graph, opts = {}) {
  if (!graph || !graph.defs || !graph.defs.length) return '';
  const maxFiles = opts.maxFiles || 50;
  const perFile = opts.perFile || 16;
  const only = opts.files ? new Set(opts.files) : null;   // restrict to a file subset
  const byFile = dict();
  for (const d of graph.defs) {
    if (only && !only.has(d.rel)) continue;
    (byFile[d.rel] = byFile[d.rel] || []).push(d.name);
  }
  const rels = Object.keys(byFile);
  // most-symbol-dense files first, then a stable path sort for readability
  rels.sort((a, b) => byFile[b].length - byFile[a].length);
  const chosen = rels.slice(0, maxFiles).sort();
  const byDir = dict();
  for (const rel of chosen) {
    const cut = rel.lastIndexOf('/');
    const dir = cut >= 0 ? rel.slice(0, cut) : '.';
    (byDir[dir] = byDir[dir] || []).push(rel);
  }
  const out = [];
  for (const dir of Object.keys(byDir).sort()) {
    out.push(`${dir}/`);
    for (const rel of byDir[dir]) {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      const names = [...new Set(byFile[rel])].slice(0, perFile);
      out.push(`  ${base}: ${names.join(', ')}`);
    }
  }
  return out.join('\n');
}

// ===== Symbol-level context packer (tree-sitter) — the token-optimizer =====
// Replaces whole-file front-loading: instead of dumping N files, load only the
// symbols the request needs (query-matched seeds) + their forward dependencies
// (calls/constructors, depth-limited), reading each symbol's SOURCE lazily by
// line range. Graph-gated — returns null when the graph is cold so the caller
// keeps today's whole-file path. No embeddings; ranking reuses BM25 retrieve().

// read a file's lines once per pack (cache), size-guarded
function readLinesCached(cache, cwd, rel) {
  if (cache.has(rel)) return cache.get(rel);
  let lines = null;
  try {
    const abs = path.join(cwd, rel);
    const st = fs.statSync(abs);
    if (st.isFile() && st.size <= SYMBOL_MAX_BYTES) lines = fs.readFileSync(abs, 'utf8').split('\n');
  } catch {}
  cache.set(rel, lines);
  return lines;
}
// a symbol's source, sliced by its line range; truncated past maxLines with a marker
function symbolSource(cache, cwd, sym, maxLines) {
  const lines = readLinesCached(cache, cwd, sym.rel);
  if (!lines) return '';
  const from = Math.max(0, sym.sl - 1);
  const span = sym.el - sym.sl + 1;
  if (maxLines && span > maxLines) {
    return lines.slice(from, from + maxLines).join('\n') +
      `\n  // … (${span - maxLines} more lines)`;
  }
  return lines.slice(from, Math.min(lines.length, sym.el)).join('\n');
}
// a lean signature: first non-body lines up to the opening brace / statement end
function signatureOf(cache, cwd, sym) {
  const lines = readLinesCached(cache, cwd, sym.rel);
  if (!lines) return sym.name;
  const from = Math.max(0, sym.sl - 1);
  const slice = lines.slice(from, Math.min(lines.length, from + 6));
  const buf = [];
  for (const ln of slice) {
    const brace = ln.indexOf('{');
    if (brace >= 0) { buf.push(ln.slice(0, brace).trimEnd()); break; }
    buf.push(ln.trimEnd());
    if (/;\s*$/.test(ln) || /=>\s*$/.test(ln) || /:\s*$/.test(ln)) break;
  }
  let sig = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (sig.length > 160) sig = sig.slice(0, 157) + '…';
  return sig || sym.name;
}
// token optimization: collapse runs of blank lines; when !keepComments also drop
// whole-line comments (// … , # … , single-line /* … */). Never touches code.
function optimizeSource(src, keepComments) {
  const out = [];
  let blank = 0;
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (!keepComments &&
        (/^\/\//.test(t) || /^#/.test(t) || (/^\/\*.*\*\/$/.test(t)))) continue;
    if (!t) { blank++; if (blank > 1) continue; } else blank = 0;
    out.push(raw);
  }
  return out.join('\n').trim();
}
// pick seed symbols (query-matched in top-ranked files; else exported top-level of
// the top files) + their forward dependencies (depth-limited call/constructor BFS)
function selectSymbols(graph, query, files, opts) {
  const qtokens = new Set(tokenize(query));
  const rankedFiles = files.slice(0, opts.topFiles || 4).map((f) => f.rel);
  const seen = new Set();
  const seeds = [];
  for (const rel of rankedFiles) {
    for (const id of (graph.fileDefs[rel] || [])) {
      const d = graph.defById[id];
      if (!d || seen.has(id)) continue;
      if (tokenize(d.name).some((t) => qtokens.has(t))) { seen.add(id); seeds.push(id); }
    }
  }
  // SEMANTIC seeds — vector-matched def ids from the caller. These carry the
  // meaning-based matches ("timezone bug" → formatUnixDate) that the lexical
  // name-token match above structurally cannot find.
  for (const id of (opts.vectorIds || [])) {
    if (graph.defById[id] && !seen.has(id)) { seen.add(id); seeds.push(id); }
  }
  if (!seeds.length) {   // no name match → exported/public top-level symbols of the top files
    for (const rel of rankedFiles.slice(0, 2)) {
      for (const id of (graph.fileDefs[rel] || [])) {
        const d = graph.defById[id];
        if (!d || seen.has(id) || d.parent) continue;
        if (d.vis === 'exported' || d.vis === 'public' || d.vis === 'pub') {
          seen.add(id); seeds.push(id);
        }
      }
    }
  }
  const seedIds = seeds.slice(0, opts.maxSeeds || 8);
  const depSet = new Set();
  for (const id of seedIds) {
    for (const nid of forwardReach(graph, id, opts.callDepth || 2, 40)) {
      if (!seen.has(nid)) depSet.add(nid);
    }
  }
  return { seeds: seedIds, deps: [...depSet].slice(0, opts.maxDeps || 12) };
}
// build the packed symbol context. Returns null (→ caller falls back to whole-file)
// when the graph is cold or nothing relevant is found.
function packSymbols(cwd, graph, idx, query, opts = {}) {
  if (!graph || !graph.defs || !graph.defs.length) return null;
  const files = retrieve(idx, query, opts.rankFiles || 12);
  // no lexical hits is fine when the caller brought semantic seeds
  if (!files.length && !(opts.vectorIds && opts.vectorIds.length)) return null;
  const { seeds, deps } = selectSymbols(graph, query, files, opts);
  if (!seeds.length) return null;

  const cache = new Map();
  const keepComments = !!opts.comments;
  const budget = opts.budget || 12000;
  let used = 0;
  const involved = new Set();
  const sigLine = (d) =>
    `- ${d.name} (${d.type} in ${d.rel}:${d.sl}` +
    `${d.parent ? ', ' + d.parent : ''})${d.doc ? ' — ' + d.doc : ''}`;

  const sigLines = [];
  for (const id of [...seeds, ...deps]) {
    const d = graph.defById[id]; if (!d) continue;
    sigLines.push(sigLine(d)); involved.add(d.rel);
  }
  // IMPLEMENTATIONS — seed symbols, full (optimized) source, budget-first
  const impl = [];
  for (const id of seeds) {
    const d = graph.defById[id]; if (!d) continue;
    const src = optimizeSource(symbolSource(cache, cwd, d, opts.maxLines || 120), keepComments);
    if (!src) continue;
    const block = `===== ${d.rel} :: ${d.name} (${d.sl}-${d.el}) =====\n${src}`;
    if (used + block.length > budget) break;
    used += block.length; impl.push(block);
  }
  if (!impl.length) return null;   // couldn't read any seed source → fall back
  // DEPENDENCIES — full body if it fits, else signature-only (token optimization)
  const depBlocks = [];
  for (const id of deps) {
    const d = graph.defById[id]; if (!d) continue;
    const src = optimizeSource(symbolSource(cache, cwd, d, 60), keepComments);
    let block;
    if (src && used + src.length + 80 <= budget) {
      block = `===== ${d.rel} :: ${d.name} (${d.sl}-${d.el}) =====\n${src}`;
    } else {
      block = `----- ${d.rel} :: ${d.name} — ${signatureOf(cache, cwd, d)}`;
    }
    if (used + block.length > budget) break;
    used += block.length; depBlocks.push(block);
  }
  const map = repoMapSymbols(graph, { files: [...involved], maxFiles: 30, perFile: 12 });
  return {
    seedCount: seeds.length, depCount: deps.length, chars: used,
    files: involved.size, map, sigLines, impl, depBlocks,
  };
}
// render a pack into the prompt block, in the spec's order:
// repo map → signatures → implementations → dependencies
function formatSymbolContext(pack) {
  const parts = [];
  if (pack.map) {
    parts.push('REPO MAP (symbols — orientation only, do not re-list):\n' + pack.map);
  }
  if (pack.sigLines.length) {
    parts.push('RELEVANT SYMBOLS (signatures):\n' + pack.sigLines.join('\n'));
  }
  if (pack.impl.length) {
    parts.push('IMPLEMENTATIONS (the symbols this task touches — already loaded, ' +
      'do NOT re-open the files):\n' + pack.impl.join('\n\n'));
  }
  if (pack.depBlocks.length) {
    parts.push('DEPENDENCIES (called/constructed by the above; ' +
      'signature-only lines start with -----):\n' + pack.depBlocks.join('\n\n'));
  }
  return parts.join('\n\n');
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
    // build the code graph in the background too, then bootstrap vectors off it
    ensureGraph(cwd).then((g) => maybeBootstrapVectors(cwd, g)).catch(() => {});
    return { ok: true, cached: existed, files: Object.keys(idx.files).length };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// watch the project for new/removed files and keep the map fresh (incrementally).
// Debounced; skips node_modules/.git/etc. One recursive watcher per repo.
ipcMain.handle('symbol-watch', async (_e, cwd) => {
  try {
    if (symbolWatchers[cwd]) return { ok: true, already: true };
    await loadOrBuildIndex(cwd);
    // keep the code graph warm for this project, then bootstrap vectors off it
    ensureGraph(cwd).then((g) => maybeBootstrapVectors(cwd, g)).catch(() => {});
    const state = { timer: null, pending: new Set() };
    const flush = async () => {
      const idx = symbolCache[cwd]; if (!idx) { state.pending.clear(); return; }
      const paths = [...state.pending]; state.pending.clear();
      let changed = 0;
      const graph = graphCache[cwd];
      let gChanged = false;
      for (const abs of paths) {
        const rel = path.relative(cwd, abs).replace(/\\/g, '/');
        try {
          const st = await fs.promises.stat(abs);
          if (st.isFile()) {
            if (await indexOneFile(cwd, abs)) changed++;
            if (await reparseFileInGraph(cwd, abs)) gChanged = true;
          }
        } catch {                      // gone → remove from index + graph
          if (idx.files[rel]) { delete idx.files[rel]; invCache.delete(idx); changed++; }
          if (graph) { removeFileFromGraph(graph, rel); indexGraph(graph); gChanged = true; }
        }
      }
      if (changed) {
        recomputeAvgLen(idx);
        await persistIndex(cwd, idx);
        send('symbol-updated', { cwd, files: Object.keys(idx.files).length, changed });
      }
      if (gChanged && graph) {
        try { await persistGraph(cwd, graph); } catch {}
        // keep the semantic vectors in step — re-embed only the changed files, in
        // a worker so the ~seconds of embed + rewrite never freeze the UI. Fire
        // and forget; the watcher must not block on it.
        if (V.hasVectorIndex(indexDir(cwd))) {
          const rels = paths.map((abs) => path.relative(cwd, abs).replace(/\\/g, '/'));
          // ship the changed files' defs with the job — the worker then skips
          // re-reading + JSON.parsing the whole codegraph.json per save burst
          const defs = [];
          for (const rel of rels) {
            for (const id of (graph.fileDefs[rel] || [])) {
              if (graph.defById[id]) defs.push(graph.defById[id]);
            }
          }
          runVectorJob(cwd, { job: 'sync', dir: indexDir(cwd), rels, defs })
            .then((m) => {
              if (m && m.ok) { V.invalidateCache(); send('vector-updated', { cwd, count: m.count }); }
            })
            .catch(() => {});
        }
      }
    };
    let watcher;
    try {
      watcher = fs.watch(cwd, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (rel.split('/').some((p) => skipDir(cwd, p))) return;
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

// ===== Code-graph controls for the status bar =====
// regression-impact: the LEAN per-run query every agent launch hits (cached
// graph only, never a build). codegraph-build: user-triggered rebuild with a
// progress stream. codegraph-status: precomputed? watcher running? last built?
const graphManualBuilding = {};   // cwd -> true while a user-triggered rebuild runs

ipcMain.handle('regression-impact', async (_e, { cwd, prompt }) => {
  try {
    if (!cwd) return { ok: true, impact: '' };
    const idx = await loadOrBuildIndex(cwd);
    const files = retrieve(idx, prompt || '', 8);
    const impact = regressionImpact(getGraphForQuery(cwd), idx, files);
    ensureGraph(cwd).catch(() => {});   // warm for next time; never blocks the run
    return { ok: true, impact };
  } catch (e) { return { ok: false, impact: '', error: String(e && e.message ? e.message : e) }; }
});

ipcMain.handle('codegraph-status', (_e, cwd) => {
  if (!cwd) {
    return {
      ok: true, built: false, empty: false, building: false, watching: false,
      lastBuilt: 0, files: 0, broken: false, error: ''
    };
  }
  let g = graphCache[cwd];
  if (!g) g = loadGraphDisk(cwd);
  return {
    ok: true,
    built: !!(g && g.defs && g.defs.length),
    // a build DID complete but yielded no symbols (grammar failures or no
    // supported languages) — the UI must not repaint this as "never built"
    empty: !!(g && g.built && g.defs && !g.defs.length),
    building: !!graphBuilding[cwd] || !!graphManualBuilding[cwd],
    watching: !!symbolWatchers[cwd],
    lastBuilt: g && g.built ? g.built : 0,
    files: g && g.defs ? g.defs.length : 0,
    broken: !!tsBroken,
    error: tsBroken ? tsInitError : ''
  };
});

// One PERSISTENT embedding worker for ALL vector work (build / sync / query). The
// model loads once and stays resident OFF the main thread, so neither building nor
// querying ever freezes the UI. Jobs are serialized inside the worker. `payload`
// carries { job, dir, ... }; onProgress fires for build progress.
let _vecWorker = null;
const _vecReqs = new Map();
let _vecReqId = 0;
// Absolute dir of the bundled embedding model. In the packaged app the model
// ships as extraResources (resources/local_cache/...) on real disk — it can't
// live inside app.asar because onnxruntime reads the .onnx via native code, not
// Electron's asar-patched fs. In dev it sits next to the source.
function embedModelDir() {
  const rel = ['local_cache', 'fast-bge-small-en-v1.5'];
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, ...rel) : '';
  const dev = path.join(__dirname, ...rel);
  try {
    if (packaged && fs.existsSync(path.join(packaged, 'model_optimized.onnx'))) {
      return packaged;
    }
  } catch {}
  return dev;
}

function vecWorker() {
  if (_vecWorker) return _vecWorker;
  const w = new Worker(path.join(__dirname, 'vectors-worker.js'),
    { workerData: { modelDir: embedModelDir() } });
  w.on('message', (m) => {
    const req = _vecReqs.get(m.id);
    if (!req) return;
    if (m.type === 'progress') { if (req.onProgress) req.onProgress(m.done, m.total); }
    else if (m.type === 'done') { _vecReqs.delete(m.id); req.resolve(m); }
  });
  const fail = (err) => {
    for (const [, req] of _vecReqs) req.resolve({ ok: false, error: err });
    _vecReqs.clear(); _vecWorker = null;   // allow a fresh spawn next request
  };
  w.on('error', (e) => fail(String(e && e.message || e)));
  w.on('exit', () => fail('vector worker exited'));
  _vecWorker = w;
  return w;
}
function runVectorJob(cwd, payload, onProgress) {
  return new Promise((resolve) => {
    const id = ++_vecReqId;
    _vecReqs.set(id, { resolve, onProgress });
    try { vecWorker().postMessage({ id, ...payload }); }
    catch (e) { _vecReqs.delete(id); resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

// build the semantic vector index over a fresh graph — off-thread, deduped,
// progress-reported. Never awaited on a hot path (embedding is CPU-heavy).
const vectorBuilding = {};
function buildVectorsBg(cwd, graph) {
  if (!cwd || !graph || !graph.defs || !graph.defs.length) return;
  if (vectorBuilding[cwd]) return;
  vectorBuilding[cwd] = true;
  const total = graph.defs.length || 1;
  send('vector-progress', { cwd, done: 0, total, phase: 'build' });
  runVectorJob(cwd, { job: 'build', dir: indexDir(cwd) },
    (done, t) => send('vector-progress', { cwd, done, total: t || total, phase: 'build' }))
    .then((m) => {
      V.invalidateCache();   // worker rewrote the file — drop main's stale copy
      // ALWAYS report completion (ok true/false) so the bar finalizes instead of
      // hanging at "vectors 0%" when embedding is unavailable.
      send('vector-updated', { cwd, count: (m && m.count) || 0, ok: !!(m && m.ok), error: m && m.error });
    })
    .finally(() => { delete vectorBuilding[cwd]; });
}

// auto-bootstrap: RAG stayed lexical-only forever unless a user manually clicked
// "build graph" — kick a first-time vector build once a graph is available on open.
// No-op once an index exists (watch-sync keeps it fresh) or while one is building.
function maybeBootstrapVectors(cwd, graph) {
  try {
    if (!cwd || !graph || !graph.defs || !graph.defs.length) return;
    if (V.hasVectorIndex(indexDir(cwd))) return;
    if (vectorBuilding[cwd]) return;
    buildVectorsBg(cwd, graph);
  } catch {}
}

ipcMain.handle('codegraph-build', async (_e, cwd) => {
  if (!cwd) return { ok: false, error: 'no project open' };
  if (graphManualBuilding[cwd] || graphBuilding[cwd]) return { ok: false, error: 'already building' };
  graphManualBuilding[cwd] = true;
  // a manual rebuild is the retry gesture — clear any prior stuck failure and
  // respawn the parse worker so tree-sitter init gets re-attempted fresh
  tsBroken = false; tsInitError = ''; tsInitErrorLogged = false;
  resetGraphWorker();
  try {
    delete graphCache[cwd];   // force a fresh parse (buildCodeGraph repopulates + persists)
    const graph = await buildCodeGraph(cwd, (done, total) => send('codegraph-progress', { cwd, done, total }));
    if (tsBroken) return { ok: false, error: tsInitError || 'tree-sitter unavailable' };
    send('codegraph-updated', { cwd });
    buildVectorsBg(cwd, graph);   // refresh semantic vectors off the new graph
    return { ok: true, files: graph && graph.defs ? graph.defs.length : 0, lastBuilt: graph ? graph.built : 0 };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally { delete graphManualBuilding[cwd]; }
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
// NAMES + SYMBOLS only, never file contents — the push is a map by design; the
// agent pulls code via mcp__deck__* (the old withContent inlining is gone so
// nothing can quietly regress back to whole-file dumping).
ipcMain.handle('retrieve-context', async (_e, { cwd, query, k }) => {
  try {
    const idx = await loadOrBuildIndex(cwd);
    const files = retrieve(idx, query, k || 8);
    // regression blast-radius from the cached code graph (never triggers a build here);
    // background-refresh it for next time so a cold first run still returns via fallback.
    const impact = regressionImpact(getGraphForQuery(cwd), idx, files);
    ensureGraph(cwd).catch(() => {});
    return { ok: true, files, repoMap: repoMapFromIndex(idx, cwd), impact };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), files: [] }; }
});

// ===== Retrieval eval loop — hit@k of pre-ranked files vs files actually edited =====
// The runs themselves generate labels for free: the renderer records what
// retrieval PREDICTED at launch and which files the agent actually EDITED, and
// logs one JSONL line per qualifying run here. This is the measurement loop
// for retrieval quality — read .loveai/index/retrieval-eval.jsonl (or call
// eval-stats) before/after tuning ranking to see whether a change helped.
ipcMain.handle('eval-log', async (_e, { cwd, entry }) => {
  try {
    if (!cwd || !entry) return { ok: false };
    const dir = indexDir(cwd);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(path.join(dir, 'retrieval-eval.jsonl'),
      JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});
ipcMain.handle('eval-stats', async (_e, cwd) => {
  try {
    const p = path.join(indexDir(cwd), 'retrieval-eval.jsonl');
    const lines = (await fs.promises.readFile(p, 'utf8')).trim().split('\n');
    const entries = lines.slice(-200)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const n = entries.length;
    const avg = (f) => n
      ? +(entries.reduce((a, e) => a + (f(e) || 0), 0) / n).toFixed(3) : 0;
    return {
      ok: true, runs: n,
      hit5: avg((e) => e.hit5), hit10: avg((e) => e.hit10),
      last: entries.slice(-5),
    };
  } catch { return { ok: true, runs: 0, hit5: 0, hit10: 0, last: [] }; }
});

// SYMBOL-LEVEL context (tree-sitter): the minimum symbols a request needs +
// their dependencies, instead of whole files. Graph-gated — returns
// { ok, ready:false } when the graph is cold so the renderer keeps the whole-file
// path; still warms the graph in the background for next time.
ipcMain.handle('retrieve-symbols', async (_e, { cwd, query, budget, comments }) => {
  try {
    if (!cwd) return { ok: true, ready: false };
    const idx = await loadOrBuildIndex(cwd);
    const graph = getGraphForQuery(cwd);
    ensureGraph(cwd).catch(() => {});           // warm for next time; never blocks
    if (!graph || !graph.defs || !graph.defs.length) return { ok: true, ready: false };
    // semantic seeds close the gap where no query token matches any symbol name
    const vectorIds = (await workerVectorHits(cwd, query || '', 24)).map((h) => h.id);
    const pack = packSymbols(cwd, graph, idx, query || '', {
      budget: budget || 12000, comments: !!comments, vectorIds,
    });
    if (!pack) return { ok: true, ready: false };
    return {
      ok: true, ready: true, context: formatSymbolContext(pack),
      stats: { seeds: pack.seedCount, deps: pack.depCount, files: pack.files, chars: pack.chars },
    };
  } catch (e) {
    return { ok: false, ready: false, error: String(e && e.message ? e.message : e) };
  }
});

// ===== Semantic vector retrieval + single-shot planning =====
ipcMain.handle('vector-status', (_e, cwd) => {
  return { ok: true, exists: cwd ? V.hasVectorIndex(indexDir(cwd)) : false };
});

ipcMain.handle('vector-build', async (_e, cwd) => {
  try {
    if (!cwd) return { ok: false, error: 'no project' };
    const graph = await ensureGraph(cwd);   // ensures codegraph.json exists on disk
    if (!graph || !graph.defs || !graph.defs.length) return { ok: false, error: 'no code graph' };
    if (vectorBuilding[cwd]) return { ok: false, error: 'already building' };
    vectorBuilding[cwd] = true;
    send('vector-progress', { cwd, done: 0, total: graph.defs.length || 1, phase: 'build' });
    try {
      const m = await runVectorJob(cwd, { job: 'build', dir: indexDir(cwd) },
        (d, t) => send('vector-progress', { cwd, done: d, total: t }));
      V.invalidateCache();
      send('vector-updated', { cwd, count: (m && m.count) || 0, ok: !!(m && m.ok), error: m && m.error });
      return m || { ok: false };
    } finally { delete vectorBuilding[cwd]; }
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

ipcMain.handle('vector-query', async (_e, { cwd, query: q, k }) => {
  try {
    if (!cwd || !q) return { ok: true, ready: false, hits: [] };
    // query runs in the persistent worker — never loads the model on the main
    // thread. hits === null means the index isn't built yet (vs. built-but-no-match).
    const m = await runVectorJob(cwd, { job: 'query', dir: indexDir(cwd), query: q, k: k || 30 });
    return {
      ok: !!m.ok, ready: Array.isArray(m.hits),
      hits: Array.isArray(m.hits) ? m.hits : [],
      // when hits are absent, these say WHY: index on disk? embedder error?
      indexed: !!m.indexed, embedErr: m.embedErr || '',
    };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), hits: [] }; }
});

// vector hits for a query via the persistent WORKER — the main process must
// NEVER call V.queryVectors directly: that lazily loads a second copy of the
// ONNX model on the main thread (seconds of jank + double memory).
async function workerVectorHits(cwd, q, k) {
  const m = await runVectorJob(cwd, { job: 'query', dir: indexDir(cwd), query: q, k });
  return (m && Array.isArray(m.hits)) ? m.hits : [];
}

// Fuse semantic (vector) + lexical (BM25) file rankings via reciprocal-rank fusion.
// Vector catches meaning ("timezone bug" -> formatUnixDate); BM25 nails exact
// identifiers. Pure local math, no LLM. Returns { idx, files:[{rel,...}], symbolHits }.
async function fuseRetrieval(cwd, q, k) {
  const idx = await loadOrBuildIndex(cwd);
  const bm = retrieve(idx, q, (k || 8) * 2);
  const symbolHits = await workerVectorHits(cwd, q, (k || 8) * 4);
  const vBest = new Map();
  for (const h of symbolHits) {
    const rel = h.id.slice(0, h.id.lastIndexOf('#'));
    if (!vBest.has(rel) || vBest.get(rel) < h.score) vBest.set(rel, h.score);
  }
  const vfiles = [...vBest.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const RRF = 60, score = new Map(), meta = new Map();
  bm.forEach((f, i) => { score.set(f.rel, (score.get(f.rel) || 0) + 1 / (RRF + i)); meta.set(f.rel, f); });
  vfiles.forEach((rel, i) => { score.set(rel, (score.get(rel) || 0) + 1 / (RRF + i)); });
  const files = [...score.keys()]
    .sort((a, b) => score.get(b) - score.get(a))
    .slice(0, k || 8)
    .map((rel) => meta.get(rel) || { rel });
  return { idx, files, symbolHits };
}

// Deterministic, LLM-free context bundle for the planner: fused ranked files +
// implementations of the top semantic symbols + regression impact. This is the
// package that replaces 32 turns of agentic grep/read with one prepared payload.
async function buildPlanContext(cwd, q, opts = {}) {
  const { idx, files, symbolHits } = await fuseRetrieval(cwd, q, opts.files || 10);
  const graph = getGraphForQuery(cwd);
  const cache = new Map();
  const parts = [];
  parts.push('RANKED FILES (semantic + lexical fusion):\n' +
    files.map((f) => `- ${f.rel}`).join('\n'));
  if (graph && graph.defById && symbolHits.length) {
    const seen = new Set();
    const blocks = [];
    let budget = opts.budget || 16000;
    for (const h of symbolHits) {
      if (budget <= 0) break;
      const d = graph.defById[h.id];
      if (!d || seen.has(d.id)) continue;
      seen.add(d.id);
      const src = symbolSource(cache, cwd, d, 120);
      if (!src) continue;
      const block = `===== ${d.rel} :: ${d.name} (${d.type}, ${d.sl}-${d.el}) =====\n${src}`;
      if (block.length > budget) continue;
      budget -= block.length;
      blocks.push(block);
    }
    if (blocks.length) parts.push('KEY SYMBOLS (implementations):\n' + blocks.join('\n\n'));
  }
  const impact = regressionImpact(graph, idx, files);
  if (impact) parts.push('REGRESSION IMPACT (who references what you may change):\n' + impact);
  const text = parts.join('\n\n');
  return { text, files: files.map((f) => f.rel), chars: text.length };
}

// expose the deterministic bundle on its own (preview / debugging / renderer reuse)
ipcMain.handle('plan-context', async (_e, { cwd, issue }) => {
  try { return { ok: true, ...(await buildPlanContext(cwd, issue, {})) }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});

// SINGLE-SHOT plan: deterministic context in, ONE tool-less LLM call out. No agent
// loop, no grep/read turns, no transcript re-read pileup — the token-light
// replacement for the agentic prompt-engineer. Returns { ok, text, usage, cost }.
ipcMain.handle('plan-generate', async (_e, { cwd, issue, model, effort }) => {
  await sdkReady;
  try {
    if (!cwd || !issue) return { ok: false, error: 'cwd and issue required' };
    const ctx = await buildPlanContext(cwd, issue, {});
    const sys =
      'You are a planning engineer. Using ONLY the context provided, produce a ' +
      'precise implementation plan: root cause, the exact files/symbols to change, ' +
      'the change per file, and regression risks. The context is complete — do NOT ' +
      'ask to explore. Be concrete and terse.';
    const prompt =
      `ISSUE:\n${issue}\n\n` +
      `CONTEXT (retrieved deterministically — this is everything you get):\n${ctx.text}`;
    const opts = {
      model: model || 'claude-opus-4-8',
      cwd,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: sys },
      settingSources: ['project'],
      maxTurns: 1,
      allowedTools: [],            // NO tools → single turn, no agentic exploration
      includePartialMessages: false,
    };
    if (CLAUDE_EXE) opts.pathToClaudeCodeExecutable = CLAUDE_EXE;
    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (effort && EFFORTS.includes(effort)) opts.effort = effort;
    let text = '', usage = null, cost = 0;
    for await (const msg of query({ prompt, options: opts })) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content || []) if (b.type === 'text') text += b.text;
      } else if (msg.type === 'result') {
        usage = msg.usage || null;
        cost = msg.total_cost_usd || msg.cost_usd || 0;
        if (msg.subtype === 'success' && !text && msg.result) text = msg.result;
      }
    }
    return { ok: true, text: text.trim(), ctxChars: ctx.chars, files: ctx.files, usage, cost };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
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

// full transcript of one stored session, read back from ~/.claude/projects/*/<id>.jsonl —
// used both when the operator resumes a session and when a stale resume needs its
// context reconstructed (see readSessionTranscript below)
function readSessionTranscript(sessionId, limit = 80) {
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
  return msgs.slice(-limit);
}

ipcMain.handle('session-load', (_e, sessionId) => readSessionTranscript(sessionId, 80));

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
    // user's core.editor may be a Windows abs path MINGW can't parse;
    // override per-terminal only (no global git config writes).
    // LOVEAI_BRIDGE_* lets any CLI in this terminal drive the in-app browser
    // (browserctl.js / raw HTTP) without hunting for the info file.
    env: {
      ...process.env,
      GIT_EDITOR: 'notepad', GIT_SEQUENCE_EDITOR: 'notepad',
      LOVEAI_BRIDGE_PORT: String(BRIDGE_PORT || ''),
      LOVEAI_BRIDGE_TOKEN: BRIDGE_TOKEN
    }
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
      // NOT the claude_code preset: that system prompt costs ~10k+ tokens and
      // buys nothing here — this path is tool-less one-shot text generation
      // (commit messages, PR bodies, fix routing), so a tiny prompt suffices.
      systemPrompt: 'You are a text generator. Reply with ONLY the requested ' +
        'text — no preamble, no explanations, no markdown fences.',
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

// ============================================================
// DECK RETRIEVAL TOOLS — in-process MCP server (pull-model context)
// ============================================================
// Instead of front-loading a big pre-computed context blob into the first
// prompt (push), the agent queries the project's LOCAL index mid-task, when
// it knows what it's actually looking for. Handlers run in this process —
// no network, no subprocess; typical answer in milliseconds. All tools are
// read-only so the model can batch them with other reads.
function deckToolText(text) {
  return { content: [{ type: 'text', text: String(text || '(no results)') }] };
}
function deckToolErr(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

// score topics the way the renderer's memoryInject does: token overlap on
// title/keywords/files, phrase-boost on keywords. Local heuristic, no LLM.
function deckTopicHits(cwd, q, n) {
  const dir = path.join(cwd, '.loveai', 'memory', 'topics');
  if (!fs.existsSync(dir)) return [];
  const qtokens = String(q).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const ql = String(q).toLowerCase();
  const scored = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const t = memParseTopic(fs.readFileSync(path.join(dir, f), 'utf8'));
    const hay = `${t.title} ${t.keywords} ${t.files.join(' ')}`.toLowerCase();
    let s = 0;
    for (const w of qtokens) if (hay.includes(w)) s++;
    for (const kw of (t.keywords || '').toLowerCase().split(',')) {
      const k = kw.trim(); if (k && ql.includes(k)) s += 2;
    }
    if (s > 0) scored.push({ t: { ...t, slug: f.replace(/\.md$/, '') }, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, n).map(x => x.t);
}

function buildDeckServer(cwd) {
  if (!sdkTool || !createSdkMcpServer || !z || !cwd) return null;
  const RO = { annotations: { readOnlyHint: true } };

  const searchCode = sdkTool(
    'search_code',
    'Search this project\'s prebuilt code index (BM25 lexical + semantic ' +
    'vector fusion). Returns ranked files with their symbols plus the top ' +
    'symbol-level matches. Instant and indexed — prefer this over Glob/Grep ' +
    'for DISCOVERY; use Grep/Read to verify exact code afterwards.',
    {
      query: z.string().describe('What you are looking for — feature, symbol, error text, concept'),
      k: z.number().int().min(1).max(30).default(10).describe('How many files to return')
    },
    async (args) => {
      try {
        const { idx, files, symbolHits } = await fuseRetrieval(cwd, args.query, args.k);
        if (!files.length && !symbolHits.length) {
          return deckToolText('No index matches — fall back to Grep/Glob.');
        }
        const fLines = files.map(f =>
          `- ${f.rel}${f.symbols && f.symbols.length ? ' — ' + f.symbols.slice(0, 8).join(', ') : ''}`);
        const sLines = symbolHits.slice(0, 12).map(h => `- ${h.id} (${h.score.toFixed(2)})`);
        const capNote = idx && idx.truncated
          ? `\n\n[PARTIAL INDEX — capped at ${INDEX_MAX_FILES} files; a miss here ` +
            `does not mean the code doesn't exist. Verify with Grep.]`
          : '';
        return deckToolText(
          `RANKED FILES (lexical+semantic fusion):\n${fLines.join('\n')}` +
          (sLines.length ? `\n\nTOP SYMBOL MATCHES:\n${sLines.join('\n')}` : '') +
          capNote);
      } catch (e) { return deckToolErr('search_code failed: ' + (e && e.message ? e.message : e)); }
    },
    RO
  );

  const getSymbols = sdkTool(
    'get_symbols',
    'Get the tree-sitter SYMBOL PACK for a topic: the implementations a ' +
    'request needs plus their dependencies, extracted from the code graph — ' +
    'actual code, not just file names. Use after search_code narrows the area.',
    {
      query: z.string().describe('Feature/symbol/topic to pull implementations for'),
      budget: z.number().int().min(2000).max(30000).default(12000)
        .describe('Max characters of code to return')
    },
    async (args) => {
      try {
        const idx = await loadOrBuildIndex(cwd);
        const graph = getGraphForQuery(cwd);
        ensureGraph(cwd).catch(() => {});
        if (!graph || !graph.defs || !graph.defs.length) {
          return deckToolText('Code graph not built yet — use search_code + Read instead.');
        }
        // fuse in semantic seeds so meaning-only queries (no name overlap) pack too
        const vectorIds = (await workerVectorHits(cwd, args.query, 24)).map((h) => h.id);
        const pack = packSymbols(cwd, graph, idx, args.query, {
          budget: args.budget, vectorIds,
        });
        if (!pack) return deckToolText('Nothing relevant in the graph for that query.');
        return deckToolText(formatSymbolContext(pack));
      } catch (e) { return deckToolErr('get_symbols failed: ' + (e && e.message ? e.message : e)); }
    },
    RO
  );

  const whoReferences = sdkTool(
    'who_references',
    'Regression blast-radius: which symbols match this query and what ' +
    'calls/imports them across the project (from the cached code graph). ' +
    'Check BEFORE changing a shared symbol.',
    { query: z.string().describe('Symbol name, file, or feature you intend to change') },
    async (args) => {
      try {
        const idx = await loadOrBuildIndex(cwd);
        const files = retrieve(idx, args.query, 8);
        const impact = regressionImpact(getGraphForQuery(cwd), idx, files);
        ensureGraph(cwd).catch(() => {});
        return deckToolText(impact && impact.trim()
          ? impact : 'No reference data (graph cold or no matches).');
      } catch (e) { return deckToolErr('who_references failed: ' + (e && e.message ? e.message : e)); }
    },
    RO
  );

  const topicMemory = sdkTool(
    'topic_memory',
    'Feature notes previous runs recorded in .loveai/memory/topics — flows, ' +
    'key paths, step-by-steps. Check before re-exploring a known feature.',
    { query: z.string().describe('Feature or area you are working on') },
    async (args) => {
      try {
        const hits = deckTopicHits(cwd, args.query, 2);
        if (!hits.length) return deckToolText('No topic memory matches.');
        return deckToolText(hits.map(t =>
          `=== MEMORY: ${t.title || t.slug} ===\n${t.body}`).join('\n\n'));
      } catch (e) { return deckToolErr('topic_memory failed: ' + (e && e.message ? e.message : e)); }
    },
    RO
  );

  return createSdkMcpServer({
    name: 'deck',
    version: '1.0.0',
    tools: [searchCode, getSymbols, whoReferences, topicMemory]
  });
}

// ===== browser MCP server — the bridge as in-process agent tools ==========
// Same idea as Playwright MCP but against the app's OWN sandbox browser:
// zero spawn cost, instant commands, shares the user's live session/tabs.
let browserServerCache = null;
function buildBrowserServer() {
  if (!sdkTool || !createSdkMcpServer || !z) return null;
  if (browserServerCache) return browserServerCache;
  const RO = { annotations: { readOnlyHint: true } };
  const out = r => deckToolText(typeof r === 'string' ? r : JSON.stringify(r));
  const run = async cmd => {
    try { return out(await bridgeDispatch(cmd)); }
    catch (e) { return deckToolErr('bridge failed: ' + (e.message || e)); }
  };
  const target = {
    tabId: z.string().optional()
      .describe('Tab id from browser_tabs — omit for the active tab')
  };

  const tabsTool = sdkTool(
    'browser_tabs',
    'List the in-app sandbox browser tabs (id, url, title, project, active). ' +
    'Start here to pick a target tab.',
    {},
    () => run({ op: 'tabs' }),
    RO
  );
  const openTool = sdkTool(
    'browser_open',
    'Open a URL in the in-app browser. Reuses an existing tab showing the ' +
    'same URL unless reuse=false. Returns the tab id.',
    {
      url: z.string().describe('URL — bare hosts get a scheme (localhost → http)'),
      reuse: z.boolean().default(true)
        .describe('Focus an existing tab with this URL instead of opening a duplicate')
    },
    a => run({ op: 'open', url: a.url, reuse: a.reuse }),
  );
  const navTool = sdkTool(
    'browser_navigate',
    'Navigate the active (or given) tab: to a URL, or back / forward / reload.',
    {
      ...target,
      url: z.string().optional().describe('Destination URL (omit when using action)'),
      action: z.enum(['back', 'forward', 'reload']).optional()
    },
    a => run({ op: 'navigate', tabId: a.tabId, url: a.url, action: a.action }),
  );
  const snapshotTool = sdkTool(
    'browser_snapshot',
    'Accessibility-style outline of the page: headings + every interactive ' +
    'element with a stable ref (ref=eN). Use refs with browser_click / ' +
    'browser_fill. Retake after navigation — refs reset. mode "full" also ' +
    'includes visible text blocks.',
    {
      ...target,
      mode: z.enum(['interactive', 'full']).default('interactive'),
      maxChars: z.number().int().min(1000).max(60000).default(20000)
    },
    a => run({ op: 'snapshot', tabId: a.tabId, mode: a.mode, maxChars: a.maxChars }),
    RO
  );
  const clickTool = sdkTool(
    'browser_click',
    'Click an element — by snapshot ref (best), CSS selector, or visible text.',
    {
      ...target,
      ref: z.string().optional().describe('ref from browser_snapshot, e.g. "e12"'),
      selector: z.string().optional().describe('CSS selector'),
      text: z.string().optional().describe('visible text of the element')
    },
    a => run({ op: 'click', tabId: a.tabId, ref: a.ref, selector: a.selector, text: a.text }),
  );
  const fillTool = sdkTool(
    'browser_fill',
    'Set an input / textarea / select / contenteditable value (fires proper ' +
    'input+change events so React/Vue see it). submit=true presses Enter after.',
    {
      ...target,
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.string(),
      submit: z.boolean().default(false)
    },
    a => run({
      op: 'fill', tabId: a.tabId, ref: a.ref, selector: a.selector,
      value: a.value, submit: a.submit
    }),
  );
  const pressTool = sdkTool(
    'browser_press',
    'Send a REAL key event to the page (goes through Chromium input, so ' +
    'default actions like form submit fire). Keys: Enter, Tab, Escape, ' +
    'ArrowDown, a, … Optionally focus a ref/selector first.',
    { ...target, key: z.string(), ref: z.string().optional(), selector: z.string().optional() },
    a => run({ op: 'press', tabId: a.tabId, key: a.key, ref: a.ref, selector: a.selector }),
  );
  const evalTool = sdkTool(
    'browser_eval',
    'Evaluate JavaScript in the page and return the JSON-serialized result. ' +
    'Accepts an expression or statements (use `return` with statements).',
    { ...target, code: z.string() },
    a => run({ op: 'eval', tabId: a.tabId, code: a.code }),
  );
  const consoleTool = sdkTool(
    'browser_console',
    'Read the page\'s buffered console messages (level, message, source). ' +
    'clear=true empties the buffer after reading.',
    {
      ...target,
      limit: z.number().int().min(1).max(500).default(50),
      clear: z.boolean().default(false)
    },
    a => run({ op: 'console', tabId: a.tabId, limit: a.limit, clear: a.clear }),
    RO
  );
  const networkTool = sdkTool(
    'browser_network',
    'Recent network requests from the sandbox browser (method, url, status, ' +
    'ms, errors). Filter by URL substring.',
    {
      filter: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      since: z.number().optional().describe('only requests after this epoch-ms')
    },
    a => run({ op: 'network', filter: a.filter, limit: a.limit, since: a.since }),
    RO
  );
  const screenshotTool = sdkTool(
    'browser_screenshot',
    'Screenshot the tab to a PNG file and return its absolute path (activates ' +
    'the tab first — hidden guests capture blank). View it with the Read tool.',
    { ...target, path: z.string().optional().describe('absolute .png path (default: temp)') },
    a => run({ op: 'screenshot', tabId: a.tabId, path: a.path }),
    RO
  );
  const waitTool = sdkTool(
    'browser_wait_for',
    'Wait until a condition holds: selector present, text visible, URL ' +
    'contains, selector gone, or page load finished.',
    {
      ...target,
      selector: z.string().optional(),
      text: z.string().optional(),
      urlContains: z.string().optional(),
      gone: z.string().optional().describe('CSS selector that must disappear'),
      load: z.boolean().optional().describe('true = wait for loading to finish'),
      timeoutMs: z.number().int().min(100).max(60000).default(10000)
    },
    a => run({
      op: 'waitFor', tabId: a.tabId, selector: a.selector, text: a.text,
      urlContains: a.urlContains, gone: a.gone, load: a.load, timeoutMs: a.timeoutMs
    }),
    RO
  );

  browserServerCache = createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tabsTool, openTool, navTool, snapshotTool, clickTool, fillTool,
      pressTool, evalTool, consoleTool, networkTool, screenshotTool, waitTool
    ]
  });
  return browserServerCache;
}

ipcMain.handle('agent-run', async (_e, cfg) => {
  // cfg: { runId, agentId, prompt, model, cwd, rules, permissionMode, resumeSessionId }
  await sdkReady;
  const abortController = new AbortController();
  runs.set(cfg.runId, { abortController });

  const CONCISE_RULE = 'OUTPUT DISCIPLINE: be terse. No preamble, no recap of ' +
    'the task, no summary of steps already visible in tool calls. State only what ' +
    'changed and why, briefly. Output tokens cost ~5x input.';
  const appendRules = [cfg.rules, cfg.concise ? CONCISE_RULE : '']
    .filter(Boolean).join('\n\n');
  const options = {
    model: cfg.model,
    cwd: cfg.cwd || process.env.USERPROFILE,
    permissionMode: cfg.permissionMode || 'acceptEdits',
    abortController,
    systemPrompt: appendRules
      ? { type: 'preset', preset: 'claude_code', append: appendRules }
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
    // force the run cwd to the session's home so its project slug matches and the
    // CLI can find the id — only when a real stored cwd came through. Fresh-retry
    // paths delete cfg.resume, so they keep the original options.cwd.
    if (typeof cfg.resumeCwd === 'string' && cfg.resumeCwd) options.cwd = cfg.resumeCwd;
    if (cfg.forkSession) options.forkSession = true;
  }
  // PULL RETRIEVAL — the project's local index as in-process tools the agent
  // calls mid-task (bound to the PROJECT cwd, not the session-slug cwd).
  // Replaces most of the old front-loaded context blob; see buildDeckServer.
  const deckServer = buildDeckServer(cfg.cwd);
  if (deckServer) {
    options.mcpServers = { deck: deckServer };
    options.allowedTools = ['mcp__deck__*'];
  }
  // in-app browser bridge — every agent can see/drive the sandbox browser
  const browserServer = buildBrowserServer();
  if (browserServer) {
    options.mcpServers = { ...(options.mcpServers || {}), browser: browserServer };
    options.allowedTools = [...(options.allowedTools || []), 'mcp__browser__*'];
  }

  const isMissingSession = (s) => /no conversation found with session id/i.test(String(s || ''));

  // when a resume points at a dead session, rebuild the fresh-retry prompt from the
  // dead session's transcript so the follow-up doesn't answer cold
  const STALE_PREAMBLE_CAP = 12000;
  function buildStalePrompt() {
    const prior = cfg.resumeSessionId ? readSessionTranscript(cfg.resumeSessionId, 40) : [];
    if (!prior.length) return { prompt: cfg.prompt, restored: false };
    const ROLE_PREFIX = { user: 'YOU:', assistant: 'ASSISTANT:', tool: 'TOOL:' };
    const lines = prior.map(m => `${ROLE_PREFIX[m.role] || 'TOOL:'} ${m.text}`);
    let body = lines.join('\n');
    while (body.length > STALE_PREAMBLE_CAP && lines.length > 1) {
      lines.shift();
      body = lines.join('\n');
    }
    const preamble = 'Prior conversation context (the stored session could not be ' +
      'resumed — continue as if it is intact):\n' + body;
    return { prompt: preamble + '\n\n---\n\nCurrent request:\n' + cfg.prompt, restored: true };
  }

  // locate each edit hunk's starting line by reading the target file — the
  // tool_use event fires before the edit lands, so old_string is normally
  // still present; new_string covers the already-applied race. null = unknown.
  function hunkLine(txt, probe) {
    if (!txt || !probe) return null;
    const idx = txt.indexOf(probe);
    return idx < 0 ? null : txt.slice(0, idx).split('\n').length;
  }
  function editStartLines(tool, input) {
    try {
      if (tool === 'Write') return [1];
      const file = input.file_path || input.path || '';
      const txt = fs.readFileSync(file, 'utf8');
      const edits = (tool === 'MultiEdit' && Array.isArray(input.edits))
        ? input.edits : [input];
      return edits.map(e => {
        const ln = hunkLine(txt, e.old_string);
        return ln !== null ? ln : hunkLine(txt, e.new_string);
      });
    } catch { return null; }
  }

  // flatten a tool_result block's content (string OR [{type:'text',text}]) to text
  function toolResultText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(x => (x && x.type === 'text') ? x.text : '').join('\n');
    }
    return '';
  }
  // one-line outcome for the console (what the Read/Grep/Bash actually returned)
  function summarizeTool(name, text, input, isError) {
    const t = String(text == null ? '' : text);
    const lines = t ? t.split('\n').filter(l => l.trim() !== '').length : 0;
    if (isError) {
      const first = t.split('\n').map(s => s.trim()).find(Boolean) || 'failed';
      return { ok: false, summary: first.slice(0, 60) };
    }
    const n = (k, one) => lines ? `${lines} ${k}${lines === 1 ? '' : one}` : '';
    switch (name) {
      case 'Read': return { ok: true, summary: n('line', 's') || 'empty file' };
      case 'Grep': {
        const content = input && input.output_mode === 'content';
        if (!lines) return { ok: true, summary: 'nothing found' };
        return { ok: true, summary: content
          ? `found ${lines} match${lines === 1 ? '' : 'es'}`
          : `found in ${lines} file${lines === 1 ? '' : 's'}` };
      }
      case 'Glob': return { ok: true, summary: n('file', 's') || 'nothing found' };
      case 'Bash': case 'PowerShell':
        return { ok: true, summary: 'done' };
      default: return { ok: true, summary: n('line', 's') || 'done' };
    }
  }

  // one pass over the SDK stream. Returns {missingSession, errored} so the caller
  // can retry from scratch when a resume points at a session that no longer exists.
  async function runOnce(opts, forwardEvents, promptOverride) {
    let missingSession = false, errored = false;
    // tool_use id -> {name,input}, so the tool_result (a later 'user' message)
    // can be summarized per-tool and routed back to the right console row
    const toolMeta = {};
    for await (const msg of query({ prompt: promptOverride || cfg.prompt, options: opts })) {
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
            toolMeta[block.id] = { name: block.name, input: block.input };
            const evt = {
              runId: cfg.runId, agentId: cfg.agentId, kind: 'tool',
              id: block.id,
              tool: block.name,
              input: JSON.stringify(block.input).slice(0, 400)
            };
            // edit tools carry their FULL input (plus each hunk's real start
            // line, found by reading the target file) so the renderer can draw
            // a line-numbered diff card — the 400-char cap above truncates
            // old/new_string and would break JSON.parse in the renderer
            if (/^(Edit|MultiEdit|Write)$/.test(block.name)) {
              evt.editInput = JSON.stringify(block.input).slice(0, 400000);
              evt.editLines = editStartLines(block.name, block.input);
            }
            send('agent-event', evt);
          }
        }
        send('agent-event', { runId: cfg.runId, agentId: cfg.agentId, kind: 'text-end' });
      } else if (msg.type === 'user') {
        // tool_result blocks land here — summarize each and route it back to the
        // console row of the tool_use that produced it (matched by tool_use_id)
        const content = msg.message && msg.message.content;
        if (forwardEvents && Array.isArray(content)) {
          for (const block of content) {
            if (!block || block.type !== 'tool_result') continue;
            const meta = toolMeta[block.tool_use_id] || {};
            const { ok, summary } = summarizeTool(
              meta.name || '', toolResultText(block), meta.input, !!block.is_error);
            send('agent-event', {
              runId: cfg.runId, agentId: cfg.agentId, kind: 'tool-result',
              id: block.tool_use_id, tool: meta.name || '', ok, summary
            });
          }
        }
      } else if (msg.type === 'result') {
        // a resume against a vanished session fails immediately with this result
        if (msg.subtype !== 'success' && (isMissingSession(msg.result) || isMissingSession(msg.error))) {
          missingSession = true;
          break;   // don't forward — the caller retries fresh
        }
        // a resume that returns "success" with ZERO turns AND zero input tokens
        // never actually reached the model — the SDK resolved the resumed
        // session as a no-op (e.g. its transcript lives under a different cwd
        // slug). Forwarding it prints a misleading "SUCCESS · 0 turns" and
        // silently drops the message. Treat it exactly like a vanished session:
        // don't forward, let the caller retry fresh (with restored context).
        // Guarded on opts.resume so the fresh-retry pass never loops.
        const noopResume = opts.resume
          && msg.subtype === 'success'
          && (msg.num_turns || 0) === 0
          && (!msg.usage || (msg.usage.input_tokens || 0) === 0);
        if (noopResume) {
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
        const fp = buildStalePrompt();
        send('agent-event', {
          runId: cfg.runId, agentId: cfg.agentId, kind: 'session-invalid',
          sessionId: cfg.resumeSessionId, restored: fp.restored
        });
        const fresh = { ...options };
        delete fresh.resume;
        delete fresh.forkSession;
        await runOnce(fresh, true, fp.prompt);
      }
    } catch (err) {
      const aborted = abortController.signal.aborted;
      const msg = String(err && err.message ? err.message : err);
      // same recovery when the SDK throws instead of returning a result
      if (!aborted && cfg.resumeSessionId && isMissingSession(msg)) {
        const fp = buildStalePrompt();
        send('agent-event', {
          runId: cfg.runId, agentId: cfg.agentId, kind: 'session-invalid',
          sessionId: cfg.resumeSessionId, restored: fp.restored
        });
        try {
          const fresh = { ...options };
          delete fresh.resume;
          delete fresh.forkSession;
          await runOnce(fresh, true, fp.prompt);
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
