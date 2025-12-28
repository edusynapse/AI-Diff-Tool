
const zlib = require('zlib'); // history compression fallback (no new deps)

function _defaultBytesToB64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function _defaultB64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function createHistoryManager(cfg) {
  const window = cfg.window;
  const document = cfg.document;
  const storage = cfg.storage;
  const t = cfg.t;
  const tFmt = cfg.tFmt;
  const ensureAppSettingsLoaded = cfg.ensureAppSettingsLoaded;
  const DEFAULT_SYS_PROMPT_ID = cfg.DEFAULT_SYS_PROMPT_ID;
  const getSystemPromptById = cfg.getSystemPromptById;
  const ensureSystemPromptStore = cfg.ensureSystemPromptStore;
  const doesSystemPromptExist = cfg.doesSystemPromptExist;
  const buildDiffHtml = cfg.buildDiffHtml;

  const tabs = cfg.tabs || {};
  const modal = cfg.modal || {};

  const bytesToB64 = cfg.bytesToB64 || _defaultBytesToB64;
  const b64ToBytes = cfg.b64ToBytes || _defaultB64ToBytes;

  // -------------------------
  // History (compressed localStorage)
  // -------------------------
  const HISTORY_INDEX_KEY = 'history_index_v1';
  const HISTORY_ITEM_PREFIX = 'history_item_v1:';
  const HISTORY_VERSION = 1;

  function _historyItemKey(id) {
    return `${HISTORY_ITEM_PREFIX}${id}`;
  }

  function _isQuotaError(e) {
    const name = (e && e.name) ? String(e.name) : '';
    const code = (e && (e.code || e.number)) ? Number(e.code || e.number) : 0;
    return name === 'QuotaExceededError' || code === 22 || code === -2147024882;
  }

  async function gzipStringToB64(str) {
    const s = String(str || '');
    // Prefer browser gzip (async + efficient)
    if (typeof CompressionStream === 'function') {
      const input = new TextEncoder().encode(s);
      const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
      const ab = await new Response(stream).arrayBuffer();
      return bytesToB64(new Uint8Array(ab));
    }
    // Fallback: Node zlib (Electron renderer has Node integration)
    const buf = zlib.gzipSync(Buffer.from(s, 'utf8'));
    return bytesToB64(new Uint8Array(buf));
  }

  async function gunzipB64ToString(b64) {
    const u8 = b64ToBytes(String(b64 || ''));
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      const ab = await new Response(stream).arrayBuffer();
      return new TextDecoder().decode(new Uint8Array(ab));
    }
    const out = zlib.gunzipSync(Buffer.from(u8));
    return out.toString('utf8');
  }

  function loadHistoryIndex() {
    const raw = storage.getItem(HISTORY_INDEX_KEY);
    if (!raw) return { v: HISTORY_VERSION, items: [] };
    try {
      const obj = JSON.parse(raw);
      if (!obj || obj.v !== HISTORY_VERSION || !Array.isArray(obj.items)) {
        return { v: HISTORY_VERSION, items: [] };
      }
      // normalize + newest first
      const items = obj.items
        .filter(x => x && x.id && Number.isFinite(Number(x.ts)))
        .map(x => ({
          id: String(x.id),
          ts: Number(x.ts),
          model: String(x.model || ''),
          sysPromptId: String(x.sysPromptId || DEFAULT_SYS_PROMPT_ID),
          sysPromptName: String(x.sysPromptName || 'Default'),
          fileName: String(x.fileName || ''),
          provider: String(x.provider || '')
        }))
        .sort((a, b) => b.ts - a.ts);
      return { v: HISTORY_VERSION, items };
    } catch {
      return { v: HISTORY_VERSION, items: [] };
    }
  }

  function saveHistoryIndex(idx) {
    storage.setItem(HISTORY_INDEX_KEY, JSON.stringify(idx));
  }

  function clearAllHistory() {
    const idx = loadHistoryIndex();
    for (const it of (idx.items || [])) {
      try { storage.removeItem(_historyItemKey(it.id)); } catch {}
    }
    try { storage.removeItem(HISTORY_INDEX_KEY); } catch {}
  }

  function formatLocalTs(ts) {
    try { return new Date(Number(ts)).toLocaleString(); } catch { return String(ts); }
  }

  async function addHistoryEntry({
    ts,
    model,
    provider,
    sysPromptId,
    sysPromptName,
    sysPromptContent,
    diffText,
    inputText,
    outputText,
    inputFileName,
    durationMs,
    tokenCount
  }) {
    const settings = await ensureAppSettingsLoaded();
    const max = Math.max(1, Number(settings.historyMax || 100));

    const id = `h_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const when = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();

    const payload = {
      v: HISTORY_VERSION,
      id,
      ts: when,
      model: String(model || ''),
      provider: String(provider || ''),
      sysPromptId: String(sysPromptId || DEFAULT_SYS_PROMPT_ID),
      sysPromptName: String(sysPromptName || 'Default'),
      sysPromptContent: String(sysPromptContent || ''),
      diffText: String(diffText || ''),
      inputText: String(inputText || ''),
      outputText: String(outputText || ''),
      inputFileName: String(inputFileName || ''),
      durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
      tokenCount: Number.isFinite(Number(tokenCount)) ? Number(tokenCount) : null
    };

    const compressed = await gzipStringToB64(JSON.stringify(payload));

    // Prepare index in-memory first
    const idx = loadHistoryIndex();
    idx.items.unshift({
      id,
      ts: when,
      model: payload.model,
      sysPromptId: payload.sysPromptId,
      sysPromptName: payload.sysPromptName,
      fileName: payload.inputFileName,
      provider: payload.provider
    });

    // de-dupe by id (keep first)
    const seen = new Set();
    idx.items = idx.items.filter(x => {
      if (!x || !x.id) return false;
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });

    // enforce max (hard cap)
    while (idx.items.length > max) {
      const removed = idx.items.pop();
      if (removed?.id) {
        try { storage.removeItem(_historyItemKey(removed.id)); } catch {}
      }
    }

    // 1) store payload (evict oldest on quota)
    while (true) {
      try {
        storage.setItem(_historyItemKey(id), compressed);
        break;
      } catch (e) {
        if (!_isQuotaError(e)) throw e;
        const removed = idx.items.pop();
        if (!removed || removed.id === id) {
          // can't make space; abort storing this entry
          try { storage.removeItem(_historyItemKey(id)); } catch {}
          return;
        }
        try { storage.removeItem(_historyItemKey(removed.id)); } catch {}
      }
    }

    // 2) store index (evict oldest on quota)
    while (true) {
      try {
        saveHistoryIndex(idx);
        break;
      } catch (e) {
        if (!_isQuotaError(e)) throw e;
        const removed = idx.items.pop();
        if (!removed || removed.id === id) {
          // rollback newest payload
          try { storage.removeItem(_historyItemKey(id)); } catch {}
          return;
        }
        try { storage.removeItem(_historyItemKey(removed.id)); } catch {}
      }
    }
  }

  async function loadHistoryPayload(id) {
    const raw = storage.getItem(_historyItemKey(String(id || '')));
    if (!raw) return null;
    try {
      const json = await gunzipB64ToString(raw);
      const obj = JSON.parse(json);
      if (!obj || obj.v !== HISTORY_VERSION) return null;
      return obj;
    } catch {
      return null;
    }
  }

  // -------------------------
  // History modal UI
  // -------------------------
  let historyPage = 0;          // 0-based
  let historyIndexCache = null; // {v, items}
  let wired = false;

  function _el(id) {
    return id ? document.getElementById(id) : null;
  }

  function isHistoryModalOpen() {
    const overlay = _el(modal.overlayId || 'historyOverlay');
    return !!(overlay && !overlay.classList.contains('hidden'));
  }

  function _anyOverlayOpen(ids) {
    const arr = Array.isArray(ids) ? ids : [];
    for (const id of arr) {
      const el = _el(id);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }

  function openHistoryModal() {
    const overlay = _el(modal.overlayId || 'historyOverlay');
    if (!overlay) return;
    historyIndexCache = loadHistoryIndex();
    historyPage = 0;
    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');
    void renderHistoryPage();
    _el(modal.closeBtnId || 'historyCloseBtn')?.focus?.();
  }

  function closeHistoryModal() {
    const overlay = _el(modal.overlayId || 'historyOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');

    // Only remove modal-open if *no* other modal is open
    const ids = modal.otherOverlayIds || [
      'helpOverlay',
      'apiKeyOverlay',
      'keyTypeOverlay',
      'tabRenameOverlay',
      'tabCloseOverlay',
      'sysPromptOverlay',
      'aboutOverlay',
      'historyOverlay',
      'languageOverlay'
    ];

    if (!_anyOverlayOpen(ids)) {
      try { document.body.classList.remove('modal-open'); } catch {}
    }
    historyIndexCache = null;
    historyPage = 0;
  }

  async function renderHistoryPage() {
    const settings = await ensureAppSettingsLoaded();
    const hintEl = _el(modal.hintId || 'historyHint');
    const listEl = _el(modal.listId || 'historyList');
    const prevBtn = _el(modal.prevBtnId || 'historyPrevBtn');
    const nextBtn = _el(modal.nextBtnId || 'historyNextBtn');
    const pageLabel = _el(modal.pageLabelId || 'historyPageLabel');

    if (hintEl) {
      hintEl.textContent = tFmt(
        'history.hint',
        { max: settings.historyMax },
        `Max history size is ${settings.historyMax}. Older entries are removed automatically.`
      );
    }

    const idx = historyIndexCache || loadHistoryIndex();
    const items = Array.isArray(idx.items) ? idx.items : [];
    const pageSize = Math.max(1, Number(settings.historyPageSize || 5));
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    historyPage = Math.min(Math.max(0, historyPage), totalPages - 1);

    const start = historyPage * pageSize;
    const slice = items.slice(start, start + pageSize);

    if (listEl) {
      if (!slice.length) {
        const empty = document.createElement('div');
        empty.className = 'history-hint';
        empty.textContent = items.length ? t('history.emptyPage', 'No items on this page.') : t('history.emptyAll', 'No history yet.');
        listEl.replaceChildren(empty);
      } else {
        const frag = document.createDocumentFragment();
        for (const it of slice) {
          const row = document.createElement('div');
          row.className = 'history-row';
          row.dataset.historyId = it.id;

          const left = document.createElement('div');
          left.className = 'history-left';

          const date = document.createElement('div');
          date.className = 'history-date';
          date.textContent = formatLocalTs(it.ts);

          const meta = document.createElement('div');
          meta.className = 'history-meta';
          const bits = [];
          if (it.model) bits.push(it.model);
          if (it.sysPromptName) bits.push(it.sysPromptName);
          if (it.fileName) bits.push(it.fileName);
          meta.textContent = bits.join(' • ');

          left.appendChild(date);
          left.appendChild(meta);

          const actions = document.createElement('div');
          actions.className = 'history-actions';

          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'modal-ok history-open-btn';
          openBtn.textContent = t('history.openInNewTab', 'Open in new tab');
          openBtn.dataset.action = 'open-history';
          openBtn.dataset.historyId = it.id;

          actions.appendChild(openBtn);
          row.appendChild(left);
          row.appendChild(actions);
          frag.appendChild(row);
        }
        listEl.replaceChildren(frag);
      }
    }

    if (pageLabel) {
      pageLabel.textContent = tFmt(
        'history.pageLabel',
        { page: historyPage + 1, total: totalPages },
        `Page ${historyPage + 1} of ${totalPages}`
      );
    }
    if (prevBtn) prevBtn.disabled = historyPage <= 0;
    if (nextBtn) nextBtn.disabled = historyPage >= (totalPages - 1);
  }

  async function openHistoryItemInNewTab(historyId) {
    const payload = await loadHistoryPayload(historyId);
    if (!payload) {
      alert(t('history.loadFailed', 'Could not load this history item (it may have been cleared or storage is corrupted).'));
      return;
    }

    // Safety: ensure tabs module is wired (in case history opens early)
    try { tabs.initTabsManagerOnce?.(); } catch {}

    try { ensureSystemPromptStore?.(); } catch {}

    const fileName = (payload.inputFileName || 'file.txt').trim() || 'file.txt';
    const tab = tabs.makeTab(`🕘 ${fileName}`);
    tab.labelCustomized = true;

    tab.selectedModel = payload.model || tab.selectedModel;
    tab.systemPromptId = doesSystemPromptExist(payload.sysPromptId) ? payload.sysPromptId : DEFAULT_SYS_PROMPT_ID;

    tab.diffText = payload.diffText || '';
    tab.modelText = payload.inputText || '';
    tab.originalFileName = fileName;
    // keep the custom file picker filename displays correct per-tab
    tab.modelInputFileName = fileName;
    tab.diffInputFileName = tab.diffInputFileName || '';
    tab.modifiedText = payload.outputText || '';
    tab.errorText = '';
    tab.retryCount = 0;
    tab.lastDurationMs = Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null;
    tab.lastTokenCount = Number.isFinite(Number(payload.tokenCount)) ? Number(payload.tokenCount) : null;

    if (tab.modelText && tab.modifiedText) {
      const html = buildDiffHtml(tab.modelText, tab.modifiedText);
      const holder = tabs.ensureTabDiffDom(tab);
      if (holder) holder.innerHTML = html;
    }

    tabs.addTabAndSelect(tab);
  }

  function wireDomEvents() {
    if (wired) return;
    wired = true;

    const overlay = _el(modal.overlayId || 'historyOverlay');
    const closeBtn = _el(modal.closeBtnId || 'historyCloseBtn');
    const okBtn = _el(modal.okBtnId || 'historyOkBtn');
    const clearBtn = _el(modal.clearBtnId || 'historyClearBtn');
    const prevBtn = _el(modal.prevBtnId || 'historyPrevBtn');
    const nextBtn = _el(modal.nextBtnId || 'historyNextBtn');
    const list = _el(modal.listId || 'historyList');

    if (closeBtn) closeBtn.addEventListener('click', closeHistoryModal);
    if (okBtn) okBtn.addEventListener('click', closeHistoryModal);
    if (prevBtn) prevBtn.addEventListener('click', () => { historyPage = Math.max(0, historyPage - 1); void renderHistoryPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { historyPage = historyPage + 1; void renderHistoryPage(); });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const ok = confirm('Clear all history? This cannot be undone.');
        if (!ok) return;
        clearAllHistory();
        historyIndexCache = loadHistoryIndex();
        historyPage = 0;
        void renderHistoryPage();
      });
    }

    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeHistoryModal();
      });
    }

    if (list && list.dataset.delegated !== '1') {
      list.dataset.delegated = '1';
      list.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button[data-action="open-history"]');
        const id = btn?.dataset?.historyId;
        if (!id) return;
        void openHistoryItemInNewTab(id).then(() => {
          closeHistoryModal();
        });
      });
    }
  }

  return {
    addHistoryEntry,
    openHistoryModal,
    closeHistoryModal,
    isHistoryModalOpen,
    wireDomEvents,
    clearAllHistory,
    // exposed for tests/debug if needed
    _loadHistoryIndex: loadHistoryIndex,
    _loadHistoryPayload: loadHistoryPayload
  };
}

module.exports = { createHistoryManager };