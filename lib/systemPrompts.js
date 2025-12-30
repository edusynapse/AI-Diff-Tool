
/* systemPrompts.js */
// System prompts: persistent store + editor modal (manager-style, like history.js)
// - Persists to localStorage with versioning
// - Enforces max prompts, Default prompt exists + locked + pinned at top
// - Modal list with badges (Default / In use)
// - Create / duplicate / edit / delete / use prompt for active tab
// - Updates System Prompt button label per tab
//
// Receives:
// - t, tFmt
// - storage (localStorage)
// - tabs accessors: getActiveTab, getTabById, (optional) getAllTabs, (optional) updateTabRowFor
// - overlayMgr

const SYS_PROMPTS_LS_KEY = 'system_prompts_v1';
const SYS_PROMPTS_MAX = 5;
const DEFAULT_SYS_PROMPT_ID = 'default';

const DEFAULT_SYSTEM_PROMPT = [
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

function createSystemPromptsManager({
  window,
  document,
  storage,
  t,
  tFmt,
  overlayMgr,
  tabs = {},
  modal = {}
} = {}) {
  const cfg = {
    overlayId: modal.overlayId || 'sysPromptOverlay',
    listId: modal.listId || 'sysPromptList',
    listHintId: modal.listHintId || 'sysPromptListHint',
    hintId: modal.hintId || 'sysPromptHint',
    nameId: modal.nameId || 'sysPromptNameInput',
    textId: modal.textId || 'sysPromptText',
    btnNewId: modal.btnNewId || 'sysPromptNewBtn',
    btnDupId: modal.btnDupId || 'sysPromptDuplicateBtn',
    btnDelId: modal.btnDelId || 'sysPromptDeleteBtn',
    btnSaveId: modal.btnSaveId || 'sysPromptSaveBtn',
    btnUseId: modal.btnUseId || 'sysPromptUseBtn',
    btnCloseId: modal.btnCloseId || 'sysPromptCloseBtn',
    btnCancelId: modal.btnCancelId || 'sysPromptCancelBtn',
    sysBtnId: modal.sysBtnId || 'sysPromptBtn'
  };

  let systemPromptStore = null; // { v, prompts: [] }

  // Modal state (kept internal to this manager)
  let sysPromptModalSelectedId = DEFAULT_SYS_PROMPT_ID;
  let sysPromptModalMode = 'view'; // 'view' | 'create' | 'edit'
  let sysPromptModalDirty = false;
  let sysPromptModalForTabId = null;

  function _now() { return Date.now(); }

  function _isPlainObj(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function _safeGetItem(k) {
    try { return storage?.getItem?.(k); } catch { return null; }
  }

  function _safeSetItem(k, v) {
    try { storage?.setItem?.(k, v); } catch { }
  }

  function _loadSystemPromptStore() {
    const raw = _safeGetItem(SYS_PROMPTS_LS_KEY);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (!_isPlainObj(obj)) return null;
      if (obj.v !== 1) return null;
      if (!Array.isArray(obj.prompts)) return null;
      return obj;
    } catch {
      return null;
    }
  }

  function _saveSystemPromptStore(store) {
    _safeSetItem(SYS_PROMPTS_LS_KEY, JSON.stringify(store));
  }

  function ensureSystemPromptStore() {
    let store = _loadSystemPromptStore();
    if (!store) store = { v: 1, prompts: [] };

    const now = _now();
    const idx = store.prompts.findIndex(p => p && p.id === DEFAULT_SYS_PROMPT_ID);
    const defObj = {
      id: DEFAULT_SYS_PROMPT_ID,
      name: 'Default',
      content: DEFAULT_SYSTEM_PROMPT,
      locked: true,
      createdAt: now,
      updatedAt: now
    };

    if (idx === -1) {
      store.prompts.unshift(defObj);
    } else {
      const existing = store.prompts[idx] || {};
      const merged = {
        ...existing,
        ...defObj,
        createdAt: existing.createdAt || now,
        updatedAt: now
      };
      store.prompts[idx] = merged;
      if (idx !== 0) {
        store.prompts.splice(idx, 1);
        store.prompts.unshift(merged);
      }
    }

    // De-dupe by id, keep first occurrence (Default already at top)
    const seen = new Set();
    store.prompts = store.prompts.filter(p => {
      const id = String(p?.id || '').trim();
      if (!id) return false;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // Enforce max (always keep Default + first N-1 customs)
    if (store.prompts.length > SYS_PROMPTS_MAX) {
      const def = store.prompts.find(p => p.id === DEFAULT_SYS_PROMPT_ID);
      const customs = store.prompts
        .filter(p => p.id !== DEFAULT_SYS_PROMPT_ID)
        .slice(0, SYS_PROMPTS_MAX - 1);
      store.prompts = [def, ...customs].filter(Boolean);
    }

    _saveSystemPromptStore(store);
    systemPromptStore = store;
    return store;
  }

  function getSystemPromptById(id) {
    const store = systemPromptStore || ensureSystemPromptStore();
    const wanted = String(id || '').trim();
    const found = store.prompts.find(p => p && p.id === wanted);
    if (found) return found;
    const def = store.prompts.find(p => p && p.id === DEFAULT_SYS_PROMPT_ID);
    return def || { id: DEFAULT_SYS_PROMPT_ID, name: 'Default', content: DEFAULT_SYSTEM_PROMPT, locked: true };
  }

  function doesSystemPromptExist(id) {
    const store = systemPromptStore || ensureSystemPromptStore();
    const wanted = String(id || '').trim();
    if (!wanted) return false;
    return !!store.prompts.find(p => p && p.id === wanted);
  }

  function _setButtonLabelText(btn, text) {
    if (!btn) return;
    const lbl = btn.querySelector ? btn.querySelector('.btn-label') : null;
    if (lbl) lbl.textContent = text;
    else btn.textContent = text;
    btn.title = text;
    btn.setAttribute('aria-label', text);
  }

  function updateSystemPromptButtonForTab(tab) {
    const btn = document?.getElementById?.(cfg.sysBtnId);
    if (!btn) return;
    const p = getSystemPromptById(tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID);
    const rawName = p?.name || 'Default';
    const nm = (p?.id === DEFAULT_SYS_PROMPT_ID)
      ? t?.('sysPrompt.defaultName', rawName)
      : rawName;
    const label = tFmt?.('sysPrompt.buttonLabel', { name: nm }, `Prompt - ${nm}`);
    _setButtonLabelText(btn, label);
    btn.title = tFmt?.('sysPrompt.buttonTitle', { name: nm }, `System prompt: ${nm}`);
  }

  function _els() {
    return {
      overlay: document.getElementById(cfg.overlayId),
      list: document.getElementById(cfg.listId),
      listHint: document.getElementById(cfg.listHintId),
      hint: document.getElementById(cfg.hintId),
      name: document.getElementById(cfg.nameId),
      text: document.getElementById(cfg.textId),
      btnNew: document.getElementById(cfg.btnNewId),
      btnDup: document.getElementById(cfg.btnDupId),
      btnDel: document.getElementById(cfg.btnDelId),
      btnSave: document.getElementById(cfg.btnSaveId),
      btnUse: document.getElementById(cfg.btnUseId),
      btnClose: document.getElementById(cfg.btnCloseId),
      btnCancel: document.getElementById(cfg.btnCancelId)
    };
  }

  function _getTabById(tabId) {
    try {
      if (typeof tabs.getTabById === 'function') return tabs.getTabById(tabId);
    } catch { }
    return null;
  }

  function _getActiveTab() {
    try { return (typeof tabs.getActiveTab === 'function') ? tabs.getActiveTab() : null; } catch { return null; }
  }

  function _getAllTabs() {
    try { return (typeof tabs.getAllTabs === 'function') ? (tabs.getAllTabs() || []) : []; } catch { return []; }
  }

  function _updateTabRowFor(tab) {
    try { return (typeof tabs.updateTabRowFor === 'function') ? tabs.updateTabRowFor(tab) : undefined; } catch { }
    return undefined;
  }

  function _renderSysPromptList() {
    const { list, listHint } = _els();
    if (!list) return;
    const store = systemPromptStore || ensureSystemPromptStore();
    const tab = _getTabById(sysPromptModalForTabId) || _getActiveTab();
    const inUseId = tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID;

    const frag = document.createDocumentFragment();
    for (const p of store.prompts) {
      const row = document.createElement('div');
      row.className = 'sys-prompt-item';
      row.dataset.promptId = p.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', p.id === sysPromptModalSelectedId ? 'true' : 'false');
      row.classList.toggle('active', p.id === sysPromptModalSelectedId);

      const name = document.createElement('div');
      name.className = 'sys-prompt-item-name';
      name.textContent = (p.id === DEFAULT_SYS_PROMPT_ID)
        ? t?.('sysPrompt.defaultName', (p.name || 'Default'))
        : (p.name || t?.('sysPrompt.unnamed', '(unnamed)'));

      const badges = document.createElement('div');
      badges.className = 'sys-prompt-item-badges';

      if (p.id === DEFAULT_SYS_PROMPT_ID) {
        const b = document.createElement('span');
        b.className = 'sys-prompt-badge';
        b.textContent = t?.('sysPrompt.badgeDefault', 'Default');
        badges.appendChild(b);
      }

      if (p.id === inUseId) {
        const b = document.createElement('span');
        b.className = 'sys-prompt-badge';
        b.textContent = t?.('sysPrompt.badgeInUse', 'In use');
        badges.appendChild(b);
      }

      row.appendChild(name);
      row.appendChild(badges);
      frag.appendChild(row);
    }
    list.replaceChildren(frag);

    if (listHint) {
      const count = store.prompts.length;
      const remaining = Math.max(0, SYS_PROMPTS_MAX - count);
      const plural = (remaining === 1) ? '' : 's';
      listHint.textContent = tFmt?.(
        'sysPrompt.listHint',
        { remaining, max: SYS_PROMPTS_MAX, plural },
        `You can save ${remaining} more prompt${plural} (max ${SYS_PROMPTS_MAX} incl. Default).`
      );
    }
  }

  function _setSysPromptEditorFromSelection() {
    const { name, text, hint, btnSave, btnUse, btnDel } = _els();
    const store = systemPromptStore || ensureSystemPromptStore();
    const p = store.prompts.find(x => x.id === sysPromptModalSelectedId) || getSystemPromptById(DEFAULT_SYS_PROMPT_ID);
    if (!name || !text) return;

    sysPromptModalDirty = false;
    if (hint) hint.textContent = '';

    const locked = !!p.locked || p.id === DEFAULT_SYS_PROMPT_ID;
    name.value = p.name || '';
    text.value = p.content || '';

    name.disabled = locked;
    text.readOnly = locked;

    if (locked) {
      if (hint) hint.textContent = t?.(
        'sysPrompt.defaultLockedHint',
        'Default prompt cannot be edited. Click “New” or “Duplicate” to create a custom prompt.'
      );
    }

    if (btnSave) btnSave.disabled = locked;
    if (btnDel) btnDel.disabled = locked;
    if (btnUse) btnUse.disabled = false;

    sysPromptModalMode = locked ? 'view' : 'edit';
  }

  function openSysPromptModal({ tabId = null } = {}) {
    const { overlay, hint, list, name, text, btnSave, btnDel } = _els();
    if (!overlay) return;

    ensureSystemPromptStore();
    sysPromptModalForTabId = tabId || null;
    const tab = _getTabById(sysPromptModalForTabId) || _getActiveTab();
    sysPromptModalSelectedId = tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID;
    sysPromptModalDirty = false;
    sysPromptModalMode = 'view';
    if (hint) hint.textContent = '';

    overlayMgr?.open?.(cfg.overlayId);

    _renderSysPromptList();
    _setSysPromptEditorFromSelection();

    const p = getSystemPromptById(sysPromptModalSelectedId);
    const locked = !!p.locked || p.id === DEFAULT_SYS_PROMPT_ID;
    if (btnSave) btnSave.disabled = locked;
    if (btnDel) btnDel.disabled = locked;

    setTimeout(() => {
      try { list?.focus?.(); } catch { }
      if (!locked) {
        try { text?.focus?.(); } catch { }
      } else {
        try { name?.blur?.(); } catch { }
      }
    }, 0);
  }

  function closeSysPromptModal({ force = false } = {}) {
    const { overlay } = _els();
    if (!overlay) return;
    overlayMgr?.close?.(cfg.overlayId, { force });
    // State reset happens in onOverlayClosed as well; harmless to do here.
    sysPromptModalDirty = false;
    sysPromptModalMode = 'view';
    sysPromptModalForTabId = null;
  }

  function onOverlayClosed() {
    // Called by overlayMgr.register({ onClose }) to keep internal state consistent.
    sysPromptModalDirty = false;
    sysPromptModalMode = 'view';
    sysPromptModalForTabId = null;
  }

  function _beginCreatePromptFrom(baseId) {
    const { name, text, hint, btnSave, btnDel } = _els();
    const base = getSystemPromptById(baseId || DEFAULT_SYS_PROMPT_ID);
    if (!name || !text) return;

    sysPromptModalMode = 'create';
    sysPromptModalDirty = true;

    name.disabled = false;
    text.readOnly = false;
    name.value = '';
    text.value = base.content || DEFAULT_SYSTEM_PROMPT;

    if (btnSave) btnSave.disabled = false;
    if (btnDel) btnDel.disabled = true;

    if (hint) hint.textContent = t?.(
      'sysPrompt.createHint',
      'Creating a new custom prompt. Enter a name, edit the text, then Save.'
    );
    setTimeout(() => {
      try { name.focus(); name.select(); } catch { }
    }, 0);
  }

  function _normalizeName(s) { return (s || '').trim(); }

  function _isNameTaken(name, ignoreId = null) {
    const store = systemPromptStore || ensureSystemPromptStore();
    const n = _normalizeName(name).toLowerCase();
    return store.prompts.some(p => p.id !== ignoreId && (p.name || '').trim().toLowerCase() === n);
  }

  function _createPromptId() {
    return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function handleSysPromptSave() {
    const { name, text, hint } = _els();
    const store = systemPromptStore || ensureSystemPromptStore();
    if (!name || !text) return;
    if (hint) hint.textContent = '';

    const selected = getSystemPromptById(sysPromptModalSelectedId);
    const selectedLocked = !!selected.locked || selected.id === DEFAULT_SYS_PROMPT_ID;

    const nm = _normalizeName(name.value);
    const content = (text.value || '').trimEnd();

    if (sysPromptModalMode === 'create') {
      if (!nm) { if (hint) hint.textContent = t?.('sysPrompt.msg.nameRequired', 'Prompt name is required.'); return; }
      if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = t?.('sysPrompt.msg.defaultReserved', '“Default” is reserved. Choose another name.'); return; }
      if (_isNameTaken(nm, null)) { if (hint) hint.textContent = t?.('sysPrompt.msg.nameTaken', 'A prompt with this name already exists.'); return; }
      if (!content.trim()) { if (hint) hint.textContent = t?.('sysPrompt.msg.textRequired', 'System prompt text is required.'); return; }

      if (store.prompts.length >= SYS_PROMPTS_MAX) {
        if (hint) hint.textContent = tFmt?.(
          'sysPrompt.msg.maxPrompts',
          { max: SYS_PROMPTS_MAX },
          `Max ${SYS_PROMPTS_MAX} prompts allowed (including Default). Delete one to add a new one.`
        );
        return;
      }

      const now = _now();
      const id = _createPromptId();
      store.prompts.push({
        id,
        name: nm,
        content,
        locked: false,
        createdAt: now,
        updatedAt: now
      });

      _saveSystemPromptStore(store);
      systemPromptStore = store;
      sysPromptModalSelectedId = id;
      sysPromptModalMode = 'edit';
      sysPromptModalDirty = false;
      if (hint) hint.textContent = t?.('sysPrompt.msg.saved', 'Saved.');
      _renderSysPromptList();
      _setSysPromptEditorFromSelection();
      return;
    }

    if (selectedLocked) {
      if (hint) hint.textContent = t?.('sysPrompt.msg.cantEditDefault', 'Default prompt cannot be edited.');
      return;
    }

    if (!nm) { if (hint) hint.textContent = t?.('sysPrompt.msg.nameRequired', 'Prompt name is required.'); return; }
    if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = t?.('sysPrompt.msg.defaultReserved', '“Default” is reserved. Choose another name.'); return; }
    if (_isNameTaken(nm, selected.id)) { if (hint) hint.textContent = t?.('sysPrompt.msg.nameTaken', 'A prompt with this name already exists.'); return; }
    if (!content.trim()) { if (hint) hint.textContent = t?.('sysPrompt.msg.textRequired', 'System prompt text is required.'); return; }

    const i = store.prompts.findIndex(p => p.id === selected.id);
    if (i === -1) { if (hint) hint.textContent = t?.('sysPrompt.msg.notFound', 'Could not find this prompt in storage.'); return; }

    store.prompts[i] = {
      ...store.prompts[i],
      name: nm,
      content,
      updatedAt: _now()
    };
    _saveSystemPromptStore(store);
    systemPromptStore = store;
    sysPromptModalDirty = false;
    if (hint) hint.textContent = t?.('sysPrompt.msg.saved', 'Saved.');
    _renderSysPromptList();
  }

  function handleSysPromptUse() {
    const { hint } = _els();
    const tab = _getTabById(sysPromptModalForTabId) || _getActiveTab();
    if (!tab) return;

    if (sysPromptModalDirty) {
      if (hint) hint.textContent = t?.('sysPrompt.msg.unsaved', 'You have unsaved changes. Save before using this prompt.');
      return;
    }

    tab.systemPromptId = sysPromptModalSelectedId || DEFAULT_SYS_PROMPT_ID;

    // Optional: if tabs UI needs refreshing
    _updateTabRowFor(tab);

    // Button label for active tab
    const active = _getActiveTab();
    if (active && String(active.id || '') === String(tab.id || '')) {
      updateSystemPromptButtonForTab(active);
    }

    _renderSysPromptList();
    closeSysPromptModal();
  }

  function handleSysPromptDelete() {
    const { hint } = _els();
    const store = systemPromptStore || ensureSystemPromptStore();
    const p = getSystemPromptById(sysPromptModalSelectedId);
    if (!p || p.id === DEFAULT_SYS_PROMPT_ID || p.locked) {
      if (hint) hint.textContent = t?.('sysPrompt.msg.cantDeleteDefault', 'Default prompt cannot be deleted.');
      return;
    }

    const ok = window?.confirm?.(
      tFmt?.('sysPrompt.confirmDelete', { name: p.name }, `Delete system prompt “${p.name}”?`)
    );
    if (!ok) return;

    store.prompts = store.prompts.filter(x => x.id !== p.id);
    _saveSystemPromptStore(store);
    systemPromptStore = store;

    // Any tabs using this prompt revert to Default (best-effort)
    const all = _getAllTabs();
    if (Array.isArray(all) && all.length) {
      for (const tt of all) {
        if (tt && tt.systemPromptId === p.id) tt.systemPromptId = DEFAULT_SYS_PROMPT_ID;
      }
    } else {
      const active = _getActiveTab();
      if (active && active.systemPromptId === p.id) active.systemPromptId = DEFAULT_SYS_PROMPT_ID;
    }

    sysPromptModalSelectedId = DEFAULT_SYS_PROMPT_ID;
    sysPromptModalMode = 'view';
    sysPromptModalDirty = false;
    if (hint) hint.textContent = t?.('sysPrompt.msg.deleted', 'Deleted.');
    _renderSysPromptList();
    _setSysPromptEditorFromSelection();

    const active = _getActiveTab();
    if (active) updateSystemPromptButtonForTab(active);
  }

  function handleSysPromptDuplicate() {
    _beginCreatePromptFrom(sysPromptModalSelectedId || DEFAULT_SYS_PROMPT_ID);
  }

  function isSysPromptModalOpen() {
    const overlay = document.getElementById(cfg.overlayId);
    return !!(overlay && !overlay.classList.contains('hidden'));
  }

  function wireDomEvents() {
    const { overlay, list, name, text, btnClose, btnCancel, btnNew, btnDup, btnSave, btnUse, btnDel } = _els();
    if (!overlay) return;
    if (overlay.dataset.sysPromptsWired === '1') return;
    overlay.dataset.sysPromptsWired = '1';

    // System Prompt button (opens modal for active tab)
    const sysBtn = document.getElementById(cfg.sysBtnId);
    if (sysBtn && sysBtn.dataset.sysPromptsBtnWired !== '1') {
      sysBtn.dataset.sysPromptsBtnWired = '1';
      sysBtn.addEventListener('click', () => {
        const active = _getActiveTab();
        openSysPromptModal({ tabId: active?.id });
      });
    }

    if (btnClose) btnClose.addEventListener('click', () => closeSysPromptModal());
    if (btnCancel) btnCancel.addEventListener('click', () => closeSysPromptModal());
    if (btnNew) btnNew.addEventListener('click', () => _beginCreatePromptFrom(DEFAULT_SYS_PROMPT_ID));
    if (btnDup) btnDup.addEventListener('click', handleSysPromptDuplicate);
    if (btnSave) btnSave.addEventListener('click', handleSysPromptSave);
    if (btnUse) btnUse.addEventListener('click', handleSysPromptUse);
    if (btnDel) btnDel.addEventListener('click', handleSysPromptDelete);

    if (list && list.dataset.delegated !== '1') {
      list.dataset.delegated = '1';
      list.addEventListener('click', (e) => {
        const row = e.target?.closest?.('.sys-prompt-item');
        const pid = String(row?.dataset?.promptId || '').trim();
        if (!pid) return;

        if (sysPromptModalDirty) {
          const ok = window?.confirm?.(t?.('sysPrompt.confirmDiscard', 'Discard unsaved changes?'));
          if (!ok) return;
        }

        sysPromptModalSelectedId = pid;
        _renderSysPromptList();
        _setSysPromptEditorFromSelection();
      });
    }

    if (name) name.addEventListener('input', () => { sysPromptModalDirty = true; });
    if (text) text.addEventListener('input', () => { sysPromptModalDirty = true; });
  }

  return {
    SYS_PROMPTS_LS_KEY,
    SYS_PROMPTS_MAX,
    DEFAULT_SYS_PROMPT_ID,
    DEFAULT_SYSTEM_PROMPT,
    ensureSystemPromptStore,
    getSystemPromptById,
    doesSystemPromptExist,
    updateSystemPromptButtonForTab,
    openSysPromptModal,
    closeSysPromptModal,
    isSysPromptModalOpen,
    onOverlayClosed,
    wireDomEvents
  };
}

module.exports = {
  createSystemPromptsManager,
  SYS_PROMPTS_LS_KEY,
  SYS_PROMPTS_MAX,
  DEFAULT_SYS_PROMPT_ID,
  DEFAULT_SYSTEM_PROMPT
};