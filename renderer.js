const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
const Diff2Html = require('diff2html');  // For rendering as HTML
const zlib = require('zlib'); // history compression fallback (no new deps)
const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const { createTabsManager } = require('./tabs');
const { createApiKeyManager } = require('./apikeys');
const { createI18nManager } = require('./i18n');

// --- Close modals + keep tabs safe when switching language ---
function closeAllModalsForLanguageChange() {
  // stash current tab inputs safely (doesn't touch their contents)
  try { initTabsManagerOnce(); saveActiveTabFromDom(); } catch {}

  // Close everything visible; force-close blocking ones
  try { closeHelp(); } catch {}
  try { closeAbout(); } catch {}
  try { closeHistoryModal(); } catch {}
  try { closeSysPromptModal(); } catch {}
  try { closeTabRenameModal(); } catch {}
  try { closeTabCloseModal(); } catch {}
  try { closeLanguageModal(); } catch {}

  try {
    const api = initApiKeysManagerOnce();
    api?.closeApiKeyModal?.({ force: true });
    api?.closeKeyTypeModal?.({ force: true });
  } catch {}

  // Hard reset body scroll lock (safe because we just closed everything)
  try { document.body.classList.remove('modal-open'); } catch {}
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

  // Only overwrite the filename display if no file is currently shown
  if (diffName && diffName.dataset.hasFile !== '1') diffName.textContent = none;
  if (modelName && modelName.dataset.hasFile !== '1') modelName.textContent = none;
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

function refreshUiAfterLanguageChange() {
  // 1) Tabs (aria-label, busy tooltip, etc.)
  try { initTabsManagerOnce(); renderTabsFull(); } catch {}

  // 2) System prompt button label (uses t/tFmt)
  try { updateSystemPromptButtonForTab(getActiveTab()); } catch {}

  // 3) Model time string (uses tFmt)
  try { setModelTimeUi(getActiveTab()); } catch {}

  // 4) Diff nav labels already handled by applyI18nToStaticUi,
  //    but visibility/disabled state can be refreshed.
  try { updateDiffNavButtons(); } catch {}

  // 5) Custom file pickers ("Choose file" / "No file chosen")
  try { applyI18nToFilePickers(); } catch {}
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
      'historyOverlay'
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
// System prompts (Default + up to 4 custom, total 5 incl Default)
// -------------------------
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

let systemPromptStore = null; // { v, prompts: [] }

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
  } catch {}
  appSettingsLoaded = true;
  return appSettings;
}

function _sysNow() { return Date.now(); }

function loadSystemPromptStore() {
  const raw = localStorage.getItem(SYS_PROMPTS_LS_KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.prompts)) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveSystemPromptStore(store) {
  localStorage.setItem(SYS_PROMPTS_LS_KEY, JSON.stringify(store));
}

function ensureSystemPromptStore() {
  let store = loadSystemPromptStore();
  if (!store) store = { v: 1, prompts: [] };

  // Ensure Default exists and is always the current built-in prompt (reset behaviour)
  const now = _sysNow();
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
    store.prompts[idx] = {
      ...existing,
      ...defObj,
      createdAt: existing.createdAt || now,
      updatedAt: now
    };
    // Keep Default at top
    if (idx !== 0) {
      store.prompts.splice(idx, 1);
      store.prompts.unshift(defObj);
    }
  }

  // De-dupe by id, keep first occurrence (Default already at top)
  const seen = new Set();
  store.prompts = store.prompts.filter(p => {
    if (!p || !p.id) return false;
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // Enforce max (always keep Default + first N-1 customs)
  if (store.prompts.length > SYS_PROMPTS_MAX) {
    const def = store.prompts.find(p => p.id === DEFAULT_SYS_PROMPT_ID);
    const customs = store.prompts.filter(p => p.id !== DEFAULT_SYS_PROMPT_ID).slice(0, SYS_PROMPTS_MAX - 1);
    store.prompts = [def, ...customs].filter(Boolean);
  }

  saveSystemPromptStore(store);
  systemPromptStore = store;
  return store;
}

function getSystemPromptById(id) {
  const store = systemPromptStore || ensureSystemPromptStore();
  const found = store.prompts.find(p => p.id === id);
  return found || store.prompts.find(p => p.id === DEFAULT_SYS_PROMPT_ID) || {
    id: DEFAULT_SYS_PROMPT_ID, name: 'Default', content: DEFAULT_SYSTEM_PROMPT, locked: true
  };
}


// Keep diff2html scheme class in sync when user toggles app theme
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
      } catch {}

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
    for (const { wrap } of containers) ro.observe(wrap);
  } catch {}

  schedule();
}

