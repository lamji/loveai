// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// SKILL EDITOR — hand-edit SKILL.md or have an agent improve it
// ============================================================
const SKILL_AGENT = '__skill__';
const skillPage = document.getElementById('skill-page');
const skeMsgs = document.getElementById('ske-msgs');
const ske = {
  path: null, runId: null, running: false, bubble: null,
  status(text, cls) {
    const el = document.getElementById('ske-status');
    el.textContent = text || '';
    el.className = 'set-status ' + (cls || '');
  }
};

function skeMsg(role, text) {
  const empty = document.getElementById('ske-empty');
  if (empty) empty.remove();
  const wrap = document.createElement('div');
  wrap.className = 'skp-msg ' + role;
  wrap.innerHTML = '<div class="skp-who"></div><div class="skp-bubble"></div>';
  wrap.querySelector('.skp-who').textContent = role === 'user' ? 'YOU' : 'SKILL AGENT';
  wrap.querySelector('.skp-bubble').textContent = text || '';
  skeMsgs.appendChild(wrap);
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
  return wrap.querySelector('.skp-bubble');
}

function skeNote(text) {
  const empty = document.getElementById('ske-empty');
  if (empty) empty.remove();
  const n = document.createElement('div');
  n.className = 'skp-note';
  n.textContent = text;
  skeMsgs.appendChild(n);
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

// stream into the current assistant bubble, creating it on the first token
function skeAssistant(text) {
  if (!ske.bubble || !ske.bubble.isConnected) ske.bubble = skeMsg('assistant', '');
  ske.bubble.textContent += text;
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

// The reply interleaves conversation with the file body between <SKILL_MD>
// markers. Recomputing the visible text from the whole buffer (instead of
// appending chunks) is the only way to keep raw markdown out of the bubble —
// a chunk can straddle a marker boundary.
function skeRenderBubble() {
  if (!ske.bubble) return;
  const b = ske.buffer || '';
  const open = b.indexOf('<SKILL_MD>');
  const close = b.indexOf('</SKILL_MD>');
  let text;
  if (open === -1) {
    text = b;
  } else {
    const pre = b.slice(0, open).trim();
    const post = close === -1 ? '' : b.slice(close + '</SKILL_MD>'.length).trimStart();
    text = pre + (pre && post ? '\n\n' : '') + post;
    if (!text.trim() && close === -1) text = '✍ rewriting the skill file...';
  }
  ske.bubble.textContent = text;
  skeMsgs.scrollTop = skeMsgs.scrollHeight;
}

async function openSkillEditor(sk) {
  const r = await window.deck.skillRead(sk.path);
  if (!r.ok) { await showAlert({ title: 'CANNOT OPEN', message: r.error, okText: 'CLOSE', kind: 'danger' }); return; }
  ske.path = sk.path;
  ske.bubble = null;
  document.getElementById('ske-title').textContent = '/' + sk.name;
  document.getElementById('ske-path').textContent = sk.path + ' · ' + sk.scope;
  document.getElementById('ske-content').value = r.content;
  skeMsgs.innerHTML = `<div class="skp-empty" id="ske-empty">
    <div class="skp-empty-mark"></div>
    <div>Ask the agent to improve this skill — tighten steps, add checks, restructure...</div></div>`;
  ske.status('');
  skillPage.classList.remove('hidden');
  document.getElementById('ske-chat').focus();
}

async function skeReload() {
  const r = await window.deck.skillRead(ske.path);
  if (r.ok) document.getElementById('ske-content').value = r.content;
}

function skeSetRunning(on) {
  ske.running = on;
  document.getElementById('ske-send').disabled = on;
  document.getElementById('ske-stop').classList.toggle('hidden', !on);
  document.getElementById('ske-save').disabled = on;
}

document.getElementById('ske-save').onclick = async () => {
  const r = await window.deck.skillSave(ske.path, document.getElementById('ske-content').value);
  ske.status(r.ok ? 'saved' : r.error, r.ok ? 'ok' : 'err');
  if (r.ok) loadSettings();
};

async function skeSend() {
  const box = document.getElementById('ske-chat');
  const ask = box.value.trim();
  if (!ask || ske.running || !ske.path) return;
  box.value = '';
  box.style.height = 'auto';
  skeSetRunning(true);
  ske.status('agent working...');
  skeMsg('user', ask);
  ske.bubble = skeMsg('assistant', '');
  ske.bubble.classList.add('thinking');

  // The agent must NOT edit the file itself: Claude Code guards ~/.claude
  // behind a permission prompt this modal can't answer. Instead it returns the
  // full improved file in its reply and the app writes it via skillSave.
  ske.buffer = '';
  ske.runId = uid();
  const current = document.getElementById('ske-content').value;
  await window.deck.runAgent({
    runId: ske.runId, agentId: SKILL_AGENT,
    model: document.getElementById('ske-model').value,
    cwd: ske.path.replace(/[\\/]SKILL\.md$/, ''),
    // no tools are needed (the file travels in the prompt/reply); default mode
    // auto-denies any tool call, so ~/.claude's permission guard never trips
    permissionMode: 'default',
    leanContext: true,   // the whole task travels in the prompt — skip global config
    rules: '',
    prompt: `You are improving a Claude Code skill definition (a SKILL.md file). Do not use any tools — everything you need is below.

CURRENT SKILL.MD:
<<<SKILL
${current}
SKILL>>>

USER REQUEST: ${ask}

Reply with the COMPLETE improved file between <SKILL_MD> and </SKILL_MD> markers, then a 1-2 sentence summary of what you changed. Keep the YAML frontmatter valid: it must retain "name" and a one-line "description" (rewrite the description only if the request affects it).`
  });
}

// pull the improved file out of the agent's reply and write it ourselves
async function skeApplyReply() {
  const m = /<SKILL_MD>\s*\n?([\s\S]*?)\n?\s*<\/SKILL_MD>/.exec(ske.buffer || '');
  if (!m) { ske.status('agent produced no file update', 'err'); return; }
  const r = await window.deck.skillSave(ske.path, m[1].trimEnd() + '\n');
  if (!r.ok) { ske.status('save failed: ' + r.error, 'err'); return; }
  ske.status('improved & saved', 'ok');
  skeNote('✔ SKILL.md updated');
  await skeReload();
  loadSettings();
}

function skillAgentEvent(ev) {
  if (ev.runId !== ske.runId) return;
  switch (ev.kind) {
    case 'text-delta': {
      ske.buffer += ev.text;
      if (ske.bubble) ske.bubble.classList.remove('thinking');
      skeRenderBubble();
      break;
    }
    case 'tool': skeNote('⚙ ' + ev.tool); break;
    case 'result': ske.lastResult = ev.subtype; break;
    case 'error':
      ske.lastResult = 'error';
      ske.status('error: ' + ev.error, 'err');
      skeAssistant('\n⚠ ' + ev.error);
      break;
    case 'aborted': ske.lastResult = 'aborted'; ske.status('stopped', 'err'); break;
    case 'done': {
      skeSetRunning(false);
      if (ske.bubble) {
        ske.bubble.classList.remove('thinking');
        skeRenderBubble();
        // a reply that was only the file body leaves an empty bubble — drop it
        if (!ske.bubble.textContent.trim() || ske.bubble.textContent === '✍ rewriting the skill file...') {
          ske.bubble.closest('.skp-msg').remove();
        }
      }
      if (ske.lastResult === 'success') skeApplyReply();
      ske.bubble = null;
      break;
    }
  }
}

document.getElementById('ske-send').onclick = skeSend;
const skeChat = document.getElementById('ske-chat');
// GPT-style: Enter sends, Shift+Enter is a newline
skeChat.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); skeSend(); }
});
// composer grows with the message, capped by CSS max-height
skeChat.addEventListener('input', () => {
  skeChat.style.height = 'auto';
  skeChat.style.height = skeChat.scrollHeight + 'px';
});
document.getElementById('ske-stop').onclick = () => { if (ske.runId) window.deck.stopAgent(ske.runId); };
document.getElementById('ske-back').onclick = () => {
  if (ske.running && ske.runId) window.deck.stopAgent(ske.runId);
  skillPage.classList.add('hidden');
};

