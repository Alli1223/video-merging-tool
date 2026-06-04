'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let clips = [];            // ordered clip objects (thumb filled in async)
let sortMode = 'date-asc';
let selectedId = null;
let folderPath = null;
let merging = false;
let lastOutput = null;
let outputPath = null; // user-chosen save location (null = ask at merge time)

const el = {};
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { return '—'; }
}

const SOURCE_LABEL = {
  metadata: 'metadata',
  filename: 'filename',
  created: 'file created',
  modified: 'file date'
};

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------
// Lossless stream-copy is only safe when every clip shares the same codecs and
// parameters. We derive that from the per-clip compatKey computed during scan.
function compatibility() {
  if (clips.length === 0) return { lossless: false, keys: 0 };
  const keys = new Set(clips.map((c) => c.compatKey));
  return { lossless: keys.size === 1, keys: keys.size };
}

// The "majority" compat key — clips that differ from it are the odd ones out.
function majorityKey() {
  const counts = {};
  for (const c of clips) counts[c.compatKey] = (counts[c.compatKey] || 0) + 1;
  let best = null, bestN = -1;
  for (const k in counts) if (counts[k] > bestN) { best = k; bestN = counts[k]; }
  return best;
}

// How many clips differ from the majority format (the re-encode culprits).
function countMismatched() {
  if (clips.length < 2) return 0;
  const major = majorityKey();
  return clips.filter((c) => c.compatKey !== major).length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll() {
  renderList();
  renderTimeline();
  updateSummary();
  updateMergeControls();
}

function renderList() {
  const list = el.clipList;
  list.innerHTML = '';
  const major = clips.length ? majorityKey() : null;

  clips.forEach((c, i) => {
    const odd = clips.length > 1 && c.compatKey !== major;
    const li = document.createElement('li');
    li.className = 'clip' + (c.id === selectedId ? ' selected' : '') + (odd ? ' compat-warn' : '');
    li.draggable = true;
    li.dataset.id = c.id;
    li.dataset.index = i;

    const audio = c.hasAudio ? `${c.acodec || 'audio'}` : 'no audio';
    const res = c.width && c.height ? `${c.width}×${c.height}` : '—';
    const fps = c.fps ? `${Math.round(c.fps)} fps` : '';

    li.innerHTML = `
      <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
      <div class="clip-index">${i + 1}</div>
      <div class="thumb ${c.thumb ? '' : 'loading'}" ${c.thumb ? `style="background-image:url('${c.thumb}')"` : ''}>
        ${c.thumb ? '' : '🎞️'}
      </div>
      <div class="clip-info">
        <div class="clip-name" title="${escapeAttr(c.name)}">${escapeHtml(c.name)}</div>
        <div class="clip-meta">
          <span title="Source: ${SOURCE_LABEL[c.timeSource] || c.timeSource}">${fmtTime(c.sortTime)}
            <span class="time-source">${SOURCE_LABEL[c.timeSource] || c.timeSource}</span>
          </span>
          <span>${fmtDuration(c.duration)}</span>
          <span class="${odd ? 'tag-warn' : ''}">${res}${fps ? ' · ' + fps : ''}</span>
          <span class="${odd ? 'tag-warn' : ''}">${c.vcodec || '?'} / ${audio}</span>
          <span>${fmtSize(c.size)}</span>
        </div>
      </div>
      <button class="remove-btn" title="Remove from list" data-remove="${c.id}">✕</button>
    `;
    list.appendChild(li);
  });

  attachRowEvents();
}

function renderTimeline() {
  const tl = el.timeline;
  tl.innerHTML = '';
  if (clips.length === 0) {
    tl.innerHTML = '<div class="timeline-empty">The timeline will appear here once a folder is loaded.</div>';
    return;
  }
  const major = majorityKey();

  clips.forEach((c, i) => {
    const odd = clips.length > 1 && c.compatKey !== major;
    // Width is roughly proportional to clip duration, clamped to a sane range.
    const width = Math.max(72, Math.min(Math.round((c.duration || 1) * 3.5), 260));
    const div = document.createElement('div');
    div.className = 'tl-clip' + (odd ? ' compat-warn' : '');
    div.draggable = true;
    div.dataset.id = c.id;
    div.dataset.index = i;
    div.style.width = width + 'px';
    if (c.thumb) div.style.backgroundImage = `url('${c.thumb}')`;
    div.innerHTML = `
      <div class="tl-num">${i + 1}</div>
      <div class="tl-label">
        <div class="tl-name">${escapeHtml(c.name)}</div>
        <div class="tl-dur">${fmtDuration(c.duration)}</div>
      </div>
    `;
    tl.appendChild(div);
  });

  attachTimelineEvents();
}

function updateSummary() {
  const total = clips.reduce((s, c) => s + (c.duration || 0), 0);
  const size = clips.reduce((s, c) => s + (c.size || 0), 0);
  el.clipCount.textContent = clips.length
    ? `${clips.length} clip${clips.length > 1 ? 's' : ''} · ${fmtSize(size)}`
    : '';
  el.totalDuration.textContent = clips.length ? `Total length: ${fmtDuration(total)}` : '';

  const { lossless } = compatibility();
  const badge = el.compatBadge;
  if (clips.length === 0) {
    badge.hidden = true;
  } else if (lossless) {
    badge.hidden = false;
    badge.className = 'badge ok';
    badge.textContent = '✓ Lossless merge';
  } else {
    badge.hidden = false;
    badge.className = 'badge warn';
    badge.textContent = '⚠ Mixed formats — needs re-encode';
  }

  // Offer a one-click way to drop the odd-format clips for a lossless merge.
  const mismatched = countMismatched();
  el.keepCompatBtn.hidden = mismatched === 0;
  if (mismatched > 0) el.keepCompatBtn.textContent = `Drop ${mismatched} mismatched`;
}

// Enable/disable the re-encode toggle and merge button based on current state.
function updateMergeControls() {
  const { lossless } = compatibility();
  const has = clips.length > 0;

  if (!has) {
    el.reencodeToggle.disabled = true;
    el.reencodeToggle.checked = false;
  } else if (!lossless) {
    // Mixed formats: re-encode is mandatory.
    el.reencodeToggle.checked = true;
    el.reencodeToggle.disabled = true;
    el.reencodeLabel.textContent = 'Re-encode (required — clips differ)';
  } else {
    el.reencodeToggle.disabled = merging;
    el.reencodeLabel.textContent = 'Re-encode (lossless when off)';
  }

  el.mergeBtn.disabled = !has || merging;
  el.sortSelect.disabled = !has || merging;
  el.shuffleBtn.disabled = !has || merging;
  el.outputBtn.disabled = !has || merging;
  el.keepCompatBtn.disabled = merging;
  el.openBtn.disabled = merging;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

// ---------------------------------------------------------------------------
// Drag & drop reordering (works from both the list and the timeline)
// ---------------------------------------------------------------------------
let dragId = null;

function indexOfId(id) { return clips.findIndex((c) => c.id === id); }

function moveClip(fromId, toId, after) {
  const from = indexOfId(fromId);
  let to = indexOfId(toId);
  if (from === -1 || to === -1 || fromId === toId) return;
  const [item] = clips.splice(from, 1);
  to = indexOfId(toId); // recompute after removal
  if (after) to += 1;
  clips.splice(to, 0, item);
  setSortMode('custom');
  renderAll();
}

function makeDraggable(node, container) {
  node.addEventListener('dragstart', (e) => {
    dragId = Number(node.dataset.id);
    node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (_) {}
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('dragging');
    container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });
  node.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    if (Number(node.dataset.id) !== dragId) node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop-target');
    const targetId = Number(node.dataset.id);
    if (dragId == null || dragId === targetId) return;
    // Decide insert before/after based on pointer position within the node.
    const rect = node.getBoundingClientRect();
    const horizontal = container === el.timeline;
    const after = horizontal
      ? (e.clientX - rect.left) > rect.width / 2
      : (e.clientY - rect.top) > rect.height / 2;
    moveClip(dragId, targetId, after);
  });
}

