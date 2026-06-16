// Ambient, project-wide type declarations.
//
// This file has no top-level import/export, so everything it declares is global
// and visible in every other file without an import. That lets the main process
// (CommonJS), the helper modules, and the renderer (a classic <script>, which
// must stay import-free to emit a plain browser script) all share one typed
// contract — in particular the `window.api` IPC bridge defined by `Api` below.

// ---------------------------------------------------------------------------
// Enumerated settings (mirror the <option> values in renderer/index.html)
// ---------------------------------------------------------------------------
type Codec = 'h264' | 'hevc';
type Quality = 'lossless' | 'near' | 'high' | 'balanced';
type EncoderPref = 'auto' | 'nvenc' | 'cpu';
type ResolutionPref = 'auto' | '720' | '1080' | '1440' | '2160';
type FpsPref = 'auto' | '24' | '25' | '30' | '50' | '60';
// Max output file size in GB ('off' = single file). Presets cover the common
// upload/filesystem caps; the engine treats the value as parseFloat(GB)*1e9.
type SplitPref = 'off' | '2' | '4' | '10' | '50' | '256';
type SortMode = 'date-asc' | 'date-desc' | 'name-asc' | 'name-desc';
type TimeSource = 'metadata' | 'filename' | 'created' | 'modified';
type LogLevel = 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Media / clip shapes
// ---------------------------------------------------------------------------
// The reduced ffprobe output the scanner keeps for each file.
interface ProbeResult {
  hasVideo: boolean;
  width: number;
  height: number;
  vcodec: string | null;
  pixfmt: string | null;
  fps: number;
  hasAudio: boolean;
  acodec: string | null;
  sampleRate: number;
  channels: number;
  duration: number;
  creationTimeTag: string | null;
}

// Per-clip edits applied before merging. Defaults mean "no edit": contrast and
// saturation 1, no trim. A clip carrying ANY edit is always re-encoded — pixels
// can't be changed, nor frames cut frame-accurately, on a lossless stream copy.
// `trimEnd` is the out-point in seconds from the start of the source (so the
// kept span is [trimStart, trimEnd] and its length is trimEnd - trimStart).
interface ClipEdits {
  contrast?: number;
  saturation?: number;
  trimStart?: number;
  trimEnd?: number;
}

// A scanned, orderable clip. `thumb` is filled in asynchronously in the renderer.
interface Clip extends ClipEdits {
  id: number;
  path: string;
  name: string;
  ext: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string | null;
  acodec: string | null;
  pixfmt: string | null;
  sampleRate: number;
  channels: number;
  hasVideo: boolean;
  hasAudio: boolean;
  sortTime: number;
  timeSource: TimeSource;
  compatKey: string;
  thumb?: string | null;
}

// Minimal clip subsets the (pure) engine helpers actually read.
interface VideoSpecClip {
  width: number;
  height: number;
  fps: number;
  vcodec: string | null;
}
interface MergeClip extends VideoSpecClip, ClipEdits {
  path: string;
  duration: number;
  hasAudio: boolean;
  hasVideo?: boolean;
  compatKey: string;
  name?: string;
  // File size in bytes — used to plan size-limited splitting. Optional: the
  // engine falls back to statting the file when absent.
  size?: number;
}
interface EstimateClip extends VideoSpecClip, ClipEdits {
  size: number;
  duration: number;
  compatKey: string;
}
interface TrackDuration {
  path: string;
  duration: number;
}

