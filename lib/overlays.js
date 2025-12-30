
'use strict';

/**
 * Overlay / Modal Manager
 * - Open/close overlays by id
 * - Close on outside-click (backdrop click: event.target === overlayEl)
 * - Close on ESC (per-overlay rules)
 * - Maintain body.modal-open based on registry
 * - Provide closeAll({force:true})
 *
 * No external deps.
 */

function createOverlayManager({ document, onAnyChange } = {}) {
  if (!document) throw new Error('createOverlayManager: document is required');

  const registry = new Map(); // id -> config
  const openStack = [];       // last-opened order (best-effort)

  // Coalesce syncs triggered by MutationObserver / rapid changes
  let _raf = null;
  const _schedule = () => {
    if (_raf) return;
    const cb = () => {
      _raf = null;
      try { _rebuildOpenStackBestEffort(); } catch {}
      try { syncBodyClass(); } catch {}
      try { onAnyChange?.(); } catch {}
    };
    if (typeof requestAnimationFrame === 'function') _raf = requestAnimationFrame(cb);
    else _raf = setTimeout(cb, 0);
  };

  const _getEl = (id) => {
    try { return document.getElementById(id); } catch { return null; }
  };

  const _isOpenEl = (el) => !!(el && el.classList && !el.classList.contains('hidden'));

  const isOpen = (id) => _isOpenEl(_getEl(id));

  function _stackTouchOpen(id) {
    const idx = openStack.indexOf(id);
    if (idx !== -1) openStack.splice(idx, 1);
    openStack.push(id);
  }

  function _stackRemove(id) {
    const idx = openStack.indexOf(id);
    if (idx !== -1) openStack.splice(idx, 1);
  }

  function _rebuildOpenStackBestEffort() {
    // Ensure stack includes all currently-open overlays (and excludes closed ones).
    // Order is best-effort: we keep existing order and append newly-seen opens.
    for (const id of registry.keys()) {
      if (isOpen(id)) _stackTouchOpen(id);
      else _stackRemove(id);
    }
  }

  function syncBodyClass() {
    const body = document.body;
    if (!body || !body.classList) return;
    let any = false;
    for (const id of registry.keys()) {
      if (isOpen(id)) { any = true; break; }
    }
    body.classList.toggle('modal-open', any);
  }

  function register(cfg = {}) {
    const id = String(cfg.id || '').trim();
    if (!id) return null;
    registry.set(id, { ...cfg, id });
    // Best-effort: pick up initial state
    try { if (isOpen(id)) _stackTouchOpen(id); } catch {}
    _schedule();
    return id;
  }

  function _shouldCloseByRule(rule, ctx) {
    if (!rule) return false;
    if (typeof rule === 'function') {
      try { return !!rule(ctx); } catch { return true; }
    }
    if (typeof rule === 'object') {
      if (rule.enabled === false) return false;
      return true;
    }
    return !!rule;
  }

  function _ruleBehavior(rule) {
    if (rule && typeof rule === 'object') {
      return {
        preventDefault: rule.preventDefault !== false,
        stopPropagation: rule.stopPropagation !== false
      };
    }
    return { preventDefault: true, stopPropagation: true };
  }

  function open(id, { force = false } = {}) {
    const key = String(id || '').trim();
    if (!key) return false;
    const cfg = registry.get(key) || { id: key };
    const el = _getEl(key);
    if (!el) return false;

    // Show
    try { el.classList.remove('hidden'); } catch {}

    // Hook
    try { cfg.onOpen?.({ id: key, el, force }); } catch {}

    _stackTouchOpen(key);
    syncBodyClass();
    try { onAnyChange?.(); } catch {}
    return true;
  }

  function close(id, { force = false, reason = 'api' } = {}) {
    const key = String(id || '').trim();
    if (!key) return false;
    const cfg = registry.get(key) || { id: key };
    const el = _getEl(key);
    if (!el) {
      _stackRemove(key);
      _schedule();
      return false;
    }

    if (!_isOpenEl(el)) {
      _stackRemove(key);
      _schedule();
      return true;
    }

    // Optional blocker
    if (!force && typeof cfg.beforeClose === 'function') {
      try {
        const ok = cfg.beforeClose({ id: key, el, force, reason });
        if (ok === false) return false;
      } catch {}
    }

    // Hide first (so CSS/scroll lock updates immediately)
    try { el.classList.add('hidden'); } catch {}

    _stackRemove(key);

    // Hook
    try { cfg.onClose?.({ id: key, el, force, reason }); } catch {}

    syncBodyClass();
    try { onAnyChange?.(); } catch {}
    return true;
  }

  function closeAll({ force = false } = {}) {
    // Close in reverse-open order first
    const ids = Array.from(new Set(openStack.slice().reverse().concat(Array.from(registry.keys()))));
    for (const id of ids) {
      try { if (isOpen(id)) close(id, { force, reason: 'closeAll' }); } catch {}
    }
    syncBodyClass();
    try { onAnyChange?.(); } catch {}
    return true;
  }

  function _topmostOpenIdMatching(predicate) {
    for (let i = openStack.length - 1; i >= 0; i--) {
      const id = openStack[i];
      const cfg = registry.get(id);
      const el = _getEl(id);
      if (!cfg || !el || !_isOpenEl(el)) continue;
      if (predicate({ id, cfg, el })) return { id, cfg, el };
    }
    // Fallback: scan registry (in insertion order)
    for (const [id, cfg] of registry.entries()) {
      const el = _getEl(id);
      if (!el || !_isOpenEl(el)) continue;
      if (predicate({ id, cfg, el })) return { id, cfg, el };
    }
    return null;
  }

  // Outside click (capture): only close when user clicks the backdrop element itself.
  document.addEventListener('click', (e) => {
    const hit = _topmostOpenIdMatching(({ id, cfg, el }) => {
      if (!_shouldCloseByRule(cfg.closeOnOutside, { id, el, event: e })) return false;
      return e.target === el;
    });
    if (!hit) return;
    const { id, cfg, el } = hit;
    close(id, { force: false, reason: 'outside' });

    const b = _ruleBehavior(cfg.closeOnOutside);
    if (b.preventDefault) e.preventDefault();
    if (b.stopPropagation) {
      e.stopPropagation();
      try { e.stopImmediatePropagation(); } catch {}
    }
  }, true);

  // ESC (capture): close topmost closeOnEsc overlay.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const hit = _topmostOpenIdMatching(({ id, cfg, el }) => {
      return _shouldCloseByRule(cfg.closeOnEsc, { id, el, event: e });
    });
    if (!hit) return;
    const { id, cfg } = hit;
    close(id, { force: false, reason: 'esc' });

    const b = _ruleBehavior(cfg.closeOnEsc);
    if (b.preventDefault) e.preventDefault();
    if (b.stopPropagation) {
      e.stopPropagation();
      try { e.stopImmediatePropagation(); } catch {}
    }
  }, true);

  // MutationObserver: keep modal-open correct even when other modules toggle overlays directly.
  try {
    const mo = new MutationObserver((muts) => {
      let relevant = false;
      for (const m of muts) {
        const t = m.target;
        if (!t || t === document.body) continue;
        const id = t.id;
        if (id && registry.has(id)) { relevant = true; }
      }
      if (relevant) _schedule();
    });
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    });
  } catch {}

  // Initial sync
  _schedule();

  return {
    register,
    open,
    close,
    closeAll,
    isOpen,
    syncBodyClass
  };
}

module.exports = { createOverlayManager };