// ============================================================
// SETTINGS — MCP servers, skills, skill creator
// ============================================================
const settingsModal = document.getElementById('settings-modal');

document.querySelectorAll('.set-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.set-tab').forEach(t => t.classList.toggle('active', t === tab));
    for (const pane of ['mcp', 'skills', 'creator']) {
      document.getElementById('set-' + pane).classList.toggle('hidden', pane !== tab.dataset.set);
    }
  };
});

function setRow({ name, sub, chip, chipClass, onDelete, onClick }) {
  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `<div class="set-row-body"><div class="set-row-name"></div><div class="set-row-sub"></div></div><span class="set-chip"></span>`;
  row.querySelector('.set-row-name').textContent = name;
  row.querySelector('.set-row-sub').textContent = sub;
  const c = row.querySelector('.set-chip');
  c.textContent = chip;
  if (chipClass) c.classList.add(chipClass);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'Delete skill';
    del.textContent = '✕';
    del.onclick = e => { e.stopPropagation(); onDelete(); };
    row.appendChild(del);
  }
  if (onClick) { row.style.cursor = 'pointer'; row.onclick = onClick; }
  return row;
}

async function loadSettings() {
  loadSlashItems();   // keep the chatbox / menu in sync with skill changes
  window.deck.cliVersion().then(v => {
    document.getElementById('set-meta').textContent = v ? 'Claude Code — ' + v : 'Claude Code CLI not found on PATH';
  });

  const mcpBox = document.getElementById('mcp-list');
  mcpBox.innerHTML = '<div class="set-empty">loading...</div>';
  const servers = await window.deck.mcpList(projectDir || '');
  mcpBox.innerHTML = '';
  if (!servers.length) mcpBox.innerHTML = '<div class="set-empty">No MCP servers configured. Add one with: claude mcp add &lt;name&gt; ...</div>';
  for (const s of servers) {
    mcpBox.appendChild(setRow({
      name: s.name,
      sub: `${s.transport} · ${s.target || '(no target)'}`,
      chip: s.scope, chipClass: s.scope === 'user' ? '' : 'proj'
    }));
  }

  const skBox = document.getElementById('skills-list');
  skBox.innerHTML = '<div class="set-empty">loading...</div>';
  const skills = await window.deck.skillsList(projectDir || '');
  skBox.innerHTML = '';
  if (!skills.length) skBox.innerHTML = '<div class="set-empty">No skills found. Create one in the SKILL CREATOR tab.</div>';
  for (const sk of skills) {
    skBox.appendChild(setRow({
      name: '/' + sk.name,
      sub: sk.description,
      chip: sk.scope, chipClass: sk.scope === 'user' ? '' : 'proj',
      onClick: () => openSkillEditor(sk),
      onDelete: sk.scope === 'user' ? async () => {
        const yes = await showAlert({
          title: 'DELETE SKILL',
          message: `Remove /${sk.name} from this account? The whole skill folder is deleted.`,
          okText: 'DELETE', cancelText: 'KEEP', kind: 'danger'
        });
        if (!yes) return;
        const r = await window.deck.skillDelete(sk.path);
        if (!r.ok) await showAlert({ title: 'DELETE FAILED', message: r.error, okText: 'CLOSE', kind: 'danger' });
        loadSettings();
      } : null
    }));
  }
}

