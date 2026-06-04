const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const url = require('url');
const { scanDirectory } = require('./src/scanner');
const ffmpeg = require('./src/ffmpeg');

let mainWindow = null;
let lastScanDir = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1218',
    title: 'Video Merging Tool',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F12 toggles dev tools, handy while developing.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder of videos',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('scan:directory', async (_e, dir) => {
  lastScanDir = dir;
  return await scanDirectory(dir);
});

ipcMain.handle('thumbs:generate', async (_e, items) => {
  await ffmpeg.generateThumbnails(items, (thumb) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('thumb:done', thumb);
    }
  });
  return true;
});

ipcMain.handle('dialog:saveOutput', async (_e, defaultName) => {
  const defaultPath = lastScanDir
    ? path.join(lastScanDir, defaultName || 'merged.mp4')
    : (defaultName || 'merged.mp4');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save merged video as',
    defaultPath,
    filters: [
      { name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'm4v', 'webm', 'avi'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('merge:start', async (_e, opts) => {
  return await ffmpeg.merge(opts, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('merge:progress', progress);
    }
  });
});

ipcMain.handle('merge:cancel', async () => {
  ffmpeg.cancel();
  return true;
});

ipcMain.handle('shell:showItem', async (_e, p) => {
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('util:fileUrl', async (_e, p) => {
  return url.pathToFileURL(p).toString();
});
