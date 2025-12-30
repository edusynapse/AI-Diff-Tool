
// models.js
// Model manifest + model dropdown + provider gating (single source of truth).
//
// Pattern: createXManager({ deps... }) -> { wireDomEvents(), ... }
// No direct access to renderer globals; everything is passed in.

function createModelsManager({
  window,
  document,
  fs,
  path,
  appDirname,   // pass __dirname from renderer
  cwd,          // pass process.cwd() from renderer
  storage,      // e.g. localStorage
  apiKeys,      // { hasEncryptedApiKey(providerId), providerForModel(modelId) }
  tabsApi,      // { getActiveTab(), getTabById(id)?, onActiveTabChanged(cb)? }
  modelSelectId = 'modelSelect',
  storageKey = 'selectedModel',
} = {}) {
  let modelManifest = null;
  let modelManifestIndex = {
    modelToProvider: new Map(), // modelId -> providerId
    modelMeta: new Map(),       // modelId -> { providerId, ...modelObj }
  };

  let _wired = false;
  let _gateWired = false;

  function _isPlainObj(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function _safeGetItem(k) {
    try { return storage?.getItem?.(k); } catch { return null; }
  }
  function _safeSetItem(k, v) {
    try { storage?.setItem?.(k, v); } catch { }
  }

  function _getModelSelect() {
    try { return document?.getElementById?.(modelSelectId) || null; } catch { return null; }
  }

  function _allOptgroups(sel) {
    if (!sel) return [];
    try { return Array.from(sel.querySelectorAll('optgroup')); } catch { return []; }
  }

  function _allOptions(sel) {
    if (!sel) return [];
    try { return Array.from(sel.querySelectorAll('option')); } catch { return []; }
  }

  function _modelExistsInDropdown(modelId) {
    const sel = _getModelSelect();
    const wanted = String(modelId || '').trim();
    if (!sel || !wanted) return false;
    for (const opt of _allOptions(sel)) {
      if (String(opt?.value || '').trim() === wanted) return true;
    }
    return false;
  }

  function _modelsInGroup(groupEl) {
    if (!groupEl) return [];
    try {
      return Array.from(groupEl.querySelectorAll('option'))
        .map(o => String(o?.value || '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function _providerIdsInDropdown() {
    const sel = _getModelSelect();
    if (!sel) return [];
    const groups = _allOptgroups(sel);
    const ids = [];
    for (const g of groups) {
      const p = String(g?.dataset?.provider || '').trim();
      if (p) ids.push(p);
    }
    return ids;
  }

  function _hasKeyForProvider(providerId) {
    const p = String(providerId || '').trim();
    if (!p) return false;
    try { return !!apiKeys?.hasEncryptedApiKey?.(p); } catch { return false; }
  }

  // Enabled providers:
  // - if ANY keys exist for providers present in dropdown => enabled = those providers with keys
  // - else (no keys at all) => enabled = all providers (so the user can choose; apply will prompt)
  function _enabledProvidersSetFromDropdown() {
    const providers = _providerIdsInDropdown();
    const withKeys = providers.filter(_hasKeyForProvider);
    const enabled = (withKeys.length > 0) ? withKeys : providers;
    return new Set(enabled);
  }

  function _lastOptionValueInEnabledProviders(enabledSet) {
    const sel = _getModelSelect();
    if (!sel) return '';
    const groups = _allOptgroups(sel);
    let last = '';
    for (const g of groups) {
      const p = String(g?.dataset?.provider || '').trim();
      if (!p) continue;
      if (!enabledSet.has(p)) continue;
      if (g.disabled) continue;
      const models = _modelsInGroup(g);
      if (models.length) last = models[models.length - 1];
    }
    return last;
  }

  function _lastOptionValueInProvider(providerId) {
    const sel = _getModelSelect();
    if (!sel) return '';
    const pWanted = String(providerId || '').trim();
    if (!pWanted) return '';
    const groups = _allOptgroups(sel);
    for (const g of groups) {
      const p = String(g?.dataset?.provider || '').trim();
      if (p !== pWanted) continue;
      const models = _modelsInGroup(g);
      return models[models.length - 1] || '';
    }
    return '';
  }

  function _findModelManifestPath() {
    const baseCwd = String(cwd || '').trim();
    const baseDir = String(appDirname || '').trim();
    const candidates = [];
    try {
      if (baseCwd) candidates.push(path.resolve(baseCwd, 'model_manifest.json'));
    } catch { }
    try {
      if (baseDir) {
        candidates.push(path.resolve(baseDir, 'model_manifest.json'));
        candidates.push(path.resolve(baseDir, '..', 'model_manifest.json'));
        candidates.push(path.resolve(baseDir, '..', '..', 'model_manifest.json'));
      }
    } catch { }

    for (const p of candidates) {
      try {
        if (p && fs?.existsSync?.(p)) return p;
      } catch { }
    }
    return null;
  }

  function _loadModelManifestSync() {
    const p = _findModelManifestPath();
    if (!p) return null;
    let obj = null;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      obj = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!_isPlainObj(obj)) return null;
    if (obj.manifest_version !== 1) return null;
    if (!Array.isArray(obj.providers) || obj.providers.length === 0) return null;

    const idx = { modelToProvider: new Map(), modelMeta: new Map() };
    for (const prov of obj.providers) {
      if (!_isPlainObj(prov)) continue;
      const providerId = String(prov.id || '').trim();
      if (!providerId) continue;
      const models = Array.isArray(prov.models) ? prov.models : [];
      for (const m of models) {
        if (!_isPlainObj(m)) continue;
        const modelId = String(m.id || '').trim();
        if (!modelId) continue;
        idx.modelToProvider.set(modelId, providerId);
        idx.modelMeta.set(modelId, { providerId, ...m });
      }
    }
    if (idx.modelMeta.size === 0) return null;

    modelManifest = obj;
    modelManifestIndex = idx;
    return obj;
  }

  function buildModelSelectFromManifest(manifest) {
    const sel = _getModelSelect();
    if (!sel) return false;
    if (!_isPlainObj(manifest) || !Array.isArray(manifest.providers)) return false;

    // Clear hardcoded options; manifest is source of truth.
    try { sel.replaceChildren(); } catch { sel.innerHTML = ''; }

    for (const prov of manifest.providers) {
      if (!_isPlainObj(prov)) continue;
      const providerId = String(prov.id || '').trim();
      const providerLabel = String(prov.label || prov.id || '').trim();
      if (!providerId) continue;

      const og = document.createElement('optgroup');
      og.label = providerLabel || providerId;
      og.dataset.provider = providerId;

      const models = Array.isArray(prov.models) ? prov.models : [];
      for (const m of models) {
        if (!_isPlainObj(m)) continue;
        const modelId = String(m.id || '').trim();
        if (!modelId) continue;

        const opt = document.createElement('option');
        opt.value = modelId;
        opt.textContent = String(m.label || m.id || '').trim() || modelId;
        opt.dataset.provider = providerId;

        // Keep pricing around for later UI work (no behavior change today).
        try {
          const pr = _isPlainObj(m.pricing) ? m.pricing : null;
          if (pr) opt.dataset.pricing = JSON.stringify(pr);
        } catch { }

        og.appendChild(opt);
      }

      if (og.querySelector('option')) sel.appendChild(og);
    }

    return true;
  }

  function initModelManifestAndDropdown() {
    const m = _loadModelManifestSync();
    if (m) buildModelSelectFromManifest(m);
    return m;
  }

  function manifestMaxTokensForModel(modelId) {
    try {
      const meta = modelManifestIndex?.modelMeta?.get?.(String(modelId || '').trim());
      if (meta && Number.isFinite(meta.max_tokens)) return Math.floor(meta.max_tokens);
    } catch { }
    return null;
  }

  function providerForModelId(modelId) {
    const m = String(modelId || '').trim();
    if (!m) return '';

    // Prefer manifest index
    try {
      const p = modelManifestIndex?.modelToProvider?.get?.(m);
      if (p) return String(p);
    } catch { }

    // Fall back to apikeys manager mapping (runtime routing)
    try {
      const p = apiKeys?.providerForModel?.(m);
      if (p) return String(p);
    } catch { }

    // Final fallback heuristic (kept for safety)
    return m.startsWith('gpt-') ? 'openai' : 'xai';
  }

  function updateModelDropdownGating({ coerceActive = true } = {}) {
    const sel = _getModelSelect();
    if (!sel) return;

    const enabled = _enabledProvidersSetFromDropdown();
    const groups = _allOptgroups(sel);
    for (const g of groups) {
      const p = String(g?.dataset?.provider || '').trim();
      if (!p) continue;
      g.disabled = !enabled.has(p);
    }

    if (coerceActive) coerceActiveTabModelToEnabled();
  }

  // Coercion rule:
  // - If current model is invalid for enabled provider(s), pick LAST option of another enabled set.
  // - If model not in dropdown, fall back within inferred provider, else last enabled option.
  function coerceModelToEnabled(model) {
    const raw = String(model || '').trim();
    const sel = _getModelSelect();
    if (!sel) return raw;

    const enabled = _enabledProvidersSetFromDropdown();
    const provider = providerForModelId(raw);
    const inDropdown = raw ? _modelExistsInDropdown(raw) : false;

    // If provider is not enabled (i.e., gated), jump to LAST option in enabled providers (other set).
    if (provider && enabled.size > 0 && !enabled.has(provider)) {
      return _lastOptionValueInEnabledProviders(enabled) || raw;
    }

    // Provider enabled (or unknown): keep if in dropdown
    if (inDropdown) return raw;

    // Missing from dropdown: prefer last option of inferred provider (if enabled), else last enabled.
    const byProv = _lastOptionValueInProvider(provider);
    if (byProv) return byProv;
    return _lastOptionValueInEnabledProviders(enabled) || raw;
  }

  function coerceActiveTabModelToEnabled(tabMaybe) {
    const tab = tabMaybe || (tabsApi?.getActiveTab?.() || null);
    const sel = _getModelSelect();
    if (!tab) {
      // Still keep dropdown value valid if possible
      if (sel) {
        const cur = String(sel.value || '').trim();
        const after = coerceModelToEnabled(cur);
        if (after && after !== cur) sel.value = after;
      }
      return;
    }

    const before = String(tab.selectedModel || '').trim();
    const after = coerceModelToEnabled(before || (sel ? String(sel.value || '').trim() : ''));
    if (after && after !== before) tab.selectedModel = after;
    if (sel && after && String(sel.value || '').trim() !== after) sel.value = after;
  }

  function initSelectedModel({ fallbackDefaultModel } = {}) {
    const sel = _getModelSelect();
    if (!sel) return '';

    const manifestDefault = String(modelManifest?.defaults?.model || '').trim();
    const fallback = String(fallbackDefaultModel || '').trim();
    const storedRaw = String(_safeGetItem(storageKey) || '').trim();

    // Choose candidate: stored > manifest default > fallback > last option in dropdown
    let candidate = storedRaw || manifestDefault || fallback || '';
    if (!candidate) {
      const opts = _allOptions(sel);
      candidate = String(opts[opts.length - 1]?.value || '').trim();
    }

    const chosen = coerceModelToEnabled(candidate);
    if (chosen) sel.value = chosen;
    if (chosen) _safeSetItem(storageKey, chosen);

    try {
      const tab = tabsApi?.getActiveTab?.() || null;
      if (tab && chosen) tab.selectedModel = chosen;
    } catch { }

    return chosen;
  }

  function wireDomEvents() {
    if (_wired) return;
    _wired = true;

    const sel = _getModelSelect();
    if (!sel) return;
    if (sel.dataset.modelsWired === '1') return;
    sel.dataset.modelsWired = '1';

    sel.addEventListener('change', (e) => {
      const next = String(e?.target?.value || '').trim();
      if (next) _safeSetItem(storageKey, next);

      try {
        const tab = tabsApi?.getActiveTab?.() || null;
        if (tab) tab.selectedModel = next;
      } catch { }

      // If the selection is no longer valid due to gating, coerce immediately.
      try { coerceActiveTabModelToEnabled(); } catch { }
    });

    // Optional: react to tab changes if tabs manager exposes an event.
    try {
      tabsApi?.onActiveTabChanged?.(() => {
        try { coerceActiveTabModelToEnabled(); } catch { }
      });
    } catch { }
  }

  function initModelProviderGateOnce() {
    if (_gateWired) return;
    _gateWired = true;

    // Initial sync (covers startup + restored tabs)
    try { updateModelDropdownGating({ coerceActive: true }); } catch { }

    // Recompute gating immediately after a key is added/updated
    try {
      window?.addEventListener?.('apikeys:changed', () => {
        try { updateModelDropdownGating({ coerceActive: true }); } catch { }
      });
    } catch { }
  }

  return {
    // manifest load/build
    _findModelManifestPath,
    _loadModelManifestSync,
    buildModelSelectFromManifest,
    initModelManifestAndDropdown,

    // index + helpers
    get modelManifestIndex() { return modelManifestIndex; },
    get modelManifest() { return modelManifest; },
    manifestMaxTokensForModel,
    providerForModelId,

    // gating/coercion
    updateModelDropdownGating,
    coerceModelToEnabled,
    coerceActiveTabModelToEnabled,
    initModelProviderGateOnce,

    // persistence + DOM wiring
    initSelectedModel,
    wireDomEvents,
  };
}

module.exports = { createModelsManager };