// Pure construction of FFmpeg argument lists and parsing of its progress
// output. Kept free of child_process / filesystem so the (fiddly) filter-graph
// logic can be unit-tested without ever launching FFmpeg.

import path from 'path';

export function parseFps(rate: string | null | undefined): number {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = String(rate).split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

// Small numeric helpers used by the background-music argument builders.
function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
// Format a number for an ffmpeg filter argument: a few decimals, no trailing
// zeros, never exponential (so e.g. 4, 3.5, 0.75 — not "4.0000000001").
function fmtNum(v: unknown): string {
  return String(Math.round(num(v, 0) * 1000) / 1000);
}

// Escape a path for an ffmpeg concat-demuxer list file. Forward slashes work on
// every platform; single quotes are escaped per the concat format rules.
export function concatPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

export function concatListContent(clips: { path: string }[]): string {
  return clips.map((c) => `file '${concatPath(c.path)}'`).join('\n') + '\n';
}

export function isMp4Like(outputPath: string): boolean {
  return ['.mp4', '.mov', '.m4v'].includes(path.extname(outputPath).toLowerCase());
}

// Lossless path: stream-copy with the concat demuxer.
export function buildCopyArgs(listFile: string, outputPath: string): string[] {
  const args = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-map', '0'];
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  return args;
}

// Target spec for re-encoding = the largest dimensions / highest frame rate
// among the clips, snapped to even dimensions (required by yuv420p / x264).
export function reencodeTarget(clips: { width: number; height: number; fps: number }[]): Target {
  let W = 0, H = 0, F = 0;
  for (const c of clips) {
    if (c.width > W) W = c.width;
    if (c.height > H) H = c.height;
    if (c.fps > F) F = c.fps;
  }
  W = Math.max(2, W - (W % 2));
  H = Math.max(2, H - (H % 2));
  F = F > 0 ? Math.min(Math.round(F), 60) : 30;
  return { W, H, F };
}

// Named output resolutions (16:9). Non-16:9 sources are letterboxed via pad.
export const RESOLUTIONS: Record<string, { w: number; h: number }> = {
  2160: { w: 3840, h: 2160 },
  1440: { w: 2560, h: 1440 },
  1080: { w: 1920, h: 1080 },
  720: { w: 1280, h: 720 }
};

// Resolve the output target {W,H,F} from the user's settings, falling back to
// "auto" (match the largest dimensions / highest frame rate among the clips).
export function resolveTarget(
  clips: { width: number; height: number; fps: number }[],
  settings: Partial<Settings> = {}
): Target {
  const auto = reencodeTarget(clips);
  let { W, H, F } = auto;
  const res = settings.resolution ? RESOLUTIONS[settings.resolution] : undefined;
  if (res) { W = res.w; H = res.h; }
  if (settings.fps && settings.fps !== 'auto') {
    const f = parseInt(settings.fps, 10);
    if (f > 0) F = f;
  }
  return { W, H, F };
}

// Video encoder arguments for the chosen codec / GPU / quality.
//   codec: 'h264' | 'hevc'   useNvenc: boolean
//   quality: 'lossless' | 'near' (visually lossless) | 'high' | 'balanced'
export function buildVideoEncodeArgs(codec: Codec, useNvenc: boolean, quality: Quality): string[] {
  const isHevc = codec === 'hevc';
  const args: string[] = [];
  if (useNvenc) {
    args.push('-c:v', isHevc ? 'hevc_nvenc' : 'h264_nvenc');
    if (quality === 'lossless') {
      args.push('-preset', 'p7', '-tune', 'lossless');
    } else {
      const cq = quality === 'high' ? '24' : quality === 'balanced' ? '28' : '19'; // 'near' default
      args.push('-preset', 'p7', '-rc', 'vbr', '-cq', cq, '-b:v', '0');
    }
  } else {
    args.push('-c:v', isHevc ? 'libx265' : 'libx264');
    if (quality === 'lossless') {
      if (isHevc) args.push('-preset', 'medium', '-x265-params', 'lossless=1');
      else args.push('-preset', 'veryslow', '-qp', '0');
    } else {
      const crf = quality === 'high' ? (isHevc ? '22' : '20')
        : quality === 'balanced' ? (isHevc ? '26' : '23')
          : (isHevc ? '18' : '16'); // 'near' default (visually lossless)
      args.push('-preset', isHevc ? 'medium' : 'slow', '-crf', crf);
    }
  }
  args.push('-pix_fmt', 'yuv420p');
  if (isHevc) args.push('-tag:v', 'hvc1'); // play HEVC in QuickTime/most players
  return args;
}

// Args to turn ONE clip into a target-spec segment file. When copyVideo is true
// (the clip already matches the target) the video is stream-copied (lossless)
// and only the audio is normalized; otherwise the video is scaled/padded/fps-
// converted and re-encoded. Audio is always normalized to AAC 48k stereo so all
// segments can be concatenated by stream copy afterwards.
export function buildSegmentArgs(
  clip: { path: string; hasAudio: boolean; duration: number },
  target: Target,
  encOpts: EncodeOpts,
  outPath: string,
  copyVideo: boolean
): string[] {
  const { W, H, F } = target;
  const args = ['-i', clip.path];
  const hasAudio = !!clip.hasAudio;
  if (!hasAudio) {
    const dur = clip.duration > 0 ? clip.duration : 1;
    args.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
  }
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  if (copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push('-vf',
      `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${F},format=yuv420p`);
    args.push(...buildVideoEncodeArgs(encOpts.codec, encOpts.useNvenc, encOpts.quality));
  }
  args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '320k');
  args.push('-movflags', '+faststart', outPath);
  return args;
}

