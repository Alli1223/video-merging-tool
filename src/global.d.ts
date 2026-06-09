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

// A scanned, orderable clip. `thumb` is filled in asynchronously in the renderer.
interface Clip {
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
interface MergeClip extends VideoSpecClip {
  path: string;
  duration: number;
  hasAudio: boolean;
  hasVideo?: boolean;
  compatKey: string;
  name?: string;
}
interface EstimateClip extends VideoSpecClip {
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
  settings?: Settings;
  music?: MergeMusic | null;
}
// What the renderer sends over IPC — the main process attaches `settings`.
type MergePayload = Omit<MergeOptions, 'settings'>;

interface MergeResult {
  success: boolean;
  mode?: 'copy' | 'reencode' | 'hybrid';
  outputPath?: string;
  music?: boolean;
  musicFailed?: boolean;
  canceled?: boolean;
}

// Streamed merge progress (a superset across all phases).
interface Progress {
  percent: number;
  phase?: 'encoding' | 'joining' | 'music-prep' | 'music';
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
