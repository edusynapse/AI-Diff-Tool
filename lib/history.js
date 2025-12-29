const zlib = require('zlib'); // history compression fallback (no new deps)

// -------------------------
// ZIP (no deps): minimal deflate ZIP writer + reader
// Export is a standard .zip that users can unzip.
// -------------------------
const HISTORY_EXPORT_MAGIC = 'AI_DIFF_TOOL_HISTORY_EXPORT';
const HISTORY_EXPORT_VERSION = 1;

let _crcTable = null;
function _crc32(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[i] = c >>> 0;
    }
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < b.length; i++) crc = (_crcTable[(crc ^ b[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ -1) >>> 0;
}

function _dosTimeDate(d) {
  const dt = (d instanceof Date) ? d : new Date(Number(d) || Date.now());
  const year = Math.max(1980, dt.getFullYear());
  const month = dt.getMonth() + 1;
  const day = dt.getDate();
  const hours = dt.getHours();
  const minutes = dt.getMinutes();
  const seconds = dt.getSeconds();
  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | ((Math.floor(seconds / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

function _zipCreate(files, now = new Date()) {
  const list = Array.isArray(files) ? files : [];
  const { dosTime, dosDate } = _dosTimeDate(now);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of list) {
    const name = String(f?.name || '').replace(/\\/g, '/');
    if (!name || name.includes('..') || name.startsWith('/')) continue;

    const data = Buffer.isBuffer(f?.data) ? f.data : Buffer.from(f?.data || '');
    const crc = _crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const method = 8; // deflate
    const flags = 0x0800; // UTF-8 filenames

    const nameBuf = Buffer.from(name, 'utf8');

    // Local file header (30 bytes)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(flags, 6);       // flags
    lfh.writeUInt16LE(method, 8);      // compression
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);          // extra len

    locals.push(lfh, nameBuf, compressed);

    // Central directory header (46 bytes)
    const cfh = Buffer.alloc(46);
    cfh.writeUInt32LE(0x02014b50, 0);
    cfh.writeUInt16LE(20, 4);          // version made by
    cfh.writeUInt16LE(20, 6);          // version needed
    cfh.writeUInt16LE(flags, 8);
    cfh.writeUInt16LE(method, 10);
    cfh.writeUInt16LE(dosTime, 12);
    cfh.writeUInt16LE(dosDate, 14);
    cfh.writeUInt32LE(crc, 16);
    cfh.writeUInt32LE(compressed.length, 20);
    cfh.writeUInt32LE(data.length, 24);
    cfh.writeUInt16LE(nameBuf.length, 28);
    cfh.writeUInt16LE(0, 30);          // extra len
    cfh.writeUInt16LE(0, 32);          // comment len
    cfh.writeUInt16LE(0, 34);          // disk start
    cfh.writeUInt16LE(0, 36);          // int attrs
    cfh.writeUInt32LE(0, 38);          // ext attrs
    cfh.writeUInt32LE(offset, 42);     // local header offset

    centrals.push(cfh, nameBuf);

    offset += lfh.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  const entries = Math.floor(centrals.length / 2);
  eocd.writeUInt16LE(entries, 8);
  eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, centralDir, eocd]);
}

function _zipExtractAll(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 22) return null;

  // Find EOCD by scanning backwards (max comment 64k)
  const sig = 0x06054b50;
  const maxBack = Math.min(b.length, 0x10000 + 22);
  let eocdOff = -1;
  for (let i = b.length - 22; i >= b.length - maxBack; i--) {
    if (i < 0) break;
    if (b.readUInt32LE(i) === sig) { eocdOff = i; break; }
  }
  if (eocdOff < 0) return null;

  const cdSize = b.readUInt32LE(eocdOff + 12);
  const cdOff = b.readUInt32LE(eocdOff + 16);
  if (!cdSize || cdOff + cdSize > b.length) return null;

  const out = new Map();
  let p = cdOff;
  const cdEnd = cdOff + cdSize;
  while (p + 46 <= cdEnd) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const cmtLen = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42);

    const nameStart = p + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > cdEnd) return null;

    const name = b.slice(nameStart, nameEnd).toString((flags & 0x0800) ? 'utf8' : 'binary');
    p = nameEnd + extraLen + cmtLen;

    // Read local header to find data start
    if (lho + 30 > b.length) return null;
    if (b.readUInt32LE(lho) !== 0x04034b50) return null;
    const lNameLen = b.readUInt16LE(lho + 26);
    const lExtraLen = b.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > b.length) return null;

    // Reject encrypted zips
    if (flags & 0x0001) return null;

    const comp = b.slice(dataStart, dataEnd);
    let data = null;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else return null;

    out.set(name, data);
  }
  return out;
}

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
  const ipcRenderer = cfg.ipcRenderer || null;
  const saveZipToDisk = cfg.saveZipToDisk || null;
  const ensureAppSettingsLoaded = cfg.ensureAppSettingsLoaded;
  const DEFAULT_SYS_PROMPT_ID = cfg.DEFAULT_SYS_PROMPT_ID;
  const getSystemPromptById = cfg.getSystemPromptById;
  const ensureSystemPromptStore = cfg.ensureSystemPromptStore;
  const doesSystemPromptExist = cfg.doesSystemPromptExist;
  const buildDiffHtml = cfg.buildDiffHtml;
  const sanitizeModel = cfg.sanitizeModel;

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

  function _pad2(n) { return String(Number(n) || 0).padStart(2, '0'); }
  function _formatExportZipName(now) {
    const d = (now instanceof Date) ? now : new Date(Number(now) || Date.now());
    const dd = _pad2(d.getDate());
    const mm = _pad2(d.getMonth() + 1);
    const yyyy = String(d.getFullYear());
    let hh = d.getHours();
    const ampm = hh >= 12 ? 'pm' : 'am';
    hh = hh % 12;
    if (hh === 0) hh = 12;
    const hhs = _pad2(hh);
    const mins = _pad2(d.getMinutes());
    return `AI-Diff-History_${dd}_${mm}_${yyyy}_${hhs}_${mins}_${ampm}.zip`;
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

  function _getExportPayloadNormalized() {
    const idx = loadHistoryIndex();
    const items = {};
    for (const it of (idx.items || [])) {
      const id = String(it?.id || '');
      if (!id) continue;
      const raw = storage.getItem(_historyItemKey(id));
      if (raw) items[id] = String(raw);
    }
    return { idx, items };
  }

  async function _doExportHistoryZip() {
    const now = new Date();
    const filename = _formatExportZipName(now);

    const { idx, items } = _getExportPayloadNormalized();
    const manifest = {
      magic: HISTORY_EXPORT_MAGIC,
      export_version: HISTORY_EXPORT_VERSION,
      created_ts: now.getTime(),
      history_version: HISTORY_VERSION
    };

    const files = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: 'history_index.json', data: Buffer.from(JSON.stringify(idx, null, 2), 'utf8') },
      { name: 'history_items.json', data: Buffer.from(JSON.stringify({ v: HISTORY_VERSION, items }, null, 2), 'utf8') }
    ];

    const zipBuf = _zipCreate(files, now);

    // Prompt user where to save via main process (preferred)
    if (typeof saveZipToDisk === 'function') {
      const res = await saveZipToDisk({ filename, buffer: zipBuf });
      if (res?.ok) return { ok: true };
      if (res?.canceled) return { ok: false, canceled: true };
      return { ok: false, reason: String(res?.reason || 'save_failed') };
    }

    // Fallback (should be rare): attempt browser download (may not prompt in Electron)
    try {
      const blob = new Blob([zipBuf], { type: 'application/zip' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { window.URL.revokeObjectURL(url); } catch {} }, 500);
      return { ok: true, fallback: true };
    } catch {
      return { ok: false, reason: 'download_failed' };
    }
  }

  async function _importHistoryZipFromBytes(bytes) {
    const entries = _zipExtractAll(bytes);
    if (!entries) return { ok: false, reason: 'zip_invalid' };

    const manifestRaw = entries.get('manifest.json');
    const indexRaw = entries.get('history_index.json');
    const itemsRaw = entries.get('history_items.json');
    if (!manifestRaw || !indexRaw || !itemsRaw) return { ok: false, reason: 'missing_files' };

    let manifest = null;
    let idx = null;
    let itemsObj = null;
    try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch {}
    try { idx = JSON.parse(indexRaw.toString('utf8')); } catch {}
    try { itemsObj = JSON.parse(itemsRaw.toString('utf8')); } catch {}

    if (!manifest || manifest.magic !== HISTORY_EXPORT_MAGIC || Number(manifest.export_version) !== HISTORY_EXPORT_VERSION) {
      return { ok: false, reason: 'not_ours' };
    }
    if (!idx || idx.v !== HISTORY_VERSION || !Array.isArray(idx.items)) return { ok: false, reason: 'bad_index' };
    if (!itemsObj || itemsObj.v !== HISTORY_VERSION || !itemsObj.items || typeof itemsObj.items !== 'object') {
      return { ok: false, reason: 'bad_items' };
    }

    const settings = await ensureAppSettingsLoaded();
    const max = Math.max(1, Number(settings.historyMax || 100));

    // Normalize + enforce max (newest-first already expected, but we normalize anyway)
    idx.items = idx.items
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
      .sort((a, b) => b.ts - a.ts)
      .slice(0, max);

    // Replace local history
    clearAllHistory();

    // Store payloads (evict oldest on quota)
    while (true) {
      try {
        for (const it of idx.items) {
          const raw = itemsObj.items[it.id];
          if (!raw) continue;
          storage.setItem(_historyItemKey(it.id), String(raw));
        }
        break;
      } catch (e) {
        if (!_isQuotaError(e)) return { ok: false, reason: 'store_failed' };
        const removed = idx.items.pop();
        if (!removed) return { ok: false, reason: 'quota' };
        try { storage.removeItem(_historyItemKey(removed.id)); } catch {}
      }
    }

    // Save index (evict oldest on quota)
    while (true) {
      try {
        saveHistoryIndex({ v: HISTORY_VERSION, items: idx.items });
        break;
      } catch (e) {
        if (!_isQuotaError(e)) return { ok: false, reason: 'index_save_failed' };
        const removed = idx.items.pop();
        if (!removed) return { ok: false, reason: 'quota' };
        try { storage.removeItem(_historyItemKey(removed.id)); } catch {}
      }
    }

    return { ok: true, count: idx.items.length };
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
    const clearBtn = _el(modal.clearBtnId || 'historyClearBtn');
    const okBtn = _el(modal.okBtnId || 'historyOkBtn');
    const importBtn = _el(modal.importBtnId || 'historyImportBtn');
    const exportBtn = _el(modal.exportBtnId || 'historyExportBtn');

    if (hintEl) {
      hintEl.textContent = tFmt(
        'history.hint',
        { max: settings.historyMax },
        `Max history size is ${settings.historyMax}. Older entries are removed automatically.`
      );
    }

    // Static button labels (safe to set each render so language changes apply)
    if (clearBtn) clearBtn.textContent = t('history.clear', 'Clear');
    if (prevBtn) prevBtn.textContent = t('history.prev', 'Prev');
    if (nextBtn) nextBtn.textContent = t('history.next', 'Next');
    if (okBtn) okBtn.textContent = t('history.close', 'Close');
    if (importBtn) importBtn.textContent = t('history.import', 'Import History');
    if (exportBtn) exportBtn.textContent = t('history.export', 'Export History');

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

    {
      const raw = payload.model || tab.selectedModel;
      const next = (typeof sanitizeModel === 'function') ? sanitizeModel(raw) : raw;
      tab.selectedModel = next || tab.selectedModel;
    }

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
    const importBtn = _el(modal.importBtnId || 'historyImportBtn');
    const exportBtn = _el(modal.exportBtnId || 'historyExportBtn');
    const importInput = _el(modal.importInputId || 'historyImportFile');

    if (closeBtn) closeBtn.addEventListener('click', closeHistoryModal);
    if (okBtn) okBtn.addEventListener('click', closeHistoryModal);
    if (prevBtn) prevBtn.addEventListener('click', () => { historyPage = Math.max(0, historyPage - 1); void renderHistoryPage(); });
    if (nextBtn) nextBtn.addEventListener('click', () => { historyPage = historyPage + 1; void renderHistoryPage(); });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        const ok = confirm(t('history.clearConfirm', 'Clear all history? This cannot be undone.'));
        if (!ok) return;
        clearAllHistory();
        historyIndexCache = loadHistoryIndex();
        historyPage = 0;
        void renderHistoryPage();
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        void _doExportHistoryZip().then((res) => {
          if (res?.ok) return;
          if (res?.canceled) return;
          alert(t('history.exportFailed', 'Export failed. Please try again.'));
        });
      });
    }

    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => {
        try { importInput.value = ''; } catch {}
        try { importInput.click(); } catch {}
      });
    }

    if (importInput && importInput.dataset.wired !== '1') {
      importInput.dataset.wired = '1';
      importInput.addEventListener('change', async () => {
        try {
          const f = importInput.files && importInput.files[0];
          if (!f) return;

          const ok = confirm(t('history.importConfirm', 'Importing will replace your current history. Continue?'));
          if (!ok) return;

          const ab = await f.arrayBuffer();
          const res = await _importHistoryZipFromBytes(Buffer.from(ab));
          if (!res?.ok) {
            const reason = String(res?.reason || '');
            if (reason === 'not_ours' || reason === 'missing_files') {
              alert(t('history.importNotOurs', 'This ZIP does not look like a history export from this app.'));
            } else {
              alert(t('history.importFailed', 'Import failed. The file may be corrupted or unsupported.'));
            }
            return;
          }

          historyIndexCache = loadHistoryIndex();
          historyPage = 0;
          await renderHistoryPage();
          alert(tFmt('history.importSuccessFmt', { count: res.count }, `Imported ${res.count} history item(s).`));
        } catch {
          alert(t('history.importFailed', 'Import failed. The file may be corrupted or unsupported.'));
        }
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