// ---------------------------------------------------------------------------
// Output target + encoding
// ---------------------------------------------------------------------------
interface Target {
  W: number;
  H: number;
  F: number;
}
interface EncodeOpts {
  codec: Codec;
  useNvenc: boolean;
  quality: Quality;
}
interface EncoderInfo {
  h264_nvenc: boolean;
  hevc_nvenc: boolean;
}

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------
interface Settings {
  resolution: ResolutionPref;
  fps: FpsPref;
  encoder: EncoderPref;
  codec: Codec;
  quality: Quality;
  split: SplitPref;
  // Run the post-merge integrity check (decode/spot-check the finished file and
  // auto-repair damaged clips). On by default; turn off to skip it entirely.
  verify: boolean;
  musicVibe: string;
  musicCrossfade: number;
  musicFadeOut: number;
  musicVolume: number;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
interface ScanStats {
  matched: number;
  probed: number;
  withVideo: number;
}
interface ScanResult {
  dir: string;
  clips: Clip[];
  stats: ScanStats;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------
interface MergeMusic {
  trackPaths: string[];
  options?: Partial<MusicOptions>;
}
interface MergeOptions {
  clips: MergeClip[];
  outputPath: string;
  forceReencode?: boolean;
  settings?: Partial<Settings>;
  music?: MergeMusic | null;
  // Used by the size-split orchestrator so every part is encoded to the SAME
  // target (resolved from the full clip list, not just the part's clips).
  targetOverride?: Target;
}
// What the renderer sends over IPC — the main process attaches `settings`.
type MergePayload = Omit<MergeOptions, 'settings'>;

// One output file of a size-split merge.
interface PartInfo {
  path: string;
  bytes: number;
  clips: number;
}

interface MergeResult {
  success: boolean;
  mode?: 'copy' | 'reencode' | 'hybrid';
  outputPath?: string;
  music?: boolean;
  musicFailed?: boolean;
  canceled?: boolean;
  /** Present (length ≥ 2) when the output was split into size-limited parts. */
  parts?: PartInfo[];
  /** Did the final output pass the post-merge integrity verification? */
  verified?: boolean;
  /** Clips that failed their integrity check and were rebuilt by re-encoding. */
  repaired?: RepairedClip[];
  /** Clips dropped from the merge because they could not be processed/verified
   *  even after a re-encode — cut out so one bad file can't fail the whole job. */
  dropped?: DroppedClip[];
  /** Actual decodable duration produced (below the input total when clips were
   *  dropped) — what the post-merge verification and music length use. */
  outputDuration?: number;
  /** Human-readable detail when something could not be verified or fixed. */
  verifyNote?: string;
}

// A planned size-limited part: clips[start..end] (inclusive indices).
interface PartPlan {
  start: number;
  end: number;
  estBytes: number;
  /** This single clip alone exceeds the budget (cannot be split further). */
  oversize: boolean;
  /** Every clip in the part is stream-copied, so estBytes is exact. */
  exact: boolean;
}

// ---------------------------------------------------------------------------
// Output integrity verification
// ---------------------------------------------------------------------------
type VerifyIssueKind = 'decode' | 'duration' | 'crc' | 'process';
interface VerifyIssue {
  kind: VerifyIssueKind;
  detail: string;
}
interface VerifyReport {
  ok: boolean;
  issues: VerifyIssue[];
}
// Everything a verification run gathers, fed to the pure assessIntegrity().
interface IntegrityInput {
  exitCode: number | null;
  errorCount: number;
  errorSample: string[];
  decodedDuration: number | null;
  expectedDuration?: number | null;
  crc?: string | null;
  expectedCrc?: string | null;
}
interface RepairedClip {
  name: string;
  reason: VerifyIssueKind;
}
interface DroppedClip {
  name: string;
  reason: VerifyIssueKind;
}

// Streamed merge progress (a superset across all phases).
interface Progress {
  percent: number;
  phase?: 'encoding' | 'joining' | 'verifying' | 'music-prep' | 'music';
  // Set while a size-split merge works on one of its parts.
  part?: number;
  partsTotal?: number;
  clip?: number;
  total?: number;
  clipName?: string;
  action?: 'copy' | 'encode';
  encoder?: 'gpu' | 'cpu';
  codec?: Codec;
  fps?: number;
  speed?: number;
  seconds?: number;
  bitrate?: string;
  totalDuration?: number;
}

// ---------------------------------------------------------------------------
// Output size estimate + free space
// ---------------------------------------------------------------------------
interface SizeEstimate {
  bytes: number;
  peakBytes: number;
  exact: boolean;
  pureCopy: boolean;
}
interface EstimatePayload {
  clips?: EstimateClip[];
  settings?: Settings;
  opts?: { forceReencode?: boolean; music?: boolean };
}
interface FreeSpace {
  freeBytes: number;
  mount: string | null;
}
interface ConfirmOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message?: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------
interface ThumbInput {
  path: string;
  duration: number;
}
interface ThumbDone {
  path: string;
  thumb: string | null;
}

// ---------------------------------------------------------------------------
// Background music
// ---------------------------------------------------------------------------
interface MusicOptions {
  crossfade: number;
  fadeIn: number;
  fadeOut: number;
  volume: number;
}
interface Credit {
  creator: string;
  album: string;
  license: string;
  source: string;
}
interface MusicResult {
  trackPaths: string[];
  credits: Credit[];
  totalSeconds: number;
  vibe?: string;
}
interface Vibe {
  key: string;
  label: string;
  description: string;
}
interface SourceInfo {
  name: string;
  license: string;
  note: string;
  browseUrl: string;
}
interface CacheInfo {
  count: number;
  bytes: number;
}
interface MusicProgress {
  stage: 'listing' | 'downloading' | 'done';
  vibe: string;
  percent: number;
  trackTitle?: string;
  index?: number;
  total?: number;
}
interface FetchMusicOpts {
  vibe?: string;
  poolSize?: number;
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------
interface UpdateStatus {
  state: 'checking' | 'available' | 'none' | 'error' | 'progress' | 'downloaded';
  version?: string;
  canAutoUpdate?: boolean;
  percent?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// The preload bridge contract (window.api). Typing preload's object as `Api`
// makes the bridge compile-checked against what the renderer consumes.
// ---------------------------------------------------------------------------
interface Api {
  openFolder(): Promise<string | null>;
  scanDirectory(dir: string): Promise<ScanResult>;
  generateThumbnails(items: ThumbInput[]): Promise<boolean>;
  onThumb(cb: (data: ThumbDone) => void): () => void;
  saveOutput(defaultName?: string): Promise<string | null>;
  estimateSize(payload: EstimatePayload): Promise<SizeEstimate>;
  getFreeSpace(targetPath: string): Promise<FreeSpace>;
  confirmDialog(opts: ConfirmOptions): Promise<boolean>;
  startMerge(opts: MergePayload): Promise<MergeResult>;
  onMergeProgress(cb: (p: Progress) => void): () => void;
  cancelMerge(): Promise<boolean>;
  getMusicSources(): Promise<SourceInfo>;
  getMusicVibes(): Promise<Vibe[]>;
  fetchMusic(opts: FetchMusicOpts): Promise<MusicResult>;
  onMusicProgress(cb: (p: MusicProgress) => void): () => void;
  getMusicCacheInfo(): Promise<CacheInfo>;
  clearMusicCache(): Promise<boolean>;
  openMusicSource(): Promise<boolean>;
  showItemInFolder(p: string): Promise<boolean>;
  fileUrl(p: string): Promise<string>;
  getVersion(): Promise<string>;
  log(level: LogLevel, message: string): Promise<boolean>;
  openLogFile(): Promise<string | null>;
  revealLogFile(): Promise<string | null>;
  getLogPath(): Promise<string | null>;
  copyText(text: string): Promise<boolean>;
  getSettings(): Promise<Settings>;
  setSettings(partial: Partial<Settings>): Promise<Settings>;
  getEncoderInfo(): Promise<EncoderInfo>;
  checkForUpdate(): Promise<boolean>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): Promise<boolean>;
  openReleases(): Promise<boolean>;
  onUpdateStatus(cb: (p: UpdateStatus) => void): () => void;
}

interface Window {
  api: Api;
}

// `ffprobe-static` ships no type definitions; it exports an object with the
// resolved binary path. (`ffmpeg-static` does ship its own types.)
declare module 'ffprobe-static' {
  const ffprobe: { path: string };
  export = ffprobe;
}
