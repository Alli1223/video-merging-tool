// Headless verification of the merge engine (no GUI). Generates real test
// clips, then drives the actual scanner + ffmpeg modules end to end.
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { scanDirectory } from './src/scanner';
import * as ffmpeg from './src/ffmpeg';

if (!ffmpegStatic) throw new Error('ffmpeg-static binary not found — run "npm install"');
const FFMPEG: string = ffmpegStatic;
const FFPROBE: string = ffprobeStatic.path;

function gen(dir: string, name: string, args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, name)]);
  console.log('  generated', name);
}

function probe(f: string): void {
  const out = execFileSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height',
    '-of', 'default=noprint_wrappers=1', f
  ]).toString();
  console.log(`  ${path.basename(f)}: ${fs.statSync(f).size} bytes | ` +
    out.trim().split(/\r?\n/).join(' | '));
}

function audioStreamCount(f: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', f]).toString().trim();
  return out ? out.split(/\r?\n/).filter(Boolean).length : 0;
}

function durationOf(f: string): number {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1', f]).toString().trim();
  return parseFloat(out) || 0;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmt-test-'));
  console.log('Test dir:', dir, '\n');

  console.log('Generating test clips...');
  // A: 1280x720 30fps + audio, recorded 10:00
  gen(dir, 'A_clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-01-01T10:00:00.000000Z']);
  // B: same format, recorded 09:00 (earlier) — named "B" but should sort FIRST
  gen(dir, 'B_clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-01-01T09:00:00.000000Z']);
  // C: DIFFERENT format (640x480 25fps, no audio), recorded 11:00 — forces re-encode
  gen(dir, 'C_clip.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2021-01-01T11:00:00.000000Z']);

  // --- Scan & order ---
  const { clips } = await scanDirectory(dir);
  console.log('\nScan order (expect B, A, C by capture time):');
  clips.forEach((c, i) => console.log(
    `  ${i + 1}. ${c.name}  ${new Date(c.sortTime).toISOString()}  src=${c.timeSource}  ` +
    `${c.width}x${c.height} ${Math.round(c.fps)}fps audio=${c.hasAudio}  key=${c.compatKey}`));

  const order = clips.map((c) => c.name).join(',');
  console.log('\nAssertions:');
  console.log('  order == B,A,C :', order === 'B_clip.mp4,A_clip.mp4,C_clip.mp4' ? 'PASS' : 'FAIL (' + order + ')');
  console.log('  B uses metadata:', clips[0].timeSource === 'metadata' ? 'PASS' : 'FAIL');
  const keys = new Set(clips.map((c) => c.compatKey));
  console.log('  mixed formats  :', keys.size > 1 ? 'PASS (' + keys.size + ' keys)' : 'FAIL');

  const onProg = (): ((p: Progress) => void) => {
    let last = 0;
    return (p: Progress) => {
      if (p.percent - last >= 25 || p.percent === 100) { last = p.percent; process.stdout.write(` ${Math.round(p.percent)}%`); }
    };
  };

  // --- Lossless copy on the two compatible clips ---
  console.log('\n--- Lossless copy merge (A+B) ---');
  const outCopy = path.join(dir, 'merged_copy.mp4');
  const r1 = await ffmpeg.merge({ outputPath: outCopy,
    clips: clips.filter((c) => c.name !== 'C_clip.mp4') }, onProg());
  console.log('\n  result:', JSON.stringify(r1));
  probe(outCopy);
  console.log('  output exists  :', fs.existsSync(outCopy) ? 'PASS' : 'FAIL');
  console.log('  integrity pass :', r1.verified ? 'PASS' : 'FAIL');

  // --- Re-encode fallback on all three (mixed formats + missing audio) ---
  console.log('\n--- Re-encode merge (A+B+C, C has no audio) ---');
  const outRe = path.join(dir, 'merged_reencode.mp4');
  const r2 = await ffmpeg.merge({ outputPath: outRe, clips }, onProg());
  console.log('\n  result:', JSON.stringify(r2));
  probe(outRe);
  console.log('  output exists  :', fs.existsSync(outRe) ? 'PASS' : 'FAIL');
  console.log('  integrity pass :', r2.verified ? 'PASS' : 'FAIL');

  // --- Background music: loop + crossfade a small pool under the merged video ---
  console.log('\n--- Merge with background music (A+B + 2 local tracks, no network) ---');
  gen(dir, 'music1.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'libmp3lame', '-b:a', '128k']);
  gen(dir, 'music2.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=5', '-c:a', 'libmp3lame', '-b:a', '128k']);
  const outMusic = path.join(dir, 'merged_music.mp4');
  const r3 = await ffmpeg.merge({
    outputPath: outMusic,
    clips: clips.filter((c) => c.name !== 'C_clip.mp4'), // A+B = ~4s of video
    music: {
      trackPaths: [path.join(dir, 'music1.mp3'), path.join(dir, 'music2.mp3')],
      options: { crossfade: 1, fadeIn: 1, fadeOut: 1, volume: 0.8 }
    }
  }, onProg());
  console.log('\n  result:', JSON.stringify(r3));
  probe(outMusic);
  const aCount = audioStreamCount(outMusic);
  const mDur = durationOf(outMusic);
  console.log('  output exists  :', fs.existsSync(outMusic) ? 'PASS' : 'FAIL');
  console.log('  has audio track:', aCount >= 1 ? 'PASS' : `FAIL (${aCount})`);
  console.log('  music flag set :', r3 && r3.music ? 'PASS' : 'FAIL');
  console.log('  integrity pass :', r3.verified ? 'PASS' : 'FAIL');
  console.log('  trimmed to video length (~4s):', (mDur > 3 && mDur < 5) ? 'PASS' : `FAIL (${mDur.toFixed(2)}s)`);

  // --- Corruption detection & repair ---
  // D is a byte-identical copy of A with a 4 KB hole blown into its packet
  // data: the container index (moov, at the end) stays valid, so probing and
  // stream-copying "succeed" — exactly the silent-corruption case the
  // verification pass exists for. The merge must detect it, re-encode just
  // that clip, and produce a verified output of the full length.
  console.log('\n--- Corruption detection & repair (A+B+D, D = damaged copy of A) ---');
  const cDir = path.join(dir, 'corrupt-test');
  fs.mkdirSync(cDir);
  fs.copyFileSync(path.join(dir, 'A_clip.mp4'), path.join(cDir, 'A_clip.mp4'));
  fs.copyFileSync(path.join(dir, 'B_clip.mp4'), path.join(cDir, 'B_clip.mp4'));
  const dPath = path.join(cDir, 'D_clip.mp4');
  fs.copyFileSync(path.join(dir, 'A_clip.mp4'), dPath);
  const dSize = fs.statSync(dPath).size;
  const fd = fs.openSync(dPath, 'r+');
  fs.writeSync(fd, Buffer.alloc(4096), 0, 4096, Math.floor(dSize * 0.45));
  fs.closeSync(fd);
  console.log('  corrupted D_clip.mp4 (zeroed 4 KB at 45% of', dSize, 'bytes)');

  const { clips: cClips } = await scanDirectory(cDir);
  console.log('  scanned', cClips.length, 'clips — same format, so the lossless copy path is attempted first');
  const outFix = path.join(cDir, 'merged_fixed.mp4');
  const r4 = await ffmpeg.merge({ outputPath: outFix, clips: cClips }, onProg());
  console.log('\n  result:', JSON.stringify(r4));
  probe(outFix);
  const repairedNames = (r4.repaired || []).map((r) => r.name);
  const fixDur = durationOf(outFix);
  console.log('  output exists       :', fs.existsSync(outFix) ? 'PASS' : 'FAIL');
  console.log('  corruption repaired :', repairedNames.includes('D_clip.mp4') ? 'PASS' : `FAIL (${JSON.stringify(r4.repaired || [])})`);
  console.log('  final verified      :', r4.verified ? 'PASS' : 'FAIL');
  console.log('  full length kept    :', (fixDur > 5 && fixDur < 7) ? 'PASS' : `FAIL (${fixDur.toFixed(2)}s)`);

  // Directly exercise the spot-check verifier (the path real >2 GB outputs take
  // instead of a full decode — these tiny clips never trip the size threshold,
  // so call it straight to cover its decode-window + verdict logic).
  console.log('\n--- Spot-check verifier (used for large outputs) ---');
  const okSpot = await ffmpeg.verifyFileSpot(path.join(cDir, 'A_clip.mp4'), 2, () => {});
  const badSpot = await ffmpeg.verifyFileSpot(dPath, 2, () => {});
  console.log('  clean clip passes   :', okSpot.ok ? 'PASS' : `FAIL (${JSON.stringify(okSpot.issues)})`);
  console.log('  damaged clip flagged:', !badSpot.ok ? 'PASS' : `FAIL (${JSON.stringify(badSpot.issues)})`);

  // --- Size-limited splitting (max file size per output) ---
  // A tiny 100 KB limit forces one clip per part: A (~55 KB) fits the packing
  // budget alone but A+B (~110 KB) doesn't, so the merge must produce
  // _part1/_part2 files, each under the limit and individually verified.
  console.log('\n--- Size-split merge (A+B with a ~100 KB per-file limit) ---');
  const outSplit = path.join(dir, 'merged_split.mp4');
  const r5 = await ffmpeg.merge({
    outputPath: outSplit,
    clips: clips.filter((c) => c.name !== 'C_clip.mp4'),
    // The UI presets are whole GB; the engine just parses GB -> bytes, which
    // lets the test use a sub-GB limit small enough to bite on tiny clips.
    settings: { split: '0.0001' as SplitPref }
  }, onProg());
  console.log('\n  result:', JSON.stringify(r5));
  const partFiles = (r5.parts || []).map((p) => p.path);
  partFiles.forEach((p) => probe(p));
  const partSizesOk = (r5.parts || []).every((p) => p.bytes > 0 && p.bytes <= 100000 && fs.existsSync(p.path));
  const splitDur = partFiles.reduce((s, p) => s + durationOf(p), 0);
  console.log('  split into 2 parts  :', partFiles.length === 2 ? 'PASS' : `FAIL (${partFiles.length})`);
  console.log('  parts under limit   :', partSizesOk ? 'PASS' : 'FAIL');
  console.log('  parts named _partN  :', partFiles.every((p, i) => p.endsWith(`merged_split_part${i + 1}.mp4`)) ? 'PASS' : `FAIL (${partFiles.join(', ')})`);
  console.log('  parts verified      :', r5.verified ? 'PASS' : 'FAIL');
  console.log('  combined length ~4s :', (splitDur > 3 && splitDur < 5) ? 'PASS' : `FAIL (${splitDur.toFixed(2)}s)`);
  console.log('  no single file left :', !fs.existsSync(outSplit) ? 'PASS' : 'FAIL');

  // --- Verification disabled (opt-out) ---
  // With verify off, the merge must still produce a correct file but report no
  // verification verdict (verified omitted) and run no integrity/repair pass.
  console.log('\n--- Verify disabled (A+B, settings.verify = false) ---');
  const outNoVerify = path.join(dir, 'merged_noverify.mp4');
  const r6 = await ffmpeg.merge({
    outputPath: outNoVerify,
    clips: clips.filter((c) => c.name !== 'C_clip.mp4'),
    settings: { verify: false }
  }, onProg());
  console.log('\n  result:', JSON.stringify(r6));
  probe(outNoVerify);
  const nvDur = durationOf(outNoVerify);
  console.log('  output exists       :', fs.existsSync(outNoVerify) ? 'PASS' : 'FAIL');
  console.log('  no verify verdict   :', r6.verified === undefined ? 'PASS' : `FAIL (verified=${r6.verified})`);
  console.log('  length ~4s          :', (nvDur > 3 && nvDur < 5) ? 'PASS' : `FAIL (${nvDur.toFixed(2)}s)`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nAll engine tests completed. Cleaned up temp dir.');
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
