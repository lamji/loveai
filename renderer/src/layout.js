// ============================================================
// WORKBENCH LAYOUT — dockable bottom panel (terminal / problems),
// resizable via a draggable splitter, Ctrl+` toggles it. Classic script,
// shared global scope. Panel persists its height across sessions.
// ============================================================
(() => {
  const panel = document.getElementById('panel');
  const splitter = document.getElementById('panel-splitter');
  const workbench = document.getElementById('workbench');
  const HEIGHT_KEY = 'panelHeight';

  function clampHeight(h) {
    const max = workbench.clientHeight - 120;   // leave room for the editor area
    return Math.max(100, Math.min(h, Math.max(120, max)));
  }
  function restorePanelHeight() {
    if (panel.classList.contains('max')) return;
    const saved = parseInt(localStorage.getItem(HEIGHT_KEY), 10);
    panel.style.height = clampHeight(saved || 280) + 'px';
  }

  // ---- panel state (used by terminal.js: openTerminal/closeTerminalView) ----
  window.panelOpen = () => !panel.classList.contains('hidden');
  window.panelActivePage = () => {
    const t = document.querySelector('.panel-tab.active');
    return t ? t.dataset.panel : 'terminal';
  };
  window.setPanelPage = (which) => {
    document.querySelectorAll('.panel-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.panel === which));
    document.getElementById('term-view').classList.toggle('hidden', which !== 'terminal');
    document.getElementById('problems-view').classList.toggle('hidden', which !== 'problems');
    const ta = document.getElementById('panel-term-actions');
    if (ta) ta.style.display = which === 'terminal' ? '' : 'none';
    if (which === 'terminal' && window.fitActiveTerm) setTimeout(fitActiveTerm, 0);
  };
  window.panelShow = (which) => {
    panel.classList.remove('hidden', 'min');
    splitter.classList.remove('hidden');
    restorePanelHeight();
    setPanelPage(which || panelActivePage() || 'terminal');
  };
  window.panelHide = () => {
    panel.classList.add('hidden');
    splitter.classList.add('hidden');
    panel.classList.remove('max');
  };
  window.panelToggle = (which) => {
    if (panelOpen() && panelActivePage() === (which || 'terminal')) panelHide();
    else panelShow(which);
  };

  // ---- panel bar buttons ----
  document.getElementById('panel-close').onclick = () => {
    panel.classList.remove('fullscreen', 'min');
    document.body.classList.remove('panel-fullscreen');
    if (typeof closeTerminalView === 'function') closeTerminalView();
    else panelHide();
  };
  // minimize: collapse to just the bar (click again or a tab to restore)
  document.getElementById('panel-min').onclick = () => {
    panel.classList.remove('fullscreen');
    panel.classList.toggle('min');
    if (window.fitActiveTerm) setTimeout(fitActiveTerm, 0);
  };
  // full screen: the panel overrides EVERYTHING — terminal only, whole window
  const fsBtn = document.getElementById('panel-fullscreen');
  function setFullscreen(on) {
    panel.classList.toggle('fullscreen', on);
    document.body.classList.toggle('panel-fullscreen', on);   // hides sidebar/header
    fsBtn.title = on ? 'Exit full screen (Esc)' : 'Full screen (terminal only)';
    if (window.fitActiveTerm) setTimeout(fitActiveTerm, 0);
  }
  fsBtn.onclick = () => {
    panel.classList.remove('min');
    setFullscreen(!panel.classList.contains('fullscreen'));
  };
  // Esc leaves full screen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('fullscreen')) setFullscreen(false);
  });
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.onclick = () => {
      const which = tab.dataset.panel;
      setPanelPage(which);
      if (which === 'terminal' && typeof termTabs !== 'undefined' && !termTabs.length
          && typeof newTerm === 'function') newTerm('bash');
      if (which === 'problems' && window.renderProblems) renderProblems();
    };
  });

  // ---- draggable splitter (resize the panel height) ----
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    if (panel.classList.contains('max')) return;
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = workbench.getBoundingClientRect();
    const h = clampHeight(rect.bottom - e.clientY);
    panel.style.height = h + 'px';
    if (window.fitActiveTerm) fitActiveTerm();
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(HEIGHT_KEY, parseInt(panel.style.height, 10) || 280);
  });

  // ---- Ctrl+` toggles the terminal; Ctrl+Shift+` (Ctrl+~) opens a NEW one ----
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'Backquote') {
      e.preventDefault();
      if (e.shiftKey) {
        panelShow('terminal');
        if (typeof newTerm === 'function') newTerm('bash');
        if (typeof setTermIconActive === 'function') setTermIconActive(true);
      } else if (typeof termOpen === 'function' && termOpen()) {
        closeTerminalView();
      } else {
        openTerminal();
      }
    }
  });

  // ---- editor | console side-by-side split ----
  const editorArea = document.getElementById('editor-area');
  const viewerEl = document.getElementById('viewer');
  const consoleEl = document.getElementById('console-feed');
  // vertical divider inserted between the two columns while split is on
  const vdiv = document.createElement('div');
  vdiv.id = 'esplit-divider';
  vdiv.className = 'hidden';

  window.isSplit = () => editorArea.classList.contains('split');
  window.toggleSplit = () => {
    if (!editorArea.classList.contains('split')) {
      if (typeof openFiles !== 'undefined' && !openFiles.length) {
        if (window.toast) toast('Open a file first to split', false);
        return;
      }
      editorArea.classList.add('split');
      viewerEl.classList.remove('hidden');
      consoleEl.parentNode.insertBefore(vdiv, consoleEl);   // viewer | divider | console
      vdiv.classList.remove('hidden');
      viewerEl.style.flex = '1 1 55%';
      consoleEl.style.flex = '1 1 45%';
    } else {
      editorArea.classList.remove('split');
      vdiv.classList.add('hidden');
      viewerEl.style.flex = '';
      consoleEl.style.flex = '';
      if (typeof syncPane === 'function') syncPane();
    }
    const splitBtn = document.getElementById('vw-split');
    if (splitBtn) splitBtn.classList.toggle('on', editorArea.classList.contains('split'));
    if (typeof renderConsoleChips === 'function') renderConsoleChips();
  };
  const splitBtn = document.getElementById('vw-split');
  if (splitBtn) splitBtn.onclick = () => toggleSplit();

  // drag the vertical divider to rebalance the two columns
  let vdrag = false;
  vdiv.addEventListener('mousedown', (e) => {
    vdrag = true; document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!vdrag) return;
    const r = editorArea.getBoundingClientRect();
    let pct = ((e.clientX - r.left) / r.width) * 100;
    pct = Math.max(25, Math.min(75, pct));
    viewerEl.style.flex = `1 1 ${pct}%`;
    consoleEl.style.flex = `1 1 ${100 - pct}%`;
  });
  document.addEventListener('mouseup', () => {
    if (!vdrag) return;
    vdrag = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
  });

  // ---- resizable + collapsible sidebar ----
  const sidebar = document.getElementById('sidebar');
  const SIDE_WIDTH_KEY = 'sidebarWidth';
  const SIDE_COLLAPSED_KEY = 'sidebarCollapsed';
  const SIDE_MIN = 200, SIDE_MAX = 640, SIDE_DEFAULT = 320;

  // divider handle, sits between the sidebar and the main console
  const sdiv = document.createElement('div');
  sdiv.id = 'sidebar-splitter';
  sidebar.after(sdiv);

  // thin rail shown when the sidebar is fully collapsed — click to re-open
  const expandRail = document.createElement('div');
  expandRail.id = 'sidebar-expand';
  expandRail.className = 'hidden';
  expandRail.title = 'Show sidebar (Ctrl+B)';
  expandRail.textContent = '⇥';
  sdiv.after(expandRail);

  function clampSideWidth(w) {
    const max = Math.min(SIDE_MAX, window.innerWidth - 360);
    return Math.max(SIDE_MIN, Math.min(w, Math.max(SIDE_MIN, max)));
  }
  function applySideWidth(w) {
    const width = clampSideWidth(w);
    sidebar.style.width = width + 'px';
    localStorage.setItem(SIDE_WIDTH_KEY, String(width));
    if (window.fitActiveTerm) fitActiveTerm();
  }
  function setSidebarCollapsed(on) {
    sidebar.classList.toggle('collapsed', on);
    sdiv.classList.toggle('hidden', on);
    expandRail.classList.toggle('hidden', !on);
    localStorage.setItem(SIDE_COLLAPSED_KEY, on ? '1' : '0');
    if (window.fitActiveTerm) setTimeout(fitActiveTerm, 0);
  }
  window.toggleSidebar = () =>
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));

  // restore persisted width + collapsed state
  applySideWidth(parseInt(localStorage.getItem(SIDE_WIDTH_KEY), 10) || SIDE_DEFAULT);
  if (localStorage.getItem(SIDE_COLLAPSED_KEY) === '1') setSidebarCollapsed(true);

  const collapseBtn = document.getElementById('side-collapse');
  if (collapseBtn) collapseBtn.onclick = () => setSidebarCollapsed(true);
  expandRail.onclick = () => setSidebarCollapsed(false);

  // Ctrl+B toggles the sidebar, like VS Code
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b'
        && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      window.toggleSidebar();
    }
  });

  // drag the divider to resize
  let sdrag = false;
  sdiv.addEventListener('mousedown', (e) => {
    sdrag = true; sdiv.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!sdrag) return;
    applySideWidth(e.clientX - sidebar.getBoundingClientRect().left);
  });
  document.addEventListener('mouseup', () => {
    if (!sdrag) return;
    sdrag = false; sdiv.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  });

  // keep the terminal fitted when the window resizes
  window.addEventListener('resize', () => {
    if (panelOpen() && !panel.classList.contains('max')) {
      panel.style.height = clampHeight(parseInt(panel.style.height, 10) || 280) + 'px';
    }
    if (window.fitActiveTerm) fitActiveTerm();
  });
})();
