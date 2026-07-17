// ===== Per-user cloud sync (Supabase via main process) =====
// Loaded BEFORE app.js. Patches localStorage.setItem once so every existing
// save site (agents roster, theme, projectDir, learn, ai_* prefs) syncs to the
// user's row without touching the rest of the codebase. localStorage stays the
// offline cache; the cloud copy is last-write-wins.
const Sync = (() => {
  const SETTINGS_KEYS = ['theme', 'projectDir', 'learn'];
  const isSettingsKey = k => SETTINGS_KEYS.includes(k) || k.startsWith('ai_');
  let enabled = false;
  let timer = null;
  let dirty = { roster: false, settings: false };

  function snapshotSettings() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isSettingsKey(k)) out[k] = localStorage.getItem(k);
    }
    return out;
  }

  async function flush() {
    timer = null;
    if (!enabled) return;
    try {
      if (dirty.roster) {
        dirty.roster = false;
        const agents = JSON.parse(localStorage.getItem('agents') || '[]');
        const r = await window.deck.saasRosterSet(agents);
        if (!r.ok) { dirty.roster = true; console.warn('sync: roster push failed:', r.error); }
      }
      if (dirty.settings) {
        dirty.settings = false;
        const r = await window.deck.saasSettingsSet(snapshotSettings());
        if (!r.ok) { dirty.settings = true; console.warn('sync: settings push failed:', r.error); }
      }
    } catch (e) { console.warn('sync: push failed:', e); }
  }

  function schedule() {
    if (!enabled) return;               // dirty flags survive until enabled
    clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  }

  function onSet(key) {
    if (key === 'agents') { dirty.roster = true; schedule(); }
    else if (isSettingsKey(key)) { dirty.settings = true; schedule(); }
  }

  // patch — catches every write from app.js / settings.js / git.js unchanged
  const _set = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (k, v) => { _set(k, v); onSet(String(k)); };

  // skills live on disk, not in localStorage — wrap the skill IPC calls so any
  // create/save/delete re-pushes the whole skills folder to the cloud
  let skillsTimer = null;
  function pushSkillsSoon() {
    if (!enabled) return;
    clearTimeout(skillsTimer);
    skillsTimer = setTimeout(() => {
      window.deck.saasSkillsPush().then(r => {
        if (!r.ok) console.warn('sync: skills push failed:', r.error);
      }).catch(e => console.warn('sync: skills push failed:', e));
    }, 1500);
  }
  for (const fn of ['skillCreate', 'skillSave', 'skillDelete']) {
    const orig = window.deck[fn].bind(window.deck);
    window.deck[fn] = async (...args) => {
      const r = await orig(...args);
      pushSkillsSoon();
      return r;
    };
  }

  // Pull the cloud copy into localStorage. First login (empty cloud) seeds the
  // cloud from what this machine already has. Returns true when localStorage
  // changed — the caller reloads once so app.js re-reads the fresh values.
  async function hydrate() {
    let changed = false;
    try {
      const rr = await window.deck.saasRosterGet();
      if (rr.ok && Array.isArray(rr.agents) && rr.agents.length) {
        const local = localStorage.getItem('agents') || '[]';
        const remote = JSON.stringify(rr.agents);
        if (local !== remote) { _set('agents', remote); changed = true; }
      } else if (rr.ok) {
        dirty.roster = true;            // seed cloud after enable()
      }
      const rs = await window.deck.saasSettingsGet();
      if (rs.ok && rs.settings && Object.keys(rs.settings).length) {
        for (const [k, v] of Object.entries(rs.settings)) {
          if (!isSettingsKey(k)) continue;
          if (localStorage.getItem(k) !== v) { _set(k, v); changed = true; }
        }
      } else if (rs.ok) {
        dirty.settings = true;
      }
      // skills: download any the cloud has that this machine doesn't (also
      // seeds the cloud from local skills on first sync — handled in main)
      const rk = await window.deck.saasSkillsPull();
      if (rk.ok && rk.added && rk.added.length) {
        console.info('sync: skills added from cloud:', rk.added.join(', '));
      }
    } catch (e) { console.warn('sync: hydrate failed:', e); }
    return changed;
  }

  function enable() {
    enabled = true;
    if (dirty.roster || dirty.settings) schedule();
    // full skills backup on every launch — catches skills created or edited
    // OUTSIDE the app (Claude Code CLI, manual edits), so a dead machine never
    // takes skills with it: any login on a new machine restores the lot
    pushSkillsSoon();
  }

  return { hydrate, enable };
})();
