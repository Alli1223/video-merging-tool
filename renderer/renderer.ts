// This file is a classic browser <script> (no import/export), so it compiles to
// a plain script the renderer loads directly. It talks to the main process only
// through the typed `window.api` bridge declared in src/global.d.ts.

// Forward uncaught renderer errors to the log file so problems are visible.
window.addEventListener('error', (e) => {
  try { window.api.log('error', 'renderer error: ' + ((e.error && e.error.stack) || e.message)); } catch { /* ignore */ }
});
window.addEventListener('unhandledrejection', (e) => {
  try { window.api.log('error', 'renderer unhandledrejection: ' + ((e.reason && e.reason.stack) || e.reason)); } catch { /* ignore */ }
});

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type SortModeUI = SortMode | 'custom';

// Strongly-typed handle to every element the renderer touches.
interface Elements {
  openBtn: HTMLButtonElement;
  openBtn2: HTMLButtonElement;
  sortSelect: HTMLSelectElement;
  shuffleBtn: HTMLButtonElement;
  folderPath: HTMLElement;
  emptyState: HTMLElement;
  listContainer: HTMLElement;
  loadingState: HTMLElement;
  loadingText: HTMLElement;
  clipList: HTMLUListElement;
  clipCount: HTMLElement;
  previewPane: HTMLElement;
  previewVideo: HTMLVideoElement;
  previewInfo: HTMLElement;
  timeline: HTMLElement;
  totalDuration: HTMLElement;
  compatBadge: HTMLElement;
  reencodeToggle: HTMLInputElement;
  reencodeLabel: HTMLElement;
  musicToggle: HTMLInputElement;
  musicVibe: HTMLSelectElement;
  musicStatus: HTMLElement;
  musicCreditsBtn: HTMLButtonElement;
  statusMsg: HTMLElement;
  copyStatusBtn: HTMLButtonElement;
  progressWrap: HTMLElement;
  progressBar: HTMLElement;
  progressText: HTMLElement;
  mergeBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  showBtn: HTMLButtonElement;
  outputBtn: HTMLButtonElement;
  outputPath: HTMLElement;
  keepCompatBtn: HTMLButtonElement;
  updateBanner: HTMLElement;
  updateText: HTMLElement;
  updateActionBtn: HTMLButtonElement;
  updateDismiss: HTMLButtonElement;
  settingsBtn: HTMLButtonElement;
  settingsOverlay: HTMLElement;
  settingsClose: HTMLButtonElement;
  settingsVersion: HTMLElement;
  checkUpdatesBtn: HTMLButtonElement;
  updateStatusText: HTMLElement;
  openReleasesBtn: HTMLButtonElement;
  openLogBtn: HTMLButtonElement;
  openLogFolderBtn: HTMLButtonElement;
  logPathText: HTMLElement;
  outputInfo: HTMLElement;
  setResolution: HTMLSelectElement;
  setFps: HTMLSelectElement;
  setEncoder: HTMLSelectElement;
  setCodec: HTMLSelectElement;
  setQuality: HTMLSelectElement;
  setSplit: HTMLSelectElement;
  encoderInfo: HTMLElement;
  setMusicCrossfade: HTMLSelectElement;
  setMusicFadeOut: HTMLSelectElement;
  setMusicVolume: HTMLSelectElement;
  musicCacheText: HTMLElement;
  clearMusicBtn: HTMLButtonElement;
  browseMusicBtn: HTMLButtonElement;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let clips: Clip[] = [];            // ordered clip objects (thumb filled in async)
let sortMode: SortModeUI = 'date-asc';
let selectedId: number | null = null;
let folderPath: string | null = null;
let merging = false;
let lastOutput: string | null = null;
let outputPath: string | null = null; // user-chosen save location (null = ask at merge time)
let lastStatusText = '';
let settings: Settings = { resolution: 'auto', fps: 'auto', encoder: 'auto', codec: 'hevc', quality: 'near', split: 'off', musicVibe: 'mix', musicCrossfade: 4, musicFadeOut: 5, musicVolume: 100 };
let encoderInfo: EncoderInfo = { h264_nvenc: false, hevc_nvenc: false };
let mergeStartTime = 0;
let musicEnabled = false;     // "Add background music" toggle
let musicTracks: MusicResult | null = null; // { trackPaths, credits, totalSeconds } once fetched
let musicFetching = false;
let vibeLabels: Record<string, string> = {}; // vibe key -> display label (e.g. "🎧 Lo-fi beats")
let currentEstimate: SizeEstimate | null = null; // output-size estimate
let lastEstimateSig = '';     // signature of inputs the estimate was computed for

const el = {} as Elements;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtDuration(sec: number): string {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return '—'; }
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

const SOURCE_LABEL: Record<TimeSource, string> = {
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
function compatibility(): { lossless: boolean; keys: number } {
  if (clips.length === 0) return { lossless: false, keys: 0 };
  const keys = new Set(clips.map((c) => c.compatKey));
  return { lossless: keys.size === 1, keys: keys.size };
}

// Named output resolutions (kept in sync with src/ffargs.ts RESOLUTIONS).
const RES: Record<string, [number, number]> = { 2160: [3840, 2160], 1440: [2560, 1440], 1080: [1920, 1080], 720: [1280, 720] };

// Resolve the output target {W,H,F} from settings + clips (for display + the
// "what will happen" summary). The main process resolves it authoritatively.
function resolveTargetLocal(): Target {
  let W = 0, H = 0, F = 0;
  for (const c of clips) { if (c.width > W) W = c.width; if (c.height > H) H = c.height; if (c.fps > F) F = c.fps; }
  W = Math.max(2, W - (W % 2)); H = Math.max(2, H - (H % 2));
  F = F > 0 ? Math.min(Math.round(F), 60) : 30;
  const r = RES[settings.resolution];
  if (r) { W = r[0]; H = r[1]; }
  if (settings.fps && settings.fps !== 'auto') { const f = parseInt(settings.fps, 10); if (f > 0) F = f; }
  return { W, H, F };
}

function matchesTargetLocal(c: Clip, t: Target, codec: Codec): boolean {
  return c.width === t.W && c.height === t.H && Math.round(c.fps || 0) === t.F && c.vcodec === codec;
}

// What the merge will produce given the current clips + settings.
function outputPlan(): { t: Target; codec: Codec; matching: number; pureCopy: boolean; encLabel: string } {
  const t = resolveTargetLocal();
  const codec: Codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
  const matching = clips.filter((c) => matchesTargetLocal(c, t, codec)).length;
  const allCompat = clips.length > 0 && new Set(clips.map((c) => c.compatKey)).size === 1;
  const pureCopy = clips.length > 0 && matching === clips.length && allCompat;
  const nvencKey: keyof EncoderInfo = codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc';
  const usingGpu = settings.encoder === 'nvenc' || (settings.encoder === 'auto' && encoderInfo[nvencKey]);
  const encLabel = settings.encoder === 'cpu' ? 'CPU' : (usingGpu ? 'GPU' : 'CPU');
  return { t, codec, matching, pureCopy, encLabel };
}

// A cheap fingerprint of everything that affects the output size, so the
// (async) estimate is only refetched when one of these actually changes.
function estimateSignature(): string {
  const clipSig = clips.map((c) =>
    `${c.id}:${c.size}:${c.width}x${c.height}:${Math.round(c.fps || 0)}:${c.vcodec}:${c.compatKey}:${Math.round(c.duration || 0)}`
  ).join('|');
  const force = el.reencodeToggle && el.reencodeToggle.checked ? 'R' : '';
  return `${clipSig}#${settings.resolution}/${settings.fps}/${settings.codec}/${settings.quality}#${force}#${musicEnabled ? 'M' : ''}`;
}

// Ask the main process for an output-size estimate (it owns the size model), and
// re-render the summary once it resolves. Fail-soft: on error we just show no
// estimate rather than blocking anything.
async function refreshEstimate(): Promise<void> {
  if (!clips.length) { currentEstimate = null; return; }
  const sigAtCall = lastEstimateSig;
  let est: SizeEstimate | null = null;
  try {
    est = await window.api.estimateSize({
      clips: clips.map((c) => ({
        size: c.size, duration: c.duration, width: c.width, height: c.height,
        fps: c.fps, vcodec: c.vcodec, compatKey: c.compatKey
      })),
      settings,
      opts: { forceReencode: !!(el.reencodeToggle && el.reencodeToggle.checked), music: musicEnabled }
    });
  } catch { est = null; }
  if (sigAtCall !== lastEstimateSig) return; // a newer change superseded this estimate
  currentEstimate = est;
  updateSummary();
}

// The "majority" compat key — clips that differ from it are the odd ones out.
function majorityKey(): string | null {
  const counts: Record<string, number> = {};
  for (const c of clips) counts[c.compatKey] = (counts[c.compatKey] || 0) + 1;
  let best: string | null = null, bestN = -1;
  for (const k in counts) if (counts[k] > bestN) { best = k; bestN = counts[k]; }
  return best;
}

// How many clips differ from the majority format (the re-encode culprits).
function countMismatched(): number {
  if (clips.length < 2) return 0;
  const major = majorityKey();
  return clips.filter((c) => c.compatKey !== major).length;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll(): void {
  renderList();
  renderTimeline();
  updateSummary();
  updateMergeControls();
}

function renderList(): void {
  const list = el.clipList;
  list.innerHTML = '';
  const major = clips.length ? majorityKey() : null;

  clips.forEach((c, i) => {
    const odd = clips.length > 1 && c.compatKey !== major;
    const li = document.createElement('li');
    li.className = 'clip' + (c.id === selectedId ? ' selected' : '') + (odd ? ' compat-warn' : '');
    li.draggable = true;
    li.dataset.id = String(c.id);
    li.dataset.index = String(i);

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

function renderTimeline(): void {
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
    div.dataset.id = String(c.id);
    div.dataset.index = String(i);
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

function updateSummary(): void {
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
    el.outputInfo.textContent = '';
    return;
  }

  const plan = outputPlan();

  // Recompute the output-size estimate only when a size-affecting input changes
  // (not on every reorder), then render whatever estimate we currently have.
  const sig = estimateSignature();
  if (sig !== lastEstimateSig) { lastEstimateSig = sig; refreshEstimate(); }

  let txt = `→ ${plan.t.W}×${plan.t.H} @ ${plan.t.F}fps · ${plan.codec === 'hevc' ? 'HEVC' : 'H.264'} (${plan.encLabel})`;
  if (currentEstimate && currentEstimate.bytes > 0) {
    txt += ` · est. output ≈ ${fmtSize(currentEstimate.bytes)}`;
    if (settings.split && settings.split !== 'off') {
      const limit = parseFloat(settings.split) * 1e9;
      // Mirrors the engine's 0.95 packing budget (src/ffargs.ts). Approximate —
      // the real count depends on where clip boundaries fall.
      const n = limit > 0 ? Math.max(1, Math.ceil(currentEstimate.bytes / (limit * 0.95))) : 1;
      txt += n > 1 ? ` · splits into ~${n} files of ≤${settings.split} GB` : ` · fits in one ≤${settings.split} GB file`;
    }
  }
  el.outputInfo.textContent = txt;
  el.outputInfo.title = !currentEstimate ? ''
    : currentEstimate.exact
      ? 'Lossless copy — output size ≈ the combined size of the input clips.'
      : 'Re-encoded size is an estimate; the actual size depends on the footage.';

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
function updateMergeControls(): void {
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
  el.musicToggle.disabled = !has || merging || musicFetching;
  el.musicVibe.disabled = !has || merging || musicFetching;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function escapeAttr(s: unknown): string { return escapeHtml(s).replace(/'/g, '&#39;'); }

// ---------------------------------------------------------------------------
// Drag & drop reordering (works from both the list and the timeline)
// ---------------------------------------------------------------------------
let dragId: number | null = null;

function indexOfId(id: number): number { return clips.findIndex((c) => c.id === id); }

function moveClip(fromId: number, toId: number, after: boolean): void {
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

function makeDraggable(node: HTMLElement, container: HTMLElement): void {
  node.addEventListener('dragstart', (e: DragEvent) => {
    dragId = Number(node.dataset.id);
    node.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch { /* ignore */ }
    }
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('dragging');
    container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  });
  node.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    if (Number(node.dataset.id) !== dragId) node.classList.add('drop-target');
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e: DragEvent) => {
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

function attachRowEvents(): void {
  el.clipList.querySelectorAll<HTMLLIElement>('.clip').forEach((li) => {
    makeDraggable(li, el.clipList);
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.remove-btn')) return;
      selectClip(Number(li.dataset.id));
    });
    const rm = li.querySelector<HTMLButtonElement>('.remove-btn');
    if (rm) {
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        removeClip(Number(rm.dataset.remove));
      });
    }
  });
}

function attachTimelineEvents(): void {
  el.timeline.querySelectorAll<HTMLElement>('.tl-clip').forEach((div) => {
    makeDraggable(div, el.timeline);
    div.addEventListener('click', () => selectClip(Number(div.dataset.id)));
  });
}

// ---------------------------------------------------------------------------
// Selection + preview
// ---------------------------------------------------------------------------
async function selectClip(id: number): Promise<void> {
  selectedId = id;
  const c = clips.find((x) => x.id === id);
  renderList();
  if (!c) return;

  el.previewPane.hidden = false;
  document.querySelector('.body')?.classList.add('has-preview');

  try {
    el.previewVideo.src = await window.api.fileUrl(c.path);
  } catch { /* preview is best-effort */ }

  el.previewInfo.innerHTML = `
    <div><b>${escapeHtml(c.name)}</b></div>
    <div>Recorded: ${fmtTime(c.sortTime)} <span class="time-source">${SOURCE_LABEL[c.timeSource] || c.timeSource}</span></div>
    <div>Duration: ${fmtDuration(c.duration)} · ${fmtSize(c.size)}</div>
    <div>Video: ${c.width}×${c.height} · ${Math.round(c.fps)} fps · ${c.vcodec || '?'} (${c.pixfmt || '?'})</div>
    <div>Audio: ${c.hasAudio ? `${c.acodec} · ${c.sampleRate} Hz · ${c.channels} ch` : 'none'}</div>
  `;
}

function removeClip(id: number): void {
  clips = clips.filter((c) => c.id !== id);
  if (selectedId === id) {
    selectedId = null;
    el.previewPane.hidden = true;
    document.querySelector('.body')?.classList.remove('has-preview');
    el.previewVideo.removeAttribute('src');
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
function setSortMode(mode: SortModeUI): void {
  sortMode = mode;
  const customOpt = el.sortSelect.querySelector<HTMLOptionElement>('option[value="custom"]');
  if (mode === 'custom') {
    if (customOpt) customOpt.hidden = false;
    el.sortSelect.value = 'custom';
  } else {
    el.sortSelect.value = mode;
  }
}

function applySort(mode: SortModeUI): void {
  setSortMode(mode);
  if (mode === 'date-asc') clips.sort((a, b) => (a.sortTime - b.sortTime) || a.name.localeCompare(b.name));
  else if (mode === 'date-desc') clips.sort((a, b) => (b.sortTime - a.sortTime) || a.name.localeCompare(b.name));
  else if (mode === 'name-asc') clips.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (mode === 'name-desc') clips.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  renderAll();
}

// Randomize the clip order (Fisher–Yates). Result is a "custom" order that can
// still be hand-tweaked by dragging afterwards. Click again to re-shuffle.
function shuffleClips(): void {
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
function keepCompatibleOnly(): void {
  if (merging || clips.length < 2) return;
  const major = majorityKey();
  const removed = clips.filter((c) => c.compatKey !== major);
  if (!removed.length) return;
  clips = clips.filter((c) => c.compatKey === major);
  if (removed.some((c) => c.id === selectedId)) {
    selectedId = null;
    el.previewPane.hidden = true;
    document.querySelector('.body')?.classList.remove('has-preview');
    el.previewVideo.removeAttribute('src');
  }
  renderAll();
  setStatus(`Removed ${removed.length} clip(s) of a different format — the rest can merge losslessly.`);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
async function openFolder(): Promise<void> {
  const dir = await window.api.openFolder();
  if (!dir) return;
  await scan(dir);
}

async function scan(dir: string): Promise<void> {
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

  let result: ScanResult;
  try {
    result = await window.api.scanDirectory(dir);
  } catch (e) {
    el.loadingState.hidden = true;
    el.emptyState.hidden = false;
    setStatus('Could not read that folder: ' + errText(e), 'error');
    window.api.log('error', 'Scan failed (renderer): ' + errText(e));
    return;
  }

  clips = result.clips.map((c) => ({ ...c, thumb: null }));
  el.loadingState.hidden = true;

  if (clips.length === 0) {
    el.emptyState.hidden = false;
    const st = result.stats;
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
  document.querySelector('.body')?.classList.remove('has-preview');
  setSortMode('date-asc');
  renderAll();
  setStatus(`Loaded ${clips.length} clip${clips.length > 1 ? 's' : ''} — drag to reorder, then click Merge ▶ to create your video.`);

  // Fill in thumbnails asynchronously.
  window.api.generateThumbnails(clips.map((c) => ({ path: c.path, duration: c.duration })));
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
async function startMerge(): Promise<void> {
  if (clips.length === 0 || merging) return;
  const forceReencode = el.reencodeToggle.checked;
  const plan = outputPlan();

  // If background music is on but the tracks aren't ready yet (e.g. an earlier
  // fetch failed), try once more before committing to a long merge.
  if (musicEnabled && (!musicTracks || !musicTracks.trackPaths.length)) {
    await fetchMusicTracks();
    if (!musicTracks || !musicTracks.trackPaths.length) {
      setStatus('Background music was requested but could not be fetched. Turn it off to merge without music, or check your connection.', 'error');
      return;
    }
  }

  // Use the chosen output location, or ask now.
  let out = outputPath;
  if (!out) {
    out = await window.api.saveOutput(suggestedOutputName());
    if (!out) return;
    outputPath = out;
    updateOutputDisplay();
  }
  lastOutput = out;

  // Make sure the destination drive has room. The estimate includes the
  // temporary files created during the merge, so the peak need can be ~2x the
  // final size. If it looks tight, warn but let the user decide.
  try {
    const est = await window.api.estimateSize({
      clips: clips.map((c) => ({
        size: c.size, duration: c.duration, width: c.width, height: c.height,
        fps: c.fps, vcodec: c.vcodec, compatKey: c.compatKey
      })),
      settings,
      opts: { forceReencode, music: musicEnabled }
    });
    const space = await window.api.getFreeSpace(out);
    if (est && est.peakBytes > 0 && space && space.freeBytes > 0) {
      const needed = Math.round(est.peakBytes * 1.07) + 256 * 1024 * 1024; // margin + container/fs overhead
      if (needed > space.freeBytes) {
        const proceed = await window.api.confirmDialog({
          title: 'Low disk space',
          message: 'The destination drive may not have enough free space for this merge.',
          detail: `Estimated space needed: ~${fmtSize(needed)} (including temporary files during the merge).\n`
            + `Free on ${space.mount || 'the destination drive'}: ${fmtSize(space.freeBytes)}.\n\n`
            + 'Merge anyway?',
          confirmText: 'Merge anyway',
          cancelText: 'Cancel'
        });
        if (!proceed) {
          setStatus('Merge canceled — not enough free space on the destination drive. Free up space or choose another drive via “Save to…”.', 'error');
          return;
        }
      }
    }
  } catch { /* if the space check fails for any reason, don't block the merge */ }

  merging = true;
  mergeStartTime = Date.now();
  resetMergeUi();
  el.progressWrap.hidden = false;
  el.cancelBtn.hidden = false;
  el.mergeBtn.hidden = true;
  el.showBtn.hidden = true;
  setProgress(0);
  const musicNote = (musicEnabled && musicTracks && musicTracks.trackPaths.length) ? ' + chill background music' : '';
  setStatus((plan.pureCopy && !forceReencode)
    ? 'Merging losslessly (stream copy)…' + musicNote
    : `Encoding to ${plan.t.W}×${plan.t.H} @ ${plan.t.F}fps · ${plan.codec === 'hevc' ? 'HEVC' : 'H.264'} (${plan.encLabel})${musicNote}… this can take a while.`);
  updateMergeControls();

  const payload: MergePayload = {
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
      name: c.name,
      size: c.size // used to plan size-limited splitting
    }))
  };

  if (musicEnabled && musicTracks && musicTracks.trackPaths.length) {
    payload.music = {
      trackPaths: musicTracks.trackPaths,
      options: {
        crossfade: Number(settings.musicCrossfade ?? 4),
        fadeOut: Number(settings.musicFadeOut ?? 5),
        fadeIn: 2,
        volume: Number(settings.musicVolume ?? 100) / 100
      }
    };
  }

  try {
    const res = await window.api.startMerge(payload);
    if (res && res.canceled) {
      setStatus('Merge canceled.', 'error');
    } else {
      setProgress(100);
      const bits: string[] = [];
      if (res.musicFailed) bits.push('background music could not be added, so it was saved without music');
      else if (res.music) bits.push('with background music');
      if (res.repaired && res.repaired.length) {
        const n = res.repaired.length;
        bits.push(`${n} corrupted clip${n > 1 ? 's were' : ' was'} detected and re-encoded to fix ${n > 1 ? 'them' : 'it'}`);
      }
      let msg: string;
      if (res.parts && res.parts.length > 1) {
        const limitNote = settings.split && settings.split !== 'off' ? `, each under ${settings.split} GB` : '';
        msg = `Done — split into ${res.parts.length} files${limitNote}:\n`
          + res.parts.map((p) => `• ${baseName(p.path)} (${fmtSize(p.bytes)})`).join('\n');
      } else {
        msg = `Done — saved to ${res.outputPath}`;
      }
      if (bits.length) msg += ` (${bits.join('; ')})`;
      if (res.verified === false) {
        // Saved, but the integrity pass couldn't confirm the file is clean —
        // show neutrally (not green) with the reason.
        msg += `\n⚠ The integrity check could not confirm the output is fully clean${res.verifyNote ? ': ' + res.verifyNote : '.'}`;
        setStatus(msg);
      } else {
        if (res.verified) msg += ' · integrity verified ✓';
        setStatus(msg, 'success');
      }
      el.showBtn.hidden = false;
    }
  } catch (e) {
    setStatus('Merge failed: ' + errText(e), 'error');
    window.api.log('error', 'Merge failed (renderer): ' + errText(e));
  } finally {
    merging = false;
    el.cancelBtn.hidden = true;
    el.mergeBtn.hidden = false;
    el.progressWrap.hidden = el.showBtn.hidden ? true : el.progressWrap.hidden;
    updateMergeControls();
  }
}

function resetMergeUi(): void {
  el.progressWrap.hidden = true;
  el.showBtn.hidden = true;
  setProgress(0);
}

function setProgress(pct: number): void {
  el.progressBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  el.progressText.textContent = Math.round(pct) + '%';
}

function setStatus(msg: string, kind?: string): void {
  lastStatusText = msg || '';
  el.statusMsg.textContent = msg;
  el.statusMsg.className = 'status-msg' + (kind ? ' ' + kind : '');
  el.copyStatusBtn.hidden = !msg;
}

async function copyStatus(): Promise<void> {
  try {
    await window.api.copyText(lastStatusText);
    const original = el.copyStatusBtn.textContent;
    el.copyStatusBtn.textContent = '✓ Copied';
    setTimeout(() => { el.copyStatusBtn.textContent = original; }, 1200);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Merge progress display
// ---------------------------------------------------------------------------
function fmtClock(ms: number): string {
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function mergeProgressText(p: Progress): string {
  const partPrefix = p.part ? `Part ${p.part}${p.partsTotal ? '/' + p.partsTotal : ''} — ` : '';
  let action: string;
  if (p.phase === 'music-prep') {
    action = 'Preparing background music (crossfading tracks into a seamless loop)…';
  } else if (p.phase === 'music') {
    action = 'Adding background music to the video (copying video, no re-encode)…';
  } else if (p.phase === 'verifying') {
    action = p.clip
      ? `Checking clip ${p.clip}/${p.total} for corruption (decode + CRC): ${p.clipName || ''}`
      : 'Verifying the merged video — decoding every frame to catch corruption…';
  } else if (p.phase === 'joining') {
    action = 'Joining clips losslessly (stream copy)…';
  } else if (p.action === 'copy') {
    action = `Keeping clip ${p.clip}/${p.total} lossless (no re-encode): ${p.clipName || ''}`;
  } else {
    const eng = p.encoder === 'gpu' ? 'GPU / NVENC' : 'CPU';
    action = `Encoding clip ${p.clip}/${p.total} on ${eng} (${(p.codec || '').toUpperCase()}): ${p.clipName || ''}`;
  }

  const stats = [`${Math.round(p.percent || 0)}% overall`];
  if (p.speed && p.speed > 0) stats.push(`${p.speed.toFixed(1)}× speed`);
  if (p.fps && p.fps > 0) stats.push(`${Math.round(p.fps)} fps`);
  if (mergeStartTime && p.percent > 1.5) {
    const elapsed = Date.now() - mergeStartTime;
    const remaining = elapsed * (100 - p.percent) / p.percent;
    stats.push(`~${fmtRemaining(remaining)} left`);
    stats.push(`finishes ~${fmtClock(Date.now() + remaining)}`);
  }
  return partPrefix + action + '\n' + stats.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Output location
// ---------------------------------------------------------------------------
function suggestedOutputName(): string {
  const base = (folderPath ? folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'merged') || 'merged';
  const plan = outputPlan();
  const ext = (plan.pureCopy && !el.reencodeToggle.checked) ? ((clips[0] && clips[0].ext) || 'mp4') : 'mp4';
  return `${base}_merged.${ext}`;
}

async function chooseOutput(): Promise<void> {
  const picked = await window.api.saveOutput(suggestedOutputName());
  if (!picked) return;
  outputPath = picked;
  updateOutputDisplay();
}

function updateOutputDisplay(): void {
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
// Background music
// ---------------------------------------------------------------------------
// Populate the vibe dropdown from the catalog in the main process.
async function populateVibes(): Promise<void> {
  try {
    const vibes = await window.api.getMusicVibes();
    el.musicVibe.innerHTML = '';
    vibeLabels = {};
    vibes.forEach((v) => {
      vibeLabels[v.key] = v.label;
      const opt = document.createElement('option');
      opt.value = v.key;
      opt.textContent = v.label;
      opt.title = v.description || '';
      el.musicVibe.appendChild(opt);
    });
    el.musicVibe.value = settings.musicVibe || 'mix';
  } catch { /* ignore */ }
}

async function onMusicToggle(): Promise<void> {
  musicEnabled = el.musicToggle.checked;
  if (musicEnabled && (!musicTracks || !musicTracks.trackPaths.length)) {
    await fetchMusicTracks();
  } else {
    updateMusicStatus();
  }
  updateSummary(); // music adds an audio track — refresh the size estimate
}

// Switching vibe persists the choice and, if music is on, fetches the new vibe
// (instant if it was downloaded before — each vibe has its own cache).
async function onMusicVibeChange(): Promise<void> {
  settings.musicVibe = el.musicVibe.value;
  try { await window.api.setSettings({ musicVibe: settings.musicVibe }); } catch { /* ignore */ }
  if (musicEnabled) {
    musicTracks = null; // force a refetch for the newly selected vibe
    await fetchMusicTracks();
  }
}

// Fetch (and cache) the royalty-free track pool for the selected vibe. Safe to
// call repeatedly — the main process reuses anything already downloaded.
async function fetchMusicTracks(): Promise<void> {
  if (musicFetching) return;
  musicFetching = true;
  el.musicCreditsBtn.hidden = true;
  const label = vibeLabels[settings.musicVibe] || 'chill';
  el.musicStatus.textContent = `⏳ Finding free ${label} tracks…`;
  updateMergeControls();
  try {
    musicTracks = await window.api.fetchMusic({ vibe: settings.musicVibe });
    updateMusicStatus();
    refreshMusicCacheInfo();
  } catch (e) {
    musicTracks = null;
    musicEnabled = false;
    el.musicToggle.checked = false;
    el.musicStatus.textContent = '⚠ Could not fetch music (offline?). ' + errText(e);
    window.api.log('error', 'Music fetch failed (renderer): ' + errText(e));
  } finally {
    musicFetching = false;
    updateMergeControls();
  }
}

function updateMusicStatus(): void {
  if (!musicEnabled) {
    el.musicStatus.textContent = '';
    el.musicCreditsBtn.hidden = true;
    return;
  }
  if (musicTracks && musicTracks.trackPaths.length) {
    const n = musicTracks.trackPaths.length;
    const label = vibeLabels[settings.musicVibe] || 'chill';
    el.musicStatus.textContent = `✓ ${n} CC0 track${n > 1 ? 's' : ''} ready (${label}) — looped & crossfaded to fill your video.`;
    el.musicCreditsBtn.hidden = !(musicTracks.credits && musicTracks.credits.length);
  } else {
    el.musicStatus.textContent = '';
    el.musicCreditsBtn.hidden = true;
  }
}

function showMusicCredits(): void {
  if (!musicTracks || !musicTracks.credits || !musicTracks.credits.length) return;
  const lines = musicTracks.credits.map((c) => `• ${c.creator} — ${c.album} (${c.license})`);
  const text =
    'Background music is CC0 / public domain — you are free to use it in any project, including commercially, with no attribution required.\n\n' +
    'For the record, the tracks in this pool come from (via the Internet Archive):\n' + lines.join('\n');
  setStatus(text);
}

function refreshMusicCacheInfo(): void {
  window.api.getMusicCacheInfo().then((info) => {
    if (!info || !info.count) { el.musicCacheText.textContent = 'No music downloaded yet.'; return; }
    el.musicCacheText.textContent = `${info.count} track${info.count > 1 ? 's' : ''} cached · ${fmtSize(info.bytes)}`;
  }).catch(() => {});
}

async function clearMusicDownloads(): Promise<void> {
  try {
    await window.api.clearMusicCache();
    musicTracks = null;
    if (musicEnabled) { el.musicToggle.checked = false; musicEnabled = false; }
    updateMusicStatus();
    refreshMusicCacheInfo();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Auto-update banner
// ---------------------------------------------------------------------------
function handleUpdateStatus(p: UpdateStatus): void {
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
async function openSettings(): Promise<void> {
  el.settingsOverlay.hidden = false;
  try {
    el.settingsVersion.textContent = 'v' + (await window.api.getVersion());
  } catch {
    el.settingsVersion.textContent = '—';
  }
  try {
    el.logPathText.textContent = await window.api.getLogPath();
  } catch { /* ignore */ }
}

function closeSettings(): void {
  el.settingsOverlay.hidden = true;
}

async function checkForUpdatesManual(): Promise<void> {
  el.checkUpdatesBtn.disabled = true;
  el.updateStatusText.textContent = 'Checking for updates…';
  await window.api.checkForUpdate();
}

// Reflect update status inside the Settings dialog. The top banner handles the
// at-a-glance prompt; this gives explicit feedback for the manual check.
function updateSettingsStatus(p: UpdateStatus): void {
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
async function loadSettingsIntoUi(): Promise<void> {
  try {
    settings = { ...settings, ...(await window.api.getSettings()) };
    encoderInfo = (await window.api.getEncoderInfo()) || encoderInfo;
  } catch { /* ignore */ }
  el.setResolution.value = settings.resolution || 'auto';
  el.setFps.value = settings.fps || 'auto';
  el.setEncoder.value = settings.encoder || 'auto';
  el.setCodec.value = settings.codec || 'h264';
  el.setQuality.value = settings.quality || 'near';
  el.setSplit.value = settings.split || 'off';
  el.setMusicCrossfade.value = String(settings.musicCrossfade ?? 4);
  el.setMusicFadeOut.value = String(settings.musicFadeOut ?? 5);
  el.setMusicVolume.value = String(settings.musicVolume ?? 100);
  await populateVibes();
  updateEncoderInfoLabel();
  refreshMusicCacheInfo();
  updateSummary();
}

async function onSettingChange(): Promise<void> {
  settings = {
    ...settings, // keep values not represented by a settings-dialog control (e.g. musicVibe)
    resolution: el.setResolution.value as ResolutionPref,
    fps: el.setFps.value as FpsPref,
    encoder: el.setEncoder.value as EncoderPref,
    codec: el.setCodec.value as Codec,
    quality: el.setQuality.value as Quality,
    split: el.setSplit.value as SplitPref,
    musicCrossfade: parseInt(el.setMusicCrossfade.value, 10),
    musicFadeOut: parseInt(el.setMusicFadeOut.value, 10),
    musicVolume: parseInt(el.setMusicVolume.value, 10)
  };
  updateEncoderInfoLabel();
  updateSummary();
  try { await window.api.setSettings(settings); } catch { /* ignore */ }
}

function updateEncoderInfoLabel(): void {
  const parts: string[] = [];
  if (encoderInfo.h264_nvenc) parts.push('H.264');
  if (encoderInfo.hevc_nvenc) parts.push('HEVC');
  el.encoderInfo.textContent = parts.length
    ? `NVENC available: ${parts.join(', ')}`
    : 'No NVIDIA NVENC detected — CPU will be used';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function init(): void {
  el.openBtn = $<HTMLButtonElement>('openBtn');
  el.openBtn2 = $<HTMLButtonElement>('openBtn2');
  el.sortSelect = $<HTMLSelectElement>('sortSelect');
  el.shuffleBtn = $<HTMLButtonElement>('shuffleBtn');
  el.folderPath = $('folderPath');
  el.emptyState = $('emptyState');
  el.listContainer = $('listContainer');
  el.loadingState = $('loadingState');
  el.loadingText = $('loadingText');
  el.clipList = $<HTMLUListElement>('clipList');
  el.clipCount = $('clipCount');
  el.previewPane = $('previewPane');
  el.previewVideo = $<HTMLVideoElement>('previewVideo');
  el.previewInfo = $('previewInfo');
  el.timeline = $('timeline');
  el.totalDuration = $('totalDuration');
  el.compatBadge = $('compatBadge');
  el.reencodeToggle = $<HTMLInputElement>('reencodeToggle');
  el.reencodeLabel = $('reencodeLabel');
  el.musicToggle = $<HTMLInputElement>('musicToggle');
  el.musicVibe = $<HTMLSelectElement>('musicVibe');
  el.musicStatus = $('musicStatus');
  el.musicCreditsBtn = $<HTMLButtonElement>('musicCreditsBtn');
  el.statusMsg = $('statusMsg');
  el.copyStatusBtn = $<HTMLButtonElement>('copyStatusBtn');
  el.progressWrap = $('progressWrap');
  el.progressBar = $('progressBar');
  el.progressText = $('progressText');
  el.mergeBtn = $<HTMLButtonElement>('mergeBtn');
  el.cancelBtn = $<HTMLButtonElement>('cancelBtn');
  el.showBtn = $<HTMLButtonElement>('showBtn');
  el.outputBtn = $<HTMLButtonElement>('outputBtn');
  el.outputPath = $('outputPath');
  el.keepCompatBtn = $<HTMLButtonElement>('keepCompatBtn');
  el.updateBanner = $('updateBanner');
  el.updateText = $('updateText');
  el.updateActionBtn = $<HTMLButtonElement>('updateActionBtn');
  el.updateDismiss = $<HTMLButtonElement>('updateDismiss');
  el.settingsBtn = $<HTMLButtonElement>('settingsBtn');
  el.settingsOverlay = $('settingsOverlay');
  el.settingsClose = $<HTMLButtonElement>('settingsClose');
  el.settingsVersion = $('settingsVersion');
  el.checkUpdatesBtn = $<HTMLButtonElement>('checkUpdatesBtn');
  el.updateStatusText = $('updateStatusText');
  el.openReleasesBtn = $<HTMLButtonElement>('openReleasesBtn');
  el.openLogBtn = $<HTMLButtonElement>('openLogBtn');
  el.openLogFolderBtn = $<HTMLButtonElement>('openLogFolderBtn');
  el.logPathText = $('logPathText');
  el.outputInfo = $('outputInfo');
  el.setResolution = $<HTMLSelectElement>('setResolution');
  el.setFps = $<HTMLSelectElement>('setFps');
  el.setEncoder = $<HTMLSelectElement>('setEncoder');
  el.setCodec = $<HTMLSelectElement>('setCodec');
  el.setQuality = $<HTMLSelectElement>('setQuality');
  el.setSplit = $<HTMLSelectElement>('setSplit');
  el.encoderInfo = $('encoderInfo');
  el.setMusicCrossfade = $<HTMLSelectElement>('setMusicCrossfade');
  el.setMusicFadeOut = $<HTMLSelectElement>('setMusicFadeOut');
  el.setMusicVolume = $<HTMLSelectElement>('setMusicVolume');
  el.musicCacheText = $('musicCacheText');
  el.clearMusicBtn = $<HTMLButtonElement>('clearMusicBtn');
  el.browseMusicBtn = $<HTMLButtonElement>('browseMusicBtn');

  el.openBtn.addEventListener('click', openFolder);
  el.openBtn2.addEventListener('click', openFolder);
  el.sortSelect.addEventListener('change', (e) => applySort((e.target as HTMLSelectElement).value as SortModeUI));
  el.shuffleBtn.addEventListener('click', shuffleClips);
  el.mergeBtn.addEventListener('click', startMerge);
  el.cancelBtn.addEventListener('click', () => window.api.cancelMerge());
  el.reencodeToggle.addEventListener('change', updateSummary); // refresh size estimate
  el.musicToggle.addEventListener('change', onMusicToggle);
  el.musicVibe.addEventListener('change', onMusicVibeChange);
  el.musicCreditsBtn.addEventListener('click', showMusicCredits);
  el.clearMusicBtn.addEventListener('click', clearMusicDownloads);
  el.browseMusicBtn.addEventListener('click', () => window.api.openMusicSource());
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
  const settingIds: (keyof Elements)[] = ['setResolution', 'setFps', 'setEncoder', 'setCodec', 'setQuality', 'setSplit',
    'setMusicCrossfade', 'setMusicFadeOut', 'setMusicVolume'];
  settingIds.forEach((id) => {
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
    const txt = mergeProgressText(p);
    el.statusMsg.textContent = txt;
    el.statusMsg.className = 'status-msg';
    el.copyStatusBtn.hidden = true;
    lastStatusText = txt;
  });

  // Background-music download progress.
  window.api.onMusicProgress((p) => {
    if (!musicFetching) return;
    const label = vibeLabels[settings.musicVibe] || 'chill';
    if (p.stage === 'downloading' && p.total) {
      el.musicStatus.textContent = `⏳ Downloading ${label} tracks… ${p.index || 0}/${p.total} (${p.percent || 0}%)`;
    } else if (p.stage === 'listing') {
      el.musicStatus.textContent = `⏳ Finding free ${label} tracks…`;
    }
  });

  // Auto-update: listen for status from main, then check the releases page.
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.checkForUpdate();
  updateOutputDisplay();
  loadSettingsIntoUi();
}

// Update just the thumbnail images for a clip (avoids a full re-render flicker).
function updateThumb(c: Clip): void {
  document.querySelectorAll<HTMLElement>(`.clip[data-id="${c.id}"] .thumb`).forEach((t) => {
    t.classList.remove('loading');
    t.textContent = '';
    t.style.backgroundImage = `url('${c.thumb}')`;
  });
  document.querySelectorAll<HTMLElement>(`.tl-clip[data-id="${c.id}"]`).forEach((t) => {
    t.style.backgroundImage = `url('${c.thumb}')`;
  });
}

document.addEventListener('DOMContentLoaded', init);