// -------------------------
// Diff navigation (Prev/Next change)
// -------------------------
let diffNavObserver = null;
let diffNavVisible = false;
let diffNavIdx = -1; // -1 means "not aligned to a change yet"

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
  } catch {}
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
  const raw = localStorage.getItem(HISTORY_INDEX_KEY);
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
  localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(idx));
}

function clearAllHistory() {
  const idx = loadHistoryIndex();
  for (const it of (idx.items || [])) {
    try { localStorage.removeItem(_historyItemKey(it.id)); } catch {}
  }
  try { localStorage.removeItem(HISTORY_INDEX_KEY); } catch {}
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
      try { localStorage.removeItem(_historyItemKey(removed.id)); } catch {}
    }
  }

  // 1) store payload (evict oldest on quota)
  while (true) {
    try {
      localStorage.setItem(_historyItemKey(id), compressed);
      break;
    } catch (e) {
      if (!_isQuotaError(e)) throw e;
      const removed = idx.items.pop();
      if (!removed || removed.id === id) {
        // can't make space; abort storing this entry
        try { localStorage.removeItem(_historyItemKey(id)); } catch {}
        return;
      }
      try { localStorage.removeItem(_historyItemKey(removed.id)); } catch {}
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
        try { localStorage.removeItem(_historyItemKey(id)); } catch {}
        return;
      }
      try { localStorage.removeItem(_historyItemKey(removed.id)); } catch {}
    }
  }
}

async function loadHistoryPayload(id) {
  const raw = localStorage.getItem(_historyItemKey(String(id || '')));
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

function isHistoryModalOpen() {
  return !document.getElementById('historyOverlay')?.classList.contains('hidden');
}

function openHistoryModal() {
  const overlay = document.getElementById('historyOverlay');
  if (!overlay) return;
  historyIndexCache = loadHistoryIndex();
  historyPage = 0;
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  void renderHistoryPage();
  document.getElementById('historyCloseBtn')?.focus();
}

function closeHistoryModal() {
  const overlay = document.getElementById('historyOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');

  // Only remove modal-open if *no* other modal is open
  const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
  const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
  const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
  const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
  const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
  const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
  const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
  const histOpen = !overlay.classList.contains('hidden');
  const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');

  if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen && !aboutOpen && !histOpen && !langOpen) {
    document.body.classList.remove('modal-open');
  }
  historyIndexCache = null;
  historyPage = 0;
}

async function renderHistoryPage() {
  await ensureAppSettingsLoaded();
  const hintEl = document.getElementById('historyHint');
  const listEl = document.getElementById('historyList');
  const prevBtn = document.getElementById('historyPrevBtn');
  const nextBtn = document.getElementById('historyNextBtn');
  const pageLabel = document.getElementById('historyPageLabel');

  if (hintEl) {
    hintEl.textContent = tFmt('history.hint', { max: appSettings.historyMax }, `Max history size is ${appSettings.historyMax}. Older entries are removed automatically.`);
  }

  const idx = historyIndexCache || loadHistoryIndex();
  const items = Array.isArray(idx.items) ? idx.items : [];
  const pageSize = Math.max(1, Number(appSettings.historyPageSize || 5));
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

  if (pageLabel) pageLabel.textContent = tFmt('history.pageLabel', { page: historyPage + 1, total: totalPages }, `Page ${historyPage + 1} of ${totalPages}`);
  if (prevBtn) prevBtn.disabled = historyPage <= 0;
  if (nextBtn) nextBtn.disabled = historyPage >= (totalPages - 1);
}

// NOTE: addTabAndSelect is provided by ./tabs.js via createTabsManager().
// (Local implementation removed to avoid duplicate declarations.)
 

function doesSystemPromptExist(id) {
  const store = systemPromptStore || ensureSystemPromptStore();
  return !!store.prompts.find(p => p && p.id === id);
}

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