// Re-encode fallback: normalize every clip to the target spec with the concat
// filter, in one pass. Used when the per-segment join can't be stream-copied.
// Clips without audio get a matched silent track so the filter sees uniform
// streams. The (potentially huge) graph is written to filterScriptPath.
export function buildReencodeArgs(
  clips: { path: string; width: number; height: number; fps: number; hasAudio: boolean; duration: number }[],
  outputPath: string,
  filterScriptPath: string,
  target?: Target,
  encOpts: EncodeOpts = { codec: 'h264', useNvenc: false, quality: 'near' }
): { args: string[]; filterComplex: string } {
  const { W, H, F } = (target && target.W) ? target : reencodeTarget(clips);
  const anyAudio = clips.some((c) => c.hasAudio);

  const inputArgs: string[] = [];
  let inputIndex = 0;
  const videoInputIdx: number[] = [];
  const audioInputIdx: number[] = [];

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

  const filters: string[] = [];
  const concatLabels: string[] = [];
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

  // The filter graph can be huge (one chain per clip). Pass it via a script
  // file (-filter_complex_script) rather than inline, so the command line stays
  // short — otherwise many clips overflow the OS command-line limit, which
  // surfaces as "spawn ENAMETOOLONG". The caller writes filterComplex to
  // filterScriptPath.
  const args = [...inputArgs, '-filter_complex_script', filterScriptPath, '-map', '[v]'];
  if (anyAudio) args.push('-map', '[a]');
  args.push(...buildVideoEncodeArgs(encOpts.codec, encOpts.useNvenc, encOpts.quality));
  if (anyAudio) args.push('-c:a', 'aac', '-b:a', '320k');
  else args.push('-an');
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  return { args, filterComplex };
}

// ---------------------------------------------------------------------------
// Background music
// ---------------------------------------------------------------------------
// A pool of (royalty-free) music tracks is turned into one seamless "loop unit"
// by crossfading consecutive tracks, then that unit is stream-looped under the
// whole video. The video stream is copied untouched — only the audio is built
// and encoded — so adding music never re-encodes (or degrades) the footage.

// Clamp the music timing options to safe values for a video of totalDuration
// seconds. Fades can't exceed half the video; crossfade/volume are bounded.
export function planMusic(totalDuration: number, opts: Partial<MusicOptions> = {}): MusicOptions {
  const T = totalDuration > 0 ? totalDuration : 0;
  const crossfade = clamp(num(opts.crossfade, 4), 0, 12);
  const fadeIn = clamp(num(opts.fadeIn, 2), 0, T > 0 ? T / 2 : num(opts.fadeIn, 2));
  const fadeOut = clamp(num(opts.fadeOut, 5), 0, T > 0 ? T / 2 : num(opts.fadeOut, 5));
  const volume = clamp(num(opts.volume, 1), 0.05, 4);
  return { crossfade, fadeIn, fadeOut, volume };
}

// Normalize one music input to a uniform stereo 48k stream so tracks of
// different sample rates / channel layouts can be crossfaded together.
function musicNormFilter(idx: number, label: string): string {
  return `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`;
}

