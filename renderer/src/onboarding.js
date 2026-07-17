// ===== SaaS onboarding gate — Google login → Claude CLI setup → full UI =====
// Loaded LAST (needs termTheme from settings.js and the xterm globals). The
// #onboard overlay covers the whole window until every gate passes; the app
// underneath boots normally but stays hidden and untouchable.
(() => {
  const TID = '__setup__';
  const overlay = document.getElementById('onboard');
  const panels = {
    boot: document.getElementById('ob-boot'),
    login: document.getElementById('ob-login'),
    claude: document.getElementById('ob-claude')
  };
  const msgEl = document.getElementById('ob-claude-msg');
  const loginErr = document.getElementById('ob-login-err');
  let xt = null, fit = null, ptyStarted = false, startedClaude = false;
  let pollTimer = null, finished = false;

  function showPanel(name) {
    for (const [k, el] of Object.entries(panels)) el.classList.toggle('hidden', k !== name);
  }

  async function finish() {
    if (finished) return;
    finished = true;
    clearInterval(pollTimer);
    if (ptyStarted) {
      try { window.deck.termKill(TID); } catch {}
      ptyStarted = false;
      startedClaude = false;
      if (xt) xt.clear();
    }
    document.getElementById('ob-claude-login').classList.add('hidden');
    // pull the user's cloud settings/roster; if they differ from this machine,
    // reload once so app.js re-reads localStorage (guard against reload loops)
    if (!sessionStorage.getItem('syncHydrated')) {
      sessionStorage.setItem('syncHydrated', '1');
      const changed = await Sync.hydrate();
      if (changed) { location.reload(); return; }
    }
    Sync.enable();
    overlay.classList.add('hidden');
    document.body.classList.remove('onboarding');
  }

  // ---- gate 2: Claude CLI installed + logged in ----
  function claudeMsg(t) { msgEl.textContent = t; }

  function ensureTerm() {
    if (xt) return;
    xt = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      cursorBlink: true,
      scrollback: 3000,
      theme: termTheme()
    });
    fit = new FitAddon.FitAddon();
    xt.loadAddon(fit);
    xt.open(document.getElementById('ob-term'));
    try { fit.fit(); } catch {}
    xt.onData(d => window.deck.termInput(TID, d));
    xt.onResize(({ cols, rows }) => window.deck.termResize(TID, cols, rows));
    new ResizeObserver(() => { try { fit.fit(); } catch {} })
      .observe(document.getElementById('ob-term'));
    window.deck.onTermData(p => { if (p.termId === TID) xt.write(p.data); });
  }

  async function startClaudeSetup(check) {
    showPanel('claude');
    ensureTerm();
    if (!ptyStarted) {
      ptyStarted = true;
      // powershell: npm -g installs behave best on Windows
      await window.deck.termStart(TID, '', xt.cols, xt.rows, 'powershell');
      xt.focus();
    }
    if (!check.hasGlobalCli) {
      claudeMsg('Installing the Claude CLI — watch below, answer any prompts (y/n) yourself.');
      window.deck.termInput(TID, 'npm i -g @anthropic-ai/claude-code\r');
    } else {
      offerClaudeLogin();
    }
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 3000);
  }

  // login is user-initiated: show the button and wait for a click — never
  // auto-fire (logging out would otherwise bounce straight back into login)
  const claudeLoginBtn = document.getElementById('ob-claude-login');
  function offerClaudeLogin() {
    claudeMsg('Your Claude account is disconnected. Log in to use LoveAi.');
    claudeLoginBtn.classList.remove('hidden');
  }
  claudeLoginBtn.onclick = () => {
    startedClaude = true;
    claudeLoginBtn.classList.add('hidden');
    claudeMsg('Connect your Claude account — a browser window will open; ' +
      'finish there and paste the code below if asked.');
    window.deck.termInput(TID, 'claude auth login\r');
    xt.focus();
  };

  async function poll() {
    const c = await window.deck.claudeSetupCheck();
    if (c.loggedIn) { claudeMsg('Claude connected — launching LoveAi…'); finish(); return; }
    if (c.hasGlobalCli && !startedClaude && claudeLoginBtn.classList.contains('hidden')) {
      offerClaudeLogin();   // npm install just finished — surface the button
    }
  }

  // ---- gate 1: Google login (Supabase) ----
  async function afterLogin() {
    showPanel('boot');
    const c = await window.deck.claudeSetupCheck();
    if (c.installed && c.hasGlobalCli && c.loggedIn) { finish(); return; }
    if (c.loggedIn && !c.hasGlobalCli) { finish(); return; } // SDK binary covers agent runs
    startClaudeSetup(c);
  }

  window.deck.onAuthChanged(p => {
    if (p && p.user) { loginErr.textContent = ''; afterLogin(); }
    else if (p && p.error) loginErr.textContent = '✗ ' + p.error;
  });

  document.getElementById('ob-google').onclick = async () => {
    loginErr.textContent = '';
    const r = await window.deck.saasLoginStart();
    if (!r.ok) loginErr.textContent = '✗ ' + r.error;
    else loginErr.textContent = 'Waiting for the browser… complete the Google sign-in there.';
  };

  // show a busy state on a button while an async action runs
  async function withBusy(btn, label, fn) {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="ob-btn-spin"></span> ' + label;
    try { await fn(); }
    finally { delete btn.dataset.busy; btn.disabled = false; btn.innerHTML = prev; }
  }

  // sign out of LoveAi (settings modal footer + the claude-gate screen)
  async function signOutLoveAi(btn) {
    await withBusy(btn, 'SIGNING OUT…', async () => {
      await window.deck.saasLogout();
      sessionStorage.removeItem('syncHydrated');
      location.reload();
    });
  }
  for (const id of ['set-signout', 'ob-signout']) {
    const el = document.getElementById(id);
    if (el) el.onclick = () => signOutLoveAi(el);
  }

  // Re-engage the gate mid-session — e.g. the user logs OUT of Claude while the
  // app is open. Hides the whole UI again and walks the Claude setup flow.
  async function regate() {
    finished = false;
    document.body.classList.add('onboarding');
    overlay.classList.remove('hidden');
    showPanel('boot');
    const c = await window.deck.claudeSetupCheck();
    if (c.loggedIn) { finish(); return; }
    startClaudeSetup(c);
  }

  // take over the account modal's Claude LOGOUT/LOGIN buttons: after logout the
  // entire UI is replaced by the setup terminal until Claude is signed in again
  const acLogout = document.getElementById('ac-logout');
  if (acLogout) acLogout.onclick = () => withBusy(acLogout, 'LOGGING OUT…', async () => {
    await window.deck.authLogout();
    document.getElementById('acct-modal').classList.add('hidden');
    regate();
  });
  const acLogin = document.getElementById('ac-login');
  if (acLogin) acLogin.onclick = () => {
    document.getElementById('acct-modal').classList.add('hidden');
    regate();
  };

  (async function boot() {
    document.body.classList.add('onboarding');
    showPanel('boot');
    const s = await window.deck.saasSession();
    if (s && s.configured === false) {
      // backend not configured yet — don't lock the developer out of the app
      console.warn('SaaS: Supabase not configured (config.js) — skipping login gate');
      finished = true;
      overlay.classList.add('hidden');
      document.body.classList.remove('onboarding');
      return;
    }
    if (s && s.user) afterLogin();
    else showPanel('login');
  })();
})();
