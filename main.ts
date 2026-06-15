import { app, BrowserWindow, ipcMain, dialog, shell, screen, clipboard, IpcMainInvokeEvent } from 'electron';
import path from 'path';
import url from 'url';
import fs from 'fs';
import https from 'https';
import { autoUpdater } from 'electron-updater';
import { scanDirectory } from './src/scanner';
import * as ffmpeg from './src/ffmpeg';
import * as music from './src/music';
import { estimateMergeBytes } from './src/ffargs';
import * as log from './src/logger';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function errStack(e: unknown): string {
  return e instanceof Error && e.stack ? e.stack : String(e);
}

const GH_OWNER = 'Alli1223';
const GH_REPO = 'video-merging-tool';
const RELEASES_URL = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/latest`;

// Auto-update (download + self-install) only makes sense for the installed
// (NSIS) build. The portable single-exe can't replace itself and dev runs
// aren't packaged — those fall back to "a newer release exists, open the page".
const canAutoUpdate = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;

let mainWindow: BrowserWindow | null = null;
let lastScanDir: string | null = null;

// Persisted output/encoding preferences (userData/settings.json).
const DEFAULT_SETTINGS: Settings = {
  resolution: 'auto', fps: 'auto', encoder: 'auto', codec: 'hevc', quality: 'near',
  split: 'off', // max size per output file ('off' = single file)
  verify: true, // post-merge integrity check (decode/spot-check + auto-repair)
  // Background music tuning (the selection of tracks is per-session, not saved).
  musicVibe: 'mix', musicCrossfade: 4, musicFadeOut: 5, musicVolume: 100
};
let settings: Settings = { ...DEFAULT_SETTINGS };

function settingsFile(): string { return path.join(app.getPath('userData'), 'settings.json'); }
function musicCacheDir(): string { return path.join(app.getPath('userData'), 'music-cache'); }
function loadSettings(): void {
  try { settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
}
function saveSettings(): void {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); }
  catch (e) { log.error('Could not save settings:', errMsg(e)); }
}

function createWindow(): void {
  // Fit the window within the screen's work area so the top bar and footer
  // (and their buttons) are never pushed off-screen on smaller or scaled
  // displays — e.g. a 1366x768 laptop can't fully show an 880px-tall window,
  // which would clip the Shuffle button (top) and Merge button (bottom).
  const { width: waW, height: waH } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: Math.min(1280, waW - 40),
    height: Math.min(820, waH - 60),
    minWidth: Math.min(820, waW - 20),
    minHeight: Math.min(540, waH - 40),
    center: true,
    backgroundColor: '#0f1218',
    title: 'Video Merging Tool',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  win.center();

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F12 toggles dev tools, handy while developing.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    log.setLogFile(path.join(logDir, 'app.log'));
  } catch (e) {
    console.error('Could not set up log file:', e);
  }
  log.info(`Video Merging Tool ${app.getVersion()} starting | platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged}`);
  log.info('FFmpeg binaries:', ffmpeg.binaryInfo());
  loadSettings();
  log.info('Settings:', settings);
  ffmpeg.detectEncoders().then((e) => log.info('NVENC available:', e)).catch(() => {});

  createWindow();
  setupAutoUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on('uncaughtException', (e) => log.error('uncaughtException:', errStack(e)));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', errStack(e)));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder of videos',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('scan:directory', async (_e: IpcMainInvokeEvent, dir: string): Promise<ScanResult> => {
  lastScanDir = dir;
  try {
    return await scanDirectory(dir);
  } catch (e) {
    log.error('scan:directory failed for', dir, '-', errStack(e));
    throw e;
  }
});

ipcMain.handle('thumbs:generate', async (_e: IpcMainInvokeEvent, items: ThumbInput[]): Promise<boolean> => {
  await ffmpeg.generateThumbnails(items, (thumb) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('thumb:done', thumb);
    }
  });
  return true;
});

ipcMain.handle('dialog:saveOutput', async (_e: IpcMainInvokeEvent, defaultName?: string): Promise<string | null> => {
  if (!mainWindow) return null;
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

ipcMain.handle('merge:start', async (_e: IpcMainInvokeEvent, opts: MergePayload): Promise<MergeResult> => {
  const fullOpts: MergeOptions = { ...opts, settings };
  log.info('merge:start', { clips: opts && opts.clips && opts.clips.length, output: opts && opts.outputPath, forceReencode: opts && opts.forceReencode, settings });
  try {
    const res = await ffmpeg.merge(fullOpts, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('merge:progress', progress);
      }
    });
    log.info('merge finished:', res);
    return res;
  } catch (e) {
    log.error('merge failed:', errStack(e));
    throw e;
  }
});

ipcMain.handle('merge:cancel', async (): Promise<boolean> => {
  ffmpeg.cancel();
  return true;
});

// ---------------------------------------------------------------------------
// Size estimate + free-space check
// ---------------------------------------------------------------------------

// Estimate the merged output size for the given clips. The renderer passes its
// own settings + flags so the estimate matches exactly what it will produce.
ipcMain.handle('estimate:size', (_e: IpcMainInvokeEvent, payload?: EstimatePayload): SizeEstimate => {
  const p = payload || {};
  try {
    return estimateMergeBytes(p.clips || [], p.settings || settings, p.opts || {});
  } catch (e) {
    log.warn('estimate:size failed:', errMsg(e));
    return { bytes: 0, peakBytes: 0, exact: false, pureCopy: false };
  }
});

// Free space on the volume that holds targetPath (its parent directory).
ipcMain.handle('disk:freeSpace', async (_e: IpcMainInvokeEvent, targetPath: string): Promise<FreeSpace> => {
  try {
    const dir = path.dirname(targetPath || lastScanDir || app.getPath('documents'));
    const st = await fs.promises.statfs(dir);
    const freeBytes = (st.bavail != null ? st.bavail : st.bfree) * st.bsize;
    return { freeBytes, mount: path.parse(dir).root || dir };
  } catch (e) {
    log.warn('disk:freeSpace failed:', errMsg(e));
    return { freeBytes: 0, mount: null };
  }
});

// Native confirm dialog (used for the "not enough space" warning). Returns true
// if the user chose the confirm (first) button.
ipcMain.handle('dialog:confirm', async (_e: IpcMainInvokeEvent, o?: ConfirmOptions): Promise<boolean> => {
  const opt = o || {};
  if (!mainWindow) return false;
  const res = await dialog.showMessageBox(mainWindow, {
    type: opt.type || 'warning',
    buttons: [opt.confirmText || 'OK', opt.cancelText || 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: opt.title || 'Confirm',
    message: opt.message || '',
    detail: opt.detail || ''
  });
  return res.response === 0;
});

// ---------------------------------------------------------------------------
// Background music (fetched on demand from the Internet Archive, cached locally)
// ---------------------------------------------------------------------------
ipcMain.handle('music:sources', (): SourceInfo => music.sourceInfo());
ipcMain.handle('music:vibes', (): Vibe[] => music.listVibes());

ipcMain.handle('music:fetch', async (_e: IpcMainInvokeEvent, opts?: FetchMusicOpts): Promise<MusicResult> => {
  log.info('music:fetch requested', opts || {});
  try {
    const res = await music.fetchTracks({
      cacheDir: musicCacheDir(),
      vibe: (opts && opts.vibe) || 'mix',
      poolSize: (opts && opts.poolSize) || 8,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('music:progress', p);
      }
    });
    log.info('music:fetch ready —', res.trackPaths.length, 'track(s),', res.credits.length, 'source(s)');
    return res;
  } catch (e) {
    log.error('music:fetch failed:', errStack(e));
    throw e;
  }
});

ipcMain.handle('music:cacheInfo', (): CacheInfo => music.cacheInfo(musicCacheDir()));
ipcMain.handle('music:clearCache', (): boolean => music.clearCache(musicCacheDir()));
ipcMain.handle('music:openSource', async (): Promise<boolean> => { await shell.openExternal(music.sourceInfo().browseUrl); return true; });

ipcMain.handle('shell:showItem', async (_e: IpcMainInvokeEvent, p: string): Promise<boolean> => {
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('util:fileUrl', async (_e: IpcMainInvokeEvent, p: string): Promise<string> => {
  return url.pathToFileURL(p).toString();
});

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

function sendUpdate(payload: UpdateStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', payload);
  }
}

// Simple x.y.z comparison: is `a` newer than `b`?
function isNewer(a: string, b: string): boolean {
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
function checkLatestManually(): void {
  const opts = { headers: { 'User-Agent': GH_REPO, Accept: 'application/vnd.github+json' } };
  https.get(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`, opts, (res) => {
    let data = '';
    res.on('data', (d: Buffer) => { data += d; });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data) as { tag_name?: string };
        const tag = String((parsed || {}).tag_name || '').replace(/^v/, '');
        if (tag && isNewer(tag, app.getVersion())) {
          sendUpdate({ state: 'available', version: tag, canAutoUpdate: false });
        } else {
          sendUpdate({ state: 'none' });
        }
      } catch (e) {
        sendUpdate({ state: 'error', message: errMsg(e) });
      }
    });
  }).on('error', (e) => sendUpdate({ state: 'error', message: errMsg(e) }));
}

