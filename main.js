const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,  // Enable Node in renderer for file reading
      contextIsolation: false  // For simplicity; in prod, use preload
    }
  });
  win.loadFile('index.html');
  win.webContents.openDevTools();  // For development; remove in prod
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});