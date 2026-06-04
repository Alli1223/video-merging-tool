// Headless verification of the merge engine (no GUI). Generates real test
// clips, then drives the actual scanner + ffmpeg modules end to end.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { scanDirectory } = require('./src/scanner');
const ffmpeg = require('./src/ffmpeg');

function gen(dir, name, args) {
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, name)]);
  console.log('  generated', name);
}

function probe(f) {
  const out = execFileSync(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,width,height',
    '-of', 'default=noprint_wrappers=1', f
  ]).toString();
  console.log(`  ${path.basename(f)}: ${fs.statSync(f).size} bytes | ` +
    out.trim().split(/\r?\n/).join(' | '));
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

  const onProg = (label) => { let last = 0; return (p) => {
    if (p.percent - last >= 25 || p.percent === 100) { last = p.percent; process.stdout.write(` ${Math.round(p.percent)}%`); }
  }; };

  // --- Lossless copy on the two compatible clips ---
  console.log('\n--- Lossless copy merge (A+B) ---');
  const outCopy = path.join(dir, 'merged_copy.mp4');
  const r1 = await ffmpeg.merge({ outputPath: outCopy, mode: 'copy',
    clips: clips.filter((c) => c.name !== 'C_clip.mp4') }, onProg());
  console.log('\n  result:', JSON.stringify(r1));
  probe(outCopy);
  console.log('  output exists  :', fs.existsSync(outCopy) ? 'PASS' : 'FAIL');

  // --- Re-encode fallback on all three (mixed formats + missing audio) ---
  console.log('\n--- Re-encode merge (A+B+C, C has no audio) ---');
  const outRe = path.join(dir, 'merged_reencode.mp4');
  const r2 = await ffmpeg.merge({ outputPath: outRe, mode: 'reencode', clips }, onProg());
  console.log('\n  result:', JSON.stringify(r2));
  probe(outRe);
  console.log('  output exists  :', fs.existsSync(outRe) ? 'PASS' : 'FAIL');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nAll engine tests completed. Cleaned up temp dir.');
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
