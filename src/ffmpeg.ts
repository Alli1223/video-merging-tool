import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import {
  parseFps, concatListContent, buildCopyArgs, buildReencodeArgs,
  resolveTarget, buildSegmentArgs, parseProgressTime, computePercent,
  planMusic, buildLoopUnitArgs, buildMusicMuxArgs,
  buildVerifyArgs, buildVideoCrcArgs, parseCrcOutput, assessIntegrity, durationTolerance,
  splitLimitBytes, partPath, planParts
} from './ffargs';
import * as log from './logger';

// ---------------------------------------------------------------------------
// Error helpers (catch clauses are typed `unknown` under strict mode)
// ---------------------------------------------------------------------------
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function errStack(e: unknown): string {
  return e instanceof Error && e.stack ? e.stack : String(e);
}
interface CancelableError extends Error { canceled?: boolean }
function canceledError(): CancelableError {
  const e: CancelableError = new Error('Merge canceled');
  e.canceled = true;
  return e;
}
function isCanceled(e: unknown): boolean {
  return !!(e && typeof e === 'object' && (e as CancelableError).canceled);
}

// When the app is packaged into an asar archive the bundled binaries live in
// the ".unpacked" sibling directory. In dev (running `electron .`) there is no
// asar, so this replace is a harmless no-op.
function resolveBinary(p: string | null): string | null {
  if (!p) return p;
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
          .replace('app.asar/', 'app.asar.unpacked/');
}

const FFMPEG = resolveBinary(ffmpegStatic);
const FFPROBE = resolveBinary(ffprobeStatic.path);

// The currently running ffmpeg merge process (so it can be canceled).
let currentProc: ChildProcess | null = null;
let canceled = false;

// Resolve the binary paths, throwing a clear error if they are missing.
function ffmpegBin(): string {
  if (!FFMPEG) throw new Error('FFmpeg binary not found. Run "npm install" to fetch ffmpeg-static.');
  return FFMPEG;
}
function ffprobeBin(): string {
  if (!FFPROBE) throw new Error('FFprobe binary not found. Run "npm install" to fetch ffprobe-static.');
  return FFPROBE;
}
function assertBinaries(): void {
  ffmpegBin();
  ffprobeBin();
}

// Report resolved binary paths and whether they exist — logged at startup so a
// packaging / asar-unpack path problem (a common cause of "0 clips found") is
// immediately visible in the log.
export function binaryInfo(): { ffmpeg: string | null; ffmpegExists: boolean; ffprobe: string | null; ffprobeExists: boolean } {
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
let encoderCache: EncoderInfo | null = null;

function probeEncoder(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '1', '-c:v', name, '-f', 'null', '-'];
    const p = spawn(ffmpegBin(), args);
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

// Detect which NVENC encoders actually work here (needs an NVIDIA GPU + drivers).
export async function detectEncoders(): Promise<EncoderInfo> {
  if (encoderCache) return encoderCache;
  if (!FFMPEG) return { h264_nvenc: false, hevc_nvenc: false };
  const [h264, hevc] = await Promise.all([probeEncoder('h264_nvenc'), probeEncoder('hevc_nvenc')]);
  encoderCache = { h264_nvenc: h264, hevc_nvenc: hevc };
  log.info('Encoder detection (NVENC):', encoderCache);
  return encoderCache;
}

// Does this clip already match the target video spec exactly (so it can be kept
// losslessly via stream copy)?
function matchesTargetVideo(clip: VideoSpecClip, target: Target, codecName: Codec): boolean {
  return clip.width === target.W && clip.height === target.H &&
    Math.round(clip.fps || 0) === target.F && clip.vcodec === codecName;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { creation_time?: string };
}
interface FfprobeFormat {
  duration?: string;
  tags?: { creation_time?: string };
}
interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

function runProbe(file: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file];
    const proc = spawn(ffprobeBin(), args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d; });
    proc.stderr.on('data', (d: Buffer) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed: ' + err));
      try { resolve(JSON.parse(out) as FfprobeOutput); } catch (e) { reject(e); }
    });
  });
}