// Build the args + filter graph that join a pool of tracks into ONE loop-unit
// file, consecutive tracks blended by an equal-power crossfade. tracks:
// [{path, duration}]. The graph is returned separately so the caller can write
// it to a script file (it can be long for a big pool). Crossfade is reduced if
// a track is too short to overlap by the requested amount.
export function buildLoopUnitArgs(
  tracks: TrackDuration[],
  filterScriptPath: string,
  outPath: string,
  opts: { crossfade?: number } = {}
): { args: string[]; filterComplex: string; crossfade: number } {
  const n = tracks.length;
  if (n === 0) throw new Error('buildLoopUnitArgs: no tracks provided');

  const minDur = tracks.reduce(
    (m, t) => Math.min(m, t.duration > 0 ? t.duration : Infinity), Infinity);
  const maxCross = Number.isFinite(minDur) ? minDur / 2 : 4;
  const C = clamp(num(opts.crossfade, 4), 0, maxCross);

  const inputArgs: string[] = [];
  tracks.forEach((t) => inputArgs.push('-i', t.path));

  let filterComplex: string;
  if (n === 1) {
    filterComplex = musicNormFilter(0, 'mix');
  } else {
    const norm = tracks.map((_, i) => musicNormFilter(i, `a${i}`));
    if (C <= 0.05) {
      // Crossfade disabled / impossible — just concatenate in order.
      const labels = tracks.map((_, i) => `[a${i}]`).join('');
      filterComplex = norm.join(';') + ';' + `${labels}concat=n=${n}:v=0:a=1[mix]`;
    } else {
      const chain: string[] = [];
      let prev = 'a0';
      for (let i = 1; i < n; i++) {
        const out = i === n - 1 ? 'mix' : `x${i}`;
        chain.push(`[${prev}][a${i}]acrossfade=d=${fmtNum(C)}:c1=tri:c2=tri[${out}]`);
        prev = out;
      }
      filterComplex = norm.join(';') + ';' + chain.join(';');
    }
  }

  const args = [...inputArgs, '-filter_complex_script', filterScriptPath,
    '-map', '[mix]', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', outPath];
  return { args, filterComplex, crossfade: C };
}

// Build the final mux: loop the music unit under the (already merged, silent)
// video, applying volume + a fade-in at the start and fade-out at the end, and
// trim to the exact video length. The video is stream-copied (no re-encode).
export function buildMusicMuxArgs(
  videoPath: string,
  loopUnitPath: string,
  outputPath: string,
  totalDuration: number,
  plan: Partial<MusicOptions> = {}
): string[] {
  const T = num(totalDuration, 0);
  const FI = num(plan.fadeIn, 0);
  const FO = num(plan.fadeOut, 0);
  const V = num(plan.volume, 1);

  const af: string[] = [];
  if (Math.abs(V - 1) > 1e-3) af.push(`volume=${fmtNum(V)}`);
  if (FI > 0.05) af.push(`afade=t=in:st=0:d=${fmtNum(FI)}`);
  if (FO > 0.05 && T > 0) af.push(`afade=t=out:st=${fmtNum(Math.max(0, T - FO))}:d=${fmtNum(FO)}`);

  const args = ['-i', videoPath, '-stream_loop', '-1', '-i', loopUnitPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy'];
  if (af.length) args.push('-af', af.join(','));
  args.push('-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2');
  if (T > 0) args.push('-t', fmtNum(T));
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  return args;
}

// ---------------------------------------------------------------------------
// Output integrity verification (decode check + CRC content compare)
// ---------------------------------------------------------------------------
// A produced file is checked by fully decoding it into the null muxer: any
// bitstream damage surfaces as `-v error` lines on stderr, and the final
// -progress out_time reveals how much was actually decodable (truncation
// check). For stream-copied video, a CRC-32 of the decoded frames (ffmpeg's
// `crc` muxer) can additionally be compared against the source file — a
// container-independent "the content is exactly what the source contains"
// check, which catches silent write corruption that still happens to decode.

// Decode-verify args for a produced file. When crcOutPath is given, a CRC-32
// of the decoded video frames is also written there (a tiny text file of the
// form "CRC=0x12345678"). -noautorotate keeps the decoded frames identical
// between a source and a remuxed copy when rotation metadata is involved.
export function buildVerifyArgs(file: string, crcOutPath?: string): string[] {
  const args = ['-v', 'error', '-noautorotate', '-i', file];
  if (crcOutPath) args.push('-map', '0:v:0', '-f', 'crc', crcOutPath);
  args.push('-map', '0:v:0?', '-map', '0:a?', '-f', 'null', '-');
  return args;
}

// CRC-32 of the decoded video frames only — used on the SOURCE side of a
// copied-clip comparison (decode errors here mean the source itself is bad).
export function buildVideoCrcArgs(file: string, crcOutPath: string): string[] {
  return ['-v', 'error', '-noautorotate', '-i', file, '-map', '0:v:0', '-f', 'crc', crcOutPath];
}

// Parse the crc muxer's output ("CRC=0x12345678") to a normalized string.
export function parseCrcOutput(content: string | null | undefined): string | null {
  const m = String(content || '').match(/CRC=(0x[0-9A-Fa-f]{8})/);
  return m ? m[1].toLowerCase() : null;
}

// How far short a decoded duration may fall before it counts as truncation.
// Resample padding / fps rounding shift things slightly, so be generous: this
// catches "half the video is missing", not sub-second drift.
export function durationTolerance(expected: number): number {
  return Math.max(2, expected * 0.05);
}

// Pure verdict over everything a verification run gathered. Only a SHORT
// duration is flagged (truncation); a longer-than-expected file plays fine.
// The CRC pair is compared only when both sides are present.
export function assessIntegrity(input: IntegrityInput): VerifyReport {
  const issues: VerifyIssue[] = [];
  if (input.exitCode !== 0) {
    issues.push({ kind: 'process', detail: `verification decoder exited with code ${input.exitCode}` });
  }
  if (input.errorCount > 0) {
    const sample = (input.errorSample || []).slice(0, 3).join(' | ');
    issues.push({ kind: 'decode', detail: `${input.errorCount} decode error(s)${sample ? ' — ' + sample : ''}` });
  }
  const expected = input.expectedDuration || 0;
  if (expected > 0 && input.decodedDuration != null &&
      input.decodedDuration < expected - durationTolerance(expected)) {
    issues.push({ kind: 'duration', detail: `decodable length is ${input.decodedDuration.toFixed(1)}s, expected ~${expected.toFixed(1)}s` });
  }
  if (input.crc && input.expectedCrc && input.crc !== input.expectedCrc) {
    issues.push({ kind: 'crc', detail: `video content CRC ${input.crc} does not match the source's ${input.expectedCrc}` });
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Output size estimation
// ---------------------------------------------------------------------------

// Does a clip already match the target spec (so it's kept losslessly)? Mirrors
// matchesTargetVideo() in ffmpeg.ts — kept here so the (pure) estimator has no
// dependency on the merge engine.
function clipMatchesTarget(clip: VideoSpecClip, target: Target, codec: Codec): boolean {
  return clip.width === target.W && clip.height === target.H &&
    Math.round(clip.fps || 0) === target.F && clip.vcodec === codec;
}

// Rough per-second video bitrate (bits/s) for a re-encode at the given spec,
// from a bits-per-pixel-per-frame model. Real CRF/CQ bitrate is very content
// dependent, so this is deliberately a ballpark — surfaced as an estimate.
export function estimatedVideoBitrate(W: number, H: number, F: number, codec: Codec, quality: Quality): number {
  const pps = Math.max(1, W) * Math.max(1, H) * Math.max(1, F); // pixels per second
  const BPP: Record<Codec, Record<Quality, number>> = {
    h264: { lossless: 1.5, near: 0.12, high: 0.08, balanced: 0.05 },
    hevc: { lossless: 1.2, near: 0.075, high: 0.05, balanced: 0.032 }
  };
  const table = BPP[codec] || BPP.h264;
  const bpp = table[quality] != null ? table[quality] : table.near;
  return pps * bpp;
}

// AAC bitrate used for the (normalized / music) audio track.
const AUDIO_BITRATE_BPS = 320000;

// Estimate the merged output size and the peak disk usage during the merge.
//   - Lossless stream-copy clips contribute their original file size (exact).
//   - Re-encoded clips contribute estimatedVideoBitrate * duration.
//   - Background music adds an AAC track across the whole timeline.
// `exact` is true only for a pure lossless copy with no music. `peakBytes`
// accounts for temporary intermediates (per-clip segments / the pre-music
// video copy), which roughly double disk use for any non-pure-copy merge.
// opts: { forceReencode, music }.
export function estimateMergeBytes(
  clips: EstimateClip[],
  settings: Partial<Settings> = {},
  opts: { forceReencode?: boolean; music?: boolean } = {}
): SizeEstimate {
  if (!clips || !clips.length) return { bytes: 0, peakBytes: 0, exact: false, pureCopy: false };

  const target = resolveTarget(clips, settings);
  const codec: Codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
  const quality = settings.quality || 'near';
  const forceReencode = !!opts.forceReencode;

  const totalDuration = clips.reduce((s, c) => s + (c.duration || 0), 0);
  const allMatch = clips.every((c) => clipMatchesTarget(c, target, codec));
  const allCompat = new Set(clips.map((c) => c.compatKey)).size === 1;
  const pureCopy = !forceReencode && allMatch && allCompat;

  let bytes = 0;
  if (pureCopy) {
    bytes = clips.reduce((s, c) => s + (c.size || 0), 0);
  } else {
    const brBps = estimatedVideoBitrate(target.W, target.H, target.F, codec, quality);
    for (const c of clips) {
      if (!forceReencode && clipMatchesTarget(c, target, codec)) bytes += (c.size || 0);
      else bytes += (brBps / 8) * (c.duration || 0);
    }
  }
  if (opts.music) bytes += (AUDIO_BITRATE_BPS / 8) * totalDuration;

  const exact = pureCopy && !opts.music;
  const peakBytes = exact ? bytes : bytes * 2;
  return { bytes: Math.round(bytes), peakBytes: Math.round(peakBytes), exact, pureCopy };
}

// ---------------------------------------------------------------------------
// Size-limited splitting (e.g. YouTube's 256 GB per-file upload cap)
// ---------------------------------------------------------------------------
// The output is split at CLIP boundaries: consecutive clips are greedily packed
// into parts whose estimated size stays under the limit, and each part is then
// merged as an independent file. Stream-copied clips contribute their exact
// file size; re-encoded clips use the bitrate model inflated by a safety
// factor (real CRF bitrate is content-dependent and can exceed the model).
// The engine still measures every produced part and re-splits one that came
// out oversized, so the safety factor only has to be roughly right.

const REENCODE_SAFETY = 1.5;
// Headroom under the hard limit for container overhead / estimate noise.
const SPLIT_BUDGET = 0.95;

// Map the split setting ('off' | GB string) to a byte limit; 0 = no splitting.
export function splitLimitBytes(settings: Partial<Settings> = {}): number {
  if (!settings.split || settings.split === 'off') return 0;
  const gb = parseFloat(settings.split);
  return gb > 0 ? Math.round(gb * 1e9) : 0;
}

// "C:\v\out.mp4" + 2 -> "C:\v\out_part2.mp4" (extension preserved).
export function partPath(outputPath: string, n: number): string {
  const ext = path.extname(outputPath);
  return outputPath.slice(0, outputPath.length - ext.length) + `_part${n}` + ext;
}

// The bytes one clip is expected to contribute to the merged output.
function clipWeightBytes(
  clip: EstimateClip, target: Target, codec: Codec, quality: Quality,
  forceReencode: boolean, music: boolean
): { bytes: number; exact: boolean } {
  const copied = !forceReencode && clipMatchesTarget(clip, target, codec) && (clip.size || 0) > 0;
  const bytes = copied
    ? (clip.size || 0)
    : (estimatedVideoBitrate(target.W, target.H, target.F, codec, quality) / 8) * (clip.duration || 0) * REENCODE_SAFETY;
  return { bytes: bytes + (music ? (AUDIO_BITRATE_BPS / 8) * (clip.duration || 0) : 0), exact: copied };
}

// Greedily pack consecutive clips into parts of at most limitBytes (with the
// budget headroom). Order is preserved and every clip lands in exactly one
// part. A single clip whose weight alone exceeds the budget becomes its own
// part flagged `oversize` — the caller decides whether that is fatal (exact
// size) or worth attempting anyway (model estimate).
export function planParts(
  clips: EstimateClip[],
  settings: Partial<Settings> = {},
  opts: { forceReencode?: boolean; music?: boolean } = {},
  limitBytes: number = 0
): PartPlan[] {
  if (!clips.length) return [];
  const budget = limitBytes > 0 ? limitBytes * SPLIT_BUDGET : Infinity;
  const target = resolveTarget(clips, settings);
  const codec: Codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
  const quality = settings.quality || 'near';

  const parts: PartPlan[] = [];
  let cur: PartPlan | null = null;
  clips.forEach((clip, i) => {
    const w = clipWeightBytes(clip, target, codec, quality, !!opts.forceReencode, !!opts.music);
    if (cur && cur.estBytes + w.bytes <= budget) {
      cur.end = i;
      cur.estBytes += w.bytes;
      cur.exact = cur.exact && w.exact;
    } else {
      cur = { start: i, end: i, estBytes: w.bytes, oversize: w.bytes > budget, exact: w.exact };
      parts.push(cur);
    }
  });
  return parts;
}

// Parse one line of ffmpeg `-progress` output into elapsed output seconds.
export function parseProgressTime(line: string): number | null {
  const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Convert elapsed/total seconds to a percent, clamped below 100 so the bar only
// reaches 100% when the process actually finishes.
export function computePercent(seconds: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(99.5, (seconds / total) * 100));
}
