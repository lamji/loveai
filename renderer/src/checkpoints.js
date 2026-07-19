// Extracted from app.js — classic script, shares global scope. Keep load order.
//
// CHECKPOINTS — one snapshot per task (not per edit). A checkpoint is opened the
// moment a task starts (runAgent / launchPipeline) and finalized once the task
// ends; at that point main.js diffs the working tree against the snapshot to see
// which files actually changed — by ANY means (Edit/Write/MultiEdit, Bash rm/mv/
// sed, whatever), not just tool calls we happened to observe. Revert restores
// each touched file to its exact pre-task content (or deletes it, if the task
// created it) — see main.js's checkpoint-* IPC handlers.

const cpOpen = new Map();      // cwd -> { repo, ref, untracked, label, refcount, createdAt, ready }
let cpList = [];                // finalized checkpoints across every repo seen this session, newest first
const cpRepoCache = new Map();  // cwd -> repo (avoid re-resolving on every tool call)

async function cpResolveRepo(cwd) {
  if (cpRepoCache.has(cwd)) return cpRepoCache.get(cwd);
  let repo = null;
  try { const r = await window.deck.gitRepoRoot(cwd); repo = (r && r.ok) ? r.repo : null; } catch {}
  cpRepoCache.set(cwd, repo);
  return repo;
}

// begin (or join) the checkpoint for a cwd. Safe to call before repo/ref/
// untracked-baseline resolve — cpEndTask always awaits entry.ready first.
function cpBeginTask(cwd, label) {
  if (!cwd) return;
  const existing = cpOpen.get(cwd);
  if (existing) { existing.refcount++; return; }
  const entry = { repo: null, ref: null, untracked: [], label: label || '', refcount: 1, createdAt: Date.now(), ready: null };
  cpOpen.set(cwd, entry);
  entry.ready = (async () => {
    const repo = await cpResolveRepo(cwd);
    if (!repo) return;   // not a git repo — no checkpoint possible, silently skipped
    entry.repo = repo;
    try {
      const c = await window.deck.checkpointCreate(repo);
      if (c && c.ok) { entry.ref = c.ref; entry.untracked = c.untracked || []; }
    } catch {}
  })();
}

async function cpEndTask(cwd) {
  const entry = cwd && cpOpen.get(cwd);
  if (!entry) return;
  entry.refcount--;
  if (entry.refcount > 0) return;
  cpOpen.delete(cwd);
  await entry.ready;
  if (!entry.repo || !entry.ref) return;
  // computed from git itself — catches edits made by ANY tool (Bash included),
  // not just Edit/Write/MultiEdit calls we happened to see go by
  let files = [];
  try {
    const t = await window.deck.checkpointTouched(entry.repo, entry.ref, entry.untracked);
    if (t && t.ok) files = t.files || [];
  } catch {}
  if (!files.length) return;   // nothing actually changed — nothing to checkpoint
  const record = {
    id: uid(), repo: entry.repo, ref: entry.ref, label: entry.label,
    files, createdAt: entry.createdAt, finishedAt: Date.now()
  };
  cpList.unshift(record);
  await cpPersist(entry.repo);
  cpRenderBadge();
  if (!cpPanel.classList.contains('hidden')) cpRenderPanel();
  cpFeedNote(record);
}

async function cpPersist(repo) {
  const mine = cpList.filter(c => c.repo === repo);
  try { await window.deck.checkpointsSave(repo, mine); } catch {}
}

// a since-fixed main.js bug let a git stderr warning (e.g. a CRLF/LF notice)
// leak into a checkpoint's touched-files list as if it were a real path — strip
// any such bogus entry out of records loaded from disk so an old checkpoint
// from before the fix self-heals instead of staying stuck with a permanently
// failing revert button forever.
function cpSanitizeFiles(files) {
  return (files || []).filter(f => !/^\s*(warning|hint|error|fatal):/i.test(f));
}

// called when a project/workspace is opened — see gitDetect() in git.js
async function cpLoadForRepos(repoList) {
  let changed = false;
  for (const repo of repoList || []) {
    if (cpList.some(c => c.repo === repo)) continue;   // already loaded this session
    try {
      const r = await window.deck.checkpointsLoad(repo);
      if (r && r.ok && r.list && r.list.length) {
        let dirty = false;
        const cleaned = [];
        for (const record of r.list) {
          const files = cpSanitizeFiles(record.files);
          if (files.length !== (record.files || []).length) dirty = true;
          if (files.length) cleaned.push(files.length === record.files.length ? record : { ...record, files });
        }
        cpList.push(...cleaned);
        changed = true;
        if (dirty) await cpPersist(repo);
      }
    } catch {}
  }
  if (!changed) return;
  cpList.sort((a, b) => b.finishedAt - a.finishedAt);
  cpRenderBadge();
  if (!cpPanel.classList.contains('hidden')) cpRenderPanel();
}

// small clickable note dropped into the feed right where the work happened
function cpFeedNote(record) {
  if (!consoleFeed) return;
  const n = record.files.length;
  const el = document.createElement('div');
  el.className = 'ev';
  el.innerHTML = `<span class="tag op">CHECKPOINT</span><span class="ico">✓</span>` +
    `<span class="body ok cp-note-link">checkpoint saved — ${n} file${n === 1 ? '' : 's'}, revertable</span>`;
  el.querySelector('.cp-note-link').onclick = () => { cpOpenPanel(); cpHighlight(record.id); };
  consoleFeed.appendChild(el);
  pinFeedToBottom();
}

