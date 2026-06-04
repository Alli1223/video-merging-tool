const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const {
  parseFps, concatListContent, buildCopyArgs, buildReencodeArgs,
  parseProgressTime, computePercent
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

async function mergeReencode(clips, outputPath, totalDuration, onProgress) {
  // Write the (potentially huge) filter graph to a file so the command line
  // can't overflow the OS limit with many clips (spawn ENAMETOOLONG).
  const filterScript = path.join(os.tmpdir(), `vmt-filter-${process.pid}-${Date.now()}.txt`);
  const { args, filterComplex } = buildReencodeArgs(clips, outputPath, filterScript);
  fs.writeFileSync(filterScript, filterComplex, 'utf8');
  try {
    await runFfmpeg(args, totalDuration, onProgress);
  } finally {
    safeUnlink(filterScript);
  }
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

module.exports = { probeFile, generateThumbnails, merge, cancel, binaryInfo };
