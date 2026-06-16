// Headless verification of the merge engine (no GUI). Generates real test
// clips, then drives the actual scanner + ffmpeg modules end to end.
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
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

function videoRes(f: string): string {
  return execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f]).toString().trim();
}

// Full-decode error count, EXCLUDING benign non-monotonic-DTS muxer warnings
// (timestamp seams at segment joins, not content corruption). spawnSync so a
// non-zero exit on a damaged file still yields its stderr.
function contentDecodeErrors(f: string): number {
  const res = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-noautorotate', '-i', f,
    '-map', '0:v:0?', '-map', '0:a?', '-f', 'null', '-'], { encoding: 'utf8' });
  return (res.stderr || '').split(/\r?\n/).filter((l) => l.trim() && !/monoton/i.test(l)).length;
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

  // --- Downscale to a smaller target + heterogeneous-encoder join (regression) ---
  // A clip LARGER than the chosen output resolution must be downscaled, and the
  // merged file must decode cleanly. The matching-resolution clip is stream-
  // copied while the larger one is re-encoded; the segments (different parameter
  // sets) are joined as MPEG-TS so they don't corrupt each other. This mirrors
  // the reported "every converted video is corrupted" case — which an MP4-segment
  // join silently broke, very visibly under NVENC.
  console.log('\n--- Downscale to a smaller target (720p clip copied + 1080p clip downscaled) ---');
  const dsDir = path.join(dir, 'downscale-test');
  fs.mkdirSync(dsDir);
  gen(dsDir, 'M_720.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-tag:v', 'hvc1', '-shortest', '-metadata', 'creation_time=2021-02-01T09:00:00.000000Z']);
  gen(dsDir, 'N_1080.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:v', 'libx265', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-tag:v', 'hvc1', '-shortest', '-metadata', 'creation_time=2021-02-01T10:00:00.000000Z']);
  const { clips: dsClips } = await scanDirectory(dsDir);
  const outDs = path.join(dsDir, 'merged_720.mp4');
  const r7 = await ffmpeg.merge({ outputPath: outDs, clips: dsClips,
    settings: { resolution: '720', codec: 'hevc', quality: 'near' } }, onProg());
  console.log('\n  result:', JSON.stringify(r7));
  probe(outDs);
  const dsRes = videoRes(outDs);
  const dsErrs = contentDecodeErrors(outDs);
  const dsDur = durationOf(outDs);
  console.log('  output exists       :', fs.existsSync(outDs) ? 'PASS' : 'FAIL');
  console.log('  downscaled to 720p  :', dsRes === '1280x720' ? 'PASS' : `FAIL (${dsRes})`);
  console.log('  decodes clean       :', dsErrs === 0 ? 'PASS' : `FAIL (${dsErrs} content error(s))`);
  console.log('  mixed copy+reencode :', r7.mode === 'hybrid' ? 'PASS' : `FAIL (${r7.mode})`);
  console.log('  verified            :', r7.verified ? 'PASS' : 'FAIL');
  console.log('  full length ~4s     :', (dsDur > 3 && dsDur < 5) ? 'PASS' : `FAIL (${dsDur.toFixed(2)}s)`);

  // --- Per-clip contrast + trim (re-encode just the edited clip) ---
  // P is untouched (stream-copied); Q has its contrast boosted and is trimmed to
  // its middle 1s, so it is re-encoded. The merged file must be the trimmed total
  // length (2s + 1s) and decode cleanly.
  console.log('\n--- Per-clip edits: contrast + saturation + trim one of two clips ---');
  const teDir = path.join(dir, 'edit-test');
  fs.mkdirSync(teDir);
  gen(teDir, 'P.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-03-01T09:00:00.000000Z']);
  gen(teDir, 'Q.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-03-01T10:00:00.000000Z']);
  const { clips: teClips } = await scanDirectory(teDir);
  const q = teClips.find((c) => c.name === 'Q.mp4');
  if (q) { q.contrast = 1.5; q.saturation = 1.3; q.trimStart = 0.5; q.trimEnd = 1.5; } // keep its middle second
  const outTe = path.join(teDir, 'merged_edit.mp4');
  const r8 = await ffmpeg.merge({ outputPath: outTe, clips: teClips,
    settings: { codec: 'h264', quality: 'near' } }, onProg());
  console.log('\n  result:', JSON.stringify(r8));
  probe(outTe);
  const teDur = durationOf(outTe);
  const teErrs = contentDecodeErrors(outTe);
  console.log('  output exists       :', fs.existsSync(outTe) ? 'PASS' : 'FAIL');
  console.log('  trimmed total ~3s   :', (teDur > 2.6 && teDur < 3.4) ? 'PASS' : `FAIL (${teDur.toFixed(2)}s)`);
  console.log('  decodes clean       :', teErrs === 0 ? 'PASS' : `FAIL (${teErrs} content error(s))`);
  console.log('  re-encoded edited   :', r8.mode === 'hybrid' ? 'PASS' : `FAIL (${r8.mode})`);
  console.log('  verified            :', r8.verified ? 'PASS' : 'FAIL');

  // --- Bounded full re-encode (the mergeReencode fallback) ---
  // mergeReencode re-encodes EVERY clip to its own MPEG-TS segment one at a time
  // (flat memory), then joins them — the fallback that replaced a single concat-
  // filter pass which opened every input at once and could use 100+ GB of RAM.
  // It's only hit when a stream-copy join fails, so exercise it directly and
  // confirm it yields a clean, full-length, correctly-scaled output.
  console.log('\n--- Bounded full re-encode (mergeReencode fallback) ---');
  const reDir = path.join(dir, 'reencode-test');
  fs.mkdirSync(reDir);
  gen(reDir, 'R1.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-04-01T09:00:00.000000Z']);
  gen(reDir, 'R2.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25:duration=2', // different size/fps
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2021-04-01T10:00:00.000000Z']);
  const { clips: reClips } = await scanDirectory(reDir);
  const outRe2 = path.join(reDir, 'reencoded.mp4');
  const reTotal = reClips.reduce((s, c) => s + (c.duration || 0), 0);
  const r9 = await ffmpeg.mergeReencode(reClips, outRe2, { W: 1280, H: 720, F: 30 },
    { codec: 'h264', useNvenc: false, quality: 'near' }, reTotal, onProg());
  console.log('\n  result:', JSON.stringify(r9));
  probe(outRe2);
  const reRes = videoRes(outRe2);
  const reErrs = contentDecodeErrors(outRe2);
  const reDur2 = durationOf(outRe2);
  console.log('  output exists       :', fs.existsSync(outRe2) ? 'PASS' : 'FAIL');
  console.log('  all scaled to 720p  :', reRes === '1280x720' ? 'PASS' : `FAIL (${reRes})`);
  console.log('  decodes clean       :', reErrs === 0 ? 'PASS' : `FAIL (${reErrs} content error(s))`);
  console.log('  full length ~4s     :', (reDur2 > 3 && reDur2 < 5) ? 'PASS' : `FAIL (${reDur2.toFixed(2)}s)`);

  // --- Drop an unprocessable clip instead of failing the whole merge ---
  // A clip that can't be turned into a segment (here a garbage file masquerading
  // as video) is cut out and the merge finishes with the rest. The output must
  // be just the good clip's length and still verify (the shorter length must NOT
  // be mistaken for truncation now that verification uses the produced duration).
  console.log('\n--- Drop a broken clip, finish with the rest ---');
  const dropDir = path.join(dir, 'drop-test');
  fs.mkdirSync(dropDir);
  gen(dropDir, 'good.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-metadata', 'creation_time=2021-05-01T09:00:00.000000Z']);
  fs.writeFileSync(path.join(dropDir, 'bad.mp4'), Buffer.from('this is not a real video file '.repeat(200)));
  const { clips: goodClips } = await scanDirectory(dropDir); // only good.mp4 has a video stream
  const goodClip = goodClips[0];
  // Fabricate a merge entry for the garbage file (a different size forces the
  // per-clip hybrid path, where it will fail to encode and be dropped).
  const badClip = { ...goodClip, path: path.join(dropDir, 'bad.mp4'), name: 'bad.mp4', width: 640, height: 480, compatKey: 'bad' };
  const outDrop = path.join(dropDir, 'merged_drop.mp4');
  const r10 = await ffmpeg.merge({ outputPath: outDrop, clips: [goodClip, badClip],
    settings: { codec: 'h264', quality: 'near' } }, onProg());
  console.log('\n  result:', JSON.stringify(r10));
  const dropKept = fs.existsSync(outDrop);
  const dropDur = dropKept ? durationOf(outDrop) : 0;
  const dropErrs = dropKept ? contentDecodeErrors(outDrop) : 999;
  console.log('  output exists       :', dropKept ? 'PASS' : 'FAIL');
  console.log('  bad clip dropped    :', (r10.dropped || []).some((d) => d.name === 'bad.mp4') ? 'PASS' : `FAIL (${JSON.stringify(r10.dropped || [])})`);
  console.log('  kept good clip ~2s  :', (dropDur > 1.6 && dropDur < 2.6) ? 'PASS' : `FAIL (${dropDur.toFixed(2)}s)`);
  console.log('  decodes clean       :', dropErrs === 0 ? 'PASS' : `FAIL (${dropErrs} content error(s))`);
  console.log('  still verified      :', r10.verified ? 'PASS' : 'FAIL');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nAll engine tests completed. Cleaned up temp dir.');
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