async function openHistoryItemInNewTab(historyId) {
  const payload = await loadHistoryPayload(historyId);
  if (!payload) {
    alert(t('history.loadFailed', 'Could not load this history item (it may have been cleared or storage is corrupted).'));
    return;
  }
  // Safety: ensure tabs module is wired (in case history opens early)
  initTabsManagerOnce();

  ensureSystemPromptStore();
  const fileName = (payload.inputFileName || 'file.txt').trim() || 'file.txt';
  const tab = makeTab(`🕘 ${fileName}`);
  tab.labelCustomized = true;

  tab.selectedModel = payload.model || tab.selectedModel;
  tab.systemPromptId = doesSystemPromptExist(payload.sysPromptId) ? payload.sysPromptId : DEFAULT_SYS_PROMPT_ID;

  tab.diffText = payload.diffText || '';
  tab.modelText = payload.inputText || '';
  tab.originalFileName = fileName;
  tab.modifiedText = payload.outputText || '';
  tab.errorText = '';
  tab.retryCount = 0;
  tab.lastDurationMs = Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : null;
  tab.lastTokenCount = Number.isFinite(Number(payload.tokenCount)) ? Number(payload.tokenCount) : null;

  if (tab.modelText && tab.modifiedText) {
    const html = buildDiffHtml(tab.modelText, tab.modifiedText);
    const holder = ensureTabDiffDom(tab);
    if (holder) holder.innerHTML = html;
  }

  addTabAndSelect(tab);
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

// -------------------------
// API keys: extracted manager (./apikeys.js)
// -------------------------
let apiKeysMgr = null;
function initApiKeysManagerOnce() {
  if (apiKeysMgr) return apiKeysMgr;
  apiKeysMgr = createApiKeyManager({ t, tFmt, ipcRenderer });
  return apiKeysMgr;
}

function updateSystemPromptButtonForTab(tab) {
  const btn = document.getElementById('sysPromptBtn');
  if (!btn) return;
  const p = getSystemPromptById(tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID);
  const rawName = p?.name || 'Default';
  const nm = (p?.id === DEFAULT_SYS_PROMPT_ID) ? t('sysPrompt.defaultName', rawName) : rawName;
  btn.textContent = tFmt('sysPrompt.buttonLabel', { name: nm }, `Prompt - ${nm}`);
  btn.title = tFmt('sysPrompt.buttonTitle', { name: nm }, `System prompt: ${nm}`);
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
   const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
   const renameOpen = !overlay.classList.contains('hidden');
   const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
   const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
   const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
   const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
   const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');

   if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen) {
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
   updateTabRowFor(tab);
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

    overlay.classList.remove('hidden');
    document.body.classList.add('modal-open');

    // Focus Cancel by default (safer)
    setTimeout(() => {
      document.getElementById('tabCloseCancelBtn')?.focus();
    }, 0);
  }

  function closeTabCloseModal() {
    const overlay = document.getElementById('tabCloseOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');

    // Only remove modal-open if *no* other modal is open
    const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
    const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
    const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
    const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
    const closeOpen = !overlay.classList.contains('hidden');
    const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
    const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
    const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
    const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');

    if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen) {
      document.body.classList.remove('modal-open');
    }

    closingTabId = null;
  }

  function confirmTabClose() {
    if (!closingTabId) return;
    doCloseTab(closingTabId);
    closeTabCloseModal();
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
 
  // Only remove modal-open if *no* other modal is open
  const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
  const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
  const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
  const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
  const helpOpen = !overlay.classList.contains('hidden');
  const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
  const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
  const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
  const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');
 
  if (!apiOpen && !typeOpen && !renameOpen && !closeOpen && !helpOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen) {
    document.body.classList.remove('modal-open');
  }
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
  const donateBtn = document.getElementById('aboutDonateBtn');
  const githubBtn = document.getElementById('aboutGitHubBtn');

  const appName = (info?.appName || 'AI Diff Tool').trim();
  const creatorName = (info?.creatorName || '').trim();
  const creatorEmail = (info?.creatorEmail || '').trim();
  const version = (info?.version || '').trim();
  const donationUrl = (info?.donationUrl || '').trim();
  const githubUrl = (info?.githubUrl || '').trim();

  if (appNameEl) appNameEl.textContent = appName;
  if (creatorNameEl) creatorNameEl.textContent = creatorName;

  if (creatorEmailEl) {
    creatorEmailEl.textContent = creatorEmail;
    // mailto: is fine for display + click
    creatorEmailEl.href = creatorEmail ? `mailto:${creatorEmail}` : '#';
  }

  if (versionEl) versionEl.textContent = version || '';

  if (donateBtn) {
    donateBtn.dataset.url = donationUrl;
    const enabled = !!donationUrl;
    donateBtn.disabled = !enabled;
    donateBtn.title = enabled ? 'Open donation page' : 'Donation link not configured (set it in ABOUT_SETTINGS before build)';
  }

  if (githubBtn) {
    githubBtn.dataset.url = githubUrl;
    githubBtn.disabled = !githubUrl;
    githubBtn.title = githubUrl ? 'Open GitHub repository' : 'GitHub URL not configured';
  }
}

