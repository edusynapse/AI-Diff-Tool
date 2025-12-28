'use strict';

function createI18nManager({
  ipcRenderer,
  window,
  document,
  storage,
  modal = {},
  hooks = {}
} = {}) {
  const LANG_LS_KEY = 'ui_language_v1';
  const LANG_FALLBACK = 'EN';

  const doc = document;
  const win = window;
  const store = storage;

  const hookBeforeChange = (typeof hooks.beforeChange === 'function') ? hooks.beforeChange : null;
  const hookAfterChange = (typeof hooks.afterChange === 'function') ? hooks.afterChange : null;

  const modalCfg = {
    overlayId: modal.overlayId || 'languageOverlay',
    buttonsWrapId: modal.buttonsWrapId || 'languageButtons',
    closeBtnId: modal.closeBtnId || 'languageCloseBtn',
    otherOverlayIds: Array.isArray(modal.otherOverlayIds) ? modal.otherOverlayIds : []
  };

  let i18n = { code: LANG_FALLBACK, pack: {}, fallback: {} };

  function _normLangCode(code) {
    // Accept inputs like: "EN", "en", "EN.json", "build/languages/EN.json"
    // Normalize to: "EN"
    const raw = String(code || '').trim();
    const noExt = raw.replace(/\.json$/i, '');
    const c = noExt.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
    return c || LANG_FALLBACK;
  }

  function _aliasLangKey(k) {
    // Keep this tiny: only handle known filename-vs-key mismatches.
    // (Your EN.json uses "zh" but you also ship CN.json.)
    switch (String(k || '').toLowerCase()) {
      case 'cn': return 'zh';
      default: return String(k || '').toLowerCase();
    }
  }

  function _getLanguageOptionsMap() {
    const p = i18n.pack;
    if (p && typeof p === 'object' && p.languageOptions && typeof p.languageOptions === 'object') {
      return p.languageOptions;
    }
    const f = i18n.fallback;
    if (f && typeof f === 'object' && f.languageOptions && typeof f.languageOptions === 'object') {
      return f.languageOptions;
    }
    return null;
  }

  function _getLanguageLabelFromOptions(code, optionsMap) {
    const key = _aliasLangKey(code);
    if (optionsMap && typeof optionsMap === 'object' && Object.prototype.hasOwnProperty.call(optionsMap, key)) {
      const v = optionsMap[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return _normLangCode(code);
  }

  function _deepGet(obj, keyPath) {
    const parts = String(keyPath || '').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function _fmt(template, vars) {
    const s = String(template || '');
    const v = (vars && typeof vars === 'object') ? vars : {};
    return s.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, k) => {
      const val = v[k];
      return (val == null) ? '' : String(val);
    });
  }

  function t(keyPath, fallbackText = '') {
    const v = _deepGet(i18n.pack, keyPath);
    if (typeof v === 'string' && v.trim()) return v;
    const vf = _deepGet(i18n.fallback, keyPath);
    if (typeof vf === 'string' && vf.trim()) return vf;
    return String(fallbackText || '');
  }

  function tFmt(keyPath, vars, fallbackText = '') {
    return _fmt(t(keyPath, fallbackText), vars);
  }

  async function setLanguage(nextCode) {
    const next = _normLangCode(nextCode);
    if (!next) return i18n.code;
    if (next === i18n.code) return i18n.code;

    // Let renderer close modals / stash state etc
    try { hookBeforeChange?.(next); } catch {}

    try { store?.setItem?.(LANG_LS_KEY, next); } catch {}

    // Fetch packs (renderer side)
    try {
      const res = await ipcRenderer?.invoke?.('language:getAll', next);
      if (res && typeof res === 'object') {
        i18n.code = _normLangCode(res.code || next);
        i18n.pack = (res.pack && typeof res.pack === 'object') ? res.pack : {};
        i18n.fallback = (res.fallback && typeof res.fallback === 'object') ? res.fallback : {};
      } else {
        i18n.code = next;
        i18n.pack = {};
        i18n.fallback = {};
      }
    } catch {
      i18n.code = next;
      i18n.pack = {};
      i18n.fallback = {};
    }

    // Let main rebuild menu labels + persist
    try { await ipcRenderer?.invoke?.('language:set', i18n.code); } catch {}

    // Apply translated strings to DOM (static UI)
    try { applyI18nToStaticUi(); } catch {}

    // Notify renderer modules to refresh any dynamic bits (tabs aria-label etc)
    try {
      win?.dispatchEvent?.(new CustomEvent('i18n:changed', { detail: { code: i18n.code } }));
    } catch {}

    try { hookAfterChange?.(i18n.code); } catch {}

    return i18n.code;
  }

  async function initI18n() {
    const desired = _normLangCode(store?.getItem?.(LANG_LS_KEY) || LANG_FALLBACK);
    try {
      const res = await ipcRenderer?.invoke?.('language:getAll', desired);
      if (res && typeof res === 'object') {
        i18n.code = _normLangCode(res.code || desired);
        i18n.pack = (res.pack && typeof res.pack === 'object') ? res.pack : {};
        i18n.fallback = (res.fallback && typeof res.fallback === 'object') ? res.fallback : {};
        try { store?.setItem?.(LANG_LS_KEY, i18n.code); } catch {}
      }
    } catch {
      // keep defaults
    }

    // Let main rebuild menu labels in the chosen language
    try { await ipcRenderer?.invoke?.('language:set', i18n.code); } catch {}
    return i18n.code;
  }

  function _byId(id) { return doc ? doc.getElementById(id) : null; }

  function setTextById(id, keyPath, fallbackText = '') {
    const el = _byId(id);
    if (!el) return;
    el.textContent = t(keyPath, fallbackText || el.textContent || '');
  }

  function setHtmlById(id, keyPath, fallbackHtml = '') {
    const el = _byId(id);
    if (!el) return;
    el.innerHTML = t(keyPath, fallbackHtml || el.innerHTML || '');
  }

  function setAttrById(id, attr, keyPath, fallbackVal = '') {
    const el = _byId(id);
    if (!el) return;
    const v = t(keyPath, fallbackVal || el.getAttribute(attr) || '');
    if (v) el.setAttribute(attr, v);
  }

  function applyI18nToStaticUi() {
    if (!doc) return;

    // document title
    doc.title = t('app.windowTitle', doc.title || 'AI Diff Tool');

    // Sidebar / topbar
    setTextById('sidebarWorkspacesTitle', 'sidebar.workspaces', 'Workspaces');
    setAttrById('newTabBtn', 'title', 'sidebar.newTab', 'New tab');
    setAttrById('newTabBtn', 'aria-label', 'sidebar.newTab', 'New tab');
    setTextById('sidebarRenameHint', 'sidebar.renameHint', 'Double-click a tab to rename');

    setTextById('mainAppTitle', 'app.name', 'AI Diff Tool');
    setAttrById('appIconImg', 'alt', 'app.iconAlt', 'AI Diff Tool icon');

    setTextById('diffPrevBtn', 'nav.prevChange', 'Prev change');
    setAttrById('diffPrevBtn', 'title', 'nav.prevChangeTitle', 'Previous change');
    setTextById('diffNextBtn', 'nav.nextChange', 'Next change');
    setAttrById('diffNextBtn', 'title', 'nav.nextChangeTitle', 'Next change');
    setTextById('goTopBtn', 'nav.goTop', 'Go to top');

    // Main labels/buttons
    setTextById('modelSelectLabel', 'model.selectLabel', 'Select Model:');
    setTextById('retryBtn', 'buttons.retry', 'Retry');
    setTextById('applyBtn', 'buttons.applyPatch', 'Apply Patch');
    setTextById('loadingText', 'loading.processing', 'Processing...');
    setTextById('diffLabel', 'labels.diffPatch', 'Diff Patch (paste or load file):');
    setTextById('modelLabel', 'labels.fileContent', 'File Content (paste or load file):');
    setTextById('outputSectionTitle', 'labels.outputSection', 'Output from Model');
    setTextById('diffSectionTitle', 'labels.diffSection', 'Diff with original');
    setTextById('copyBtn', 'buttons.copy', 'Copy');
    setTextById('download', 'buttons.download', 'Download Modified File');

    // TA action buttons (maximize/minimize tooltips)
    const maxTitle = t('textarea.maximize', 'Maximize');
    const minTitle = t('textarea.minimize', 'Minimize');
    doc.querySelectorAll('button[data-ta-action="max"]').forEach((b) => {
      b.setAttribute('title', maxTitle);
      b.setAttribute('aria-label', maxTitle);
    });
    doc.querySelectorAll('button[data-ta-action="min"]').forEach((b) => {
      b.setAttribute('title', minTitle);
      b.setAttribute('aria-label', minTitle);
    });

    // About modal (static labels)
    setTextById('aboutTitle', 'about.title', 'About');
    setAttrById('aboutCloseBtn', 'aria-label', 'about.closeAria', 'Close about');
    setTextById('aboutThanks', 'about.thanks', 'Thank you for using');
    setAttrById('aboutCreatorImg', 'alt', 'about.creatorAlt', 'Creator');
    setTextById('aboutCreatorLabel', 'about.creatorLabel', 'Creator');
    setTextById('aboutEmailLabel', 'about.emailLabel', 'Email');
    setTextById('aboutDonateBtn', 'about.donate', 'Donate');
    setTextById('aboutGitHubBtn', 'about.github', 'GitHub Repo');
    setTextById('aboutLicenseTitle', 'about.licenseTitle', 'Open Source License');
    setTextById('aboutLicenseText', 'about.licenseText', 'This project is open-source. See the LICENSE file in the GitHub repository.');
    setTextById('aboutVersionPrefix', 'about.versionPrefix', 'Version');
    setTextById('aboutOkBtn', 'buttons.close', 'Close');

    // Help modal
    setTextById('helpTitle', 'help.title', 'AI Diff Tool — Usage');
    setAttrById('helpCloseBtn', 'aria-label', 'help.closeAria', 'Close help');
    setHtmlById('helpBody', 'help.bodyHtml', _byId('helpBody')?.innerHTML || '');
    setTextById('helpOkBtn', 'buttons.close', 'Close');

    // Key type modal
    setTextById('keyTypeTitle', 'keyType.title', 'Choose API Key Type');
    setHtmlById('keyTypeIntro', 'keyType.introHtml', _byId('keyTypeIntro')?.innerHTML || '');
    setTextById('keyTypeXaiBtn', 'providers.xai', 'xAI');
    setTextById('keyTypeOpenAiBtn', 'providers.openai', 'OpenAI');

    // API key modal (static labels; dynamic title/intro set in openApiKeyModal)
    setAttrById('apiKeyCloseBtn', 'aria-label', 'apiKey.closeAria', 'Close API key dialog');
    setTextById('apiKeyModalLabel', 'apiKey.label', 'API Key');
    setTextById('apiKeyPinLabel', 'apiKey.pinLabel', '6-digit PIN');
    setTextById('apiKeyCancelBtn', 'buttons.cancel', 'Cancel');

    // Tab rename modal
    setTextById('tabRenameTitle', 'tabs.renameTitle', 'Rename tab');
    setAttrById('tabRenameCloseBtn', 'aria-label', 'tabs.renameCloseAria', 'Close rename dialog');
    setTextById('tabRenameLabel', 'tabs.nameLabel', 'Tab name');
    const rn = _byId('tabRenameInput');
    if (rn) rn.setAttribute('placeholder', t('tabs.namePlaceholder', rn.getAttribute('placeholder') || ''));
    setTextById('tabRenameHint', 'tabs.renameHint', 'Press Enter to save');
    setTextById('tabRenameSaveBtn', 'buttons.save', 'Save');
    setTextById('tabRenameCancelBtn', 'buttons.cancel', 'Cancel');

    // Tab close modal
    setTextById('tabCloseTitle', 'tabs.closeTitle', 'Close tab?');
    setAttrById('tabCloseCloseBtn', 'aria-label', 'tabs.closeCloseAria', 'Close close-tab dialog');
    setTextById('tabCloseConfirmBtn', 'tabs.closeConfirm', 'Close tab');
    setTextById('tabCloseCancelBtn', 'buttons.cancel', 'Cancel');

    // System prompt modal (UI only; prompt content is NOT translated)
    setTextById('sysPromptTitle', 'sysPrompt.title', 'System Prompt');
    setAttrById('sysPromptCloseBtn', 'aria-label', 'sysPrompt.closeAria', 'Close system prompt dialog');
    setTextById('sysPromptSavedTitle', 'sysPrompt.savedTitle', 'Saved prompts');
    setTextById('sysPromptNewBtn', 'buttons.new', 'New');
    setAttrById('sysPromptList', 'aria-label', 'sysPrompt.listAria', 'System prompts');
    setTextById('sysPromptNameLabel', 'sysPrompt.nameLabel', 'Prompt name');
    const spn = _byId('sysPromptNameInput');
    if (spn) spn.setAttribute('placeholder', t('sysPrompt.namePlaceholder', spn.getAttribute('placeholder') || ''));
    setTextById('sysPromptTextLabel', 'sysPrompt.textLabel', 'System prompt');
    setTextById('sysPromptDuplicateBtn', 'buttons.duplicate', 'Duplicate');
    setTextById('sysPromptDeleteBtn', 'buttons.delete', 'Delete');
    setTextById('sysPromptSaveBtn', 'buttons.save', 'Save');
    setTextById('sysPromptUseBtn', 'sysPrompt.useInTab', 'Use in this tab');
    setTextById('sysPromptCancelBtn', 'buttons.close', 'Close');

    // History modal
    setTextById('historyTitle', 'history.sectionTitle', 'History');
    setAttrById('historyCloseBtn', 'aria-label', 'history.closeAria', 'Close history');
    setTextById('historyClearBtn', 'buttons.clear', 'Clear');
    setAttrById('historyClearBtn', 'title', 'history.clearTitle', 'Clear history');
    setAttrById('historyList', 'aria-label', 'history.listAria', 'History items');
    setTextById('historyPrevBtn', 'buttons.prev', 'Prev');
    setTextById('historyNextBtn', 'buttons.next', 'Next');
    setTextById('historyOkBtn', 'buttons.close', 'Close');

    // Language modal
    setTextById('languageTitle', 'language.title', 'Language');
    setAttrById('languageCloseBtn', 'aria-label', 'language.closeAria', 'Close language');
    setTextById('languageIntro', 'language.intro', 'Choose a language.');
  }

  function isLanguageModalOpen() {
    const overlay = _byId(modalCfg.overlayId);
    return !!(overlay && !overlay.classList.contains('hidden'));
  }

  function _anyModalOpen(ids) {
    if (!doc) return false;
    return (ids || []).some((id) => {
      const el = _byId(id);
      return !!(el && !el.classList.contains('hidden'));
    });
  }

  async function openLanguageModal() {
    const overlay = _byId(modalCfg.overlayId);
    const buttonsWrap = _byId(modalCfg.buttonsWrapId);
    if (!overlay || !buttonsWrap) return;

    overlay.classList.remove('hidden');
    doc.body.classList.add('modal-open');

    let langs = [LANG_FALLBACK];
    try {
      const list = await ipcRenderer?.invoke?.('language:list');
      if (Array.isArray(list) && list.length) langs = list.map(_normLangCode);
    } catch {}

    const cur = _normLangCode(store?.getItem?.(LANG_LS_KEY) || i18n.code || LANG_FALLBACK);

    // Get languageOptions from the *currently loaded* language JSON (i18n.pack).
    // If it isn't present for any reason, fetch it once via IPC.
    let optionsMap = _getLanguageOptionsMap();
    if (!optionsMap) {
      try {
        const res = await ipcRenderer?.invoke?.('language:getAll', cur);
        const pack = res && typeof res === 'object' ? res.pack : null;
        const fb = res && typeof res === 'object' ? res.fallback : null;
        if (pack && typeof pack === 'object' && pack.languageOptions && typeof pack.languageOptions === 'object') {
          optionsMap = pack.languageOptions;
        } else if (fb && typeof fb === 'object' && fb.languageOptions && typeof fb.languageOptions === 'object') {
          optionsMap = fb.languageOptions;
        }
      } catch {}
    }

    const frag = doc.createDocumentFragment();
    for (const code of langs) {
      // "languageOptions" keys are lowercase ("en","hi",...)
      const displayName = _getLanguageLabelFromOptions(String(code || '').toLowerCase(), optionsMap);

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'modal-ok';
      btn.textContent = displayName;
      btn.title = displayName;
      btn.setAttribute('aria-label', displayName);
      btn.dataset.code = code;
      btn.disabled = code === cur;
      btn.addEventListener('click', async () => {
        const next = _normLangCode(btn.dataset.code);
        // no reload; keep tabs + content
        await setLanguage(next);
      });
      frag.appendChild(btn);
    }

    buttonsWrap.replaceChildren(frag);
    _byId(modalCfg.closeBtnId)?.focus?.();
  }

  function closeLanguageModal() {
    const overlay = _byId(modalCfg.overlayId);
    if (!overlay) return;
    overlay.classList.add('hidden');

    // Only remove modal-open if *no* other modal is open
    const idsToCheck = [
      ...(modalCfg.otherOverlayIds || []),
      modalCfg.overlayId
    ];
    if (!_anyModalOpen(idsToCheck)) {
      doc.body.classList.remove('modal-open');
    }
  }

  return {
    // constants (exported for convenience / future use)
    LANG_LS_KEY,
    LANG_FALLBACK,

    // core api
    t,
    tFmt,
    initI18n,
    applyI18nToStaticUi,

    // language modal
    setLanguage,
    isLanguageModalOpen,
    openLanguageModal,
    closeLanguageModal,
  };
}

module.exports = { createI18nManager };