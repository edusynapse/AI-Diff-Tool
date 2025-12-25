const OpenAI = require('openai');  // Loaded via Node integration
const { createTwoFilesPatch } = require('diff');  // For computing diff
const Diff2Html = require('diff2html');  // For rendering as HTML
const { ipcRenderer } = require('electron');
let retryCount = 0;
const MAX_RETRIES = 3;
const MAX_FILE_SIZE_MB = 5;  // Warn if larger; adjust based on API limits
let originalFileName = 'file.txt';  // Default for pasted content
let isKeyEditable = true;  // Moved to top

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
  const storedKey = localStorage.getItem('xaiApiKey');
  if (storedKey) {
    const apiKeyInput = document.getElementById('apiKey');
    apiKeyInput.value = storedKey;
    apiKeyInput.disabled = true;
    document.getElementById('saveKeyBtn').textContent = 'Update';
    isKeyEditable = false;
  }
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
  document.getElementById('saveKeyBtn').addEventListener('click', toggleSaveKey);
  document.getElementById('applyBtn').addEventListener('click', applyPatch);
  document.getElementById('retryBtn').addEventListener('click', applyPatch);
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

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHelp();
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

function toggleSaveKey() {
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveKeyBtn');
  if (isKeyEditable) {
    // Save mode: Save and lock
    const apiKey = apiKeyInput.value;
    if (apiKey) {
      localStorage.setItem('xaiApiKey', apiKey);
      apiKeyInput.disabled = true;
      saveBtn.textContent = 'Update';
      isKeyEditable = false;
    } else {
      localStorage.removeItem('xaiApiKey');
    }
  } else {
    // Update mode: Unlock for edit
    apiKeyInput.disabled = false;
    apiKeyInput.focus();
    saveBtn.textContent = 'Save';
    isKeyEditable = true;
  }
}

async function applyPatch() {
  const diffText = document.getElementById('diff').value;
  const modelContent = document.getElementById('model').value;
  const apiKey = document.getElementById('apiKey').value;
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

  if (!diffText || !modelContent || !apiKey) {
    errorEl.textContent = 'Please fill all fields.';
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
    window.modifiedBlob = new Blob([modified], { type: 'text/plain' });
    retryCount = 0;

    // Compute and display diff view with full context
    const unifiedDiff = createTwoFilesPatch('original', 'modified', modelContent, modified, '', '', { context: Number.MAX_SAFE_INTEGER });
    const html = Diff2Html.html(unifiedDiff, {
      drawFileList: false,
      matching: 'none',  // Disable matching to show all lines
      outputFormat: 'side-by-side',
      synchronisedScroll: true
    });
    diffViewEl.innerHTML = html;

  } catch (error) {
    errorEl.textContent = `Error: ${error.message}. `;
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      errorEl.textContent += `Retry ${retryCount}/${MAX_RETRIES} available.`;
      retryBtn.classList.remove('hidden');
    } else {
      errorEl.textContent += 'Max retries reached.';
    }
    console.error(error);
  } finally {
    loadingEl.classList.add('hidden');
    applyBtn.disabled = false;
  }
}

function downloadResult() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(window.modifiedBlob);
  a.download = 'modified_' + originalFileName;
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
});

// Load model from file
document.getElementById('modelFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const text = await file.text();
  document.getElementById('model').value = text;
  originalFileName = file.name;
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