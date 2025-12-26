const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
const Diff2Html = require('diff2html');  // For rendering as HTML
const { ipcRenderer } = require('electron');
const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 5;  // Warn if larger; adjust based on API limits
let originalFileName = 'file.txt';  // Default for pasted content
let isApiKeyEditable = true;

// -------------------------
// Providers + encrypted key storage
// -------------------------
const PROVIDER_XAI = 'xai';
const PROVIDER_OPENAI = 'openai';
const PROVIDERS = [PROVIDER_XAI, PROVIDER_OPENAI];

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

// LocalStorage keys (encrypted payload + legacy plaintext)
const LS = {
  [PROVIDER_XAI]:    { enc: 'api_key_enc_xai_v1',    plain: 'api_key_xai' },
  [PROVIDER_OPENAI]: { enc: 'api_key_enc_openai_v1', plain: 'api_key_openai' }
};

// PIN/crypto params
const PIN_LEN = 6;
const ENC_VERSION = 1;
const SALT_BYTES = 16;
const AES_GCM_IV_BYTES = 12;
const PBKDF2_ITERS = 150000;

// Session (RAM-only)
let sessionPin = '';
const sessionApiKeys = {
  [PROVIDER_XAI]: '',
  [PROVIDER_OPENAI]: ''
};

// Modal state
let apiModalMode = 'manage';
let apiModalBlocking = false;
let apiModalProvider = PROVIDER_XAI;
let apiModalAskPin = true;
let autoUnlockBusy = false;
let keyTypeBlocking = false;

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
  return `${mins} mins and ${secs} seconds`;
}

function setModelTimeUi(tab) {
  const el = document.getElementById('modelTime');
  if (!el) return;

  if (tab && Number.isFinite(tab.lastDurationMs)) {
    el.textContent = formatDurationMs(tab.lastDurationMs);
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
        stuckCandidates.push({ actions, top: r.top });
      }
    }

    // Pick the candidate closest to the viewport top (max top, but still < rootRect.top)
    let best = null;
    for (const c of stuckCandidates) {
      if (!best || c.top > best.top) best = c;
    }

    if (best) best.actions.classList.add('ta-actions--stuck');
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

