'use strict';

// Pure construction of FFmpeg argument lists and parsing of its progress
// output. Kept free of child_process / filesystem so the (fiddly) filter-graph
// logic can be unit-tested without ever launching FFmpeg.

const path = require('path');

function parseFps(rate) {
  if (!rate || rate === '0/0') return 0;
  const [n, d] = String(rate).split('/').map(Number);
  if (!d) return n || 0;
  return n / d;
}

// Small numeric helpers used by the background-music argument builders.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
// Format a number for an ffmpeg filter argument: a few decimals, no trailing
// zeros, never exponential (so e.g. 4, 3.5, 0.75 — not "4.0000000001").
function fmtNum(v) {
  return String(Math.round(num(v, 0) * 1000) / 1000);
}

// Escape a path for an ffmpeg concat-demuxer list file. Forward slashes work on
// every platform; single quotes are escaped per the concat format rules.
function concatPath(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function concatListContent(clips) {
  return clips.map((c) => `file '${concatPath(c.path)}'`).join('\n') + '\n';
}

function isMp4Like(outputPath) {
  return ['.mp4', '.mov', '.m4v'].includes(path.extname(outputPath).toLowerCase());
}

// Lossless path: stream-copy with the concat demuxer.
function buildCopyArgs(listFile, outputPath) {
  const args = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-map', '0'];
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  return args;
}

// Target spec for re-encoding = the largest dimensions / highest frame rate
// among the clips, snapped to even dimensions (required by yuv420p / x264).
function reencodeTarget(clips) {
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
const RESOLUTIONS = {
  2160: { w: 3840, h: 2160 },
  1440: { w: 2560, h: 1440 },
  1080: { w: 1920, h: 1080 },
  720: { w: 1280, h: 720 }
};

// Resolve the output target {W,H,F} from the user's settings, falling back to
// "auto" (match the largest dimensions / highest frame rate among the clips).
function resolveTarget(clips, settings) {
  settings = settings || {};
  const auto = reencodeTarget(clips);
  let { W, H, F } = auto;
  const res = RESOLUTIONS[settings.resolution];
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
function buildVideoEncodeArgs(codec, useNvenc, quality) {
  const isHevc = codec === 'hevc';
  const args = [];
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
function buildSegmentArgs(clip, target, encOpts, outPath, copyVideo) {
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
function buildReencodeArgs(clips, outputPath, filterScriptPath, target, encOpts) {
  const { W, H, F } = (target && target.W) ? target : reencodeTarget(clips);
  encOpts = encOpts || { codec: 'h264', useNvenc: false, quality: 'near' };
  const anyAudio = clips.some((c) => c.hasAudio);

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
function planMusic(totalDuration, opts) {
  opts = opts || {};
  const T = totalDuration > 0 ? totalDuration : 0;
  const crossfade = clamp(num(opts.crossfade, 4), 0, 12);
  const fadeIn = clamp(num(opts.fadeIn, 2), 0, T > 0 ? T / 2 : num(opts.fadeIn, 2));
  const fadeOut = clamp(num(opts.fadeOut, 5), 0, T > 0 ? T / 2 : num(opts.fadeOut, 5));
  const volume = clamp(num(opts.volume, 1), 0.05, 4);
  return { crossfade, fadeIn, fadeOut, volume };
}

// Normalize one music input to a uniform stereo 48k stream so tracks of
// different sample rates / channel layouts can be crossfaded together.
function musicNormFilter(idx, label) {
  return `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`;
}

// Build the args + filter graph that join a pool of tracks into ONE loop-unit
// file, consecutive tracks blended by an equal-power crossfade. tracks:
// [{path, duration}]. The graph is returned separately so the caller can write
// it to a script file (it can be long for a big pool). Crossfade is reduced if
// a track is too short to overlap by the requested amount.
function buildLoopUnitArgs(tracks, filterScriptPath, outPath, opts) {
  opts = opts || {};
  const n = tracks.length;
  if (n === 0) throw new Error('buildLoopUnitArgs: no tracks provided');

  const minDur = tracks.reduce(
    (m, t) => Math.min(m, t.duration > 0 ? t.duration : Infinity), Infinity);
  const maxCross = Number.isFinite(minDur) ? minDur / 2 : 4;
  const C = clamp(num(opts.crossfade, 4), 0, maxCross);

  const inputArgs = [];
  tracks.forEach((t) => inputArgs.push('-i', t.path));

  let filterComplex;
  if (n === 1) {
    filterComplex = musicNormFilter(0, 'mix');
  } else {
    const norm = tracks.map((_, i) => musicNormFilter(i, `a${i}`));
    if (C <= 0.05) {
      // Crossfade disabled / impossible — just concatenate in order.
      const labels = tracks.map((_, i) => `[a${i}]`).join('');
      filterComplex = norm.join(';') + ';' + `${labels}concat=n=${n}:v=0:a=1[mix]`;
    } else {
      const chain = [];
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
function buildMusicMuxArgs(videoPath, loopUnitPath, outputPath, totalDuration, plan) {
  plan = plan || {};
  const T = num(totalDuration, 0);
  const FI = num(plan.fadeIn, 0);
  const FO = num(plan.fadeOut, 0);
  const V = num(plan.volume, 1);

  const af = [];
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
// Output size estimation
// ---------------------------------------------------------------------------

// Does a clip already match the target spec (so it's kept losslessly)? Mirrors
// matchesTargetVideo() in ffmpeg.js — kept here so the (pure) estimator has no
// dependency on the merge engine.
function clipMatchesTarget(clip, target, codec) {
  return clip.width === target.W && clip.height === target.H &&
    Math.round(clip.fps || 0) === target.F && clip.vcodec === codec;
}

// Rough per-second video bitrate (bits/s) for a re-encode at the given spec,
// from a bits-per-pixel-per-frame model. Real CRF/CQ bitrate is very content
// dependent, so this is deliberately a ballpark — surfaced as an estimate.
function estimatedVideoBitrate(W, H, F, codec, quality) {
  const pps = Math.max(1, W) * Math.max(1, H) * Math.max(1, F); // pixels per second
  const BPP = {
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
function estimateMergeBytes(clips, settings, opts) {
  opts = opts || {};
  settings = settings || {};
  if (!clips || !clips.length) return { bytes: 0, peakBytes: 0, exact: false, pureCopy: false };

  const target = resolveTarget(clips, settings);
  const codec = settings.codec === 'hevc' ? 'hevc' : 'h264';
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

// Parse one line of ffmpeg `-progress` output into elapsed output seconds.
function parseProgressTime(line) {
  const m = line.match(/^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

// Convert elapsed/total seconds to a percent, clamped below 100 so the bar only
// reaches 100% when the process actually finishes.
function computePercent(seconds, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(99.5, (seconds / total) * 100));
}

module.exports = {
  parseFps,
  concatPath,
  concatListContent,
  isMp4Like,
  buildCopyArgs,
  reencodeTarget,
  resolveTarget,
  buildVideoEncodeArgs,
  buildSegmentArgs,
  buildReencodeArgs,
  planMusic,
  buildLoopUnitArgs,
  buildMusicMuxArgs,
  estimatedVideoBitrate,
  estimateMergeBytes,
  parseProgressTime,
  computePercent,
  RESOLUTIONS
};
