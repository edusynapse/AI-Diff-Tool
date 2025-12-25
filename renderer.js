const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
const Diff2Html = require('diff2html');  // For rendering as HTML
const { ipcRenderer } = require('electron');
const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 5;  // Warn if larger; adjust based on API limits
let originalFileName = 'file.txt';  // Default for pasted content
let isApiKeyEditable = true;
// -------------------------
// Encrypted API key storage (PIN-based)
// -------------------------
const LS_ENC_KEY = 'xaiApiKeyEnc';  // JSON payload
const LS_PLAIN_KEY = 'xaiApiKey';   // legacy plaintext (migration only)

const ENC_VERSION = 1;
const PBKDF2_ITERS = 120000;
const PIN_LEN = 6;
let autoUnlockBusy = false;
const SALT_BYTES = 16;
const AES_GCM_IV_BYTES = 12;

let sessionApiKey = '';        // decrypted API key (memory only)
let apiModalMode = 'setup';    // 'setup' | 'unlock' | 'manage'
let apiModalBlocking = false;

const webCrypto = (typeof window !== 'undefined' && window.crypto) ? window.crypto : globalThis.crypto;

// Keep diff2html scheme class in sync when user toggles app theme
function syncDiff2HtmlTheme() {
  const wrap = document.querySelector('#diffView .d2h-wrapper');
  if (!wrap) return;
  const isDark = document.body.classList.contains('dark');
  wrap.classList.toggle('d2h-dark-color-scheme', isDark);
  wrap.classList.toggle('d2h-light-color-scheme', !isDark);
  wrap.classList.remove('d2h-auto-color-scheme');
}

function isValidPin(pin) {
  return /^\d{6}$/.test((pin || '').trim());
}

function getPinBoxes() {
  const wrap = document.getElementById('apiKeyPinBoxes');
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('input.pin-box'));
}

function setHiddenPin(pin) {
  const hidden = document.getElementById('apiKeyPinInput');
  if (hidden) hidden.value = (pin || '').slice(0, PIN_LEN);
}

function getPinFromBoxes() {
  const boxes = getPinBoxes();
  if (!boxes.length) {
    return (document.getElementById('apiKeyPinInput')?.value || '').trim();
  }
  return boxes.map(b => (b.value || '').replace(/\D/g, '')).join('');
}

function focusPinBox(idx) {
  const boxes = getPinBoxes();
  const el = boxes[idx];
  if (!el) return;
  el.focus();
  // select if possible
  try { el.setSelectionRange(0, el.value.length); } catch {}
}

function clearPinBoxes({ focusIndex = 0 } = {}) {
  const boxes = getPinBoxes();
  boxes.forEach(b => { b.value = ''; });
  setHiddenPin('');
  if (boxes.length) focusPinBox(Math.min(Math.max(focusIndex, 0), boxes.length - 1));
}

function setPinBoxesFromString(pin) {
  const clean = (pin || '').replace(/\D/g, '').slice(0, PIN_LEN);
  const boxes = getPinBoxes();
  for (let i = 0; i < boxes.length; i++) {
    boxes[i].value = clean[i] || '';
  }
  setHiddenPin(clean);
  const nextIdx = Math.min(clean.length, boxes.length - 1);
  focusPinBox(nextIdx);
}

function syncHiddenPinFromBoxes() {
  setHiddenPin(getPinFromBoxes());
}

function isPinComplete() {
  const pin = getPinFromBoxes();
  return /^\d{6}$/.test(pin);
}

async function maybeAutoUnlock() {
  // Only auto-submit when unlocking (no API key field) and 6 digits are present
  if (apiModalMode !== 'unlock') return;
  if (!isPinComplete()) return;
  if (autoUnlockBusy) return;

  autoUnlockBusy = true;
  try {
    await handleApiKeyPrimaryClick();
  } finally {
    autoUnlockBusy = false;
  }
}

