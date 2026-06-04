const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const {
  parseFps, concatListContent, buildCopyArgs, buildReencodeArgs,
  resolveTarget, buildSegmentArgs, parseProgressTime, computePercent
} = require('./ffargs');
const log = require('./logger');

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

// Report resolved binary paths and whether they exist — logged at startup so a
// packaging / asar-unpack path problem (a common cause of "0 clips found") is
// immediately visible in the log.
function binaryInfo() {
  return {
    ffmpeg: FFMPEG,
    ffmpegExists: !!(FFMPEG && fs.existsSync(FFMPEG)),
    ffprobe: FFPROBE,
    ffprobeExists: !!(FFPROBE && fs.existsSync(FFPROBE))
  };
}

// ---------------------------------------------------------------------------
// Encoder detection (NVIDIA NVENC)
// ---------------------------------------------------------------------------
let encoderCache = null;

function probeEncoder(name) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '1', '-c:v', name, '-f', 'null', '-'];
    const p = spawn(FFMPEG, args);
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Detect which NVENC encoders actually work here (needs an NVIDIA GPU + drivers).
async function detectEncoders() {
  if (encoderCache) return encoderCache;
  if (!FFMPEG) return { h264_nvenc: false, hevc_nvenc: false };
  const [h264, hevc] = await Promise.all([probeEncoder('h264_nvenc'), probeEncoder('hevc_nvenc')]);
  encoderCache = { h264_nvenc: h264, hevc_nvenc: hevc };
  log.info('Encoder detection (NVENC):', encoderCache);
  return encoderCache;
}

// Does this clip already match the target video spec exactly (so it can be kept
// losslessly via stream copy)?
function matchesTargetVideo(clip, target, codecName) {
  return clip.width === target.W && clip.height === target.H &&
    Math.round(clip.fps || 0) === target.F && clip.vcodec === codecName;
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

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
}

// Run ffmpeg, parsing -progress output into a 0..100 percentage based on the
// known total output duration. Stores the process so cancel() can kill it.
function runFfmpeg(args, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    log.info('Running FFmpeg:', FFMPEG, fullArgs.join(' '));
    const proc = spawn(FFMPEG, fullArgs);
    currentProc = proc;

    let stdoutBuf = '';
    let errTail = '';

    proc.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop(); // keep the trailing partial line
      for (const line of lines) {
        const seconds = parseProgressTime(line);
        if (seconds != null) {
          onProgress({ percent: computePercent(seconds, totalDuration), seconds, totalDuration });
        }
      }
    });

    proc.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });

    proc.on('error', (e) => {
      currentProc = null;
      log.error('Failed to launch FFmpeg:', String((e && e.message) || e));
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
      log.error(`FFmpeg exited with code ${code}. stderr tail:\n${errTail.trim()}`);
      reject(new Error('FFmpeg exited with code ' + code + '\nCommand: ' + fullArgs.join(' ') + '\n' + errTail.trim()));
    });
  });
}

