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

// Re-encode fallback: normalize every clip to the common spec, then concatenate
// with the concat filter. Clips without audio get a matched silent track from
// an anullsrc lavfi input so the filter sees a uniform stream layout.
function buildReencodeArgs(clips, outputPath, filterScriptPath) {
  const { W, H, F } = reencodeTarget(clips);
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
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (anyAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  if (isMp4Like(outputPath)) args.push('-movflags', '+faststart');
  args.push(outputPath);
  return { args, filterComplex };
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
  buildReencodeArgs,
  parseProgressTime,
  computePercent
};
