// Pure helpers for detecting video files, deriving capture time, computing
// stream-compatibility keys and ordering clips. No FFmpeg / filesystem access
// lives here so the logic can be unit-tested in isolation.

import path from 'path';

export const VIDEO_EXTS = new Set<string>([
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts',
  '.wmv', '.flv', '.3gp', '.3g2', '.mpg', '.mpeg', '.mpe', '.vob', '.ogv',
  '.mxf', '.divx', '.asf', '.f4v'
]);

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTS.has(path.extname(name).toLowerCase());
}

// Pull a timestamp out of common camera/phone filename patterns, e.g.
// VID_20210115_143052.mp4, 2021-01-15 14.30.52.mov, 20210115143052.mkv.
export function parseFilenameDate(name: string): number | null {
  const m = name.match(
    /(19\d\d|20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ tT.]?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d))?/
  );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const t = dt.getTime();
  return Number.isNaN(t) ? null : t;
}

interface CaptureMeta {
  creationTimeTag?: string | null;
}
interface CaptureStat {
  birthtimeMs: number;
  mtimeMs: number;
}

// Decide which timestamp to sort a clip by, preferring the most trustworthy
// source: embedded metadata > filename pattern > filesystem created/modified.
export function resolveCaptureTime(
  meta: CaptureMeta,
  stat: CaptureStat,
  name: string
): { time: number; source: TimeSource } {
  const tag = meta.creationTimeTag ? Date.parse(meta.creationTimeTag) : NaN;
  if (!Number.isNaN(tag)) return { time: tag, source: 'metadata' };

  const fromName = parseFilenameDate(name);
  if (fromName) return { time: fromName, source: 'filename' };

  const birth = stat.birthtimeMs;
  const mod = stat.mtimeMs;
  // birthtime is reliable on Windows/macOS; on some Linux filesystems it is 0
  // or bogus, so only trust it when it is positive and not after mtime.
  if (birth && birth > 0 && birth <= mod + 1000) return { time: birth, source: 'created' };
  return { time: mod, source: 'modified' };
}

interface CompatMeta {
  vcodec: string | null;
  width: number;
  height: number;
  pixfmt: string | null;
  fps: number;
  acodec: string | null;
  sampleRate: number;
  channels: number;
}

// A key that is identical for clips that can be losslessly stream-copied
// together (same codecs and parameters). fps is rounded so 29.97 ≈ 30.
export function compatKey(meta: CompatMeta): string {
  return [
    meta.vcodec || 'novideo',
    `${meta.width}x${meta.height}`,
    meta.pixfmt || 'nopix',
    Math.round(meta.fps || 0),
    meta.acodec || 'noaudio',
    meta.sampleRate || 0,
    meta.channels || 0
  ].join('|');
}

interface SortableClip {
  name: string;
  sortTime: number;
}

export const comparators: Record<SortMode, (a: SortableClip, b: SortableClip) => number> = {
  'date-asc': (a, b) => (a.sortTime - b.sortTime) || a.name.localeCompare(b.name),
  'date-desc': (a, b) => (b.sortTime - a.sortTime) || a.name.localeCompare(b.name),
  'name-asc': (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  'name-desc': (a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })
};

// Return a new, sorted copy of the clips for the given mode (input untouched).
export function sortClips<T extends SortableClip>(clips: T[], mode: SortMode): T[] {
  const out = clips.slice();
  const cmp = comparators[mode];
  if (cmp) out.sort(cmp);
  return out;
}
