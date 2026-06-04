const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const url = require('url');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const { scanDirectory } = require('./src/scanner');
const ffmpeg = require('./src/ffmpeg');

const GH_OWNER = 'Alli1223';
const GH_REPO = 'video-merging-tool';
const RELEASES_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`;

// Auto-update (download + self-install) only makes sense for the installed
// (NSIS) build. The portable single-exe can't replace itself and dev runs
// aren't packaged — those fall back to "a newer release exists, open the page".
const canAutoUpdate = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;

let mainWindow = null;
let lastScanDir = null;

function createWindow() {
  // Fit the window within the screen's work area so the top bar and footer
  // (and their buttons) are never pushed off-screen on smaller or scaled
  // displays — e.g. a 1366x768 laptop can't fully show an 880px-tall window,
  // which would clip the Shuffle button (top) and Merge button (bottom).
  const { width: waW, height: waH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1320, waW - 40),
    height: Math.min(880, waH - 40),
    minWidth: Math.min(900, waW - 20),
    minHeight: Math.min(600, waH - 20),
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
  setupAutoUpdates();
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

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

function sendUpdate(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', payload);
  }
}

// Simple x.y.z comparison: is `a` newer than `b`?
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Portable / non-installable builds can't self-replace, so just ask the GitHub
// API whether a newer release exists and, if so, point the user at the page.
function checkLatestManually() {
  const opts = { headers: { 'User-Agent': GH_REPO, Accept: 'application/vnd.github+json' } };
  https.get(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`, opts, (res) => {
    let data = '';
    res.on('data', (d) => { data += d; });
    res.on('end', () => {
      try {
        const tag = String((JSON.parse(data) || {}).tag_name || '').replace(/^v/, '');
        if (tag && isNewer(tag, app.getVersion())) {
          sendUpdate({ state: 'available', version: tag, canAutoUpdate: false });
        } else {
          sendUpdate({ state: 'none' });
        }
      } catch (e) {
        sendUpdate({ state: 'error', message: String((e && e.message) || e) });
      }
    });
  }).on('error', (e) => sendUpdate({ state: 'error', message: String((e && e.message) || e) }));
}

function runUpdateCheck() {
  if (canAutoUpdate) {
    autoUpdater.checkForUpdates().catch((e) =>
      sendUpdate({ state: 'error', message: String((e && e.message) || e) }));
  } else if (app.isPackaged) {
    checkLatestManually(); // portable build
  } else {
    sendUpdate({ state: 'none' }); // dev run — nothing to update
  }
}

function setupAutoUpdates() {
  autoUpdater.autoDownload = false;        // wait for the user to click Download
  autoUpdater.autoInstallOnAppQuit = true; // but install a downloaded update on quit

  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendUpdate({ state: 'available', version: info.version, canAutoUpdate: true }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('error', (err) =>
    sendUpdate({ state: 'error', message: String((err && err.message) || err) }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdate({ state: 'downloaded', version: info.version }));
}

// The renderer triggers the launch-time check once it is ready to receive events.
ipcMain.handle('update:check', async () => { runUpdateCheck(); return true; });
ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); }
  catch (e) { sendUpdate({ state: 'error', message: String((e && e.message) || e) }); }
  return true;
});
ipcMain.handle('update:install', async () => { autoUpdater.quitAndInstall(); return true; });
ipcMain.handle('update:openReleases', async () => { await shell.openExternal(RELEASES_URL); return true; });
