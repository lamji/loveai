// ============================================================
// SANDBOX BROWSER — a light in-app browser SCREEN (#browser-view) for
// casual browsing and debugging a running dev server, without leaving
// the app. Classic script, shared global scope (loaded after app.js so the
// workspace globals `workspaces`/`activeWorkspaceId`/`uid` exist).
//
// TABS: multiple tabs, each backed by its own Electron <webview> (isolated
// Chromium guest, own partition) — NOT an iframe, NOT a BrowserWindow. Tabs
// are ISOLATED per project (workspace): every tab belongs to a workspace but
// the strip shows ONLY the active project's tabs (like notes/board), with
// its own active tab remembered per project. New tabs default to the active
// project; popups open as a new tab in the same project; closing a project
// prunes its tabs. Only the active tab's guest is visible; the rest stay
// alive (hidden) so dev servers keep running across tab/project switches.
// Pure renderer: no IPC / main.js involvement.
// ============================================================
(() => {
  const view = document.getElementById('browser-view');
  const headBtn = document.getElementById('btn-browser');
  const strip = document.getElementById('bw-tabs');
  const stack = document.getElementById('bw-stack');
  const bwEmpty = document.getElementById('bw-empty');
  const urlInput = document.getElementById('bw-url');
  const progress = document.getElementById('bw-progress');
  const backBtn = document.getElementById('bw-back');
  const fwdBtn = document.getElementById('bw-forward');
  const reloadBtn = document.getElementById('bw-reload');
  const homeBtn = document.getElementById('bw-home');
  const devBtn = document.getElementById('bw-devtools');
  const closeBtn = document.getElementById('bw-close');
  const newTabBtn = document.getElementById('bw-newtab');
  const fullviewBtn = document.getElementById('bw-fullview');
  const errBox = document.getElementById('bw-error');
  const errTitle = document.getElementById('bw-error-title');
  const errMsg = document.getElementById('bw-error-msg');
  const errUrl = document.getElementById('bw-error-url');
  const errRetry = document.getElementById('bw-error-retry');

  const HOME_URL = 'about:blank';
  const TABS_KEY = 'browserTabs';
  const ACTIVE_BY_WS_KEY = 'browserActiveByWs';
  const LEGACY_ACTIVE_TAB_KEY = 'browserActiveTab';

  // real desktop Chrome UA (strips the Electron/app tokens) — an Electron
  // <webview>'s default UA is rejected by Google's sign-in flow as "not secure"
  const CHROME_UA = navigator.userAgent
    .replace(/\s?(agent-deck|LoveAi)\/[^\s]+/gi, '')
    .replace(/\s?Electron\/[^\s]+/gi, '')
    .trim();

  const ERROR_MESSAGES = {
    ERR_CONNECTION_REFUSED:
      'The server refused the connection. It may be down, or nothing is running at this address.',
    ERR_NAME_NOT_RESOLVED:
      "Check the address for typos — this site's address couldn't be found.",
    ERR_INTERNET_DISCONNECTED:
      'You appear to be offline. Check your network connection.',
    ERR_CONNECTION_TIMED_OUT:
      'The connection timed out. The site may be too slow or unavailable.',
    ERR_CONNECTION_RESET: 'The connection was reset.',
    ERR_CONNECTION_CLOSED: 'The connection was reset.',
  };

  let browserOpen = false;
  let tabs = loadTabs();                // [{ id, wsId, url, title }]
  let activeByWs = loadActiveByWs();    // { [wsId]: tabId }
  const wvById = new Map();             // tab id → its <webview> element (lazy)

  // ---- persistence -----------------------------------------------------
  function loadTabs() {
    try {
      const raw = JSON.parse(localStorage.getItem(TABS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(t => t && t.id && t.wsId) : [];
    } catch { return []; }
  }
  function saveTabs() {
    const slim = tabs.map(t => ({ id: t.id, wsId: t.wsId, url: t.url, title: t.title }));
    localStorage.setItem(TABS_KEY, JSON.stringify(slim));
  }
  function loadActiveByWs() {
    let map = {};
    try {
      const raw = JSON.parse(localStorage.getItem(ACTIVE_BY_WS_KEY) || '{}');
      if (raw && typeof raw === 'object') map = raw;
    } catch { /* ignore */ }
    // best-effort migration of the old single global active tab
    const legacy = localStorage.getItem(LEGACY_ACTIVE_TAB_KEY);
    if (legacy) {
      const t = tabs.find(x => x.id === legacy);
      if (t && !map[t.wsId]) map[t.wsId] = t.id;
      localStorage.removeItem(LEGACY_ACTIVE_TAB_KEY);
    }
    return map;
  }
  function saveActiveByWs() {
    localStorage.setItem(ACTIVE_BY_WS_KEY, JSON.stringify(activeByWs));
  }

  // ---- helpers ---------------------------------------------------------
  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function getTab(id) { return tabs.find(t => t.id === id) || null; }
  function curActiveId() { return activeByWs[activeWorkspaceId] || null; }
  function activeWv() {
    const id = curActiveId();
    return id ? wvById.get(id) || null : null;
  }
  function safeUrl(wv) { try { return wv.getURL() || ''; } catch { return ''; } }

  // OAuth providers routed to a native shared-session window (main.js AUTH_HOSTS
  // is the source of truth — keep these two lists in sync).
  const AUTH_HOSTS = new Set([
    'accounts.google.com', 'accounts.youtube.com', 'oauth.googleusercontent.com',
    'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com',
  ]);
  function isAuthUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' && AUTH_HOSTS.has(url.hostname);
    } catch { return false; }
  }
  // Open the OAuth flow in a native window sharing persist:sandbox, then reload
  // the active webview so it picks up the freshly-shared login cookie.
  async function openAuthPopup(authUrl) {
    let origin = '';
    try { origin = new URL(safeUrl(activeWv())).origin; } catch {}
    try { await window.deck.openAuthWindow(authUrl, origin); } catch {}
    try { activeWv().reload(); } catch {}
  }

  function tabLabel(t) {
    if (t.title) return t.title;
    try { const h = new URL(t.url).hostname; if (h) return h; } catch { /* not a url */ }
    return 'New Tab';
  }

  function normalizeUrl(raw) {
    const s = (raw || '').trim();
    if (!s) return HOME_URL;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
    const looksHost = /^localhost(:\d+)?(\/.*)?$/i.test(s) ||
      /^[^\s/]+\.[^\s/]+(:\d+)?(\/.*)?$/.test(s);
    if (looksHost) return 'https://' + s;
    return 'https://www.google.com/search?q=' + encodeURIComponent(s);
  }

  function load(wv, url) {
    if (!wv) return;
    if (!wv._ready) { wv._pending = url; return; }
    try { wv.loadURL(url); } catch { wv.src = url; }
  }

  // ---- error overlay -----------------------------------------------------
  function showError(wv) {
    if (!wv || !wv._error) return;
    errMsg.textContent = ERROR_MESSAGES[wv._error.desc] ||
      `Something went wrong loading this page. (${wv._error.desc})`;
    errUrl.textContent = wv._error.url;
    errBox.classList.remove('hidden');
  }
  function hideError() { errBox.classList.add('hidden'); }
  function refreshErrorOverlay() {
    const wv = activeWv();
    if (wv && wv._error) showError(wv);
    else hideError();
  }

  // ---- webview lifecycle ----------------------------------------------
  function ensureWv(tab) {
    if (!tab) return null;
    let wv = wvById.get(tab.id);
    if (wv) return wv;
    wv = document.createElement('webview');
    wv.className = 'bw-view hidden';
    wv.setAttribute('partition', 'persist:sandbox');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('useragent', CHROME_UA);
    wv.setAttribute('src', tab.url || HOME_URL);
    wv._ready = false;
    wv._pending = null;
    wv._loading = false;
    wireWebview(wv, tab.id);
    stack.appendChild(wv);
    wvById.set(tab.id, wv);
    return wv;
  }
  function destroyWv(id) {
    const wv = wvById.get(id);
    if (wv) wv.remove();
    wvById.delete(id);
  }

  function wireWebview(wv, tabId) {
    const isActive = () => curActiveId() === tabId;
    const storeUrl = () => {
      const t = getTab(tabId);
      if (t) { t.url = safeUrl(wv); saveTabs(); }
    };
    wv.addEventListener('dom-ready', () => {
      wv._ready = true;
      if (wv._pending != null) { const u = wv._pending; wv._pending = null; load(wv, u); }
      if (isActive()) updateNavButtons();
    });
    wv.addEventListener('did-navigate', () => {
      wv._error = null;
      if (isActive()) hideError();
      storeUrl();
      if (isActive()) { syncUrlBar(); updateNavButtons(); }
      renderTabs();
    });
    wv.addEventListener('did-navigate-in-page', () => {
      storeUrl();
      if (isActive()) { syncUrlBar(); updateNavButtons(); }
    });
    wv.addEventListener('page-title-updated', e => {
      const t = getTab(tabId);
      if (t) { t.title = e.title || ''; saveTabs(); renderTabs(); }
    });
    wv.addEventListener('did-start-loading', () => {
      wv._loading = true;
      wv._error = null;
      if (isActive()) { progress.classList.remove('hidden'); hideError(); }
      renderTabs();
    });
    wv.addEventListener('did-stop-loading', () => {
      wv._loading = false;
      if (isActive()) progress.classList.add('hidden');
      renderTabs();
    });
    wv.addEventListener('did-fail-load', e => {
      if (e.errorCode === -3) return;      // aborted / superseded by a new nav
      if (e.isMainFrame === false) return; // sub-resource only — ignore
      wv._error = { url: e.validatedURL || safeUrl(wv), desc: e.errorDescription };
      if (isActive()) showError(wv);
    });
    // window.open OAuth popups (Google et al.) must NOT be re-hosted as an
    // embedded webview — route them to a native shared-session window instead.
    // Normal target=_blank links still open as an in-app tab.
    wv.addEventListener('new-window', e => {
      e.preventDefault();
      if (isAuthUrl(e.url)) { openAuthPopup(e.url); return; }
      const t = getTab(tabId);
      newTab(t ? t.wsId : activeWorkspaceId, e.url);
    });
  }

  // ---- toolbar state ---------------------------------------------------
  function updateNavButtons() {
    const wv = activeWv();
    try {
      backBtn.disabled = !wv || !wv.canGoBack();
      fwdBtn.disabled = !wv || !wv.canGoForward();
    } catch { backBtn.disabled = fwdBtn.disabled = true; }
  }
  function syncUrlBar() {
    if (document.activeElement === urlInput) return; // don't clobber typing
    const wv = activeWv();
    if (!wv) { urlInput.value = ''; return; }
    try {
      const u = wv.getURL();
      urlInput.value = (!u || u === HOME_URL) ? '' : u; // blank start shows empty
    } catch { /* not attached yet */ }
  }

  // ---- tab strip (active project only) ----------------------------------
  function pruneTabs() {
    const live = new Set(workspaces.map(w => w.id));
    const gone = tabs.filter(t => !live.has(t.wsId));
    if (!gone.length) return;
    gone.forEach(t => destroyWv(t.id));
    tabs = tabs.filter(t => live.has(t.wsId));
    Object.keys(activeByWs).forEach(wsId => {
      if (!live.has(wsId)) { delete activeByWs[wsId]; return; }
      const id = activeByWs[wsId];
      if (id && !tabs.some(t => t.id === id)) {
        const fallback = tabs.find(t => t.wsId === wsId);
        if (fallback) activeByWs[wsId] = fallback.id;
        else delete activeByWs[wsId];
      }
    });
    saveTabs();
    saveActiveByWs();
  }

  function renderTabs() {
    pruneTabs();
    strip.innerHTML = '';
    const ts = tabs.filter(t => t.wsId === activeWorkspaceId);
    ts.forEach(t => strip.appendChild(tabChip(t)));
    bwEmpty.classList.toggle('hidden', ts.length > 0);
  }

  function tabChip(t) {
    const wv = wvById.get(t.id);
    let cls = 'bw-tab';
    if (t.id === curActiveId()) cls += ' active';
    if (wv && wv._loading) cls += ' loading';
    const chip = el('div', cls);
    chip.title = t.url || tabLabel(t);
    const lbl = el('span', 'bw-tab-label');
    lbl.textContent = tabLabel(t);
    chip.appendChild(lbl);
    const x = el('span', 'bw-tab-close');
    x.textContent = '✕';
    x.title = 'Close tab';
    x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    chip.appendChild(x);
    chip.onclick = () => setActiveTab(t.id);
    return chip;
  }

  // ---- tab operations --------------------------------------------------
  function setActiveTab(id) {
    const resolved = (id && getTab(id)) ? id : null;
    if (resolved) activeByWs[activeWorkspaceId] = resolved;
    else delete activeByWs[activeWorkspaceId];
    saveActiveByWs();
    const wv = resolved ? ensureWv(getTab(resolved)) : null;
    wvById.forEach((w, tid) => w.classList.toggle('hidden', tid !== resolved));
    if (wv) progress.classList.toggle('hidden', !wv._loading);
    else { progress.classList.add('hidden'); urlInput.value = ''; }
    refreshErrorOverlay();
    renderTabs();
    syncUrlBar();
    updateNavButtons();
  }

  function newTab(wsId, url) {
    const t = { id: uid(), wsId: wsId || activeWorkspaceId, url: url || '', title: '' };
    tabs.push(t);
    saveTabs();
    if (t.wsId === activeWorkspaceId) {
      setActiveTab(t.id);
      if (!url) { urlInput.value = ''; urlInput.focus(); }
    } else {
      // spawned in a background project (e.g. a popup from a hidden webview) —
      // becomes that project's active tab without touching the current view
      activeByWs[t.wsId] = t.id;
      saveActiveByWs();
      renderTabs();
    }
    return t;
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const groupWs = tabs[idx].wsId;
    destroyWv(id);
    tabs.splice(idx, 1);
    saveTabs();
    if (curActiveId() === id) {
      const sib = tabs.find(t => t.wsId === groupWs) || null;
      setActiveTab(sib ? sib.id : null);
    } else {
      renderTabs();
    }
  }

  // ---- screen open / close --------------------------------------------
  function openBrowserView() {
    // only one center screen at a time — leave the others first
    if (window.tkIsOpen && window.tkIsOpen() && window.closeTicketWs) {
      window.closeTicketWs();
    }
    if (window.notesViewOpen && window.notesViewOpen() && window.closeNotesView) {
      window.closeNotesView();
    }
    browserOpen = true;
    view.classList.remove('hidden');
    document.getElementById('viewer').classList.add('hidden');
    document.getElementById('console-feed').classList.add('hidden');
    document.getElementById('agent-dock').classList.add('hidden');
    headBtn.classList.add('ico-active');
    const wsTabs = tabs.filter(t => t.wsId === activeWorkspaceId);
    if (!wsTabs.length) newTab(activeWorkspaceId, '');
    else {
      const cur = curActiveId();
      setActiveTab((cur && getTab(cur)) ? cur : wsTabs[0].id);
    }
    urlInput.focus();
  }
  function closeBrowserView() {
    if (!browserOpen) return;
    browserOpen = false;
    setFullview(false);
    view.classList.add('hidden'); // guests stay alive & hidden — dev servers keep running
    headBtn.classList.remove('ico-active');
    if (typeof syncPane === 'function') syncPane();
  }

  // ---- full view: overrides everything, left nav hidden — mirrors the
  // terminal panel's #panel-fullscreen (layout.js setFullscreen) ---------
  function setFullview(on) {
    view.classList.toggle('fullview', on);
    document.body.classList.toggle('browser-fullscreen', on);
    fullviewBtn.title = on ? 'Exit full view (Esc)' : 'Full view';
  }

  // ---- wiring ----------------------------------------------------------
  headBtn.onclick = () => (browserOpen ? closeBrowserView() : openBrowserView());
  closeBtn.onclick = closeBrowserView;
  newTabBtn.onclick = () => newTab(activeWorkspaceId, '');
  fullviewBtn.onclick = () => setFullview(!view.classList.contains('fullview'));

  urlInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const target = normalizeUrl(urlInput.value); // capture before newTab clears it
    if (!curActiveId()) newTab(activeWorkspaceId, '');
    load(activeWv(), target);
  });
  backBtn.onclick = () => {
    const w = activeWv();
    try { if (w && w.canGoBack()) w.goBack(); } catch {}
  };
  fwdBtn.onclick = () => {
    const w = activeWv();
    try { if (w && w.canGoForward()) w.goForward(); } catch {}
  };
  reloadBtn.onclick = () => { const w = activeWv(); try { if (w) w.reload(); } catch {} };
  homeBtn.onclick = () => { urlInput.value = ''; load(activeWv(), HOME_URL); };
  devBtn.onclick = () => { const w = activeWv(); try { if (w) w.openDevTools(); } catch {} };
  errRetry.onclick = () => {
    const w = activeWv();
    if (w && w._error) load(w, w._error.url);
  };

  view.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (view.classList.contains('fullview')) setFullview(false);
      else closeBrowserView();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault(); newTab(activeWorkspaceId, '');
    } else if (mod && e.key.toLowerCase() === 'w' && curActiveId()) {
      e.preventDefault(); closeTab(curActiveId());
    }
  });

  // initial paint so the strip is correct even before the first open
  renderTabs();

  window.browserViewOpen = () => browserOpen;
  window.closeBrowserView = closeBrowserView;
  // terminal link ctrl+click → open in-app instead of the OS browser
  window.openUrlInBrowser = (url) => {
    openBrowserView();
    newTab(activeWorkspaceId, url);
  };
  // projects added / removed / renamed / recolored / switched → re-sync strip
  window.browserProjectsChanged = () => {
    pruneTabs();
    if (browserOpen) setActiveTab(curActiveId());
    renderTabs();
  };
})();
