/* renderer.js */
const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
// (no new deps)

const Diff2Html = require('diff2html');  // For rendering as HTML
const { ipcRenderer, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { createSystemPromptsManager, DEFAULT_SYS_PROMPT_ID } = require('./systemPrompts');
const { createTabsManager } = require('./tabs');
const { createApiKeyManager } = require('./apikeys');
const { createModelsManager } = require('./models');
const { createI18nManager } = require('./i18n');
const { createHistoryManager } = require('./history');
const { createVersionManager } = require('./version');
const { createOverlayManager } = require('./overlays');

let versionMgr = null;

// -------------------------
// Overlay / Modal manager (single source of truth)
// -------------------------
let systemPromptsMgr = null;
function _onSysPromptOverlayClosed() {
  // overlayMgr can close the overlay via ESC/outside; keep manager state consistent.
  try { systemPromptsMgr?.onOverlayClosed?.(); } catch { }
}

const overlayMgr = createOverlayManager({ document });

// Register all overlays once (safe even before DOMContentLoaded)
overlayMgr.register({ id: 'helpOverlay', closeOnEsc: true, closeOnOutside: true });
overlayMgr.register({ id: 'aboutOverlay', closeOnEsc: true, closeOnOutside: true });
overlayMgr.register({ id: 'tabRenameOverlay', closeOnEsc: true, closeOnOutside: true, onClose: () => { try { renamingTabId = null; } catch { } } });
overlayMgr.register({ id: 'tabCloseOverlay', closeOnEsc: true, closeOnOutside: true, onClose: () => { try { closingTabId = null; } catch { } } });
overlayMgr.register({
  id: 'sysPromptOverlay', closeOnEsc: true, closeOnOutside: true, onClose: _onSysPromptOverlayClosed
});
// These are managed by extracted modules; we still register them so:
// - body.modal-open stays correct
// - closeAll({force:true}) works reliably
overlayMgr.register({
  id: 'apiKeyOverlay',
  closeOnEsc: ({ el }) => !((el?.dataset?.force === '1') || (el?.dataset?.forced === '1')),
  closeOnOutside: ({ el }) => !((el?.dataset?.force === '1') || (el?.dataset?.forced === '1')),
  onClose: () => { try { initApiKeysManagerOnce()?.closeApiKeyModal?.({ force: true }); } catch { } }
});
overlayMgr.register({
  id: 'keyTypeOverlay',
  closeOnEsc: ({ el }) => !((el?.dataset?.force === '1') || (el?.dataset?.forced === '1')),
  closeOnOutside: ({ el }) => !((el?.dataset?.force === '1') || (el?.dataset?.forced === '1')),
  onClose: () => { try { initApiKeysManagerOnce()?.closeKeyTypeModal?.({ force: true }); } catch { } }
});
overlayMgr.register({
  id: 'historyOverlay',
  closeOnEsc: true,
  closeOnOutside: true,
  onClose: () => { try { initHistoryManagerOnce()?.closeHistoryModal?.(); } catch { } }
});
// Language overlay may be force/non-dismissable during boot; do NOT close on ESC/outside.
overlayMgr.register({
  id: 'languageOverlay',
  closeOnEsc: false,
  closeOnOutside: false,
  onClose: () => { try { closeLanguageModal?.({ force: true }); } catch { } }
});
overlayMgr.register({ id: 'pinChangeOverlay', closeOnEsc: true, closeOnOutside: true });
overlayMgr.register({ id: 'cleanResetOverlay', closeOnEsc: true, closeOnOutside: true });
overlayMgr.register({
  id: 'cancelApiOverlay',
  closeOnEsc: { preventDefault: true, stopPropagation: true },
  closeOnOutside: true,
  onClose: () => {
    try {
      const overlay = document.getElementById('cancelApiOverlay');
      if (overlay) { try { delete overlay.dataset.tabId; delete overlay.dataset.token; } catch { } }
    } catch { }
  }
});
overlayMgr.register({
  id: 'confirmApplyOverlay',
  closeOnEsc: { preventDefault: true, stopPropagation: true },
  closeOnOutside: true,
  onClose: () => {
    try {
      _confirmApplyOnOk = null;
      const overlay = document.getElementById('confirmApplyOverlay');
      if (overlay) {
        try {
          delete overlay.dataset.modelName;
          delete overlay.dataset.tabId;
          delete overlay.dataset.providerId;
        } catch {
          overlay.dataset.modelName = '';
          overlay.dataset.tabId = '';
          overlay.dataset.providerId = '';
        }
      }
    } catch { }
  }
});
overlayMgr.register({
  id: 'versionOverlay',
  closeOnEsc: true,
  closeOnOutside: true,
  onClose: () => { try { versionMgr?.closeUpdateModal?.({ force: true }); } catch { } }
});

// --- Close modals + keep tabs safe when switching language ---
function closeAllModalsForLanguageChange() {
  // stash current tab inputs safely (doesn't touch their contents)
  try { initTabsManagerOnce(); saveActiveTabFromDom(); } catch { }

  // Single primitive
  try { overlayMgr.closeAll({ force: true }); } catch { }
  try { overlayMgr.syncBodyClass(); } catch { }
}

function setButtonLabelText(btn, text) {
  if (!btn) return;
  const lbl = btn.querySelector ? btn.querySelector('.btn-label') : null;
  if (lbl) {
    lbl.textContent = text;
  } else {
    btn.textContent = text;
  }
  btn.title = text;
  btn.setAttribute('aria-label', text);
}

// -------------------------
// Localized "Choose file" / "No file chosen" (custom file picker UI)
// -------------------------
function applyI18nToFilePickers() {
  const diffBtn = document.getElementById('diffFileBtn');
  const diffName = document.getElementById('diffFileName');
  const modelBtn = document.getElementById('modelFileBtn');
  const modelName = document.getElementById('modelFileName');

  const choose = t('filePicker.chooseFile', 'Choose file');
  const none = t('filePicker.noFileChosen', 'No file chosen');

  if (diffBtn) {
    diffBtn.textContent = choose;
    diffBtn.title = choose;
    diffBtn.setAttribute('aria-label', choose);
  }
  if (modelBtn) {
    modelBtn.textContent = choose;
    modelBtn.title = choose;
    modelBtn.setAttribute('aria-label', choose);
  }

  // Keep filename displays PER-TAB (do not leak across tabs)
  let tab = null;
  try { tab = (typeof getActiveTab === 'function') ? getActiveTab() : null; } catch { }
  if (tab) {
    try { syncFilePickerNamesFromTab(tab); } catch { }
  } else {
    if (diffName) { diffName.textContent = none; diffName.dataset.hasFile = '0'; }
    if (modelName) { modelName.textContent = none; modelName.dataset.hasFile = '0'; }
  }
}

// -------------------------
// Copy button labels (floating Copy + topbar Copy Output)
// -------------------------
function applyI18nToCopyButtons() {
  const copyBtn = document.getElementById('copyBtn');
  const topBtn = document.getElementById('copyOutputTopBtn');

  if (copyBtn && copyBtn.dataset.copyState !== 'copied') {
    const lbl = t('output.copy', 'Copy');
    setButtonLabelText(copyBtn, lbl);
  }

  if (topBtn && topBtn.dataset.copyState !== 'copied') {
    const lbl = t('output.copyOutput', 'Copy Output');
    setButtonLabelText(topBtn, lbl);
  }
}

// -------------------------
// "Go To Output Diff" button label (topbar)
// -------------------------
function applyI18nToGoOutputDiffButton() {
  const btn = document.getElementById('goOutputDiffBtn');
  if (!btn) return;
  const lbl = t('nav.goToOutputDiff', 'Output Diff');
  setButtonLabelText(btn, lbl);
}

function setFilePickerName(kind /* 'diff' | 'model' */, name) {
  const none = t('filePicker.noFileChosen', 'No file chosen');
  const el = document.getElementById(kind === 'diff' ? 'diffFileName' : 'modelFileName');
  if (!el) return;
  const nm = String(name || '').trim();
  if (nm) {
    el.textContent = nm;
    el.dataset.hasFile = '1';
  } else {
    el.textContent = none;
    el.dataset.hasFile = '0';
  }
}

// -------------------------
// Per-tab file picker filename state
// -------------------------
function syncFilePickerNamesFromTab(tab) {
  const diffNm = String(tab?.diffInputFileName || '').trim();
  const modelNm = String(tab?.modelInputFileName || tab?.originalFileName || '').trim();
  setFilePickerName('diff', diffNm);
  setFilePickerName('model', modelNm);

  // Keep legacy global filename in sync for code paths that still rely on it
  // (download/apply logic elsewhere may read originalFileName)
  try {
    if (modelNm) originalFileName = modelNm;
    else if (tab?.originalFileName) originalFileName = tab.originalFileName;
  } catch { }
}

function _pickedFileNameFromInput(inputEl) {
  try {
    const f = inputEl?.files?.[0];
    return f ? String(f.name || '') : '';
  } catch {
    return '';
  }
}

function initPerTabFilePickerState() {
  const diffInput = document.getElementById('diffFile');
  const modelInput = document.getElementById('modelFile');

  if (diffInput && diffInput.dataset.perTabWired !== '1') {
    diffInput.dataset.perTabWired = '1';
    diffInput.addEventListener('change', () => {
      const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
      const nm = _pickedFileNameFromInput(diffInput);
      if (tab) tab.diffInputFileName = nm;
      // Update just-picked label immediately
      setFilePickerName('diff', nm);
    });
  }

  if (modelInput && modelInput.dataset.perTabWired !== '1') {
    modelInput.dataset.perTabWired = '1';
    modelInput.addEventListener('change', () => {
      const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
      const nm = _pickedFileNameFromInput(modelInput);
      if (tab) {
        tab.modelInputFileName = nm;
        if (nm) tab.originalFileName = nm;
      }
      if (nm) originalFileName = nm;
      setFilePickerName('model', nm);
    });
  }
}

let filePickerTabSyncObserver = null;
function initFilePickerTabSyncObserver() {
  const tabsRoot = document.getElementById('tabsList');
  if (!tabsRoot || filePickerTabSyncObserver) return;

  const schedule = () => {
    try {
      const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
      if (tab) {
        syncFilePickerNamesFromTab(tab);
        // Keep the active tab's model valid vs currently-configured provider keys
        initModelsManagerOnce()?.coerceActiveTabModelToEnabled?.(tab);
        // Keep Cancel/Apply/loader/timer synced on tab switch
        syncInFlightUiForActiveTab();
      }
    } catch { }
  };

  filePickerTabSyncObserver = new MutationObserver(schedule);
  filePickerTabSyncObserver.observe(tabsRoot, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-selected']
  });
  schedule();
}

function refreshUiAfterLanguageChange() {
  // 1) Tabs (aria-label, busy tooltip, etc.)
  try { initTabsManagerOnce(); renderTabsFull(); } catch { }

  // 2) System prompt button label (uses t/tFmt)
  try { initSystemPromptsManagerOnce()?.updateSystemPromptButtonForTab?.(getActiveTab()); } catch { }

  // 3) Model time string (uses tFmt)
  try { setModelTimeUi(getActiveTab()); } catch { }

  // 4) Diff nav labels already handled by applyI18nToStaticUi,
  //    but visibility/disabled state can be refreshed.
  try { updateDiffNavButtons(); } catch { }

  // 5) Custom file pickers ("Choose file" / "No file chosen")
  try { applyI18nToFilePickers(); } catch { }
  try { applyI18nToCopyButtons(); } catch { }
  try { applyI18nToGoOutputDiffButton(); } catch { }
  try { scheduleCopyOutputTopButtonUpdate(); } catch { }
  try { scheduleGoOutputDiffButtonUpdate(); } catch { }
  try { applyI18nToPinChangeModal(); } catch { }
  try { applyI18nToCleanResetModal(); } catch { }
  try { applyI18nToCancelApiModal(); } catch { }
  try { applyI18nToConfirmApplyModal(); } catch { }
  try { versionMgr?.applyI18nToUpdateModal?.(); } catch { }
  try { applyI18nToModelActionButtons(); } catch { }
  try { syncInFlightUiForActiveTab(); } catch { }
}

// -------------------------
// PIN Change + Clean Reset modals
// -------------------------
const PIN_CHANGE_LEN = 6;

function _pinBoxesIn(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('input.pin-box'));
}

function _focusPinBoxIn(wrapId, idx) {
  const boxes = _pinBoxesIn(wrapId);
  const el = boxes[idx];
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(0, el.value.length); } catch { }
}

function _readPinFromBoxes(wrapId) {
  const boxes = _pinBoxesIn(wrapId);
  return boxes.map(b => (b.value || '').replace(/\D/g, '')).join('').slice(0, PIN_CHANGE_LEN);
}

function _syncHiddenPin(hiddenId, pin) {
  const hidden = document.getElementById(hiddenId);
  if (hidden) hidden.value = String(pin || '').slice(0, PIN_CHANGE_LEN);
}

function _clearPinBoxesIn(wrapId, hiddenId, focusIndex = 0) {
  const boxes = _pinBoxesIn(wrapId);
  boxes.forEach(b => { b.value = ''; });
  _syncHiddenPin(hiddenId, '');
  if (boxes.length) _focusPinBoxIn(wrapId, Math.min(Math.max(focusIndex, 0), boxes.length - 1));
}

function _setPinBoxesFromString(wrapId, hiddenId, pin) {
  const clean = String(pin || '').replace(/\D/g, '').slice(0, PIN_CHANGE_LEN);
  const boxes = _pinBoxesIn(wrapId);
  for (let i = 0; i < boxes.length; i++) boxes[i].value = clean[i] || '';
  _syncHiddenPin(hiddenId, clean);
  const nextIdx = Math.min(clean.length, boxes.length - 1);
  if (boxes.length) _focusPinBoxIn(wrapId, nextIdx);
}

