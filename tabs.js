'use strict';

// tabs.js - tabs/workspaces management extracted from renderer.js
// CommonJS on purpose (no TS/build step needed yet). When you're ready,
// you can rename to tabs.ts and compile with tsc/esbuild.

function createTabsManager(opts) {
  const {
    state,
    t,
    tFmt,
    DEFAULT_SYS_PROMPT_ID,
    MAX_RETRIES,
    getMainScrollEl,
    computeDiffNavVisible,
    updateDiffNavButtons,
    syncDiff2HtmlTheme,
    autoResizeIfExpanded,
    setModelTimeUi,
    updateSystemPromptButtonForTab,
    openTabRenameModal,
    openTabCloseModal,
    getOriginalFileName,
    setOriginalFileName,
  } = opts || {};

  if (!state) throw new Error('tabs.js: opts.state is required');

  // --- Fast vertical tabstrip: keep DOM rows, update incrementally ---
  const tabRowById = new Map();
  let _tabsListEl = null;
  function getTabsListEl() {
    if (_tabsListEl) return _tabsListEl;
    _tabsListEl = document.getElementById('tabsList');
    return _tabsListEl;
  }

  function ensureTabsListDelegation() {
    const list = getTabsListEl();
    if (!list || list.dataset.delegated === '1') return;
    list.dataset.delegated = '1';

    // Click: select tab OR close button
    list.addEventListener('click', (e) => {
      const closeBtn = e.target?.closest?.('button.tab-close');
      if (closeBtn) {
        e.preventDefault();
        e.stopPropagation();
        const row = closeBtn.closest('.tab-item');
        if (row?.dataset?.tabId) openTabCloseModal(row.dataset.tabId);
        return;
      }
      const row = e.target?.closest?.('.tab-item');
      if (row?.dataset?.tabId) selectTab(row.dataset.tabId);
    });

    // Double click: rename (ignore double-click on close button)
    list.addEventListener('dblclick', (e) => {
      if (e.target?.closest?.('.tab-close')) return;
      const row = e.target?.closest?.('.tab-item');
      if (row?.dataset?.tabId) openTabRenameModal(row.dataset.tabId);
    });

    // Keyboard on tab rows
    list.addEventListener('keydown', (e) => {
      const row = e.target?.closest?.('.tab-item');
      if (!row?.dataset?.tabId) return;
      const id = row.dataset.tabId;

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectTab(id);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        openTabCloseModal(id);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        focusAdjacentTab(id, e.key === 'ArrowUp' ? -1 : 1, { select: true });
      }
    });
  }

  function ensureTabRow(tab) {
    const list = getTabsListEl();
    if (!list || !tab) return null;
    let row = tabRowById.get(tab.id);
    if (row) return row;

    row = document.createElement('div');
    row.className = 'tab-item';
    row.dataset.tabId = tab.id;
    row.setAttribute('role', 'tab');

    const label = document.createElement('div');
    label.className = 'tab-label';
    row.appendChild(label);

    const spin = document.createElement('span');
    spin.className = 'tab-spinner hidden';
    spin.setAttribute('aria-hidden', 'true');
    row.appendChild(spin);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', t?.('tabs.closeAria', 'Close tab') || 'Close tab');
    row.appendChild(closeBtn);

    tabRowById.set(tab.id, row);
    return row;
  }

  function updateTabRowFor(tab) {
    if (!tab) return;
    const row = ensureTabRow(tab);
    if (!row) return;

    const isActive = tab.id === state.activeTabId;
    const isBusy = !!tab.inFlight;

    row.classList.toggle('active', isActive);
    row.classList.toggle('busy', isBusy);
    row.setAttribute('aria-selected', isActive ? 'true' : 'false');
    row.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    row.tabIndex = isActive ? 0 : -1;

    const label = row.querySelector('.tab-label');
    if (label && label.textContent !== (tab.label || '')) label.textContent = tab.label || '';

    const spin = row.querySelector('.tab-spinner');
    if (spin) spin.classList.toggle('hidden', !isBusy);

    // Keep aria-label in sync with current language
    const closeBtn = row.querySelector('button.tab-close');
    if (closeBtn) closeBtn.setAttribute('aria-label', t?.('tabs.closeAria', 'Close tab') || 'Close tab');

    if (isBusy) row.title = t?.('tabs.processing', 'Processing…') || 'Processing…';
    else row.removeAttribute('title');
  }

  function renderTabsFull() {
    const list = getTabsListEl();
    if (!list) return;

    const keep = new Set((state.tabs || []).map(tt => tt.id));
    for (const [id, row] of tabRowById.entries()) {
      if (!keep.has(id)) {
        try { row.remove(); } catch {}
        tabRowById.delete(id);
      }
    }

    const frag = document.createDocumentFragment();
    for (const tt of (state.tabs || [])) {
      const row = ensureTabRow(tt);
      updateTabRowFor(tt);
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
  }

  function focusAdjacentTab(fromId, dir /* -1|1 */, { select = false } = {}) {
    const tabs = state.tabs || [];
    const n = tabs.length;
    if (!n) return;
    const idx = Math.max(0, tabs.findIndex(tt => tt.id === fromId));
    const next = tabs[(idx + dir + n) % n];
    if (!next) return;
    const row = tabRowById.get(next.id);
    if (row) row.focus();
    if (select) selectTab(next.id);
  }

  // --- Diff DOM caching: avoid innerHTML stringify/parse on every switch ---
  function ensureTabDiffDom(tab) {
    if (!tab) return null;
    if (!tab.diffDom) tab.diffDom = document.createElement('div');
    return tab.diffDom;
  }

  function stashDiffDomIntoTab(tab) {
    const diffView = document.getElementById('diffView');
    if (!tab || !diffView) return;
    const holder = ensureTabDiffDom(tab);
    if (!holder) return;
    holder.replaceChildren();
    while (diffView.firstChild) holder.appendChild(diffView.firstChild);
  }

  function restoreDiffDomFromTab(tab) {
    const diffView = document.getElementById('diffView');
    if (!tab || !diffView) return;
    diffView.replaceChildren();
    if (tab.diffDom && tab.diffDom.firstChild) {
      while (tab.diffDom.firstChild) diffView.appendChild(tab.diffDom.firstChild);
      return;
    }
    if (tab.diffHtml) {
      diffView.innerHTML = tab.diffHtml;
      tab.diffHtml = '';
    }
  }

  function makeTab(label) {
    const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
      id,
      label,
      labelCustomized: false,
      selectedModel: (localStorage.getItem('selectedModel') || document.getElementById('modelSelect')?.value || 'grok-4-fast-reasoning'),
      systemPromptId: DEFAULT_SYS_PROMPT_ID,
      diffText: '',
      modelText: '',
      originalFileName: 'file.txt',
      modifiedText: '',
      diffHtml: '',
      diffDom: null,
      errorText: '',
      retryCount: 0,
      scrollTop: 0,
      requestSeq: 0,
      inFlightToken: null,
      inFlight: false,
      lastDurationMs: null,
      lastTokenCount: null,
      diffTaExpanded: '0',
      diffTaCollapsedH: '',
      modelTaExpanded: '0',
      modelTaCollapsedH: '',
      outputTaExpanded: '0'
    };
  }

  function getActiveTab() {
    return (state.tabs || []).find(tt => tt.id === state.activeTabId) || null;
  }

  // --- Per-tab expand/minimize state for #diff/#model/#output ---
  // The DOM is shared across workspace tabs, so we must persist + restore the
  // expanded state per tab; otherwise expanding in one tab "leaks" to others.
  function _getTaExpanded(el) {
    if (!el) return '0';
    const v = el.dataset?.taExpanded;
    if (v === '1' || v === '0') return v;
    return el.classList.contains('ta-expanded') ? '1' : '0';
  }

  function _applyTaState(el, expanded, collapsedH) {
    if (!el) return;

    // Clear any inline sizing from a different tab (prevents cross-tab leakage).
    try { el.style.height = ''; } catch {}
    try { el.style.overflowY = ''; } catch {}

    if (expanded) {
      el.classList.add('ta-expanded');
      el.dataset.taExpanded = '1';
    } else {
      el.classList.remove('ta-expanded');
      el.dataset.taExpanded = '0';
    }

    if (el.tagName === 'TEXTAREA') {
      if (collapsedH) el.dataset.taCollapsedH = String(collapsedH);
      else try { delete el.dataset.taCollapsedH; } catch {}
    }

    const wrap = el.closest?.('.ta-container');
    if (wrap) {
      const maxBtn = wrap.querySelector('button[data-ta-action="max"]');
      const minBtn = wrap.querySelector('button[data-ta-action="min"]');
      if (maxBtn) maxBtn.disabled = !!expanded;
      if (minBtn) minBtn.disabled = !expanded;
    }
  }

  function saveActiveTabFromDom() {
    const tab = getActiveTab();
    if (!tab) return;

    tab.selectedModel = document.getElementById('modelSelect')?.value || tab.selectedModel;
    tab.diffText = document.getElementById('diff')?.value || '';
    tab.modelText = document.getElementById('model')?.value || '';
    tab.modifiedText = document.getElementById('output')?.textContent || '';
    stashDiffDomIntoTab(tab);
    tab.errorText = document.getElementById('error')?.textContent || '';

    // Persist expand/minimize per tab
    const diffEl = document.getElementById('diff');
    const modelEl = document.getElementById('model');
    const outEl = document.getElementById('output');
    tab.diffTaExpanded = _getTaExpanded(diffEl);
    tab.diffTaCollapsedH = diffEl?.dataset?.taCollapsedH || '';
    tab.modelTaExpanded = _getTaExpanded(modelEl);
    tab.modelTaCollapsedH = modelEl?.dataset?.taCollapsedH || '';
    tab.outputTaExpanded = _getTaExpanded(outEl);

    tab.originalFileName = (typeof getOriginalFileName === 'function' ? getOriginalFileName() : tab.originalFileName) || 'file.txt';
    const mainScroll = typeof getMainScrollEl === 'function' ? getMainScrollEl() : null;
    tab.scrollTop = mainScroll ? mainScroll.scrollTop : 0;
  }

  function applyTabToDom(tab) {
    const modelSelect = document.getElementById('modelSelect');
    if (modelSelect) {
      const desired = tab.selectedModel || localStorage.getItem('selectedModel') || modelSelect.value;
      const ok = Array.from(modelSelect.options).some(o => o.value === desired);
      if (ok) modelSelect.value = desired;
    }

    const diffEl = document.getElementById('diff');
    const modelEl = document.getElementById('model');
    const outEl = document.getElementById('output');
    const errEl = document.getElementById('error');

    // Restore expand/minimize per tab BEFORE any auto-resize runs
    _applyTaState(diffEl, (tab.diffTaExpanded || '0') === '1', tab.diffTaCollapsedH || '');
    _applyTaState(modelEl, (tab.modelTaExpanded || '0') === '1', tab.modelTaCollapsedH || '');
    _applyTaState(outEl, (tab.outputTaExpanded || '0') === '1', '');

    if (diffEl) diffEl.value = tab.diffText || '';
    if (modelEl) modelEl.value = tab.modelText || '';
    if (outEl) outEl.textContent = tab.modifiedText || '';
    restoreDiffDomFromTab(tab);
    if (typeof syncDiff2HtmlTheme === 'function') syncDiff2HtmlTheme();
    if (errEl) errEl.textContent = tab.errorText || '';

    if (typeof setModelTimeUi === 'function') setModelTimeUi(tab);
    if (typeof updateSystemPromptButtonForTab === 'function') updateSystemPromptButtonForTab(tab);

    if (typeof autoResizeIfExpanded === 'function') {
      autoResizeIfExpanded(diffEl);
      autoResizeIfExpanded(modelEl);
      autoResizeIfExpanded(outEl);
    }

    if (typeof setOriginalFileName === 'function') {
      setOriginalFileName(tab.originalFileName || 'file.txt');
    }

    const diffFile = document.getElementById('diffFile');
    const modelFile = document.getElementById('modelFile');
    if (diffFile) diffFile.value = '';
    if (modelFile) modelFile.value = '';

    const mainScroll = typeof getMainScrollEl === 'function' ? getMainScrollEl() : null;
    if (mainScroll) {
      const desired = Number.isFinite(tab.scrollTop) ? tab.scrollTop : 0;
      requestAnimationFrame(() => {
        const max = Math.max(0, mainScroll.scrollHeight - mainScroll.clientHeight);
        mainScroll.scrollTop = Math.min(Math.max(0, desired), max);
        if (typeof computeDiffNavVisible === 'function') computeDiffNavVisible();
        if (typeof updateDiffNavButtons === 'function') updateDiffNavButtons();
      });
    } else {
      if (typeof computeDiffNavVisible === 'function') computeDiffNavVisible();
      if (typeof updateDiffNavButtons === 'function') updateDiffNavButtons();
    }

    const downloadBtn = document.getElementById('download');
    const copyBtn = document.getElementById('copyBtn');
    const retryBtn = document.getElementById('retryBtn');
    const hasOutput = !!(tab.modifiedText && tab.modifiedText.trim());
    if (downloadBtn) downloadBtn.classList.toggle('hidden', !hasOutput);
    if (copyBtn) copyBtn.classList.toggle('hidden', !hasOutput);

    const canRetry = !!(tab.errorText && tab.retryCount > 0 && tab.retryCount < MAX_RETRIES);
    if (retryBtn) retryBtn.classList.toggle('hidden', !canRetry);

    const applyBtn = document.getElementById('applyBtn');
    const loadingEl = document.getElementById('loading');
    if (applyBtn) applyBtn.disabled = !!tab.inFlight;
    if (loadingEl) loadingEl.classList.toggle('hidden', !tab.inFlight);
  }

  function selectTab(tabId) {
    if (tabId === state.activeTabId) return;
    const prevId = state.activeTabId;
    saveActiveTabFromDom();
    state.activeTabId = tabId;
    const tab = getActiveTab();
    if (tab) applyTabToDom(tab);
    if (prevId) {
      const prevTab = (state.tabs || []).find(tt => tt.id === prevId);
      if (prevTab) updateTabRowFor(prevTab);
    }
    if (tab) updateTabRowFor(tab);
  }

  function newTab() {
    const prevId = state.activeTabId;
    saveActiveTabFromDom();

    const curModel = document.getElementById('modelSelect')?.value || localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';

    const seq = Number.isFinite(Number(state.tabSeq)) ? Number(state.tabSeq) : 1;
    state.tabSeq = seq + 1;
    const label = (typeof tFmt === 'function')
      ? tFmt('tabs.defaultTab', { n: seq }, `Tab ${seq}`)
      : `Tab ${seq}`;

    const tab = makeTab(label);
    tab.selectedModel = curModel;

    (state.tabs || []).push(tab);
    state.activeTabId = tab.id;
    applyTabToDom(tab);

    const list = getTabsListEl();
    if (list) {
      const row = ensureTabRow(tab);
      updateTabRowFor(tab);
      list.appendChild(row);
      try { row.scrollIntoView({ block: 'nearest' }); } catch {}
    }

    if (prevId) {
      const prevTab = (state.tabs || []).find(tt => tt.id === prevId);
      if (prevTab) updateTabRowFor(prevTab);
    }
  }

  function initTabs() {
    const curModel = document.getElementById('modelSelect')?.value || localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';

    const firstLabel = (typeof t === 'function') ? t('tabs.firstTab', 'Tab 1') : 'Tab 1';
    const first = makeTab(firstLabel);
    first.selectedModel = curModel;

    state.tabs = [first];
    state.tabSeq = 2;
    state.activeTabId = first.id;

    applyTabToDom(first);
    ensureTabsListDelegation();
    renderTabsFull();
  }

  function addTabAndSelect(tab) {
    const prevId = state.activeTabId;
    saveActiveTabFromDom();
    (state.tabs || []).push(tab);
    state.activeTabId = tab.id;
    applyTabToDom(tab);
    const list = getTabsListEl();
    if (list) {
      const row = ensureTabRow(tab);
      updateTabRowFor(tab);
      list.appendChild(row);
      try { row.scrollIntoView({ block: 'nearest' }); } catch {}
    }
    if (prevId) {
      const prevTab = (state.tabs || []).find(tt => tt.id === prevId);
      if (prevTab) updateTabRowFor(prevTab);
    }
  }

  function doCloseTab(tabId) {
    const tabs = state.tabs || [];
    const idx = tabs.findIndex(tt => tt.id === tabId);
    if (idx === -1) return;

    const tt = tabs[idx];
    tt.inFlightToken = null;
    tt.inFlight = false;

    const wasActive = state.activeTabId === tabId;
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      const fresh = makeTab('Tab 1');
      state.tabs = [fresh];
      state.tabSeq = 2;
      state.activeTabId = fresh.id;
      applyTabToDom(fresh);
      ensureTabsListDelegation();
      renderTabsFull();
      return;
    }

    if (wasActive) {
      const next = tabs[Math.min(idx, tabs.length - 1)] || tabs[0];
      state.activeTabId = next.id;
      applyTabToDom(next);
    }

    const row = tabRowById.get(tabId);
    if (row) {
      try { row.remove(); } catch {}
    }
    tabRowById.delete(tabId);
    tabs.forEach(updateTabRowFor);
  }

  return {
    ensureTabsListDelegation,
    ensureTabRow,
    updateTabRowFor,
    renderTabsFull,
    focusAdjacentTab,
    ensureTabDiffDom,
    makeTab,
    getActiveTab,
    saveActiveTabFromDom,
    applyTabToDom,
    selectTab,
    newTab,
    initTabs,
    addTabAndSelect,
    doCloseTab,
  };
}

module.exports = { createTabsManager };