function setupPinBoxes() {
  const boxes = getPinBoxes();
  if (!boxes.length) return;

  boxes.forEach((box, idx) => {
    // typing / input
    box.addEventListener('input', () => {
      // keep only last digit
      const digits = (box.value || '').replace(/\D/g, '');
      box.value = digits ? digits[digits.length - 1] : '';
      syncHiddenPinFromBoxes();

      if (box.value && idx < boxes.length - 1) {
        focusPinBox(idx + 1);
      }

      // Auto-unlock when full
      void maybeAutoUnlock();
    });

    // key navigation + backspace behavior
    box.addEventListener('keydown', (e) => {
      const key = e.key;

      if (key === 'Backspace') {
        e.preventDefault();
        if (box.value) {
          // clear current box first
          box.value = '';
          syncHiddenPinFromBoxes();
          return;
        }
        // if empty, clear previous and move cursor there
        if (idx > 0) {
          boxes[idx - 1].value = '';
          syncHiddenPinFromBoxes();
          focusPinBox(idx - 1);
        }
        return;
      }

      if (key === 'ArrowLeft') {
        e.preventDefault();
        if (idx > 0) focusPinBox(idx - 1);
        return;
      }

      if (key === 'ArrowRight') {
        e.preventDefault();
        if (idx < boxes.length - 1) focusPinBox(idx + 1);
        return;
      }

      // block non-digit single-character keys
      if (key.length === 1 && !/\d/.test(key)) {
        e.preventDefault();
      }
    });

    // paste support (paste 6 digits anywhere)
    box.addEventListener('paste', (e) => {
      const txt = (e.clipboardData?.getData('text') || '').trim();
      const clean = txt.replace(/\D/g, '');
      if (!clean) return;
      e.preventDefault();
      setPinBoxesFromString(clean);
      void maybeAutoUnlock();
    });
  });
}

function bytesToB64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function deriveAesKeyFromPin(pin, saltBytes, iterations) {
  const enc = new TextEncoder();
  const baseKey = await webCrypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return webCrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptApiKeyWithPin(apiKey, pin) {
  const salt = webCrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = webCrypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const key = await deriveAesKeyFromPin(pin, salt, PBKDF2_ITERS);

  const pt = new TextEncoder().encode(apiKey);
  const ctBuf = await webCrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  const ct = new Uint8Array(ctBuf);

  return {
    v: ENC_VERSION,
    alg: 'AES-GCM',
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iter: PBKDF2_ITERS,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct)
  };
}