function _wireSixDigitBoxes({ wrapId, hiddenId, onComplete } = {}) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  if (wrap.dataset.wired === '1') return;
  wrap.dataset.wired = '1';

  const boxes = _pinBoxesIn(wrapId);
  if (!boxes.length) return;

  const sync = () => {
    const v = _readPinFromBoxes(wrapId);
    _syncHiddenPin(hiddenId, v);
    return v;
  };

  boxes.forEach((box, idx) => {
    box.addEventListener('input', () => {
      const digits = (box.value || '').replace(/\D/g, '');

      if (digits.length <= 1) {
        box.value = digits;
        const v = sync();
        if (digits && idx < boxes.length - 1) _focusPinBoxIn(wrapId, idx + 1);
        if (v.length === PIN_CHANGE_LEN) { try { onComplete?.(); } catch { } }
        return;
      }

      // spread pasted/fast-typed digits across remaining boxes
      const spread = digits.split('').slice(0, boxes.length - idx);
      spread.forEach((ch, j) => { boxes[idx + j].value = ch; });
      const v = sync();
      const next = Math.min(idx + spread.length, boxes.length - 1);
      _focusPinBoxIn(wrapId, next);
      if (v.length === PIN_CHANGE_LEN) { try { onComplete?.(); } catch { } }
    });

    box.addEventListener('keydown', (e) => {
      const key = e.key;

      if (key === 'Enter') {
        // let Enter behave like "Apply" anywhere in this modal
        e.preventDefault();
        void _doPinChange();
        return;
      }

      if (key === 'Backspace') {
        e.preventDefault();
        if (box.value) {
          box.value = '';
          sync();
          return;
        }
        if (idx > 0) {
          boxes[idx - 1].value = '';
          sync();
          _focusPinBoxIn(wrapId, idx - 1);
        }
        return;
      }

      if (key === 'ArrowLeft') {
        e.preventDefault();
        if (idx > 0) _focusPinBoxIn(wrapId, idx - 1);
        return;
      }

      if (key === 'ArrowRight') {
        e.preventDefault();
        if (idx < boxes.length - 1) _focusPinBoxIn(wrapId, idx + 1);
        return;
      }

      if (key.length === 1 && !/\d/.test(key)) e.preventDefault();
    });

    box.addEventListener('paste', (e) => {
      const txt = (e.clipboardData?.getData('text') || '').trim();
      const clean = txt.replace(/\D/g, '');
      if (!clean) return;
      e.preventDefault();
      _setPinBoxesFromString(wrapId, hiddenId, clean);
      const v = sync();
      if (v.length === PIN_CHANGE_LEN) { try { onComplete?.(); } catch { } }
    });
  });
}

function applyI18nToPinChangeModal() {
  const title = document.getElementById('pinChangeTitle');
  const intro = document.getElementById('pinChangeIntro');
  const oldLbl = document.getElementById('pinChangeOldPinLabel');
  const newLbl = document.getElementById('pinChangeNewPinLabel');
  const cfmLbl = document.getElementById('pinChangeConfirmPinLabel');
  const okBtn = document.getElementById('pinChangeApplyBtn');
  const cancelBtn = document.getElementById('pinChangeCancelBtn');

  if (title) title.textContent = t('pinChange.title', 'PIN Change');
  if (intro) intro.textContent = t('pinChange.intro', 'Enter your current PIN and choose a new 6-digit PIN. Your saved API keys will be re-encrypted locally using the new PIN.');
  if (oldLbl) oldLbl.textContent = t('pinChange.oldPinLabel', 'Old PIN (6 digits)');
  if (newLbl) newLbl.textContent = t('pinChange.newPinLabel', 'New PIN (6 digits)');
  if (cfmLbl) cfmLbl.textContent = t('pinChange.confirmPinLabel', 'Confirm new PIN');
  if (okBtn) okBtn.textContent = t('pinChange.apply', 'Change PIN');
  if (cancelBtn) cancelBtn.textContent = t('pinChange.cancel', 'Cancel');
}

function applyI18nToCleanResetModal() {
  const title = document.getElementById('cleanResetTitle');
  const body = document.getElementById('cleanResetBody');
  const okBtn = document.getElementById('cleanResetConfirmBtn');
  const cancelBtn = document.getElementById('cleanResetCancelBtn');

  if (title) title.textContent = t('cleanReset.title', 'Clean and Reset');
  if (body) body.innerHTML = t('cleanReset.bodyHtml', 'This will <b>remove all local app data</b> (API keys, history, prompts, tabs, and settings). You will need to set up the app again.');
  if (okBtn) okBtn.textContent = t('cleanReset.confirm', 'Yes, reset everything');
  if (cancelBtn) cancelBtn.textContent = t('cleanReset.cancel', 'Cancel');
}

// -------------------------
// Confirm Apply Patch modal
// -------------------------
let _confirmApplyWired = false;
let _confirmApplyOnOk = null;
let _confirmApplyBypass = false;
const CONFIRM_APPLY_MODEL_TOKEN = '__MODEL__';

// -------------------------
  // Models: extracted manager (./models.js)
  // - manifest loading + dropdown building
  // - provider gating + coercion
  // - provider/model lookup for confirmApply
  // -------------------------
  let modelsMgr = null;
  function initModelsManagerOnce() {
    if (modelsMgr) return modelsMgr;
    modelsMgr = createModelsManager({
      window,
      document,
      fs,
      path,
      appDirname: __dirname,
      cwd: (typeof process !== 'undefined' && process?.cwd) ? process.cwd() : '',
      storage: localStorage,
      apiKeys: {
        hasEncryptedApiKey: (providerId) => {
          try { return !!apiKeysMgr?.hasEncryptedApiKey?.(String(providerId || '').trim()); } catch { return false; }
        },
        providerForModel: (modelId) => {
          try { return String(apiKeysMgr?.providerForModel?.(String(modelId || '').trim()) || ''); } catch { return ''; }
        }
      },
      tabsApi: {
        getActiveTab: () => { try { return (typeof getActiveTab === 'function') ? getActiveTab() : null; } catch { return null; } },
      }
    });
    return modelsMgr;
  }
 
 // Confirm Apply: per-provider max_tokens picker (no HTML changes required; DOM is injected)
 const CONFIRM_APPLY_TOKENS_WRAP_ID = 'confirmApplyTokensWrap';
 const CONFIRM_APPLY_TOKENS_LABEL_ID = 'confirmApplyTokensLabel';
 const CONFIRM_APPLY_TOKENS_INPUT_ID = 'confirmApplyTokensInput';
 const CONFIRM_APPLY_TOKENS_HINT_ID = 'confirmApplyTokensHint';

 const CONFIRM_APPLY_MAXTOKENS_LS_PREFIX = 'confirmApply.maxTokens.'; // +provider
 const CONFIRM_APPLY_MAXTOKENS_DEFAULT_OPENAI = 32768;
 const CONFIRM_APPLY_MAXTOKENS_DEFAULT_XAI = 8192;
 const CONFIRM_APPLY_MAXTOKENS_SOFT_MAX = 200000; // UI clamp only; API may reject higher

 function _clampConfirmApplyMaxTokens(n) {
   const v = Math.floor(Number(n));
   if (!Number.isFinite(v) || v <= 0) return 0;
   return Math.max(1, Math.min(CONFIRM_APPLY_MAXTOKENS_SOFT_MAX, v));
 }

 function _lsKeyForConfirmApplyMaxTokens(providerId) {
   const p = String(providerId || '').trim() || 'unknown';
   return `${CONFIRM_APPLY_MAXTOKENS_LS_PREFIX}${p}`;
 }

 function _readStoredConfirmApplyMaxTokens(providerId) {
   try {
     const raw = localStorage.getItem(_lsKeyForConfirmApplyMaxTokens(providerId));
     const v = _clampConfirmApplyMaxTokens(raw);
     return v > 0 ? v : 0;
   } catch {
     return 0;
   }
 }

 function _writeStoredConfirmApplyMaxTokens(providerId, n) {
   try {
     const v = _clampConfirmApplyMaxTokens(n);
     if (v > 0) localStorage.setItem(_lsKeyForConfirmApplyMaxTokens(providerId), String(v));
   } catch { }
 }

 function _defaultConfirmApplyMaxTokensForProvider(providerId) {
   const p = String(providerId || '').trim();
   const stored = _readStoredConfirmApplyMaxTokens(p);
   if (stored > 0) return stored;
   if (p === 'openai') return CONFIRM_APPLY_MAXTOKENS_DEFAULT_OPENAI;
   if (p === 'xai') return CONFIRM_APPLY_MAXTOKENS_DEFAULT_XAI;
   return CONFIRM_APPLY_MAXTOKENS_DEFAULT_XAI; // fallback
 }

 function _ensureConfirmApplyTokensUi() {
   const overlay = document.getElementById('confirmApplyOverlay');
   const bodyEl = document.getElementById('confirmApplyBody');
   if (!overlay || !bodyEl) return null;

   let wrap = document.getElementById(CONFIRM_APPLY_TOKENS_WRAP_ID);
   if (wrap) return wrap;

   wrap = document.createElement('div');
   wrap.id = CONFIRM_APPLY_TOKENS_WRAP_ID;
   wrap.className = 'confirm-apply-tokens';

   const lbl = document.createElement('label');
   lbl.id = CONFIRM_APPLY_TOKENS_LABEL_ID;
   lbl.className = 'confirm-apply-tokens__label';
   lbl.setAttribute('for', CONFIRM_APPLY_TOKENS_INPUT_ID);
   lbl.textContent = 'Max tokens';

   const input = document.createElement('input');
   input.id = CONFIRM_APPLY_TOKENS_INPUT_ID;
   input.className = 'confirm-apply-tokens__input';
   input.type = 'number';
   input.inputMode = 'numeric';
   input.min = '1';
   input.step = '256';
   input.autocomplete = 'off';
   input.spellcheck = false;

   const hint = document.createElement('div');
   hint.id = CONFIRM_APPLY_TOKENS_HINT_ID;
   hint.className = 'confirm-apply-tokens__hint';
   hint.textContent = '';

   wrap.appendChild(lbl);
   wrap.appendChild(input);
   wrap.appendChild(hint);

   // Insert directly after the body line (no HTML edits required)
   try { bodyEl.insertAdjacentElement('afterend', wrap); } catch { bodyEl.parentElement?.appendChild?.(wrap); }

   // Enter in the input should behave like OK
   input.addEventListener('keydown', (e) => {
     if (e.key !== 'Enter') return;
     e.preventDefault();
     try { document.getElementById('confirmApplyOkBtn')?.click?.(); } catch { }
   });

   // Soft sanitize while typing (don’t block user; just keep it numeric)
   input.addEventListener('input', () => {
     const v = _clampConfirmApplyMaxTokens(input.value);
     if (v > 0 && String(v) !== String(input.value || '').trim()) {
       input.value = String(v);
     }
   });

   return wrap;
 }

 function _readConfirmApplyMaxTokensFromDom() {
   const input = document.getElementById(CONFIRM_APPLY_TOKENS_INPUT_ID);
   const v = _clampConfirmApplyMaxTokens(input?.value);
   return v > 0 ? v : 0;
 }

 function _setConfirmApplyMaxTokensInDom(n) {
   const input = document.getElementById(CONFIRM_APPLY_TOKENS_INPUT_ID);
   if (!input) return;
   const v = _clampConfirmApplyMaxTokens(n);
   if (v > 0) input.value = String(v);
 }

 function _applyConfirmApplyTokensUi({ providerId, tabId } = {}) {
   _ensureConfirmApplyTokensUi();
   const p = String(providerId || '').trim() || 'xai';
   const tId = String(tabId || '').trim();
   // Prefer per-tab maxTokens if present; else provider default (possibly stored)
   let tabTokens = 0;
   try {
     if (tId && Array.isArray(tabs)) {
       const tab = tabs.find(tt => String(tt?.id || '') === tId);
       tabTokens = _clampConfirmApplyMaxTokens(tab?.maxTokens);
     }
   } catch { }
   // New priority: manifest max_tokens > per-tab > stored provider > hardcoded default
   let def = tabTokens;
   if (def <= 0) {
     const modelSel = document.getElementById('modelSelect');
     const modelId = String(modelSel?.value || '').trim();
     const manifestMax = initModelsManagerOnce()?.manifestMaxTokensForModel?.(modelId);
     if (manifestMax > 0) {
       def = manifestMax;
     } else {
       def = _defaultConfirmApplyMaxTokensForProvider(p);
     }
   }
   _setConfirmApplyMaxTokensInDom(def);
   const lbl = document.getElementById(CONFIRM_APPLY_TOKENS_LABEL_ID);
   const hint = document.getElementById(CONFIRM_APPLY_TOKENS_HINT_ID);
   if (lbl) lbl.textContent = t('confirmApply.maxTokensLabel', 'Max tokens');
   if (hint) {
     // Updated hint: show model's manifest max_tokens if available (very large for Grok)
     const modelSel = document.getElementById('modelSelect');
     const modelId = String(modelSel?.value || '').trim();
     const manifestMax = initModelsManagerOnce()?.manifestMaxTokensForModel?.(modelId);
     const provLabel = p === 'openai' ? 'OpenAI' : p === 'xai' ? 'xAI' : p;
     if (manifestMax > 0) {
       hint.textContent = tFmt(
         'confirmApply.maxTokensHintModelFmt',
         { provider: provLabel, modelMax: manifestMax },
         `Model allows up to ${manifestMax} output tokens (${provLabel})`
       );
     } else {
       const dOpenAi = CONFIRM_APPLY_MAXTOKENS_DEFAULT_OPENAI;
       const dXai = CONFIRM_APPLY_MAXTOKENS_DEFAULT_XAI;
       hint.textContent = tFmt(
         'confirmApply.maxTokensHintFmt',
         { provider: provLabel, defOpenai: dOpenAi, defXai: dXai },
         `Default for ${provLabel}. (OpenAI: ${dOpenAi}, xAI: ${dXai})`
       );
     }
   }
 }

// -------------------------
// Resume pending Apply/Retry after PIN unlock / API key save
// -------------------------
let _pendingModelActionAfterApiReady = null; // 'applyBtn' | 'retryBtn'
let _lastModelActionBtnId = null;           // last clicked model action button id
let _apiReadyResumeWired = false;

function _wireApiReadyResumeOnce() {
  if (_apiReadyResumeWired) return;
  _apiReadyResumeWired = true;

  // Track last model-triggering button the user clicked.
  // (Capture so it runs even when other handlers stop propagation, e.g. confirm modal.)
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    const id = String(btn?.id || '');
    if (id === 'applyBtn' || id === 'retryBtn') _lastModelActionBtnId = id;
  }, true);

  // When apikeys.js signals that keys are ready (unlock/save), resume the pending action.
  window.addEventListener('apikeys:ready', () => {
    const id = _pendingModelActionAfterApiReady;
    if (!id) return;

    const btn = document.getElementById(id);
    if (!btn || btn.disabled) {
      _pendingModelActionAfterApiReady = null;
      return;
    }

    _pendingModelActionAfterApiReady = null;

    // User already confirmed before entering PIN; skip the confirmation modal on resume.
    if (id === 'applyBtn') _confirmApplyBypass = true;

    // Let the PIN modal close paint first, then re-trigger.
    setTimeout(() => {
      try { btn.click(); } catch { }
    }, 0);
  });
}

