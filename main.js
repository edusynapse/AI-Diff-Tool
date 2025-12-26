const { app, BrowserWindow, Menu, ipcMain, shell} = require('electron');
const path = require('path');  

let isDark = false;

// About/settings (bundled inside app.asar when packaged)
// These are the values you asked to come from "settings within the app bundle".
// Donation URL intentionally empty for now; set it before building.
const ABOUT_SETTINGS = Object.freeze({
  creatorName: 'Surajit Ray',
  creatorEmail: 'surajit@edusynapse.com',
  githubUrl: 'https://github.com/edusynapse/AI-Diff-Tool',
  donationUrl: '' // set before build
});

const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icons', '512x512.png')
  : path.join(__dirname, 'build', 'icons', '512x512.png');

ipcMain.handle('about:getInfo', () => {
  return {
    appName: app.getName(),
    version: app.getVersion(),
    ...ABOUT_SETTINGS
  };
});

ipcMain.handle("creator-image-path", () => {
  if (!app.isPackaged) {
    return path.join(__dirname, "build", "creator.png"); // dev
  }
  return path.join(process.resourcesPath, "creator.png"); // packaged
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
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),

    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'xAI API Key…',
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('apikey:open', { provider: 'xai' });
            }
          }
        },
        {
          label: 'OpenAI API Key…',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('apikey:open', { provider: 'openai' });
            }
          }
        },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit' }])
      ]
    },

    // Edit (this brings back Cut/Copy/Paste/Select All etc.)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }] : [{ role: 'delete' }]),
        { type: 'separator' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'System Prompt…',
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
      label: 'View',
      submenu: [
        {
          id: 'toggle-dark-mode',
          label: 'Dark Mode',
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
          label: 'Previous Change',
          accelerator: 'F7',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('diffnav:prev');
            }
          }
        },
        {
          label: 'Next Change',
          accelerator: 'F8',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('diffnav:next');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              { role: 'minimize' },
              { role: 'zoom' },
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ]
          }
        ]
      : [
          {
            label: 'Window',
            submenu: [{ role: 'minimize' }, { role: 'close' }]
          }
        ]),

    // Help
    {
      role: 'help',
      submenu: [
        {
          label: 'Usage',
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
          label: 'About…',
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
      contextIsolation: false
    },
    icon: iconPath
  });

  win.loadFile('index.html');
  //win.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();
  createAppMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});