async function openAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;

  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');

  // Load once per session (fast), but still safe if null
  if (!aboutInfoCache) aboutInfoCache = await getAboutInfo();
  fillAboutUi(aboutInfoCache || {});

  await setAboutCreatorImage();  // ✅ THIS is “renderer placement”

  document.getElementById('aboutCloseBtn')?.focus();
}

function closeAbout() {
  const overlay = document.getElementById('aboutOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');

  // Only remove modal-open if *no* other modal is open
  const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
  const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
  const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
  const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
  const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
  const sysOpen = !document.getElementById('sysPromptOverlay')?.classList.contains('hidden');
  const aboutOpen = !overlay.classList.contains('hidden');
  const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
  const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');

  if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen) {
    document.body.classList.remove('modal-open');
  }
 }

// -------------------------
// System Prompt modal (single modal: select/create/edit/save)
// -------------------------
let sysPromptModalSelectedId = DEFAULT_SYS_PROMPT_ID;
let sysPromptModalMode = 'view'; // 'view' | 'create' | 'edit'
let sysPromptModalDirty = false;
let sysPromptModalForTabId = null;

function sysPromptEls() {
  return {
    overlay: document.getElementById('sysPromptOverlay'),
    list: document.getElementById('sysPromptList'),
    listHint: document.getElementById('sysPromptListHint'),
    hint: document.getElementById('sysPromptHint'),
    name: document.getElementById('sysPromptNameInput'),
    text: document.getElementById('sysPromptText'),
    btnNew: document.getElementById('sysPromptNewBtn'),
    btnDup: document.getElementById('sysPromptDuplicateBtn'),
    btnDel: document.getElementById('sysPromptDeleteBtn'),
    btnSave: document.getElementById('sysPromptSaveBtn'),
    btnUse: document.getElementById('sysPromptUseBtn'),
    btnClose: document.getElementById('sysPromptCloseBtn'),
    btnCancel: document.getElementById('sysPromptCancelBtn')
  };
}

function renderSysPromptList() {
  const { list, listHint } = sysPromptEls();
  if (!list) return;
  const store = systemPromptStore || ensureSystemPromptStore();
  const tab = tabs.find(t => t.id === sysPromptModalForTabId) || getActiveTab();
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
    name.textContent = (p.id === DEFAULT_SYS_PROMPT_ID) ? t('sysPrompt.defaultName', (p.name || 'Default')) : (p.name || t('sysPrompt.unnamed', '(unnamed)'));

    const badges = document.createElement('div');
    badges.className = 'sys-prompt-item-badges';

    if (p.id === DEFAULT_SYS_PROMPT_ID) {
      const b = document.createElement('span');
      b.className = 'sys-prompt-badge';
      b.textContent = t('sysPrompt.badgeDefault', 'Default');
      badges.appendChild(b);
    }

    if (p.id === inUseId) {
      const b = document.createElement('span');
      b.className = 'sys-prompt-badge';
      b.textContent = t('sysPrompt.badgeInUse', 'In use');
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
    listHint.textContent = tFmt('sysPrompt.listHint', { remaining, max: SYS_PROMPTS_MAX, plural }, `You can save ${remaining} more prompt${plural} (max ${SYS_PROMPTS_MAX} incl. Default).`);
  }
}

function setSysPromptEditorFromSelection() {
  const { name, text, hint, btnSave, btnUse, btnDel } = sysPromptEls();
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
    if (hint) hint.textContent = t('sysPrompt.defaultLockedHint', 'Default prompt cannot be edited. Click “New” or “Duplicate” to create a custom prompt.');
  }

  if (btnSave) btnSave.disabled = locked;
  if (btnDel) btnDel.disabled = locked;
  if (btnUse) btnUse.disabled = false;

  sysPromptModalMode = locked ? 'view' : 'edit';
}

function openSysPromptModal({ tabId = null } = {}) {
  const { overlay, hint, list, name, text, btnSave, btnDel } = sysPromptEls();
  if (!overlay) return;

  ensureSystemPromptStore();
  sysPromptModalForTabId = tabId || activeTabId;
  const tab = tabs.find(t => t.id === sysPromptModalForTabId) || getActiveTab();
  sysPromptModalSelectedId = tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID;
  sysPromptModalDirty = false;
  sysPromptModalMode = 'view';
  if (hint) hint.textContent = '';

  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');

  renderSysPromptList();
  setSysPromptEditorFromSelection();

  // Safety: ensure Default stays locked even if some old store had it wrong
  const p = getSystemPromptById(sysPromptModalSelectedId);
  const locked = !!p.locked || p.id === DEFAULT_SYS_PROMPT_ID;
  if (btnSave) btnSave.disabled = locked;
  if (btnDel) btnDel.disabled = locked;

  // Focus list for quick picking
  setTimeout(() => {
    try { list?.focus?.(); } catch {}
    // If current is editable, focus textarea for quick edits
    if (!locked) {
      try { text?.focus?.(); } catch {}
    } else {
      try { name?.blur?.(); } catch {}
    }
  }, 0);
}

