// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// GIT — VS Code-style source control
// ============================================================
let repos = [], gitRepo = null;
const gitPanel = document.getElementById('git-panel');
const GIT_STATUS_LABEL = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' };

const loveaiIgnored = new Set();   // repos already gitignored+untracked this session
async function ensureLoveaiIgnored() {
  for (const r of repos) {
    if (loveaiIgnored.has(r)) continue;
    loveaiIgnored.add(r);
    try {
      const res = await window.deck.gitIgnoreLoveai(r);
      if (res && res.untracked) plog('info', `.loveai untracked and gitignored in ${r.split(/[\\/]/).pop()}`);
    } catch {}
  }
}

async function gitDetect() {
  repos = projectDir ? await window.deck.gitRepos(projectDir) : [];
  await ensureLoveaiIgnored();
  const sel = document.getElementById('git-repo-sel');
  sel.innerHTML = '';
  for (const r of repos) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = r === projectDir ? r.split(/[\\/]/).pop() + ' (root)' : r.split(/[\\/]/).pop();
    o.title = r;
    sel.appendChild(o);
  }
  // single repo: automatic. multiple: menu to choose.
  sel.classList.toggle('hidden', repos.length < 2);
  if (!repos.includes(gitRepo)) gitRepo = repos[0] || null;
  if (gitRepo) sel.value = gitRepo;
  await gitRefresh();
}

async function gitRefresh() {
  const badge = document.getElementById('git-badge');
  if (!gitRepo) { badge.classList.add('hidden'); return; }

  // status of every repo — badge shows the TOTAL across all (like VS Code multi-root)
  const all = await Promise.all(repos.map(async r => ({ repo: r, st: await window.deck.gitStatus(r) })));
  const valid = all.filter(x => x.st.ok);
  if (!valid.length) { badge.classList.add('hidden'); return; }
  repos = valid.map(x => x.repo);
  if (!repos.includes(gitRepo)) { gitRepo = repos[0]; document.getElementById('git-repo-sel').value = gitRepo; }

  const countOf = st => st.staged.length + st.unstaged.length + st.untracked.length + (st.conflicts ? st.conflicts.length : 0);
  const total = valid.reduce((n, x) => n + countOf(x.st), 0);
  const sel = valid.find(x => x.repo === gitRepo);

  badge.classList.remove('hidden');
  badge.classList.toggle('dirty', total > 0);
  const countEl = document.getElementById('git-count');
  countEl.textContent = total > 99 ? '99+' : total;
  // 3 chars can't sit in an 18px circle — fall back to a pill for 99+
  countEl.classList.toggle('wide', total > 99);
  document.getElementById('git-sel-count').textContent = countOf(sel.st) || '';

  // per-repo counts in the picker
  const selEl = document.getElementById('git-repo-sel');
  [...selEl.options].forEach(o => {
    const x = valid.find(v => v.repo === o.value);
    if (!x) return;
    const base = o.value === projectDir ? o.value.split(/[\\/]/).pop() + ' (root)' : o.value.split(/[\\/]/).pop();
    const n = countOf(x.st);
    o.textContent = n ? `${base}  ●${n}` : base;
  });

  renderGitModal(sel.st);
  buildExStatus(valid);
  decorateExplorer();
  statusGit = sel.st;                       // expose for the status bar
  if (window.renderStatusBar) renderStatusBar();
}
let statusGit = null;

