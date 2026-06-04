const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ffmpeg = require('./ffmpeg');

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.mts', '.m2ts', '.ts',
  '.wmv', '.flv', '.3gp', '.3g2', '.mpg', '.mpeg', '.mpe', '.vob', '.ogv',
  '.mxf', '.divx', '.asf', '.f4v'
]);

// Pull a timestamp out of common camera/phone filename patterns, e.g.
// VID_20210115_143052.mp4, 2021-01-15 14.30.52.mov, 20210115143052.mkv.
function parseFilenameDate(name) {
  const m = name.match(
    /(19\d\d|20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ tT.]?([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d))?/
  );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const t = dt.getTime();
  return Number.isNaN(t) ? null : t;
}

// Decide which timestamp to sort a clip by, preferring the most trustworthy
// source: embedded metadata > filename pattern > filesystem created/modified.
function resolveCaptureTime(meta, stat, name) {
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

function compatKey(meta) {
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

// Probe a list of files with bounded concurrency.
async function probeAll(files) {
  const concurrency = Math.min(6, files.length || 1);
  const results = new Array(files.length);
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const i = cursor++;
      const file = files[i];
      try {
        const [meta, stat] = await Promise.all([
          ffmpeg.probeFile(file),
          fsp.stat(file)
        ]);
        results[i] = { file, meta, stat };
      } catch (_) {
        results[i] = null; // unreadable / not a real media file — drop it
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results.filter(Boolean);
}

async function scanDirectory(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name));

  const probed = await probeAll(files);

  let idCounter = 0;
  const clips = probed
    .filter((p) => p.meta.hasVideo) // only keep entries with a real video stream
    .map(({ file, meta, stat }) => {
      const name = path.basename(file);
      const capture = resolveCaptureTime(meta, stat, name);
      return {
        id: ++idCounter,
        path: file,
        name,
        ext: path.extname(file).replace('.', '').toLowerCase(),
        size: stat.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        vcodec: meta.vcodec,
        acodec: meta.acodec,
        pixfmt: meta.pixfmt,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        hasVideo: meta.hasVideo,
        hasAudio: meta.hasAudio,
        sortTime: capture.time,
        timeSource: capture.source,
        compatKey: compatKey(meta)
      };
    });

  // Default order: oldest first by capture time, name as a tiebreaker.
  clips.sort((a, b) => (a.sortTime - b.sortTime) || a.name.localeCompare(b.name));

  return { dir, clips };
}

module.exports = { scanDirectory };
