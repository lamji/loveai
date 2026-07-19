// Extracted from app.js — classic script, shares global scope. Keep load order.

// ============================================================
// COMMIT FLOW — stateful modal that survives hook rejections:
// commit → (hook/check error shown inline) → 🔧 Fix with AI (streams live with a
// thinking indicator) → commit message again → retry. Only closes on success.
// ============================================================
const CMT_LABEL = { plain: 'COMMIT', amend: 'COMMIT (AMEND)', push: 'COMMIT & PUSH', sync: 'COMMIT & SYNC' };
const cmtModal = document.getElementById('cmt-modal');
const cmt = { kind: 'plain', running: false, aiAgentId: null, streamEl: null, thinkEl: null, gitEl: null, lastError: '', streamId: null, autoPush: false };

function cmtEl(id) { return document.getElementById(id); }
function cmtStepMark(step, cls) {
  const el = cmtModal.querySelector(`.cmt-step[data-step="${step}"]`);
  if (el) el.className = 'cmt-step ' + (cls || '');
}

// ===== PUSH FLAGS — searchable multi-select menu next to the PUSH button =====
const PUSH_FLAGS = [
  { flag: '--force-with-lease', label: 'Force (safe)', hint: 'Overwrite the remote, but fail if it has commits you have not fetched yet' },
  { flag: '--force', label: 'Force', hint: 'Overwrite the remote branch unconditionally — can destroy other people’s work' },
  { flag: '--force-if-includes', label: 'Force if includes', hint: 'With Force (safe): also require the remote tip is already integrated locally' },
  { flag: '--no-verify', label: 'Skip hooks', hint: 'Bypass the pre-push hook' },
  { flag: '--tags', label: 'Push tags', hint: 'Push all local tags along with this push' },
  { flag: '--follow-tags', label: 'Follow tags', hint: 'Push annotated tags reachable from the pushed commits' },
  { flag: '--atomic', label: 'Atomic', hint: 'All refs update together, or none do' },
  { flag: '--prune', label: 'Prune', hint: 'Remove remote branches that no longer exist locally' },
  { flag: '--dry-run', label: 'Dry run', hint: 'Show what would be pushed without actually pushing anything' },
  { flag: '--no-thin', label: 'No thin pack', hint: 'Disable the thin-pack transfer optimization' },
  { flag: '-v', label: 'Verbose', hint: 'Verbose push output' }
];
const cmtPushFlags = new Set();   // extra flags selected for the NEXT push — reset per modal open

function cmtPushBadgeSync() {
  const badge = cmtEl('cmt-push-badge');
  badge.textContent = cmtPushFlags.size;
  badge.classList.toggle('hidden', !cmtPushFlags.size);
}

function cmtRenderPushFlags(filter) {
  const box = cmtEl('cmt-push-flaglist');
  box.innerHTML = '';
  const q = (filter || '').trim().toLowerCase();
  const rows = PUSH_FLAGS.filter(f => !q ||
    f.flag.toLowerCase().includes(q) || f.label.toLowerCase().includes(q));
  if (!rows.length) { box.innerHTML = '<div class="git-none">no matching flag</div>'; return; }
  for (const f of rows) {
    const row = document.createElement('label');
    row.className = 'cm-item cmt-push-flag-row';
    row.title = f.hint;
    row.innerHTML = '<input type="checkbox" />' +
      '<span class="cmt-push-flag-name"></span><code class="cmt-push-flag-code"></code>';
    row.querySelector('input').checked = cmtPushFlags.has(f.flag);
    row.querySelector('.cmt-push-flag-name').textContent = f.label;
    row.querySelector('.cmt-push-flag-code').textContent = f.flag;
    row.querySelector('input').onchange = (e) => {
      if (e.target.checked) cmtPushFlags.add(f.flag); else cmtPushFlags.delete(f.flag);
      cmtPushBadgeSync();
    };
    box.appendChild(row);
  }
}