function attachRowEvents() {
  el.clipList.querySelectorAll('.clip').forEach((li) => {
    makeDraggable(li, el.clipList);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.remove-btn')) return;
      selectClip(Number(li.dataset.id));
    });
    const rm = li.querySelector('.remove-btn');
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      removeClip(Number(rm.dataset.remove));
    });
  });
}

function attachTimelineEvents() {
  el.timeline.querySelectorAll('.tl-clip').forEach((div) => {
    makeDraggable(div, el.timeline);
    div.addEventListener('click', () => selectClip(Number(div.dataset.id)));
  });
}

// ---------------------------------------------------------------------------
// Selection + preview
// ---------------------------------------------------------------------------
async function selectClip(id) {
  selectedId = id;
  const c = clips.find((x) => x.id === id);
  renderList();
  if (!c) return;

  el.previewPane.hidden = false;
  document.querySelector('.body').classList.add('has-preview');

  try {
    el.previewVideo.src = await window.api.fileUrl(c.path);
  } catch (_) { /* preview is best-effort */ }

  el.previewInfo.innerHTML = `
    <div><b>${escapeHtml(c.name)}</b></div>
    <div>Recorded: ${fmtTime(c.sortTime)} <span class="time-source">${SOURCE_LABEL[c.timeSource] || c.timeSource}</span></div>
    <div>Duration: ${fmtDuration(c.duration)} · ${fmtSize(c.size)}</div>
    <div>Video: ${c.width}×${c.height} · ${Math.round(c.fps)} fps · ${c.vcodec || '?'} (${c.pixfmt || '?'})</div>
    <div>Audio: ${c.hasAudio ? `${c.acodec} · ${c.sampleRate} Hz · ${c.channels} ch` : 'none'}</div>
  `;
}

