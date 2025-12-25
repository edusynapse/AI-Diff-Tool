const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
const Diff2Html = require('diff2html');  // For rendering as HTML
const { ipcRenderer } = require('electron');
const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 5;  // Warn if larger; adjust based on API limits
let originalFileName = 'file.txt';  // Default for pasted content
let isApiKeyEditable = true;

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
    retryCount: 0
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
}

function renderTabs() {
  const list = document.getElementById('tabsList');
  if (!list) return;

  list.innerHTML = '';
  tabs.forEach((t, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-item' + (t.id === activeTabId ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', t.id === activeTabId ? 'true' : 'false');
    btn.dataset.tabId = t.id;

    const label = document.createElement('div');
    label.className = 'tab-label';
    label.textContent = t.label;

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.textContent = String(idx + 1);

    btn.appendChild(label);
    btn.appendChild(meta);

    // click = select
    btn.addEventListener('click', () => selectTab(t.id));

    // dblclick = rename
    btn.addEventListener('dblclick', () => {
      openTabRenameModal(t.id);
    });

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
  return localStorage.getItem('xaiApiKey') || '';
}

function openApiKeyModal({ forceEdit = false, hint = '' } = {}) {
  const overlay = document.getElementById('apiKeyOverlay');
  const input = document.getElementById('apiKeyModalInput');
  const primaryBtn = document.getElementById('apiKeyPrimaryBtn');
  const hintEl = document.getElementById('apiKeyModalHint');

  if (!overlay || !input || !primaryBtn) return;

  const storedKey = getStoredApiKey();

  // show hint if any
  if (hintEl) hintEl.textContent = hint || '';

  overlay.classList.remove('hidden');
  document.body.classList.add('modal-open');

  if (storedKey && !forceEdit) {
    // locked display mode
    input.value = storedKey;
    input.disabled = true;
    primaryBtn.textContent = 'Update';
    isApiKeyEditable = false;
    document.getElementById('apiKeyCloseBtn')?.focus();
  } else {
    // editable mode
    input.value = storedKey || '';
    input.disabled = false;
    primaryBtn.textContent = storedKey ? 'Save' : 'Save';
    isApiKeyEditable = true;
    setTimeout(() => input.focus(), 0);
  }
}

function closeApiKeyModal() {
  const overlay = document.getElementById('apiKeyOverlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function handleApiKeyPrimaryClick() {
  const input = document.getElementById('apiKeyModalInput');
  const primaryBtn = document.getElementById('apiKeyPrimaryBtn');
  if (!input || !primaryBtn) return;

  if (isApiKeyEditable) {
    // Save
    const val = (input.value || '').trim();
    if (!val) {
      // treat empty as "no key"
      localStorage.removeItem('xaiApiKey');
      closeApiKeyModal();
      return;
    }

    localStorage.setItem('xaiApiKey', val);

    // lock it after save
    input.disabled = true;
    primaryBtn.textContent = 'Update';
    isApiKeyEditable = false;

    // close after save (you asked for save/update flow from menu)
    closeApiKeyModal();
  } else {
    // Update mode: unlock for editing
    input.disabled = false;
    isApiKeyEditable = true;
    primaryBtn.textContent = 'Save';
    input.focus();
    input.select();
  }
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
  const toggle = document.getElementById('darkModeToggle');
  if (storedTheme === 'dark') {
    document.body.classList.add('dark');
    toggle.checked = true;
  }
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
  toggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      document.body.classList.add('dark');
      localStorage.setItem('theme', 'dark');
      ipcRenderer.send('theme:state', 'dark');
    } else {
      document.body.classList.remove('dark');
      localStorage.setItem('theme', 'light');
      ipcRenderer.send('theme:state', 'light');
    }
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

  if (apiOverlay) {
    apiOverlay.addEventListener('click', (e) => {
      if (e.target === apiOverlay) closeApiKeyModal();
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

  // ESC should close whichever modal is open
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const renameOpen = renameOverlay && !renameOverlay.classList.contains('hidden');
    const apiOpen = apiOverlay && !apiOverlay.classList.contains('hidden');
    const helpOpen = overlay && !overlay.classList.contains('hidden');

    if (renameOpen) closeTabRenameModal();
    else if (apiOpen) closeApiKeyModal();
    else if (helpOpen) closeHelp();
  });
});

ipcRenderer.on('theme:set', (_evt, theme) => {
  const toggle = document.getElementById('darkModeToggle');
  const shouldDark = theme === 'dark';

  document.body.classList.toggle('dark', shouldDark);
  toggle.checked = shouldDark;
  localStorage.setItem('theme', shouldDark ? 'dark' : 'light');

  // keep the menu checkbox in sync (useful if future changes happen elsewhere)
  ipcRenderer.send('theme:state', shouldDark ? 'dark' : 'light');
});

ipcRenderer.on('help:open', () => {
  openHelp();
});

ipcRenderer.on('apikey:open', () => {
  openApiKeyModal({ forceEdit: false, hint: '' });
});

async function applyPatch({ isRetry = false } = {}) {
  const tab = getActiveTab();
  if (!tab) return;

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
    // requirement: clicking Apply when key missing opens modal
    openApiKeyModal({
      forceEdit: true,
      hint: 'API key is required before you can apply a patch.'
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

  applyBtn.disabled = true;
  loadingEl.classList.remove('hidden');

  try {
    const openai = new OpenAI({
      apiKey,
      baseURL: 'https://api.x.ai/v1',
      dangerouslyAllowBrowser: true  // Enable for Electron renderer; key is user-provided and local
    });
    console.log('OpenAI SDK initialized with browser allowance.');

    const systemPrompt = 'You are an expert at applying unified diff patches to files accurately. Output ONLY the full modified file content after applying the patch. No explanations, extra text, or code fences. Do not wrap in code blocks.';

    const userPrompt = `Original file content:\n\n${modelContent}\n\nDiff patch to apply:\n\n${diffText}\n\nApply the patch and output the exact resulting file.`;

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

    outputEl.textContent = modified;
    downloadBtn.classList.remove('hidden');
    copyBtn.classList.remove('hidden');

    // Compute and display diff view with full context
    const unifiedDiff = createTwoFilesPatch('original', 'modified', modelContent, modified, '', '', { context: Number.MAX_SAFE_INTEGER });
    const html = Diff2Html.html(unifiedDiff, {
      drawFileList: false,
      matching: 'none',  // Disable matching to show all lines
      outputFormat: 'side-by-side',
      synchronisedScroll: true
    });
    diffViewEl.innerHTML = html;

    tab.retryCount = 0;
    tab.modifiedText = modified;
    tab.diffHtml = html;
    tab.errorText = '';

  } catch (error) {
    tab.errorText = `Error: ${error.message}. `;
    if (tab.retryCount < MAX_RETRIES) {
      tab.retryCount++;
      tab.errorText += `Retry ${tab.retryCount}/${MAX_RETRIES} available.`;
      retryBtn.classList.remove('hidden');
    } else {
      tab.errorText += 'Max retries reached.';
    }
    errorEl.textContent = tab.errorText;
    console.error(error);
  } finally {
    loadingEl.classList.add('hidden');
    applyBtn.disabled = false;
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
    if (!tab.labelCustomized && /^Tab\s+\d+$/i.test(tab.label)) {
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