// Probe one file and reduce ffprobe's output to the fields we care about.
export async function probeFile(file: string): Promise<ProbeResult> {
  assertBinaries();
  const data = await runProbe(file);
  const format = data.format || {};
  const streams = data.streams || [];

  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  // Skip "attached_pic" cover-art streams when a real video stream exists.
  const v = videoStreams.find((s) => !(s.disposition && s.disposition.attached_pic)) || videoStreams[0];
  const a = streams.find((s) => s.codec_type === 'audio');

  const duration = parseFloat(format.duration || (v && v.duration) || '0') || 0;
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
    sampleRate: a && a.sample_rate ? parseInt(a.sample_rate, 10) || 0 : 0,
    channels: a ? a.channels || 0 : 0,
    duration,
    creationTimeTag
  };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

function grabFrame(file: string, seek: number): Promise<string | null> {
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
    const proc = spawn(ffmpegBin(), args);
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
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
export async function generateThumbnails(items: ThumbInput[], onThumb: (t: ThumbDone) => void): Promise<void> {
  assertBinaries();
  const concurrency = Math.min(4, items.length || 1);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      const seek = Math.max(0, Math.min(item.duration ? item.duration * 0.1 : 1, 2));
      let thumb = await grabFrame(item.path, seek);
      if (!thumb) thumb = await grabFrame(item.path, 0); // retry on first frame
      onThumb({ path: item.path, thumb });
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

type ProgressCb = (p: Progress) => void;

// Run ffmpeg, parsing -progress output into a 0..100 percentage based on the
// known total output duration. Stores the process so cancel() can kill it.
function runFfmpeg(args: string[], totalDuration: number, onProgress: ProgressCb): Promise<void> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    log.info('Running FFmpeg:', ffmpegBin(), fullArgs.join(' '));
    const proc = spawn(ffmpegBin(), fullArgs);
    currentProc = proc;

    let stdoutBuf = '';
    let errTail = '';
    let cur: { seconds?: number; fps?: number; speed?: number; bitrate?: string } = {};

    proc.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? ''; // keep the trailing partial line
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key === 'out_time') { const s = parseProgressTime(line); if (s != null) cur.seconds = s; }
        else if (key === 'fps') cur.fps = parseFloat(val) || 0;
        else if (key === 'speed') cur.speed = parseFloat(val) || 0; // "2.5x" -> 2.5
        else if (key === 'bitrate') cur.bitrate = val.trim();
        else if (key === 'progress') {
          // end of one progress block — emit a snapshot
          if (cur.seconds != null) {
            onProgress({ percent: computePercent(cur.seconds, totalDuration), seconds: cur.seconds, fps: cur.fps || 0, speed: cur.speed || 0, bitrate: cur.bitrate || '', totalDuration });
          }
          cur = {};
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });

    proc.on('error', (e) => {
      currentProc = null;
      log.error('Failed to launch FFmpeg:', errMsg(e));
      reject(e);
    });

    proc.on('close', (code) => {
      currentProc = null;
      if (canceled) {
        return reject(canceledError());
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

// ---------------------------------------------------------------------------
// Integrity verification (decode check + CRC content compare)
// ---------------------------------------------------------------------------

interface VerifyRunResult {
  exitCode: number | null;
  errorCount: number;
  errorSample: string[];
  decodedDuration: number | null;
}

// Run ffmpeg purely as a decoder/verifier. Unlike runFfmpeg, a non-zero exit
// is data (the file is damaged), not an exception; decode errors are collected
// from stderr (bounded), and -progress provides both a progress callback and
// the actually-decodable duration (its last out_time).
function runVerifyFfmpeg(args: string[], totalDuration: number, onProgress: ProgressCb): Promise<VerifyRunResult> {
  return new Promise((resolve, reject) => {
    const fullArgs = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    log.info('Verifying with FFmpeg:', ffmpegBin(), fullArgs.join(' '));
    const proc = spawn(ffmpegBin(), fullArgs);
    currentProc = proc;

    let stdoutBuf = '';
    let lastSeconds: number | null = null;
    let errBuf = '';
    let errorCount = 0;
    const errorSample: string[] = [];

    const noteErrorLine = (line: string): void => {
      const t = line.trim();
      if (!t) return;
      errorCount++;
      if (errorSample.length < 5) errorSample.push(t.slice(0, 300));
    };

    proc.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const s = parseProgressTime(line);
        if (s != null) {
          lastSeconds = s;
          onProgress({ percent: computePercent(s, totalDuration), seconds: s, totalDuration });
        }
      }
    });

    proc.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString();
      const lines = errBuf.split(/\r?\n/);
      errBuf = lines.pop() ?? '';
      for (const line of lines) noteErrorLine(line);
    });

    proc.on('error', (e) => {
      currentProc = null;
      reject(e);
    });

    proc.on('close', (code) => {
      currentProc = null;
      if (errBuf.trim()) noteErrorLine(errBuf);
      if (canceled) return reject(canceledError());
      resolve({ exitCode: code, errorCount, errorSample, decodedDuration: lastSeconds });
    });
  });
}

function readTextSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function summarizeIssues(r: VerifyReport): string {
  return r.issues.map((i) => `${i.kind}: ${i.detail}`).join('; ') || 'unknown issue';
}

interface VerifyFileOpts {
  expectedDuration?: number;
  // When set, also CRC-compare the decoded video frames against this file
  // (used for stream-copied segments, whose content must equal the source's).
  crcCompareSource?: string | null;
  onProgress?: ProgressCb;
}

// Integrity-check one produced file: decode every stream and flag decode
// errors, confirm the decodable duration, and (for stream-copied video)
// compare a CRC-32 of the decoded frames against the source file.
export async function verifyFile(file: string, opts: VerifyFileOpts = {}): Promise<VerifyReport> {
  assertBinaries();
  const onProg: ProgressCb = opts.onProgress || (() => {});
  const expected = opts.expectedDuration || 0;
  const wantCrc = !!opts.crcCompareSource;
  const crcBase = path.join(os.tmpdir(), `vmt-crc-${process.pid}-${Date.now()}`);
  const outCrcPath = wantCrc ? crcBase + '-out.txt' : undefined;

  const run = await runVerifyFfmpeg(buildVerifyArgs(file, outCrcPath), expected, onProg);
  let crc: string | null = null;
  let expectedCrc: string | null = null;
  const extraIssues: VerifyIssue[] = [];

  if (outCrcPath) {
    crc = parseCrcOutput(readTextSafe(outCrcPath));
    safeUnlink(outCrcPath);
  }

  // The CRC compare is only meaningful when the file itself decoded cleanly
  // (a damaged copy already fails on its own decode errors above).
  if (wantCrc && run.exitCode === 0 && run.errorCount === 0) {
    const srcCrcPath = crcBase + '-src.txt';
    const srcRun = await runVerifyFfmpeg(buildVideoCrcArgs(opts.crcCompareSource as string, srcCrcPath), expected, onProg);
    expectedCrc = parseCrcOutput(readTextSafe(srcCrcPath));
    safeUnlink(srcCrcPath);
    if (srcRun.exitCode !== 0 || !crc || !expectedCrc) {
      extraIssues.push({ kind: 'crc', detail: 'could not CRC-compare the copied video against its source' });
      expectedCrc = null;
    }
  }

  const report = assessIntegrity({
    exitCode: run.exitCode,
    errorCount: run.errorCount,
    errorSample: run.errorSample,
    decodedDuration: run.decodedDuration,
    expectedDuration: expected || null,
    crc,
    expectedCrc
  });
  if (extraIssues.length) return { ok: false, issues: [...report.issues, ...extraIssues] };
  return report;
}