function removeClip(id) {
  clips = clips.filter((c) => c.id !== id);
  if (selectedId === id) {
    selectedId = null;
    el.previewPane.hidden = true;
    document.querySelector('.body').classList.remove('has-preview');
    el.previewVideo.removeAttribute('src');
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function setSortMode(mode) {
  sortMode = mode;
  const customOpt = el.sortSelect.querySelector('option[value="custom"]');
  if (mode === 'custom') {
    customOpt.hidden = false;
    el.sortSelect.value = 'custom';
  } else {
    el.sortSelect.value = mode;
  }
}

function applySort(mode) {
  setSortMode(mode);
  if (mode === 'date-asc') clips.sort((a, b) => (a.sortTime - b.sortTime) || a.name.localeCompare(b.name));
  else if (mode === 'date-desc') clips.sort((a, b) => (b.sortTime - a.sortTime) || a.name.localeCompare(b.name));
  else if (mode === 'name-asc') clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (mode === 'name-desc') clips.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  renderAll();
}

// Randomize the clip order (Fisher–Yates). Result is a "custom" order that can
// still be hand-tweaked by dragging afterwards. Click again to re-shuffle.
function shuffleClips() {
  if (merging || clips.length < 2) return;
  for (let i = clips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clips[i], clips[j]] = [clips[j], clips[i]];
  }
  setSortMode('custom');
  renderAll();
}

// Drop the clips whose format differs from the majority so the remaining set
// can be merged losslessly (no re-encode needed).
function keepCompatibleOnly() {
  if (merging || clips.length < 2) return;
  const major = majorityKey();
  const removed = clips.filter((c) => c.compatKey !== major);
  if (!removed.length) return;
  clips = clips.filter((c) => c.compatKey === major);
  if (removed.some((c) => c.id === selectedId)) {
    selectedId = null;
    el.previewPane.hidden = true;
    document.querySelector('.body').classList.remove('has-preview');
    el.previewVideo.removeAttribute('src');
  }
  renderAll();
  setStatus(`Removed ${removed.length} clip(s) of a different format — the rest can merge losslessly.`);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
async function openFolder() {
  const dir = await window.api.openFolder();
  if (!dir) return;
  await scan(dir);
}

async function scan(dir) {
  folderPath = dir;
  el.folderPath.textContent = dir;
  outputPath = null;
  updateOutputDisplay();
  setStatus('');
  resetMergeUi();

  // Loading UI
  el.emptyState.hidden = true;
  el.listContainer.hidden = true;
  el.loadingState.hidden = false;
  el.loadingText.textContent = 'Scanning videos and reading metadata…';

  let result;
  try {
    result = await window.api.scanDirectory(dir);
  } catch (e) {
    el.loadingState.hidden = true;
    el.emptyState.hidden = false;
    setStatus('Could not read that folder: ' + (e.message || e), 'error');
    return;
  }

  clips = result.clips.map((c) => ({ ...c, thumb: null }));
  el.loadingState.hidden = true;

  if (clips.length === 0) {
    el.emptyState.hidden = false;
    setStatus('No video files found in that folder.', 'error');
    return;
  }

  el.listContainer.hidden = false;
  selectedId = null;
  el.previewPane.hidden = true;
  document.querySelector('.body').classList.remove('has-preview');
  setSortMode('date-asc');
  renderAll();

  // Fill in thumbnails asynchronously.
  window.api.generateThumbnails(clips.map((c) => ({ path: c.path, duration: c.duration })));
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
async function startMerge() {
  if (clips.length === 0 || merging) return;
  const reencode = el.reencodeToggle.checked;
  const { lossless } = compatibility();
  const mode = (!lossless || reencode) ? 'reencode' : 'copy';

  // Use the location the user already chose, or ask now.
  let target = outputPath;
  if (!target) {
    target = await window.api.saveOutput(suggestedOutputName());
    if (!target) return;
    outputPath = target;
    updateOutputDisplay();
  }
  lastOutput = target;

  merging = true;
  resetMergeUi();
  el.progressWrap.hidden = false;
  el.cancelBtn.hidden = false;
  el.mergeBtn.hidden = true;
  el.showBtn.hidden = true;
  setProgress(0);
  setStatus(mode === 'copy'
    ? 'Merging losslessly (stream copy)…'
    : 'Re-encoding and merging — this can take a while…');
  updateMergeControls();

  const payload = {
    outputPath: target,
    mode,
    clips: clips.map((c) => ({
      path: c.path,
      duration: c.duration,
      hasVideo: c.hasVideo,
      hasAudio: c.hasAudio,
      width: c.width,
      height: c.height,
      fps: c.fps
    }))
  };

  try {
    const res = await window.api.startMerge(payload);
    if (res && res.canceled) {
      setStatus('Merge canceled.', 'error');
    } else {
      setProgress(100);
      setStatus(`Done — saved to ${res.outputPath}`, 'success');
      el.showBtn.hidden = false;
    }
  } catch (e) {
    setStatus('Merge failed: ' + (e.message || e), 'error');
  } finally {
    merging = false;
    el.cancelBtn.hidden = true;
    el.mergeBtn.hidden = false;
    el.progressWrap.hidden = el.showBtn.hidden ? true : el.progressWrap.hidden;
    updateMergeControls();
  }
}

function resetMergeUi() {
  el.progressWrap.hidden = true;
  el.showBtn.hidden = true;
  setProgress(0);
}

function setProgress(pct) {
  el.progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.progressText.textContent = Math.round(pct) + '%';
}

function setStatus(msg, kind) {
  el.statusMsg.textContent = msg;
  el.statusMsg.className = 'status-msg' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Output location
// ---------------------------------------------------------------------------
function suggestedOutputName() {
  const base = (folderPath ? folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'merged') || 'merged';
  const { lossless } = compatibility();
  const ext = (!lossless || el.reencodeToggle.checked) ? 'mp4' : ((clips[0] && clips[0].ext) || 'mp4');
  return `${base}_merged.${ext}`;
}

async function chooseOutput() {
  const picked = await window.api.saveOutput(suggestedOutputName());
  if (!picked) return;
  outputPath = picked;
  updateOutputDisplay();
}

function updateOutputDisplay() {
  if (!el.outputPath) return;
  if (outputPath) {
    el.outputPath.textContent = outputPath;
    el.outputPath.title = outputPath;
    el.outputPath.classList.add('set');
  } else {
    el.outputPath.textContent = "You'll be asked where to save when you click Merge";
    el.outputPath.title = '';
    el.outputPath.classList.remove('set');
  }
}

// ---------------------------------------------------------------------------
// Auto-update banner
// ---------------------------------------------------------------------------
function handleUpdateStatus(p) {
  if (!p) return;
  const banner = el.updateBanner;
  if (p.state === 'available') {
    el.updateText.textContent = `A new version (v${p.version}) is available.`;
    if (p.canAutoUpdate) {
      el.updateActionBtn.textContent = '⬇ Download & install';
      el.updateActionBtn.onclick = () => window.api.downloadUpdate();
    } else {
      el.updateActionBtn.textContent = '↗ Open releases page';
      el.updateActionBtn.onclick = () => window.api.openReleases();
    }
    el.updateActionBtn.disabled = false;
    banner.hidden = false;
  } else if (p.state === 'progress') {
    el.updateText.textContent = `Downloading update… ${Math.round(p.percent || 0)}%`;
    el.updateActionBtn.disabled = true;
    banner.hidden = false;
  } else if (p.state === 'downloaded') {
    el.updateText.textContent = `Update v${p.version} is ready to install.`;
    el.updateActionBtn.textContent = '↻ Restart & install';
    el.updateActionBtn.onclick = () => window.api.installUpdate();
    el.updateActionBtn.disabled = false;
    banner.hidden = false;
  }
  // 'checking' / 'none' / 'error' → leave the banner hidden (silent).
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function init() {
  el.openBtn = $('openBtn');
  el.openBtn2 = $('openBtn2');
  el.sortSelect = $('sortSelect');
  el.shuffleBtn = $('shuffleBtn');
  el.folderPath = $('folderPath');
  el.emptyState = $('emptyState');
  el.listContainer = $('listContainer');
  el.loadingState = $('loadingState');
  el.loadingText = $('loadingText');
  el.clipList = $('clipList');
  el.clipCount = $('clipCount');
  el.previewPane = $('previewPane');
  el.previewVideo = $('previewVideo');
  el.previewInfo = $('previewInfo');
  el.timeline = $('timeline');
  el.totalDuration = $('totalDuration');
  el.compatBadge = $('compatBadge');
  el.reencodeToggle = $('reencodeToggle');
  el.reencodeLabel = $('reencodeLabel');
  el.statusMsg = $('statusMsg');
  el.progressWrap = $('progressWrap');
  el.progressBar = $('progressBar');
  el.progressText = $('progressText');
  el.mergeBtn = $('mergeBtn');
  el.cancelBtn = $('cancelBtn');
  el.showBtn = $('showBtn');
  el.outputBtn = $('outputBtn');
  el.outputPath = $('outputPath');
  el.keepCompatBtn = $('keepCompatBtn');
  el.updateBanner = $('updateBanner');
  el.updateText = $('updateText');
  el.updateActionBtn = $('updateActionBtn');
  el.updateDismiss = $('updateDismiss');

  el.openBtn.addEventListener('click', openFolder);
  el.openBtn2.addEventListener('click', openFolder);
  el.sortSelect.addEventListener('change', (e) => applySort(e.target.value));
  el.shuffleBtn.addEventListener('click', shuffleClips);
  el.mergeBtn.addEventListener('click', startMerge);
  el.cancelBtn.addEventListener('click', () => window.api.cancelMerge());
  el.showBtn.addEventListener('click', () => { if (lastOutput) window.api.showItemInFolder(lastOutput); });
  el.outputBtn.addEventListener('click', chooseOutput);
  el.keepCompatBtn.addEventListener('click', keepCompatibleOnly);
  el.updateDismiss.addEventListener('click', () => { el.updateBanner.hidden = true; });

  // Thumbnails stream in one by one.
  window.api.onThumb(({ path, thumb }) => {
    const c = clips.find((x) => x.path === path);
    if (!c || !thumb) return;
    c.thumb = thumb;
    updateThumb(c);
  });

  // Live merge progress.
  window.api.onMergeProgress((p) => {
    if (typeof p.percent === 'number') setProgress(p.percent);
  });

  // Auto-update: listen for status from main, then check the releases page.
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.checkForUpdate();
  updateOutputDisplay();
}

// Update just the thumbnail images for a clip (avoids a full re-render flicker).
function updateThumb(c) {
  document.querySelectorAll(`.clip[data-id="${c.id}"] .thumb`).forEach((t) => {
    t.classList.remove('loading');
    t.textContent = '';
    t.style.backgroundImage = `url('${c.thumb}')`;
  });
  document.querySelectorAll(`.tl-clip[data-id="${c.id}"]`).forEach((t) => {
    t.style.backgroundImage = `url('${c.thumb}')`;
  });
}

document.addEventListener('DOMContentLoaded', init);
