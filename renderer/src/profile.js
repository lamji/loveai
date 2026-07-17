// ============================================================
// HEADER PROFILE — the LoveAi (Google) account shown top-right.
// Claude's account lives in the status bar now; this is your app identity:
// Google avatar (or initial), name, plan, and a dropdown with sign out.
// ============================================================
(() => {
  const bar = document.getElementById('account-bar');
  const menu = document.getElementById('profile-menu');
  let user = null, plan = 'free';

  function initial(name, email) {
    const s = (name || email || '?').trim();
    return s ? s[0].toUpperCase() : '·';
  }

  // paint an avatar target: <img> if a Google picture exists, else a letter
  function paintAvatar(elId, initialId, u) {
    const el = document.getElementById(elId);
    const init = document.getElementById(initialId);
    if (!el) return;
    const existing = el.querySelector('img');
    if (u && u.avatar) {
      if (init) init.style.display = 'none';
      if (existing) { existing.src = u.avatar; return; }
      const img = document.createElement('img');
      img.src = u.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); if (init) init.style.display = ''; };
      el.appendChild(img);
    } else {
      if (existing) existing.remove();
      if (init) { init.style.display = ''; init.textContent = initial(u && u.name, u && u.email); }
    }
  }

  function render() {
    if (!user) {
      document.getElementById('acct-name').textContent = 'Not signed in';
      document.getElementById('acct-plan').textContent = 'LoveAi';
      paintAvatar('acct-avatar', 'acct-initial', null);
      return;
    }
    const short = user.name || (user.email ? user.email.split('@')[0] : 'Account');
    document.getElementById('acct-name').textContent = short;
    document.getElementById('acct-plan').textContent = (plan || 'free').toUpperCase() + ' PLAN';
    paintAvatar('acct-avatar', 'acct-initial', user);
    // dropdown
    document.getElementById('pm-name').textContent = user.name || short;
    document.getElementById('pm-email').textContent = user.email || '';
    document.getElementById('pm-plan').textContent = plan || 'free';
    paintAvatar('pm-avatar', 'pm-initial', user);
  }

  async function load() {
    try {
      const s = await window.deck.saasSession();
      user = (s && s.user) || null;
      render();
      if (user) {
        const p = await window.deck.saasProfile();
        if (p && p.ok && p.profile) {
          plan = p.profile.plan || 'free';
          // prefer the stored avatar/name if the session lacked them
          user.avatar = user.avatar || p.profile.avatar_url;
          user.name = user.name || p.profile.display_name;
          render();
        }
      }
    } catch (e) { console.warn('profile load failed', e); }
  }

  // header bar toggles the dropdown (Claude account & usage is on the status bar).
  // suppress the bar's native tooltip while open so it can't overlap the menu.
  const barTip = bar.getAttribute('title');
  // center the menu under the account bar, clamped inside the viewport
  function positionMenu() {
    const r = bar.getBoundingClientRect();
    const wasHidden = menu.classList.contains('hidden');
    if (wasHidden) { menu.style.visibility = 'hidden'; menu.classList.remove('hidden'); }
    const w = menu.offsetWidth || 260;
    if (wasHidden) { menu.classList.add('hidden'); menu.style.visibility = ''; }
    let left = r.left + r.width / 2 - w / 2;             // center under the bar
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    menu.style.left = left + 'px';
    menu.style.right = 'auto';
    menu.style.top = (r.bottom + 6) + 'px';
  }
  function setOpen(open) {
    if (open) { positionMenu(); loadUsage(); }
    menu.classList.toggle('hidden', !open);
    if (open) bar.removeAttribute('title');
    else if (barTip) bar.setAttribute('title', barTip);
  }
  function loadUsage() {
    if (window.renderPlanDonuts) window.renderPlanDonuts('pm-usage', 'pm-usage-upd');
  }
  bar.onclick = (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains('hidden'));
  };
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== bar) setOpen(false);
  });

  document.getElementById('pm-upgrade').onclick = () => {
    setOpen(false);
    // billing isn't wired yet — point users at the plans page for now
    window.deck.openExternal('https://www.anthropic.com/pricing');
  };
  document.getElementById('pm-signout').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '⏻ Signing out…';
    await window.deck.saasLogout();
    sessionStorage.removeItem('syncHydrated');
    location.reload();
  };

  // hide any other lingering title tooltips in the header while the menu is open
  bar.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));

  // refresh when auth changes (login/logout mid-session)
  window.deck.onAuthChanged(() => load());
  window.refreshProfile = load;
  load();
})();
