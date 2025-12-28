'use strict';

// API Keys + PIN unlock + local encryption + key-type modal
// Designed for Electron renderer (Node integration), uses:
// - t / tFmt (passed in)
// - ipcRenderer (passed in)
// - localStorage, document, window.crypto

const PROVIDER_XAI = 'xai';
const PROVIDER_OPENAI = 'openai';
const PROVIDERS = [PROVIDER_XAI, PROVIDER_OPENAI];

function createApiKeyManager({ t, tFmt, ipcRenderer }) {
  // -------------------------
  // LocalStorage keys (encrypted payload)
  // -------------------------
  const LS = {
    [PROVIDER_XAI]:    { enc: 'api_key_enc_xai_v1' },
    [PROVIDER_OPENAI]: { enc: 'api_key_enc_openai_v1' }
  };

  // -------------------------
  // PIN/crypto params
  // -------------------------
  const PIN_LEN = 6;
  const ENC_VERSION = 1;
  const SALT_BYTES = 16;
  const AES_GCM_IV_BYTES = 12;
  const PBKDF2_ITERS = 150000;

  const webCrypto =
    (typeof window !== 'undefined' && window.crypto) ? window.crypto :
    (typeof globalThis !== 'undefined' ? globalThis.crypto : null);

  // -------------------------
  // Session (RAM-only)
  // -------------------------
  let sessionPin = '';
  const sessionApiKeys = {
    [PROVIDER_XAI]: '',
    [PROVIDER_OPENAI]: ''
  };

  // -------------------------
  // Modal state
  // -------------------------
  let apiModalMode = 'manage';
  let apiModalBlocking = false;
  let apiModalProvider = PROVIDER_XAI;
  let apiModalAskPin = true;
  let autoUnlockBusy = false;
  let keyTypeBlocking = false;
  let domWired = false;

  // -------------------------
  // Provider helpers
  // -------------------------
  function isValidPin(pin) {
    return /^\d{6}$/.test((pin || '').trim());
  }

  function _emitApiKeysChanged(provider) {
    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function' &&
        typeof window.CustomEvent === 'function'
      ) {
        window.dispatchEvent(new window.CustomEvent('apikeys:changed', { detail: { provider: String(provider || '') } }));
      }
    } catch {}
  }

  function providerForModel(model) {
    const m = (model || '').trim();
    // Convention: OpenAI models start with "gpt-"
    return m.startsWith('gpt-') ? PROVIDER_OPENAI : PROVIDER_XAI;
  }

  function baseUrlForProvider(provider) {
    return provider === PROVIDER_XAI ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
  }

  function getProviderUi(provider) {
    if (provider === PROVIDER_OPENAI) {
      return {
        title: t('apiKey.openaiTitle', 'OpenAI API Key'),
        placeholder: t('apiKey.openaiPlaceholder', 'sk-...'),
        introKey: t('providers.openai', 'OpenAI')
      };
    }
    if (provider === PROVIDER_XAI) {
      return {
        title: t('apiKey.xaiTitle', 'xAI API Key'),
        placeholder: t('apiKey.xaiPlaceholder', 'xai-...'),
        introKey: t('providers.xai', 'xAI')
      };
    }
    return {
      title: t('apiKey.unlockTitle', 'Unlock API Keys'),
      placeholder: '',
      introKey: t('apiKey.savedKeys', 'saved keys')
    };
  }

  // -------------------------
  // PIN boxes UI
  // -------------------------
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
    for (let i = 0; i < boxes.length; i++) boxes[i].value = clean[i] || '';
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
    const wrap = document.getElementById('apiKeyPinBoxes');
    if (!wrap) return;
    if (wrap.dataset.wired === '1') return;
    wrap.dataset.wired = '1';

    const boxes = getPinBoxes();
    if (!boxes.length) return;

    boxes.forEach((box, idx) => {
      box.addEventListener('input', () => {
        const digits = (box.value || '').replace(/\D/g, '');

        if (digits.length <= 1) {
          box.value = digits;
          syncHiddenPinFromBoxes();
          if (digits && idx < boxes.length - 1) focusPinBox(idx + 1);
        } else {
          const spread = digits.split('').slice(0, boxes.length - idx);
          spread.forEach((ch, j) => { boxes[idx + j].value = ch; });
          syncHiddenPinFromBoxes();
          const next = Math.min(idx + spread.length, boxes.length - 1);
          focusPinBox(next);
        }

        void maybeAutoUnlock();
      });

      box.addEventListener('keydown', (e) => {
        const key = e.key;

        if (key === 'Backspace') {
          e.preventDefault();
          if (box.value) {
            box.value = '';
            syncHiddenPinFromBoxes();
            return;
          }
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

        if (key.length === 1 && !/\d/.test(key)) e.preventDefault();
      });

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

  // -------------------------
  // b64 helpers (local to this module)
  // -------------------------
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

  // -------------------------
  // Crypto helpers
  // -------------------------
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

  // -------------------------
  // localStorage helpers
  // -------------------------
  function hasEncryptedApiKey(provider) {
    return !!localStorage.getItem(LS[provider]?.enc);
  }

  function hasAnyEncryptedApiKey() {
    return PROVIDERS.some(p => hasEncryptedApiKey(p));
  }

  function loadEncryptedPayload(provider) {
    const raw = localStorage.getItem(LS[provider]?.enc);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (!obj || obj.v !== ENC_VERSION || !obj.iv || !obj.salt || !obj.ct) return null;
      return obj;
    } catch {
      return null;
    }
  }

  // Length of stored plaintext key without decrypting (AES-GCM returns ct = pt + 16-byte tag)
  function getEncryptedApiKeyLength(provider) {
    const payload = loadEncryptedPayload(provider);
    if (!payload?.ct) return 0;
    try {
      const ctBytes = b64ToBytes(payload.ct);
      return Math.max(0, ctBytes.length - 16);
    } catch {
      return 0;
    }
  }

  function saveEncryptedPayload(provider, payload) {
    localStorage.setItem(LS[provider]?.enc, JSON.stringify(payload));
  }

  async function maybeDecryptProviderInSession(provider) {
    if (sessionApiKeys[provider]) return true;
    if (!isValidPin(sessionPin)) return false;
    if (!hasEncryptedApiKey(provider)) return false;
    const payload = loadEncryptedPayload(provider);
    if (!payload) return false;
    try {
      const dec = await decryptApiKeyWithPin(payload, sessionPin);
      if (!dec || !dec.trim()) return false;
      sessionApiKeys[provider] = dec.trim();
      return true;
    } catch {
      return false;
    }
  }

  function getStoredApiKey(provider) {
    return sessionApiKeys[provider] || '';
  }

  // -------------------------
  // PIN Change (re-encrypt all stored keys with a new PIN)
  // -------------------------
  async function changePin({ oldPin, newPin } = {}) {
    const op = String(oldPin || '').trim();
    const np = String(newPin || '').trim();

    if (!webCrypto?.subtle) {
      return { ok: false, reason: 'webcrypto_missing' };
    }
    if (!isValidPin(op) || !isValidPin(np)) {
      return { ok: false, reason: 'pin_invalid' };
    }

    // Collect decrypted keys first (no partial overwrite)
    const decrypted = {};
    let any = false;
    for (const p of PROVIDERS) {
      const payload = loadEncryptedPayload(p);
      if (!payload) continue;
      try {
        const dec = await decryptApiKeyWithPin(payload, op);
        if (dec && dec.trim()) {
          decrypted[p] = dec.trim();
          any = true;
        }
      } catch {
        return { ok: false, reason: 'decrypt_failed' };
      }
    }

    if (!any) return { ok: false, reason: 'no_keys' };

    // Encrypt + persist
    try {
      for (const p of Object.keys(decrypted)) {
        const payload = await encryptApiKeyWithPin(decrypted[p], np);
        saveEncryptedPayload(p, payload);
      }

      // Update session state
      sessionPin = np;
      for (const p of Object.keys(decrypted)) {
        sessionApiKeys[p] = decrypted[p];
        _emitApiKeysChanged(p);
      }

      return { ok: true };
    } catch {
      return { ok: false, reason: 'reencrypt_failed' };
    }
  }

  function clearStoredKeysAndSession() {
    try {
      for (const p of PROVIDERS) {
        localStorage.removeItem(LS[p]?.enc);
        sessionApiKeys[p] = '';
        _emitApiKeysChanged(p);
      }
      sessionPin = '';
    } catch {}
  }

  // -------------------------
  // API key modal UI helpers
  // -------------------------
  function setApiKeyRowLocked(apiInput, editBtn, maskLen) {
    if (!apiInput || !editBtn) return;
    apiInput.type = 'text'; // show literal asterisks
    apiInput.value = '*'.repeat(Math.max(0, maskLen || 0));
    apiInput.disabled = true; // greyed out via CSS
    editBtn.textContent = t('buttons.update', 'Update');
    editBtn.dataset.mode = 'locked';
  }

  function setApiKeyRowEdit(apiInput, editBtn, value = '') {
    if (!apiInput || !editBtn) return;
    apiInput.disabled = false;
    apiInput.type = 'password'; // hide actual key while typing
    apiInput.value = value || '';
    editBtn.textContent = t('buttons.save', 'Save');
    editBtn.dataset.mode = 'edit';
    setTimeout(() => {
      try { apiInput.focus(); apiInput.select(); } catch {}
    }, 0);
  }

  function openApiKeyModal({ provider = PROVIDER_XAI, mode = 'manage', blocking = false, hint = '', prefillKey = '', askPin = true } = {}) {
    const overlay = document.getElementById('apiKeyOverlay');
    const apiInput = document.getElementById('apiKeyModalInput');
    const pinInput = document.getElementById('apiKeyPinInput'); // hidden aggregator
    const pinBoxesWrap = document.getElementById('apiKeyPinBoxes');
    const pinLabel = document.getElementById('apiKeyPinLabel');
    const primaryBtn = document.getElementById('apiKeyPrimaryBtn');
    const editBtn = document.getElementById('apiKeyEditBtn');
    const apiKeyRow = document.getElementById('apiKeyInputRow');
    const cancelBtn = document.getElementById('apiKeyCancelBtn');
    const closeBtn = document.getElementById('apiKeyCloseBtn');
    const hintEl = document.getElementById('apiKeyModalHint');
    const apiLabel = document.getElementById('apiKeyModalLabel');
    const titleEl = document.getElementById('apiKeyTitle');
    const introEl = document.getElementById('apiKeyModalIntro');

    if (!overlay || !primaryBtn || !pinBoxesWrap || !pinInput) return;

    apiModalMode = mode;
    apiModalBlocking = !!blocking;
    apiModalProvider = provider;
    apiModalAskPin = !!askPin;

    const ui = getProviderUi(provider);
    if (titleEl) titleEl.textContent = ui.title;
    if (apiInput && ui.placeholder) apiInput.setAttribute('placeholder', ui.placeholder);

    if (introEl) {
      if (mode === 'unlock') {
        introEl.innerHTML = t('apiKey.introUnlockHtml', 'Enter your <b>6-digit PIN</b> to unlock and decrypt saved keys for this session.');
      } else if (!apiModalAskPin && isValidPin(sessionPin)) {
        introEl.innerHTML = tFmt(
          'apiKey.introNoPinHtml',
          { provider: ui.introKey },
          `Enter your <b>${ui.introKey} API Key</b>. It will be encrypted locally using the PIN already unlocked for this session.`
        );
      } else {
        introEl.innerHTML = tFmt(
          'apiKey.introWithPinHtml',
          { provider: ui.introKey },
          `Enter your <b>${ui.introKey} API Key</b> and a <b>6-digit PIN</b>. The key is encrypted locally and stored in this app (localStorage). The PIN is not stored.`
        );
      }
    }

    if (hintEl) hintEl.textContent = hint || '';

    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');

    // show/hide API key field depending on mode
    const showKey = mode !== 'unlock';
    if (apiLabel) apiLabel.classList.toggle('hidden', !showKey);
    if (apiKeyRow) apiKeyRow.classList.toggle('hidden', !showKey);
    if (editBtn) editBtn.classList.toggle('hidden', !showKey);
    if (apiInput) apiInput.value = '';

    // API key row behavior
    if (showKey && apiInput && editBtn) {
      const hasKey = hasEncryptedApiKey(apiModalProvider);
      if (hasKey) {
        const maskLen = getEncryptedApiKeyLength(apiModalProvider) || 0;
        setApiKeyRowLocked(apiInput, editBtn, maskLen);
      } else {
        setApiKeyRowEdit(apiInput, editBtn, prefillKey || '');
      }
    }

    // PIN UI: show only if askPin=true (or unlock mode)
    const showPinUi = (mode === 'unlock') ? true : apiModalAskPin;
    if (pinLabel) pinLabel.classList.toggle('hidden', !showPinUi);
    pinBoxesWrap.classList.toggle('hidden', !showPinUi);
    pinInput.value = '';
    clearPinBoxes({ focusIndex: 0 });

    // button labels
    primaryBtn.textContent = t('buttons.unlock', 'Unlock');
    primaryBtn.classList.toggle('hidden', mode !== 'unlock');

    // blocking behavior
    if (closeBtn) closeBtn.classList.toggle('hidden', apiModalBlocking);
    if (cancelBtn) cancelBtn.classList.toggle('hidden', apiModalBlocking);

    // focus
    setTimeout(() => {
      if (mode === 'unlock') {
        focusPinBox(0);
      } else if (apiInput && editBtn) {
        if (apiInput.disabled) editBtn.focus();
        else { apiInput.focus(); apiInput.select(); }
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
    const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
    const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
    const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
    const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
    const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
    const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');
    const pinOpen = !document.getElementById('pinChangeOverlay')?.classList.contains('hidden');
    const resetOpen = !document.getElementById('cleanResetOverlay')?.classList.contains('hidden');

    if (!helpOpen && !renameOpen && !apiOpen && !closeOpen && !typeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen && !pinOpen && !resetOpen) {
      document.body.classList.remove('modal-open');
    }

    apiModalBlocking = false;
    apiModalMode = 'manage';
    clearPinBoxes({ focusIndex: 0 });
  }

  async function handleApiKeyPrimaryClick() {
    // Primary button is ONLY for Unlock mode. If somehow triggered otherwise, treat as Save/Update.
    if (apiModalMode !== 'unlock') {
      await handleApiKeyEditBtnClick();
      return;
    }

    const hintEl = document.getElementById('apiKeyModalHint');
    const pin = apiModalAskPin ? getPinFromBoxes() : (sessionPin || '');

    if (hintEl) hintEl.textContent = '';

    if (!webCrypto?.subtle) {
      if (hintEl) hintEl.textContent = t('apiKey.webCryptoMissing', 'WebCrypto is not available in this environment.');
      return;
    }

    if (!isValidPin(pin)) {
      if (hintEl) hintEl.textContent = t('apiKey.pinInvalid', 'PIN must be exactly 6 digits.');
      clearPinBoxes({ focusIndex: 0 });
      return;
    }

    // UNLOCK MODE: decrypt all saved encrypted keys (xAI + OpenAI) in one go
    try {
      let any = false;
      for (const p of PROVIDERS) {
        const payload = loadEncryptedPayload(p);
        if (!payload) continue;
        const dec = await decryptApiKeyWithPin(payload, pin);
        if (dec && dec.trim()) {
          sessionApiKeys[p] = dec.trim();
          any = true;
        }
      }

      if (!any) {
        if (hintEl) hintEl.textContent = t('apiKey.noEncryptedKeys', 'No encrypted keys found (or data is corrupted).');
        return;
      }

      sessionPin = pin; // keep PIN in RAM for this session
      closeApiKeyModal({ force: true });
    } catch {
      if (hintEl) hintEl.textContent = t('apiKey.pinDecryptFailed', 'Invalid PIN (or corrupted stored key). Try again.');
      clearPinBoxes({ focusIndex: 0 });
    }
  }

  async function handleApiKeyEditBtnClick() {
    const apiInput = document.getElementById('apiKeyModalInput');
    const editBtn = document.getElementById('apiKeyEditBtn');
    const hintEl = document.getElementById('apiKeyModalHint');

    if (!apiInput || !editBtn) return;
    if (hintEl) hintEl.textContent = '';

    const mode = editBtn.dataset.mode || 'edit';

    // Locked -> enable editing
    if (mode === 'locked') {
      setApiKeyRowEdit(apiInput, editBtn, '');
      return;
    }

    // Edit -> Save
    const key = (apiInput.value || '').trim();
    if (!key) {
      if (hintEl) hintEl.textContent = t('apiKey.keyRequired', 'API key is required.');
      try { apiInput.focus(); } catch {}
      return;
    }

    if (!webCrypto?.subtle) {
      if (hintEl) hintEl.textContent = t('apiKey.webCryptoMissing', 'WebCrypto is not available in this environment.');
      return;
    }

    const pin = apiModalAskPin ? getPinFromBoxes() : (sessionPin || '');
    if (apiModalAskPin && !isValidPin(pin)) {
      if (hintEl) hintEl.textContent = t('apiKey.pinInvalid', 'PIN must be exactly 6 digits.');
      clearPinBoxes({ focusIndex: 0 });
      return;
    }

    try {
      const effectivePin = apiModalAskPin ? pin : sessionPin;
      if (!isValidPin(effectivePin)) {
        if (hintEl) hintEl.textContent = t('apiKey.pinNotInSession', 'PIN is not available in this session. Please unlock first.');
        return;
      }

      const provider = apiModalProvider || PROVIDER_XAI;
      const payload = await encryptApiKeyWithPin(key, effectivePin);
      saveEncryptedPayload(provider, payload);
      sessionApiKeys[provider] = key;
      sessionPin = effectivePin; // keep PIN in RAM for this session

      // Notify renderer to re-evaluate model dropdown gating
      _emitApiKeysChanged(provider);

      // If this modal was blocking (startup / apply flow), close immediately after save.
      if (apiModalBlocking) {
        closeApiKeyModal({ force: true });
        return;
      }

      // Otherwise, lock + mask in-place.
      setApiKeyRowLocked(apiInput, editBtn, key.length);
      if (hintEl) hintEl.textContent = t('apiKey.saved', 'Saved.');
      if (apiModalAskPin) clearPinBoxes({ focusIndex: 0 });
    } catch (e) {
      if (hintEl) hintEl.textContent = tFmt('apiKey.saveFailed', { err: (e?.message || e) }, `Failed to encrypt and save: ${e?.message || e}`);
    }
  }

  // -------------------------
  // Key type modal
  // -------------------------
  function openKeyTypeModal({ blocking = true, hint = '' } = {}) {
    const overlay = document.getElementById('keyTypeOverlay');
    const hintEl = document.getElementById('keyTypeHint');
    if (!overlay) return;
    keyTypeBlocking = !!blocking;
    if (hintEl) hintEl.textContent = hint || '';
    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');
    setTimeout(() => { document.getElementById('keyTypeXaiBtn')?.focus(); }, 0);
  }

  function closeKeyTypeModal({ force = false } = {}) {
    if (keyTypeBlocking && !force) return;
    const overlay = document.getElementById('keyTypeOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');

    // Only remove modal-open if *no* other modal is open
    const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
    const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
    const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
    const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
    const typeOpen = !overlay.classList.contains('hidden');
    const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
    const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
    const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
    const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');
    const pinOpen = !document.getElementById('pinChangeOverlay')?.classList.contains('hidden');
    const resetOpen = !document.getElementById('cleanResetOverlay')?.classList.contains('hidden');

    if (!helpOpen && !apiOpen && !renameOpen && !closeOpen && !typeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen && !pinOpen && !resetOpen) {
      document.body.classList.remove('modal-open');
    }
    keyTypeBlocking = false;
  }

  // -------------------------
  // Startup bootstrap
  // -------------------------
  function bootstrapApiKeyFlow() {
    // Any encrypted keys exist -> ask once for PIN and decrypt BOTH keys into RAM
    if (hasAnyEncryptedApiKey()) {
      openApiKeyModal({
        provider: 'all',
        mode: 'unlock',
        blocking: true,
        askPin: true,
        hint: t('apiKey.unlockHint', 'Enter your 6-digit PIN to unlock saved keys for this session.')
      });
      return;
    }

    // No keys at all -> force provider selection first
    openKeyTypeModal({
      blocking: true,
      hint: t('apiKey.chooseProviderHint', 'Choose a provider to set up an API key.')
    });
  }

  // This is the helper your renderer can call from applyPatch:
  // - Returns true if key is ready in session, false if we opened a modal
  async function ensureKeyOrPrompt({ provider, blocking = true } = {}) {
    const p = (provider === PROVIDER_OPENAI || provider === PROVIDER_XAI) ? provider : PROVIDER_XAI;

    // 1) Try to make key available silently
    await maybeDecryptProviderInSession(p);
    if (getStoredApiKey(p)) return true;

    // 2) Decide which UI to open
    const anyStored = hasAnyEncryptedApiKey();
    if (!anyStored) {
      openKeyTypeModal({ blocking: true, hint: 'Choose a provider to set up an API key.' });
      return false;
    }

    if (hasAnyEncryptedApiKey() && !isValidPin(sessionPin)) {
      openApiKeyModal({
        provider: 'all',
        mode: 'unlock',
        blocking: true,
        askPin: true,
        hint: 'Enter your 6-digit PIN to unlock saved keys for this session.'
      });
      return false;
    }

    openApiKeyModal({
      provider: p,
      mode: 'setup',
      blocking: !!blocking,
      askPin: !isValidPin(sessionPin),
      hint: isValidPin(sessionPin)
        ? `Enter your ${p === PROVIDER_OPENAI ? 'OpenAI' : 'xAI'} API key to save it (PIN already unlocked for this session).`
        : `Enter your ${p === PROVIDER_OPENAI ? 'OpenAI' : 'xAI'} API key and a 6-digit PIN to save it.`
    });
    return false;
  }

  // -------------------------
  // Menu-open handler (renderer keeps ipcRenderer.on('apikey:open', ...) but delegates here)
  // -------------------------
  function openFromMenu(payload) {
    const requested = payload?.provider === PROVIDER_OPENAI ? PROVIDER_OPENAI : PROVIDER_XAI;

    // If PIN isn't in RAM but keys exist, force unlock first
    if (!isValidPin(sessionPin) && hasAnyEncryptedApiKey()) {
      openApiKeyModal({
        provider: 'all',
        mode: 'unlock',
        blocking: true,
        askPin: true,
        hint: 'Enter your 6-digit PIN to unlock saved keys for this session.'
      });
      return;
    }

    openApiKeyModal({
      provider: requested,
      mode: hasEncryptedApiKey(requested) ? 'manage' : 'setup',
      blocking: false,
      askPin: !isValidPin(sessionPin),
      hint: isValidPin(sessionPin)
        ? 'Enter a new API key to re-encrypt and save (PIN already unlocked for this session).'
        : 'Enter an API key and 6-digit PIN to encrypt and save.'
    });
  }

  // -------------------------
  // Wire DOM events (call once after UI is ready)
  // -------------------------
  function wireDomEvents() {
    if (domWired) return;
    domWired = true;

    // API key modal
    const apiOverlay = document.getElementById('apiKeyOverlay');
    const apiCloseBtn = document.getElementById('apiKeyCloseBtn');
    const apiCancelBtn = document.getElementById('apiKeyCancelBtn');
    const apiPrimaryBtn = document.getElementById('apiKeyPrimaryBtn');
    const apiEditBtn = document.getElementById('apiKeyEditBtn');
    const apiKeyModalInput = document.getElementById('apiKeyModalInput');

    if (apiCloseBtn) apiCloseBtn.addEventListener('click', () => closeApiKeyModal());
    if (apiCancelBtn) apiCancelBtn.addEventListener('click', () => closeApiKeyModal());
    if (apiPrimaryBtn) apiPrimaryBtn.addEventListener('click', () => { void handleApiKeyPrimaryClick(); });
    if (apiEditBtn) apiEditBtn.addEventListener('click', () => { void handleApiKeyEditBtnClick(); });

    if (apiKeyModalInput) {
      apiKeyModalInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (apiModalMode === 'unlock') return;
        const btn = document.getElementById('apiKeyEditBtn');
        if (btn?.dataset?.mode === 'edit') {
          e.preventDefault();
          void handleApiKeyEditBtnClick();
        }
      });
    }

    setupPinBoxes();

    if (apiOverlay) {
      apiOverlay.addEventListener('click', (e) => {
        if (e.target === apiOverlay) closeApiKeyModal();
      });
    }

    // Key type modal
    const keyTypeOverlay = document.getElementById('keyTypeOverlay');
    const keyTypeXaiBtn = document.getElementById('keyTypeXaiBtn');
    const keyTypeOpenAiBtn = document.getElementById('keyTypeOpenAiBtn');

    if (keyTypeXaiBtn) {
      keyTypeXaiBtn.addEventListener('click', () => {
        closeKeyTypeModal({ force: true });
        openApiKeyModal({
          provider: PROVIDER_XAI,
          mode: 'setup',
          blocking: true,
          askPin: !isValidPin(sessionPin),
          hint: 'Enter your xAI API key and a 6-digit PIN to save it.'
        });
      });
    }

    if (keyTypeOpenAiBtn) {
      keyTypeOpenAiBtn.addEventListener('click', () => {
        closeKeyTypeModal({ force: true });
        openApiKeyModal({
          provider: PROVIDER_OPENAI,
          mode: 'setup',
          blocking: true,
          askPin: !isValidPin(sessionPin),
          hint: 'Enter your OpenAI API key and a 6-digit PIN to save it.'
        });
      });
    }

    if (keyTypeOverlay) {
      keyTypeOverlay.addEventListener('click', (e) => {
        if (e.target === keyTypeOverlay) closeKeyTypeModal();
      });
    }
  }

  return {
    // constants (useful if you want to compare in renderer)
    PROVIDER_XAI,
    PROVIDER_OPENAI,

    // provider helpers
    providerForModel,
    baseUrlForProvider,

    // storage/session helpers
    maybeDecryptProviderInSession,
    getStoredApiKey,
    hasAnyEncryptedApiKey,
    hasEncryptedApiKey,

    // flows
    bootstrapApiKeyFlow,
    ensureKeyOrPrompt,
    openFromMenu,

    // pin + reset helpers
    changePin,
    clearStoredKeysAndSession,

    // wiring + (optional) escape-close
    wireDomEvents,
    closeApiKeyModal,
    closeKeyTypeModal
  };
}

module.exports = {
  PROVIDER_XAI,
  PROVIDER_OPENAI,
  createApiKeyManager
};