function closeSysPromptModal() {
  const { overlay } = sysPromptEls();
  if (!overlay) return;
  overlay.classList.add('hidden');

  // Only remove modal-open if *no* other modal is open
  const helpOpen = !document.getElementById('helpOverlay')?.classList.contains('hidden');
  const apiOpen = !document.getElementById('apiKeyOverlay')?.classList.contains('hidden');
  const typeOpen = !document.getElementById('keyTypeOverlay')?.classList.contains('hidden');
  const renameOpen = !document.getElementById('tabRenameOverlay')?.classList.contains('hidden');
  const closeOpen = !document.getElementById('tabCloseOverlay')?.classList.contains('hidden');
  const sysOpen = !overlay.classList.contains('hidden');
  const aboutOpen = !document.getElementById('aboutOverlay')?.classList.contains('hidden');
  const historyOpen = !document.getElementById('historyOverlay')?.classList.contains('hidden');
  const langOpen = !document.getElementById('languageOverlay')?.classList.contains('hidden');

  if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen && !aboutOpen && !historyOpen && !langOpen) {
    document.body.classList.remove('modal-open');
  }

  sysPromptModalDirty = false;
  sysPromptModalMode = 'view';
  sysPromptModalForTabId = null;
}

function beginCreatePromptFrom(baseId) {
  const { name, text, hint, btnSave, btnDel } = sysPromptEls();
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

  if (hint) hint.textContent = t('sysPrompt.createHint', 'Creating a new custom prompt. Enter a name, edit the text, then Save.');
  setTimeout(() => {
    try { name.focus(); name.select(); } catch {}
  }, 0);
}

function normalizeName(s) { return (s || '').trim(); }

function isNameTaken(name, ignoreId = null) {
  const store = systemPromptStore || ensureSystemPromptStore();
  const n = normalizeName(name).toLowerCase();
  return store.prompts.some(p => p.id !== ignoreId && (p.name || '').trim().toLowerCase() === n);
}

function createPromptId() {
  return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function handleSysPromptSave() {
  const { name, text, hint } = sysPromptEls();
  const store = systemPromptStore || ensureSystemPromptStore();
  if (!name || !text) return;
  if (hint) hint.textContent = '';

  const selected = getSystemPromptById(sysPromptModalSelectedId);
  const selectedLocked = !!selected.locked || selected.id === DEFAULT_SYS_PROMPT_ID;

  const nm = normalizeName(name.value);
  const content = (text.value || '').trimEnd();

  if (sysPromptModalMode === 'create') {
    if (!nm) { if (hint) hint.textContent = t('sysPrompt.msg.nameRequired', 'Prompt name is required.'); return; }
    if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = t('sysPrompt.msg.defaultReserved', '“Default” is reserved. Choose another name.'); return; }
    if (isNameTaken(nm, null)) { if (hint) hint.textContent = t('sysPrompt.msg.nameTaken', 'A prompt with this name already exists.'); return; }
    if (!content.trim()) { if (hint) hint.textContent = t('sysPrompt.msg.textRequired', 'System prompt text is required.'); return; }

    if (store.prompts.length >= SYS_PROMPTS_MAX) {
      if (hint) hint.textContent = tFmt('sysPrompt.msg.maxPrompts', { max: SYS_PROMPTS_MAX }, `Max ${SYS_PROMPTS_MAX} prompts allowed (including Default). Delete one to add a new one.`);
      return;
    }

    const now = _sysNow();
    const id = createPromptId();
    store.prompts.push({
      id,
      name: nm,
      content,
      locked: false,
      createdAt: now,
      updatedAt: now
    });

    saveSystemPromptStore(store);
    systemPromptStore = store;
    sysPromptModalSelectedId = id;
    sysPromptModalMode = 'edit';
    sysPromptModalDirty = false;
    if (hint) hint.textContent = t('sysPrompt.msg.saved', 'Saved.');
    renderSysPromptList();
    setSysPromptEditorFromSelection();
    return;
  }

  // Editing existing custom prompt
  if (selectedLocked) {
    if (hint) hint.textContent = t('sysPrompt.msg.cantEditDefault', 'Default prompt cannot be edited.');
    return;
  }

  if (!nm) { if (hint) hint.textContent = t('sysPrompt.msg.nameRequired', 'Prompt name is required.'); return; }
  if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = t('sysPrompt.msg.defaultReserved', '“Default” is reserved. Choose another name.'); return; }
  if (isNameTaken(nm, selected.id)) { if (hint) hint.textContent = t('sysPrompt.msg.nameTaken', 'A prompt with this name already exists.'); return; }
  if (!content.trim()) { if (hint) hint.textContent = t('sysPrompt.msg.textRequired', 'System prompt text is required.'); return; }

  const i = store.prompts.findIndex(p => p.id === selected.id);
  if (i === -1) { if (hint) hint.textContent = t('sysPrompt.msg.notFound', 'Could not find this prompt in storage.'); return; }

  store.prompts[i] = {
    ...store.prompts[i],
    name: nm,
    content,
    updatedAt: _sysNow()
  };
  saveSystemPromptStore(store);
  systemPromptStore = store;
  sysPromptModalDirty = false;
  if (hint) hint.textContent = t('sysPrompt.msg.saved', 'Saved.');
  renderSysPromptList();
}