function runUpdateCheck(): void {
  if (canAutoUpdate) {
    autoUpdater.checkForUpdates().catch((e) =>
      sendUpdate({ state: 'error', message: errMsg(e) }));
  } else {
    // Portable build or running from source: can't self-install, but we can
    // still tell the user whether a newer release exists (manual GitHub check).
    checkLatestManually();
  }
}

function setupAutoUpdates(): void {
  autoUpdater.autoDownload = false;        // wait for the user to click Download
  autoUpdater.autoInstallOnAppQuit = true; // but install a downloaded update on quit

  autoUpdater.on('checking-for-update', () => sendUpdate({ state: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendUpdate({ state: 'available', version: info.version, canAutoUpdate: true }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('error', (err) =>
    sendUpdate({ state: 'error', message: errMsg(err) }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'progress', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdate({ state: 'downloaded', version: info.version }));
}

// The renderer triggers the launch-time check once it is ready to receive events.
ipcMain.handle('update:check', async (): Promise<boolean> => { runUpdateCheck(); return true; });
ipcMain.handle('update:download', async (): Promise<boolean> => {
  try { await autoUpdater.downloadUpdate(); }
  catch (e) { sendUpdate({ state: 'error', message: errMsg(e) }); }
  return true;
});
ipcMain.handle('update:install', async (): Promise<boolean> => { autoUpdater.quitAndInstall(); return true; });
ipcMain.handle('update:openReleases', async (): Promise<boolean> => { await shell.openExternal(RELEASES_URL); return true; });

ipcMain.handle('app:getVersion', (): string => app.getVersion());

// Logging — the renderer forwards its console/errors here, and the Settings
// dialog can open the log file or its folder.
ipcMain.handle('log:write', (_e: IpcMainInvokeEvent, level: LogLevel, message: string): boolean => {
  const fn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
  fn('[renderer]', message);
  return true;
});
ipcMain.handle('log:open', async (): Promise<string | null> => {
  const f = log.getLogFile();
  if (f) await shell.openPath(f);
  return f;
});
ipcMain.handle('log:reveal', async (): Promise<string | null> => {
  const f = log.getLogFile();
  if (f) shell.showItemInFolder(f);
  return f;
});
ipcMain.handle('log:path', (): string | null => log.getLogFile());
ipcMain.handle('clipboard:write', (_e: IpcMainInvokeEvent, text: unknown): boolean => { clipboard.writeText(String(text == null ? '' : text)); return true; });

// Output / encoding settings + GPU encoder availability.
ipcMain.handle('settings:get', (): Settings => settings);
ipcMain.handle('settings:set', (_e: IpcMainInvokeEvent, partial?: Partial<Settings>): Settings => {
  settings = { ...settings, ...(partial || {}) };
  saveSettings();
  log.info('Settings updated:', settings);
  return settings;
});
ipcMain.handle('encoder:info', async (): Promise<EncoderInfo> => {
  try { return await ffmpeg.detectEncoders(); }
  catch { return { h264_nvenc: false, hevc_nvenc: false }; }
});