function _wrapEnsureKeyOrPromptForResume(apiMgr) {
  if (!apiMgr || apiMgr.__resumeEnsureWrapped) return;
  apiMgr.__resumeEnsureWrapped = true;

  const orig = apiMgr.ensureKeyOrPrompt;
  if (typeof orig !== 'function') return;

  apiMgr.ensureKeyOrPrompt = async (opts = {}) => {
    const ok = await orig(opts);
    if (ok) return true;

    // A modal was opened (unlock/setup). Remember what to resume after apikeys:ready.
    _pendingModelActionAfterApiReady = _lastModelActionBtnId || 'applyBtn';
    return false;
  };
}

// Wire resume logic immediately (safe even before DOMContentLoaded).
_wireApiReadyResumeOnce();

function setConfirmApplyBodyWithHighlightedModel(bodyEl, modelName) {
  if (!bodyEl) return;
  const model = String(modelName || '').trim() || '?';

  // Ask i18n for a string that contains {model}, but we pass a TOKEN instead.
  // Then we replace that token with a styled <span> (no HTML needed in translations).
  let fmt = tFmt(
    'confirmApply.bodyFmt',
    { model: CONFIRM_APPLY_MODEL_TOKEN },
    `Confirm application of the patch using ${CONFIRM_APPLY_MODEL_TOKEN} model ?`
  );

  fmt = String(fmt || '');
  if (!fmt.includes(CONFIRM_APPLY_MODEL_TOKEN)) {
    // Safety fallback if a translation omits {model}
    fmt = `Confirm application of the patch using ${CONFIRM_APPLY_MODEL_TOKEN} model ?`;
  }

  const parts = fmt.split(CONFIRM_APPLY_MODEL_TOKEN);
  bodyEl.replaceChildren();

  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) bodyEl.appendChild(document.createTextNode(parts[i]));
    if (i < parts.length - 1) {
      const span = document.createElement('span');
      span.className = 'confirm-model';
      span.textContent = model;
      bodyEl.appendChild(span);
    }
  }
}

function applyI18nToConfirmApplyModal(modelName) {
  const title = document.getElementById('confirmApplyTitle');
  const body = document.getElementById('confirmApplyBody');
  const okBtn = document.getElementById('confirmApplyOkBtn');
  const cancelBtn = document.getElementById('confirmApplyCancelBtn');

  const overlay = document.getElementById('confirmApplyOverlay');
  const model = String(
    modelName ||
    overlay?.dataset?.modelName ||
    document.getElementById('modelSelect')?.value ||
    ''
  ).trim();
  const providerId = initModelsManagerOnce()?.providerForModelId?.(model);

  if (title) title.textContent = t('confirmApply.title', 'Confirm Patch Application');
  if (body) setConfirmApplyBodyWithHighlightedModel(body, model);
  if (okBtn) okBtn.textContent = t('confirmApply.ok', 'OK');
  if (cancelBtn) cancelBtn.textContent = t('confirmApply.cancel', 'Cancel');

  // Ensure tokens input exists + is localized + has sensible default
  try {
    overlay.dataset.providerId = providerId;
    _applyConfirmApplyTokensUi({ providerId, tabId: overlay?.dataset?.tabId });
  } catch { }
}

function openConfirmApplyModal({ modelName, onOk, tabId } = {}) {
  const overlay = document.getElementById('confirmApplyOverlay');
  if (!overlay) return;

  _confirmApplyOnOk = (typeof onOk === 'function') ? onOk : null;
  overlay.dataset.modelName = String(modelName || '').trim();
  overlay.dataset.tabId = String(tabId || activeTabId || '').trim();
  overlay.dataset.providerId = initModelsManagerOnce()?.providerForModelId?.(overlay.dataset.modelName);
  applyI18nToConfirmApplyModal(modelName);

  overlayMgr.open('confirmApplyOverlay');
  setTimeout(() => {
    try { document.getElementById(CONFIRM_APPLY_TOKENS_INPUT_ID)?.focus?.(); } catch { }
    try { document.getElementById(CONFIRM_APPLY_TOKENS_INPUT_ID)?.select?.(); } catch { }
  }, 0);
}

function closeConfirmApplyModal({ force = false } = {}) {
  overlayMgr.close('confirmApplyOverlay', { force });
}

function wireConfirmApplyModalOnce() {
  if (_confirmApplyWired) return;
  _confirmApplyWired = true;

  const overlay = document.getElementById('confirmApplyOverlay');
  const closeBtn = document.getElementById('confirmApplyCloseBtn');
  const okBtn = document.getElementById('confirmApplyOkBtn');
  const cancelBtn = document.getElementById('confirmApplyCancelBtn');
  const applyBtn = document.getElementById('applyBtn');

  if (closeBtn) closeBtn.addEventListener('click', () => closeConfirmApplyModal());
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeConfirmApplyModal());
  if (okBtn) okBtn.addEventListener('click', () => {
    const cb = _confirmApplyOnOk;
    const overlayNow = document.getElementById('confirmApplyOverlay');
    const providerId = String(overlayNow?.dataset?.providerId || '').trim()
      || initModelsManagerOnce()?.providerForModelId?.(overlayNow?.dataset?.modelName);
    const tabId = String(overlayNow?.dataset?.tabId || '').trim();

    // Read + persist chosen max_tokens (per provider) and attach to originating tab
    let maxTokens = _readConfirmApplyMaxTokensFromDom();
    if (!maxTokens) maxTokens = _defaultConfirmApplyMaxTokensForProvider(providerId);
    maxTokens = _clampConfirmApplyMaxTokens(maxTokens) || _defaultConfirmApplyMaxTokensForProvider(providerId);

    try { _writeStoredConfirmApplyMaxTokens(providerId, maxTokens); } catch { }
    try {
      if (tabId && Array.isArray(tabs)) {
        const tab = tabs.find(tt => String(tt?.id || '') === tabId);
        if (tab) tab.maxTokens = maxTokens;
      }
    } catch { }

    closeConfirmApplyModal({ force: true });
    try { cb?.({ maxTokens, providerId, tabId }); } catch { }
  });

  // Intercept Apply Patch click (capture), show confirmation modal,
  // then re-trigger click once user confirms (bypass flag avoids recursion).
  if (applyBtn && applyBtn.dataset.confirmApplyWired !== '1') {
    applyBtn.dataset.confirmApplyWired = '1';
    applyBtn.addEventListener('click', (e) => {
      if (_confirmApplyBypass) { _confirmApplyBypass = false; return; }
      if (applyBtn.disabled) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const modelSel = document.getElementById('modelSelect');
      const modelName = String(modelSel?.value || '').trim();
      const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;

      openConfirmApplyModal({
        modelName,
        tabId: tab?.id,
        onOk: () => {
          _confirmApplyBypass = true;
          try { applyBtn.click(); } catch { }
        }
      });
    }, true);
  }
}

function openPinChangeModal() {
  const overlay = document.getElementById('pinChangeOverlay');
  if (!overlay) return;
  applyI18nToPinChangeModal();

  const hint = document.getElementById('pinChangeHint');
  _clearPinBoxesIn('pinChangeOldPinBoxes', 'pinChangeOldPin', 0);
  _clearPinBoxesIn('pinChangeNewPinBoxes', 'pinChangeNewPin', 0);
  _clearPinBoxesIn('pinChangeConfirmPinBoxes', 'pinChangeConfirmPin', 0);

  overlayMgr.open('pinChangeOverlay');
  setTimeout(() => { try { _focusPinBoxIn('pinChangeOldPinBoxes', 0); } catch { } }, 0);
}

function closePinChangeModal({ force = false } = {}) {
  overlayMgr.close('pinChangeOverlay', { force });
}

async function _doPinChange() {
  const hint = document.getElementById('pinChangeHint');
  const oldPin = _readPinFromBoxes('pinChangeOldPinBoxes');
  const newPin = _readPinFromBoxes('pinChangeNewPinBoxes');
  const cfmPin = _readPinFromBoxes('pinChangeConfirmPinBoxes');

  if (hint) hint.textContent = '';

  const isValid = (p) => /^\d{6}$/.test(String(p || '').trim());
  if (!isValid(oldPin) || !isValid(newPin) || !isValid(cfmPin)) {
    if (hint) hint.textContent = t('pinChange.pinInvalid', 'Enter 6 digits.');
    return;
  }
  if (newPin !== cfmPin) {
    if (hint) hint.textContent = t('pinChange.pinsDontMatch', 'New PIN and confirmation do not match.');
    return;
  }

  const api = initApiKeysManagerOnce();
  if (!api?.hasAnyEncryptedApiKey?.()) {
    if (hint) hint.textContent = t('pinChange.noKeys', 'No saved API keys found to re-encrypt.');
    return;
  }

  const res = await api.changePin({ oldPin, newPin });
  if (!res?.ok) {
    const reason = String(res?.reason || '');
    if (reason === 'no_keys') {
      if (hint) hint.textContent = t('pinChange.noKeys', 'No saved API keys found to re-encrypt.');
    } else if (reason === 'decrypt_failed') {
      if (hint) hint.textContent = t('pinChange.decryptFailed', 'Old PIN is incorrect (or stored data is corrupted).');
    } else if (reason === 'reencrypt_failed') {
      if (hint) hint.textContent = t('pinChange.reencryptFailed', 'Failed to re-encrypt and save keys.');
    } else {
      if (hint) hint.textContent = t('pinChange.reencryptFailed', 'Failed to re-encrypt and save keys.');
    }
    return;
  }

  closePinChangeModal({ force: true });
}

function openCleanResetModal() {
  const overlay = document.getElementById('cleanResetOverlay');
  if (!overlay) return;
  applyI18nToCleanResetModal();
  const hint = document.getElementById('cleanResetHint');
  if (hint) hint.textContent = '';
  overlayMgr.open('cleanResetOverlay');
  setTimeout(() => { try { document.getElementById('cleanResetConfirmBtn')?.focus(); } catch { } }, 0);
}

function closeCleanResetModal({ force = false } = {}) {
  overlayMgr.close('cleanResetOverlay', { force });
}

async function _doCleanReset() {
  const hint = document.getElementById('cleanResetHint');
  const okBtn = document.getElementById('cleanResetConfirmBtn');
  const cancelBtn = document.getElementById('cleanResetCancelBtn');

  if (hint) hint.textContent = '';
  if (okBtn) okBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (hint) hint.textContent = t('cleanReset.inProgress', 'Resetting…');

  try {
    // 1) Ask main to delete ui_language.json and reset menu/theme
    try { await ipcRenderer.invoke('app:cleanReset'); } catch { }

    // 2) Clear renderer storage
    try { localStorage.clear(); } catch { }
    try { sessionStorage?.clear?.(); } catch { }

    // 3) Reload to a clean boot (language gate will show again)
    window.location.reload();
  } catch {
    if (hint) hint.textContent = t('cleanReset.failed', 'Reset failed. Please try again.');
    if (okBtn) okBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

let _pinResetWired = false;
function wirePinChangeAndResetModalsOnce() {
  if (_pinResetWired) return;
  _pinResetWired = true;

  // Menu events from main process
  try {
    ipcRenderer.on('pinchange:open', () => openPinChangeModal());
    ipcRenderer.on('cleanreset:open', () => openCleanResetModal());
  } catch { }

  // PIN Change modal wiring
  const pinOverlay = document.getElementById('pinChangeOverlay');
  const pinClose = document.getElementById('pinChangeCloseBtn');
  const pinCancel = document.getElementById('pinChangeCancelBtn');
  const pinApply = document.getElementById('pinChangeApplyBtn');
  if (pinClose) pinClose.addEventListener('click', () => closePinChangeModal());
  if (pinCancel) pinCancel.addEventListener('click', () => closePinChangeModal());
  if (pinApply) pinApply.addEventListener('click', () => { void _doPinChange(); });

  // Wire the 3x six-box PIN inputs (auto-forward/backspace/paste)
  _wireSixDigitBoxes({
    wrapId: 'pinChangeOldPinBoxes',
    hiddenId: 'pinChangeOldPin',
    onComplete: () => _focusPinBoxIn('pinChangeNewPinBoxes', 0)
  });
  _wireSixDigitBoxes({
    wrapId: 'pinChangeNewPinBoxes',
    hiddenId: 'pinChangeNewPin',
    onComplete: () => _focusPinBoxIn('pinChangeConfirmPinBoxes', 0)
  });
  _wireSixDigitBoxes({
    wrapId: 'pinChangeConfirmPinBoxes',
    hiddenId: 'pinChangeConfirmPin',
    onComplete: () => { try { document.getElementById('pinChangeApplyBtn')?.focus?.(); } catch { } }
  });

  // Clean Reset modal wiring
  const rsOverlay = document.getElementById('cleanResetOverlay');
  const rsClose = document.getElementById('cleanResetCloseBtn');
  const rsCancel = document.getElementById('cleanResetCancelBtn');
  const rsOk = document.getElementById('cleanResetConfirmBtn');
  if (rsClose) rsClose.addEventListener('click', () => closeCleanResetModal());
  if (rsCancel) rsCancel.addEventListener('click', () => closeCleanResetModal());
  if (rsOk) rsOk.addEventListener('click', () => { void _doCleanReset(); });

}

// Ensure wiring happens even if this file is loaded at end of body
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wirePinChangeAndResetModalsOnce, { once: true });
} else {
  wirePinChangeAndResetModalsOnce();
}

// Confirm Apply modal wiring
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireConfirmApplyModalOnce, { once: true });
} else {
  wireConfirmApplyModalOnce();
}