document.getElementById('cmt-push-caret').onclick = (e) => {
  e.stopPropagation();
  const menu = cmtEl('cmt-push-menu');
  if (menu.classList.contains('hidden')) {
    cmtEl('cmt-push-search').value = '';
    cmtRenderPushFlags('');
    menu.classList.remove('hidden');
    cmtEl('cmt-push-search').focus();
  } else {
    menu.classList.add('hidden');
  }
};
document.getElementById('cmt-push-search').oninput = (e) => cmtRenderPushFlags(e.target.value);
document.getElementById('cmt-push-search').addEventListener('keydown', e => e.stopPropagation());
document.addEventListener('click', (e) => {
  const menu = cmtEl('cmt-push-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'cmt-push-caret') {
    menu.classList.add('hidden');
  }
});

// pull a diff to feed the message/PR generators (staged first, else all changes)
async function cmtChangeDiff() {
  let d = await window.deck.gitDiff(gitRepo, { staged: true });
  if (d.ok && d.diff && d.diff.trim()) return d.diff;
  d = await window.deck.gitDiff(gitRepo, {});
  return (d.ok && d.diff) ? d.diff : '';
}

// ✨ generate a concise commit message from the diff (Haiku)
async function cmtGenMessage() {
  const btn = cmtEl('cmt-gen-msg');
  const overlay = cmtEl('cmt-gen-overlay');
  const prev = btn.textContent; btn.disabled = true; btn.textContent = '⏳';
  overlay.classList.remove('hidden');            // spinner over the input
  cmtEl('cmt-msg').classList.add('generating');
  const end = () => { btn.disabled = false; btn.textContent = prev; overlay.classList.add('hidden'); cmtEl('cmt-msg').classList.remove('generating'); };
  const diff = await cmtChangeDiff();
  if (!diff.trim()) { end(); cmtEl('cmt-summary').textContent = 'no changes to summarize'; return; }
  const prompt = `Write a git commit message for this diff. One imperative subject line (<72 chars). If the change is non-trivial, add a blank line then 1-3 short bullet lines. Output ONLY the commit message — no quotes, no preamble.

=== DIFF ===
${diff.slice(0, 30000)}`;
  const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', gitRepo);
  end();
  if (r.ok && r.text) cmtEl('cmt-msg').value = r.text.replace(/^["'`]|["'`]$/g, '').trim();
  else cmtEl('cmt-summary').textContent = '✗ generate failed: ' + (r.error || 'no text');
}
document.getElementById('cmt-gen-msg').onclick = cmtGenMessage;

async function openCommitModal(kind) {
  cmt.kind = kind; cmt.running = false; cmt.lastError = ''; cmt.gitEl = null;
  cmt.autoPush = (kind === 'push' || kind === 'sync');
  cmtPushFlags.clear(); cmtPushBadgeSync();   // never carry a flag like --force silently into a new push
  cmtEl('cmt-push-menu').classList.add('hidden');
  const st = await window.deck.gitStatus(gitRepo);
  cmt.willStageAll = st.ok && !st.staged.length && (st.unstaged.length || st.untracked.length);
  cmt.branch = st.branch || '';
  const fileCount = cmt.willStageAll ? (st.unstaged.length + st.untracked.length) : (st.ok ? st.staged.length : 0);
  cmtEl('cmt-title').textContent = 'COMMIT · ' + (st.branch || '');
  cmtEl('cmt-summary').textContent = `${fileCount} file(s)${cmt.willStageAll ? ' — will stage all first' : ' staged'}`;
  cmtEl('cmt-msg').value = cmtEl('git-msg').value.trim();
  cmtEl('cmt-msg-block').classList.remove('hidden');
  cmtEl('cmt-pr-row').classList.add('hidden');
  cmtEl('cmt-error-wrap').classList.add('hidden');
  cmtEl('cmt-live-wrap').classList.add('hidden');
  cmtEl('cmt-live').innerHTML = '';
  for (const s of ['commit', 'push', 'pr']) cmtStepMark(s, '');
  // RESUME — everything already committed (e.g. modal was closed mid-flow):
  // skip straight to the push step instead of showing an empty commit form
  const clean = st.ok && !st.staged.length && !st.unstaged.length &&
    !st.untracked.length && !(st.conflicts || []).length;
  if (clean && kind !== 'amend' && (st.ahead > 0 || !st.upstream)) {
    cmtEl('cmt-title').textContent = 'CONTINUE · ' + (st.branch || '');
    cmtEl('cmt-summary').textContent = st.ahead > 0
      ? `${st.ahead} unpushed commit(s) on ${st.branch} — continue: push, then create the PR`
      : `${st.branch} isn't published yet — continue: push, then create the PR`;
    cmtStepMark('commit', 'done');
    cmtSetState('committed');
    cmtModal.classList.remove('hidden');
    return;
  }
  if (clean && kind !== 'amend') {
    cmtEl('cmt-summary').textContent = 'nothing to commit — working tree clean and pushed';
  }
  cmtSetState('compose');
  cmtModal.classList.remove('hidden');
  cmtEl('cmt-msg').focus();
  // auto-generate the commit message from the changes when none was typed
  if (!cmtEl('cmt-msg').value.trim() && kind !== 'amend' && !clean) cmtGenMessage();
}

// visible buttons per state
function cmtSetState(state) {
  cmt.state = state;
  const show = (id, on) => cmtEl(id).classList.toggle('hidden', !on);
  const dis = (id, on) => { cmtEl(id).disabled = on; };
  const busy = ['committing', 'pushing', 'fixing', 'creating'].includes(state);
  // the message editor only matters while composing/fixing the commit itself —
  // after that it's dead weight (an empty disabled box), so hide it
  const composing = ['compose', 'error', 'committing', 'fixing'].includes(state);
  cmtEl('cmt-msg-block').classList.toggle('hidden', !composing);
  cmtEl('cmt-commit').classList.remove('btn-working');
  show('cmt-commit', state === 'compose' || state === 'error');
  show('cmt-push-wrap', state === 'committed');
  show('cmt-pr', state === 'pushed');
  show('cmt-close', state === 'done');
  show('cmt-fix', state === 'error');
  show('cmt-abort', state === 'fixing');
  show('cmt-cancel', state !== 'done');
  dis('cmt-cancel', busy);
  cmtEl('cmt-msg').disabled = busy || state !== 'compose' && state !== 'error';
  if (state === 'error') cmtEl('cmt-commit').textContent = '↻ Retry commit';
  if (state === 'compose') cmtEl('cmt-commit').textContent = '✓ ' + (CMT_LABEL[cmt.kind] || 'COMMIT');
}

// ----- live log (git process + AI process share the same panel) -----
function cmtLive(text, cls) {
  const live = cmtEl('cmt-live');
  const el = document.createElement('div');
  el.className = 'ai-line ' + (cls || '');
  el.textContent = text;
  live.appendChild(el);
  if (cmt.thinkEl) live.appendChild(cmt.thinkEl);
  live.scrollTop = live.scrollHeight;
  return el;
}
function cmtShowLive(label) {
  cmtEl('cmt-live-wrap').classList.remove('hidden');
  cmtEl('cmt-live-label').textContent = label;
}
// stream a git op's stdout/stderr live into the panel
async function cmtGitStream(op, arg) {
  cmt.streamId = uid(); cmt.gitEl = null;
  const pretty = Array.isArray(arg) ? arg.join(' ')
    : (arg && typeof arg === 'object') ? [arg.branch, ...(arg.flags || [])].join(' ')
    : (arg && arg !== '*' ? arg : '');
  cmtLive(`$ git ${op}${pretty ? ' ' + pretty : ''}`, 'sys');
  const r = await window.deck.gitStream(gitRepo, op, arg, cmt.streamId);
  cmt.streamId = null; cmt.gitEl = null;
  return r;
}
// append raw git output as it arrives (routed from the global listener)
function cmtAppendGit(data) {
  const live = cmtEl('cmt-live');
  if (!cmt.gitEl) { cmt.gitEl = document.createElement('div'); cmt.gitEl.className = 'ai-line git'; live.appendChild(cmt.gitEl); }
  cmt.gitEl.textContent += String(data).replace(/\r(?!\n)/g, '\n');
  if (cmt.thinkEl) live.appendChild(cmt.thinkEl);
  live.scrollTop = live.scrollHeight;
}
window.deck.onGitStream(p => { if (p.streamId && p.streamId === cmt.streamId) cmtAppendGit(p.data); });

function cmtOnEvent(ev) {
  if (ev.kind === 'init') { cmt.streamEl = null; cmtLive(`▸ session ${String(ev.sessionId).slice(0, 8)} · ${ev.model}`, 'sys'); }
  else if (ev.kind === 'tool') {
    cmt.streamEl = null;
    let d = ''; try { const i = JSON.parse(ev.input); d = i.file_path || i.path || i.command || i.pattern || ''; } catch {}
    cmtLive(`⚙ ${ev.tool} ${String(d).slice(0, 90)}`, 'tool');
  } else if (ev.kind === 'text-delta') {
    if (!cmt.streamEl) cmt.streamEl = cmtLive('', 'txt');
    cmt.streamEl.textContent += ev.text;
    cmtEl('cmt-live').scrollTop = cmtEl('cmt-live').scrollHeight;
  } else if (ev.kind === 'text-end') { cmt.streamEl = null; }
  else if (ev.kind === 'result') { cmtLive(`◆ ${String(ev.subtype).toUpperCase()} · ${ev.numTurns} turns`, 'ok'); }
  else if (ev.kind === 'error') { cmtLive('⚠ ' + ev.error, 'err'); }
}

// ===== STEP 1: COMMIT (streams hook/test output live) =====
cmtEl('cmt-commit').onclick = async () => {
  if (cmt.running) return;
  const msg = cmtEl('cmt-msg').value.trim();
  if (!msg && cmt.kind !== 'amend') { cmtEl('cmt-summary').textContent = '⚠ commit message required'; cmtEl('cmt-msg').focus(); return; }
  cmt.running = true;
  cmtEl('cmt-error-wrap').classList.add('hidden');
  cmtEl('cmt-live').innerHTML = '';
  cmtShowLive('COMMIT PROCESS (hooks / tests run here)');
  cmtStepMark('commit', 'active');
  cmtSetState('committing');
  if (cmt.willStageAll) await cmtGitStream('stage', '*');
  const r = await cmtGitStream(cmt.kind === 'amend' ? 'amend' : 'commit', msg);
  cmt.running = false;
  if (!r.ok) {
    cmt.lastError = r.out || 'commit failed';
    cmtEl('cmt-error').textContent = cmt.lastError;
    cmtEl('cmt-error-wrap').classList.remove('hidden');
    cmtStepMark('commit', 'fail');
    cmtSetState('error');
    return;
  }
  cmtEl('git-msg').value = '';
  cmtLive('✔ committed', 'ok');
  cmtStepMark('commit', 'done');
  gitRefresh();
  if (cmt.autoPush) { cmtEl('cmt-push').click(); return; }   // Commit & Push / Sync
  cmtSetState('committed');   // shows the PUSH button
};

// ===== STEP 2: PUSH (streamed) =====
cmtEl('cmt-push').onclick = async () => {
  if (cmt.running) return;
  cmt.running = true;
  cmtEl('cmt-push-menu').classList.add('hidden');
  cmtEl('cmt-error-wrap').classList.add('hidden');   // stale commit-step errors
  cmtEl('cmt-live').innerHTML = '';
  cmtShowLive('PUSH PROCESS');
  cmtStepMark('push', 'active');
  cmtSetState('pushing');
  if (cmt.kind === 'sync') await cmtGitStream('pull');
  const flags = [...cmtPushFlags];
  let r = await cmtGitStream('push', flags.length ? flags : undefined);
  if (!r.ok && /no upstream branch|set-upstream/i.test(r.out)) {
    r = await cmtGitStream('publish', { branch: cmt.branch || 'HEAD', flags });
  }
  cmt.running = false;
  if (!r.ok) {
    // the live panel already streamed the full output — no duplicate error pane
    cmt.lastError = r.out || 'push failed';
    cmtStepMark('push', 'fail');
    cmtLive('✗ push failed — fix and press Push again', 'err');
    cmtSetState('committed');   // let them retry Push
    return;
  }
  cmtLive('✔ pushed', 'ok');
  cmtStepMark('push', 'done');
  gitRefresh();
  await cmtPreparePR();
};

// ===== STEP 3: CREATE PR (pick base branch, AI-written description) =====
async function cmtPreparePR() {
  cmtEl('cmt-msg-block').classList.add('hidden');
  const msg = cmtEl('cmt-msg').value || '';
  cmtEl('cmt-pr-title').value = msg.split('\n')[0] || cmt.branch;
  cmtEl('cmt-pr-head').textContent = cmt.branch;
  const sel = cmtEl('cmt-pr-base-sel');
  sel.innerHTML = '<option>loading…</option>';
  cmtEl('cmt-pr-row').classList.remove('hidden');
  cmtStepMark('pr', 'active');
  cmtSetState('pushed');
  const b = await window.deck.gitBranches(gitRepo);
  const bases = [];
  const seen = new Set();
  for (const rb of (b.ok ? b.remote : [])) {
    const short = rb.replace(/^[^/]+\//, '');
    if (!/\/HEAD$|->/.test(rb) && short !== cmt.branch && !seen.has(short)) { seen.add(short); bases.push(short); }
  }
  for (const l of (b.ok ? b.local : [])) if (l.name !== cmt.branch && !seen.has(l.name)) { seen.add(l.name); bases.push(l.name); }
  sel.innerHTML = '';
  for (const name of bases) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  // default base: main → master → qa → first
  const def = bases.find(x => x === 'main') || bases.find(x => x === 'master') || bases.find(x => x === 'qa') || bases[0];
  if (def) sel.value = def;
  // auto-write the PR description from the branch's changes (editable)
  cmtGenPRDesc();
}

// ✨ AI-write the PR description (Haiku). Bug → "Issue:/Fix:", feature → explain.
async function cmtGenPRDesc() {
  const status = cmtEl('cmt-desc-status');
  const box = cmtEl('cmt-pr-desc');
  // lock the PR inputs + show a spinner overlay while the AI writes
  const locked = ['cmt-pr-desc', 'cmt-pr-title', 'cmt-pr-base-sel', 'cmt-gen-desc', 'cmt-pr'];
  const setLocked = on => locked.forEach(id => { const e = cmtEl(id); if (e) e.disabled = on; });
  setLocked(true);
  cmtEl('cmt-desc-overlay').classList.remove('hidden');
  box.classList.add('generating');
  status.textContent = '';
  const done = () => { setLocked(false); cmtEl('cmt-desc-overlay').classList.add('hidden'); box.classList.remove('generating'); };
  const base = cmtEl('cmt-pr-base-sel').value || 'main';
  // diff of this branch vs the base gives the reviewer-facing change set
  let d = await window.deck.gitDiff(gitRepo, { commit: `${base}...HEAD` });
  let diff = (d.ok && d.diff) ? d.diff : '';
  if (!diff.trim()) diff = await cmtChangeDiff();
  const prompt = `Write a pull-request description for these changes.

Decide the type from the diff and branch name "${cmt.branch}":
- If it is a BUG FIX, use EXACTLY this format:
Issue: <what was broken, 1-2 lines>
Fix: <what you changed to fix it, 1-2 lines>
- If it is a FEATURE, do NOT use that format — just explain the feature clearly in 2-4 lines (what it does, how to use it).

Keep it concise. Output ONLY the description, no title, no preamble, no markdown headers.

=== DIFF (${cmt.branch} vs ${base}) ===
${diff.slice(0, 30000)}`;
  const r = await window.deck.aiGenerate(prompt, 'claude-haiku-4-5-20251001', gitRepo);
  done();
  if (r.ok && r.text) { box.value = r.text.trim(); status.textContent = '✓ AI draft — edit freely'; }
  else { status.textContent = '✗ ' + (r.error || 'generation failed'); }
}
document.getElementById('cmt-gen-desc').onclick = cmtGenPRDesc;

cmtEl('cmt-pr').onclick = async () => {
  if (cmt.running) return;
  const title = cmtEl('cmt-pr-title').value.trim() || cmt.branch;
  const bodyDesc = cmtEl('cmt-pr-desc').value.trim();
  const base = cmtEl('cmt-pr-base-sel').value;
  if (!base) { cmtLive('✗ pick a base branch', 'err'); return; }
  cmt.running = true;
  cmtShowLive('CREATE PR PROCESS');
  cmtSetState('creating');
  // gh pr create isn't streamed — show a thinking indicator while it runs
  cmt.thinkEl = document.createElement('div'); cmt.thinkEl.className = 'ai-line ai-thinking'; cmt.thinkEl.textContent = '⏳ creating PR';
  cmtEl('cmt-live').appendChild(cmt.thinkEl);
  cmtLive(`$ gh pr create --base ${base} --head ${cmt.branch}`, 'sys');
  const r = await window.deck.prCreate(gitRepo, { title, body: bodyDesc, base });
  if (cmt.thinkEl) { cmt.thinkEl.remove(); cmt.thinkEl = null; }
  cmt.running = false;
  if (!r.ok) {
    cmtLive('✗ ' + (r.error || r.out || 'PR create failed'), 'err');
    cmtStepMark('pr', 'fail');
    cmtSetState('pushed');   // retry
    return;
  }
  cmt.prUrl = (r.out.match(/https?:\/\/\S+/) || [])[0] || '';
  cmtLive('✔ PR created' + (cmt.prUrl ? ' · ' + cmt.prUrl : ''), 'ok');
  cmtStepMark('pr', 'done');
  ghprRefresh();
  cmtSetState('done');
};

// 🔧 Fix with AI — reads the failure output, fixes it, streams here with thinking
cmtEl('cmt-fix').onclick = async () => {
  const agent = byRole('senior')[0] || agents.find(a => a.id === 'def-general') || agents[0];
  if (!agent) return;
  if (R(agent.id).running) { cmtLive('✗ ' + agent.name + ' is busy', 'err'); return; }
  cmt.aiAgentId = agent.id; cmt.streamEl = null;
  cmtShowLive(`🔧 FIXING WITH AI · ${agent.name}`);
  cmtLive('— analyzing the failure —', 'sys');
  cmtSetState('fixing');
  cmt.thinkEl = document.createElement('div');
  cmt.thinkEl.className = 'ai-line ai-thinking';
  cmt.thinkEl.textContent = '⏳ thinking';
  cmtEl('cmt-live').appendChild(cmt.thinkEl);
  const prompt = `A git commit was BLOCKED by a pre-commit hook (lint/tests/etc). Below is the FULL output, including any failing test details. Diagnose the cause and FIX it so the hook passes — write or repair the required tests, satisfy the linter, whatever it demands. Do NOT run "git commit" yourself; the app retries after you finish. Keep changes minimal and in scope.

=== HOOK / TEST OUTPUT ===
${cmt.lastError.slice(0, 9000)}`;
  runAgent(agent.id, prompt, false, false, {
    fresh: true,
    onEvent: cmtOnEvent,
    onDone: (result) => {
      if (cmt.thinkEl) { cmt.thinkEl.remove(); cmt.thinkEl = null; }
      cmt.aiAgentId = null;
      if (result === 'aborted') { cmtLive('■ fix aborted.', 'err'); cmtSetState('error'); return; }
      cmtLive(result === 'success' ? '✔ fix complete — press ↻ Retry commit.' : '✗ fix ended: ' + result, result === 'success' ? 'ok' : 'err');
      cmtEl('cmt-summary').textContent = 'AI applied a fix — retry the commit';
      cmtSetState('error');
      gitRefresh();
    }
  });
};

cmtEl('cmt-abort').onclick = () => { if (cmt.aiAgentId) stopAgent(cmt.aiAgentId); };
cmtEl('cmt-close').onclick = () => cmtModal.classList.add('hidden');
cmtEl('cmt-cancel').onclick = () => { if (!cmt.running && !cmt.aiAgentId) cmtModal.classList.add('hidden'); };
cmtModal.addEventListener('click', e => { if (e.target === cmtModal && !cmt.running && !cmt.aiAgentId) cmtModal.classList.add('hidden'); });

const commitMenu = document.getElementById('commit-menu');
document.getElementById('git-commit').onclick = () => openCommitModal('plain');
document.getElementById('git-commit-more').onclick = (e) => {
  e.stopPropagation();
  commitMenu.classList.toggle('hidden');
  if (!commitMenu.classList.contains('hidden')) fitDropUp(commitMenu, document.getElementById('git-commit-more'));
};
commitMenu.querySelectorAll('.cm-item').forEach(item => {
  item.onclick = async () => {
    commitMenu.classList.add('hidden');
    if (item.dataset.act) { await gitDo(item.dataset.act); refreshWorkspace(); return; }   // stash
    openCommitModal(item.dataset.kind);
  };
});
document.addEventListener('click', () => commitMenu.classList.add('hidden'));
document.getElementById('git-msg').addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') openCommitModal('plain');
});
// keep the badge fresh: poll + refresh after every agent run
setInterval(() => { if (gitRepo && !gitPanel.classList.contains('hidden')) gitRefresh(); }, 10000);
setInterval(() => { if (gitRepo) gitRefresh(); }, 30000);

