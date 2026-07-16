const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
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

let win;
// runId -> { abortController }
const runs = new Map();

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ctrl+click on a terminal link — only ever http(s), opened in the OS browser
ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  return true;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
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
  const out = { tasks: [], verdict: null, brief: false };
  try {
    const files = fs.readdirSync(pipelineDir(cwd));
    out.tasks = files.filter(f => /^task-\d+.*\.md$/i.test(f)).sort();
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
    return true;
  } catch {
    return false;
  }
});

// ===== File explorer (read-only — browse and copy project code) =====
// every path is validated against the imported project root before any read
function insideRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

ipcMain.handle('fs-list', (_e, { root, dir }) => {
  try {
    if (!root || !dir || !insideRoot(root, dir)) return { ok: false, error: 'outside the project root' };
    const items = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      items.push({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() });
    }
    // directories first, then files — each alphabetical, like VS Code
    items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
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
function git(repo, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (String(stdout || '') + String(stderr || '')).trim() });
    });
  });
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
  let branch = '';
  const staged = [], unstaged = [], untracked = [];
  for (const l of r.out.split('\n')) {
    if (!l) continue;
    if (l.startsWith('##')) { branch = l.slice(3); continue; }
    const x = l[0], y = l[1], f = l.slice(3);
    if (x === '?' && y === '?') { untracked.push(f); continue; }
    if (x !== ' ') staged.push({ s: x, f });
    if (y !== ' ') unstaged.push({ s: y, f });
  }
  return { ok: true, branch, staged, unstaged, untracked };
});

ipcMain.handle('git-cmd', async (_e, { repo, op, arg }) => {
  const ops = {
    stage: arg === '*' ? ['add', '-A'] : ['add', '--', arg],
    unstage: arg === '*' ? ['reset'] : ['reset', '--', arg],
    commit: ['commit', '-m', arg || 'update'],
    amend: arg ? ['commit', '--amend', '-m', arg] : ['commit', '--amend', '--no-edit'],
    push: ['push'],
    pull: ['pull']
  };
  if (!ops[op]) return { ok: false, out: 'unknown git op' };
  return git(repo, ops[op]);
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