// -------------------------
// Cancel API Call modal + in-flight elapsed timer + icon buttons
// -------------------------
const ICON_SVG_PROMPT = `<svg viewBox="0 0 24 24"><path d="M4 20h16"/><path d="M7 17l4-4"/><path d="M9 7l8 8"/><path d="M14 4l6 6"/></svg>`;
const ICON_SVG_CANCEL = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>`;
const ICON_SVG_APPLY = `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`;

function ensureIconButtonStructure(btn, svgHtml, fallbackLabel = '') {
  if (!btn) return;
  const hasLbl = !!btn.querySelector?.('.btn-label');
  const hasIco = !!btn.querySelector?.('.btn-ico');
  if (hasLbl && hasIco) return;

  const existing = String(btn.textContent || '').trim() || String(fallbackLabel || '').trim();
  btn.replaceChildren();

  const ico = document.createElement('span');
  ico.className = 'btn-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.innerHTML = svgHtml || '';

  const lbl = document.createElement('span');
  lbl.className = 'btn-label';
  lbl.textContent = existing;

  btn.appendChild(ico);
  btn.appendChild(lbl);
}

let _loadingElapsedTimer = null;
let _loadingElapsedTabId = null;

function _fmtMmSs(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return `${mm}:${ss}`;
}

function stopLoadingElapsedTimer({ clear = false } = {}) {
  if (_loadingElapsedTimer) {
    try { clearInterval(_loadingElapsedTimer); } catch { }
    _loadingElapsedTimer = null;
  }
  _loadingElapsedTabId = null;
  const el = document.getElementById('loadingElapsed');
  if (el) {
    if (clear) el.textContent = '00:00';
    el.classList.add('hidden');
  }
}

function startLoadingElapsedTimerForTab(tab) {
  const el = document.getElementById('loadingElapsed');
  if (!el || !tab) return;
  if (!tab.inFlight) { stopLoadingElapsedTimer(); return; }

  // only render timer for the ACTIVE tab
  if (String(activeTabId || '') !== String(tab.id || '')) return;

  // ensure start time exists
  if (!Number.isFinite(tab.inFlightStartMs)) tab.inFlightStartMs = _nowMs();

  stopLoadingElapsedTimer({ clear: true });
  _loadingElapsedTabId = tab.id;
  el.classList.remove('hidden');

  const tick = () => {
    const curTab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
    if (!curTab || !curTab.inFlight || curTab.id !== _loadingElapsedTabId) {
      stopLoadingElapsedTimer();
      return;
    }
    el.textContent = _fmtMmSs(_nowMs() - (curTab.inFlightStartMs || 0));
  };

  tick();
  _loadingElapsedTimer = setInterval(tick, 250);
}

function syncInFlightUiForActiveTab() {
  const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
  const loadingEl = document.getElementById('loading');
  const applyBtn = document.getElementById('applyBtn');
  const cancelBtn = document.getElementById('cancelBtn');

  // Keep icons intact even if something set textContent
  try { applyI18nToModelActionButtons(); } catch { }

  if (!tab || !loadingEl || !applyBtn || !cancelBtn) return;

  const inFlight = !!tab.inFlight;

  loadingEl.classList.toggle('hidden', !inFlight);
  applyBtn.disabled = inFlight;
  cancelBtn.disabled = !inFlight;

  if (inFlight) startLoadingElapsedTimerForTab(tab);
  else stopLoadingElapsedTimer({ clear: true });
}

function _isAbortError(err) {
  const n = String(err?.name || '');
  if (n === 'AbortError') return true;
  const c = err?.cause;
  if (String(c?.name || '') === 'AbortError') return true;
  const msg = String(err?.message || '').toLowerCase();
  const cmsg = String(c?.message || '').toLowerCase();
  if (msg.includes('aborted') || msg.includes('abort')) return true;
  if (cmsg.includes('aborted') || cmsg.includes('abort')) return true;
  return false;
}

function _cancelTabRequestBySnapshot({ tabId, token } = {}) {
  const id = String(tabId || '').trim();
  const tok = String(token || '').trim();
  if (!id || !tok) return false;
  const tab = Array.isArray(tabs) ? tabs.find(t => String(t?.id || '') === id) : null;
  if (!tab || !tab.inFlight || String(tab.inFlightToken || '') !== tok) return false;

  tab.cancelRequested = true;
  const ctrl = tab.abortCtrl;
  const ctrlTok = String(tab.abortToken || '');
  if (ctrl && ctrlTok === tok) {
    try { ctrl.abort(); } catch { }
    return true;
  }
  return false;
}

let _cancelApiWired = false;
function applyI18nToCancelApiModal() {
  const title = document.getElementById('cancelApiTitle');
  const body = document.getElementById('cancelApiBody');
  const yesBtn = document.getElementById('cancelApiYesBtn');
  const noBtn = document.getElementById('cancelApiNoBtn');

  if (title) title.textContent = t('cancelApi.title', 'Cancel API call');
  if (body) body.textContent = t('cancelApi.body', 'Cancel the API call ?');
  if (yesBtn) yesBtn.textContent = t('cancelApi.yes', 'Yes');
  if (noBtn) noBtn.textContent = t('cancelApi.no', 'No');
}

function openCancelApiModal() {
  const overlay = document.getElementById('cancelApiOverlay');
  if (!overlay) return;
  const tab = (typeof getActiveTab === 'function') ? getActiveTab() : null;
  if (!tab || !tab.inFlight || !tab.inFlightToken) return;

  overlay.dataset.tabId = String(tab.id || '');
  overlay.dataset.token = String(tab.inFlightToken || '');
  applyI18nToCancelApiModal();

  overlayMgr.open('cancelApiOverlay');
  setTimeout(() => { try { document.getElementById('cancelApiNoBtn')?.focus?.(); } catch { } }, 0);
}

function closeCancelApiModal({ force = false } = {}) {
  overlayMgr.close('cancelApiOverlay', { force });
}

function wireCancelApiModalOnce() {
  if (_cancelApiWired) return;
  _cancelApiWired = true;

  const overlay = document.getElementById('cancelApiOverlay');
  const closeBtn = document.getElementById('cancelApiCloseBtn');
  const yesBtn = document.getElementById('cancelApiYesBtn');
  const noBtn = document.getElementById('cancelApiNoBtn');

  if (closeBtn) closeBtn.addEventListener('click', () => closeCancelApiModal());
  if (noBtn) noBtn.addEventListener('click', () => closeCancelApiModal());
  if (yesBtn) yesBtn.addEventListener('click', () => {
    const tabId = overlay?.dataset?.tabId;
    const token = overlay?.dataset?.token;
    closeCancelApiModal({ force: true });
    try { _cancelTabRequestBySnapshot({ tabId, token }); } catch { }
  });
}

function applyI18nToModelActionButtons() {
  const sysBtn = document.getElementById('sysPromptBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const applyBtn = document.getElementById('applyBtn');

  // Rebuild icon structure if any other i18n code set textContent and wiped children
  if (sysBtn) ensureIconButtonStructure(sysBtn, ICON_SVG_PROMPT, 'Prompt');
  if (cancelBtn) ensureIconButtonStructure(cancelBtn, ICON_SVG_CANCEL, 'Cancel');
  if (applyBtn) ensureIconButtonStructure(applyBtn, ICON_SVG_APPLY, 'Apply Patch');

  if (cancelBtn) {
    const lbl = t('cancelApi.button', 'Cancel');
    setButtonLabelText(cancelBtn, lbl);
  }
}

// Ensure cancel modal wiring happens even if this file is loaded at end of body
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCancelApiModalOnce, { once: true });
} else {
  wireCancelApiModalOnce();
}

const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 5;  // Warn if larger; adjust based on API limits
let originalFileName = 'file.txt';  // Default for pasted content
let isApiKeyEditable = true;

// -------------------------
// UI Language (i18n) - Renderer (modularized)
// -------------------------
const i18nMgr = createI18nManager({
  ipcRenderer,
  window,
  document,
  storage: localStorage,
  hooks: {
    beforeChange: closeAllModalsForLanguageChange,
    afterChange: refreshUiAfterLanguageChange
  },
  modal: {
    overlayId: 'languageOverlay',
    buttonsWrapId: 'languageButtons',
    closeBtnId: 'languageCloseBtn',
    // Used only to decide when to remove body.modal-open
    otherOverlayIds: [
      'helpOverlay',
      'apiKeyOverlay',
      'keyTypeOverlay',
      'tabRenameOverlay',
      'tabCloseOverlay',
      'sysPromptOverlay',
      'aboutOverlay',
      'historyOverlay',
      'pinChangeOverlay',
      'cleanResetOverlay',
      'confirmApplyOverlay',
      'versionOverlay'
    ]
  }
});

const {
  t,
  tFmt,
  initI18n,
  applyI18nToStaticUi,
  setLanguage,
  isLanguageModalOpen,
  openLanguageModal,
  closeLanguageModal,
} = i18nMgr;

// -------------------------
// System prompts: extracted manager (./systemPrompts.js)
// -------------------------
function initSystemPromptsManagerOnce() {
  if (systemPromptsMgr) return systemPromptsMgr;
  systemPromptsMgr = createSystemPromptsManager({
    window,
    document,
    storage: localStorage,
    t,
    tFmt,
    overlayMgr,
    tabs: {
      getActiveTab: () => { try { return (typeof getActiveTab === 'function') ? getActiveTab() : null; } catch { return null; } },
      getTabById: (id) => {
        try {
          const wanted = String(id || '').trim();
          if (!wanted || !Array.isArray(tabs)) return null;
          return tabs.find(tt => String(tt?.id || '') === wanted) || null;
        } catch { return null; }
      },
      getAllTabs: () => { try { return Array.isArray(tabs) ? tabs : []; } catch { return []; } },
      updateTabRowFor: (tab) => { try { if (typeof updateTabRowFor === 'function') return updateTabRowFor(tab); } catch { } }
    }
  });
  return systemPromptsMgr;
}


// ---- Back-compat helpers (applyPatch/history still call these) ----
function getSystemPromptById(id) {
  try { return initSystemPromptsManagerOnce()?.getSystemPromptById?.(id); } catch { return null; }
}

const DEFAULT_SYSTEM_PROMPT = (() => {
  try {
    const p = getSystemPromptById(DEFAULT_SYS_PROMPT_ID);
    return String(p?.content || '');
  } catch {
    return '';
  }
})();
// -------------------------
// Right-click menu for Diff + File Content textareas (only #diff and #model)
// Native menu is built in main via IPC; roles keep Paste working reliably.
// -------------------------
let _rightClickMenuWired = false;
function wireRightClickMenuOnce() {
  if (_rightClickMenuWired) return;
  _rightClickMenuWired = true;

  document.addEventListener('contextmenu', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'TEXTAREA') return;
    const id = String(el.id || '');
    if (id !== 'diff' && id !== 'model') return;

    // Replace default Chromium menu with our minimal menu.
    e.preventDefault();
    e.stopPropagation();
    try { e.stopImmediatePropagation(); } catch { }

    try { el.focus(); } catch { }

    const readOnly = !!(el.readOnly || el.disabled);
    const value = String(el.value || '');
    const hasText = value.length > 0;
    const selStart = Number.isFinite(el.selectionStart) ? el.selectionStart : 0;
    const selEnd = Number.isFinite(el.selectionEnd) ? el.selectionEnd : 0;
    const hasSelection = Math.abs(selEnd - selStart) > 0;

    let clip = '';
    try { clip = String(clipboard.readText() || ''); } catch { clip = ''; }

    const can = {
      selectAll: hasText,
      copy: hasSelection,
      paste: !readOnly && clip.length > 0,
      delete: !readOnly && (hasSelection || selStart < value.length)
    };

    const labels = {
      selectAll: t('rightClickMenu.selectAll', 'Select All'),
      copy: t('rightClickMenu.copy', 'Copy'),
      paste: t('rightClickMenu.paste', 'Paste'),
      delete: t('rightClickMenu.delete', 'Delete')
    };

    try {
      ipcRenderer.send('rightClickMenu:show', { x: e.x, y: e.y, can, labels });
    } catch { }
  }, true); // capture: beats any global preventDefault handlers
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireRightClickMenuOnce, { once: true });
} else {
  wireRightClickMenuOnce();
}

// -----------------
// Version check + update modal (GitHub Releases)
// -------------------------
versionMgr = createVersionManager({
  window,
  document,
  ipcRenderer,
  t,
  tFmt,
  externalOpen: (url) => { try { ipcRenderer.send('external:open', url); } catch { } },
  syncBodyModalOpen: () => { try { overlayMgr.syncBodyClass(); } catch { } },
  modal: {
    overlayId: 'versionOverlay',
    closeBtnId: 'versionCloseBtn',
    downloadBtnId: 'versionDownloadBtn',
    laterBtnId: 'versionLaterBtn',
    titleId: 'versionTitle',
    introId: 'versionIntro',
    currentLabelId: 'versionCurrentLabel',
    currentValueId: 'versionCurrentValue',
    latestLabelId: 'versionLatestLabel',
    latestValueId: 'versionLatestValue',
    notesWrapId: 'versionNotesWrap',
    notesTitleId: 'versionNotesTitle',
    notesTextId: 'versionNotes',
    hintId: 'versionHint'
  }
});

// -------------------------
// Boot language gate: ensure language is chosen before initializing the rest of the app
// -------------------------
async function bootLanguageGate() {
  // Decide clean-start using MAIN's persisted file, not renderer localStorage.
  let configured = true;
  try { configured = await ipcRenderer.invoke('language:isConfigured'); } catch { }

  await initI18n();
  applyI18nToStaticUi();

  // Only check for updates on startup if language was already configured
  // (If language selection gate is shown on a clean slate start, do NOT check.)
  if (configured) {
    try { void versionMgr?.checkAtStartup?.(); } catch { }
  }

  if (!configured) {
    await new Promise((resolve) => {
      openLanguageModal({
        force: true,
        closeOnSelect: true,
        onSelected: () => resolve()
      });
    });

    // After user selects, i18n already applied by setLanguage().
    // But static UI might have been drawn once; apply again to be safe.
    applyI18nToStaticUi();
  }
}

// -------------------------
// App settings (from main)
// -------------------------
const DEFAULT_APP_SETTINGS = Object.freeze({ historyMax: 100, historyPageSize: 5 });
let appSettings = { ...DEFAULT_APP_SETTINGS };
let appSettingsLoaded = false;

async function ensureAppSettingsLoaded() {
  if (appSettingsLoaded) return appSettings;
  try {
    const s = await ipcRenderer.invoke('app:getSettings');
    if (s && typeof s === 'object') {
      appSettings = {
        ...appSettings,
        historyMax: Number.isFinite(Number(s.historyMax)) ? Number(s.historyMax) : appSettings.historyMax,
        historyPageSize: Number.isFinite(Number(s.historyPageSize)) ? Number(s.historyPageSize) : appSettings.historyPageSize
      };
    }
  } catch { }
  appSettingsLoaded = true;
  return appSettings;
}

// -------------------------
// History: extracted manager (./history.js)
// -------------------------
let historyMgr = null;
function initHistoryManagerOnce() {
  if (historyMgr) return historyMgr;
  const sp = initSystemPromptsManagerOnce();
  historyMgr = createHistoryManager({
    window,
    document,
    storage: localStorage,
    t,
    tFmt,
    ipcRenderer,
    saveZipToDisk: async ({ filename, buffer } = {}) => {
      const nm = String(filename || 'AI-Diff-History.zip');
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
      const data_b64 = buf.toString('base64');
      try {
        return await ipcRenderer.invoke('history:saveZip', { filename: nm, data_b64 });
      } catch {
        return { ok: false, reason: 'ipc_failed' };
      }
    },
    ensureAppSettingsLoaded,
    DEFAULT_SYS_PROMPT_ID,
    getSystemPromptById: (...args) => sp.getSystemPromptById(...args),
    ensureSystemPromptStore: (...args) => sp.ensureSystemPromptStore(...args),
    doesSystemPromptExist: (...args) => sp.doesSystemPromptExist(...args),
    buildDiffHtml,
    sanitizeModel: (m) => initModelsManagerOnce()?.coerceModelToEnabled?.(m),
    tabs: {
      initTabsManagerOnce: () => initTabsManagerOnce(),
      makeTab: (...args) => makeTab(...args),
      addTabAndSelect: (...args) => addTabAndSelect(...args),
      ensureTabDiffDom: (...args) => ensureTabDiffDom(...args),
      getActiveTab: () => getActiveTab()
    },
    modal: {
      overlayId: 'historyOverlay',
      closeBtnId: 'historyCloseBtn',
      okBtnId: 'historyOkBtn',
      clearBtnId: 'historyClearBtn',
      prevBtnId: 'historyPrevBtn',
      nextBtnId: 'historyNextBtn',
      listId: 'historyList',
      hintId: 'historyHint',
      pageLabelId: 'historyPageLabel',
      otherOverlayIds: [
        'helpOverlay',
        'apiKeyOverlay',
        'keyTypeOverlay',
        'tabRenameOverlay',
        'tabCloseOverlay',
        'sysPromptOverlay',
        'aboutOverlay',
        'historyOverlay',
        'languageOverlay'
        , 'pinChangeOverlay'
        , 'cleanResetOverlay'
        , 'confirmApplyOverlay'
        , 'versionOverlay'
      ]
    }
  });
  return historyMgr;
}

function _sysNow() { return Date.now(); }

function syncDiff2HtmlTheme() {
  const wrap = document.querySelector('#diffView .d2h-wrapper');
  if (!wrap) return;
  const isDark = document.body.classList.contains('dark');
  wrap.classList.toggle('d2h-dark-color-scheme', isDark);
  wrap.classList.toggle('d2h-light-color-scheme', !isDark);
  wrap.classList.remove('d2h-auto-color-scheme');
}

// -------------------------
// Header app icon (bundled via extraResources)
// -------------------------
async function setAppHeaderIcon() {
  const img = document.getElementById('appIconImg');
  if (!img) return;

  try {
    const p = await ipcRenderer.invoke('app-icon-path');
    if (!p) return;
    img.src = pathToFileURL(p).href;
    img.classList.remove('hidden');
  } catch {
    // no-op
  }
}

// -------------------------
// Tabs: active highlight matches the "+" button color
// -------------------------
function _parseCssColorToRgbaParts(s) {
  const str = String(s || '').trim();
  const m = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!m) return null;
  const r = Math.max(0, Math.min(255, parseInt(m[1], 10)));
  const g = Math.max(0, Math.min(255, parseInt(m[2], 10)));
  const b = Math.max(0, Math.min(255, parseInt(m[3], 10)));
  const a = (m[4] == null) ? 1 : Math.max(0, Math.min(1, parseFloat(m[4])));
  return { r, g, b, a };
}

function _rgba({ r, g, b }, a) {
  const alpha = Math.max(0, Math.min(1, Number(a)));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function syncTabActiveHighlightFromNewTabButton() {
  const btn = document.getElementById('newTabBtn');
  if (!btn) return;

  const cs = window.getComputedStyle(btn);
  const bg = cs.backgroundColor;
  const fg = cs.color;
  const border =
    cs.borderTopColor ||
    cs.borderLeftColor ||
    cs.borderColor ||
    '';

  // Prefer a "real" background; if it's effectively transparent, fall back to the text color.
  const bgParts = _parseCssColorToRgbaParts(bg);
  const fgParts = _parseCssColorToRgbaParts(fg);
  const bdParts = _parseCssColorToRgbaParts(border);

  // We want the ACTIVE TAB background to match the "+" button background.
  // On some themes the "+" bg may compute as fully transparent; in that case,
  // prefer the button border color (and ONLY as a last resort use the text color).
  const hasRealBg = !!(bgParts && bgParts.a >= 0.04);
  const baseParts =
    hasRealBg ? bgParts :
      (bdParts && bdParts.a >= 0.04) ? bdParts :
        fgParts;
  if (!baseParts) return;

  const root = document.documentElement;

  // 1) Background: match actual "+" bg if it exists (preserve its alpha).
  //    Otherwise synthesize a subtle shade that is still visible.
  if (hasRealBg) {
    root.style.setProperty('--tab-active-bg', bg);
  } else {
    root.style.setProperty('--tab-active-bg', _rgba(baseParts, 0.16));
  }

  // 2) Border/indicator: slightly stronger than bg, still subtle in dark mode.
  //    If the "+" has a real border, use it directly.
  if (bdParts && bdParts.a >= 0.04) {
    root.style.setProperty('--tab-active-border', border);
  } else {
    root.style.setProperty('--tab-active-border', _rgba(baseParts, 0.22));
  }

  root.style.setProperty('--tab-active-accent', _rgba(baseParts, 0.70));
  root.style.setProperty('--tab-active-focus', _rgba(baseParts, 0.35));
}

// -------------------------
// Model timing (X mins and Y seconds)
// -------------------------
function _nowMs() {
  return (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return tFmt('output.timeFmt', { mins, secs }, `${mins} mins and ${secs} seconds`);
}

// -------------------------
// Token estimation (best-effort)
// - Uses API-reported usage when available
// - Falls back to a lightweight heuristic when usage is absent
// -------------------------
function estimateTokensForText(text) {
  const s = (text || '');
  if (!s) return 0;
  // Simple heuristic: ~4 chars per token (works reasonably for English/code mixed).
  return Math.max(1, Math.ceil(s.length / 4));
}

function estimateChatTokens(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  // Rough structural overhead per message (role/formatting). Not exact, but stable.
  const OVERHEAD_PER_MSG = 4;
  const FINAL_OVERHEAD = 2;
  let total = FINAL_OVERHEAD;
  for (const m of msgs) {
    total += OVERHEAD_PER_MSG;
    total += estimateTokensForText(m?.content || '');
  }
  return Math.max(0, total);
}

function getUsageTotalTokens(completion) {
  const u = completion?.usage;
  if (!u) return null;
  if (Number.isFinite(u.total_tokens)) return u.total_tokens;
  if (Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)) {
    return u.prompt_tokens + u.completion_tokens;
  }
  return null;
}

function setModelTimeUi(tab) {
  const el = document.getElementById('modelTime');
  if (!el) return;

  if (tab && Number.isFinite(tab.lastDurationMs)) {
    const parts = [formatDurationMs(tab.lastDurationMs)];
    if (Number.isFinite(tab.lastTokenCount)) {
      parts.push(tFmt('output.tokensEstFmt', { n: String(tab.lastTokenCount) }, `${tab.lastTokenCount} tokens [est.]`));
    }
    el.textContent = parts.join(t('output.separator', ' / '));
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

// -------------------------
// Textarea / Output expand-collapse (maximize / minimize)
// -------------------------
function ensureDefaultMetrics(el) {
  if (!el || !el.dataset) return;
  if (!el.dataset.taExpanded) el.dataset.taExpanded = '0';
}

function setExpandedButtonState(el) {
  if (!el) return;
  const wrap = el.closest('.ta-container');
  if (!wrap) return;
  const maxBtn = wrap.querySelector('button[data-ta-action="max"]');
  const minBtn = wrap.querySelector('button[data-ta-action="min"]');
  const expanded = el.dataset.taExpanded === '1';
  if (maxBtn) maxBtn.disabled = expanded;
  if (minBtn) minBtn.disabled = !expanded;
}

function maximizeElement(el) {
  if (!el) return;
  ensureDefaultMetrics(el);

  // Remember collapsed height for smooth minimize
  if (el.tagName === 'TEXTAREA') {
    el.dataset.taCollapsedH = `${el.getBoundingClientRect().height}`;
  }

  // CSP-safe: no inline styles, just CSS classes
  el.classList.add('ta-expanded');
  el.dataset.taExpanded = '1';
  setExpandedButtonState(el);

  // Fit to full content (and animate height because textarea has transition now)
  autoResizeIfExpanded(el);
}

function minimizeElement(el) {
  if (!el) return;
  ensureDefaultMetrics(el);

  // Smooth collapse for textarea: animate back to prior height, then clear inline height
  if (el.tagName === 'TEXTAREA') {
    const to = Number(el.dataset.taCollapsedH || 0);
    if (to > 0) {
      const from = el.getBoundingClientRect().height;
      el.style.overflowY = 'hidden';
      el.style.height = `${from}px`;
      el.offsetHeight; // force reflow so transition triggers
      el.style.height = `${to}px`;

      const onEnd = (ev) => {
        if (ev.propertyName !== 'height') return;
        el.removeEventListener('transitionend', onEnd);
        el.style.height = '';
        el.style.overflowY = '';
      };
      el.addEventListener('transitionend', onEnd);
    } else {
      el.style.height = '';
      el.style.overflowY = '';
    }
  }

  el.classList.remove('ta-expanded');
  el.dataset.taExpanded = '0';
  setExpandedButtonState(el);
}

function autoResizeIfExpanded(el) {
  if (!el) return;
  if (el.tagName !== 'TEXTAREA') return;
  if (!el.classList.contains('ta-expanded')) return;

  // Grow/shrink to fit content (old behavior: no inner scroll)
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';                 // allow shrink
  el.style.height = `${el.scrollHeight + 2}px`; // +2 avoids last-line clipping in Chromium sometimes
}

function initTextareaExpandCollapse() {
  // Prime defaults + initial button state
  ['#diff', '#model', '#output'].forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    ensureDefaultMetrics(el);
    if (!el.dataset.taExpanded) el.dataset.taExpanded = '0';
    setExpandedButtonState(el);
  });

  // Event delegation for all max/min buttons
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button[data-ta-action][data-ta-target]');
    if (!btn) return;
    const action = btn.getAttribute('data-ta-action');
    const targetSel = btn.getAttribute('data-ta-target');
    const el = targetSel ? document.querySelector(targetSel) : null;
    if (!el) return;
    if (action === 'max') maximizeElement(el);
    if (action === 'min') minimizeElement(el);
  });

  // Keep expanded textareas auto-fitting while user types/pastes
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el && el.tagName === 'TEXTAREA') autoResizeIfExpanded(el);
  });

  // Refit expanded ones on resize (font/viewport changes)
  window.addEventListener('resize', () => {
    ['#diff', '#model'].forEach((sel) => autoResizeIfExpanded(document.querySelector(sel)));
  });
}

// -------------------------
// Sticky output actions (max/min/copy)
// Stick under header when output container top scrolls out of view,
// hide when output container is fully out of view.
// -------------------------
function initStickyTaActions() {
  const root = getMainScrollEl();
  if (!root) return;

  // All ta-containers that have a direct .ta-actions child
  const containers = Array.from(root.querySelectorAll('.ta-container'))
    .map((wrap) => {
      const actions = wrap.querySelector(':scope > .ta-actions');
      return actions ? { wrap, actions } : null;
    })
    .filter(Boolean);

  if (!containers.length) return;

  const MARGIN = 6;      // same “breathing room” you used
  const MIN_VISIBLE = 44;

  const update = () => {
    const rootRect = root.getBoundingClientRect();

    // Candidates whose top is above the viewport top (scrolled past),
    // but are still visible enough to justify sticking.
    const stuckCandidates = [];

    for (const { wrap, actions } of containers) {
      const r = wrap.getBoundingClientRect();
      // Always clear stuck geometry; we re-apply only to the ONE best candidate
      try {
        actions.style.removeProperty('--ta-stuck-top');
        actions.style.removeProperty('--ta-stuck-left');
        actions.style.removeProperty('--ta-stuck-width');
      } catch { }

      const outAbove = r.bottom <= rootRect.top + 1;
      const outBelow = r.top >= rootRect.bottom - 1;

      if (outAbove || outBelow) {
        actions.classList.remove('ta-actions--stuck');
        actions.classList.add('ta-actions--hidden');
        continue;
      }

      actions.classList.remove('ta-actions--hidden');

      const topOutOfView = r.top < (rootRect.top + MARGIN);
      const stillVisibleEnough = r.bottom > (rootRect.top + MIN_VISIBLE);

      // default: not stuck (we'll apply stuck to only ONE best candidate)
      actions.classList.remove('ta-actions--stuck');

      if (topOutOfView && stillVisibleEnough) {
        stuckCandidates.push({ actions, wrap, top: r.top });
      }
    }

    // Pick the candidate closest to the viewport top (max top, but still < rootRect.top)
    let best = null;
    for (const c of stuckCandidates) {
      if (!best || c.top > best.top) best = c;
    }

    if (best) {
      // Pin to the exact textarea container box so there is NO horizontal jump
      const wr = best.wrap.getBoundingClientRect();
      const topPx = Math.round(rootRect.top + MARGIN);
      const leftPx = Math.round(wr.left);
      const widthPx = Math.round(wr.width);
      best.actions.style.setProperty('--ta-stuck-top', `${topPx}px`);
      best.actions.style.setProperty('--ta-stuck-left', `${leftPx}px`);
      best.actions.style.setProperty('--ta-stuck-width', `${widthPx}px`);
      best.actions.classList.add('ta-actions--stuck');
    }
  };

  let raf = null;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      update();
    });
  };

  root.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  // If any textarea expands/collapses, container heights change:
  try {
    const ro = new ResizeObserver(schedule);
    for (const { wrap } of containers) ro.observe(wr);
  } catch { }

  schedule();
}

// -------------------------
// Diff navigation (Prev/Next change)
// -------------------------
let diffNavObserver = null;
let diffNavVisible = false;
let diffNavIdx = -1; // -1 means "not aligned to a change yet"

// -------------------------
// Topbar "Copy Output" button visibility
// Show when:
// - Output exists (copy button is visible + output text non-empty)
// - Output section is above/out of view (scrolled past)
// - Diff section is visible (same time Prev/Next appear)
// -------------------------
let copyOutputTopRaf = null;

function updateCopyOutputTopButton() {
  const btn = document.getElementById('copyOutputTopBtn');
  if (!btn) return;

  const root = getMainScrollEl();
  const outWrap = document.getElementById('output-container');
  const copyBtn = document.getElementById('copyBtn');
  const outputEl = document.getElementById('output');

  if (!root || !outWrap || !copyBtn || !outputEl) {
    btn.classList.add('hidden');
    return;
  }

  const hasOutput =
    !copyBtn.classList.contains('hidden') &&
    (String(outputEl.textContent || '').length > 0);

  if (!hasOutput) {
    btn.classList.add('hidden');
    return;
  }

  // Only show alongside diff nav (user is in diff section)
  if (!diffNavVisible) {
    btn.classList.add('hidden');
    return;
  }

  const rootRect = root.getBoundingClientRect();
  const r = outWrap.getBoundingClientRect();

  // "Scrolled past output": output container bottom is above the scroll viewport top
  const outputAbove = r.bottom <= (rootRect.top + 1);
  btn.classList.toggle('hidden', !outputAbove);
}

function scheduleCopyOutputTopButtonUpdate() {
  if (copyOutputTopRaf) return;
  copyOutputTopRaf = requestAnimationFrame(() => {
    copyOutputTopRaf = null;
    updateCopyOutputTopButton();
  });
}

function initCopyOutputTopButton() {
  const root = getMainScrollEl();
  const btn = document.getElementById('copyOutputTopBtn');
  if (!root || !btn) return;
  if (btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';

  btn.addEventListener('click', () => copyOutput(btn));

  root.addEventListener('scroll', scheduleCopyOutputTopButtonUpdate, { passive: true });
  window.addEventListener('resize', scheduleCopyOutputTopButtonUpdate);

  // React immediately when output appears/disappears (tab switch, applyPatch completion)
  try {
    const mo = new MutationObserver(scheduleCopyOutputTopButtonUpdate);
    const copyBtn = document.getElementById('copyBtn');
    const outputEl = document.getElementById('output');
    if (copyBtn) mo.observe(copyBtn, { attributes: true, attributeFilter: ['class'] });
    if (outputEl) mo.observe(outputEl, { childList: true, subtree: true, characterData: true });
  } catch { }

  scheduleCopyOutputTopButtonUpdate();
}

// -------------------------
// Topbar "Go To Output Diff" button visibility
// Show ONLY when:
// - Output exists in the active tab
// - The diff section is currently below the scroll viewport (off-screen below)
// -------------------------
let goOutputDiffRaf = null;

function _hasActiveTabOutput() {
  let tab = null;
  try { tab = (typeof getActiveTab === 'function') ? getActiveTab() : null; } catch { }
  return !!(tab && String(tab.modifiedText || '').length > 0);
}

function scrollToOutputDiffTop() {
  const root = getMainScrollEl();
  const anchor = document.getElementById('diffSectionTitle') || document.getElementById('diffView');
  if (!root || !anchor) return;

  const rootRect = root.getBoundingClientRect();
  const aRect = anchor.getBoundingClientRect();
  const y = aRect.top - rootRect.top + root.scrollTop;
  root.scrollTo({ top: Math.max(0, y - 12), behavior: 'smooth' });
}

function updateGoOutputDiffButton() {
  const btn = document.getElementById('goOutputDiffBtn');
  if (!btn) return;

  const root = getMainScrollEl();
  const diffAnchor = document.getElementById('diffSectionTitle') || document.getElementById('diffView');
  if (!root || !diffAnchor) {
    btn.classList.add('hidden');
    return;
  }

  if (!_hasActiveTabOutput()) {
    btn.classList.add('hidden');
    return;
  }

  const hasRenderedDiff = !!document.querySelector('#diffView .d2h-wrapper');
  if (!hasRenderedDiff) {
    btn.classList.add('hidden');
    return;
  }

  const rootRect = root.getBoundingClientRect();
  const dRect = diffAnchor.getBoundingClientRect();

  // ONLY when diff is OFF-SCREEN BELOW
  const diffBelow = dRect.top >= (rootRect.bottom - 1);
  btn.classList.toggle('hidden', !diffBelow);
}

function scheduleGoOutputDiffButtonUpdate() {
  if (goOutputDiffRaf) return;
  goOutputDiffRaf = requestAnimationFrame(() => {
    goOutputDiffRaf = null;
    updateGoOutputDiffButton();
  });
}

function initGoOutputDiffButton() {
  const root = getMainScrollEl();
  const btn = document.getElementById('goOutputDiffBtn');
  if (!root || !btn) return;
  if (btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';

  // Ensure localized label on startup
  try { applyI18nToGoOutputDiffButton(); } catch { }

  btn.addEventListener('click', scrollToOutputDiffTop);

  root.addEventListener('scroll', scheduleGoOutputDiffButtonUpdate, { passive: true });
  window.addEventListener('resize', scheduleGoOutputDiffButtonUpdate);

  // React immediately when output/diff DOM changes (tab switch, applyPatch completion)
  try {
    const mo = new MutationObserver(scheduleGoOutputDiffButtonUpdate);
    const out = document.getElementById('output');
    const diff = document.getElementById('diffView');
    if (out) mo.observe(out, { childList: true, subtree: true, characterData: true });
    if (diff) mo.observe(diff, { childList: true, subtree: true });
  } catch { }

  scheduleGoOutputDiffButtonUpdate();
}

function getMainScrollEl() {
  return document.getElementById('mainScroll')
    || document.querySelector('.main-body')   // fallback if you forgot the id
    || null;
}

function resetDiffNav() { diffNavIdx = -1; }

function getChangeTargets() {
  const diffRoot = document.getElementById('diffView');
  if (!diffRoot) return [];

  const wrapper = diffRoot.querySelector('.d2h-wrapper');
  if (!wrapper) return [];

  // SIMPLE + RELIABLE: every changed row is a target (in DOM order).
  // (No hunks/blocks logic; that's what keeps biting you.)
  const rows = Array.from(wrapper.querySelectorAll('tr'));
  const isChangeRow = (tr) =>
    !!tr.querySelector('td.d2h-code-line.d2h-ins, td.d2h-code-line.d2h-del, td.d2h-code-line.d2h-change, td.d2h-ins, td.d2h-del, td.d2h-change');
  return rows.filter(isChangeRow);
}

function scrollToChange(dir /* -1 | 1 */) {
  const root = getMainScrollEl(); // ALWAYS scroll what the user actually scrolls
  const targets = getChangeTargets();
  if (!root || !targets.length) return;

  const rootRect = root.getBoundingClientRect();
  const yFor = (el) => el.getBoundingClientRect().top - rootRect.top + root.scrollTop;
  const ys = targets.map(yFor);

  // If user scrolled manually, diffNavIdx is reset to -1 (see scroll handler below).
  if (diffNavIdx === -1) {
    const cur = root.scrollTop;
    const margin = 12;
    if (dir > 0) {
      // first change below current viewport top
      let i = ys.findIndex(y => y > cur + margin);
      if (i === -1) i = 0; // wrap
      diffNavIdx = i;
    } else {
      // last change above current viewport top
      let i = -1;
      for (let k = ys.length - 1; k >= 0; k--) {
        if (ys[k] < cur - margin) { i = k; break; }
      }
      if (i === -1) i = ys.length - 1; // wrap
      diffNavIdx = i;
    }
  } else {
    // Deterministic step
    diffNavIdx = (diffNavIdx + dir + targets.length) % targets.length;
  }

  const targetEl = targets[diffNavIdx];
  const y = ys[diffNavIdx];
  root.scrollTo({ top: Math.max(0, y - 24), behavior: 'smooth' });

  // brief highlight (optional)
  try {
    targetEl.classList.add('diff-nav-flash');
    setTimeout(() => targetEl.classList.remove('diff-nav-flash'), 700);
  } catch { }
}

function updateDiffNavButtons() {
  const prevBtn = document.getElementById('diffPrevBtn');
  const nextBtn = document.getElementById('diffNextBtn');
  if (!prevBtn || !nextBtn) return;

  const hasDiff = !!document.querySelector('#diffView .d2h-wrapper');
  // Show ONLY when the diff section is actually visible in the scroll viewport
  const show = hasDiff && diffNavVisible;

  prevBtn.classList.toggle('hidden', !show);
  nextBtn.classList.toggle('hidden', !show);

  if (show) {
    const hasTargets = getChangeTargets().length > 0;
    prevBtn.disabled = !hasTargets;
    nextBtn.disabled = !hasTargets;
  }
  try { scheduleCopyOutputTopButtonUpdate(); } catch { }
}

function setupDiffNavObserver() {
  const mainScroll = getMainScrollEl();
  const diffView = document.getElementById('diffView');
  if (!mainScroll || !diffView) return;

  if (diffNavObserver) diffNavObserver.disconnect();

  diffNavObserver = new IntersectionObserver((entries) => {
    const e = entries?.[0];
    // NOTE: intersectionRatio is relative to the TARGET (diffView) height.
    // For tall diffs it may never reach 0.12 even when the diff is on-screen.
    // Using isIntersecting makes the buttons appear whenever any part is visible.
    diffNavVisible = !!(e && e.isIntersecting);
    updateDiffNavButtons();
  }, { root: mainScroll, threshold: [0] });

  diffNavObserver.observe(diffView);

  // Immediate sync (IO callback can be delayed)
  computeDiffNavVisible();
  updateDiffNavButtons();
}

function computeDiffNavVisible() {
  const root = getMainScrollEl();
  const target = document.getElementById('diffView');
  if (!root || !target) {
    diffNavVisible = false;
    return diffNavVisible;
  }

  const rootRect = root.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();

  const overlapTop = Math.max(rootRect.top, tRect.top);
  const overlapBottom = Math.min(rootRect.bottom, tRect.bottom);
  const overlap = Math.max(0, overlapBottom - overlapTop);

  // Visible if any part of diffView is within the scroll viewport
  diffNavVisible = overlap > 0;
  return diffNavVisible;
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

// NOTE: addTabAndSelect is provided by ./tabs.js via createTabsManager().
// (Local implementation removed to avoid duplicate declarations.)


function buildDiffHtml(originalText, modifiedText) {
  const unifiedDiff = createTwoFilesPatch(
    'original',
    'modified',
    originalText || '',
    modifiedText || '',
    '',
    '',
    { context: Number.MAX_SAFE_INTEGER }
  );
  return Diff2Html.html(unifiedDiff, {
    drawFileList: false,
    matching: 'none',
    outputFormat: 'side-by-side',
    synchronisedScroll: true,
    colorScheme: document.body.classList.contains('dark') ? 'dark' : 'light'
  });
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
  // remove legacy plaintext if present
  localStorage.removeItem(LS[provider]?.plain);
}

function loadLegacyPlain(provider) {
  return (localStorage.getItem(LS[provider]?.plain) || '').trim();
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



// -------------------------
// API keys: extracted manager (./apikeys.js)
// -------------------------
let apiKeysMgr = null;
function initApiKeysManagerOnce() {
  if (apiKeysMgr) return apiKeysMgr;
  apiKeysMgr = createApiKeyManager({ t, tFmt, ipcRenderer });

  try { _wrapEnsureKeyOrPromptForResume(apiKeysMgr); } catch { }
  try { initModelsManagerOnce()?.initModelProviderGateOnce?.(); } catch { }
  return apiKeysMgr;
}

// -------------------------
// Model selector gating by configured API keys
// -------------------------

// -------------------------
// Tabs: multiple workspaces
// -------------------------
let tabs = [];
let activeTabId = null;
let tabSeq = 1;
let renamingTabId = null;
let closingTabId = null;

// Tabs/workspaces extracted to ./tabs.js
let tabsMgr = null;
let ensureTabsListDelegation, ensureTabRow, updateTabRowFor, renderTabsFull, focusAdjacentTab;
let ensureTabDiffDom, makeTab, getActiveTab, saveActiveTabFromDom, applyTabToDom, selectTab, newTab, initTabs, addTabAndSelect, doCloseTab;

function initTabsManagerOnce() {
  if (tabsMgr) return tabsMgr;

  tabsMgr = createTabsManager({
    state: {
      get tabs() { return tabs; },
      set tabs(v) { tabs = v; },
      get activeTabId() { return activeTabId; },
      set activeTabId(v) { activeTabId = v; },
      get tabSeq() { return tabSeq; },
      set tabSeq(v) { tabSeq = v; },
    },
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
    getOriginalFileName: () => originalFileName,
    setOriginalFileName: (v) => { originalFileName = (v || 'file.txt'); },
  });

  ({
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
  } = tabsMgr);

  return tabsMgr;
}

// Provide updateSystemPromptButtonForTab from system prompts manager
function updateSystemPromptButtonForTab(tab) {
  try {
    return initSystemPromptsManagerOnce()?.updateSystemPromptButtonForTab?.(tab);
  } catch { }
}

// -------------------------
// API keys: extracted manager (./apikeys.js)
// -------------------------
apiKeysMgr = null;
function initApiKeysManagerOnce() {
  if (apiKeysMgr) return apiKeysMgr;
  apiKeysMgr = createApiKeyManager({ t, tFmt, ipcRenderer });

  try { _wrapEnsureKeyOrPromptForResume(apiKeysMgr); } catch { }
  try { initModelsManagerOnce()?.initModelProviderGateOnce?.(); } catch { }
  return apiKeysMgr;
}

function openTabRenameModal(tabId) {
  const overlay = document.getElementById('tabRenameOverlay');
  const input = document.getElementById('tabRenameInput');
  const tab = tabs.find(t => t.id === tabId);
  if (!overlay || !input || !tab) return;

  renamingTabId = tabId;
  overlayMgr.open('tabRenameOverlay');

  input.value = tab.label || '';
  input.disabled = false;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function closeTabRenameModal() {
  overlayMgr.close('tabRenameOverlay');
  renamingTabId = null; // keep explicit for local correctness
}
function saveTabRename() {
  try { initTabsManagerOnce(); } catch { }

  const input = document.getElementById('tabRenameInput');
  const next = String(input?.value || '').trim();
  const tabId = String(renamingTabId || activeTabId || '').trim();

  if (!tabId) { closeTabRenameModal(); return; }

  const tab = Array.isArray(tabs)
    ? tabs.find(t => String(t?.id || '') === tabId)
    : null;

  if (!tab) { closeTabRenameModal(); return; }

  if (next) {
    tab.label = next;
    tab.labelCustomized = true;
  }

  if (typeof updateTabRowFor === 'function') updateTabRowFor(tab);
  else if (typeof renderTabsFull === 'function') renderTabsFull();

  closeTabRenameModal();
}

function openTabCloseModal(tabId) {
  const overlay = document.getElementById('tabCloseOverlay');
  const nameEl = document.getElementById('tabCloseName');
  const bodyEl = document.getElementById('tabCloseBody');
  const tab = tabs.find(t => t.id === tabId);
  if (!overlay || !tab) return;

  closingTabId = tabId;
  const tabName = tab.label || t('tabs.fallbackName', 'this tab');
  if (bodyEl) {
    // Replace full sentence to support languages with different word order
    bodyEl.innerHTML = tFmt('tabs.closeBodyHtml', { tabName }, `Close <b id="tabCloseName">${tabName}</b>? Any unsaved input in this tab will be lost.`);
  }
  // Ensure we still set the <b id="tabCloseName"> if present (template keeps it)
  const nameEl2 = document.getElementById('tabCloseName') || nameEl;
  if (nameEl2) nameEl2.textContent = tabName;

  overlayMgr.open('tabCloseOverlay');

  // Focus Cancel by default (safer)
  setTimeout(() => {
    document.getElementById('tabCloseCancelBtn')?.focus();
  }, 0);
}

function closeTabCloseModal() {
  overlayMgr.close('tabCloseOverlay');
  closingTabId = null; // keep explicit for local correctness
}

function confirmTabClose() {
  if (!closingTabId) return;
  doCloseTab(closingTabId);
  closeTabCloseModal();
}

function openHelp() {
  const overlay = document.getElementById('helpOverlay');
  if (!overlay) return;
  overlayMgr.open('helpOverlay');
  document.getElementById('helpCloseBtn')?.focus();
}

function closeHelp() {
  const overlay = document.getElementById('helpOverlay');
  if (!overlay) return;
  overlayMgr.close('helpOverlay');
}

// -------------------------
// About modal
// -------------------------
let aboutInfoCache = null;

async function getAboutInfo() {
  try {
    // Fetch from main process (bundled settings + app version/name)
    const info = await ipcRenderer.invoke('about:getInfo');
    return info || null;
  } catch {
    return null;
  }
}

async function setAboutCreatorImage() {
  const img = document.getElementById('aboutCreatorImg');
  if (!img) return;

  const p = await ipcRenderer.invoke('creator-image-path');
  if (!p) return;

  // safest cross-platform (Windows/Linux/macOS)
  img.src = pathToFileURL(p).href;
}

function fillAboutUi(info) {
  const appNameEl = document.getElementById('aboutAppName');
  const creatorNameEl = document.getElementById('aboutCreatorName');
  const creatorEmailEl = document.getElementById('aboutCreatorEmail');
  const versionEl = document.getElementById('aboutVersion');
  const githubBtn = document.getElementById('aboutGitHubBtn');

  const appName = (info?.appName || 'AI Diff Tool').trim();
  const creatorName = (info?.creatorName || '').trim();
  const creatorEmail = (info?.creatorEmail || '').trim();
  const version = (info?.version || '').trim();
  const githubUrl = (info?.githubUrl || '').trim();

  if (appNameEl) appNameEl.textContent = appName;
  if (creatorNameEl) creatorNameEl.textContent = creatorName;

  if (creatorEmailEl) {
    creatorEmailEl.textContent = creatorEmail;
    // mailto: is fine for display + click
    creatorEmailEl.href = creatorEmail ? `mailto:${creatorEmail}` : '#';
  }

  if (versionEl) versionEl.textContent = version || '';

  if (githubBtn) {
    githubBtn.dataset.url = githubUrl;
    githubBtn.disabled = !githubUrl;
    githubBtn.title = githubUrl ? 'Open GitHub repository' : 'GitHub URL not configured';
  }
}

async function mountRazorpayButtonInAbout() {
  const frame = document.getElementById('aboutRazorpayFrame');
  if (!frame) return;
  if (frame.dataset.loaded === '1') return;

  // IMPORTANT:
  // - Razorpay fails inside file:// / sandboxed srcdoc because Origin becomes 'null'
  // - We instead load the button from a local http://127.0.0.1 page served by main
  //   so the iframe has a real origin and CORS preflight succeeds.
  try {
    const donateUrl = await ipcRenderer.invoke('razorpay:getDonateUrl');
    const u = String(donateUrl || '').trim();
    if (!u) return;
    frame.src = u;
    frame.dataset.loaded = '1';
  } catch {
    // no-op
  }
}

async function openAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;

  overlayMgr.open('aboutOverlay');

  // Load once per session (fast), but still safe if null
  if (!aboutInfoCache) aboutInfoCache = await getAboutInfo();
  fillAboutUi(aboutInfoCache || {});
  await mountRazorpayButtonInAbout();

  await setAboutCreatorImage();  // ✅ THIS is “renderer placement”

  document.getElementById('aboutCloseBtn')?.focus();
}

function closeAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;
  overlayMgr.close('aboutOverlay');
}

// Load stored API key and model on app start
window.addEventListener('DOMContentLoaded', async () => {
  await bootLanguageGate();

  applyI18nToFilePickers();
  applyI18nToCopyButtons();
  applyI18nToGoOutputDiffButton();
  applyI18nToCancelApiModal();
  applyI18nToModelActionButtons();

  // Models: manifest -> dropdown -> restore default selection
  const models = initModelsManagerOnce();
  try {
    models.initModelManifestAndDropdown?.();
  } catch (e) {
    console.error('Failed to load model_manifest.json:', e);
  }
  // Persist default selected model and apply per-tab selection (active tab when available)
  try {
    models.initSelectedModel?.({ fallbackDefaultModel: 'grok-4-fast-reasoning' });
  } catch { }
  // Wire modelSelect change -> per-tab selection + default persistence
  try { models.wireDomEvents?.(); } catch { }

  const storedTheme = localStorage.getItem('theme') || 'light';
  document.body.classList.toggle('dark', storedTheme === 'dark');
  ipcRenderer.send('theme:state', storedTheme);

  // Header icon + tab active highlight should be ready ASAP
  void setAppHeaderIcon();
  syncTabActiveHighlightFromNewTabButton();

  // Setup context menu
  document.body.addEventListener('contextmenu', handleContextMenu);
  // Add event listeners for buttons
  document.getElementById('applyBtn').addEventListener('click', () => applyPatch({ isRetry: false }));
  document.getElementById('retryBtn').addEventListener('click', () => applyPatch({ isRetry: true }));
  document.getElementById('cancelBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('cancelBtn');
    if (btn && !btn.disabled) openCancelApiModal();
  });
  document.getElementById('copyBtn').addEventListener('click', () => copyOutput(document.getElementById('copyBtn')));
  document.getElementById('download').addEventListener('click', downloadResult);

  // Localized file pickers (custom UI triggers the hidden native inputs)
  document.getElementById('diffFileBtn')?.addEventListener('click', () => {
    document.getElementById('diffFile')?.click();
  });
  document.getElementById('modelFileBtn')?.addEventListener('click', () => {
    document.getElementById('modelFile')?.click();
  });
  // Track chosen filenames PER TAB (prevents "leaking" labels across tabs)
  initPerTabFilePickerState();

  // Tabs
  initSystemPromptsManagerOnce().ensureSystemPromptStore();
  initTabsManagerOnce();
  initTabs();
  document.getElementById('newTabBtn')?.addEventListener('click', newTab);
  initFilePickerTabSyncObserver();

  // Browser-like tab shortcuts (vertical tabs still on the left)
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;

    // Ctrl/Cmd+T => new tab
    if (e.key.toLowerCase() === 't') {
      e.preventDefault();
      newTab();
      return;
    }

    // Ctrl/Cmd+W => close tab
    if (e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (activeTabId) openTabCloseModal(activeTabId);
      return;
    }

    // Ctrl/Cmd+Tab / Ctrl/Cmd+Shift+Tab => cycle tabs
    if (e.key === 'Tab') {
      e.preventDefault();
      focusAdjacentTab(activeTabId, e.shiftKey ? -1 : 1, { select: true });
    }
  });
  // Max/Min floating buttons
  initTextareaExpandCollapse();
  // Sticky max/min/copy for OUTPUT area while scrolling
  initStickyTaActions();

  // Topbar "Copy Output" (appears when output is scrolled past, while in diff)
  initCopyOutputTopButton();
  // Topbar "Go To Output Diff" (appears only when diff is below viewport and output exists)
  initGoOutputDiffButton();

  // --- Help overlay wiring (must be inside load) ---
  const overlay = document.getElementById('helpOverlay');
  const closeBtn = document.getElementById('helpCloseBtn');
  const okBtn = document.getElementById('helpOkBtn');

  if (closeBtn) closeBtn.addEventListener('click', closeHelp);
  if (okBtn) okBtn.addEventListener('click', closeHelp);

  // --- About overlay wiring ---
  const aboutOverlay = document.getElementById('aboutOverlay');
  const aboutCloseBtn = document.getElementById('aboutCloseBtn');
  const aboutOkBtn = document.getElementById('aboutOkBtn');
  const aboutGitHubBtn = document.getElementById('aboutGitHubBtn');

  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', closeAbout);
  if (aboutOkBtn) aboutOkBtn.addEventListener('click', closeAbout);

  // External open for Donate/GitHub (URLs injected on openAbout)
  if (aboutGitHubBtn) {
    aboutGitHubBtn.addEventListener('click', () => {
      const url = (aboutGitHubBtn.dataset.url || '').trim();
      if (url) ipcRenderer.send('external:open', url);
    });
  }

  // --- API keys / local encryption flow (extracted to ./apikeys.js) ---
  const apiKeys = initApiKeysManagerOnce();
  apiKeys.wireDomEvents();       // attaches API key + key-type modal listeners
  // Safety reset (in case HTML/CSS changed and something is visible)
  try { apiKeys.closeApiKeyModal?.({ force: true }); } catch { }
  try { apiKeys.closeKeyTypeModal?.({ force: true }); } catch { }

  // FIRST-RUN onboarding (right after language selection):
  // If there are no saved keys at all, force the non-dismissable provider picker + key entry flow.
  try {
    if (!apiKeys.hasAnyEncryptedApiKey()) {
      apiKeys.bootstrapApiKeyFlow();
    }
  } catch { }

  // Keep handle for ESC logic below
  const apiOverlay = document.getElementById('apiKeyOverlay');

  // --- History modal (extracted to ./history.js) ---
  const history = initHistoryManagerOnce();
  history.wireDomEvents();

  // --- Tab rename modal wiring ---
  const renameOverlay = document.getElementById('tabRenameOverlay');
  const renameCloseBtn = document.getElementById('tabRenameCloseBtn');
  const renameCancelBtn = document.getElementById('tabRenameCancelBtn');
  const renameSaveBtn = document.getElementById('tabRenameSaveBtn');
  const renameInput = document.getElementById('tabRenameInput');

  if (renameCloseBtn) renameCloseBtn.addEventListener('click', closeTabRenameModal);
  if (renameCancelBtn) renameCancelBtn.addEventListener('click', closeTabRenameModal);
  if (renameSaveBtn) renameSaveBtn.addEventListener('click', saveTabRename);

  if (renameInput) {
    renameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveTabRename();
    });
  }

  // --- Tab close modal wiring ---
  const tabCloseOverlay = document.getElementById('tabCloseOverlay');
  const tabCloseCloseBtn = document.getElementById('tabCloseCloseBtn');
  const tabCloseCancelBtn = document.getElementById('tabCloseCancelBtn');
  const tabCloseConfirmBtn = document.getElementById('tabCloseConfirmBtn');

  if (tabCloseCloseBtn) tabCloseCloseBtn.addEventListener('click', closeTabCloseModal);
  if (tabCloseCancelBtn) tabCloseCancelBtn.addEventListener('click', closeTabCloseModal);
  if (tabCloseConfirmBtn) tabCloseConfirmBtn.addEventListener('click', confirmTabClose);

  // --- Diff nav buttons ---
  document.getElementById('diffPrevBtn')?.addEventListener('click', () => scrollToChange(-1));
  document.getElementById('diffNextBtn')?.addEventListener('click', () => scrollToChange(1));

  // --- Language overlay wiring ---
  ipcRenderer.on('language:open', () => { void openLanguageModal(); });
  const langOverlay = document.getElementById('languageOverlay');
  const langCloseBtn = document.getElementById('languageCloseBtn');
  if (langCloseBtn) langCloseBtn.addEventListener('click', closeLanguageModal);
  if (langOverlay) {
    langOverlay.addEventListener('click', (e) => {
      if (e.target === langOverlay) closeLanguageModal();
    });
  }

  // Also allow menu-triggered open even before anything else
  // (main will send language:open)

  // --- System prompts (extracted to ./systemPrompts.js) ---
  initSystemPromptsManagerOnce().wireDomEvents();

  setupDiffNavObserver();
  updateDiffNavButtons();

  // Optional keyboard shortcuts:
  // F7 = prev change, F8 = next change
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F7') { e.preventDefault(); scrollToChange(-1); }
    if (e.key === 'F8') { e.preventDefault(); scrollToChange(1); }
  });

  // ESC should close whichever modal is open
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const renameOpen = renameOverlay && !renameOverlay.classList.contains('hidden');
    const apiOpen = apiOverlay && !apiOverlay.classList.contains('hidden');
    const helpOpen = overlay && !overlay.classList.contains('hidden');
    const aboutOpen = aboutOverlay && !aboutOverlay.classList.contains('hidden');
    const closeOpen = tabCloseOverlay && !tabCloseOverlay.classList.contains('hidden');
    let sysOpen = false;
    try { sysOpen = !!initSystemPromptsManagerOnce()?.isSysPromptModalOpen?.(); }
    catch { sysOpen = !!(document.getElementById('sysPromptOverlay') && !document.getElementById('sysPromptOverlay').classList.contains('hidden')); }
    const histOpen = history.isHistoryModalOpen();
    const langOpen = langOverlay && !langOverlay.classList.contains('hidden');
    const cancelOpen = !_isOverlayOpen ? false : _isOverlayOpen('cancelApiOverlay');

    if (cancelOpen) closeCancelApiModal();
    else if (langOpen) closeLanguageModal();
    else if (histOpen) history.closeHistoryModal();
    else if (sysOpen) { try { initSystemPromptsManagerOnce()?.closeSysPromptModal?.(); } catch { } }
    else if (aboutOpen) closeAbout();
    else if (closeOpen) closeTabCloseModal();
    else if (renameOpen) closeTabRenameModal();
    else if (apiOpen) {
      initApiKeysManagerOnce().closeApiKeyModal();
    }
    else if (helpOpen) closeHelp();
  });

  // --- Go to top (appears when scrolling the main body) ---
  const mainScroll = document.getElementById('mainScroll');
  const goTopBtn = document.getElementById('goTopBtn');

  if (mainScroll && goTopBtn) {
    const updateGoTop = () => {
      resetDiffNav(); // user scrolled manually -> next/prev should re-anchor from viewport
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

// Optional: one global listener (in case other modules want it later)
window.addEventListener('i18n:changed', () => {
  // hooks already call refreshUiAfterLanguageChange(), but this is harmless
});

ipcRenderer.on('theme:set', (_evt, theme) => {
  const shouldDark = theme === 'dark';

  document.body.classList.toggle('dark', shouldDark);
  localStorage.setItem('theme', shouldDark ? 'dark' : 'light');

  // Re-theme an already-rendered diff without regenerating HTML
  syncDiff2HtmlTheme();

  // Keep tab active highlight matched to "+" in both themes
  syncTabActiveHighlightFromNewTabButton();
  // keep the menu checkbox in sync
  ipcRenderer.send('theme:state', shouldDark ? 'dark' : 'light');
});

ipcRenderer.on('help:open', () => {
  openHelp();
});

ipcRenderer.on('about:open', () => {
  void openAbout();
});

ipcRenderer.on('diffnav:prev', () => {
  scrollToChange(-1);
});

ipcRenderer.on('diffnav:next', () => {
  scrollToChange(1);
});

ipcRenderer.on('sysprompt:open', () => {
  initSystemPromptsManagerOnce()?.openSysPromptModal?.({ tabId: activeTabId });
});

ipcRenderer.on('history:open', () => {
  initHistoryManagerOnce().openHistoryModal();
});

ipcRenderer.on('apikey:open', (_evt, payload) => {
  initApiKeysManagerOnce().openFromMenu(payload);
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
  const selectedModelSnapshot = document.getElementById('modelSelect').value;
  const apiKeys = initApiKeysManagerOnce();
  const provider = apiKeys.providerForModel(selectedModelSnapshot);
  // lock model choice into the originating tab + request
  // lock model choice into the originating tab + request
  tab.selectedModel = selectedModelSnapshot;

  // Lock system prompt choice into the originating tab + request
  const systemPromptIdSnapshot = tab.systemPromptId || DEFAULT_SYS_PROMPT_ID;
  tab.systemPromptId = systemPromptIdSnapshot;
  const systemPromptSnapshot = getSystemPromptById(systemPromptIdSnapshot)?.content || DEFAULT_SYSTEM_PROMPT;

  const outputEl = document.getElementById('output');
  const errorEl = document.getElementById('error');
  const loadingEl = document.getElementById('loading');
  const loadingElapsedEl = document.getElementById('loadingElapsed');
  const applyBtn = document.getElementById('applyBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const retryBtn = document.getElementById('retryBtn');
  const downloadBtn = document.getElementById('download');
  const copyBtn = document.getElementById('copyBtn');
  const diffViewEl = document.getElementById('diffView');

  errorEl.textContent = '';
  outputEl.textContent = '';
  diffViewEl.innerHTML = '';

  // Reset timing for this run (will be set when the model replies)
  tab.lastDurationMs = null;
  tab.lastTokenCount = null;
  if (activeTabId === tabId) setModelTimeUi(tab);
  // Also clear cached diff for this tab (we are recomputing)
  if (tab.diffDom) tab.diffDom.replaceChildren();
  tab.diffHtml = '';
  resetDiffNav();
  diffNavVisible = false;
  updateDiffNavButtons();
  downloadBtn.classList.add('hidden');
  copyBtn.classList.add('hidden');
  try { scheduleCopyOutputTopButtonUpdate(); } catch { }
  try { scheduleGoOutputDiffButtonUpdate(); } catch { }
  retryBtn.classList.add('hidden');

  if (!isRetry) tab.retryCount = 0;

  if (!diffText || !modelContent) {
    errorEl.textContent = 'Please fill Diff Patch and File Content.';
    try { scheduleGoOutputDiffButtonUpdate(); } catch { }
    return;
  }

  // Ensure the correct provider key is available (xAI for grok-*, OpenAI for gpt-*)
  await apiKeys.maybeDecryptProviderInSession(provider);
  const apiKey = apiKeys.getStoredApiKey(provider);
  if (!apiKey) { apiKeys.ensureKeyOrPrompt({ provider, blocking: true }); return; }

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
  tab.inFlightStartMs = _nowMs();      // for live mm:ss timer
  tab.cancelRequested = false;
  tab.abortCtrl = new AbortController();
  tab.abortToken = token;
  updateTabRowFor(tab); // fast spinner update

  // Keep tab state consistent even if user switches tabs
  tab.diffText = diffTextSnapshot || '';
  tab.modelText = modelContentSnapshot || '';

  if (activeTabId === tabId) {
    syncInFlightUiForActiveTab();
  }

  try {
    const openai = new OpenAI({
      apiKey,
      baseURL: apiKeys.baseUrlForProvider(provider),
      dangerouslyAllowBrowser: true  // Enable for Electron renderer; key is user-provided and local
    });
    console.log('OpenAI SDK initialized with browser allowance.');

    const userPrompt = `Original file content:\n\n${modelContentSnapshot}\n\nDiff patch to apply:\n\n${diffTextSnapshot}\n\nApply the patch and output the exact resulting file.`;
    const messages = [
      { role: 'system', content: systemPromptSnapshot },
      { role: 'user', content: userPrompt }
    ];

    // Use per-tab max tokens chosen in Confirm Apply modal (falls back per provider)
    let maxTokens = 0;
    try { maxTokens = _clampConfirmApplyMaxTokens(tab?.maxTokens); } catch { }
    if (!maxTokens) maxTokens = _defaultConfirmApplyMaxTokensForProvider(provider);
 

    const t0 = _nowMs();
    const completion = await openai.chat.completions.create({
      model: selectedModelSnapshot,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens || 32768
    }, { signal: tab.abortCtrl?.signal });

    const durationMs = _nowMs() - t0;
    const usageTotalTokens = getUsageTotalTokens(completion);

    let modified = completion.choices[0].message.content;
    // Strip any potential code fences
    modified = modified.replace(/^```[\w]*\n?|\n?```$/g, '').trim();

    // If this response is stale (user started a newer run), ignore it
    if (tab.inFlightToken !== token) {
      return;
    }

    // Store + render timing (model replied)
    tab.lastDurationMs = Math.max(0, Math.round(durationMs));
    // Prefer API-reported usage when present; otherwise estimate total tokens for (system+user+assistant)
    if (Number.isFinite(usageTotalTokens)) {
      tab.lastTokenCount = usageTotalTokens;
    } else {
      tab.lastTokenCount = estimateChatTokens([...messages, { role: 'assistant', content: modified }]);
    }
    if (activeTabId === tabId) setModelTimeUi(tab);

    // If model returned a congruency error, show it as an app error (not as file output)
    if (/^ERROR:/i.test(modified)) {
      tab.modifiedText = '';
      tab.diffHtml = '';
      tab.errorText = modified;
      tab.retryCount = 0;

      if (activeTabId === tabId) {
        outputEl.textContent = '';
        diffViewEl.innerHTML = '';
        updateDiffNavButtons();
        downloadBtn.classList.add('hidden');
        copyBtn.classList.add('hidden');
        retryBtn.classList.add('hidden');
        errorEl.textContent = modified;
        try { scheduleGoOutputDiffButtonUpdate(); } catch { }
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
    tab.diffHtml = ''; // legacy fallback not needed
    tab.errorText = '';
    tab.retryCount = 0;

    // ✅ Store history at the moment we have a successful output (all heavy fields compressed)
    try {
      const spObj = getSystemPromptById(systemPromptIdSnapshot || DEFAULT_SYS_PROMPT_ID);
      void initHistoryManagerOnce().addHistoryEntry({
        ts: Date.now(),
        model: selectedModelSnapshot,
        provider,
        sysPromptId: systemPromptIdSnapshot,
        sysPromptName: spObj?.name || 'Default',
        sysPromptContent: systemPromptSnapshot,
        diffText: diffTextSnapshot,
        inputText: modelContentSnapshot,
        outputText: modified,
        inputFileName: tab.originalFileName || originalFileName || 'file.txt',
        durationMs: tab.lastDurationMs,
        tokenCount: tab.lastTokenCount
      });
    } catch { }

    // If user is NOT viewing that tab, parse diff into the tab's hidden DOM cache now
    // (so switching later is instant; no innerHTML parse on tab switch)
    if (activeTabId !== tabId) {
      const holder = ensureTabDiffDom(tab);
      if (holder) holder.innerHTML = html;
      updateTabRowFor(tab);
      return;
    }

    // Only paint UI if user is still viewing that tab
    if (activeTabId === tabId) {
      outputEl.textContent = modified;
      autoResizeIfExpanded(outputEl);
      diffViewEl.innerHTML = html;
      syncDiff2HtmlTheme();
      requestAnimationFrame(() => {
        computeDiffNavVisible();
        updateDiffNavButtons();
      });
      errorEl.textContent = '';
      downloadBtn.classList.remove('hidden');
      copyBtn.classList.remove('hidden');
      try { scheduleCopyOutputTopButtonUpdate(); } catch { }
      try { scheduleGoOutputDiffButtonUpdate(); } catch { }
    }

  } catch (error) {
    if (tab.inFlightToken !== token) return;

    if (_isAbortError(error) || tab.cancelRequested) {
      tab.errorText = t('cancelApi.cancelled', 'Cancelled.');
      tab.retryCount = 0;
    } else {
      tab.errorText = `Error: ${error.message}. `;
      if (tab.retryCount < MAX_RETRIES) {
        tab.retryCount++;
        tab.errorText += `Retry ${tab.retryCount}/${MAX_RETRIES} available.`;
      } else {
        tab.errorText += 'Max retries reached.';
      }
    }

    if (activeTabId === tabId) {
      errorEl.textContent = tab.errorText;
      if (tab.retryCount > 0 && tab.retryCount < MAX_RETRIES) retryBtn.classList.remove('hidden');
      if (_isAbortError(error) || tab.cancelRequested) retryBtn.classList.add('hidden');
    }

    console.error(error);
  } finally {
    // Only clear inFlight if this is still the current request for that tab
    if (tab.inFlightToken === token) {
      tab.inFlightToken = null;
      tab.inFlight = false;
      updateTabRowFor(tab); // fast spinner update
    }
    if (String(tab.abortToken || '') === String(token || '')) {
      tab.abortToken = null;
      tab.abortCtrl = null;
    }

    if (activeTabId === tabId) {
      loadingEl.classList.add('hidden');
      applyBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
      stopLoadingElapsedTimer({ clear: true });
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

function copyOutput(btnOverride) {
  const outputEl = document.getElementById('output');
  const text = String(outputEl?.textContent || '');
  if (!text) return;

  const btn = btnOverride || document.getElementById('copyBtn');
  const isTop = btn && btn.id === 'copyOutputTopBtn';

  const setBtn = (b, label) => setButtonLabelText(b, label);

  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    btn.dataset.copyState = 'copied';
    setBtn(btn, t('output.copied', 'Copied!'));
    setTimeout(() => {
      btn.dataset.copyState = 'copy';
      setBtn(btn, isTop ? t('output.copyOutput', 'Copy Output') : t('output.copy', 'Copy'));
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
  });
}

// Load diff from file
document.getElementById('diffFile')?.addEventListener('change', async (e) => {
  const input = e.target;
  const file = input?.files?.[0] || null;
  setFilePickerName('diff', file?.name || '');
  if (!file) return;
  const text = await file.text();
  document.getElementById('diff').value = text;
  try { initTabsManagerOnce(); } catch { }
  const tab = getActiveTab?.();
  if (tab) tab.diffText = text;
});

// Load model from file
document.getElementById('modelFile')?.addEventListener('change', async (e) => {
  const input = e.target;
  const file = input?.files?.[0] || null;
  setFilePickerName('model', file?.name || '');
  if (!file) return;
  const text = await file.text();
  document.getElementById('model').value = text;
  originalFileName = file.name;
  try { initTabsManagerOnce(); } catch { }
  const tab = getActiveTab?.();
  if (tab) {
    tab.modelText = text;
    tab.originalFileName = file.name;
    if (!tab.labelCustomized) {
      // CSS ellipsis will truncate visually to fit the sidebar
      tab.label = file.name;
      updateTabRowFor(tab);
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

// NOTE:
// models.js is now the single source of truth for:
// - model_manifest.json loading + dropdown building
// - provider gating + coercion
// - provider/model lookup for confirmApply
// Keep renderer thin: initModelsManagerOnce() + call methods.
/* =========================================================
   Sidebar resize (drag divider between sidebar and main)
   - Pointer-based (works for mouse + touch in Electron)
   - Persist width in localStorage
   - Double-click divider resets width
   - Arrow keys on divider adjust width
   ========================================================= */
(function () {
  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function initSidebarResize() {
    const resizer = document.getElementById("sidebarResizer");
    const sidebar = document.querySelector(".sidebar");
    if (!resizer || !sidebar) return;

    const root = document.documentElement;

    const MIN = 180;
    function calcMax() {
      // clamp max to 60% of window or 560px, whichever is smaller
      return Math.min(560, Math.floor(window.innerWidth * 0.6));
    }

    // Restore saved width
    const saved = parseInt(localStorage.getItem("sidebarWidth") || "", 10);
    if (!Number.isNaN(saved)) {
      root.style.setProperty("--sidebar-w", clamp(saved, MIN, calcMax()) + "px");
    }

    let startX = 0;
    let startW = 0;

    function onPointerMove(e) {
      const dx = e.clientX - startX;
      const next = clamp(startW + dx, MIN, calcMax());
      root.style.setProperty("--sidebar-w", next + "px");
    }

    function onPointerUp() {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onPointerMove);

      // Persist final width
      const finalW = Math.round(sidebar.getBoundingClientRect().width);
      localStorage.setItem("sidebarWidth", String(finalW));
    }

    resizer.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      document.body.classList.add("is-resizing");

      try { resizer.setPointerCapture(e.pointerId); } catch (_) {}

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    });

    // Double-click divider = reset default width
    resizer.addEventListener("dblclick", () => {
      root.style.setProperty("--sidebar-w", "220px");
      localStorage.removeItem("sidebarWidth");
    });

    // Keyboard resizing (focus divider then ← / →)
    resizer.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 48 : 16;
      const cur = sidebar.getBoundingClientRect().width;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = clamp(cur - step, MIN, calcMax());
        root.style.setProperty("--sidebar-w", next + "px");
        localStorage.setItem("sidebarWidth", String(Math.round(next)));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = clamp(cur + step, MIN, calcMax());
        root.style.setProperty("--sidebar-w", next + "px");
        localStorage.setItem("sidebarWidth", String(Math.round(next)));
      }
    });

    // If window resizes, keep sidebar width in bounds
    window.addEventListener("resize", () => {
      const cur = sidebar.getBoundingClientRect().width;
      const next = clamp(cur, MIN, calcMax());
      root.style.setProperty("--sidebar-w", next + "px");
      localStorage.setItem("sidebarWidth", String(Math.round(next)));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSidebarResize);
  } else {
    initSidebarResize();
  }
})();