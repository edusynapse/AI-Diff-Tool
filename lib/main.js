const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');

let isDark = false;

// -------------------------
// UI Language (i18n) - Main process
// - Renderer selects language, main rebuilds menu using that pack.
// - Fallback language is EN.
// - Language packs live in build/languages/*.json (dev)
//   and are copied to resourcesPath/languages/*.json (packaged)
// -------------------------
const LANG_FALLBACK = 'EN';
let currentLang = LANG_FALLBACK;
let cachedFallbackPack = null;
const cachedLangPacks = new Map(); // code -> pack
let langSettingsPath = null; // initialized after app is ready

function isLanguageConfigured() {
  if (!langSettingsPath) return false;
  try {
    return fs.existsSync(langSettingsPath);
  } catch {
    return false;
  }
}

function _safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    return null;
  }
}

function normalizeLangCode(code) {
  const c = String(code || '').trim().replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  return c || LANG_FALLBACK;
}

function getLanguagesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'languages')
    : path.join(__dirname, '..', 'build', 'languages');
}

function listAvailableLanguages() {
  const dir = getLanguagesDir();
  const out = new Set([LANG_FALLBACK]);
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => d.name);
    for (const f of files) {
      // Expect files like EN.json, HI.json etc.
      const m = String(f).match(/^([A-Za-z0-9_-]+)\.json$/);
      if (!m) continue;
      out.add(normalizeLangCode(m[1]));
    }
  } catch {
    // no-op (folder may not exist in dev until created)
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function loadLanguagePack(code) {
  const c = normalizeLangCode(code);
  if (cachedLangPacks.has(c)) return cachedLangPacks.get(c);

  const dir = getLanguagesDir();
  const p = path.join(dir, `${c}.json`);
  const pack = _safeReadJson(p) || {};
  cachedLangPacks.set(c, pack);
  return pack;
}

function ensureFallbackPackLoaded() {
  if (cachedFallbackPack) return cachedFallbackPack;
  cachedFallbackPack = loadLanguagePack(LANG_FALLBACK) || {};
  return cachedFallbackPack;
}

function deepGet(obj, keyPath) {
  const parts = String(keyPath || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function tMenu(keyPath, fallbackText) {
  const cur = loadLanguagePack(currentLang) || {};
  const fb = ensureFallbackPackLoaded();
  const v = deepGet(cur, keyPath);
  if (typeof v === 'string' && v.trim()) return v;
  const vf = deepGet(fb, keyPath);
  if (typeof vf === 'string' && vf.trim()) return vf;
  return String(fallbackText || '');
}

function readPersistedLanguage() {
  if (!langSettingsPath) return LANG_FALLBACK;
  try {
    const raw = fs.readFileSync(langSettingsPath, 'utf8');
    const obj = JSON.parse(raw);
    const code = normalizeLangCode(obj?.code || '');
    return code || LANG_FALLBACK;
  } catch {
    return LANG_FALLBACK;
  }
}

function persistLanguage(code) {
  if (!langSettingsPath) return;
  try {
    fs.writeFileSync(
      langSettingsPath,
      JSON.stringify({ v: 1, code: normalizeLangCode(code) }, null, 2),
      'utf8'
    );
  } catch {
    // no-op
  }
}

function resolveLanguage(code) {
  const c = normalizeLangCode(code);
  const list = listAvailableLanguages();
  if (list.includes(c)) return c;
  return LANG_FALLBACK;
}

// Main-process app settings (renderer reads these via IPC)
const APP_SETTINGS = Object.freeze({
  historyMax: 100,
  historyPageSize: 5
});

// About/settings (bundled inside app.asar when packaged)
// These are the values you asked to come from "settings within the app bundle".
// Donation URL intentionally empty for now; set it before building.
const ABOUT_SETTINGS = Object.freeze({
  creatorName: 'Surajit Ray',
  creatorEmail: 'surajit@edusynapse.com',
  githubUrl: 'https://github.com/edusynapse/AI-Diff-Tool',
  donationUrl: '' // set before build
});

// -------------------------
// Razorpay Donate: serve the payment button from a local HTTP origin
// Why:
// - Loading Razorpay inside file:// (or sandboxed srcdoc) yields Origin: null
// - Razorpay APIs block CORS preflight from 'null' origin
// - This local server gives the iframe a real http://127.0.0.1 origin
// -------------------------
const RAZORPAY_PAYMENT_BUTTON_ID = 'pl_RwZR8RzepB0ABH';
let donateServer = null;
let donateServerUrl = '';
let donateServerPromise = null;

function buildRazorpayDonateHtml() {
  // Keep this page minimal and self-contained.
  // NOTE: this page runs in an iframe (renderer subframe).
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'self';
      script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://cdn.razorpay.com https://browser.sentry-cdn.com;
      style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.razorpay.com https://*.razorpay.com;
      font-src https://fonts.gstatic.com data:;
      img-src 'self' data: https://*.razorpay.com https://razorpay.com;
      connect-src https://api.razorpay.com https://*.razorpay.com https://razorpay.com https://*.sentry.io;
      frame-src https://*.razorpay.com https://razorpay.com;
      form-action 'self' https://*.razorpay.com https://razorpay.com;
    " />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      body { margin: 0; padding: 0; }
      form { margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <form>
      <script
        src="https://checkout.razorpay.com/v1/payment-button.js"
        data-payment_button_id="${RAZORPAY_PAYMENT_BUTTON_ID}"
        async
      ></script>
    </form>

    <script>
      (function () {
        function getH() {
          var de = document.documentElement;
          var b = document.body;
          var h1 = de ? (de.scrollHeight || de.offsetHeight || 0) : 0;
          var h2 = b ? (b.scrollHeight || b.offsetHeight || 0) : 0;
          return Math.max(h1, h2, 0);
        }

        var last = 0;
        var raf = null;

        function send(force) {
          var h = getH();
          if (!h) return;
          if (!force && h === last) return;
          last = h;
          try {
            window.parent && window.parent.postMessage({ type: 'rzp:resize', height: h }, '*');
          } catch (e) {}
        }

        function schedule(force) {
          if (raf) return;
          raf = requestAnimationFrame(function () {
            raf = null;
            send(!!force);
          });
        }

        window.addEventListener('load', function () { schedule(true); });
        setTimeout(function () { schedule(true); }, 300);
        setTimeout(function () { schedule(true); }, 900);

        try {
          var mo = new MutationObserver(function () { schedule(true); });
          mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        } catch (e) {}
      })();
    </script>
  </body>
</html>`;
}

function ensureDonateServer() {
  if (donateServerUrl) return Promise.resolve(donateServerUrl);
  if (donateServerPromise) return donateServerPromise;

  donateServerPromise = new Promise((resolve) => {
    try {
      donateServer = http.createServer((req, res) => {
        try {
          const url = String(req.url || '').split('?')[0];
          if (url !== '/razorpay-donate') {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
          }
          const html = buildRazorpayDonateHtml();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          res.end(html);
        } catch {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Server Error');
          } catch {}
        }
      });

      donateServer.once('error', () => {
        donateServerUrl = '';
        donateServerPromise = null;
        resolve('');
      });

      donateServer.listen(0, '127.0.0.1', () => {
        const addr = donateServer.address();
        const port = (addr && typeof addr === 'object') ? addr.port : null;
        donateServerUrl = port ? `http://127.0.0.1:${port}/razorpay-donate` : '';
        resolve(donateServerUrl);
      });
    } catch {
      donateServerUrl = '';
      donateServerPromise = null;
      resolve('');
    }
  });

  return donateServerPromise;
}

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', '512x512.png')
  : path.join(__dirname, '..', 'build', 'icons', '512x512.png');