// ============================================================
// PANEL UI
// ============================================================
const cpBadge = document.getElementById('cp-badge');
const cpPanel = document.getElementById('cp-panel');

function cpRenderBadge() {
  if (!cpBadge) return;
  const n = cpList.length;
  cpBadge.classList.toggle('hidden', n === 0);
  const countEl = document.getElementById('cp-count');
  if (countEl) countEl.textContent = n > 99 ? '99+' : n;
}

function cpTimeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function cpOpenPanel() { cpRenderPanel(); cpPanel.classList.remove('hidden'); }
function cpClosePanel() { cpPanel.classList.add('hidden'); }
function cpHighlight(id) {
  const row = cpPanel.querySelector(`[data-cp-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.add('cp-flash');
  setTimeout(() => row.classList.remove('cp-flash'), 1200);
}

cpBadge.onclick = (e) => {
  e.stopPropagation();
  if (cpPanel.classList.contains('hidden')) cpOpenPanel();
  else cpClosePanel();
};
document.addEventListener('click', e => {
  if (e.target.closest('.modal')) return;
  if (!cpPanel.classList.contains('hidden') && !document.getElementById('cp-wrap').contains(e.target)) cpClosePanel();
});

function cpRenderPanel() {
  cpPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'git-head-row';
  head.innerHTML = `<span class="git-head-title">CHECKPOINTS <span class="sec-count">${cpList.length || ''}</span></span>`;
  cpPanel.appendChild(head);

  if (!cpList.length) {
    const none = document.createElement('div');
    none.className = 'git-none';
    none.textContent = 'no checkpoints yet — one appears once a task finishes editing files.';
    cpPanel.appendChild(none);
    return;
  }

  const list = document.createElement('div');
  list.className = 'cp-list';
  for (const record of cpList) list.appendChild(cpRow(record));
  cpPanel.appendChild(list);
}

function cpRow(record) {
  const row = document.createElement('div');
  row.className = 'cp-item';
  row.dataset.cpId = record.id;
  const n = record.files.length;
  const repoName = String(record.repo || '').split(/[\\/]/).pop();
  row.innerHTML =
    `<div class="cp-head">` +
      `<span class="cp-caret">▸</span>` +
      `<span class="cp-label"></span>` +
      `<span class="cp-meta">${esc(repoName)} · ${n} file${n === 1 ? '' : 's'} · ${cpTimeAgo(record.finishedAt)}</span>` +
      `<button class="mini-btn cp-revert-all" title="Revert all files in this checkpoint">↺ REVERT ALL</button>` +
    `</div>` +
    `<div class="cp-files hidden"></div>`;
  const labelEl = row.querySelector('.cp-label');
  labelEl.textContent = record.label || '(untitled task)';
  labelEl.title = record.label || '';
  const body = row.querySelector('.cp-files');
  row.querySelector('.cp-head').addEventListener('click', (e) => {
    if (e.target.closest('.cp-revert-all')) return;
    body.classList.toggle('hidden');
    row.querySelector('.cp-caret').textContent = body.classList.contains('hidden') ? '▸' : '▾';
    if (!body.classList.contains('hidden') && !body.dataset.built) { body.dataset.built = '1'; cpBuildFiles(record, body); }
  });
  row.querySelector('.cp-revert-all').onclick = async (e) => {
    e.stopPropagation();
    await cpConfirmAndRevert(record, record.files);
  };
  return row;
}

function cpBuildFiles(record, body) {
  for (const f of record.files) {
    const line = document.createElement('div');
    line.className = 'git-file cp-file';
    const base = f.split('/').pop();
    const dir = f.slice(0, -base.length);
    line.innerHTML =
      `<span class="gf-name"></span><span class="gf-dir"></span>` +
      `<button class="mini-btn cp-file-revert" title="Revert just this file">↺</button>`;
    const nameEl = line.querySelector('.gf-name');
    nameEl.textContent = base; nameEl.title = f;
    line.querySelector('.gf-dir').textContent = dir;
    line.querySelector('.cp-file-revert').onclick = () => cpConfirmAndRevert(record, [f]);
    body.appendChild(line);
  }
}

async function cpConfirmAndRevert(record, files) {
  const n = files.length;
  const ok = await showAlert({
    title: 'REVERT TO CHECKPOINT',
    message: `Restore ${n} file${n === 1 ? '' : 's'} to its exact state before ` +
      `"${record.label || 'this task'}"? Any changes since — including your own edits — will be lost.`,
    okText: 'REVERT', cancelText: 'CANCEL', kind: 'danger'
  });
  if (!ok) return;
  let r;
  try { r = await window.deck.checkpointRevert(record.repo, record.ref, files); }
  catch (e) { toast('✗ revert failed: ' + (e && e.message ? e.message : e), false); return; }
  const results = r.results || [];
  const failed = results.filter(x => !x.ok);
  toast(failed.length ? `reverted with ${failed.length} error(s)` : `✓ reverted ${n} file${n === 1 ? '' : 's'}`, !failed.length);
  const done = new Set(results.filter(x => x.ok).map(x => x.file));
  record.files = record.files.filter(f => !done.has(f));
  if (!record.files.length) cpList = cpList.filter(c => c.id !== record.id);
  await cpPersist(record.repo);
  cpRenderBadge();
  cpRenderPanel();
  if (typeof gitRefresh === 'function' && gitRepo) gitRefresh();
}