function handleSysPromptUse() {
  const { hint } = sysPromptEls();
  const tab = tabs.find(t => t.id === sysPromptModalForTabId) || getActiveTab();
  if (!tab) return;

  if (sysPromptModalDirty) {
    if (hint) hint.textContent = t('sysPrompt.msg.unsaved', 'You have unsaved changes. Save before using this prompt.');
    return;
  }

  tab.systemPromptId = sysPromptModalSelectedId || DEFAULT_SYS_PROMPT_ID;
  if (tab.id === activeTabId) updateSystemPromptButtonForTab(tab);
  // also refresh badges in list ("In use")
  renderSysPromptList();
  closeSysPromptModal();
}

function handleSysPromptDelete() {
  const { hint } = sysPromptEls();
  const store = systemPromptStore || ensureSystemPromptStore();
  const p = getSystemPromptById(sysPromptModalSelectedId);
  if (!p || p.id === DEFAULT_SYS_PROMPT_ID || p.locked) {
    if (hint) hint.textContent = t('sysPrompt.msg.cantDeleteDefault', 'Default prompt cannot be deleted.');
    return;
  }

  const ok = confirm(tFmt('sysPrompt.confirmDelete', { name: p.name }, `Delete system prompt “${p.name}”?`));
  if (!ok) return;

  const nextPrompts = store.prompts.filter(x => x.id !== p.id);
  store.prompts = nextPrompts;
  saveSystemPromptStore(store);
  systemPromptStore = store;

  // Any tabs using this prompt revert to Default
  for (const t of tabs) {
    if (t.systemPromptId === p.id) t.systemPromptId = DEFAULT_SYS_PROMPT_ID;
  }

  sysPromptModalSelectedId = DEFAULT_SYS_PROMPT_ID;
  sysPromptModalMode = 'view';
  sysPromptModalDirty = false;
  if (hint) hint.textContent = t('sysPrompt.msg.deleted', 'Deleted.');
  renderSysPromptList();
  setSysPromptEditorFromSelection();

  // Active tab button label might need update
  const active = getActiveTab();
  if (active) updateSystemPromptButtonForTab(active);
}

function handleSysPromptDuplicate() {
  beginCreatePromptFrom(sysPromptModalSelectedId || DEFAULT_SYS_PROMPT_ID);
}

