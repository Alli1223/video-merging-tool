const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// When the app is packaged into an asar archive the bundled binaries live in
// the ".unpacked" sibling directory. In dev (running `electron .`) there is no
// asar, so this replace is a harmless no-op.
function resolveBinary(p) {
  if (!p) return p;
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
          .replace('app.asar/', 'app.asar.unpacked/');
}

const FFMPEG = resolveBinary(ffmpegStatic);
const FFPROBE = resolveBinary(ffprobeStatic && ffprobeStatic.path);

// The currently running ffmpeg merge process (so it can be canceled).
let currentProc = null;
let canceled = false;

function assertBinaries() {
  if (!FFMPEG) throw new Error('FFmpeg binary not found. Run "npm install" to fetch ffmpeg-static.');
  if (!FFPROBE) throw new Error('FFprobe binary not found. Run "npm install" to fetch ffprobe-static.');
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

function runProbe(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file];
    const proc = spawn(FFPROBE, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + err));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function parseFps(rate) {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = String(rate).split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

// Probe one file and reduce ffprobe's output to the fields we care about.
async function probeFile(file) {
  assertBinaries();
  const data = await runProbe(file);
  const format = data.format || {};
  const streams = data.streams || [];

  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  // Skip "attached_pic" cover-art streams when a real video stream exists.
  const v = videoStreams.find((s) => !(s.disposition && s.disposition.attached_pic)) || videoStreams[0];
  const a = streams.find((s) => s.codec_type === 'audio');

  const duration = parseFloat(format.duration || (v && v.duration) || 0) || 0;
  const creationTimeTag =
    (format.tags && format.tags.creation_time) ||
    (v && v.tags && v.tags.creation_time) ||
    null;

  return {
    hasVideo: !!v,
    width: v ? v.width || 0 : 0,
    height: v ? v.height || 0 : 0,
    vcodec: v ? v.codec_name || null : null,
    pixfmt: v ? v.pix_fmt || null : null,
    fps: v ? parseFps(v.avg_frame_rate || v.r_frame_rate) : 0,
    hasAudio: !!a,
    acodec: a ? a.codec_name || null : null,
    sampleRate: a ? parseInt(a.sample_rate || 0, 10) || 0 : 0,
    channels: a ? a.channels || 0 : 0,
    duration,
    creationTimeTag
  };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

function grabFrame(file, seek) {
  return new Promise((resolve) => {
    const args = [
      '-ss', String(seek),
      '-i', file,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    ];
    const proc = spawn(FFMPEG, args);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      if (!chunks.length) return resolve(null);
      resolve('data:image/jpeg;base64,' + Buffer.concat(chunks).toString('base64'));
    });
  });
}

// Generate thumbnails for many clips with bounded concurrency, emitting each
// one as soon as it is ready so the UI can fill in progressively.
async function generateThumbnails(items, onThumb) {
  assertBinaries();
  const concurrency = Math.min(4, items.length || 1);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      const seek = Math.max(0, Math.min(item.duration ? item.duration * 0.1 : 1, 2));
      let thumb = await grabFrame(item.path, seek);
      if (!thumb) thumb = await grabFrame(item.path, 0); // retry on first frame
      onThumb({ path: item.path, thumb });
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

// Escape a path for an ffmpeg concat-demuxer list file. Forward slashes work on
// every platform; single quotes are escaped per the concat format rules.
function concatPath(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function isMp4Like(outputPath) {
  return ['.mp4', '.mov', '.m4v'].includes(path.extname(outputPath).toLowerCase());
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

// Run ffmpeg, parsing -progress output into a 0..100 percentage based on the
// known total output duration. Stores the process so cancel() can kill it.
function runFfmpeg(args, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    const proc = spawn(FFMPEG, fullArgs);
    currentProc = proc;

    let stdoutBuf = '';
    let errTail = '';

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop(); // keep the trailing partial line
      for (const line of lines) {
        const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          let percent = totalDuration > 0 ? (seconds / totalDuration) * 100 : 0;
          percent = Math.max(0, Math.min(99.5, percent));
          onProgress({ percent, seconds, totalDuration });
        }
      }
    });

    proc.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });

    proc.on('error', (e) => {
      currentProc = null;
      reject(e);
    });

    proc.on('close', (code) => {
      currentProc = null;
      if (canceled) {
        const err = new Error('Merge canceled');
        err.canceled = true;
        return reject(err);
      }
      if (code === 0) {
        onProgress({ percent: 100, totalDuration });
        return resolve();
      }
      reject(new Error('FFmpeg exited with code ' + code + '\n' + errTail.trim()));
    });
  });
}