function gitFileRow(f, statusChar, staged) {
  const parts = f.replace(/"/g, '').split('/');
  const base = parts.pop();
  const dir = parts.join('/');
  const row = document.createElement('div');
  row.className = 'git-file';
  row.title = f;
  const discardBtn = staged ? '' : `<button class="mini-btn gf-discard" title="${statusChar === '?' ? 'Delete untracked file' : 'Discard changes'}">↩</button>`;
  row.innerHTML = `<span class="gf-name" title="View diff">${esc(base)}</span><span class="gf-dir">${esc(dir)}</span>${discardBtn}<button class="mini-btn gf-stage">${staged ? '−' : '+'}</button><span class="gf-status s-${GIT_STATUS_LABEL[statusChar] || 'M'}">${GIT_STATUS_LABEL[statusChar] || statusChar}</span>`;
  row.querySelector('.gf-stage').onclick = async () => {
    await window.deck.gitCmd(gitRepo, staged ? 'unstage' : 'stage', f);
    gitRefresh();
  };
  const disc = row.querySelector('.gf-discard');
  if (disc) disc.onclick = async () => {
    const untracked = statusChar === '?';
    const ok = await showAlert({
      title: untracked ? 'DELETE FILE' : 'DISCARD CHANGES',
      message: untracked ? `Permanently delete untracked "${base}"?` : `Discard all changes to "${base}"? This cannot be undone.`,
      okText: untracked ? 'DELETE' : 'DISCARD', cancelText: 'CANCEL', kind: 'danger'
    });
    if (!ok) return;
    await window.deck.gitCmd(gitRepo, untracked ? 'clean' : 'discard', f);
    gitRefresh(); refreshWorkspace();
  };
  // click the name → diff view (untracked files have no diff, so open them instead)
  row.querySelector('.gf-name').onclick = () => {
    if (statusChar === '?') openFile(joinPath(gitRepo, f.replace(/"/g, '')));
    else openDiff({ file: f, staged });
  };
  return row;
}

function renderGitModal(st) {
  document.getElementById('git-branch-line').textContent = gitRepo;
  document.getElementById('git-branch-name').textContent = st.branch || '(detached)';
  // ahead/behind vs upstream, VS Code-style ↑n ↓n
  const syncEl = document.getElementById('git-sync-state');
  if (st.upstream) {
    const bits = [];
    if (st.behind) bits.push(`↓${st.behind}`);
    if (st.ahead) bits.push(`↑${st.ahead}`);
    syncEl.textContent = bits.join(' ') || '✓ up to date';
    syncEl.classList.toggle('behind', !!st.behind);
  } else {
    syncEl.textContent = 'no upstream';
    syncEl.classList.remove('behind');
  }

  const stagedBox = document.getElementById('git-staged');
  const unstagedBox = document.getElementById('git-unstaged');
  const conflictBox = document.getElementById('git-conflicts');
  stagedBox.innerHTML = ''; unstagedBox.innerHTML = ''; conflictBox.innerHTML = '';

  // merge conflicts get their own section with a Resolve action per file
  const conflicts = st.conflicts || [];
  for (const f of conflicts) {
    const row = gitConflictRow(f);
    conflictBox.appendChild(row);
  }
  document.getElementById('sec-conflicts').classList.toggle('hidden', !conflicts.length);
  document.getElementById('conflicts-count').textContent = conflicts.length || '';

  for (const { s, f } of st.unstaged) unstagedBox.appendChild(gitFileRow(f, s, false));
  for (const f of st.untracked) unstagedBox.appendChild(gitFileRow(f, '?', false));
  for (const { s, f } of st.staged) stagedBox.appendChild(gitFileRow(f, s, true));
  // like VS Code: staged section only appears when something is staged
  document.getElementById('sec-staged').classList.toggle('hidden', !st.staged.length);
  document.getElementById('staged-count').textContent = st.staged.length || '';
  document.getElementById('changes-count').textContent = (st.unstaged.length + st.untracked.length) || '';
  if (!st.unstaged.length && !st.untracked.length) unstagedBox.innerHTML = '<div class="git-none">working tree clean</div>';
}

// a conflicted file: click the name to resolve it VS Code-style; ↗ opens the raw
// file in the editor; ✓ marks it resolved as-is
function gitConflictRow(f) {
  const base = f.replace(/"/g, '').split('/').pop();
  const row = document.createElement('div');
  row.className = 'git-file gf-conflict';
  row.title = 'Click to resolve conflicts';
  row.innerHTML = `<span class="gf-name">${esc(base)}</span><button class="mini-btn gf-open" title="Open raw file">↗</button><button class="mini-btn gf-resolve" title="Mark resolved as-is (stage)">✓</button><span class="gf-status s-U">!</span>`;
  row.querySelector('.gf-name').onclick = () => openConflictResolver(f);
  row.querySelector('.gf-open').onclick = () => { if (gitRepo) openFile(joinPath(gitRepo, f.replace(/"/g, ''))); };
  row.querySelector('.gf-resolve').onclick = async () => {
    await window.deck.gitCmd(gitRepo, 'resolve', f);
    gitRefresh();
  };
  return row;
}

// ============================================================
// MERGE CONFLICT RESOLVER — VS Code-style accept current/incoming/both,
// plus an AI pass that recommends which side to take per conflict
// ============================================================
const conflictModal = document.getElementById('conflict-modal');
let cf = null;   // { rel, abs, segments, choices: Map(idx -> 'current'|'incoming'|'both') }

// split file text into alternating text/conflict segments
function parseConflicts(text) {
  const lines = text.split('\n');
  const segs = [];
  let plain = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) {
      if (plain.length) { segs.push({ type: 'text', lines: plain }); plain = []; }
      const seg = { type: 'conflict', curLabel: lines[i].slice(7).trim() || 'HEAD', current: [], incoming: [], incLabel: 'incoming' };
      i++;
      while (i < lines.length && !lines[i].startsWith('=======')) seg.current.push(lines[i++]);
      i++;   // skip =======
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) seg.incoming.push(lines[i++]);
      if (i < lines.length) seg.incLabel = lines[i].slice(7).trim() || 'incoming';
      segs.push(seg);
    } else plain.push(lines[i]);
  }
  if (plain.length) segs.push({ type: 'text', lines: plain });
  return segs;
}

async function openConflictResolver(relFile, opts = {}) {
  const rel = relFile.replace(/"/g, '');
  const abs = joinPath(gitRepo, rel);
  const r = await window.deck.fsRead(gitRepo, abs, shikiTheme());
  if (!r.ok) { toast('✗ cannot read ' + rel + ': ' + r.error, false); return; }
  const segments = parseConflicts(r.content);
  if (!segments.some(s => s.type === 'conflict')) {
    // no markers — treat as already resolved; advance a PR flow if present
    if (opts.after) { opts.after(); return; }
    toast('no conflict markers found — opening the file instead', false);
    openFile(abs);
    return;
  }
  // opts.after: called after this file is saved+staged (PR conflict chaining)
  // opts.aiRule: extra guidance appended to the AI analyzer prompt
  cf = { rel, abs, segments, choices: new Map(), after: opts.after || null, aiRule: opts.aiRule || '' };
  document.getElementById('cf-title').textContent = 'RESOLVE CONFLICTS · ' + rel.split('/').pop();
  document.getElementById('cf-status').textContent = opts.progress || '';
  gitPanel.classList.add('hidden');
  renderConflicts();
  conflictModal.classList.remove('hidden');
}

function renderConflicts() {
  const body = document.getElementById('cf-body');
  body.innerHTML = '';
  let confIdx = 0, total = 0, resolved = 0;
  for (const seg of cf.segments) {
    if (seg.type === 'text') {
      // context: show a few surrounding lines, collapse the middle
      const pre = document.createElement('pre');
      pre.className = 'cf-ctx';
      const ls = seg.lines;
      pre.textContent = ls.length > 7 ? [...ls.slice(0, 3), '        · · ·', ...ls.slice(-3)].join('\n') : ls.join('\n');
      body.appendChild(pre);
      continue;
    }
    const i = confIdx++;
    total++;
    const choice = cf.choices.get(i);
    const box = document.createElement('div');
    box.className = 'cf-conf';
    if (choice) {
      resolved++;
      const chosen = choice === 'current' ? seg.current : choice === 'incoming' ? seg.incoming : [...seg.current, ...seg.incoming];
      box.innerHTML = `<div class="cf-done-head">✓ resolved — accepted ${choice} <a href="#" class="cf-undo">undo</a></div><pre class="cf-chosen"></pre>`;
      box.querySelector('.cf-chosen').textContent = chosen.join('\n') || '(empty)';
      box.querySelector('.cf-undo').onclick = (e) => { e.preventDefault(); cf.choices.delete(i); renderConflicts(); };
    } else {
      // VS Code look: action links sit inside the conflict block, above Current
      box.innerHTML = `
        <div class="cf-actions">
          <a href="#" data-c="current">Accept Current Change</a><span>|</span>
          <a href="#" data-c="incoming">Accept Incoming Change</a><span>|</span>
          <a href="#" data-c="both">Accept Both Changes</a>
          <span class="cf-reco" data-reco="${i}"></span>
        </div>
        <div class="cf-cur"><div class="cf-label cur">&lt;&lt;&lt;&lt;&lt;&lt;&lt; ${esc(seg.curLabel)} (Current Change)</div><pre></pre></div>
        <div class="cf-sep">=======</div>
        <div class="cf-inc"><pre></pre><div class="cf-label inc">&gt;&gt;&gt;&gt;&gt;&gt;&gt; ${esc(seg.incLabel)} (Incoming Change)</div></div>`;
      box.querySelector('.cf-cur pre').textContent = seg.current.join('\n') || '(empty)';
      box.querySelector('.cf-inc pre').textContent = seg.incoming.join('\n') || '(empty)';
      box.querySelectorAll('.cf-actions a').forEach(aEl => {
        aEl.onclick = (e) => { e.preventDefault(); cf.choices.set(i, aEl.dataset.c); renderConflicts(); };
      });
      if (cf.reco && cf.reco[i]) {
        const el = box.querySelector('.cf-reco');
        el.textContent = `🤖 suggests: ${cf.reco[i].pick}${cf.reco[i].why ? ' — ' + cf.reco[i].why : ''}`;
      }
    }
    body.appendChild(box);
  }
  document.getElementById('cf-count').textContent = `${resolved}/${total} resolved`;
  document.getElementById('cf-save').disabled = resolved !== total;
}

// rebuild the file from segments + choices and finish the resolution
document.getElementById('cf-save').onclick = async () => {
  if (!cf) return;
  const btn = document.getElementById('cf-save');
  btn.disabled = true; const prev = btn.textContent; btn.textContent = '⏳ SAVING…';
  const out = [];
  let i = 0;
  for (const seg of cf.segments) {
    if (seg.type === 'text') { out.push(...seg.lines); continue; }
    const c = cf.choices.get(i++);
    if (c === 'current') out.push(...seg.current);
    else if (c === 'incoming') out.push(...seg.incoming);
    else out.push(...seg.current, ...seg.incoming);
  }
  const w = await window.deck.fsWrite(gitRepo, cf.abs, out.join('\n'));
  if (!w.ok) { btn.textContent = prev; btn.disabled = false; toast('✗ save failed: ' + w.error, false); return; }
  await window.deck.gitCmd(gitRepo, 'resolve', cf.rel);
  btn.textContent = prev;
  toast(`✓ ${cf.rel.split('/').pop()} resolved & staged`);
  const after = cf.after;
  conflictModal.classList.add('hidden');
  cf = null;
  gitRefresh(); refreshWorkspace();
  if (after) after();   // PR conflict chain: open the next file / finish
};

async function cfCancel() {
  conflictModal.classList.add('hidden'); cf = null;
  if (prConflictCtx) {   // abort the merge we started for the PR flow
    prConflictCtx = null;
    await window.deck.prAbortMerge(gitRepo);
    toast('merge aborted — PR not created.', false);
    gitRefresh(); refreshWorkspace();
  }
}
document.getElementById('cf-cancel').onclick = cfCancel;
conflictModal.addEventListener('click', e => { if (e.target === conflictModal) cfCancel(); });

// AI pass: an agent reads every conflict and recommends a side per conflict
document.getElementById('cf-ai').onclick = async () => {
  if (!cf) return;
  const agent = byRole('reviewer')[0] || byRole('senior')[0] || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { toast('✗ ' + agent.name + ' is busy', false); return; }
  const confs = cf.segments.filter(s => s.type === 'conflict');
  const blocks = confs.map((s, i) =>
    `CONFLICT ${i}\n<<< CURRENT (${s.curLabel})\n${s.current.join('\n')}\n=== INCOMING (${s.incLabel})\n${s.incoming.join('\n')}\n>>>`).join('\n\n');
  const status = document.getElementById('cf-status');
  status.textContent = '🤖 analyzing…';
  const rule = cf.aiRule
    ? cf.aiRule
    : 'Pick the side that preserves correct, complete behavior; use BOTH when the two changes are independent and both needed.';
  const prompt = `Merge conflicts in ${cf.rel}. For EACH conflict decide which side to accept. Do not use tools.

DECISION RULE: ${rule}

Output EXACTLY one line per conflict, nothing else:
CONFLICT <n>: CURRENT | INCOMING | BOTH — <reason, max 12 words>

${blocks.slice(0, 40000)}`;
  const applyAuto = !!cf.aiRule;   // PR flow: auto-apply the AI's picks so you can just Save
  runAgent(agent.id, prompt, false, false, {
    fresh: true, model: 'claude-sonnet-5',
    onDone: (result, text) => {
      if (!cf) return;
      if (result !== 'success') { status.textContent = 'analysis ' + result; return; }
      cf.reco = {};
      for (const m of text.matchAll(/CONFLICT\s+(\d+)\s*:\s*(CURRENT|INCOMING|BOTH)\s*(?:—|-)?\s*(.*)/gi)) {
        const idx = +m[1], pick = m[2].toUpperCase();
        cf.reco[idx] = { pick, why: (m[3] || '').trim().slice(0, 80) };
        if (applyAuto) cf.choices.set(idx, pick === 'CURRENT' ? 'current' : pick === 'INCOMING' ? 'incoming' : 'both');
      }
      status.textContent = Object.keys(cf.reco).length ? (applyAuto ? '🤖 applied — review & Save' : '🤖 recommendations ready') : 'no recommendations parsed';
      renderConflicts();
    }
  });
};

// forward-slash join for repo + git-relative path (git always emits '/')
function joinPath(repo, rel) { return (repo.replace(/[\\/]+$/, '') + '/' + rel).replace(/\//g, sepChar()); }
function sepChar() { return navigator.platform.startsWith('Win') ? '\\' : '/'; }

function gitOut(text, ok = true) {
  const el = document.getElementById('git-out');
  el.textContent = text || '';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
}

async function gitDo(op, arg) {
  gitOut('working...', true);
  const r = await window.deck.gitCmd(gitRepo, op, arg);
  gitOut(r.out.split('\n').slice(-3).join(' · ') || (r.ok ? 'done' : 'failed'), r.ok);
  gitRefresh();
  // pull/merge rewrite files on disk — refresh the tree and open editors
  if (op === 'pull') refreshWorkspace();
  return r;
}

document.getElementById('git-badge').onclick = async (e) => {
  e.stopPropagation();
  if (gitPanel.classList.contains('hidden')) {
    await gitDetect();
    gitPanel.classList.remove('hidden');
    ciRefresh();   // CI status is fetched only when the panel is opened (gh call)
    ghprRefresh();
  } else {
    gitPanel.classList.add('hidden');
  }
};
// close the dropdown on any click outside it — but NOT when the click lands in a
// modal/dialog (discard confirm, branch prompt, etc.) that the panel itself opened
document.addEventListener('click', e => {
  if (e.target.closest('.modal')) return;
  if (!gitPanel.classList.contains('hidden') && !document.getElementById('git-wrap').contains(e.target)) {
    gitPanel.classList.add('hidden');
  }
});
document.getElementById('git-repo-sel').onchange = e => { gitRepo = e.target.value; gitRefresh(); };
document.getElementById('git-refresh').onclick = gitRefresh;
// git panel ⌨: open a bash terminal in the CURRENTLY SELECTED repo — reuse a live
// tab already sitting in that repo, otherwise start a fresh one there
document.getElementById('git-bash').onclick = () => {
  gitPanel.classList.add('hidden');
  const repo = gitRepo || projectDir || '';
  openTerminal();                       // opens the bottom panel on the terminal
  const existing = termTabs.find(t => !t.dead && t.cwd === repo);
  if (existing) activateTerm(existing.id);
  else newTerm('bash', repo);
};

// ---------- lightweight text prompt (branch name, remote url, ...) ----------
// work: async fn(value) — runs INSIDE the dialog after OK (buttons lock, OK shows
// workingText); the promise then resolves { value, res } instead of just value.
function askText({ title, placeholder = '', value = '', work = null, workingText = '⏳ WORKING…' }) {
  return new Promise(res => {
    const ov = document.createElement('div');
    ov.className = 'modal';
    ov.innerHTML = `<div class="modal-card alert-card"><div class="modal-title"></div>
      <input class="ask-input" spellcheck="false" />
      <div class="modal-actions"><button class="btn ask-cancel">CANCEL</button><button class="btn btn-launch ask-ok">OK</button></div></div>`;
    ov.querySelector('.modal-title').textContent = title;
    const inp = ov.querySelector('.ask-input');
    const okBtn = ov.querySelector('.ask-ok');
    const cancelBtn = ov.querySelector('.ask-cancel');
    inp.placeholder = placeholder; inp.value = value;
    document.body.appendChild(ov);
    inp.focus(); inp.select();
    let busy = false;
    const done = v => { if (busy) return; ov.remove(); res(v); };
    const submit = async () => {
      const v = inp.value.trim() || null;
      if (v === null) { done(null); return; }
      if (!work) { done(v); return; }
      busy = true;
      inp.disabled = true; okBtn.disabled = true; cancelBtn.disabled = true;
      okBtn.textContent = workingText; okBtn.classList.add('btn-working');
      let r;
      try { r = await work(v); } catch (e) { r = { ok: false, error: String(e && e.message ? e.message : e) }; }
      busy = false;
      ov.remove();
      res({ value: v, res: r });
    };
    okBtn.onclick = submit;
    cancelBtn.onclick = () => done(null);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') done(null);
    });
    ov.addEventListener('click', e => { if (e.target === ov) done(null); });
  });
}

// ---------- branch switcher ----------
const branchMenu = document.getElementById('branch-menu');
const branchFetchedRepos = new Set();   // repos already `git fetch`ed this session
document.getElementById('git-branch-btn').onclick = async (e) => {
  e.stopPropagation();
  if (!branchMenu.classList.contains('hidden')) { branchMenu.classList.add('hidden'); return; }
  if (!gitRepo) return;
  // remotes only show up after a fetch — do it once per repo per session (or on
  // demand via the ⟳ button), with a loading state so it never looks empty
  if (!branchFetchedRepos.has(gitRepo)) {
    branchMenu.innerHTML = '<div class="cm-item">⟳ fetching remotes…</div>';
    branchMenu.classList.remove('hidden');
    fitDropUp(branchMenu, document.getElementById('git-branch-btn'));
    await window.deck.gitCmd(gitRepo, 'fetch');
    branchFetchedRepos.add(gitRepo);
  }
  const r = await window.deck.gitBranches(gitRepo);
  branchMenu.innerHTML = '';
  if (!r.ok) { branchMenu.innerHTML = `<div class="cm-item">${esc(r.error || 'failed')}</div>`; }
  else {
    // search box (pinned, doesn't scroll)
    const search = document.createElement('input');
    search.className = 'branch-search';
    search.placeholder = '🔎 filter branches…';
    search.spellcheck = false;
    branchMenu.appendChild(search);

    // checking a box filters OUT that category
    const toggles = document.createElement('div');
    toggles.className = 'branch-toggles';
    toggles.innerHTML = `
      <label><input type="checkbox" class="bt-local"> hide local</label>
      <label><input type="checkbox" class="bt-remote"> hide remote</label>
      <button class="bt-fetch" title="Fetch remotes again">⟳ fetch</button>`;
    branchMenu.appendChild(toggles);
    const cbLocal = toggles.querySelector('.bt-local');
    const cbRemote = toggles.querySelector('.bt-remote');
    toggles.querySelector('.bt-fetch').onclick = async (ev) => {
      ev.stopPropagation();
      branchFetchedRepos.delete(gitRepo);          // force a fresh fetch
      branchMenu.classList.add('hidden');
      document.getElementById('git-branch-btn').click();   // reopen → refetch + rerender
    };

    const list = document.createElement('div');
    list.className = 'branch-list';
    branchMenu.appendChild(list);

    const rows = [];   // { name, el, section, header? }
    const addHeader = (label) => {
      const h = document.createElement('div');
      h.className = 'branch-sec'; h.textContent = label;
      list.appendChild(h);
      rows.push({ header: true, el: h, section: label });
    };

    // ---- LOCAL (sorted, current pinned first) ----
    const locals = r.local.slice().sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)));
    addHeader('LOCAL');
    for (const b of locals) {
      const it = document.createElement('div');
      it.className = 'cm-item' + (b.current ? ' cm-current' : '');
      it.innerHTML = `<span>${b.current ? '● ' : ''}${esc(b.name)}</span>${b.current ? '' : '<span class="cm-del" title="Delete">🗑</span>'}`;
      it.querySelector('span').onclick = async () => {
        branchMenu.classList.add('hidden');
        if (!b.current) { await gitDo('checkout', b.name); refreshWorkspace(); }
      };
      const del = it.querySelector('.cm-del');
      if (del) del.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await showAlert({ title: 'DELETE BRANCH', message: `Delete branch "${b.name}"? Unmerged commits on it will be lost.`, okText: 'DELETE', cancelText: 'CANCEL', kind: 'danger' });
        if (ok) { await gitDo('delete-branch', b.name); document.getElementById('git-branch-btn').click(); document.getElementById('git-branch-btn').click(); }
      };
      list.appendChild(it);
      rows.push({ name: b.name.toLowerCase(), el: it, kind: 'local' });
    }

    // ---- REMOTE (sorted; hides ones already checked out locally) ----
    const localNames = new Set(r.local.map(b => b.name));
    const remotes = (r.remote || [])
      .filter(rb => !/\/HEAD$|->/.test(rb))                 // skip origin/HEAD pointers
      .map(rb => ({ full: rb, short: rb.replace(/^[^/]+\//, '') }))
      .filter(rb => !localNames.has(rb.short))              // no dup of a local branch
      .sort((a, b) => a.full.localeCompare(b.full));
    if (remotes.length) {
      addHeader('REMOTE');
      for (const rb of remotes) {
        const it = document.createElement('div');
        it.className = 'cm-item branch-remote';
        it.innerHTML = `<span>${esc(rb.full)}</span><span class="branch-co" title="Check out (creates a local tracking branch)">⤓</span>`;
        // selecting a remote branch auto-branches out: creates a local tracking branch
        it.onclick = async () => {
          branchMenu.classList.add('hidden');
          await gitDo('checkout', rb.short);
          refreshWorkspace();
        };
        list.appendChild(it);
        rows.push({ name: rb.full.toLowerCase(), el: it, kind: 'remote' });
      }
    }

    const noHit = document.createElement('div');
    noHit.className = 'git-none'; noHit.textContent = 'no match'; noHit.style.display = 'none';
    list.appendChild(noHit);

    const applyBranchFilter = () => {
      const q = search.value.trim().toLowerCase();
      const hideLocal = cbLocal.checked, hideRemote = cbRemote.checked;
      let hits = 0;
      for (const row of rows) {
        if (row.header) continue;
        const kindHidden = (row.kind === 'local' && hideLocal) || (row.kind === 'remote' && hideRemote);
        const show = !kindHidden && (!q || row.name.includes(q));
        row.el.style.display = show ? '' : 'none';
        if (show) hits++;
      }
      // hide a section header when nothing under it is visible
      let curHeader = null, curCount = 0;
      const flush = () => { if (curHeader) curHeader.style.display = curCount ? '' : 'none'; };
      for (const row of rows) {
        if (row.header) { flush(); curHeader = row.el; curCount = 0; }
        else if (row.el.style.display !== 'none') curCount++;
      }
      flush();
      noHit.style.display = hits ? 'none' : '';
    };
    search.oninput = applyBranchFilter;
    cbLocal.onchange = applyBranchFilter;
    cbRemote.onchange = applyBranchFilter;
    search.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); branchMenu.classList.add('hidden'); } };

    const create = document.createElement('div');
    create.className = 'cm-item branch-create'; create.textContent = '＋ Create branch…';
    create.onclick = async () => {
      branchMenu.classList.add('hidden');
      const name = await askText({ title: 'NEW BRANCH', placeholder: 'branch name' });
      if (name) { await gitDo('create-branch', name); refreshWorkspace(); }
    };
    branchMenu.appendChild(create);
  }
  branchMenu.classList.remove('hidden');
  fitDropUp(branchMenu, document.getElementById('git-branch-btn'));
  const sb = branchMenu.querySelector('.branch-search'); if (sb) sb.focus();
};

// Anchor a dropdown to its button using fixed positioning off the button's
// on-screen rect — so it always hangs from the button (not some ancestor) and
// stays inside the viewport, flipping above when there's no room below.
function fitDropUp(menu, anchor) {
  const a = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.right = 'auto';
  // keep the left edge on-screen
  const width = menu.offsetWidth || 200;
  menu.style.left = Math.max(8, Math.min(a.left, window.innerWidth - width - 8)) + 'px';
  const below = window.innerHeight - a.bottom - 12;
  const above = a.top - 12;
  if (below < 200 && above > below) {
    menu.style.top = 'auto';
    menu.style.bottom = (window.innerHeight - a.top + 4) + 'px';   // hang upward from the button
    menu.style.maxHeight = Math.min(340, above) + 'px';
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = (a.bottom + 4) + 'px';
    menu.style.maxHeight = Math.min(340, Math.max(140, below)) + 'px';
  }
}
document.addEventListener('click', e => {
  if (!branchMenu.classList.contains('hidden') && !branchMenu.contains(e.target) && e.target.id !== 'git-branch-btn') {
    branchMenu.classList.add('hidden');
  }
});

document.getElementById('git-fetch').onclick = () => gitDo('fetch');
document.getElementById('git-merge-abort').onclick = async () => {
  const ok = await showAlert({ title: 'ABORT MERGE', message: 'Abort the in-progress merge and restore the pre-merge state?', okText: 'ABORT MERGE', cancelText: 'CANCEL', kind: 'danger' });
  if (ok) { await gitDo('merge-abort'); refreshWorkspace(); }
};

// ---------- history + diff modal ----------
const gitModal = document.getElementById('git-modal');
function closeGitModal() { gitModal.classList.add('hidden'); }
document.getElementById('git-modal-close').onclick = closeGitModal;
gitModal.addEventListener('click', e => { if (e.target === gitModal) closeGitModal(); });

function renderDiff(container, diffText) {
  container.innerHTML = '';
  if (!diffText || !diffText.trim()) { container.innerHTML = '<div class="git-none">no changes to show</div>'; return; }
  const pre = document.createElement('pre');
  pre.className = 'diff-pre';
  for (const line of diffText.split('\n')) {
    const span = document.createElement('span');
    const c = line[0];
    span.className = 'dl ' + (c === '+' && !line.startsWith('+++') ? 'add'
      : c === '-' && !line.startsWith('---') ? 'del'
      : c === '@' ? 'hunk'
      : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---') ? 'meta' : 'ctx');
    span.textContent = line + '\n';
    pre.appendChild(span);
  }
  container.appendChild(pre);
}

async function openDiff({ file, staged, commit }) {
  gitPanel.classList.add('hidden');
  gitModal.querySelector('.git-modal-card').classList.add('diff-only');
  document.getElementById('git-modal-title').textContent = commit ? 'DIFF · ' + commit.slice(0, 8) : 'DIFF · ' + (file || '').replace(/"/g, '').split('/').pop() + (staged ? ' (staged)' : '');
  const diffView = document.getElementById('git-diff-view');
  diffView.innerHTML = '<div class="git-none">loading…</div>';
  gitModal.classList.remove('hidden');
  const r = await window.deck.gitDiff(gitRepo, { file, staged, commit });
  renderDiff(diffView, r.diff);
}

async function openGitHistory() {
  gitPanel.classList.add('hidden');
  gitModal.querySelector('.git-modal-card').classList.remove('diff-only');
  document.getElementById('git-modal-title').textContent = 'HISTORY';
  const list = document.getElementById('git-hist-list');
  const diffView = document.getElementById('git-diff-view');
  list.innerHTML = '<div class="git-none">loading…</div>';
  diffView.innerHTML = '<div class="git-none">select a commit</div>';
  gitModal.classList.remove('hidden');
  const r = await window.deck.gitLog(gitRepo, 60);
  list.innerHTML = '';
  if (!r.ok || !r.commits.length) { list.innerHTML = `<div class="git-none">${esc(r.error || 'no commits')}</div>`; return; }
  for (const c of r.commits) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML = `<div class="hist-subj"></div><div class="hist-meta"><span class="hist-hash">${esc(c.short)}</span> · ${esc(c.author)} · ${esc(c.date)}${c.refs ? ' · <span class="hist-refs"></span>' : ''}</div>`;
    row.querySelector('.hist-subj').textContent = c.subject;
    if (c.refs) row.querySelector('.hist-refs').textContent = c.refs;
    row.onclick = async () => {
      list.querySelectorAll('.hist-row').forEach(x => x.classList.remove('sel'));
      row.classList.add('sel');
      diffView.innerHTML = '<div class="git-none">loading…</div>';
      const d = await window.deck.gitDiff(gitRepo, { commit: c.hash });
      renderDiff(diffView, d.diff);
    };
    list.appendChild(row);
  }
}
document.getElementById('git-history').onclick = openGitHistory;

// ---------- GitHub Actions CI ----------
function parseGh(url) {
  const m = /github[^:/]*[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? { owner: m[1], repo: m[2] } : null;
}
function ciClass(run) {
  return run.status !== 'completed' ? 'run'
    : run.conclusion === 'success' ? 'ok'
    : run.conclusion === 'failure' ? 'fail' : 'warn';
}
function ciLabel(run) {
  return run.status !== 'completed' ? '● running'
    : run.conclusion === 'success' ? '✓ passing'
    : run.conclusion === 'failure' ? '✗ failing' : (run.conclusion || '?');
}

async function ciRefresh() {
  const section = document.getElementById('git-ci');
  const body = document.getElementById('ci-body');
  const state = document.getElementById('ci-state');
  if (!gitRepo) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  state.className = 'ci-state';

  const list = await window.deck.ciList(gitRepo);
  if (!list.files.length) {
    state.textContent = 'not set up';
    body.innerHTML = '<button class="mini-btn ci-scaffold-btn">＋ Add CI workflow</button>';
    body.querySelector('.ci-scaffold-btn').onclick = ciScaffold;
    return;
  }
  state.textContent = 'checking…';
  const st = await window.deck.ciStatus(gitRepo);
  if (!st.ok) { state.textContent = ''; body.innerHTML = `<div class="git-none">${esc(st.error)}</div>`; return; }
  if (!st.runs.length) { state.textContent = 'no runs yet'; body.innerHTML = '<div class="git-none">push to trigger the workflow</div>'; return; }

  state.textContent = ciLabel(st.runs[0]);
  state.className = 'ci-state ' + ciClass(st.runs[0]);
  body.innerHTML = '';
  for (const run of st.runs.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'ci-row';
    row.title = 'Open run in browser';
    row.innerHTML = `<span class="ci-dot ${ciClass(run)}"></span><span class="ci-title"></span><span class="ci-branch"></span>`;
    row.querySelector('.ci-title').textContent = `${run.workflowName}: ${run.displayTitle}`;
    row.querySelector('.ci-branch').textContent = run.headBranch || '';
    row.onclick = () => run.url && window.deck.openExternal(run.url);
    body.appendChild(row);
  }
}

async function ciScaffold() {
  const r = await window.deck.ciScaffold(gitRepo);
  if (!r.ok) { gitOut(r.error, false); return; }
  gitOut('CI created: .github/workflows/ci.yml — commit & push to activate', true);
  exReset(); gitRefresh(); ciRefresh();
}

document.getElementById('ci-refresh').onclick = (e) => { e.stopPropagation(); ciRefresh(); };
document.getElementById('ci-open').onclick = async (e) => {
  e.stopPropagation();
  const r = await window.deck.gitRemotes(gitRepo);
  const origin = (r.remotes || []).find(x => x.name === 'origin') || (r.remotes || [])[0];
  const gh = origin && parseGh(origin.url);
  if (gh) window.deck.openExternal(`https://github.com/${gh.owner}/${gh.repo}/actions`);
  else gitOut('no GitHub remote found', false);
};

// ---------- Pull requests: accordion section (list → diff/comments → review → merge) ----------
const PR_DECISION = {
  APPROVED: { txt: '✓ approved', cls: 'ok', rank: 0 },
  CHANGES_REQUESTED: { txt: '✗ changes requested', cls: 'fail', rank: 2 },
  REVIEW_REQUIRED: { txt: '• review required', cls: 'run', rank: 1 }
};
function prDec(pr) {
  return PR_DECISION[pr.reviewDecision] || { txt: pr.isDraft ? 'draft' : (pr.state || '').toLowerCase(), cls: 'warn', rank: 3 };
}
let ghprExpanded = null;   // number of the currently expanded PR

async function ghprRefresh() {
  const body = document.getElementById('ghpr-body-list') || document.getElementById('ghpr-body');
  const count = document.getElementById('ghpr-count');
  if (!gitRepo) { document.getElementById('git-pr-sec').classList.add('hidden'); return; }
  document.getElementById('git-pr-sec').classList.remove('hidden');
  body.innerHTML = '<div class="git-none">loading…</div>';
  const r = await window.deck.prList(gitRepo);
  if (!r.ok) { count.textContent = ''; body.innerHTML = `<div class="git-none">${esc(r.error)}</div>`; return; }
  const prs = r.prs.slice().sort((a, b) => prDec(a).rank - prDec(b).rank || a.number - b.number);  // approved first
  count.textContent = prs.length || '';
  if (!prs.length) { body.innerHTML = '<div class="git-none">no open pull requests</div>'; return; }
  body.innerHTML = '';
  for (const pr of prs) body.appendChild(ghprRow(pr));
}

function ghprRow(pr) {
  const dec = prDec(pr);
  const wrap = document.createElement('div');
  wrap.className = 'ghpr-item';
  wrap.innerHTML = `
    <div class="ghpr-row">
      <div class="ghpr-main">
        <div class="ghpr-title-line"><span class="ghpr-num">#${pr.number}</span> <span class="ghpr-title-txt"></span></div>
        <div class="ghpr-meta"><span class="ghpr-branch"></span> → <span class="ghpr-base"></span> · <span class="ghpr-dec ${dec.cls}">${dec.txt}</span></div>
      </div>
      <span class="ghpr-open-arrow">›</span>
    </div>`;
  wrap.querySelector('.ghpr-title-txt').textContent = pr.title;
  wrap.querySelector('.ghpr-branch').textContent = pr.headRefName;
  wrap.querySelector('.ghpr-base').textContent = pr.baseRefName;
  wrap.querySelector('.ghpr-row').onclick = () => ghprOpenDetail(pr);
  return wrap;
}

// ---- toast: confirmation feedback for background git/gh actions ----
let toastEl = null, toastTimer = null;
function toast(msg, ok = true) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.className = ok ? 'ok' : 'err';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hide'), 3200);
}

// put a button (and its siblings) into a busy state; returns a restore fn
function btnBusy(btn, label) {
  if (!btn) return () => {};
  const bar = btn.parentElement;
  const prev = btn.textContent;
  const disabled = [];
  if (bar) for (const b of bar.querySelectorAll('button')) { if (!b.disabled) { b.disabled = true; disabled.push(b); } }
  btn.textContent = label;
  btn.classList.add('btn-working');
  return () => {
    btn.textContent = prev;
    btn.classList.remove('btn-working');
    for (const b of disabled) b.disabled = false;
  };
}

// full-page PR view: header + actions + diff (left) + description/comments (right)
const ghprPage = document.getElementById('ghpr-page');
let ghprCurrent = null;
let ghprLastReview = '';   // last AI-review text captured for the current PR
document.getElementById('ghpr-back').onclick = () => ghprPage.classList.add('hidden');

function ghprOpenDetail(pr) {
  ghprCurrent = pr;
  ghprLastReview = '';
  gitPanel.classList.add('hidden');
  const dec = prDec(pr);
  const approved = pr.reviewDecision === 'APPROVED';
  document.getElementById('ghpr-dt-num').textContent = '#' + pr.number;
  document.getElementById('ghpr-dt-titletxt').textContent = pr.title;
  document.getElementById('ghpr-dt-branch').textContent = pr.headRefName;
  document.getElementById('ghpr-dt-base').textContent = pr.baseRefName;
  const decEl = document.getElementById('ghpr-dt-dec');
  decEl.textContent = dec.txt; decEl.className = 'ghpr-dec ' + dec.cls;

  const actions = document.getElementById('ghpr-dt-actions');
  actions.innerHTML = `
    <button class="mini-btn" data-a="review">🤖 AI Review</button>
    <button class="mini-btn" data-a="fix">🔧 Fix from review</button>
    <button class="mini-btn" data-a="approve">✓ Approve</button>
    <button class="mini-btn" data-a="request">✗ Request changes</button>
    <button class="mini-btn" data-a="merge" ${approved ? '' : 'disabled title="merge enabled once approved"'}>⧉ Merge</button>
    <button class="mini-btn" data-a="open">↗ Browser</button>`;
  actions.querySelector('[data-a="open"]').onclick = () => pr.url && window.deck.openExternal(pr.url);
  actions.querySelector('[data-a="approve"]').onclick = (e) => ghprReview(pr.number, 'approve', e.currentTarget);
  actions.querySelector('[data-a="request"]').onclick = (e) => ghprReview(pr.number, 'request', e.currentTarget);
  actions.querySelector('[data-a="review"]').onclick = () => openAiModal('review', pr);
  actions.querySelector('[data-a="fix"]').onclick = () => openAiModal('fix', pr);
  const mergeBtn = actions.querySelector('[data-a="merge"]');
  mergeBtn.onclick = (e) => { if (!mergeBtn.disabled) ghprMerge(pr.number, e.currentTarget); };

  document.getElementById('ghpr-dt-diff').innerHTML = '<div class="git-none">loading diff…</div>';
  document.getElementById('ghpr-dt-desc').textContent = '';
  document.getElementById('ghpr-dt-comments').innerHTML = '<div class="git-none">loading…</div>';
  document.getElementById('ghpr-dt-cmt').value = '';
  ghprPage.classList.remove('hidden');
  ghprLoadDetail(pr);
}

async function ghprLoadDetail(pr) {
  // diff
  window.deck.prDiff(gitRepo, pr.number, pr.baseRefName, pr.headRefName).then(d => {
    const box = document.getElementById('ghpr-dt-diff');
    if (!d.ok) { box.innerHTML = `<div class="git-none">${esc(d.error)}</div>`; return; }
    renderDiff(box, d.diff);
  });
  // description + comments + reviews
  window.deck.prView(gitRepo, pr.number).then(v => {
    const cbox = document.getElementById('ghpr-dt-comments');
    const desc = document.getElementById('ghpr-dt-desc');
    if (!v.ok) { cbox.innerHTML = `<div class="git-none">${esc(v.error)}</div>`; return; }
    desc.textContent = (v.pr.body || '').trim() || '(no description)';
    const items = [];
    for (const rv of (v.pr.reviews || [])) if (rv.body || rv.state) items.push({ who: rv.author && rv.author.login, when: rv.submittedAt, body: (rv.state ? `[${rv.state}] ` : '') + (rv.body || '') });
    for (const c of (v.pr.comments || [])) items.push({ who: c.author && c.author.login, when: c.createdAt, body: c.body });
    if (!items.length) { cbox.innerHTML = '<div class="git-none">no comments yet</div>'; return; }
    cbox.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'ghpr-cmt-item';
      el.innerHTML = `<div class="ghpr-cmt-who"></div><div class="ghpr-cmt-body"></div>`;
      el.querySelector('.ghpr-cmt-who').textContent = (it.who || '?') + (it.when ? ' · ' + new Date(it.when).toLocaleString() : '');
      el.querySelector('.ghpr-cmt-body').textContent = it.body || '';
      cbox.appendChild(el);
    }
  });
}

const ghprSend = document.getElementById('ghpr-dt-send');
const ghprCmtInput = document.getElementById('ghpr-dt-cmt');
async function ghprDoComment() {
  if (!ghprCurrent) return;
  const text = ghprCmtInput.value.trim();
  if (!text) return;
  ghprSend.disabled = true; ghprSend.textContent = '…';
  const r = await window.deck.prComment(gitRepo, ghprCurrent.number, text);
  ghprSend.disabled = false; ghprSend.textContent = 'Comment';
  if (!r.ok) { await showAlert({ title: 'COMMENT FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  ghprCmtInput.value = '';
  ghprLoadDetail(ghprCurrent);
}
ghprSend.onclick = ghprDoComment;
ghprCmtInput.addEventListener('keydown', e => { if (e.key === 'Enter') ghprDoComment(); });

async function ghprReview(number, action) {
  let r;
  if (action === 'request') {
    // the reason dialog itself shows the processing state while gh runs
    const out = await askText({
      title: 'REQUEST CHANGES', placeholder: 'what needs changing?',
      work: (v) => window.deck.prReview(gitRepo, number, 'request', v),
      workingText: '⏳ SUBMITTING…'
    });
    if (out === null) return;
    r = out.res;
  } else {
    // confirm modal doubles as the progress indicator
    const res = await showAlert({
      title: `APPROVE PR #${number}`, message: 'Submit an approving review for this pull request?',
      okText: 'APPROVE', cancelText: 'CANCEL',
      work: () => window.deck.prReview(gitRepo, number, 'approve', ''),
      workingText: '⏳ APPROVING…'
    });
    if (res === false) return;
    r = res;
  }
  if (!r || !r.ok) { toast(`✗ review failed: ${((r && (r.error || r.out)) || '').slice(0, 120)}`, false); return; }
  toast(action === 'approve' ? `✓ PR #${number} approved` : `✓ changes requested on PR #${number}`);
  await ghprRefresh();
  // re-open the detail with fresh state so Approve flips the Merge button on
  if (ghprCurrent && ghprCurrent.number === number && !ghprPage.classList.contains('hidden')) {
    const list = await window.deck.prList(gitRepo);
    const fresh = list.ok && list.prs.find(p => p.number === number);
    if (fresh) ghprOpenDetail(fresh);
  }
}

async function ghprMerge(number) {
  // the confirm modal stays open and shows MERGING… while gh works
  const res = await showAlert({
    title: `MERGE PR #${number}`, message: 'Squash-merge this PR and delete its branch?',
    okText: 'MERGE', cancelText: 'CANCEL', kind: 'danger',
    work: () => window.deck.prMerge(gitRepo, number, 'squash'),
    workingText: '⏳ MERGING…'
  });
  if (res === false) return;
  if (!res || !res.ok) { toast(`✗ merge failed: ${((res && (res.error || res.out)) || '').slice(0, 120)}`, false); return; }
  toast(`✓ PR #${number} squash-merged · branch deleted`);
  ghprPage.classList.add('hidden');   // PR is gone now
  ghprRefresh(); gitRefresh(); refreshWorkspace();
}

// ---------- AI Review / Fix modal (agent + model picker, live activity, result) ----------
const aiModal = document.getElementById('ai-modal');
const aiState = { mode: null, pr: null, running: false, streamEl: null, resultText: '', runAgentId: null, thinkEl: null };

// toggle the Start button into an Abort button while a run is live, and show a
// pulsing "thinking…" indicator at the bottom of the activity log
function aiSetRunning(on) {
  aiState.running = on;
  const btn = document.getElementById('ai-start');
  document.getElementById('ai-agent').disabled = on;
  document.getElementById('ai-model').disabled = on;
  if (on) {
    btn.textContent = '■ Abort';
    btn.classList.add('ai-abort');
    const live = document.getElementById('ai-live');
    aiState.thinkEl = document.createElement('div');
    aiState.thinkEl.className = 'ai-line ai-thinking';
    aiState.thinkEl.textContent = '⏳ thinking';
    live.appendChild(aiState.thinkEl);
  } else {
    btn.textContent = '▶ Start';
    btn.classList.remove('ai-abort');
    if (aiState.thinkEl) { aiState.thinkEl.remove(); aiState.thinkEl = null; }
  }
}

function aiPopulate(mode) {
  const agSel = document.getElementById('ai-agent');
  agSel.innerHTML = '';
  for (const a of agents) {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = `${ROLE_ICON[a.role] || ''} ${a.name}`;
    agSel.appendChild(o);
  }
  const mdSel = document.getElementById('ai-model');
  mdSel.innerHTML = '';
  for (const [id, label] of Object.entries(MODEL_LABELS)) {
    const o = document.createElement('option'); o.value = id; o.textContent = label; mdSel.appendChild(o);
  }
  // consistency: reuse the LAST agent+model chosen for this mode; otherwise a
  // strong default (Opus) so reviews don't silently vary by model each run
  const savedAg = localStorage.getItem('ai_' + mode + '_agent');
  const savedMd = localStorage.getItem('ai_' + mode + '_model');
  const defAg = (savedAg && agents.find(a => a.id === savedAg)) ? savedAg : (byRole(mode === 'review' ? 'reviewer' : 'senior')[0] || {}).id;
  if (defAg) agSel.value = defAg;
  const defMd = (savedMd && MODEL_LABELS[savedMd]) ? savedMd : 'claude-opus-4-8';
  mdSel.value = defMd;
}
function aiSaveChoice() {
  if (!aiState.mode) return;
  localStorage.setItem('ai_' + aiState.mode + '_agent', document.getElementById('ai-agent').value);
  localStorage.setItem('ai_' + aiState.mode + '_model', document.getElementById('ai-model').value);
}
document.getElementById('ai-agent').onchange = aiSaveChoice;
document.getElementById('ai-model').onchange = aiSaveChoice;

function openAiModal(mode, pr) {
  aiState.mode = mode; aiState.pr = pr; aiState.running = false; aiState.streamEl = null; aiState.resultText = '';
  document.getElementById('ai-modal-title').textContent = (mode === 'review' ? 'AI REVIEW' : 'FIX FROM REVIEW') + ` · PR #${pr.number}`;
  document.getElementById('ai-sub').textContent = mode === 'review'
    ? 'The agent reads the PR diff and reports findings + a verdict.'
    : 'The agent validates the PR review/comments against the diff, then plans a fix.';
  aiPopulate(mode);
  document.getElementById('ai-live').innerHTML = '<div class="git-none">pick an agent + model, then press Start</div>';
  document.getElementById('ai-final-wrap').classList.add('hidden');
  document.getElementById('ai-final').textContent = '';
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-post').classList.add('hidden');
  document.getElementById('ai-start').disabled = false;
  aiModal.classList.remove('hidden');
}
document.getElementById('ai-close').onclick = () => aiModal.classList.add('hidden');

function aiLiveLine(text, cls) {
  const live = document.getElementById('ai-live');
  const el = document.createElement('div');
  el.className = 'ai-line ' + (cls || '');
  el.textContent = text;
  live.appendChild(el);
  if (aiState.thinkEl) live.appendChild(aiState.thinkEl);   // keep it pinned to the bottom
  live.scrollTop = live.scrollHeight;
  return el;
}
function aiOnEvent(ev) {
  const live = document.getElementById('ai-live');
  if (ev.kind === 'init') { aiState.streamEl = null; aiLiveLine(`▸ session ${String(ev.sessionId).slice(0, 8)} · ${ev.model}`, 'sys'); }
  else if (ev.kind === 'tool') {
    aiState.streamEl = null;
    let detail = ''; try { const i = JSON.parse(ev.input); detail = i.file_path || i.path || i.command || i.pattern || i.query || ''; } catch {}
    aiLiveLine(`⚙ ${ev.tool} ${String(detail).slice(0, 100)}`, 'tool');
  } else if (ev.kind === 'text-delta') {
    if (!aiState.streamEl) aiState.streamEl = aiLiveLine('', 'txt');
    aiState.streamEl.textContent += ev.text;
    live.scrollTop = live.scrollHeight;
  } else if (ev.kind === 'text-end') { aiState.streamEl = null; }
  else if (ev.kind === 'result') { aiLiveLine(`◆ ${String(ev.subtype).toUpperCase()} · ${ev.numTurns} turns · ${(ev.durationMs / 1000).toFixed(1)}s`, 'ok'); }
  else if (ev.kind === 'error') { aiLiveLine('⚠ ' + ev.error, 'err'); }
}

document.getElementById('ai-start').onclick = async () => {
  if (aiState.running) {                       // Abort
    if (aiState.runAgentId) stopAgent(aiState.runAgentId);
    aiLiveLine('■ abort requested…', 'err');
    return;
  }
  const agentId = document.getElementById('ai-agent').value;
  const model = document.getElementById('ai-model').value;
  const a = agents.find(x => x.id === agentId);
  if (!a) return;
  if (R(agentId).running) { await showAlert({ title: 'AGENT BUSY', message: `${a.name} is already running.`, okText: 'OK' }); return; }
  const pr = aiState.pr;
  const d = await window.deck.prDiff(gitRepo, pr.number, pr.baseRefName, pr.headRefName);
  if (!d.ok || !d.diff.trim()) { await showAlert({ title: 'NO DIFF', message: d.error || 'this PR has no diff.', okText: 'OK' }); return; }

  aiSaveChoice();   // remember this agent+model for next time (consistency)
  let prompt, plan = false;
  if (aiState.mode === 'review') {
    // strict rubric + fixed output schema → different models produce comparable,
    // repeatable reviews instead of free-form prose that varies by model
    prompt = `You are a code reviewer. Review ONLY the diff below against this fixed rubric. Be deterministic and terse — output ONLY the format specified, no preamble or prose.

PR #${pr.number}: ${pr.title}  (${pr.headRefName} → ${pr.baseRefName})

Check these categories IN THIS ORDER, and report only issues actually present in the diff:
1. CORRECTNESS — bugs, logic errors, unhandled edge cases, broken contracts
2. SECURITY — injection, auth, secrets, unsafe input
3. PERFORMANCE — needless work, N+1, blocking calls
4. MAINTAINABILITY — dead code, naming, duplication

OUTPUT FORMAT — one line per finding, nothing else:
[SEVERITY] path:line — <issue in <=15 words> — fix: <suggested fix in <=15 words>
SEVERITY is exactly one of: BLOCKER, MAJOR, MINOR, NIT.
Sort findings by severity (BLOCKER first). If a category has none, output nothing for it.

Then a blank line, then EXACTLY one final line:
VERDICT: APPROVE
— or —
VERDICT: REQUEST CHANGES — <one sentence why>
(Use REQUEST CHANGES if and only if there is at least one BLOCKER or MAJOR.)

=== DIFF ===
${d.diff.slice(0, 60000)}`;
  } else {
    const v = await window.deck.prView(gitRepo, pr.number);
    const notes = [];
    if (v.ok) {
      for (const rv of (v.pr.reviews || [])) if (rv.body || rv.state) notes.push(`- [${rv.state || 'review'}] ${(rv.author && rv.author.login) || '?'}: ${rv.body || ''}`);
      for (const c of (v.pr.comments || [])) notes.push(`- ${(c.author && c.author.login) || '?'}: ${c.body || ''}`);
    }
    if (!notes.length) { await showAlert({ title: 'NO REVIEW/COMMENTS', message: 'This PR has no review or comments yet. Run AI Review and post it (or add a comment) first.', okText: 'OK' }); return; }
    prompt = `You are a fixer AI working on pull request #${pr.number} (${pr.title}), branch ${pr.headRefName}.

Below are the REVIEW COMMENTS on this PR. Your job:
1. VALIDATE each point against the actual diff — is it a real, correct concern? Note any you disagree with and why.
2. For valid ones, produce a concrete FIX PLAN: exact files, the change, and how you'll verify it.
Do NOT write code yet — this is plan mode. Present the validated findings and the plan.

=== REVIEW / COMMENTS ===
${notes.join('\n')}

=== PR DIFF ===
${(d.diff || '').slice(0, 55000)}`;
    plan = true;
  }

  document.getElementById('ai-live').innerHTML = '';
  document.getElementById('ai-final-wrap').classList.add('hidden');
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-post').classList.add('hidden');
  document.getElementById('ai-approve').classList.add('hidden');
  document.getElementById('ai-fullview-btn').classList.add('hidden');
  aiState.streamEl = null; aiState.runAgentId = agentId;
  aiSetRunning(true);
  aiLiveLine(`starting ${a.name} on ${MODEL_LABELS[model]}…`, 'sys');

  runAgent(agentId, prompt, false, plan, {
    fresh: true, model,
    onEvent: aiOnEvent,
    onDone: (result, text) => {
      aiSetRunning(false);
      aiState.resultText = (text || '').trim();
      const fw = document.getElementById('ai-final-wrap');
      document.getElementById('ai-final-label').textContent = aiState.mode === 'review' ? 'REVIEW RESULT' : 'FIX PLAN';
      document.getElementById('ai-final').textContent = aiState.resultText || '(no text returned)';
      fw.classList.remove('hidden');
      if (result === 'aborted') { aiLiveLine('■ aborted by operator.', 'err'); return; }
      if (result !== 'success' || !aiState.resultText) return;
      document.getElementById('ai-fullview-btn').classList.remove('hidden');
      if (aiState.mode === 'review') {
        document.getElementById('ai-post').classList.remove('hidden');
        document.getElementById('ai-approve').classList.remove('hidden');
      } else {
        document.getElementById('ai-apply').classList.remove('hidden');
      }
    }
  });
};

// ---- full-screen result view (with approve/apply) ----
const aiFullview = document.getElementById('ai-fullview');
document.getElementById('aifv-back').onclick = () => aiFullview.classList.add('hidden');
function openAiFullview() {
  document.getElementById('aifv-title').textContent = (aiState.mode === 'review' ? 'AI REVIEW' : 'FIX PLAN') + ` · PR #${aiState.pr.number}`;
  document.getElementById('aifv-body').textContent = aiState.resultText || '(no result)';
  const acts = document.getElementById('aifv-actions');
  acts.innerHTML = aiState.mode === 'review'
    ? '<button class="mini-btn" data-a="post">💬 Post as comment</button><button class="mini-btn" data-a="approve">✓ Approve PR</button>'
    : '<button class="mini-btn" data-a="apply">🔧 Apply Fix</button>';
  const post = acts.querySelector('[data-a="post"]'); if (post) post.onclick = () => document.getElementById('ai-post').click();
  const appr = acts.querySelector('[data-a="approve"]'); if (appr) appr.onclick = () => document.getElementById('ai-approve').click();
  const apply = acts.querySelector('[data-a="apply"]'); if (apply) apply.onclick = () => { aiFullview.classList.add('hidden'); document.getElementById('ai-apply').click(); };
  aiFullview.classList.remove('hidden');
}
document.getElementById('ai-fullview-btn').onclick = openAiFullview;
document.getElementById('ai-approve').onclick = async (e) => {
  await ghprReview(aiState.pr.number, 'approve', e.currentTarget);
  aiFullview.classList.add('hidden');
  aiModal.classList.add('hidden');
};

// review mode: post the result as a PR comment
document.getElementById('ai-post').onclick = async () => {
  if (!aiState.resultText) return;
  const btn = document.getElementById('ai-post');
  btn.disabled = true; btn.textContent = 'posting…';
  const r = await window.deck.prComment(gitRepo, aiState.pr.number, `### 🤖 AI Review\n\n${aiState.resultText}`);
  btn.disabled = false; btn.textContent = '💬 Post as comment';
  if (!r.ok) { await showAlert({ title: 'POST FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  plog('ok', `AI review posted on PR #${aiState.pr.number}.`);
  if (ghprCurrent && ghprCurrent.number === aiState.pr.number) ghprLoadDetail(ghprCurrent);
};

// fix mode: apply the plan — the same agent implements it for real, then we refresh
document.getElementById('ai-apply').onclick = async () => {
  if (!aiState.resultText) return;
  const agentId = document.getElementById('ai-agent').value;
  const model = document.getElementById('ai-model').value;
  const a = agents.find(x => x.id === agentId);
  if (R(agentId).running) { await showAlert({ title: 'AGENT BUSY', message: `${a.name} is already running.`, okText: 'OK' }); return; }
  document.getElementById('ai-live').innerHTML = '';
  document.getElementById('ai-apply').classList.add('hidden');
  document.getElementById('ai-fullview-btn').classList.add('hidden');
  aiState.streamEl = null; aiState.runAgentId = agentId;
  aiSetRunning(true);
  aiLiveLine('applying the fix plan…', 'sys');
  const prompt = `Implement the following fix plan for real (you are out of plan mode). Make the edits, then verify.

=== FIX PLAN ===
${aiState.resultText}`;
  runAgent(agentId, prompt, false, false, {
    fresh: true, model,
    onEvent: aiOnEvent,
    onDone: (result) => {
      aiSetRunning(false);
      aiLiveLine(result === 'success' ? '✔ fix applied — review the changes in Source Control, then commit/push.' : (result === 'aborted' ? '■ aborted.' : '✗ fix run ended: ' + result), result === 'success' ? 'ok' : 'err');
      gitRefresh(); refreshWorkspace();
    }
  });
};

// create-PR dialog
const ghprModal = document.getElementById('ghpr-modal');
document.getElementById('ghpr-close').onclick = () => ghprModal.classList.add('hidden');
ghprModal.addEventListener('click', e => { if (e.target === ghprModal) ghprModal.classList.add('hidden'); });
document.getElementById('ghpr-refresh').onclick = (e) => { e.stopPropagation(); ghprRefresh(); };
// searchable head-branch picker for the New PR dialog
let ghprHead = '';   // chosen source branch
let ghprBranchList = [];   // all branch short-names (local + remote, deduped)
const ghprHeadMenu = document.getElementById('ghpr-head-menu');
function ghprRenderHeadList(q) {
  const list = document.getElementById('ghpr-head-list');
  list.innerHTML = '';
  const ql = (q || '').toLowerCase();
  const hits = ghprBranchList.filter(b => !ql || b.toLowerCase().includes(ql));
  if (!hits.length) { list.innerHTML = '<div class="git-none">no match</div>'; return; }
  for (const b of hits.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'sbranch-item' + (b === ghprHead ? ' sel' : '');
    row.textContent = b;
    row.onclick = () => {
      ghprHead = b;
      document.getElementById('ghpr-head-btn').textContent = '⎇ ' + b;
      ghprHeadMenu.classList.add('hidden');
    };
    list.appendChild(row);
  }
}
document.getElementById('ghpr-head-btn').onclick = (e) => {
  e.stopPropagation();
  const open = ghprHeadMenu.classList.toggle('hidden');
  if (!open) { const s = document.getElementById('ghpr-head-search'); s.value = ''; ghprRenderHeadList(''); s.focus(); }
};
document.getElementById('ghpr-head-search').oninput = (e) => ghprRenderHeadList(e.target.value);
document.getElementById('ghpr-head-search').onclick = (e) => e.stopPropagation();
document.addEventListener('click', (e) => { if (!ghprHeadMenu.classList.contains('hidden') && !e.target.closest('.sbranch')) ghprHeadMenu.classList.add('hidden'); });

document.getElementById('ghpr-new').onclick = async (e) => {
  e.stopPropagation();
  const st = await window.deck.gitStatus(gitRepo);
  const cur = st.ok ? st.branch : '';
  // gather every branch (local + remote short names, deduped), current first
  const b = await window.deck.gitBranches(gitRepo);
  const seen = new Set(); ghprBranchList = [];
  const add = n => { if (n && !seen.has(n)) { seen.add(n); ghprBranchList.push(n); } };
  if (cur) add(cur);
  for (const l of (b.ok ? b.local : [])) add(l.name);
  for (const rb of (b.ok ? b.remote : [])) if (!/\/HEAD$|->/.test(rb)) add(rb.replace(/^[^/]+\//, ''));
  ghprHead = cur;
  document.getElementById('ghpr-head-btn').textContent = cur ? '⎇ ' + cur : 'select branch…';
  // base options (everything except the head), default main/master/qa
  const sel = document.getElementById('ghpr-base-sel');
  sel.innerHTML = '';
  for (const name of ghprBranchList.filter(x => x !== cur)) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  const def = ghprBranchList.find(x => x === 'main') || ghprBranchList.find(x => x === 'master') || ghprBranchList.find(x => x === 'qa') || sel.options[0]?.value;
  if (def) sel.value = def;
  document.getElementById('ghpr-title').value = '';
  document.getElementById('ghpr-body').value = '';
  ghprHeadMenu.classList.add('hidden');
  ghprModal.classList.remove('hidden');
  document.getElementById('ghpr-title').focus();
};
// ---- PR conflict resolve flow: merge base→head, resolve, commit+push, create ----
let prConflictCtx = null;   // { base, head, title, body, files: [] }

function openNextPrConflict() {
  if (!prConflictCtx) return;
  if (!prConflictCtx.files.length) { finishPrConflict(); return; }
  const rel = prConflictCtx.files[0];
  const n = prConflictCtx.total - prConflictCtx.files.length + 1;
  openConflictResolver(rel, {
    progress: `PR conflict ${n}/${prConflictCtx.total} · ${prConflictCtx.head} ← ${prConflictCtx.base}`,
    aiRule: `This is a MERGE of "${prConflictCtx.base}" (INCOMING/theirs) into "${prConflictCtx.head}" (CURRENT/ours). For each conflict: if it touches OUR intended change on ${prConflictCtx.head}, keep CURRENT (ours win). If it is unrelated to our change (only their base update), take INCOMING (theirs). If both changes are needed and independent, take BOTH.`,
    after: () => { prConflictCtx.files.shift(); openNextPrConflict(); }
  });
}

async function finishPrConflict() {
  const ctx = prConflictCtx; prConflictCtx = null;
  toast('conflicts resolved — committing merge & pushing…');
  const c = await window.deck.gitCmd(gitRepo, 'commit', `Merge ${ctx.base} into ${ctx.head} (resolve conflicts)`);
  if (!c.ok) { await showAlert({ title: 'MERGE COMMIT FAILED', message: c.out, okText: 'OK' }); return; }
  const p = await pushOrPublish();
  if (!p.ok) { await showAlert({ title: 'PUSH FAILED', message: p.out, okText: 'OK' }); return; }
  const r = await window.deck.prCreate(gitRepo, { title: ctx.title, body: ctx.body, base: ctx.base, head: ctx.head });
  if (!r.ok) { await showAlert({ title: 'CREATE FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  toast(`✓ resolved + pushed + PR created: ${ctx.head} → ${ctx.base}`);
  gitRefresh(); ghprRefresh(); refreshWorkspace();
}

document.getElementById('ghpr-create-btn').onclick = async () => {
  const title = document.getElementById('ghpr-title').value.trim();
  if (!ghprHead) { await showAlert({ title: 'PICK A BRANCH', message: 'Choose the source branch to open the PR from.', okText: 'OK' }); return; }
  if (!title) { document.getElementById('ghpr-title').focus(); return; }
  const body = document.getElementById('ghpr-body').value;
  const base = document.getElementById('ghpr-base-sel').value;
  const btn = document.getElementById('ghpr-create-btn');
  btn.disabled = true; btn.textContent = 'checking conflicts…';
  const chk = await window.deck.prConflictCheck(gitRepo, base, ghprHead);
  if (chk.ok && chk.conflict) {
    btn.disabled = false; btn.textContent = 'Create PR';
    const proceed = await showAlert({
      title: 'MERGE CONFLICTS',
      message: `This PR (${ghprHead} → ${base}) has merge conflicts in ${chk.files.length} file(s). Merge ${base} into ${ghprHead} now so you can resolve them (AI or manual), then it auto-commits, pushes, and creates the PR.`,
      okText: 'RESOLVE NOW', cancelText: 'CANCEL', kind: 'warn',
      work: () => window.deck.prStartMerge(gitRepo, base, ghprHead)
    });
    if (proceed === false) return;
    if (!proceed || !proceed.ok) { toast('✗ ' + ((proceed && proceed.error) || 'could not start the merge'), false); return; }
    ghprModal.classList.add('hidden');
    if (!proceed.conflict) {   // merged clean unexpectedly — just commit/push/create
      prConflictCtx = { base, head: ghprHead, title, body, files: [], total: 0 };
      finishPrConflict();
    } else {
      prConflictCtx = { base, head: ghprHead, title, body, files: proceed.files.slice(), total: proceed.files.length };
      plog('info', `PR conflicts: ${proceed.files.length} file(s) to resolve, then commit + push + create.`);
      openNextPrConflict();
    }
    return;
  }
  // no conflict → create directly
  btn.textContent = 'creating…';
  const r = await window.deck.prCreate(gitRepo, { title, body, base, head: ghprHead });
  btn.disabled = false; btn.textContent = 'Create PR';
  if (!r.ok) { await showAlert({ title: 'CREATE FAILED', message: r.error || r.out, okText: 'OK' }); return; }
  toast(`✓ PR created: ${ghprHead} → ${base}`);
  ghprModal.classList.add('hidden');
  ghprRefresh();
};

// collapsible sections (Staged / Changes / Conflicts / CI): click the header to
// hide or show its children. Action buttons inside the header keep working.
document.querySelectorAll('#git-panel .git-section > .git-sec-head').forEach(head => {
  head.classList.add('accordion');
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;   // let stage-all / refresh / etc. through
    head.parentElement.classList.toggle('collapsed');
  });
});