// Load stored API key and model on app start
window.addEventListener('load', () => {
  void (async () => {
    await initI18n();
    applyI18nToStaticUi();
    applyI18nToFilePickers();

    const storedModel = localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';
    document.getElementById('modelSelect').value = storedModel;

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
    document.getElementById('copyBtn').addEventListener('click', copyOutput);
    document.getElementById('download').addEventListener('click', downloadResult);

    // Localized file pickers (custom UI triggers the hidden native inputs)
    document.getElementById('diffFileBtn')?.addEventListener('click', () => {
      document.getElementById('diffFile')?.click();
    });
    document.getElementById('modelFileBtn')?.addEventListener('click', () => {
      document.getElementById('modelFile')?.click();
    });

    document.getElementById('modelSelect').addEventListener('change', (e) => {
      // Per-tab model selection (does NOT change other tabs)
      const tab = getActiveTab();
      if (tab) tab.selectedModel = e.target.value;
      localStorage.setItem('selectedModel', e.target.value); // default for new tabs / next launch
    });

    // Tabs
    ensureSystemPromptStore();
    initTabsManagerOnce();
    initTabs();
    document.getElementById('newTabBtn')?.addEventListener('click', newTab);

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

    // --- About overlay wiring ---
    const aboutOverlay = document.getElementById('aboutOverlay');
    const aboutCloseBtn = document.getElementById('aboutCloseBtn');
    const aboutOkBtn = document.getElementById('aboutOkBtn');
    const aboutDonateBtn = document.getElementById('aboutDonateBtn');
    const aboutGitHubBtn = document.getElementById('aboutGitHubBtn');

    if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', closeAbout);
    if (aboutOkBtn) aboutOkBtn.addEventListener('click', closeAbout);

    if (aboutOverlay) {
      aboutOverlay.addEventListener('click', (e) => {
        if (e.target === aboutOverlay) closeAbout();
      });
    }

    // External open for Donate/GitHub (URLs injected on openAbout)
    if (aboutDonateBtn) {
      aboutDonateBtn.addEventListener('click', () => {
        const url = (aboutDonateBtn.dataset.url || '').trim();
        if (url) ipcRenderer.send('external:open', url);
      });
    }
    if (aboutGitHubBtn) {
      aboutGitHubBtn.addEventListener('click', () => {
        const url = (aboutGitHubBtn.dataset.url || '').trim();
        if (url) ipcRenderer.send('external:open', url);
      });
    }

    // --- API keys / local encryption flow (extracted to ./apikeys.js) ---
    const apiKeys = initApiKeysManagerOnce();
    apiKeys.wireDomEvents();       // attaches API key + key-type modal listeners
    apiKeys.bootstrapApiKeyFlow(); // startup unlock/setup flow

    // Keep handle for ESC logic below
    const apiOverlay = document.getElementById('apiKeyOverlay');
 
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

    // --- Tab close modal wiring ---
    const tabCloseOverlay = document.getElementById('tabCloseOverlay');
    const tabCloseCloseBtn = document.getElementById('tabCloseCloseBtn');
    const tabCloseCancelBtn = document.getElementById('tabCloseCancelBtn');
    const tabCloseConfirmBtn = document.getElementById('tabCloseConfirmBtn');

    if (tabCloseCloseBtn) tabCloseCloseBtn.addEventListener('click', closeTabCloseModal);
    if (tabCloseCancelBtn) tabCloseCancelBtn.addEventListener('click', closeTabCloseModal);
    if (tabCloseConfirmBtn) tabCloseConfirmBtn.addEventListener('click', confirmTabClose);

    if (tabCloseOverlay) {
      tabCloseOverlay.addEventListener('click', (e) => {
        if (e.target === tabCloseOverlay) closeTabCloseModal();
      });
    }

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

    // --- System prompt button + modal wiring ---
    const sysBtn = document.getElementById('sysPromptBtn');
    if (sysBtn) sysBtn.addEventListener('click', () => openSysPromptModal({ tabId: activeTabId }));

    const sp = sysPromptEls();
    if (sp.btnClose) sp.btnClose.addEventListener('click', closeSysPromptModal);
    if (sp.btnCancel) sp.btnCancel.addEventListener('click', closeSysPromptModal);
    if (sp.btnNew) sp.btnNew.addEventListener('click', () => beginCreatePromptFrom(DEFAULT_SYS_PROMPT_ID));
    if (sp.btnDup) sp.btnDup.addEventListener('click', handleSysPromptDuplicate);
    if (sp.btnSave) sp.btnSave.addEventListener('click', handleSysPromptSave);
    if (sp.btnUse) sp.btnUse.addEventListener('click', handleSysPromptUse);
    if (sp.btnDel) sp.btnDel.addEventListener('click', handleSysPromptDelete);

    if (sp.overlay) {
      sp.overlay.addEventListener('click', (e) => {
        if (e.target === sp.overlay) closeSysPromptModal();
      });
    }

    if (sp.list && sp.list.dataset.delegated !== '1') {
      sp.list.dataset.delegated = '1';
      sp.list.addEventListener('click', (e) => {
        const row = e.target?.closest?.('.sys-prompt-item');
        if (!row?.dataset?.promptId) return;
        if (sysPromptModalDirty) {
          const ok = confirm('Discard unsaved changes?');
          if (!ok) return;
        }
        sysPromptModalSelectedId = row.dataset.promptId;
        renderSysPromptList();
        setSysPromptEditorFromSelection();
      });
    }

    // Track dirty state for Save/Use gating
    if (sp.name) sp.name.addEventListener('input', () => { sysPromptModalDirty = true; });
    if (sp.text) sp.text.addEventListener('input', () => { sysPromptModalDirty = true; });

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
      const sysOpen = sp.overlay && !sp.overlay.classList.contains('hidden');
      const histOpen = historyOverlay && !historyOverlay.classList.contains('hidden');
      const langOpen = langOverlay && !langOverlay.classList.contains('hidden');

      if (langOpen) closeLanguageModal();
      else if (histOpen) closeHistoryModal();
      else if (sysOpen) closeSysPromptModal();
      else if (aboutOpen) closeAbout();
      else if (closeOpen) closeTabCloseModal();
      else if (renameOpen) closeTabRenameModal();
      else if (apiOpen) {
        initApiKeysManagerOnce().closeApiKeyModal();
      }
      else if (helpOpen) closeHelp();
    });

    // --- History modal wiring ---
    const historyOverlay = document.getElementById('historyOverlay');
    const historyCloseBtn = document.getElementById('historyCloseBtn');
    const historyOkBtn = document.getElementById('historyOkBtn');
    const historyClearBtn = document.getElementById('historyClearBtn');
    const historyPrevBtn = document.getElementById('historyPrevBtn');
    const historyNextBtn = document.getElementById('historyNextBtn');
    const historyList = document.getElementById('historyList');

    if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistoryModal);
    if (historyOkBtn) historyOkBtn.addEventListener('click', closeHistoryModal);
    if (historyPrevBtn) historyPrevBtn.addEventListener('click', () => { historyPage = Math.max(0, historyPage - 1); void renderHistoryPage(); });
    if (historyNextBtn) historyNextBtn.addEventListener('click', () => { historyPage = historyPage + 1; void renderHistoryPage(); });

    if (historyClearBtn) {
      historyClearBtn.addEventListener('click', () => {
        const ok = confirm('Clear all history? This cannot be undone.');
        if (!ok) return;
        clearAllHistory();
        historyIndexCache = loadHistoryIndex();
        historyPage = 0;
        void renderHistoryPage();
      });
    }

    if (historyOverlay) {
      historyOverlay.addEventListener('click', (e) => {
        if (e.target === historyOverlay) closeHistoryModal();
      });
    }

    if (historyList && historyList.dataset.delegated !== '1') {
      historyList.dataset.delegated = '1';
      historyList.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button[data-action="open-history"]');
        const id = btn?.dataset?.historyId;
        if (!id) return;
        void openHistoryItemInNewTab(id).then(() => {
          closeHistoryModal();
        });
      });
    }

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

    })(); // end async load wrapper
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
  openSysPromptModal({ tabId: activeTabId });
});

