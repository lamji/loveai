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
    PAGE_CRASHED: 'The page crashed. Hit "Try again" to reload it.',
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
    const slim = tabs.map(t =>
      ({ id: t.id, wsId: t.wsId, url: t.url, title: t.title, fav: t.fav || '' }));
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
    if (looksHost) {
      // dev servers are plain http — https://localhost:5173 would SSL-error
      const host = s.split(/[/:]/)[0];
      const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i.test(host);
      return (local ? 'http://' : 'https://') + s;
    }
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
    wv.addEventListener('page-favicon-updated', e => {
      const t = getTab(tabId);
      const fav = (e.favicons && e.favicons[0]) || '';
      if (t && t.fav !== fav) { t.fav = fav; saveTabs(); renderTabs(); }
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
    // NOTE: popups (window.open / target=_blank / OAuth) are routed by MAIN —
    // the webview `new-window` DOM event was removed in Electron 22. See the
    // web-contents-created handler in main.js + onBrowserPopup below.
    // ring buffer of the guest's console output — read by the bridge
    // (`console` op) so AI/e2e runs can see page errors without devtools
    wv._console = [];
    const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'];
    wv.addEventListener('console-message', e => {
      const level = typeof e.level === 'number'
        ? (CONSOLE_LEVELS[e.level] || String(e.level)) : String(e.level || 'info');
      wv._console.push({
        ts: Date.now(), level, message: e.message,
        source: e.sourceId ? `${e.sourceId}:${e.line}` : ''
      });
      if (wv._console.length > 500) wv._console.splice(0, wv._console.length - 500);
    });
    wv.addEventListener('render-process-gone', () => {
      const t = getTab(tabId);
      wv._error = { url: safeUrl(wv) || (t && t.url) || '', desc: 'PAGE_CRASHED' };
      if (isActive()) showError(wv);
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
    const t = getTab(curActiveId());
    if (!wv && !t) { urlInput.value = ''; return; }
    let u = '';
    if (wv) { try { u = wv.getURL() || ''; } catch { /* not attached yet */ } }
    if (!u && t) u = t.url || ''; // webview not attached → fall back to stored url
    urlInput.value = (!u || u === HOME_URL) ? '' : u; // blank start shows empty
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
    // favicon slot — spinner while loading, site icon, or a dim dot
    const ico = el('span', 'bw-tab-ico');
    if (wv && wv._loading) {
      ico.classList.add('spin');
    } else if (t.fav) {
      const img = el('img', 'bw-tab-fav');
      img.src = t.fav;
      img.onerror = () => img.remove();
      ico.appendChild(img);
    }
    chip.appendChild(ico);
    const lbl = el('span', 'bw-tab-label');
    lbl.textContent = tabLabel(t);
    chip.appendChild(lbl);
    const x = el('span', 'bw-tab-close');
    x.textContent = '✕';
    x.title = 'Close tab';
    x.onclick = e => { e.stopPropagation(); closeTab(t.id); };
    chip.appendChild(x);
    chip.onclick = () => setActiveTab(t.id);
    // middle-click closes, like Chrome
    chip.onauxclick = e => { if (e.button === 1) closeTab(t.id); };
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
    // focus the url bar only on an empty tab — a loaded page keeps its url
    // visible (syncUrlBar skips updates while the bar is focused)
    const act = getTab(curActiveId());
    if (!act || !act.url || act.url === HOME_URL) urlInput.focus();
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
    const target = normalizeUrl(urlInput.value);
    // no active tab → open one straight onto the URL (a blank newTab would
    // clear + refocus the url bar, leaving it empty while the page loads)
    if (!curActiveId()) newTab(activeWorkspaceId, target);
    else load(activeWv(), target);
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

  // popups routed from main (setWindowOpenHandler on the guest — the webview
  // `new-window` DOM event no longer exists): open as a tab in the OPENER's
  // project so background-project popups don't hijack the current screen
  window.deck.onBrowserPopup(({ url, openerId }) => {
    let wsId = activeWorkspaceId;
    wvById.forEach((wv, tid) => {
      try {
        if (wv.getWebContentsId() === openerId) {
          const t = getTab(tid);
          if (t) wsId = t.wsId;
        }
      } catch { /* not attached yet */ }
    });
    newTab(wsId, url);
  });

  // hotkeys forwarded from main — keys pressed INSIDE the guest page never
  // bubble to this document, so Esc/Ctrl+T/W/L would die once the page has focus
  window.deck.onBrowserHotkey(({ key, mod }) => {
    if (!browserOpen) return;
    if (key === 'escape') {
      if (view.classList.contains('fullview')) setFullview(false);
      else closeBrowserView();
    } else if (mod && key === 't') newTab(activeWorkspaceId, '');
    else if (mod && key === 'w' && curActiveId()) closeTab(curActiveId());
    else if (mod && key === 'l') { urlInput.focus(); urlInput.select(); }
  });

  window.browserViewOpen = () => browserOpen;
  window.closeBrowserView = closeBrowserView;
  const stripSlash = u => String(u || '').replace(/\/$/, '');
  // terminal link ctrl+click → open in-app instead of the OS browser.
  // Reuse before create: an existing tab on the same URL is focused (repeat
  // clicks on a dev-server link must not spam tabs), an empty "New Tab" is
  // navigated in place, and only then does a fresh tab open.
  window.openUrlInBrowser = (url) => {
    const isEmpty = t => t && (!t.url || t.url === HOME_URL);
    const existing = tabs.find(t =>
      t.wsId === activeWorkspaceId && stripSlash(t.url) === stripSlash(url));
    const act = getTab(curActiveId());
    // reuse ANY empty "New Tab" in this project (active one first) — a
    // non-active empty tab must not linger while a fresh tab opens beside it
    const empty = isEmpty(act) ? act
      : tabs.find(t => t.wsId === activeWorkspaceId && isEmpty(t)) || null;
    let tab = existing || empty || newTab(activeWorkspaceId, url);
    openBrowserView();
    setActiveTab(tab.id);
    if (tab === empty) {
      tab.url = url;
      saveTabs();
      load(ensureWv(tab), url);
      renderTabs();
    }
    // show the target immediately and give focus to the page, not the url
    // bar — a focused bar blocks syncUrlBar on every later did-navigate,
    // leaving it blank until a manual refresh
    urlInput.blur();
    urlInput.value = url;
    return tab;
  };
  // projects added / removed / renamed / recolored / switched → re-sync strip
  window.browserProjectsChanged = () => {
    pruneTabs();
    if (browserOpen) setActiveTab(curActiveId());
    renderTabs();
  };

  // internals for the automation bridge (renderer/src/bridge.js) — the bridge
  // drives the same tabs/webviews the user sees, it is not a parallel browser
  window.__bw = {
    tabs: () => tabs,
    getTab,
    wvById,
    ensureWv,
    newTab,
    setActiveTab,
    closeTab,
    curActiveId,
    openBrowserView,
    closeBrowserView,
    isOpen: () => browserOpen,
    normalizeUrl,
    HOME_URL,
  };
})();