async function mergeCopy(clips: { path: string }[], outputPath: string, totalDuration: number, onProgress: ProgressCb): Promise<MergeResult> {
  const listFile = path.join(os.tmpdir(), `vmt-concat-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(listFile, concatListContent(clips), 'utf8');
  try {
    await runFfmpeg(buildCopyArgs(listFile, outputPath), totalDuration, onProgress);
  } finally {
    safeUnlink(listFile);
  }
  return { success: true, mode: 'copy', outputPath };
}

async function mergeReencode(clips: MergeClip[], outputPath: string, target: Target, encOpts: EncodeOpts, totalDuration: number, onProgress: ProgressCb): Promise<MergeResult> {
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
async function mergeHybrid(clips: MergeClip[], outputPath: string, target: Target, encOpts: EncodeOpts, codecName: Codec, totalDuration: number, onProgress: ProgressCb, forceReencode?: boolean): Promise<MergeResult> {
  // Keep the working segments on the SAME drive as the output: this avoids
  // filling the system drive (C:) with potentially many GB of intermediates,
  // and makes the final stream-copy join a fast same-volume operation. Fall
  // back to the system temp dir only if the output folder isn't writable.
  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(path.dirname(outputPath), 'vmt-tmp-'));
  } catch (e) {
    log.warn('Could not create a temp folder next to the output; using system temp:', errMsg(e));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmt-seg-'));
  }
  log.info('Hybrid merge working dir:', tmpDir);
  const segments: string[] = [];
  const repaired: RepairedClip[] = [];
  const unresolved: string[] = [];
  try {
    let done = 0;
    let useNvencNow = encOpts.useNvenc;
    for (let i = 0; i < clips.length; i++) {
      if (canceled) { throw canceledError(); }
      const clip = clips[i];
      const clipName = clip.name || path.basename(String(clip.path || ''));
      const seg = path.join(tmpDir, `seg-${String(i).padStart(4, '0')}.mp4`);
      let copyNow = !forceReencode && matchesTargetVideo(clip, target, codecName);
      const base = done;
      const onSeg: ProgressCb = (p) => {
        // Per-clip processing occupies 0..92% of the progress bar.
        onProgress({
          percent: computePercent(base + (p.seconds || 0), totalDuration) * 0.92,
          phase: 'encoding', clip: i + 1, total: clips.length,
          clipName,
          action: copyNow ? 'copy' : 'encode',
          encoder: useNvencNow ? 'gpu' : 'cpu',
          codec: encOpts.codec,
          fps: p.fps, speed: p.speed
        });
      };
      const onVerify: ProgressCb = (p) => {
        // The check decodes the just-written segment, so it advances within
        // the same slice of the bar the clip already occupies.
        onProgress({
          percent: computePercent(base + (p.seconds || 0), totalDuration) * 0.92,
          phase: 'verifying', clip: i + 1, total: clips.length, clipName
        });
      };

      const buildSegment = async (): Promise<void> => {
        try {
          await runFfmpeg(buildSegmentArgs(clip, target, { ...encOpts, useNvenc: useNvencNow }, seg, copyNow), clip.duration || 0, onSeg);
        } catch (e) {
          if (canceled) throw e;
          if (copyNow) {
            // Even the lossless remux failed — the source bitstream is suspect,
            // so fall back to a clean re-encode of this clip.
            log.warn(`Stream-copying clip ${i + 1} failed; re-encoding it instead:`, errMsg(e));
            copyNow = false;
            repaired.push({ name: clipName, reason: 'process' });
            safeUnlink(seg);
            await buildSegment();
            return;
          }
          if (!useNvencNow) throw e;
          // GPU encode failed (e.g. resolution/codec the GPU can't do) — drop to
          // CPU for this clip and the rest of the merge.
          log.warn(`GPU encode failed for clip ${i + 1}; retrying this and the remaining clips on CPU:`, errMsg(e));
          useNvencNow = false;
          safeUnlink(seg);
          await runFfmpeg(buildSegmentArgs(clip, target, { ...encOpts, useNvenc: false }, seg, false), clip.duration || 0, onSeg);
        }
      };
      await buildSegment();

      // Integrity-check the segment we just produced. A stream-copied segment
      // is additionally CRC-compared against its source, so damage in the
      // source (or a bad write) can't ride a lossless copy into the output.
      let report = await verifyFile(seg, {
        expectedDuration: clip.duration || 0,
        crcCompareSource: copyNow ? clip.path : null,
        onProgress: onVerify
      });
      if (!report.ok) {
        const reason: VerifyIssueKind = report.issues[0] ? report.issues[0].kind : 'decode';
        log.warn(`Clip ${i + 1}/${clips.length} (${clipName}) failed its integrity check — ${summarizeIssues(report)} — rebuilding it with a re-encode.`);
        // Re-encoding decodes around damaged regions (error concealment)
        // instead of copying them; a corrupt GPU encode is redone on the CPU.
        const wasCopy = copyNow;
        copyNow = false;
        if (!wasCopy) useNvencNow = false;
        safeUnlink(seg);
        await buildSegment();
        report = await verifyFile(seg, { expectedDuration: clip.duration || 0, onProgress: onVerify });
        if (report.ok) {
          if (!repaired.some((r) => r.name === clipName)) repaired.push({ name: clipName, reason });
          log.info(`Clip ${i + 1} (${clipName}) repaired by re-encoding (original problem: ${reason}).`);
        } else {
          // Still failing after a rebuild (e.g. the source is too damaged to
          // decode at full length). Keep the best effort and tell the user.
          unresolved.push(`${clipName} (${summarizeIssues(report)})`);
          log.error(`Clip ${i + 1} (${clipName}) still fails verification after re-encoding: ${summarizeIssues(report)}`);
        }
      }

      done += clip.duration || 0;
      segments.push(seg);
    }

    const listFile = path.join(tmpDir, 'segments.txt');
    fs.writeFileSync(listFile, concatListContent(segments.map((s) => ({ path: s }))), 'utf8');
    try {
      await runFfmpeg(buildCopyArgs(listFile, outputPath), totalDuration,
        (p) => onProgress({ percent: 92 + (p.percent || 0) * 0.08, phase: 'joining', fps: p.fps, speed: p.speed }));
    } catch (joinErr) {
      if (canceled) throw joinErr;
      log.warn('Stream-copy join failed; falling back to a full re-encode:', errMsg(joinErr));
      await mergeReencode(clips, outputPath, target, encOpts, totalDuration, onProgress);
    }
    const result: MergeResult = { success: true, mode: 'hybrid', outputPath };
    if (repaired.length) result.repaired = repaired;
    if (unresolved.length) result.verifyNote = 'could not fully verify ' + unresolved.join('; ');
    return result;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Background music
// ---------------------------------------------------------------------------

// Probe each music track for its duration (needed to size crossfades).
async function probeMusicDurations(paths: string[]): Promise<TrackDuration[]> {
  const out: TrackDuration[] = [];
  for (const p of paths) {
    let duration = 0;
    try { duration = (await probeFile(p)).duration || 0; }
    catch (e) { log.warn('Could not probe music track', p, '-', errMsg(e)); }
    out.push({ path: p, duration });
  }
  return out;
}

interface MusicParams {
  videoPath: string;
  trackPaths: string[];
  outputPath: string;
  totalDuration: number;
  options?: Partial<MusicOptions>;
}

// Add a looping, crossfaded background-music bed to an already-merged (silent)
// video. Two ffmpeg passes: (1) crossfade the track pool into one seamless
// "loop unit"; (2) stream-loop that unit under the whole video with fades,
// stream-copying the video so the footage is never re-encoded.
export async function addBackgroundMusic(params: MusicParams, onProgress: ProgressCb): Promise<{ success: boolean; outputPath: string }> {
  const { videoPath, trackPaths, outputPath, totalDuration } = params;
  assertBinaries();
  const tracks = (await probeMusicDurations(trackPaths)).filter((t) => fs.existsSync(t.path));
  if (!tracks.length) throw new Error('No usable music tracks were provided.');
  const plan = planMusic(totalDuration, params.options);

  // Work next to the output (same drive) so the final mux is a fast same-volume
  // operation and we don't fill the system drive.
  let tmpDir: string;
  try { tmpDir = fs.mkdtempSync(path.join(path.dirname(outputPath), 'vmt-music-')); }
  catch { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmt-music-')); }
  const loopUnit = path.join(tmpDir, 'loopunit.m4a');
  const filterScript = path.join(tmpDir, 'music-filter.txt');
  log.info('Background music:', { tracks: tracks.length, plan, tmpDir });

  try {
    // Pass 1 — build the crossfaded loop unit.
    const { args: luArgs, filterComplex, crossfade } = buildLoopUnitArgs(tracks, filterScript, loopUnit, { crossfade: plan.crossfade });
    const loopDur = Math.max(0, tracks.reduce((s, t) => s + (t.duration || 0), 0) - Math.max(0, tracks.length - 1) * crossfade);
    fs.writeFileSync(filterScript, filterComplex, 'utf8');
    await runFfmpeg(luArgs, loopDur, (p) =>
      onProgress({ percent: p.percent || 0, phase: 'music-prep', fps: p.fps, speed: p.speed }));

    if (canceled) { throw canceledError(); }

    // Pass 2 — loop the unit under the video, with fades, trimmed to length.
    await runFfmpeg(buildMusicMuxArgs(videoPath, loopUnit, outputPath, totalDuration, plan), totalDuration, (p) =>
      onProgress({ percent: p.percent || 0, phase: 'music', fps: p.fps, speed: p.speed }));
    return { success: true, outputPath };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// A temp path next to the final output for the pre-music (silent) video.
function siblingTempVideo(outputPath: string): string {
  const ext = path.extname(outputPath) || '.mp4';
  return path.join(path.dirname(outputPath), `.vmt-nomusic-${process.pid}-${Date.now()}${ext}`);
}

// Merge one set of clips into ONE output file (the pre-split engine flow).
async function mergeSingle(opts: MergeOptions, onProgress: ProgressCb): Promise<MergeResult> {
  assertBinaries();
  const { clips, outputPath, forceReencode } = opts;
  const settings: Partial<Settings> = opts.settings || {};

  if (!clips || clips.length === 0) throw new Error('No clips to merge.');
  if (!outputPath) throw new Error('No output path provided.');

  // A size-split merge pins the target from the FULL clip list so every part
  // comes out at the same resolution/fps.
  const target = opts.targetOverride || resolveTarget(clips, settings);
  const codec: Codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
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
  const encOpts: EncodeOpts = { codec, useNvenc, quality };
  log.info('Merge:', { clips: clips.length, target, codec, quality, encoder: wanted, useNvenc });

  const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0);

  // Optional background music. When requested, the clips are merged to a temp
  // (silent) video first, then a music bed is added in a video-copy pass. The
  // video merge fills 0..90% of the progress bar and the music pass 90..100%.
  const music = opts.music && Array.isArray(opts.music.trackPaths) && opts.music.trackPaths.length ? opts.music : null;
  const videoTarget = music ? siblingTempVideo(outputPath) : outputPath;
  const videoProgress: ProgressCb = music ? (p) => onProgress({ ...p, percent: (p.percent || 0) * 0.9 }) : onProgress;

  try {
    const allMatch = clips.every((c) => matchesTargetVideo(c, target, codec));
    const allCompat = new Set(clips.map((c) => c.compatKey)).size === 1;

    // The merge work fills 0..86% of the (video-side) progress and the final
    // verification pass 86..100%. With music enabled both sit inside the
    // 0..90% video share set up above.
    const workProgress: ProgressCb = (p) => videoProgress({ ...p, percent: (p.percent || 0) * 0.86 });
    const verifyProgress: ProgressCb = (p) =>
      videoProgress({ percent: 86 + (p.percent || 0) * 0.14, phase: 'verifying', seconds: p.seconds, totalDuration });

    let result: MergeResult;
    if (!forceReencode && allMatch && allCompat) {
      result = await mergeCopy(clips, videoTarget, totalDuration, workProgress);
    } else {
      result = await mergeHybrid(clips, videoTarget, target, encOpts, codec, totalDuration, workProgress, forceReencode);
    }

    // Final integrity pass: decode the whole merged file end to end so any
    // corruption (a damaged source copied through, a truncated write, a bad
    // join) is caught now rather than discovered during playback.
    log.info('Verifying merged output:', videoTarget);
    let report = await verifyFile(videoTarget, { expectedDuration: totalDuration, onProgress: verifyProgress });
    if (!report.ok) {
      log.warn(`Merged output failed verification (${summarizeIssues(report)}); repairing.`);
      const prev = result;
      safeUnlink(videoTarget);
      if (prev.mode === 'copy') {
        // Redo the merge per clip: each clip is individually verified and only
        // the damaged ones get re-encoded, so the repair touches just what is
        // actually broken.
        result = await mergeHybrid(clips, videoTarget, target, encOpts, codec, totalDuration, workProgress, forceReencode);
      } else {
        // The per-clip path already verified its segments, so the remaining
        // suspect is the join — rebuild with the single-pass re-encoder.
        result = await mergeReencode(clips, videoTarget, target, encOpts, totalDuration, workProgress);
        if (prev.repaired) result.repaired = prev.repaired;
        if (prev.verifyNote) result.verifyNote = prev.verifyNote;
      }
      report = await verifyFile(videoTarget, { expectedDuration: totalDuration, onProgress: verifyProgress });
    }
    result.verified = report.ok;
    if (!report.ok) {
      result.verifyNote = [result.verifyNote, summarizeIssues(report)].filter(Boolean).join('; ');
      log.error('Merged output still fails verification after repair; keeping the best effort.', result.verifyNote);
    } else if (result.repaired && result.repaired.length) {
      log.info('Merged output verified OK. Repaired clips:', result.repaired.map((r) => `${r.name} (${r.reason})`).join(', '));
    } else {
      log.info('Merged output verified OK.');
    }

    if (music) {
      try {
        await addBackgroundMusic({
          videoPath: videoTarget, trackPaths: music.trackPaths, outputPath,
          totalDuration, options: music.options || {}
        }, (p) => onProgress({ ...p, percent: 90 + (p.percent || 0) * 0.1 }));
        // Cheap sanity check on the muxed file (its video stream was already
        // verified above): make sure the write wasn't truncated.
        const muxDur = (await probeFile(outputPath)).duration || 0;
        if (totalDuration > 0 && muxDur < totalDuration - durationTolerance(totalDuration)) {
          throw new Error(`music mux looks truncated (${muxDur.toFixed(1)}s of ~${totalDuration.toFixed(1)}s)`);
        }
        safeUnlink(videoTarget);
        result = { ...result, outputPath, music: true };
      } catch (musicErr) {
        if (isCanceled(musicErr)) throw musicErr;
        // Don't waste a long video encode if only the music step failed —
        // keep the merged (silent) video as the output. videoTarget is a
        // sibling of outputPath, so this rename is a fast same-volume move.
        log.error('Adding background music failed; saving the merged video without music:', errStack(musicErr));
        safeUnlink(outputPath);
        try { fs.renameSync(videoTarget, outputPath); }
        catch { try { fs.copyFileSync(videoTarget, outputPath); safeUnlink(videoTarget); } catch { /* ignore */ } }
        result = { ...result, outputPath, music: false, musicFailed: true };
      }
    }
    return result;
  } catch (err) {
    safeUnlink(outputPath); // remove the half-written output
    if (music) safeUnlink(videoTarget); // and the pre-music temp video
    if (isCanceled(err)) return { success: false, canceled: true };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Size-limited splitting (e.g. YouTube's 256 GB per-file upload cap)
// ---------------------------------------------------------------------------

function statBytes(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function fmtGB(bytes: number): string {
  return (bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 2) + ' GB';
}

// Merge with a max-bytes-per-file limit: clips are packed into consecutive
// parts (planned from per-clip size estimates), and each part is merged as its
// own file through the full single-merge pipeline — verification and repair
// included. Every produced part is then measured: one that still exceeds the
// limit (re-encode bitrate is content-dependent, so estimates can undershoot)
// is split in half at a clip boundary and redone, so "every file fits" holds
// regardless of how good the estimates were.
async function mergeSplit(opts: MergeOptions, limitBytes: number, onProgress: ProgressCb): Promise<MergeResult> {
  const settings: Partial<Settings> = opts.settings || {};
  const { clips, outputPath, forceReencode } = opts;
  if (!clips || clips.length === 0) throw new Error('No clips to merge.');
  if (!outputPath) throw new Error('No output path provided.');

  const wantMusic = !!(opts.music && Array.isArray(opts.music.trackPaths) && opts.music.trackPaths.length);
  // The planner needs file sizes; the renderer sends them, but fall back to
  // statting so direct engine callers keep working.
  const planClips: EstimateClip[] = clips.map((c) => ({
    width: c.width, height: c.height, fps: c.fps, vcodec: c.vcodec,
    compatKey: c.compatKey, duration: c.duration || 0,
    size: c.size != null ? c.size : statBytes(c.path)
  }));
  // Pin the target from the FULL clip list so every part matches.
  const targetOverride = opts.targetOverride || resolveTarget(clips, settings);
  const queue = planParts(planClips, settings, { forceReencode, music: wantMusic }, limitBytes);

  // Fail fast on a hopeless plan: a single stream-copied clip whose EXACT size
  // exceeds the limit can never fit, no matter how the timeline is split.
  const hopeless = queue.find((p) => p.oversize && p.exact);
  if (hopeless) {
    const c = clips[hopeless.start];
    throw new Error(
      `"${c.name || path.basename(c.path)}" is ${fmtGB(hopeless.estBytes)} on its own, over the ` +
      `${fmtGB(limitBytes)} per-file limit — splitting happens at clip boundaries, so it can never fit. ` +
      'Lower the quality, turn on "Force re-encode every clip", or raise the split limit.');
  }

  const totalDuration = clips.reduce((s, c) => s + (c.duration || 0), 0);
  log.info(`Split merge: limit ${fmtGB(limitBytes)}, ${queue.length} planned part(s):`,
    queue.map((p) => `clips ${p.start + 1}-${p.end + 1} ~${fmtGB(p.estBytes)}${p.exact ? ' (exact)' : ''}`).join(', '));

  const parts: PartInfo[] = [];
  const repaired: RepairedClip[] = [];
  const notes: string[] = [];
  let allVerified = true;
  let anyMusicFailed = false;
  let lastMode: MergeResult['mode'];
  let doneDuration = 0;

  const cleanupParts = (): void => { for (const p of parts) safeUnlink(p.path); };

  try {
    while (queue.length) {
      if (canceled) { cleanupParts(); return { success: false, canceled: true }; }
      const range = queue.shift() as PartPlan;
      const partClips = clips.slice(range.start, range.end + 1);
      const partDuration = partClips.reduce((s, c) => s + (c.duration || 0), 0);
      const partNo = parts.length + 1;
      const partsKnown = parts.length + 1 + queue.length;
      // A merge that fits in one file keeps the chosen name; real parts get a
      // _partN suffix.
      const singleFile = parts.length === 0 && queue.length === 0;
      const pPath = singleFile ? outputPath : partPath(outputPath, partNo);

      const partProgress: ProgressCb = (p) => onProgress({
        ...p,
        ...(singleFile ? {} : { part: partNo, partsTotal: partsKnown }),
        percent: totalDuration > 0
          ? ((doneDuration + ((p.percent || 0) / 100) * partDuration) / totalDuration) * 100
          : (p.percent || 0)
      });

      log.info(`Part ${partNo}/${partsKnown}: clips ${range.start + 1}-${range.end + 1} -> ${pPath} (est. ${fmtGB(range.estBytes)})`);
      const res = await mergeSingle({ ...opts, clips: partClips, outputPath: pPath, targetOverride }, partProgress);
      if (res.canceled || canceled) { cleanupParts(); return { success: false, canceled: true }; }

      const bytes = statBytes(pPath);
      if (bytes > limitBytes) {
        safeUnlink(pPath);
        if (partClips.length <= 1) {
          const c = partClips[0];
          throw new Error(
            `"${c.name || path.basename(c.path)}" encoded to ${fmtGB(bytes)}, over the ${fmtGB(limitBytes)} ` +
            'per-file limit, and a single clip cannot be split further. Lower the quality or raise the split limit.');
        }
        // The estimate undershot. Split this part in half at a clip boundary
        // and redo both halves (they are re-measured like any other part).
        log.warn(`Part ${partNo} came out at ${fmtGB(bytes)} (limit ${fmtGB(limitBytes)}); splitting it in half and retrying.`);
        const midEnd = range.start + Math.ceil(partClips.length / 2) - 1;
        queue.unshift(
          { start: range.start, end: midEnd, estBytes: range.estBytes / 2, oversize: false, exact: range.exact },
          { start: midEnd + 1, end: range.end, estBytes: range.estBytes / 2, oversize: false, exact: range.exact }
        );
        continue;
      }

      parts.push({ path: pPath, bytes, clips: partClips.length });
      doneDuration += partDuration;
      lastMode = res.mode;
      if (res.repaired) repaired.push(...res.repaired);
      if (res.verified === false) allVerified = false;
      if (res.verifyNote) notes.push(singleFile ? res.verifyNote : `part ${partNo}: ${res.verifyNote}`);
      if (res.musicFailed) anyMusicFailed = true;
    }
  } catch (err) {
    cleanupParts();
    if (isCanceled(err)) return { success: false, canceled: true };
    throw err;
  }

  const result: MergeResult = {
    success: true,
    mode: lastMode,
    outputPath: parts[0].path,
    verified: allVerified
  };
  if (parts.length > 1) result.parts = parts;
  if (repaired.length) result.repaired = repaired;
  if (notes.length) result.verifyNote = notes.join('; ');
  if (wantMusic) {
    result.music = !anyMusicFailed;
    if (anyMusicFailed) result.musicFailed = true;
  }
  log.info(`Split merge finished: ${parts.length} part(s):`,
    parts.map((p) => `${path.basename(p.path)} ${fmtGB(p.bytes)}`).join(', '));
  return result;
}

// Entry point used by the IPC handler. Splits the output into size-limited
// parts when the split setting is on; otherwise merges to a single file.
export async function merge(opts: MergeOptions, onProgress: ProgressCb): Promise<MergeResult> {
  assertBinaries();
  canceled = false;
  const limitBytes = splitLimitBytes(opts.settings || {});
  if (!limitBytes) return mergeSingle(opts, onProgress);
  return mergeSplit(opts, limitBytes, onProgress);
}

export function cancel(): void {
  canceled = true;
  if (currentProc) {
    try { currentProc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}
