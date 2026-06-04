const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal API surface exposed to the renderer. The renderer never gets
// direct access to Node, FFmpeg, or the filesystem — everything goes through
// these IPC calls which are handled in the main process.
contextBridge.exposeInMainWorld('api', {
  // Open a native folder picker. Resolves to the chosen path, or null if canceled.
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),

  // Scan a directory: probe every video file and return ordered clip metadata.
  scanDirectory: (dir) => ipcRenderer.invoke('scan:directory', dir),

  // Kick off thumbnail generation for the given clips. Thumbnails stream back
  // one at a time via the onThumb subscription below.
  generateThumbnails: (items) => ipcRenderer.invoke('thumbs:generate', items),
  onThumb: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('thumb:done', handler);
    return () => ipcRenderer.removeListener('thumb:done', handler);
  },

  // Native save dialog for the merged output file.
  saveOutput: (defaultName) => ipcRenderer.invoke('dialog:saveOutput', defaultName),

  // Start a merge. Progress streams back via onMergeProgress.
  startMerge: (opts) => ipcRenderer.invoke('merge:start', opts),
  onMergeProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('merge:progress', handler);
    return () => ipcRenderer.removeListener('merge:progress', handler);
  },
  cancelMerge: () => ipcRenderer.invoke('merge:cancel'),

  // Reveal a file in the OS file manager.
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),

  // Convert an absolute path to a file:// URL (used for the preview player).
  fileUrl: (p) => ipcRenderer.invoke('util:fileUrl', p),

  // App info.
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Logging / diagnostics.
  log: (level, message) => ipcRenderer.invoke('log:write', level, message),
  openLogFile: () => ipcRenderer.invoke('log:open'),
  revealLogFile: () => ipcRenderer.invoke('log:reveal'),
  getLogPath: () => ipcRenderer.invoke('log:path'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  // Output / encoding settings + GPU encoder availability.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  getEncoderInfo: () => ipcRenderer.invoke('encoder:info'),

  // Auto-update (from the GitHub releases page).
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:openReleases'),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  }
});