ipcMain.handle('language:list', () => {
  return listAvailableLanguages();
});

ipcMain.handle('language:getAll', (_evt, code) => {
  // If renderer doesn't pass a code, serve the CURRENT main-process language
  // (which comes from ui_language.json if configured, else fallback).
  const desired = resolveLanguage(code || currentLang);
  const fallback = ensureFallbackPackLoaded();
  const pack = loadLanguagePack(desired) || {};
  return {
    code: desired,
    pack,
    fallback,
    available: listAvailableLanguages(),
    configured: isLanguageConfigured()
  };
});

ipcMain.handle('language:isConfigured', () => {
  return isLanguageConfigured();
});

ipcMain.handle('language:set', (_evt, code) => {
  const next = resolveLanguage(code);
  currentLang = next;
  persistLanguage(next);
  // Rebuild app menu so menu labels update immediately
  try { createAppMenu(); } catch {}
  return { ok: true, code: next };
});

ipcMain.handle('language:getCurrent', () => {
  return currentLang;
});

ipcMain.handle('app:getSettings', () => {
  return APP_SETTINGS;
});

// Full "clean reset":
// - Delete main-process language selection file (ui_language.json)
// - Reset main process language to EN and theme to light (best-effort)
ipcMain.handle('app:cleanReset', async () => {
  // Remove persisted language file (if any)
  try {
    if (langSettingsPath && fs.existsSync(langSettingsPath)) {
      await fsp.unlink(langSettingsPath);
    }
  } catch {
    // ignore
  }

  // Reset main-process state to defaults
  try { currentLang = LANG_FALLBACK; } catch {}
  try { isDark = false; } catch {}

  // Rebuild menu so labels + dark checkbox reset
  try { createAppMenu(); } catch {}

  // Tell renderer to switch to light (renderer will also clear localStorage + reload)
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('theme:set', 'light');
    }
  } catch {}

  return { ok: true };
});

