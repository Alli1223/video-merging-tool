'use strict';

// Forward uncaught renderer errors to the log file so problems are visible.
window.addEventListener('error', (e) => {
  try { window.api.log('error', 'renderer error: ' + ((e.error && e.error.stack) || e.message)); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { window.api.log('error', 'renderer unhandledrejection: ' + ((e.reason && e.reason.stack) || e.reason)); } catch (_) {}
});

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
let lastStatusText = '';
let settings = { resolution: 'auto', fps: 'auto', encoder: 'auto', codec: 'hevc', quality: 'near' };
let encoderInfo = { h264_nvenc: false, hevc_nvenc: false };
let mergeStartTime = 0;

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

// Named output resolutions (kept in sync with src/ffargs.js RESOLUTIONS).
const RES = { 2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };

// Resolve the output target {W,H,F} from settings + clips (for display + the
// "what will happen" summary). The main process resolves it authoritatively.
function resolveTargetLocal() {
  let W = 0, H = 0, F = 0;
  for (const c of clips) { if (c.width > W) W = c.width; if (c.height > H) H = c.height; if (c.fps > F) F = c.fps; }
  W = Math.max(2, W - (W % 2)); H = Math.max(2, H - (H % 2));
  F = F > 0 ? Math.min(Math.round(F), 60) : 30;
  if (RES[settings.resolution]) { W = RES[settings.resolution][0]; H = RES[settings.resolution][1]; }
  if (settings.fps && settings.fps !== 'auto') { const f = parseInt(settings.fps, 10); if (f > 0) F = f; }
  return { W, H, F };
}

function matchesTargetLocal(c, t, codec) {
  return c.width === t.W && c.height === t.H && Math.round(c.fps || 0) === t.F && c.vcodec === codec;
}

// What the merge will produce given the current clips + settings.
function outputPlan() {
  const t = resolveTargetLocal();
  const codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
  const matching = clips.filter((c) => matchesTargetLocal(c, t, codec)).length;
  const allCompat = clips.length > 0 && new Set(clips.map((c) => c.compatKey)).size === 1;
  const pureCopy = clips.length > 0 && matching === clips.length && allCompat;
  const nvencKey = codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc';
  const usingGpu = settings.encoder === 'nvenc' || (settings.encoder === 'auto' && encoderInfo[nvencKey]);
  const encLabel = settings.encoder === 'cpu' ? 'CPU' : (usingGpu ? 'GPU' : 'CPU');
  return { t, codec, matching, pureCopy, encLabel };
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

  const badge = el.compatBadge;
  if (clips.length === 0) {
    badge.hidden = true;
    el.keepCompatBtn.hidden = true;
    if (el.outputInfo) el.outputInfo.textContent = '';
    return;
  }

  const plan = outputPlan();
  if (el.outputInfo) {
    el.outputInfo.textContent = `→ ${plan.t.W}×${plan.t.H} @ ${plan.t.F}fps · ${plan.codec === 'hevc' ? 'HEVC' : 'H.264'} (${plan.encLabel})`;
  }
  badge.hidden = false;
  if (plan.pureCopy) {
    badge.className = 'badge ok';
    badge.textContent = '✓ Lossless — all clips match the target';
  } else if (plan.matching > 0) {
    badge.className = 'badge ok';
    badge.textContent = `✓ ${plan.matching} kept lossless · ${clips.length - plan.matching} re-encoded`;
  } else {
    badge.className = 'badge warn';
    badge.textContent = `Re-encoding all ${clips.length} clips to target`;
  }

  // Offer a one-click way to drop clips that differ from the majority format.
  const mismatched = countMismatched();
  el.keepCompatBtn.hidden = mismatched === 0;
  if (mismatched > 0) el.keepCompatBtn.textContent = `Drop ${mismatched} mismatched`;
}

// Enable/disable controls based on current state.
function updateMergeControls() {
  const has = clips.length > 0;

  // The toggle now means "force re-encode everything" (override keep-lossless).
  el.reencodeToggle.disabled = !has || merging;
  el.reencodeLabel.textContent = 'Force re-encode every clip';

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
    window.api.log('error', 'Scan failed (renderer): ' + (e.message || e));
    return;
  }

  clips = result.clips.map((c) => ({ ...c, thumb: null }));
  el.loadingState.hidden = true;

  if (clips.length === 0) {
    el.emptyState.hidden = false;
    const st = result.stats || {};
    const msg = !st.matched
      ? 'No video files found in that folder. (Subfolders are not scanned.)'
      : `Found ${st.matched} file(s), but none had a readable video stream. See Settings → Open log file for details.`;
    setStatus(msg, 'error');
    window.api.log('warn', 'Scan produced 0 usable clips: ' + JSON.stringify(st));
    return;
  }

  window.api.log('info', `Loaded ${clips.length} clip(s) from ${dir}`);
  el.listContainer.hidden = false;
  selectedId = null;
  el.previewPane.hidden = true;
  document.querySelector('.body').classList.remove('has-preview');
  setSortMode('date-asc');
  renderAll();
  setStatus(`Loaded ${clips.length} clip${clips.length > 1 ? 's' : ''} — drag to reorder, then click Merge ▶ to create your video.`);

  // Fill in thumbnails asynchronously.
  window.api.generateThumbnails(clips.map((c) => ({ path: c.path, duration: c.duration })));
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
async function startMerge() {
  if (clips.length === 0 || merging) return;
  const forceReencode = el.reencodeToggle.checked;
  const plan = outputPlan();

  // Use the chosen output location, or ask now.
  let out = outputPath;
  if (!out) {
    out = await window.api.saveOutput(suggestedOutputName());
    if (!out) return;
    outputPath = out;
    updateOutputDisplay();
  }
  lastOutput = out;

  merging = true;
  mergeStartTime = Date.now();
  resetMergeUi();
  el.progressWrap.hidden = false;
  el.cancelBtn.hidden = false;
  el.mergeBtn.hidden = true;
  el.showBtn.hidden = true;
  setProgress(0);
  setStatus((plan.pureCopy && !forceReencode)
    ? 'Merging losslessly (stream copy)…'
    : `Encoding to ${plan.t.W}×${plan.t.H} @ ${plan.t.F}fps · ${plan.codec === 'hevc' ? 'HEVC' : 'H.264'} (${plan.encLabel})… this can take a while.`);
  updateMergeControls();

  const payload = {
    outputPath: out,
    forceReencode,
    clips: clips.map((c) => ({
      path: c.path,
      duration: c.duration,
      hasVideo: c.hasVideo,
      hasAudio: c.hasAudio,
      width: c.width,
      height: c.height,
      fps: c.fps,
      vcodec: c.vcodec,
      compatKey: c.compatKey,
      name: c.name
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
    window.api.log('error', 'Merge failed (renderer): ' + (e.message || e));
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
  lastStatusText = msg || '';
  el.statusMsg.textContent = msg;
  el.statusMsg.className = 'status-msg' + (kind ? ' ' + kind : '');
  if (el.copyStatusBtn) el.copyStatusBtn.hidden = !msg;
}

async function copyStatus() {
  try {
    await window.api.copyText(lastStatusText);
    const original = el.copyStatusBtn.textContent;
    el.copyStatusBtn.textContent = '✓ Copied';
    setTimeout(() => { el.copyStatusBtn.textContent = original; }, 1200);
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Merge progress display
// ---------------------------------------------------------------------------
function fmtClock(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}

function fmtRemaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function mergeProgressText(p) {
  let action;
  if (p.phase === 'joining') {
    action = 'Joining clips losslessly (stream copy)…';
  } else if (p.action === 'copy') {
    action = `Keeping clip ${p.clip}/${p.total} lossless (no re-encode): ${p.clipName || ''}`;
  } else {
    const eng = p.encoder === 'gpu' ? 'GPU / NVENC' : 'CPU';
    action = `Encoding clip ${p.clip}/${p.total} on ${eng} (${(p.codec || '').toUpperCase()}): ${p.clipName || ''}`;
  }

  const stats = [`${Math.round(p.percent || 0)}% overall`];
  if (p.speed > 0) stats.push(`${p.speed.toFixed(1)}× speed`);
  if (p.fps > 0) stats.push(`${Math.round(p.fps)} fps`);
  if (mergeStartTime && p.percent > 1.5) {
    const elapsed = Date.now() - mergeStartTime;
    const remaining = elapsed * (100 - p.percent) / p.percent;
    stats.push(`~${fmtRemaining(remaining)} left`);
    stats.push(`finishes ~${fmtClock(Date.now() + remaining)}`);
  }
  return action + '\n' + stats.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Output location
// ---------------------------------------------------------------------------
function suggestedOutputName() {
  const base = (folderPath ? folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'merged') || 'merged';
  const plan = outputPlan();
  const ext = (plan.pureCopy && !el.reencodeToggle.checked) ? ((clips[0] && clips[0].ext) || 'mp4') : 'mp4';
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
  updateSettingsStatus(p);
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
// Settings
// ---------------------------------------------------------------------------
async function openSettings() {
  el.settingsOverlay.hidden = false;
  try {
    el.settingsVersion.textContent = 'v' + (await window.api.getVersion());
  } catch (_) {
    el.settingsVersion.textContent = '—';
  }
  try {
    el.logPathText.textContent = await window.api.getLogPath();
  } catch (_) { /* ignore */ }
}

function closeSettings() {
  el.settingsOverlay.hidden = true;
}

async function checkForUpdatesManual() {
  el.checkUpdatesBtn.disabled = true;
  el.updateStatusText.textContent = 'Checking for updates…';
  await window.api.checkForUpdate();
}

// Reflect update status inside the Settings dialog. The top banner handles the
// at-a-glance prompt; this gives explicit feedback for the manual check.
function updateSettingsStatus(p) {
  if (!el.updateStatusText) return;
  const ver = p && p.version ? 'v' + p.version : '';
  switch (p && p.state) {
    case 'checking':
      el.updateStatusText.textContent = 'Checking for updates…';
      el.checkUpdatesBtn.disabled = true;
      break;
    case 'progress':
      el.updateStatusText.textContent = `Downloading ${ver}… ${Math.round(p.percent || 0)}%`;
      el.checkUpdatesBtn.disabled = true;
      break;
    case 'available':
      el.updateStatusText.textContent = `Update available: ${ver}`;
      el.checkUpdatesBtn.disabled = false;
      break;
    case 'downloaded':
      el.updateStatusText.textContent = `Update ${ver} downloaded — restart to install.`;
      el.checkUpdatesBtn.disabled = false;
      break;
    case 'none':
      el.updateStatusText.textContent = "You're on the latest version.";
      el.checkUpdatesBtn.disabled = false;
      break;
    case 'error':
      el.updateStatusText.textContent = "Couldn't check for updates — try again later.";
      el.checkUpdatesBtn.disabled = false;
      break;
  }
}

// ---------------------------------------------------------------------------
// Output & encoding settings
// ---------------------------------------------------------------------------
async function loadSettingsIntoUi() {
  try {
    settings = { ...settings, ...(await window.api.getSettings()) };
    encoderInfo = (await window.api.getEncoderInfo()) || encoderInfo;
  } catch (_) { /* ignore */ }
  el.setResolution.value = settings.resolution || 'auto';
  el.setFps.value = settings.fps || 'auto';
  el.setEncoder.value = settings.encoder || 'auto';
  el.setCodec.value = settings.codec || 'h264';
  el.setQuality.value = settings.quality || 'near';
  updateEncoderInfoLabel();
  updateSummary();
}

async function onSettingChange() {
  settings = {
    resolution: el.setResolution.value,
    fps: el.setFps.value,
    encoder: el.setEncoder.value,
    codec: el.setCodec.value,
    quality: el.setQuality.value
  };
  updateEncoderInfoLabel();
  updateSummary();
  try { await window.api.setSettings(settings); } catch (_) { /* ignore */ }
}

function updateEncoderInfoLabel() {
  if (!el.encoderInfo) return;
  const parts = [];
  if (encoderInfo.h264_nvenc) parts.push('H.264');
  if (encoderInfo.hevc_nvenc) parts.push('HEVC');
  el.encoderInfo.textContent = parts.length
    ? `NVENC available: ${parts.join(', ')}`
    : 'No NVIDIA NVENC detected — CPU will be used';
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
  el.copyStatusBtn = $('copyStatusBtn');
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
  el.settingsBtn = $('settingsBtn');
  el.settingsOverlay = $('settingsOverlay');
  el.settingsClose = $('settingsClose');
  el.settingsVersion = $('settingsVersion');
  el.checkUpdatesBtn = $('checkUpdatesBtn');
  el.updateStatusText = $('updateStatusText');
  el.openReleasesBtn = $('openReleasesBtn');
  el.openLogBtn = $('openLogBtn');
  el.openLogFolderBtn = $('openLogFolderBtn');
  el.logPathText = $('logPathText');
  el.outputInfo = $('outputInfo');
  el.setResolution = $('setResolution');
  el.setFps = $('setFps');
  el.setEncoder = $('setEncoder');
  el.setCodec = $('setCodec');
  el.setQuality = $('setQuality');
  el.encoderInfo = $('encoderInfo');

  el.openBtn.addEventListener('click', openFolder);
  el.openBtn2.addEventListener('click', openFolder);
  el.sortSelect.addEventListener('change', (e) => applySort(e.target.value));
  el.shuffleBtn.addEventListener('click', shuffleClips);
  el.mergeBtn.addEventListener('click', startMerge);
  el.cancelBtn.addEventListener('click', () => window.api.cancelMerge());
  el.showBtn.addEventListener('click', () => { if (lastOutput) window.api.showItemInFolder(lastOutput); });
  el.copyStatusBtn.addEventListener('click', copyStatus);
  el.outputBtn.addEventListener('click', chooseOutput);
  el.keepCompatBtn.addEventListener('click', keepCompatibleOnly);
  el.updateDismiss.addEventListener('click', () => { el.updateBanner.hidden = true; });
  el.settingsBtn.addEventListener('click', openSettings);
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsOverlay.addEventListener('click', (e) => { if (e.target === el.settingsOverlay) closeSettings(); });
  el.checkUpdatesBtn.addEventListener('click', checkForUpdatesManual);
  el.openReleasesBtn.addEventListener('click', () => window.api.openReleases());
  el.openLogBtn.addEventListener('click', () => window.api.openLogFile());
  el.openLogFolderBtn.addEventListener('click', () => window.api.revealLogFile());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.settingsOverlay.hidden) closeSettings(); });
  ['setResolution', 'setFps', 'setEncoder', 'setCodec', 'setQuality'].forEach((id) => {
    el[id].addEventListener('change', onSettingChange);
  });

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
    if (!merging) return;
    el.statusMsg.textContent = mergeProgressText(p);
    el.statusMsg.className = 'status-msg';
    el.copyStatusBtn.hidden = true;
    lastStatusText = el.statusMsg.textContent;
  });

  // Auto-update: listen for status from main, then check the releases page.
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.checkForUpdate();
  updateOutputDisplay();
  loadSettingsIntoUi();
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