async function mergeCopy(clips, outputPath, totalDuration, onProgress) {
  const listFile = path.join(os.tmpdir(), `vmt-concat-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(listFile, concatListContent(clips), 'utf8');
  try {
    await runFfmpeg(buildCopyArgs(listFile, outputPath), totalDuration, onProgress);
  } finally {
    safeUnlink(listFile);
  }
  return { success: true, mode: 'copy', outputPath };
}

async function mergeReencode(clips, outputPath, target, encOpts, totalDuration, onProgress) {
  // Full single-pass re-encode with the concat filter (fallback path). The
  // (potentially huge) filter graph goes to a file to avoid command-line limits.
  const filterScript = path.join(os.tmpdir(), `vmt-filter-${process.pid}-${Date.now()}.txt`);
  const { args, filterComplex } = buildReencodeArgs(clips, outputPath, filterScript, target, encOpts);
  fs.writeFileSync(filterScript, filterComplex, 'utf8');
  try {
    await runFfmpeg(args, totalDuration, onProgress);
  } finally {
    safeUnlink(filterScript);
  }
  return { success: true, mode: 'reencode', outputPath };
}

// Per-clip path: clips that already match the target keep their video stream
// (lossless); the rest are re-encoded to the target. Each clip becomes a
// normalized segment, then all segments are joined by stream copy. Falls back
// to a full re-encode if the stream-copy join fails.
async function mergeHybrid(clips, outputPath, target, encOpts, codecName, totalDuration, onProgress, forceReencode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmt-seg-'));
  const segments = [];
  try {
    let done = 0;
    let useNvencNow = encOpts.useNvenc;
    for (let i = 0; i < clips.length; i++) {
      if (canceled) { const e = new Error('Merge canceled'); e.canceled = true; throw e; }
      const clip = clips[i];
      const seg = path.join(tmpDir, `seg-${String(i).padStart(4, '0')}.mp4`);
      const copyVideo = !forceReencode && matchesTargetVideo(clip, target, codecName);
      const base = done;
      const onSeg = (p) => {
        // Per-clip processing occupies 0..92% of the progress bar.
        onProgress({ percent: computePercent(base + (p.seconds || 0), totalDuration) * 0.92, phase: 'encoding', clip: i + 1, total: clips.length });
      };
      try {
        await runFfmpeg(buildSegmentArgs(clip, target, { ...encOpts, useNvenc: useNvencNow }, seg, copyVideo), clip.duration || 0, onSeg);
      } catch (e) {
        if (canceled || copyVideo || !useNvencNow) throw e;
        // GPU encode failed (e.g. resolution/codec the GPU can't do) — drop to
        // CPU for this clip and the rest of the merge.
        log.warn(`GPU encode failed for clip ${i + 1}; retrying this and the remaining clips on CPU:`, String((e && e.message) || e));
        useNvencNow = false;
        safeUnlink(seg);
        await runFfmpeg(buildSegmentArgs(clip, target, { ...encOpts, useNvenc: false }, seg, false), clip.duration || 0, onSeg);
      }
      done += clip.duration || 0;
      segments.push(seg);
    }

    const listFile = path.join(tmpDir, 'segments.txt');
    fs.writeFileSync(listFile, concatListContent(segments.map((s) => ({ path: s }))), 'utf8');
    try {
      await runFfmpeg(buildCopyArgs(listFile, outputPath), totalDuration,
        (p) => onProgress({ percent: 92 + (p.percent || 0) * 0.08, phase: 'joining' }));
    } catch (joinErr) {
      if (canceled) throw joinErr;
      log.warn('Stream-copy join failed; falling back to a full re-encode:', String((joinErr && joinErr.message) || joinErr));
      await mergeReencode(clips, outputPath, target, encOpts, totalDuration, onProgress);
    }
    return { success: true, mode: 'hybrid', outputPath };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

// Entry point used by the IPC handler.
async function merge(opts, onProgress) {
  assertBinaries();
  canceled = false;
  const { clips, outputPath, forceReencode } = opts;
  const settings = opts.settings || {};

  if (!clips || clips.length === 0) throw new Error('No clips to merge.');
  if (!outputPath) throw new Error('No output path provided.');

  const target = resolveTarget(clips, settings);
  const codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
  const quality = settings.quality || 'near';

  // Resolve GPU vs CPU.
  const enc = await detectEncoders();
  const nvencForCodec = codec === 'hevc' ? enc.hevc_nvenc : enc.h264_nvenc;
  const wanted = settings.encoder || 'auto';
  let useNvenc = wanted === 'cpu' ? false : nvencForCodec;
  if (wanted === 'nvenc' && !nvencForCodec) log.warn('NVENC requested but unavailable for', codec, '- using CPU.');
  // NVENC has a max resolution (~4096px for H.264, ~8192px for HEVC). Above that
  // the GPU encoder can't open ("Width NNNN exceeds 4096"), so use the CPU.
  const nvencMax = codec === 'hevc' ? 8192 : 4096;
  if (useNvenc && (target.W > nvencMax || target.H > nvencMax)) {
    log.warn(`Target ${target.W}x${target.H} exceeds ${codec} NVENC limit (${nvencMax}px); using CPU.`);
    useNvenc = false;
  }
  const encOpts = { codec, useNvenc, quality };
  log.info('Merge:', { clips: clips.length, target, codec, quality, encoder: wanted, useNvenc });

  const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);

  try {
    const allMatch = clips.every((c) => matchesTargetVideo(c, target, codec));
    const allCompat = new Set(clips.map((c) => c.compatKey)).size === 1;
    if (!forceReencode && allMatch && allCompat) {
      return await mergeCopy(clips, outputPath, totalDuration, onProgress);
    }
    return await mergeHybrid(clips, outputPath, target, encOpts, codec, totalDuration, onProgress, forceReencode);
  } catch (err) {
    safeUnlink(outputPath); // remove the half-written output
    if (err && err.canceled) return { success: false, canceled: true };
    throw err;
  }
}

function cancel() {
  canceled = true;
  if (currentProc) {
    try { currentProc.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }
}

module.exports = { probeFile, generateThumbnails, merge, cancel, binaryInfo, detectEncoders };