ipcMain.handle('about:getInfo', () => {
  return {
    appName: app.getName(),
    version: app.getVersion(),
    ...ABOUT_SETTINGS
  };
});

ipcMain.handle('razorpay:getDonateUrl', async () => {
  return await ensureDonateServer();
});

ipcMain.handle("creator-image-path", () => {
  if (!app.isPackaged) {
    return path.join(__dirname, "..", "build", "creator.png"); // dev
  }
  return path.join(process.resourcesPath, "creator.png"); // packaged
});

ipcMain.handle("app-icon-path", () => {
  // used for the header icon in the renderer
  if (!app.isPackaged) {
    return path.join(__dirname, "..", "build", "icons", "128x128.png"); // dev
  }
  return path.join(process.resourcesPath, "app-icon.png"); // packaged (extraResources)
});

function isAllowedExternalUrl(url) {
  const u = String(url || '').trim();
  return /^https?:\/\/\S+/i.test(u);
}

ipcMain.on('external:open', (_evt, url) => {
  const u = String(url || '').trim();
  if (!u) return;
  if (!isAllowedExternalUrl(u)) return;
  void shell.openExternal(u);
});

function createAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu (keeps standard mac behavior)
    ...(isMac
      ? [
          {
            label: app.name, // keep app name as-is
            submenu: [
              { role: 'about', label: tMenu('menu.mac.about', 'About') },
              { type: 'separator' },
              { role: 'services', label: tMenu('menu.mac.services', 'Services') },
              { type: 'separator' },
              { role: 'hide', label: tMenu('menu.mac.hide', 'Hide') },
              { role: 'hideOthers', label: tMenu('menu.mac.hideOthers', 'Hide Others') },
              { role: 'unhide', label: tMenu('menu.mac.unhide', 'Unhide') },
              { type: 'separator' },
              { role: 'quit', label: tMenu('menu.mac.quit', 'Quit') }
            ]
          }
        ]
      : []),

    // File
    {
      label: tMenu('menu.file.title', 'File'),
      submenu: [
        {
          label: tMenu('menu.file.xaiKey', 'xAI API Key…'),
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('apikey:open', { provider: 'xai' });
            }
          }
        },
        {
          label: tMenu('menu.file.openaiKey', 'OpenAI API Key…'),
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('apikey:open', { provider: 'openai' });
            }
          }
        },
        { type: 'separator' },
        {
          label: tMenu('menu.file.pinChange', 'PIN Change…'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('pinchange:open');
            }
          }
        },
        {
          label: tMenu('menu.file.cleanReset', 'Clean and Reset…'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('cleanreset:open');
            }
          }
        },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close', label: tMenu('menu.file.close', 'Close') }] : [{ role: 'quit', label: tMenu('menu.file.quit', 'Quit') }])
      ]
    },

    // Edit (this brings back Cut/Copy/Paste/Select All etc.)
    {
      label: tMenu('menu.edit.title', 'Edit'),
      submenu: [
        { role: 'undo', label: tMenu('menu.edit.undo', 'Undo') },
        { role: 'redo', label: tMenu('menu.edit.redo', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: tMenu('menu.edit.cut', 'Cut') },
        { role: 'copy', label: tMenu('menu.edit.copy', 'Copy') },
        { role: 'paste', label: tMenu('menu.edit.paste', 'Paste') },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle', label: tMenu('menu.edit.pasteMatch', 'Paste and Match Style') }, { role: 'delete', label: tMenu('menu.edit.delete', 'Delete') }]
          : [{ role: 'delete', label: tMenu('menu.edit.delete', 'Delete') }]),
        { type: 'separator' },
        { role: 'selectAll', label: tMenu('menu.edit.selectAll', 'Select All') },
        { type: 'separator' },
        {
          label: tMenu('menu.edit.systemPrompt', 'System Prompt…'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('sysprompt:open');
            }
          }
        }
      ]
    },

    // View (we add Dark Mode here, but keep the standard view items)
    {
      label: tMenu('menu.view.title', 'View'),
      submenu: [
        {
          label: tMenu('menu.view.history', 'History…'),
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('history:open');
            }
          }
        },
        {
          label: tMenu('menu.view.language', 'Language…'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('language:open');
            }
          }
        },
        { type: 'separator' },
        {
          id: 'toggle-dark-mode',
          label: tMenu('menu.view.darkMode', 'Dark Mode'),
          type: 'checkbox',
          checked: isDark,
          accelerator: 'CmdOrCtrl+D',
          click: (item) => {
            isDark = item.checked;
            const win = BrowserWindow.getFocusedWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send('theme:set', isDark ? 'dark' : 'light');
            }
          }
        },
        { type: 'separator' },
        {
          label: tMenu('menu.view.prevChange', 'Previous Change'),
          accelerator: 'F7',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('diffnav:prev');
            }
          }
        },
        {
          label: tMenu('menu.view.nextChange', 'Next Change'),
          accelerator: 'F8',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('diffnav:next');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload', label: tMenu('menu.view.reload', 'Reload') },
        { role: 'forceReload', label: tMenu('menu.view.forceReload', 'Force Reload') },
        { role: 'toggleDevTools', label: tMenu('menu.view.devTools', 'Toggle Developer Tools') },
        { type: 'separator' },
        { role: 'resetZoom', label: tMenu('menu.view.resetZoom', 'Actual Size') },
        { role: 'zoomIn', label: tMenu('menu.view.zoomIn', 'Zoom In') },
        { role: 'zoomOut', label: tMenu('menu.view.zoomOut', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: tMenu('menu.view.fullscreen', 'Toggle Full Screen') }
      ]
    },

    // Help
    {
      role: 'help',
      label: tMenu('menu.help.title', 'Help'),
      submenu: [
        {
          label: tMenu('menu.help.usage', 'Usage'),
          accelerator: 'F1',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('help:open');
            }
          }
        },
        { type: 'separator' },
        {
          label: tMenu('menu.help.about', 'About…'),
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('about:open');
            }
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Keep menu checkbox in sync with whatever theme renderer sets (storedTheme etc.)
ipcMain.on('theme:state', (_evt, theme) => {
  isDark = theme === 'dark';
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById('toggle-dark-mode');
  if (item) item.checked = isDark;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Explicit hardening: never expose Node in iframes/subframes.
      // (Default is false in Electron, but we set it explicitly.)
      nodeIntegrationInSubFrames: false
    },
    icon: iconPath
  });

  // IMPORTANT: prevent external pages opened via window.open from inheriting Node integration.
  // Razorpay checkout/payment flows may open popups; we allow them but force a locked-down window.
  try {
    win.webContents.setWindowOpenHandler(({ url }) => {
      const u = String(url || '').trim();

      const isHttp = /^https?:\/\//i.test(u);
      const isAboutBlank = /^about:blank/i.test(u);

      // Allow http(s) + about:blank, but in a sandboxed, no-Node window.
      if (isHttp || isAboutBlank) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true
            }
          }
        };
      }

      // Block everything else by default.
      return { action: 'deny' };
    });
  } catch {}

  win.loadFile(path.join(__dirname, '..', 'index.html'));
  //win.webContents.openDevTools();
}

app.whenReady().then(() => {
  // init language persistence file path
  try {
    langSettingsPath = path.join(app.getPath('userData'), 'ui_language.json');
  } catch {
    langSettingsPath = null;
  }
  currentLang = resolveLanguage(readPersistedLanguage());

  createWindow();
  createAppMenu();
});

app.on('before-quit', () => {
  try { donateServer?.close?.(); } catch {}
  donateServer = null;
  donateServerUrl = '';
  donateServerPromise = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});