// Lossless path: stream-copy with the concat demuxer. Requires all clips share
// the same codecs/parameters (the renderer only chooses this when compatible).
async function mergeCopy(clips, outputPath, totalDuration, onProgress) {
  const listFile = path.join(os.tmpdir(), `vmt-concat-${process.pid}-${Date.now()}.txt`);
  const listContent = clips.map((c) => `file '${concatPath(c.path)}'`).join('\n') + '\n';
  fs.writeFileSync(listFile, listContent, 'utf8');

  const args = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-map', '0'];
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);

  try {
    await runFfmpeg(args, totalDuration, onProgress);
  } finally {
    safeUnlink(listFile);
  }
  return { success: true, mode: 'copy', outputPath };
}

// Re-encode fallback: normalize every clip to a common resolution, frame rate,
// pixel format and audio layout, then concatenate with the concat filter. This
// is the path used when clips are not byte-compatible.
async function mergeReencode(clips, outputPath, totalDuration, onProgress) {
  // Target spec = the largest dimensions / highest frame rate among the clips.
  let W = 0, H = 0, F = 0;
  for (const c of clips) {
    if (c.width > W) W = c.width;
    if (c.height > H) H = c.height;
    if (c.fps > F) F = c.fps;
  }
  W = Math.max(2, W - (W % 2));
  H = Math.max(2, H - (H % 2));
  F = F > 0 ? Math.min(Math.round(F), 60) : 30;

  const anyAudio = clips.some((c) => c.hasAudio);

  // Build input args. Clips that lack audio get a matched silent track from an
  // anullsrc lavfi input so the concat filter sees a uniform stream layout.
  const inputArgs = [];
  let inputIndex = 0;
  const videoInputIdx = [];
  const audioInputIdx = [];

  clips.forEach((c) => {
    inputArgs.push('-i', c.path);
    videoInputIdx.push(inputIndex++);
  });

  if (anyAudio) {
    clips.forEach((c, i) => {
      if (c.hasAudio) {
        audioInputIdx[i] = videoInputIdx[i];
      } else {
        const dur = c.duration > 0 ? c.duration : 1;
        inputArgs.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
        audioInputIdx[i] = inputIndex++;
      }
    });
  }

  // Build the filter graph.
  const filters = [];
  const concatLabels = [];
  clips.forEach((c, i) => {
    filters.push(
      `[${videoInputIdx[i]}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${F},format=yuv420p[v${i}]`
    );
    if (anyAudio) {
      filters.push(`[${audioInputIdx[i]}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      concatLabels.push(`[v${i}][a${i}]`);
    } else {
      concatLabels.push(`[v${i}]`);
    }
  });

  const n = clips.length;
  const concatFilter = anyAudio
    ? `${concatLabels.join('')}concat=n=${n}:v=1:a=1[v][a]`
    : `${concatLabels.join('')}concat=n=${n}:v=1:a=0[v]`;
  const filterComplex = filters.join(';') + ';' + concatFilter;

  const args = [...inputArgs, '-filter_complex', filterComplex, '-map', '[v]'];
  if (anyAudio) args.push('-map', '[a]');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (anyAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);

  await runFfmpeg(args, totalDuration, onProgress);
  return { success: true, mode: 'reencode', outputPath };
}

// Entry point used by the IPC handler.
async function merge(opts, onProgress) {
  assertBinaries();
  canceled = false;
  const { clips, outputPath, mode } = opts;

  if (!clips || clips.length === 0) throw new Error('No clips to merge.');
  if (!outputPath) throw new Error('No output path provided.');

  const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);

  try {
    if (mode === 'reencode') {
      return await mergeReencode(clips, outputPath, totalDuration, onProgress);
    }
    return await mergeCopy(clips, outputPath, totalDuration, onProgress);
  } catch (err) {
    safeUnlink(outputPath); // remove the half-written output
    if (err && err.canceled) {
      return { success: false, canceled: true };
    }
    throw err;
  }
}

function cancel() {
  canceled = true;
  if (currentProc) {
    try { currentProc.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
}

module.exports = { probeFile, generateThumbnails, merge, cancel };