ipcRenderer.on('history:open', () => {
  openHistoryModal();
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
   const applyBtn = document.getElementById('applyBtn');
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
   retryBtn.classList.add('hidden');

   if (!isRetry) tab.retryCount = 0;

   if (!diffText || !modelContent) {
     errorEl.textContent = 'Please fill Diff Patch and File Content.';
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
   updateTabRowFor(tab); // fast spinner update

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
       baseURL: apiKeys.baseUrlForProvider(provider),
       dangerouslyAllowBrowser: true  // Enable for Electron renderer; key is user-provided and local
     });
     console.log('OpenAI SDK initialized with browser allowance.');

     const userPrompt = `Original file content:\n\n${modelContentSnapshot}\n\nDiff patch to apply:\n\n${diffTextSnapshot}\n\nApply the patch and output the exact resulting file.`;
     const messages = [
       { role: 'system', content: systemPromptSnapshot },
       { role: 'user', content: userPrompt }
     ];

     const t0 = _nowMs();
     const completion = await openai.chat.completions.create({
       model: selectedModelSnapshot,
       messages,
       temperature: 0.2,
       max_tokens: 32768  // Higher for large files; per docs
     });

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
       void addHistoryEntry({
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
     } catch {}

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
       updateTabRowFor(tab); // fast spinner update
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
document.getElementById('diffFile')?.addEventListener('change', async (e) => {
  const input = e.target;
  const file = input?.files?.[0] || null;
  setFilePickerName('diff', file?.name || '');
  if (!file) return;
  const text = await file.text();
  document.getElementById('diff').value = text;
  try { initTabsManagerOnce(); } catch {}
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
  try { initTabsManagerOnce(); } catch {}
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