function isValidPin(pin) {
  return /^\d{6}$/.test((pin || '').trim());
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
  if (provider === PROVIDER_OPENAI) return { title: 'OpenAI API Key', placeholder: 'sk-...', introKey: 'OpenAI' };
  if (provider === PROVIDER_XAI) return { title: 'xAI API Key', placeholder: 'xai-...', introKey: 'xAI' };
  return { title: 'Unlock API Keys', placeholder: '', introKey: 'saved keys' };
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
      // Keep only digits; allow multi-digit (mobile autofill / paste into one box)
      const digits = (box.value || '').replace(/\D/g, '');

      if (digits.length <= 1) {
        box.value = digits;
        syncHiddenPinFromBoxes();
        if (digits && idx < boxes.length - 1) focusPinBox(idx + 1);
      } else {
        // Spread multi-digit input across remaining boxes starting at idx
        const spread = digits.split('').slice(0, boxes.length - idx);
        spread.forEach((ch, j) => {
          boxes[idx + j].value = ch;
        });
        syncHiddenPinFromBoxes();
        const next = Math.min(idx + spread.length, boxes.length - 1);
        focusPinBox(next);
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

// --- Fast vertical tabstrip: keep DOM rows, update incrementally ---
const tabRowById = new Map();
let _tabsListEl = null;
function getTabsListEl() {
  if (_tabsListEl) return _tabsListEl;
  _tabsListEl = document.getElementById('tabsList');
  return _tabsListEl;
}

function ensureTabsListDelegation() {
  const list = getTabsListEl();
  if (!list || list.dataset.delegated === '1') return;
  list.dataset.delegated = '1';

  // Click: select tab OR close button
  list.addEventListener('click', (e) => {
    const closeBtn = e.target?.closest?.('button.tab-close');
    if (closeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const row = closeBtn.closest('.tab-item');
      if (row?.dataset?.tabId) openTabCloseModal(row.dataset.tabId);
      return;
    }
    const row = e.target?.closest?.('.tab-item');
    if (row?.dataset?.tabId) selectTab(row.dataset.tabId);
  });

  // Double click: rename (ignore double-click on close button)
  list.addEventListener('dblclick', (e) => {
    if (e.target?.closest?.('.tab-close')) return;
    const row = e.target?.closest?.('.tab-item');
    if (row?.dataset?.tabId) openTabRenameModal(row.dataset.tabId);
  });

  // Keyboard on tab rows
  list.addEventListener('keydown', (e) => {
    const row = e.target?.closest?.('.tab-item');
    if (!row?.dataset?.tabId) return;
    const id = row.dataset.tabId;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectTab(id);
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      openTabCloseModal(id);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusAdjacentTab(id, e.key === 'ArrowUp' ? -1 : 1, { select: true });
    }
  });
}

function ensureTabRow(tab) {
  const list = getTabsListEl();
  if (!list || !tab) return null;
  let row = tabRowById.get(tab.id);
  if (row) return row;

  row = document.createElement('div');
  row.className = 'tab-item';
  row.dataset.tabId = tab.id;
  row.setAttribute('role', 'tab');

  const label = document.createElement('div');
  label.className = 'tab-label';
  row.appendChild(label);

  const spin = document.createElement('span');
  spin.className = 'tab-spinner hidden';
  spin.setAttribute('aria-hidden', 'true');
  row.appendChild(spin);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close tab');
  row.appendChild(closeBtn);

  tabRowById.set(tab.id, row);
  return row;
}

function updateTabRowFor(tab) {
  if (!tab) return;
  const row = ensureTabRow(tab);
  if (!row) return;

  const isActive = tab.id === activeTabId;
  const isBusy = !!tab.inFlight;

  row.classList.toggle('active', isActive);
  row.classList.toggle('busy', isBusy);
  row.setAttribute('aria-selected', isActive ? 'true' : 'false');
  row.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  row.tabIndex = isActive ? 0 : -1;

  const label = row.querySelector('.tab-label');
  if (label && label.textContent !== (tab.label || '')) label.textContent = tab.label || '';

  const spin = row.querySelector('.tab-spinner');
  if (spin) spin.classList.toggle('hidden', !isBusy);

  if (isBusy) row.title = 'Processing…';
  else row.removeAttribute('title');
}

function renderTabsFull() {
  const list = getTabsListEl();
  if (!list) return;

  const keep = new Set(tabs.map(t => t.id));
  for (const [id, row] of tabRowById.entries()) {
    if (!keep.has(id)) {
      try { row.remove(); } catch {}
      tabRowById.delete(id);
    }
  }

  const frag = document.createDocumentFragment();
  for (const t of tabs) {
    const row = ensureTabRow(t);
    updateTabRowFor(t);
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

function focusAdjacentTab(fromId, dir /* -1|1 */, { select = false } = {}) {
  const n = tabs.length;
  if (!n) return;
  const idx = Math.max(0, tabs.findIndex(t => t.id === fromId));
  const next = tabs[(idx + dir + n) % n];
  if (!next) return;
  const row = tabRowById.get(next.id);
  if (row) row.focus();
  if (select) selectTab(next.id);
}

// --- Diff DOM caching: avoid innerHTML stringify/parse on every switch ---
function ensureTabDiffDom(tab) {
  if (!tab) return null;
  if (!tab.diffDom) tab.diffDom = document.createElement('div');
  return tab.diffDom;
}

function stashDiffDomIntoTab(tab) {
  const diffView = document.getElementById('diffView');
  if (!tab || !diffView) return;
  const holder = ensureTabDiffDom(tab);
  if (!holder) return;
  holder.replaceChildren();
  // Typically there is a single .d2h-wrapper root => O(1) move
  while (diffView.firstChild) holder.appendChild(diffView.firstChild);
}

function restoreDiffDomFromTab(tab) {
  const diffView = document.getElementById('diffView');
  if (!tab || !diffView) return;
  diffView.replaceChildren();
  // If we have cached DOM, move it back (fast)
  if (tab.diffDom && tab.diffDom.firstChild) {
    while (tab.diffDom.firstChild) diffView.appendChild(tab.diffDom.firstChild);
    return;
  }
  // Fallback for older state (if any)
  if (tab.diffHtml) {
    diffView.innerHTML = tab.diffHtml;
    tab.diffHtml = ''; // stop re-parsing later
  }
}

function makeTab(label) {
  const id = `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    label,
    labelCustomized: false,
    selectedModel: (localStorage.getItem('selectedModel') || document.getElementById('modelSelect')?.value || 'grok-4-fast-reasoning'),
    systemPromptId: DEFAULT_SYS_PROMPT_ID,
    diffText: '',
    modelText: '',
    originalFileName: 'file.txt',
    modifiedText: '',
    diffHtml: '',   // legacy fallback only
    diffDom: null,  // DOM cache for diff view (fast tab switching)
    errorText: '',
    retryCount: 0,
    // Per-tab main scroll position
    scrollTop: 0,
    // NEW
    requestSeq: 0,
    inFlightToken: null,
    inFlight: false,
    lastDurationMs: null
  };
}

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function saveActiveTabFromDom() {
  const tab = getActiveTab();
  if (!tab) return;

  tab.selectedModel = document.getElementById('modelSelect')?.value || tab.selectedModel;
  tab.diffText = document.getElementById('diff').value || '';
  tab.modelText = document.getElementById('model').value || '';
  tab.modifiedText = document.getElementById('output').textContent || '';
  // Diff view: cache DOM, not innerHTML
  stashDiffDomIntoTab(tab);
  tab.errorText = document.getElementById('error').textContent || '';
  tab.originalFileName = originalFileName;
  // Save main scroll per tab
  const mainScroll = getMainScrollEl();
  tab.scrollTop = mainScroll ? mainScroll.scrollTop : 0;
}

function applyTabToDom(tab) {
  // Restore per-tab model selection into the shared dropdown
  const modelSelect = document.getElementById('modelSelect');
  if (modelSelect) {
    const desired = tab.selectedModel || localStorage.getItem('selectedModel') || modelSelect.value;
    // only set if it's a valid option
    const ok = Array.from(modelSelect.options).some(o => o.value === desired);
    if (ok) modelSelect.value = desired;
  }

  document.getElementById('diff').value = tab.diffText || '';
  document.getElementById('model').value = tab.modelText || '';
  document.getElementById('output').textContent = tab.modifiedText || '';
  restoreDiffDomFromTab(tab);
  // If the diff HTML was saved under a different theme, fix its wrapper class now
  syncDiff2HtmlTheme();
  document.getElementById('error').textContent = tab.errorText || '';
  // Output header right-side timing
  setModelTimeUi(tab);
  // System prompt button label (per-tab)
  updateSystemPromptButtonForTab(tab);

  // If any area is currently expanded, re-fit it to the newly applied content
  autoResizeIfExpanded(document.getElementById('diff'));
  autoResizeIfExpanded(document.getElementById('model'));
  autoResizeIfExpanded(document.getElementById('output'));

  originalFileName = tab.originalFileName || 'file.txt';

  // reset file inputs (cannot be set programmatically; safest is to clear)
  const diffFile = document.getElementById('diffFile');
  const modelFile = document.getElementById('modelFile');
  if (diffFile) diffFile.value = '';
  if (modelFile) modelFile.value = '';

  // Restore per-tab scroll AFTER content is in DOM
  const mainScroll = getMainScrollEl();
  if (mainScroll) {
    const desired = Number.isFinite(tab.scrollTop) ? tab.scrollTop : 0;
    requestAnimationFrame(() => {
      const max = Math.max(0, mainScroll.scrollHeight - mainScroll.clientHeight);
      mainScroll.scrollTop = Math.min(Math.max(0, desired), max);
      // Force recompute so we don't rely on IO callback timing
      computeDiffNavVisible();
      updateDiffNavButtons();
    });
  } else {
    computeDiffNavVisible();
    updateDiffNavButtons();
  }

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

function updateSystemPromptButtonForTab(tab) {
  const btn = document.getElementById('sysPromptBtn');
  if (!btn) return;
  const p = getSystemPromptById(tab?.systemPromptId || DEFAULT_SYS_PROMPT_ID);
  const nm = p?.name || 'Default';
  btn.textContent = `Prompt - ${nm}`;
  btn.title = `System prompt: ${nm}`;
}

// NOTE: renderTabs() replaced by incremental tabstrip (renderTabsFull + updateTabRowFor)

function selectTab(tabId) {
  if (tabId === activeTabId) return;
  const prevId = activeTabId;
  saveActiveTabFromDom();
  activeTabId = tabId;
  const tab = getActiveTab();
  if (tab) applyTabToDom(tab);
  // Update only two rows
  if (prevId) {
    const prevTab = tabs.find(t => t.id === prevId);
    if (prevTab) updateTabRowFor(prevTab);
  }
  if (tab) updateTabRowFor(tab);
}

function newTab() {
  const prevId = activeTabId;
  saveActiveTabFromDom();
  const curModel = document.getElementById('modelSelect')?.value || localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';
  const tab = makeTab(`Tab ${tabSeq++}`);
  tab.selectedModel = curModel;
  tabs.push(tab);
  activeTabId = tab.id;
  applyTabToDom(tab);
  // Append only the new row
  const list = getTabsListEl();
  if (list) {
    const row = ensureTabRow(tab);
    updateTabRowFor(tab);
    list.appendChild(row);
    try { row.scrollIntoView({ block: 'nearest' }); } catch {}
  }
  // Update previous active row
  if (prevId) {
    const prevTab = tabs.find(t => t.id === prevId);
    if (prevTab) updateTabRowFor(prevTab);
  }
}

function initTabs() {
  const curModel = document.getElementById('modelSelect')?.value || localStorage.getItem('selectedModel') || 'grok-4-fast-reasoning';
  tabs = [makeTab('Tab 1')];
  tabs[0].selectedModel = curModel;
  tabSeq = 2;
  activeTabId = tabs[0].id;
  applyTabToDom(tabs[0]);
  ensureTabsListDelegation();
  renderTabsFull();
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

  if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen) {
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
   const tab = tabs.find(t => t.id === tabId);
   if (!overlay || !tab) return;

   closingTabId = tabId;
   if (nameEl) nameEl.textContent = tab.label || 'this tab';

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

   if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen) {
     document.body.classList.remove('modal-open');
   }

   closingTabId = null;
 }

 function doCloseTab(tabId) {
   const idx = tabs.findIndex(t => t.id === tabId);
   if (idx === -1) return;

   const t = tabs[idx];
   // If something is in flight, invalidate token so its response is ignored
   t.inFlightToken = null;
   t.inFlight = false;

   const wasActive = activeTabId === tabId;
   tabs.splice(idx, 1);

   // Always keep at least one tab alive
   if (tabs.length === 0) {
     const fresh = makeTab('Tab 1');
     tabs = [fresh];
     tabSeq = 2;
     activeTabId = fresh.id;
     applyTabToDom(fresh);
     ensureTabsListDelegation();
     renderTabsFull();
     return;
   }

   if (wasActive) {
     // pick the next tab (same index after removal) or previous
     const next = tabs[Math.min(idx, tabs.length - 1)] || tabs[0];
     activeTabId = next.id;
     applyTabToDom(next);
   }

   // Remove the row (if present) and refresh active state
   const row = tabRowById.get(tabId);
   if (row) {
     try { row.remove(); } catch {}
   }
   tabRowById.delete(tabId);
   tabs.forEach(updateTabRowFor);
 }

 function confirmTabClose() {
   if (!closingTabId) return;
   doCloseTab(closingTabId);
   closeTabCloseModal();
 }

function getStoredApiKey(provider) {
  return sessionApiKeys[provider] || '';
}

function setApiKeyRowLocked(apiInput, editBtn, maskLen) {
  if (!apiInput || !editBtn) return;
  apiInput.type = 'text'; // show literal asterisks
  apiInput.value = '*'.repeat(Math.max(0, maskLen || 0));
  apiInput.disabled = true; // greyed out via CSS
  editBtn.textContent = 'Update';
  editBtn.dataset.mode = 'locked';
}

function setApiKeyRowEdit(apiInput, editBtn, value = '') {
  if (!apiInput || !editBtn) return;
  apiInput.disabled = false;
  apiInput.type = 'password'; // hide actual key while typing
  apiInput.value = value || '';
  editBtn.textContent = 'Save';
  editBtn.dataset.mode = 'edit';
  setTimeout(() => {
    try {
      apiInput.focus();
      apiInput.select();
    } catch {}
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
      introEl.innerHTML = 'Enter your <b>6-digit PIN</b> to unlock and decrypt saved keys for this session.';
    } else if (!apiModalAskPin && isValidPin(sessionPin)) {
      introEl.innerHTML = `Enter your <b>${ui.introKey} API Key</b>. It will be encrypted locally using the PIN already unlocked for this session.`;
    } else {
      introEl.innerHTML = `Enter your <b>${ui.introKey} API Key</b> and a <b>6-digit PIN</b>. The key is encrypted locally and stored in this app (localStorage). The PIN is not stored.`;
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

  // API key row behavior:
  // - If key exists: show masked, disabled, button "Update"
  // - If no key: editable, button "Save"
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
  if (pinInput) pinInput.value = '';
  clearPinBoxes({ focusIndex: 0 });

  // button labels
  primaryBtn.textContent = 'Unlock';
  primaryBtn.classList.toggle('hidden', mode !== 'unlock');

  // non-disposable / blocking behavior
  if (closeBtn) closeBtn.classList.toggle('hidden', apiModalBlocking);
  if (cancelBtn) cancelBtn.classList.toggle('hidden', apiModalBlocking);

  // focus
  setTimeout(() => {
    if (mode === 'unlock') {
      // focus first PIN box
      focusPinBox(0);
    } else if (apiInput && editBtn) {
      // If locked, focus the Update button; else focus input
      if (apiInput.disabled) editBtn.focus();
      else {
        apiInput.focus();
        apiInput.select();
      }
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

  if (!helpOpen && !renameOpen && !apiOpen && !closeOpen && !typeOpen && !sysOpen) {
    document.body.classList.remove('modal-open');
  }

  // reset
  apiModalBlocking = false;
  apiModalMode = 'manage';
  // clear PIN UI on close
  clearPinBoxes({ focusIndex: 0 });
}

async function handleApiKeyPrimaryClick() {
  // Primary button is ONLY for Unlock mode. If somehow triggered otherwise, treat as Save/Update.
  if (apiModalMode !== 'unlock') {
    await handleApiKeyEditBtnClick();
    return;
  }

  const apiInput = document.getElementById('apiKeyModalInput');
  const pinInput = document.getElementById('apiKeyPinInput'); // hidden aggregator
  const hintEl = document.getElementById('apiKeyModalHint');

  const pin = apiModalAskPin ? getPinFromBoxes() : (sessionPin || '');
  const key = (apiInput?.value || '').trim();

  if (hintEl) hintEl.textContent = '';

  if (!webCrypto?.subtle) {
    if (hintEl) hintEl.textContent = 'WebCrypto is not available in this environment.';
    return;
  }

  // Validate PIN only when required (unlock or first-time setup)
  if (apiModalMode === 'unlock' || apiModalAskPin) {
    if (!isValidPin(pin)) {
      if (hintEl) hintEl.textContent = 'PIN must be exactly 6 digits.';
      clearPinBoxes({ focusIndex: 0 });
      return;
    }
  }

  // UNLOCK MODE: decrypt all saved encrypted keys (xAI + OpenAI) in one go
  if (apiModalMode === 'unlock') {
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
        if (hintEl) hintEl.textContent = 'No encrypted keys found (or data is corrupted).';
        return;
      }

      sessionPin = pin; // keep PIN in RAM for this session

      // close even if blocking (success path)
      closeApiKeyModal({ force: true });
    } catch {
      if (hintEl) hintEl.textContent = 'Invalid PIN (or corrupted stored key). Try again.';
      clearPinBoxes({ focusIndex: 0 });
    }
    return;
  }

  // Non-unlock paths are handled by the same-row Update/Save button.
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
    if (hintEl) hintEl.textContent = 'API key is required.';
    try { apiInput.focus(); } catch {}
    return;
  }

  if (!webCrypto?.subtle) {
    if (hintEl) hintEl.textContent = 'WebCrypto is not available in this environment.';
    return;
  }

  const pin = apiModalAskPin ? getPinFromBoxes() : (sessionPin || '');
  if (apiModalAskPin && !isValidPin(pin)) {
    if (hintEl) hintEl.textContent = 'PIN must be exactly 6 digits.';
    clearPinBoxes({ focusIndex: 0 });
    return;
  }

  try {
    const effectivePin = apiModalAskPin ? pin : sessionPin;
    if (!isValidPin(effectivePin)) {
      if (hintEl) hintEl.textContent = 'PIN is not available in this session. Please unlock first.';
      return;
    }

    const provider = apiModalProvider || PROVIDER_XAI;
    const payload = await encryptApiKeyWithPin(key, effectivePin);
    saveEncryptedPayload(provider, payload);
    sessionApiKeys[provider] = key;
    sessionPin = effectivePin; // keep PIN in RAM for this session

    // If this modal was blocking (startup / apply flow), close immediately after save.
    if (apiModalBlocking) {
      closeApiKeyModal({ force: true });
      return;
    }

    // Otherwise, lock + mask in-place.
    setApiKeyRowLocked(apiInput, editBtn, key.length);
    if (hintEl) hintEl.textContent = 'Saved.';
    // Clear PIN boxes if shown (optional hygiene)
    if (apiModalAskPin) clearPinBoxes({ focusIndex: 0 });
  } catch (e) {
    if (hintEl) hintEl.textContent = `Failed to encrypt and save: ${e?.message || e}`;
  }
 }

function bootstrapApiKeyFlow() {
  // Any encrypted keys exist -> ask once for PIN and decrypt BOTH keys into RAM
  if (hasAnyEncryptedApiKey()) {
    openApiKeyModal({
      provider: 'all',
      mode: 'unlock',
      blocking: true,
      askPin: true,
      hint: 'Enter your 6-digit PIN to unlock saved keys for this session.'
    });
    return;
  }

  // Legacy plaintext migration (pick first provider with legacy)
  for (const p of PROVIDERS) {
    const legacy = loadLegacyPlain(p);
    if (legacy) {
      openApiKeyModal({
        provider: p,
        mode: 'setup',
        blocking: true,
        askPin: true,
        hint: 'Set a 6-digit PIN to encrypt your existing saved API key.',
        prefillKey: legacy
      });
      return;
    }
  }

  // No keys at all -> force provider selection first
  openKeyTypeModal({ blocking: true });
}

function openKeyTypeModal({ blocking = true, hint = '' } = {}) {
  const overlay = document.getElementById('keyTypeOverlay');
  const hintEl = document.getElementById('keyTypeHint');
  if (!overlay) return;
  keyTypeBlocking = !!blocking;
  if (hintEl) hintEl.textContent = hint || '';
  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');
  setTimeout(() => {
    document.getElementById('keyTypeXaiBtn')?.focus();
  }, 0);
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
  if (!helpOpen && !apiOpen && !renameOpen && !closeOpen && !typeOpen && !sysOpen) {
    document.body.classList.remove('modal-open');
  }
  keyTypeBlocking = false;
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
 
  if (!apiOpen && !typeOpen && !renameOpen && !closeOpen && !helpOpen && !sysOpen) {
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
    name.textContent = p.name || '(unnamed)';

    const badges = document.createElement('div');
    badges.className = 'sys-prompt-item-badges';

    if (p.id === DEFAULT_SYS_PROMPT_ID) {
      const b = document.createElement('span');
      b.className = 'sys-prompt-badge';
      b.textContent = 'Default';
      badges.appendChild(b);
    }

    if (p.id === inUseId) {
      const b = document.createElement('span');
      b.className = 'sys-prompt-badge';
      b.textContent = 'In use';
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
    listHint.textContent = `You can save ${remaining} more prompt${remaining === 1 ? '' : 's'} (max ${SYS_PROMPTS_MAX} incl. Default).`;
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
    if (hint) hint.textContent = 'Default prompt cannot be edited. Click “New” or “Duplicate” to create a custom prompt.';
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

  if (!helpOpen && !apiOpen && !typeOpen && !renameOpen && !closeOpen && !sysOpen) {
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

  if (hint) hint.textContent = 'Creating a new custom prompt. Enter a name, edit the text, then Save.';
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
    if (!nm) { if (hint) hint.textContent = 'Prompt name is required.'; return; }
    if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = '“Default” is reserved. Choose another name.'; return; }
    if (isNameTaken(nm, null)) { if (hint) hint.textContent = 'A prompt with this name already exists.'; return; }
    if (!content.trim()) { if (hint) hint.textContent = 'System prompt text is required.'; return; }

    if (store.prompts.length >= SYS_PROMPTS_MAX) {
      if (hint) hint.textContent = `Max ${SYS_PROMPTS_MAX} prompts allowed (including Default). Delete one to add a new one.`;
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
    if (hint) hint.textContent = 'Saved.';
    renderSysPromptList();
    setSysPromptEditorFromSelection();
    return;
  }

  // Editing existing custom prompt
  if (selectedLocked) {
    if (hint) hint.textContent = 'Default prompt cannot be edited.';
    return;
  }

  if (!nm) { if (hint) hint.textContent = 'Prompt name is required.'; return; }
  if (nm.toLowerCase() === 'default') { if (hint) hint.textContent = '“Default” is reserved. Choose another name.'; return; }
  if (isNameTaken(nm, selected.id)) { if (hint) hint.textContent = 'A prompt with this name already exists.'; return; }
  if (!content.trim()) { if (hint) hint.textContent = 'System prompt text is required.'; return; }

  const i = store.prompts.findIndex(p => p.id === selected.id);
  if (i === -1) { if (hint) hint.textContent = 'Could not find this prompt in storage.'; return; }

  store.prompts[i] = {
    ...store.prompts[i],
    name: nm,
    content,
    updatedAt: _sysNow()
  };
  saveSystemPromptStore(store);
  systemPromptStore = store;
  sysPromptModalDirty = false;
  if (hint) hint.textContent = 'Saved.';
  renderSysPromptList();
}

function handleSysPromptUse() {
  const { hint } = sysPromptEls();
  const tab = tabs.find(t => t.id === sysPromptModalForTabId) || getActiveTab();
  if (!tab) return;

  if (sysPromptModalDirty) {
    if (hint) hint.textContent = 'You have unsaved changes. Save before using this prompt.';
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
    if (hint) hint.textContent = 'Default prompt cannot be deleted.';
    return;
  }

  const ok = confirm(`Delete system prompt “${p.name}”?`);
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
  if (hint) hint.textContent = 'Deleted.';
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
    // Per-tab model selection (does NOT change other tabs)
    const tab = getActiveTab();
    if (tab) tab.selectedModel = e.target.value;
    localStorage.setItem('selectedModel', e.target.value); // default for new tabs / next launch
  });

  // Tabs
  ensureSystemPromptStore();
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

  // --- API key modal wiring ---
  const apiOverlay = document.getElementById('apiKeyOverlay');
  const apiCloseBtn = document.getElementById('apiKeyCloseBtn');
  const apiCancelBtn = document.getElementById('apiKeyCancelBtn');
  const apiPrimaryBtn = document.getElementById('apiKeyPrimaryBtn');
  const apiEditBtn = document.getElementById('apiKeyEditBtn');
  const apiKeyModalInput = document.getElementById('apiKeyModalInput');

  if (apiCloseBtn) apiCloseBtn.addEventListener('click', closeApiKeyModal);
  if (apiCancelBtn) apiCancelBtn.addEventListener('click', closeApiKeyModal);
  if (apiPrimaryBtn) apiPrimaryBtn.addEventListener('click', handleApiKeyPrimaryClick);
  if (apiEditBtn) apiEditBtn.addEventListener('click', () => { void handleApiKeyEditBtnClick(); });
  if (apiKeyModalInput) {
    apiKeyModalInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (apiModalMode === 'unlock') return;
      // Enter triggers Save when in edit mode
      const btn = document.getElementById('apiKeyEditBtn');
      if (btn?.dataset?.mode === 'edit') {
        e.preventDefault();
        void handleApiKeyEditBtnClick();
      }
    });
  }

  // PIN boxes wiring (numbers only + auto-advance + backspace)
  setupPinBoxes();

  if (apiOverlay) {
    apiOverlay.addEventListener('click', (e) => {
      if (e.target === apiOverlay) closeApiKeyModal();
    });
  }

  // --- API key bootstrap (PIN unlock/setup on startup) ---
  bootstrapApiKeyFlow();

  // --- Key type overlay wiring ---
  const keyTypeOverlay = document.getElementById('keyTypeOverlay');
  const keyTypeXaiBtn = document.getElementById('keyTypeXaiBtn');
  const keyTypeOpenAiBtn = document.getElementById('keyTypeOpenAiBtn');

  if (keyTypeXaiBtn) keyTypeXaiBtn.addEventListener('click', () => {
    closeKeyTypeModal({ force: true });
    openApiKeyModal({
      provider: PROVIDER_XAI,
      mode: 'setup',
      blocking: true,
      askPin: !isValidPin(sessionPin),
      hint: 'Enter your xAI API key and a 6-digit PIN to save it.'
    });
  });
  if (keyTypeOpenAiBtn) keyTypeOpenAiBtn.addEventListener('click', () => {
    closeKeyTypeModal({ force: true });
    openApiKeyModal({
      provider: PROVIDER_OPENAI,
      mode: 'setup',
      blocking: true,
      askPin: !isValidPin(sessionPin),
      hint: 'Enter your OpenAI API key and a 6-digit PIN to save it.'
    });
  });
  if (keyTypeOverlay) {
    keyTypeOverlay.addEventListener('click', (e) => {
      if (e.target === keyTypeOverlay) closeKeyTypeModal();
    });
  }

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
    const closeOpen = tabCloseOverlay && !tabCloseOverlay.classList.contains('hidden');
    const sysOpen = sp.overlay && !sp.overlay.classList.contains('hidden');

    if (sysOpen) closeSysPromptModal();
    else if (closeOpen) closeTabCloseModal();
    else if (renameOpen) closeTabRenameModal();
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

ipcRenderer.on('sysprompt:open', () => {
  openSysPromptModal({ tabId: activeTabId });
});

ipcRenderer.on('apikey:open', (_evt, payload) => {
  const provider = payload?.provider === PROVIDER_OPENAI ? PROVIDER_OPENAI : PROVIDER_XAI;

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
    provider,
    mode: hasEncryptedApiKey(provider) ? 'manage' : 'setup',
    blocking: false,
    askPin: !isValidPin(sessionPin),
    hint: isValidPin(sessionPin)
      ? 'Enter a new API key to re-encrypt and save (PIN already unlocked for this session).'
      : 'Enter an API key and 6-digit PIN to encrypt and save.'
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
  const selectedModelSnapshot = document.getElementById('modelSelect').value;
  const provider = providerForModel(selectedModelSnapshot);
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
  // 1) If PIN is in RAM and key is stored encrypted but not yet decrypted in this session -> decrypt silently
  await maybeDecryptProviderInSession(provider);

  const apiKey = getStoredApiKey(provider);
  if (!apiKey) {
    // If NO keys exist at all -> choose provider first
    const anyStored = hasAnyEncryptedApiKey() || PROVIDERS.some(p => loadLegacyPlain(p));
    if (!anyStored) {
      openKeyTypeModal({ blocking: true, hint: 'Choose a provider to set up an API key.' });
      return;
    }

    // If keys exist but PIN not unlocked in this session -> unlock once (decrypt both)
    if (hasAnyEncryptedApiKey() && !isValidPin(sessionPin)) {
      openApiKeyModal({
        provider: 'all',
        mode: 'unlock',
        blocking: true,
        askPin: true,
        hint: 'Enter your 6-digit PIN to unlock saved keys for this session.'
      });
      return;
    }

    // Otherwise, we need to set up the missing provider key.
    // If PIN already unlocked in RAM, DO NOT ask for it again.
    openApiKeyModal({
      provider,
      mode: 'setup',
      blocking: true,
      askPin: !isValidPin(sessionPin),
      hint: isValidPin(sessionPin)
        ? `Enter your ${provider === PROVIDER_OPENAI ? 'OpenAI' : 'xAI'} API key to save it (PIN already unlocked for this session).`
        : `Enter your ${provider === PROVIDER_OPENAI ? 'OpenAI' : 'xAI'} API key and a 6-digit PIN to save it.`
    });
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
      baseURL: baseUrlForProvider(provider),
      dangerouslyAllowBrowser: true  // Enable for Electron renderer; key is user-provided and local
    });
    console.log('OpenAI SDK initialized with browser allowance.');

    const userPrompt = `Original file content:\n\n${modelContentSnapshot}\n\nDiff patch to apply:\n\n${diffTextSnapshot}\n\nApply the patch and output the exact resulting file.`;

    const t0 = _nowMs();
    const completion = await openai.chat.completions.create({
      model: selectedModelSnapshot,
      messages: [
        { role: 'system', content: systemPromptSnapshot },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 32768  // Higher for large files; per docs
    });

    const durationMs = _nowMs() - t0;

    let modified = completion.choices[0].message.content;
    // Strip any potential code fences
    modified = modified.replace(/^```[\w]*\n?|\n?```$/g, '').trim();

    // If this response is stale (user started a newer run), ignore it
    if (tab.inFlightToken !== token) {
      return;
    }

    // Store + render timing (model replied)
    tab.lastDurationMs = Math.max(0, Math.round(durationMs));
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