function skStatus(text, cls) {
  const el = document.getElementById('sk-status');
  el.textContent = text;
  el.className = 'set-status ' + (cls || '');
}

document.getElementById('sk-create').onclick = async () => {
  const name = document.getElementById('sk-name').value.trim();
  const description = document.getElementById('sk-desc').value.trim();
  const instructions = document.getElementById('sk-body').value.trim();
  if (!name || !description || !instructions) { skStatus('name, description and instructions are all required', 'err'); return; }
  skStatus('creating...');
  const r = await window.deck.skillCreate({ name, description, instructions });
  if (!r.ok) { skStatus(r.error, 'err'); return; }
  skStatus(`created /${r.slug} — live for all agents`, 'ok');
  for (const id of ['sk-name', 'sk-desc', 'sk-body']) document.getElementById(id).value = '';
  loadSettings();
};

document.getElementById('btn-settings').onclick = () => { settingsModal.classList.remove('hidden'); loadSettings(); };
document.getElementById('set-close').onclick = () => settingsModal.classList.add('hidden');
document.getElementById('set-refresh').onclick = loadSettings;
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) settingsModal.classList.add('hidden'); });

// ============================================================
// THEME — dark / light
// ============================================================
let theme = localStorage.getItem('theme') || 'dark';

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  // in dark mode show the sun (what you'd switch to), in light the moon
  document.getElementById('theme-sun').classList.toggle('hidden', theme !== 'dark');
  document.getElementById('theme-moon').classList.toggle('hidden', theme === 'dark');
  document.getElementById('btn-theme').title = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
  for (const t of termTabs) t.xterm.options.theme = termTheme();
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = n => css.getPropertyValue(n).trim();
  return {
    background: v('--editor-bg'), foreground: v('--editor-fg'),
    cursor: v('--fg'), selectionBackground: v('--editor-sel')
  };
}

// shiki has a matching light theme; open files are re-tokenised on switch
function shikiTheme() { return theme === 'dark' ? 'dark-plus' : 'light-plus'; }

async function rehighlightOpenFiles() {
  for (const f of openFiles) {
    const r = await window.deck.fsHighlight(f.value, f.lang, shikiTheme());
    if (!r.ok) continue;
    f.html = shikiInner(r.html);
    if (f.path === activeFile) paintCode(f);
  }
}

document.getElementById('btn-theme').onclick = () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', theme);
  applyTheme();
  rehighlightOpenFiles();
};

// ============================================================
// SIDEBAR TABS — AGENT / EXPLORER
// ============================================================
document.querySelectorAll('.side-tab').forEach(tab => {
  tab.onclick = () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.side-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.getElementById('tab-agent').classList.toggle('hidden', which !== 'agent');
    document.getElementById('tab-explorer').classList.toggle('hidden', which !== 'explorer');
    if (which === 'explorer' && !exLoaded) exLoad();
  };
});