async function decryptApiKeyWithPin(payload, pin) {
  const iv = b64ToBytes(payload.iv);
  const salt = b64ToBytes(payload.salt);
  const ct = b64ToBytes(payload.ct);
  const key = await deriveAesKeyFromPin(pin, salt, payload.iter || PBKDF2_ITERS);

  const ptBuf = await webCrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

function hasEncryptedApiKey() {
  return !!localStorage.getItem(LS_ENC_KEY);
}

function loadEncryptedPayload() {
  const raw = localStorage.getItem(LS_ENC_KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== ENC_VERSION || !obj.iv || !obj.salt || !obj.ct) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveEncryptedPayload(payload) {
  localStorage.setItem(LS_ENC_KEY, JSON.stringify(payload));
  // remove legacy plaintext if present
  localStorage.removeItem(LS_PLAIN_KEY);
}

// -------------------------
// Tabs: multiple workspaces
// -------------------------
let tabs = [];
let activeTabId = null;
let tabSeq = 1;
let renamingTabId = null;

function makeTab(label) {
  const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    label,
    labelCustomized: false,
    diffText: '',
    modelText: '',
    originalFileName: 'file.txt',
    modifiedText: '',
    diffHtml: '',
    errorText: '',
    retryCount: 0,
    // NEW
    requestSeq: 0,
    inFlightToken: null,
    inFlight: false
  };
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function saveActiveTabFromDom() {
  const tab = getActiveTab();
  if (!tab) return;

  tab.diffText = document.getElementById('diff').value || '';
  tab.modelText = document.getElementById('model').value || '';
  tab.modifiedText = document.getElementById('output').textContent || '';
  tab.diffHtml = document.getElementById('diffView').innerHTML || '';
  tab.errorText = document.getElementById('error').textContent || '';
  tab.originalFileName = originalFileName;
}

function applyTabToDom(tab) {
  document.getElementById('diff').value = tab.diffText || '';
  document.getElementById('model').value = tab.modelText || '';
  document.getElementById('output').textContent = tab.modifiedText || '';
  document.getElementById('diffView').innerHTML = tab.diffHtml || '';
  // If the diff HTML was saved under a different theme, fix its wrapper class now
  syncDiff2HtmlTheme();
  document.getElementById('error').textContent = tab.errorText || '';

  originalFileName = tab.originalFileName || 'file.txt';

  // reset file inputs (cannot be set programmatically; safest is to clear)
  const diffFile = document.getElementById('diffFile');
  const modelFile = document.getElementById('modelFile');
  if (diffFile) diffFile.value = '';
  if (modelFile) modelFile.value = '';

  // buttons visibility
  const downloadBtn = document.getElementById('download');
  const copyBtn = document.getElementById('copyBtn');
  const retryBtn = document.getElementById('retryBtn');

  const hasOutput = !!(tab.modifiedText && tab.modifiedText.trim());
  downloadBtn.classList.toggle('hidden', !hasOutput);
  copyBtn.classList.toggle('hidden', !hasOutput);

  const canRetry = !!(tab.errorText && tab.retryCount > 0 && tab.retryCount < MAX_RETRIES);
  retryBtn.classList.toggle('hidden', !canRetry);

  const applyBtn = document.getElementById('applyBtn');
  const loadingEl = document.getElementById('loading');

  if (applyBtn) applyBtn.disabled = !!tab.inFlight;
  if (loadingEl) loadingEl.classList.toggle('hidden', !tab.inFlight);
}

function renderTabs() {
  const list = document.getElementById('tabsList');
  if (!list) return;

  list.innerHTML = '';
  tabs.forEach((t, idx) => {
    const isActive = t.id === activeTabId;
    const isBusy = !!t.inFlight;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'tab-item' +
      (isActive ? ' active' : '') +
      (isBusy ? ' busy' : '');

    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    btn.dataset.tabId = t.id;

    const label = document.createElement('div');
    label.className = 'tab-label';
    label.textContent = t.label;

    // Optional tooltip
    if (isBusy) btn.title = 'Processing…';
    else btn.removeAttribute('title');

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.textContent = String(idx + 1);

    btn.appendChild(label);

    // NEW: spinner badge when this tab has a request in flight
    if (isBusy) {
      const spin = document.createElement('span');
      spin.className = 'tab-spinner';
      spin.setAttribute('aria-hidden', 'true');
      btn.appendChild(spin);
    }

    btn.appendChild(meta);

    btn.addEventListener('click', () => selectTab(t.id));
    btn.addEventListener('dblclick', () => openTabRenameModal(t.id));

    list.appendChild(btn);
  });
}

function selectTab(tabId) {
  if (tabId === activeTabId) return;
  saveActiveTabFromDom();
  activeTabId = tabId;
  const tab = getActiveTab();
  if (tab) applyTabToDom(tab);
  renderTabs();
}

function newTab() {
  saveActiveTabFromDom();
  const tab = makeTab(`Tab ${tabSeq++}`);
  tabs.push(tab);
  activeTabId = tab.id;
  applyTabToDom(tab);
  renderTabs();
}

function initTabs() {
  tabs = [makeTab('Tab 1')];
  tabSeq = 2;
  activeTabId = tabs[0].id;
  applyTabToDom(tabs[0]);
  renderTabs();
}

function openTabRenameModal(tabId) {
  const overlay = document.getElementById('tabRenameOverlay');
  const input = document.getElementById('tabRenameInput');
  const tab = tabs.find(t => t.id === tabId);
  if (!overlay || !input || !tab) return;

  renamingTabId = tabId;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');

  input.value = tab.label || '';
  input.disabled = false;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeTabRenameModal() {
  const overlay = document.getElementById('tabRenameOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');

  // Only remove modal-open if *no* other modal is open
  const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
  const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
  const renameOpen = !overlay.classList.contains('hidden');

  if (!helpOpen && !apiOpen && !renameOpen) {
    document.body.classList.remove('modal-open');
  }

  renamingTabId = null;
}

function saveTabRename() {
  const input = document.getElementById('tabRenameInput');
  if (!input || !renamingTabId) return;

  const next = (input.value || '').trim();
  if (!next) return;

  const tab = tabs.find(t => t.id === renamingTabId);
  if (!tab) return;

  tab.label = next;
  tab.labelCustomized = true;
  renderTabs();
  closeTabRenameModal();
}

function getStoredApiKey() {
  return sessionApiKey || '';
}

function openApiKeyModal({ mode = 'manage', blocking = false, hint = '', prefillKey = '' } = {}) {
  const overlay = document.getElementById('apiKeyOverlay');
  const apiInput = document.getElementById('apiKeyModalInput');
  const pinInput = document.getElementById('apiKeyPinInput'); // hidden aggregator
  const pinBoxesWrap = document.getElementById('apiKeyPinBoxes');
  const primaryBtn = document.getElementById('apiKeyPrimaryBtn');
  const cancelBtn = document.getElementById('apiKeyCancelBtn');
  const closeBtn = document.getElementById('apiKeyCloseBtn');
  const hintEl = document.getElementById('apiKeyModalHint');
  const apiLabel = document.getElementById('apiKeyModalLabel');

  if (!overlay || !primaryBtn || !pinBoxesWrap || !pinInput) return;

  apiModalMode = mode;
  apiModalBlocking = !!blocking;

  if (hintEl) hintEl.textContent = hint || '';

  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');

  // show/hide API key field depending on mode
  const showKey = mode !== 'unlock';
  if (apiLabel) apiLabel.classList.toggle('hidden', !showKey);
  if (apiInput) {
    apiInput.classList.toggle('hidden', !showKey);
    apiInput.disabled = !showKey;
    apiInput.value = showKey ? (prefillKey || '') : '';
  }

  // always show PIN field (needed for unlock + save)
  if (pinInput) pinInput.value = '';
  // clear + focus PIN boxes
  clearPinBoxes({ focusIndex: 0 });

  // button labels
  primaryBtn.textContent = (mode === 'unlock') ? 'Unlock' : 'Save';

  // non-disposable / blocking behavior
  if (closeBtn) closeBtn.classList.toggle('hidden', apiModalBlocking);
  if (cancelBtn) cancelBtn.classList.toggle('hidden', apiModalBlocking);

  // focus
  setTimeout(() => {
    if (mode === 'unlock') {
      // focus first PIN box
      focusPinBox(0);
    } else if (apiInput) {
      apiInput.focus();
      apiInput.select();
    } else {
      pinInput.focus();
      pinInput.select();
    }
  }, 0);
}

function closeApiKeyModal({ force = false } = {}) {
  if (apiModalBlocking && !force) return;

  const overlay = document.getElementById('apiKeyOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');

  // Only remove modal-open if *no* other modal is open
  const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
  const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
  const apiOpen = !overlay.classList.contains('hidden');

  if (!helpOpen && !renameOpen && !apiOpen) {
    document.body.classList.remove('modal-open');
  }

  // reset
  apiModalBlocking = false;
  apiModalMode = 'manage';
  // clear PIN UI on close
  clearPinBoxes({ focusIndex: 0 });
}

async function handleApiKeyPrimaryClick() {
  const apiInput = document.getElementById('apiKeyModalInput');
  const pinInput = document.getElementById('apiKeyPinInput'); // hidden aggregator
  const hintEl = document.getElementById('apiKeyModalHint');

  const pin = getPinFromBoxes();
  const key = (apiInput?.value || '').trim();

  if (hintEl) hintEl.textContent = '';

  if (!webCrypto?.subtle) {
    if (hintEl) hintEl.textContent = 'WebCrypto is not available in this environment.';
    return;
  }

  if (!isValidPin(pin)) {
    if (hintEl) hintEl.textContent = 'PIN must be exactly 6 digits.';
    clearPinBoxes({ focusIndex: 0 });
    return;
  }

  // UNLOCK MODE: decrypt existing encrypted key
  if (apiModalMode === 'unlock') {
    const payload = loadEncryptedPayload();
    if (!payload) {
      if (hintEl) hintEl.textContent = 'No encrypted API key found (or data is corrupted).';
      return;
    }

    try {
      const dec = await decryptApiKeyWithPin(payload, pin);
      if (!dec || !dec.trim()) throw new Error('Decryption produced empty key');
      sessionApiKey = dec.trim();

      // close even if blocking (success path)
      closeApiKeyModal({ force: true });
    } catch {
      if (hintEl) hintEl.textContent = 'Invalid PIN (or corrupted stored key). Try again.';
      clearPinBoxes({ focusIndex: 0 });
    }
    return;
  }

  // SETUP / MANAGE: encrypt + store new key
  if (!key) {
    if (hintEl) hintEl.textContent = 'API key is required.';
    apiInput?.focus();
    apiInput?.select();
    return;
  }

  try {
    const payload = await encryptApiKeyWithPin(key, pin);
    saveEncryptedPayload(payload);
    sessionApiKey = key;

    closeApiKeyModal({ force: true });
  } catch (e) {
    if (hintEl) hintEl.textContent = `Failed to encrypt and save: ${e?.message || e}`;
  }
}

function bootstrapApiKeyFlow() {
  // Encrypted key exists -> ask for PIN to unlock
  if (hasEncryptedApiKey()) {
    openApiKeyModal({
      mode: 'unlock',
      blocking: true,
      hint: 'Enter your 6-digit PIN to unlock the saved API key.'
    });
    return;
  }

  // Legacy plaintext exists -> force PIN setup to encrypt it
  const legacy = localStorage.getItem(LS_PLAIN_KEY) || '';
  if (legacy.trim()) {
    openApiKeyModal({
      mode: 'setup',
      blocking: true,
      hint: 'Set a 6-digit PIN to encrypt your existing saved API key.',
      prefillKey: legacy.trim()
    });
    return;
  }

  // No key -> force setup (non-disposable)
  openApiKeyModal({
    mode: 'setup',
    blocking: true,
    hint: 'API key + 6-digit PIN are required before you can use Apply Patch.'
  });
}

function openHelp() {
  const overlay = document.getElementById('helpOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  document.getElementById('helpCloseBtn')?.focus();
}

function closeHelp() {
  const overlay = document.getElementById('helpOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

// Load stored API key and model on app start
window.addEventListener('load', () => {
  const storedModel = localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';
  document.getElementById('modelSelect').value = storedModel;

  const storedTheme = localStorage.getItem('theme') || 'light';
  document.body.classList.toggle('dark', storedTheme === 'dark');
  ipcRenderer.send('theme:state', storedTheme);

  // Setup context menu
  document.body.addEventListener('contextmenu', handleContextMenu);
  // Add event listeners for buttons
  document.getElementById('applyBtn').addEventListener('click', () => applyPatch({ isRetry: false }));
  document.getElementById('retryBtn').addEventListener('click', () => applyPatch({ isRetry: true }));
  document.getElementById('copyBtn').addEventListener('click', copyOutput);
  document.getElementById('download').addEventListener('click', downloadResult);
  document.getElementById('modelSelect').addEventListener('change', (e) => {
    localStorage.setItem('selectedModel', e.target.value);
  });

  // Tabs
  initTabs();
  document.getElementById('newTabBtn')?.addEventListener('click', newTab);

  // --- Help overlay wiring (must be inside load) ---
  const overlay = document.getElementById('helpOverlay');
  const closeBtn = document.getElementById('helpCloseBtn');
  const okBtn = document.getElementById('helpOkBtn');

  if (closeBtn) closeBtn.addEventListener('click', closeHelp);
  if (okBtn) okBtn.addEventListener('click', closeHelp);

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeHelp();
    });
  }

  // --- API key modal wiring ---
  const apiOverlay = document.getElementById('apiKeyOverlay');
  const apiCloseBtn = document.getElementById('apiKeyCloseBtn');
  const apiCancelBtn = document.getElementById('apiKeyCancelBtn');
  const apiPrimaryBtn = document.getElementById('apiKeyPrimaryBtn');

  if (apiCloseBtn) apiCloseBtn.addEventListener('click', closeApiKeyModal);
  if (apiCancelBtn) apiCancelBtn.addEventListener('click', closeApiKeyModal);
  if (apiPrimaryBtn) apiPrimaryBtn.addEventListener('click', handleApiKeyPrimaryClick);

  // PIN boxes wiring (numbers only + auto-advance + backspace)
  setupPinBoxes();

  if (apiOverlay) {
    apiOverlay.addEventListener('click', (e) => {
      if (e.target === apiOverlay) closeApiKeyModal();
    });
  }

  // --- API key bootstrap (PIN unlock/setup on startup) ---
  bootstrapApiKeyFlow();

  // --- Tab rename modal wiring ---
  const renameOverlay = document.getElementById('tabRenameOverlay');
  const renameCloseBtn = document.getElementById('tabRenameCloseBtn');
  const renameCancelBtn = document.getElementById('tabRenameCancelBtn');
  const renameSaveBtn = document.getElementById('tabRenameSaveBtn');
  const renameInput = document.getElementById('tabRenameInput');

  if (renameCloseBtn) renameCloseBtn.addEventListener('click', closeTabRenameModal);
  if (renameCancelBtn) renameCancelBtn.addEventListener('click', closeTabRenameModal);
  if (renameSaveBtn) renameSaveBtn.addEventListener('click', saveTabRename);

  if (renameOverlay) {
    renameOverlay.addEventListener('click', (e) => {
      if (e.target === renameOverlay) closeTabRenameModal();
    });
  }

  if (renameInput) {
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveTabRename();
    });
  }

  // ESC should close whichever modal is open
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const renameOpen = renameOverlay && !renameOverlay.classList.contains('hidden');
    const apiOpen = apiOverlay && !apiOverlay.classList.contains('hidden');
    const helpOpen = overlay && !overlay.classList.contains('hidden');

    if (renameOpen) closeTabRenameModal();
    else if (apiOpen) {
      if (!apiModalBlocking) closeApiKeyModal();
    }
    else if (helpOpen) closeHelp();
  });

  // --- Go to top (appears when scrolling the main body) ---
  const mainScroll = document.getElementById('mainScroll');
  const goTopBtn = document.getElementById('goTopBtn');

  if (mainScroll && goTopBtn) {
    const updateGoTop = () => {
      const show = mainScroll.scrollTop > 120;
      goTopBtn.classList.toggle('hidden', !show);
    };

    mainScroll.addEventListener('scroll', updateGoTop);
    updateGoTop();

    goTopBtn.addEventListener('click', () => {
      mainScroll.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
});

ipcRenderer.on('theme:set', (_evt, theme) => {
  const shouldDark = theme === 'dark';

  document.body.classList.toggle('dark', shouldDark);
  localStorage.setItem('theme', shouldDark ? 'dark' : 'light');

  // Re-theme an already-rendered diff without regenerating HTML
  syncDiff2HtmlTheme();

  // keep the menu checkbox in sync
  ipcRenderer.send('theme:state', shouldDark ? 'dark' : 'light');
});

ipcRenderer.on('help:open', () => {
  openHelp();
});

ipcRenderer.on('apikey:open', () => {
  openApiKeyModal({
    mode: 'manage',
    blocking: false,
    hint: 'Enter a new API key and 6-digit PIN to re-encrypt and save.'
  });
});

async function applyPatch({ isRetry = false } = {}) {
  const tab = getActiveTab();
  if (!tab) return;

  const tabId = tab.id;

  // Prevent double-submit for same tab
  if (tab.inFlight) {
    const errorEl = document.getElementById('error');
    if (errorEl) errorEl.textContent = 'This tab already has a request running.';
    return;
  }

  const diffText = document.getElementById('diff').value;
  const modelContent = document.getElementById('model').value;
  const apiKey = getStoredApiKey();
  const selectedModel = document.getElementById('modelSelect').value;
  const outputEl = document.getElementById('output');
  const errorEl = document.getElementById('error');
  const loadingEl = document.getElementById('loading');
  const applyBtn = document.getElementById('applyBtn');
  const retryBtn = document.getElementById('retryBtn');
  const downloadBtn = document.getElementById('download');
  const copyBtn = document.getElementById('copyBtn');
  const diffViewEl = document.getElementById('diffView');

  errorEl.textContent = '';
  outputEl.textContent = '';
  diffViewEl.innerHTML = '';
  downloadBtn.classList.add('hidden');
  copyBtn.classList.add('hidden');
  retryBtn.classList.add('hidden');

  if (!isRetry) tab.retryCount = 0;

  if (!diffText || !modelContent) {
    errorEl.textContent = 'Please fill Diff Patch and File Content.';
    return;
  }

  if (!apiKey) {
    if (hasEncryptedApiKey()) {
      openApiKeyModal({
        mode: 'unlock',
        blocking: true,
        hint: 'Enter your 6-digit PIN to unlock the saved API key.'
      });
    } else {
      openApiKeyModal({
        mode: 'setup',
        blocking: true,
        hint: 'API key + 6-digit PIN are required before you can apply a patch.'
      });
    }
    return;
  }

  // Approximate size check (textarea content)
  const contentSizeMB = new Blob([modelContent]).size / (1024 * 1024);
  if (contentSizeMB > MAX_FILE_SIZE_MB) {
    if (!confirm(`Content is ${contentSizeMB.toFixed(2)}MB. May exceed API limits. Proceed?`)) {
      return;
    }
  }

  // Snapshot inputs at the time you clicked Apply
  const diffTextSnapshot = diffText;
  const modelContentSnapshot = modelContent;

  // Mark tab as in-flight with a unique token
  const token = `${tabId}:${++tab.requestSeq}:${Date.now()}`;
  tab.inFlightToken = token;
  tab.inFlight = true;
  renderTabs(); // NEW: show spinner on the tab immediately

  // Keep tab state consistent even if user switches tabs
  tab.diffText = diffTextSnapshot || '';
  tab.modelText = modelContentSnapshot || '';

  if (activeTabId === tabId) {
    applyBtn.disabled = true;
    loadingEl.classList.remove('hidden');
  }

  try {
    const openai = new OpenAI({
      apiKey,
      baseURL: 'https://api.x.ai/v1',
      dangerouslyAllowBrowser: true  // Enable for Electron renderer; key is user-provided and local
    });
    console.log('OpenAI SDK initialized with browser allowance.');

    const systemPrompt = [
      'You are an expert at applying unified diff patches to files accurately.',
      'The diff maybe a git style diff patch or a set of instructions with places to change in the target file code with micro diffs.',
      'It also may be general instruction set - like for example to replace something everywhere in the file.',
      '',
      'CRITICAL RULE:',
      'If the diff patch is not applicable with the provided original file content , DO NOT guess and DO NOT fabricate output.',
      'Do this if the target file is wrong, or the diff refers to a different file, or some other file is pasted instead of diff etc.',
      '',
      'In that case, output an error commentary ONLY using this exact format:',
      'ERROR: <one-line reason>',
      '- <optional hint 1>',
      '- <optional hint 2>',
      '',
      'Otherwise, output ONLY the full modified file content after applying the patch.',
      'No explanations, no extra text, and no code fences.'
    ].join('\n');

    const userPrompt = `Original file content:\n\n${modelContentSnapshot}\n\nDiff patch to apply:\n\n${diffTextSnapshot}\n\nApply the patch and output the exact resulting file.`;

    const completion = await openai.chat.completions.create({
      model: selectedModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 32768  // Higher for large files; per docs
    });

    let modified = completion.choices[0].message.content;
    // Strip any potential code fences
    modified = modified.replace(/^```[\w]*\n?|\n?```$/g, '').trim();

    // If this response is stale (user started a newer run), ignore it
    if (tab.inFlightToken !== token) {
      return;
    }

    // If model returned a congruency error, show it as an app error (not as file output)
    if (/^ERROR:/i.test(modified)) {
      tab.modifiedText = '';
      tab.diffHtml = '';
      tab.errorText = modified;
      tab.retryCount = 0;

      if (activeTabId === tabId) {
        outputEl.textContent = '';
        diffViewEl.innerHTML = '';
        downloadBtn.classList.add('hidden');
        copyBtn.classList.add('hidden');
        retryBtn.classList.add('hidden');
        errorEl.textContent = modified;
      }
      return;
    }

    // Build diff HTML
    const unifiedDiff = createTwoFilesPatch(
      'original',
      'modified',
      modelContentSnapshot,
      modified,
      '',
      '',
      { context: Number.MAX_SAFE_INTEGER }
    );

    const html = Diff2Html.html(unifiedDiff, {
      drawFileList: false,
      matching: 'none',
      outputFormat: 'side-by-side',
      synchronisedScroll: true,
      colorScheme: document.body.classList.contains('dark') ? 'dark' : 'light'
    });

    // Save into the originating tab
    tab.modifiedText = modified;
    tab.diffHtml = html;
    tab.errorText = '';
    tab.retryCount = 0;

    // Only paint UI if user is still viewing that tab
    if (activeTabId === tabId) {
      outputEl.textContent = modified;
      diffViewEl.innerHTML = html;
      syncDiff2HtmlTheme();
      errorEl.textContent = '';
      downloadBtn.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
    }

  } catch (error) {
    if (tab.inFlightToken !== token) return;

    tab.errorText = `Error: ${error.message}. `;
    if (tab.retryCount < MAX_RETRIES) {
      tab.retryCount++;
      tab.errorText += `Retry ${tab.retryCount}/${MAX_RETRIES} available.`;
    } else {
      tab.errorText += 'Max retries reached.';
    }

    if (activeTabId === tabId) {
      errorEl.textContent = tab.errorText;
      if (tab.retryCount > 0 && tab.retryCount < MAX_RETRIES) retryBtn.classList.remove('hidden');
    }

    console.error(error);
  } finally {
    // Only clear inFlight if this is still the current request for that tab
    if (tab.inFlightToken === token) {
      tab.inFlightToken = null;
      tab.inFlight = false;
      renderTabs(); // NEW: remove spinner when done
    }

    if (activeTabId === tabId) {
      loadingEl.classList.add('hidden');
      applyBtn.disabled = false;
    }
  }
}

function downloadResult() {
  const tab = getActiveTab();
  if (!tab || !tab.modifiedText) return;
  const a = document.createElement('a');
  const blob = new Blob([tab.modifiedText], { type: 'text/plain' });
  a.href = URL.createObjectURL(blob);
  a.download = 'modified_' + (tab.originalFileName || originalFileName || 'file.txt');
  a.click();
}

function copyOutput() {
  const outputEl = document.getElementById('output');
  navigator.clipboard.writeText(outputEl.textContent).then(() => {
    const btn = document.getElementById('copyBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

// Load diff from file
document.getElementById('diffFile').addEventListener('change', async (e) => {
  const text = await e.target.files[0].text();
  document.getElementById('diff').value = text;
  const tab = getActiveTab();
  if (tab) tab.diffText = text;
});

// Load model from file
document.getElementById('modelFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const text = await file.text();
  document.getElementById('model').value = text;
  originalFileName = file.name;
  const tab = getActiveTab();
  if (tab) {
    tab.modelText = text;
    tab.originalFileName = file.name;
    if (!tab.labelCustomized) {
      // CSS ellipsis will truncate visually to fit the sidebar
      tab.label = file.name;
      renderTabs();
    }
  }
});

// Custom context menu for text elements
function handleContextMenu(e) {
  const target = e.target;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'PRE') {
    e.preventDefault();
    const selection = window.getSelection().toString();
    if (selection) {
      document.execCommand('copy');
    } else {
      selectAllInElement(target);
    }
  }
}

function selectAllInElement(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}