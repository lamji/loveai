// ============================================================
// BROWSER BRIDGE (renderer side) — executes automation commands relayed from
// main (bridge-cmd → bridge-reply) against the sandbox browser's LIVE
// <webview> guests. This is the in-app Playwright: no browser spawn, no
// CDP handshake — commands land on pages the user is already looking at.
// Consumers: the `browser` MCP server (in-app agents) and the localhost
// HTTP endpoint + browserctl.js CLI (terminal Claude Code / e2e scripts).
// Classic script, loaded AFTER browser.js (needs window.__bw).
// ============================================================
(() => {
  const bw = window.__bw;
  const deck = window.deck;
  if (!bw || !deck || !deck.onBridgeCmd) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const safeUrl = wv => { try { return wv.getURL() || ''; } catch { return ''; } };

  function wsName(wsId) {
    try {
      const w = workspaces.find(x => x.id === wsId);
      return w ? (w.name || '') : '';
    } catch { return ''; }
  }

  function tabInfo(t) {
    const wv = bw.wvById.get(t.id);
    return {
      tabId: t.id,
      wsId: t.wsId,
      project: wsName(t.wsId),
      url: t.url || '',
      title: t.title || '',
      active: bw.curActiveId() === t.id,
      loading: !!(wv && wv._loading),
      live: !!wv,
    };
  }

  function resolveTab(cmd) {
    if (cmd.tabId) {
      const t = bw.getTab(cmd.tabId);
      if (!t) throw new Error('no tab with id ' + cmd.tabId + ' — run the tabs op');
      return t;
    }
    const cur = bw.getTab(bw.curActiveId());
    if (cur) return cur;
    const first = bw.tabs().find(t => t.wsId === activeWorkspaceId);
    if (first) return first;
    throw new Error('no open tabs in the active project — use the open op first');
  }

  // A <webview> only ATTACHES its guest while sitting in laid-out DOM — a
  // browser screen that was never shown defers attachment forever. Opening
  // the screen + activating the tab forces attachment (and paint, which
  // screenshots need). Once attached, guests keep working while hidden.
  async function liveWv(tab, opts) {
    opts = opts || {};
    const wv = bw.ensureWv(tab);
    const attached = () => { try { return wv.getWebContentsId() > 0; } catch { return false; } };
    if (!attached() || opts.activate) {
      if (tab.wsId === activeWorkspaceId) {
        bw.openBrowserView();
        bw.setActiveTab(tab.id);
      } else if (!attached()) {
        throw new Error('tab belongs to another project and is not loaded — ' +
          'switch to that project first');
      }
    }
    const t0 = Date.now();
    while (!attached() || !wv._ready) {
      // a failed load (dead dev server etc.) may never reach dom-ready —
      // surface the real error instead of a blind attach timeout
      if (wv._error) {
        throw new Error(wv._error.desc + ' loading ' + wv._error.url);
      }
      if (Date.now() - t0 > 10000) throw new Error('webview did not attach within 10s');
      await sleep(50);
    }
    return wv;
  }

  // settle = give a triggered navigation a beat to start, then wait for
  // did-stop-loading (bounded — SPAs may never "stop" cleanly)
  async function waitLoadSettled(wv, timeoutMs) {
    await sleep(250);
    const t0 = Date.now();
    while (wv._loading && Date.now() - t0 < (timeoutMs || 8000)) await sleep(100);
  }

  // ---- guest-side helper library (idempotent, re-injected after nav) -----
  // Plain ES5-ish, no backticks/interpolation — it ships as a string.
  const GUEST_LIB = `(() => {
    if (window.__lv) return;
    const REFS = [];
    function vis(el) {
      if (!el || el.nodeType !== 1) return false;
      try { if (typeof el.checkVisibility === 'function') return el.checkVisibility(); } catch (e) {}
      const r = el.getClientRects();
      return !!(r && r.length);
    }
    function refOf(el) {
      let i = REFS.indexOf(el);
      if (i < 0) { REFS.push(el); i = REFS.length - 1; }
      return 'e' + i;
    }
    function txt(s, n) {
      s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }
    function nameOf(el) {
      const g = a => (el.getAttribute && el.getAttribute(a)) || '';
      if (g('aria-label')) return g('aria-label');
      if (el.labels && el.labels.length) return txt(el.labels[0].textContent, 60);
      if (g('placeholder')) return g('placeholder');
      if (g('alt')) return g('alt');
      if (g('title')) return g('title');
      return txt(el.textContent, 60) || el.name || el.id || '';
    }
    function roleOf(el) {
      const r = el.getAttribute && el.getAttribute('role');
      if (r) return r;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return el.getAttribute('href') ? 'link' : 'text';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        return t === 'text' ? 'textbox' : t;   // "text" collides with text lines
      }
      if (el.isContentEditable) return 'textbox';
      return 'clickable';
    }
    const INTERACTIVE = 'a[href], button, input, select, textarea, summary, ' +
      '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
      '[role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], ' +
      '[role="option"], [contenteditable="true"], [contenteditable=""], [onclick]';
    function isInteractive(el) {
      try { return el.matches(INTERACTIVE); } catch (e) { return false; }
    }
    function describeShort(el) {
      return roleOf(el) + ' "' + nameOf(el) + '"';
    }
    function describe(el) {
      const role = roleOf(el);
      let line = 'ref=' + refOf(el) + ' ' + role + ' "' + nameOf(el) + '"';
      const tag = el.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value && el.type !== 'password')
        line += ' value="' + txt(el.value, 40) + '"';
      if (tag === 'SELECT' && el.selectedOptions && el.selectedOptions.length)
        line += ' value="' + txt(el.selectedOptions[0].textContent, 40) + '"';
      if (el.checked) line += ' (checked)';
      if (el.disabled) line += ' (disabled)';
      if (role === 'link') {
        const h = el.getAttribute('href') || '';
        if (h && h !== '#') line += ' -> ' + txt(h, 80);
      }
      return line;
    }
    function snapshot(opts) {
      opts = opts || {};
      const full = opts.mode === 'full';
      const max = opts.maxChars || 20000;
      const lines = [];
      const seen = new Set();
      const root = document.body || document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let el = walker.currentNode;
      while (el) {
        if (el.nodeType === 1 && vis(el)) {
          const tag = el.tagName.toLowerCase();
          if (/^h[1-6]$/.test(tag)) {
            lines.push(tag + ' "' + txt(el.textContent, 100) + '"');
          } else if (isInteractive(el)) {
            lines.push('  ' + describe(el));
          } else if (full && /^(p|li|td|th|label|figcaption|blockquote|dt|dd)$/.test(tag)) {
            const t = txt(el.textContent, 140);
            if (t && !seen.has(t)) { seen.add(t); lines.push('  text "' + t + '"'); }
          }
        }
        el = walker.nextNode();
      }
      let body = lines.join('\\n');
      let truncated = false;
      if (body.length > max) { body = body.slice(0, max); truncated = true; }
      return { ok: true, url: location.href, title: document.title,
        refs: REFS.length, truncated: truncated, snapshot: body };
    }
    function findTarget(t) {
      t = t || {};
      if (t.ref != null && t.ref !== '') {
        const el = REFS[parseInt(String(t.ref).replace(/^e/, ''), 10)];
        if (!el || !el.isConnected)
          throw new Error('stale ref ' + t.ref + ' — retake the snapshot');
        return el;
      }
      if (t.selector) {
        const el = document.querySelector(t.selector);
        if (!el) throw new Error('nothing matches selector: ' + t.selector);
        return el;
      }
      if (t.text) {
        const want = String(t.text).trim().toLowerCase();
        const els = Array.prototype.slice.call(
          document.querySelectorAll(INTERACTIVE)).filter(vis);
        let hit = els.find(el => nameOf(el).trim().toLowerCase() === want);
        if (!hit) hit = els.find(el => nameOf(el).toLowerCase().indexOf(want) >= 0);
        if (!hit) throw new Error('no interactive element with text: ' + t.text);
        return hit;
      }
      throw new Error('target needs a ref, selector, or text');
    }
    function click(t) {
      try {
        const el = findTarget(t);
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        try { el.focus(); } catch (e) {}
        el.click();
        return { ok: true, clicked: describeShort(el) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    function fill(t, value) {
      try {
        const el = findTarget(t);
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        try { el.focus(); } catch (e) {}
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          // native setter → framework value trackers (React) see the change
          const proto = tag === 'INPUT'
            ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const d = Object.getOwnPropertyDescriptor(proto, 'value');
          if (d && d.set) d.set.call(el, value); else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (tag === 'SELECT') {
          const opts = Array.prototype.slice.call(el.options);
          const opt = opts.find(o => o.value === value) ||
            opts.find(o => txt(o.textContent, 200) === String(value).trim());
          if (!opt) return { ok: false, error: 'no option matches "' + value + '"' };
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          return { ok: false, error: 'not fillable: ' + el.tagName.toLowerCase() };
        }
        return { ok: true, filled: describeShort(el) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    function focusTarget(t) {
      try { findTarget(t).focus(); return { ok: true }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    function check(c) {
      try {
        c = c || {};
        if (c.selector) {
          const el = document.querySelector(c.selector);
          if (!el || !vis(el)) return false;
        }
        if (c.gone && document.querySelector(c.gone)) return false;
        if (c.text) {
          const t = (document.body && document.body.innerText) || '';
          if (t.toLowerCase().indexOf(String(c.text).toLowerCase()) < 0) return false;
        }
        return true;
      } catch (e) { return false; }
    }
    window.__lv = { snapshot: snapshot, click: click, fill: fill,
      focusTarget: focusTarget, check: check };
  })();`;

  async function inject(wv) {
    await wv.executeJavaScript(GUEST_LIB, false);
  }
  function guestCall(wv, fn, arg) {
    return wv.executeJavaScript('__lv.' + fn + '(' + JSON.stringify(arg || {}) + ')', false);
  }

  // eval: try as an expression first; on a parse error retry as a function
  // body (so both "document.title" and "return document.title" work)
  async function guestEval(wv, code) {
    const finish =
      'try { return { ok: true, value: JSON.parse(JSON.stringify(' +
      '__r === undefined ? null : __r)) }; } ' +
      'catch (e) { return { ok: true, value: String(__r) }; }';
    const asExpr =
      '(async () => { try { const __r = await (async () => (\n' + code + '\n))(); ' +
      finish + ' } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()';
    const asBody =
      '(async () => { try { const __r = await (async () => {\n' + code + '\n})(); ' +
      finish + ' } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } })()';
    try { return await wv.executeJavaScript(asExpr, false); }
    catch (e1) {
      try { return await wv.executeJavaScript(asBody, false); }
      catch (e2) { return { ok: false, error: String((e2 && e2.message) || e2) }; }
    }
  }

  // real key events through Chromium's input pipeline — default actions
  // (form submit on Enter, tab focus moves) actually fire, unlike synthetic
  // KeyboardEvents. Accepts "Control+a" style combos.
  function sendKey(wv, combo) {
    const parts = String(combo || '').split('+').filter(Boolean);
    const key = parts.pop() || 'Enter';
    const modifiers = parts.map(m => {
      const s = m.toLowerCase();
      return s === 'ctrl' ? 'control' : s === 'cmd' ? 'meta' : s;
    });
    wv.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    if (key.length === 1 || key === 'Enter' || key === 'Space') {
      wv.sendInputEvent({ type: 'char', keyCode: key === 'Space' ? ' ' : key, modifiers });
    }
    wv.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  }

  // ---- ops ---------------------------------------------------------------
  const ops = {
    tabs: async () => ({
      ok: true,
      browserOpen: bw.isOpen(),
      activeProject: wsName(activeWorkspaceId),
      tabs: bw.tabs().map(tabInfo),
    }),

    open: async cmd => {
      if (!cmd.url) return { ok: false, error: 'url is required' };
      const url = bw.normalizeUrl(String(cmd.url));
      let tab;
      if (cmd.reuse === false) {
        tab = bw.newTab(activeWorkspaceId, url);
        bw.openBrowserView();
        bw.setActiveTab(tab.id);
      } else {
        tab = window.openUrlInBrowser(url);
      }
      const wv = await liveWv(tab);
      await waitLoadSettled(wv, 8000);
      if (wv._error) {
        return { ok: false, error: wv._error.desc + ' loading ' + wv._error.url,
          tab: tabInfo(bw.getTab(tab.id) || tab) };
      }
      const fresh = bw.getTab(tab.id) || tab;
      return { ok: true, tab: tabInfo(fresh), url: safeUrl(wv) };
    },

    navigate: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      try {
        if (cmd.action === 'back') { if (wv.canGoBack()) wv.goBack(); }
        else if (cmd.action === 'forward') { if (wv.canGoForward()) wv.goForward(); }
        else if (cmd.action === 'reload') wv.reload();
        else if (cmd.url) await wv.loadURL(bw.normalizeUrl(String(cmd.url))).catch(() => {});
        else return { ok: false, error: 'need url or action (back|forward|reload)' };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
      await waitLoadSettled(wv, 8000);
      if (wv._error) {
        return { ok: false, error: wv._error.desc + ' loading ' + wv._error.url };
      }
      return { ok: true, url: safeUrl(wv) };
    },

    activate: async cmd => {
      const tab = resolveTab(cmd);
      await liveWv(tab, { activate: true });
      return { ok: true, tab: tabInfo(tab) };
    },

    closeTab: async cmd => {
      const tab = resolveTab(cmd);
      bw.closeTab(tab.id);
      return { ok: true, closed: tab.id };
    },

    snapshot: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      await inject(wv);
      return await guestCall(wv, 'snapshot',
        { mode: cmd.mode || 'interactive', maxChars: cmd.maxChars || 20000 });
    },

    click: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      await inject(wv);
      const r = await guestCall(wv, 'click',
        { ref: cmd.ref, selector: cmd.selector, text: cmd.text });
      await waitLoadSettled(wv, 4000);   // click may trigger a navigation
      if (r && r.ok) r.url = safeUrl(wv);
      return r;
    },

    fill: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      await inject(wv);
      const r = await wv.executeJavaScript(
        '__lv.fill(' +
        JSON.stringify({ ref: cmd.ref, selector: cmd.selector, text: cmd.text }) +
        ', ' + JSON.stringify(String(cmd.value == null ? '' : cmd.value)) + ')',
        false);
      if (r && r.ok && cmd.submit) {
        sendKey(wv, 'Enter');
        await waitLoadSettled(wv, 4000);
        r.submitted = true;
        r.url = safeUrl(wv);
      }
      return r;
    },

    press: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      if (cmd.ref || cmd.selector) {
        await inject(wv);
        const f = await guestCall(wv, 'focusTarget',
          { ref: cmd.ref, selector: cmd.selector });
        if (f && !f.ok) return f;
      }
      sendKey(wv, cmd.key || 'Enter');
      await waitLoadSettled(wv, 4000);
      return { ok: true, pressed: cmd.key || 'Enter', url: safeUrl(wv) };
    },

    eval: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      return await guestEval(wv, String(cmd.code || 'null'));
    },

    console: async cmd => {
      const tab = resolveTab(cmd);
      const wv = bw.wvById.get(tab.id);
      const buf = (wv && wv._console) || [];
      const out = buf.slice(-(cmd.limit || 50));
      if (cmd.clear && wv) wv._console = [];
      return { ok: true, total: buf.length, messages: out };
    },

    screenshot: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab, { activate: true });
      await sleep(150);   // let the freshly-shown guest paint
      const img = await wv.capturePage();
      return { ok: true, dataUrl: img.toDataURL() };   // main writes the file
    },

    waitFor: async cmd => {
      const tab = resolveTab(cmd);
      const wv = await liveWv(tab);
      const timeout = Math.min(Number(cmd.timeoutMs) || 10000, 60000);
      const t0 = Date.now();
      const wantsDom = !!(cmd.selector || cmd.text || cmd.gone);
      for (;;) {
        let pass = true;
        if (cmd.load) pass = !wv._loading;
        if (pass && cmd.urlContains) pass = safeUrl(wv).includes(cmd.urlContains);
        if (pass && wantsDom) {
          await inject(wv).catch(() => {});
          pass = !!(await guestCall(wv, 'check', {
            selector: cmd.selector, text: cmd.text, gone: cmd.gone,
          }).catch(() => false));
        }
        if (pass) return { ok: true, ms: Date.now() - t0, url: safeUrl(wv) };
        if (Date.now() - t0 > timeout) {
          return { ok: false, error: 'waitFor timeout after ' + timeout + 'ms',
            url: safeUrl(wv) };
        }
        await sleep(150);
      }
    },
  };

  deck.onBridgeCmd(async ({ id, cmd }) => {
    let result;
    try {
      const fn = ops[(cmd || {}).op];
      result = fn
        ? await fn(cmd)
        : { ok: false, error: 'unknown op "' + (cmd && cmd.op) + '" — ops: ' +
            Object.keys(ops).join(', ') + ', network (served by main)' };
    } catch (e) {
      result = { ok: false, error: String((e && e.message) || e) };
    }
    deck.bridgeReply(id, result);
  });
})();
