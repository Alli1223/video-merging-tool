import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFps, concatPath, concatListContent, isMp4Like,
  buildCopyArgs, reencodeTarget, parseProgressTime, computePercent,
  resolveTarget, buildVideoEncodeArgs, buildSegmentArgs,
  planMusic, buildLoopUnitArgs, buildMusicMuxArgs,
  estimatedVideoBitrate, estimateMergeBytes,
  buildVerifyArgs, buildVideoCrcArgs, buildSpotCheckArgs, parseCrcOutput, durationTolerance, assessIntegrity,
  verifyEnabled, spotCheckOffsets,
  splitLimitBytes, partPath, planParts,
  effectiveDuration, clipEdited
} from '../src/ffargs';

test('parseFps handles fractions and edge cases', () => {
  assert.equal(parseFps('30/1'), 30);
  assert.equal(parseFps('25/1'), 25);
  assert.equal(Math.round(parseFps('30000/1001') * 100) / 100, 29.97);
  assert.equal(parseFps('0/0'), 0);
  assert.equal(parseFps(''), 0);
  assert.equal(parseFps(null), 0);
});

test('concatPath normalizes slashes and escapes single quotes', () => {
  assert.equal(concatPath('C:\\videos\\a.mp4'), 'C:/videos/a.mp4');
  assert.equal(concatPath("/home/u/it's a clip.mp4"), "/home/u/it'\\''s a clip.mp4");
});

test('concatListContent emits one quoted file line per clip', () => {
  const txt = concatListContent([{ path: '/a.mp4' }, { path: '/b.mp4' }]);
  const lines = txt.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "file '/a.mp4'");
  assert.equal(lines[1], "file '/b.mp4'");
});

test('isMp4Like is true only for mp4-family containers', () => {
  assert.equal(isMp4Like('out.mp4'), true);
  assert.equal(isMp4Like('out.MOV'), true);
  assert.equal(isMp4Like('out.m4v'), true);
  assert.equal(isMp4Like('out.mkv'), false);
  assert.equal(isMp4Like('out.webm'), false);
});

test('buildCopyArgs stream-copies and adds faststart for mp4 only', () => {
  const mp4 = buildCopyArgs('/tmp/list.txt', '/out/movie.mp4');
  assert.deepEqual(mp4.slice(0, 8), ['-f', 'concat', '-safe', '0', '-i', '/tmp/list.txt', '-c', 'copy']);
  assert.ok(mp4.includes('-map') && mp4.includes('0'));
  assert.ok(mp4.join(' ').includes('-movflags +faststart'));
  assert.equal(mp4[mp4.length - 1], '/out/movie.mp4');

  const mkv = buildCopyArgs('/tmp/list.txt', '/out/movie.mkv');
  assert.ok(!mkv.join(' ').includes('faststart'));
});

test('reencodeTarget picks the largest even dimensions and capped fps', () => {
  assert.deepEqual(reencodeTarget([
    { width: 1280, height: 720, fps: 30 },
    { width: 1920, height: 1080, fps: 60 },
    { width: 641, height: 481, fps: 24 } // odd dims -> snapped even
  ]), { W: 1920, H: 1080, F: 60 });

  // odd dims snapped down, fps falls back to 30 when unknown
  assert.deepEqual(reencodeTarget([{ width: 641, height: 481, fps: 0 }]), { W: 640, H: 480, F: 30 });

  // very high fps is capped at 60
  assert.deepEqual(reencodeTarget([{ width: 100, height: 100, fps: 240 }]), { W: 100, H: 100, F: 60 });
});

test('parseProgressTime extracts seconds from ffmpeg -progress output', () => {
  assert.equal(parseProgressTime('out_time=00:00:12.500000'), 12.5);
  assert.equal(parseProgressTime('out_time=01:02:03.000000'), 3723);
  assert.equal(parseProgressTime('progress=continue'), null);
  assert.equal(parseProgressTime('frame=120'), null);
});

test('computePercent clamps within 0..99.5 during progress', () => {
  assert.equal(computePercent(0, 100), 0);
  assert.equal(computePercent(50, 100), 50);
  assert.equal(computePercent(100, 100), 99.5); // never reports 100 mid-stream
  assert.equal(computePercent(10, 0), 0);       // unknown total
});

test('resolveTarget uses settings, falling back to auto (largest)', () => {
  const clips = [{ width: 1920, height: 1080, fps: 30 }, { width: 1280, height: 720, fps: 60 }];
  assert.deepEqual(resolveTarget(clips, {}), { W: 1920, H: 1080, F: 60 }); // auto = max dims + max fps
  assert.deepEqual(resolveTarget(clips, { resolution: '2160', fps: '60' }), { W: 3840, H: 2160, F: 60 });
  assert.deepEqual(resolveTarget(clips, { resolution: '1080', fps: '24' }), { W: 1920, H: 1080, F: 24 });
});

test('buildVideoEncodeArgs selects encoder/codec/quality correctly', () => {
  assert.ok(buildVideoEncodeArgs('h264', true, 'near').join(' ').includes('h264_nvenc'));
  assert.ok(buildVideoEncodeArgs('hevc', true, 'near').join(' ').includes('hevc_nvenc'));
  assert.ok(buildVideoEncodeArgs('h264', false, 'near').join(' ').includes('libx264'));
  assert.ok(buildVideoEncodeArgs('hevc', false, 'near').join(' ').includes('libx265'));
  assert.ok(buildVideoEncodeArgs('h264', true, 'near').includes('-cq'));   // NVENC quality
  assert.ok(buildVideoEncodeArgs('h264', false, 'near').includes('-crf')); // CPU quality
  assert.ok(buildVideoEncodeArgs('h264', false, 'lossless').includes('-qp')); // x264 true-lossless
  assert.ok(buildVideoEncodeArgs('h264', true, 'lossless').join(' ').includes('lossless'));
  assert.ok(buildVideoEncodeArgs('hevc', true, 'near').join(' ').includes('hvc1')); // HEVC compat tag
});

test('buildSegmentArgs copies matching video and re-encodes the rest', () => {
  const clip = { path: '/a.mp4', width: 3840, height: 2160, fps: 60, hasAudio: true, duration: 5 };
  const target = { W: 3840, H: 2160, F: 60 };
  const enc = { codec: 'hevc' as const, useNvenc: true, quality: 'near' as const };

  const copy = buildSegmentArgs(clip, target, enc, '/seg.ts', true).join(' ');
  assert.ok(copy.includes('-c:v copy'));         // matching clip kept losslessly
  assert.ok(!copy.includes('hevc_nvenc'));
  assert.ok(copy.includes('-c:a aac'));          // audio normalized for the join
  // Segments are MPEG-TS (params in-band per segment) so a copied original and
  // a re-encoded clip can be stream-copy-joined without corruption — NOT MP4.
  assert.ok(copy.includes('-f mpegts'));
  assert.ok(!copy.includes('faststart'));        // faststart is an mp4-only flag

  const re = buildSegmentArgs(clip, target, enc, '/seg.ts', false).join(' ');
  assert.ok(re.includes('hevc_nvenc'));
  assert.ok(re.includes('scale=3840:2160'));
  assert.ok(!re.includes('-c:v copy'));
  assert.ok(re.includes('-f mpegts'));
});

test('buildSegmentArgs adds a silent track for clips without audio', () => {
  const clip = { path: '/a.mp4', width: 1280, height: 720, fps: 30, hasAudio: false, duration: 3 };
  const s = buildSegmentArgs(clip, { W: 1920, H: 1080, F: 30 },
    { codec: 'h264', useNvenc: false, quality: 'near' }, '/seg.mp4', false).join(' ');
  assert.ok(s.includes('anullsrc'));
  assert.ok(s.includes('-map 1:a:0'));
});

// ---------------------------------------------------------------------------
// Background music
// ---------------------------------------------------------------------------

test('planMusic clamps fades to half the video and bounds volume', () => {
  // Long video: requested values pass through.
  assert.deepEqual(planMusic(600, { crossfade: 4, fadeIn: 2, fadeOut: 5, volume: 1 }),
    { crossfade: 4, fadeIn: 2, fadeOut: 5, volume: 1 });
  // Tiny video: fades can't exceed half its length.
  const p = planMusic(6, { fadeIn: 2, fadeOut: 5 });
  assert.equal(p.fadeIn, 2);
  assert.equal(p.fadeOut, 3); // 5 clamped to 6/2
  // Volume is bounded to a sane range; crossfade capped at 12.
  assert.equal(planMusic(600, { volume: 99 }).volume, 4);
  assert.equal(planMusic(600, { volume: 0 }).volume, 0.05);
  assert.equal(planMusic(600, { crossfade: 999 }).crossfade, 12);
  // Defaults when nothing is provided.
  assert.deepEqual(planMusic(600, {}), { crossfade: 4, fadeIn: 2, fadeOut: 5, volume: 1 });
});

test('buildLoopUnitArgs crossfade-chains a pool into one [mix] output', () => {
  const tracks = [
    { path: '/m1.mp3', duration: 120 },
    { path: '/m2.mp3', duration: 90 },
    { path: '/m3.mp3', duration: 150 }
  ];
  const { args, filterComplex, crossfade } = buildLoopUnitArgs(tracks, '/tmp/f.txt', '/out/loop.m4a', { crossfade: 4 });
  const s = args.join(' ');
  assert.equal(args.filter((x) => x === '-i').length, 3);        // one input per track
  assert.ok(s.includes('-filter_complex_script /tmp/f.txt'));     // graph via file
  assert.ok(s.includes('-map [mix]'));
  assert.ok(s.includes('-c:a aac'));
  assert.equal(args[args.length - 1], '/out/loop.m4a');
  assert.equal(crossfade, 4);
  // Two joins for three tracks, ending in the [mix] label.
  assert.equal((filterComplex.match(/acrossfade=/g) || []).length, 2);
  assert.ok(filterComplex.includes('[mix]'));
  assert.ok(filterComplex.includes('acrossfade=d=4:c1=tri:c2=tri'));
});

test('buildLoopUnitArgs caps crossfade at half the shortest track', () => {
  const tracks = [{ path: '/a.mp3', duration: 8 }, { path: '/b.mp3', duration: 200 }];
  const { filterComplex, crossfade } = buildLoopUnitArgs(tracks, '/f.txt', '/o.m4a', { crossfade: 8 });
  assert.equal(crossfade, 4); // 8s shortest -> max 4s overlap
  assert.ok(filterComplex.includes('acrossfade=d=4:'));
});

test('buildLoopUnitArgs handles a single track (no crossfade) and crossfade=0 (concat)', () => {
  const one = buildLoopUnitArgs([{ path: '/solo.mp3', duration: 60 }], '/f.txt', '/o.m4a', { crossfade: 4 });
  assert.equal(one.args.filter((x) => x === '-i').length, 1);
  assert.ok(!one.filterComplex.includes('acrossfade'));
  assert.ok(one.filterComplex.includes('[mix]'));

  const concat = buildLoopUnitArgs(
    [{ path: '/a.mp3', duration: 60 }, { path: '/b.mp3', duration: 60 }], '/f.txt', '/o.m4a', { crossfade: 0 });
  assert.ok(!concat.filterComplex.includes('acrossfade'));
  assert.ok(concat.filterComplex.includes('concat=n=2:v=0:a=1[mix]'));
});

test('buildMusicMuxArgs stream-loops music under a copied video with fades + trim', () => {
  const args = buildMusicMuxArgs('/in.mp4', '/loop.m4a', '/out.mp4', 3600,
    { fadeIn: 2, fadeOut: 5, volume: 0.8 });
  const s = args.join(' ');
  assert.ok(s.includes('-stream_loop -1 -i /loop.m4a'));
  assert.ok(s.includes('-map 0:v:0 -map 1:a:0'));
  assert.ok(s.includes('-c:v copy'));               // video never re-encoded
  assert.ok(s.includes('volume=0.8'));
  assert.ok(s.includes('afade=t=in:st=0:d=2'));
  assert.ok(s.includes('afade=t=out:st=3595:d=5')); // 3600 - 5
  assert.ok(s.includes('-t 3600'));                 // trimmed to video length
  assert.ok(s.includes('-movflags +faststart'));
  assert.equal(args[args.length - 1], '/out.mp4');
});

test('buildMusicMuxArgs omits volume at 1.0 and faststart for non-mp4', () => {
  const a = buildMusicMuxArgs('/in.mkv', '/loop.m4a', '/out.mkv', 100, { fadeIn: 0, fadeOut: 0, volume: 1 });
  const s = a.join(' ');
  assert.ok(!s.includes('volume='));   // unity gain -> no volume filter
  assert.ok(!s.includes('afade'));      // no fades requested
  assert.ok(!s.includes('faststart'));  // mkv
  assert.ok(s.includes('-c:v copy'));
  assert.ok(s.includes('-t 100'));
});

// ---------------------------------------------------------------------------
// Output size estimation
// ---------------------------------------------------------------------------

test('estimateMergeBytes: pure lossless copy sums input sizes (exact)', () => {
  const clips = [
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 10, size: 1_000_000 },
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 20, size: 2_000_000 }
  ];
  const r = estimateMergeBytes(clips, { codec: 'h264', quality: 'near' }, {});
  assert.equal(r.pureCopy, true);
  assert.equal(r.exact, true);
  assert.equal(r.bytes, 3_000_000);
  assert.equal(r.peakBytes, 3_000_000); // copy writes the output once
});

test('estimateMergeBytes: mixed formats keep matching clips but double peak', () => {
  // Same spec but different compatKeys -> not a pure copy (hybrid path). Both
  // clips still match the target, so they are kept at their original size, but
  // the per-clip segments make peak disk ~2x.
  const clips = [
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 10, size: 1_000_000 },
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k2', duration: 20, size: 2_000_000 }
  ];
  const r = estimateMergeBytes(clips, { codec: 'h264', quality: 'near' }, {});
  assert.equal(r.pureCopy, false);
  assert.equal(r.exact, false);
  assert.equal(r.bytes, 3_000_000);
  assert.equal(r.peakBytes, 6_000_000);
});

test('estimateMergeBytes: a non-matching clip is sized by the bitrate model', () => {
  const clips = [
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 10, size: 5_000_000 }, // kept
    { width: 1280, height: 720, fps: 30, vcodec: 'h264', compatKey: 'k2', duration: 10, size: 1_000_000 }   // re-encoded to 1080p
  ];
  const r = estimateMergeBytes(clips, { codec: 'h264', quality: 'near' }, {});
  const br = estimatedVideoBitrate(1920, 1080, 30, 'h264', 'near');
  const expected = Math.round(5_000_000 + (br / 8) * 10);
  assert.equal(r.bytes, expected);
  assert.ok(r.bytes > 5_000_000);
  assert.equal(r.exact, false);
});

test('estimateMergeBytes: forceReencode sizes every clip by the model', () => {
  const clips = [
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 10, size: 9_000_000 },
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 20, size: 9_000_000 }
  ];
  const r = estimateMergeBytes(clips, { codec: 'h264', quality: 'near' }, { forceReencode: true });
  const br = estimatedVideoBitrate(1920, 1080, 30, 'h264', 'near');
  assert.equal(r.pureCopy, false);
  assert.equal(r.bytes, Math.round((br / 8) * 10 + (br / 8) * 20)); // original sizes ignored
});

test('estimateMergeBytes: background music adds an audio track and disables exact', () => {
  const clips = [
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 10, size: 1_000_000 },
    { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', duration: 20, size: 2_000_000 }
  ];
  const r = estimateMergeBytes(clips, { codec: 'h264', quality: 'near' }, { music: true });
  assert.equal(r.exact, false); // music means an extra encode pass
  assert.equal(r.bytes, Math.round(3_000_000 + (320000 / 8) * 30)); // + AAC across 30s
});

test('estimateMergeBytes: empty input is zero', () => {
  assert.deepEqual(estimateMergeBytes([], {}, {}), { bytes: 0, peakBytes: 0, exact: false, pureCopy: false });
});

test('estimatedVideoBitrate scales with resolution and is lower for HEVC', () => {
  const h264 = estimatedVideoBitrate(1920, 1080, 30, 'h264', 'near');
  const hevc = estimatedVideoBitrate(1920, 1080, 30, 'hevc', 'near');
  const h264_4k = estimatedVideoBitrate(3840, 2160, 30, 'h264', 'near');
  assert.ok(hevc < h264);          // HEVC is more efficient
  assert.ok(h264_4k > h264);       // 4K needs more than 1080p
  assert.ok(h264 > 0);
});

test('buildVerifyArgs decodes all streams into the null muxer', () => {
  const s = buildVerifyArgs('/x/out.mp4').join(' ');
  assert.ok(s.includes('-v error'));                      // only real errors on stderr
  assert.ok(s.includes('-noautorotate'));                 // deterministic frames vs the source
  assert.ok(s.includes('-i /x/out.mp4'));
  assert.ok(s.includes('-map 0:v:0? -map 0:a? -f null -')); // decode-check video + audio
  assert.ok(!s.includes('-f crc'));                       // no CRC sink unless asked
});

test('buildVerifyArgs adds a video CRC sink when a crc path is given', () => {
  const s = buildVerifyArgs('/x/seg.mp4', '/tmp/crc.txt').join(' ');
  assert.ok(s.includes('-map 0:v:0 -f crc /tmp/crc.txt'));
  assert.ok(s.includes('-f null -'));                     // still decode-checks everything
});

test('buildVideoCrcArgs hashes only the first video stream', () => {
  const s = buildVideoCrcArgs('/src.mp4', '/tmp/c.txt').join(' ');
  assert.ok(s.includes('-i /src.mp4'));
  assert.ok(s.includes('-map 0:v:0 -f crc /tmp/c.txt'));
  assert.ok(!s.includes('null'));
});

test('parseCrcOutput extracts and normalizes the CRC line', () => {
  assert.equal(parseCrcOutput('CRC=0xDEADBEEF\n'), '0xdeadbeef');
  assert.equal(parseCrcOutput('CRC=0x00000000'), '0x00000000');
  assert.equal(parseCrcOutput('no crc here'), null);
  assert.equal(parseCrcOutput(''), null);
  assert.equal(parseCrcOutput(null), null);
});

test('durationTolerance is at least 2s and scales at 5%', () => {
  assert.equal(durationTolerance(10), 2);
  assert.equal(durationTolerance(0), 2);
  assert.equal(durationTolerance(200), 10);
});

test('assessIntegrity passes a clean run', () => {
  const r = assessIntegrity({
    exitCode: 0, errorCount: 0, errorSample: [],
    decodedDuration: 59.8, expectedDuration: 60
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('assessIntegrity flags decode errors, truncation, crc mismatch and a bad exit', () => {
  const decode = assessIntegrity({ exitCode: 0, errorCount: 3, errorSample: ['err A', 'err B'], decodedDuration: 60, expectedDuration: 60 });
  assert.equal(decode.ok, false);
  assert.equal(decode.issues[0].kind, 'decode');
  assert.ok(decode.issues[0].detail.includes('err A'));   // sample surfaces in the detail

  const trunc = assessIntegrity({ exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: 30, expectedDuration: 60 });
  assert.equal(trunc.ok, false);
  assert.equal(trunc.issues[0].kind, 'duration');

  const crc = assessIntegrity({
    exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: 60, expectedDuration: 60,
    crc: '0x11111111', expectedCrc: '0x22222222'
  });
  assert.equal(crc.ok, false);
  assert.equal(crc.issues[0].kind, 'crc');

  const proc = assessIntegrity({ exitCode: 1, errorCount: 0, errorSample: [], decodedDuration: null });
  assert.equal(proc.ok, false);
  assert.equal(proc.issues[0].kind, 'process');
});

test('assessIntegrity tolerates drift and over-length, and skips absent checks', () => {
  // a small shortfall within tolerance is fine
  assert.ok(assessIntegrity({ exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: 59, expectedDuration: 60 }).ok);
  // longer than expected is not corruption
  assert.ok(assessIntegrity({ exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: 65, expectedDuration: 60 }).ok);
  // no expected duration and only one half of a CRC pair -> those checks are skipped
  assert.ok(assessIntegrity({ exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: null, crc: '0xabcabc01', expectedCrc: null }).ok);
  // matching CRC pair stays clean
  assert.ok(assessIntegrity({ exitCode: 0, errorCount: 0, errorSample: [], decodedDuration: 60, expectedDuration: 60, crc: '0xaaaaaaaa', expectedCrc: '0xaaaaaaaa' }).ok);
});

test('splitLimitBytes maps the setting to bytes (0 = off)', () => {
  assert.equal(splitLimitBytes({}), 0);
  assert.equal(splitLimitBytes({ split: 'off' }), 0);
  assert.equal(splitLimitBytes({ split: '256' }), 256e9); // YouTube upload cap
  assert.equal(splitLimitBytes({ split: '4' }), 4e9);     // FAT32
});

test('partPath inserts _partN before the extension', () => {
  assert.equal(partPath('/videos/holiday_merged.mp4', 1), '/videos/holiday_merged_part1.mp4');
  assert.equal(partPath('/videos/holiday_merged.mp4', 12), '/videos/holiday_merged_part12.mp4');
  assert.equal(partPath('/videos/noext', 2), '/videos/noext_part2');
});

// A 1080p30 h264 clip that exactly matches the default auto target, so its
// (exact) file size is used as its packing weight.
function copyClip(size: number, duration = 60): EstimateClip {
  return { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k1', size, duration };
}

test('planParts packs consecutive matching clips by their exact sizes', () => {
  // budget = 100e9 * 0.95 = 95e9 -> 40+40 fits, the third 40 starts part 2
  const parts = planParts(
    [copyClip(40e9), copyClip(40e9), copyClip(40e9)],
    { codec: 'h264' }, {}, 100e9
  );
  assert.equal(parts.length, 2);
  assert.deepEqual([parts[0].start, parts[0].end], [0, 1]);
  assert.deepEqual([parts[1].start, parts[1].end], [2, 2]);
  assert.equal(parts[0].estBytes, 80e9);  // exact sizes, no inflation
  assert.equal(parts[0].exact, true);
  assert.equal(parts[0].oversize, false);
  // parts tile the clip list: contiguous, in order, no gaps
  assert.equal(parts[0].end + 1, parts[1].start);
});

test('planParts flags a single clip that cannot fit (exact oversize)', () => {
  const parts = planParts(
    [copyClip(40e9), copyClip(120e9), copyClip(40e9)],
    { codec: 'h264' }, {}, 100e9
  );
  assert.equal(parts.length, 3); // the oversize clip is isolated in its own part
  assert.equal(parts[1].oversize, true);
  assert.equal(parts[1].exact, true);
  assert.equal(parts[0].oversize, false);
});

test('planParts inflates re-encode estimates with a safety factor', () => {
  // forceReencode -> the model (x safety), not the file size, is the weight
  const clip = copyClip(40e9, 3600);
  const [part] = planParts([clip], { codec: 'h264', quality: 'near' }, { forceReencode: true }, 1000e9);
  const model = (estimatedVideoBitrate(1920, 1080, 30, 'h264', 'near') / 8) * 3600;
  assert.equal(part.estBytes, model * 1.5);
  assert.equal(part.exact, false);
});

test('planParts adds the music audio track to each clip weight', () => {
  const clip = copyClip(40e9, 100);
  const [plain] = planParts([clip], { codec: 'h264' }, {}, 1000e9);
  const [withMusic] = planParts([clip], { codec: 'h264' }, { music: true }, 1000e9);
  assert.equal(withMusic.estBytes - plain.estBytes, (320000 / 8) * 100);
});

test('planParts with no limit returns one part covering everything', () => {
  const parts = planParts([copyClip(40e9), copyClip(40e9)], { codec: 'h264' }, {}, 0);
  assert.equal(parts.length, 1);
  assert.deepEqual([parts[0].start, parts[0].end], [0, 1]);
  assert.equal(planParts([], {}, {}, 100e9).length, 0);
});

test('verifyEnabled is on unless explicitly disabled', () => {
  assert.equal(verifyEnabled({}), true);             // default on (e.g. old settings.json)
  assert.equal(verifyEnabled({ verify: true }), true);
  assert.equal(verifyEnabled({ verify: false }), false);
});

test('spotCheckOffsets samples across the timeline, clamped to [min,max]', () => {
  // short file: bumped up to the minimum sample count, spanning [0, dur-window]
  const a = spotCheckOffsets(120, 2, 8, 24);
  assert.equal(a.length, 8);
  assert.equal(a[0], 0);
  assert.equal(a[a.length - 1], 118); // duration - window
  // long file: ~one per minute, capped at the maximum
  const b = spotCheckOffsets(7200, 2, 8, 24);
  assert.equal(b.length, 24);
  assert.equal(b[0], 0);
  assert.equal(b[b.length - 1], 7198);
  // offsets are strictly increasing and never seek past the decodable window
  for (let i = 1; i < b.length; i++) assert.ok(b[i] > b[i - 1]);
  // tiny / zero / sub-window durations degrade to a single offset at 0
  assert.deepEqual(spotCheckOffsets(1, 2, 8, 24), [0]);
  assert.deepEqual(spotCheckOffsets(0, 2, 8, 24), [0]);
});

test('buildSpotCheckArgs fast-seeks and decodes a short window into null', () => {
  const s = buildSpotCheckArgs('/out.mp4', 90, 2).join(' ');
  assert.ok(s.includes('-ss 90'));      // seek BEFORE -i (fast input seek)
  assert.ok(s.indexOf('-ss') < s.indexOf('-i'));
  assert.ok(s.includes('-t 2'));        // bounded window length
  assert.ok(s.includes('-i /out.mp4'));
  assert.ok(s.includes('-f null'));     // decode, discard output
  assert.ok(s.includes('-v error'));    // only decode errors on stderr
  // a negative offset is clamped to 0
  assert.ok(buildSpotCheckArgs('/o.mp4', -5, 2).join(' ').includes('-ss 0'));
});

test('effectiveDuration returns the kept span after trimming', () => {
  assert.equal(effectiveDuration({ duration: 10 }), 10);                          // untrimmed
  assert.equal(effectiveDuration({ duration: 10, trimStart: 2 }), 8);             // start only
  assert.equal(effectiveDuration({ duration: 10, trimStart: 2, trimEnd: 8 }), 6); // start + end
  assert.equal(effectiveDuration({ duration: 10, trimEnd: 4 }), 4);              // end only
  assert.equal(effectiveDuration({ duration: 10, trimEnd: 99 }), 10);            // end clamped to duration
  assert.equal(effectiveDuration({ duration: 10, trimStart: 99 }), 0);          // start past end -> 0
});

test('clipEdited detects contrast/saturation changes and trims', () => {
  assert.equal(clipEdited({ duration: 10 }), false);
  assert.equal(clipEdited({ duration: 10, contrast: 1, saturation: 1 }), false);
  assert.equal(clipEdited({ duration: 10, contrast: 1.3 }), true);
  assert.equal(clipEdited({ duration: 10, saturation: 1.4 }), true);
  assert.equal(clipEdited({ duration: 10, saturation: 1 }), false);
  assert.equal(clipEdited({ duration: 10, trimStart: 1 }), true);
  assert.equal(clipEdited({ duration: 10, trimEnd: 9 }), true);   // end trimmed in
  assert.equal(clipEdited({ duration: 10, trimEnd: 10 }), false); // end at full length
});

test('buildSegmentArgs applies contrast, saturation and trim on the re-encode path', () => {
  const clip = { path: '/a.mp4', hasAudio: true, duration: 10, contrast: 1.5, saturation: 1.2, trimStart: 2, trimEnd: 8 };
  const args = buildSegmentArgs(clip, { W: 1920, H: 1080, F: 30 }, { codec: 'h264', useNvenc: false, quality: 'near' }, '/seg.ts', false);
  const s = args.join(' ');
  assert.ok(s.includes('-ss 2'));                          // seek to the in-point
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'));     // fast input seek (before -i)
  assert.ok(s.includes('eq=contrast=1.5:saturation=1.2')); // one eq carries both adjustments
  assert.ok(s.includes('-t 6'));                           // capped to the 6s kept span

  // saturation alone -> eq with only that param
  const satOnly = buildSegmentArgs({ path: '/a.mp4', hasAudio: true, duration: 5, saturation: 0.5 },
    { W: 1920, H: 1080, F: 30 }, { codec: 'h264', useNvenc: false, quality: 'near' }, '/seg.ts', false).join(' ');
  assert.ok(satOnly.includes('eq=saturation=0.5'));
  assert.ok(!satOnly.includes('contrast='));
});

test('buildSegmentArgs adds no trim/colour args for an unedited clip', () => {
  const clip = { path: '/a.mp4', hasAudio: true, duration: 10 };
  const s = buildSegmentArgs(clip, { W: 1920, H: 1080, F: 30 }, { codec: 'h264', useNvenc: false, quality: 'near' }, '/seg.ts', false).join(' ');
  assert.ok(!s.includes('-ss'));
  assert.ok(!s.includes('eq='));
  assert.ok(!s.includes('-t '));
});

test('estimateMergeBytes treats an edited clip as re-encoded, not a copy', () => {
  const base = { width: 1920, height: 1080, fps: 30, vcodec: 'h264', compatKey: 'k', size: 100e6, duration: 60 };
  const settings = { resolution: '1080' as const, fps: '30' as const, codec: 'h264' as const, quality: 'near' as const };
  // Unedited clip that matches the target -> pure lossless copy.
  assert.equal(estimateMergeBytes([base], settings, {}).pureCopy, true);
  // A contrast change forces a re-encode, so it's no longer a pure copy.
  assert.equal(estimateMergeBytes([{ ...base, contrast: 1.5 }], settings, {}).pureCopy, false);
  // Trimming to half the length roughly halves the re-encode estimate.
  const full = estimateMergeBytes([{ ...base, contrast: 1.5 }], settings, {}).bytes;
  const half = estimateMergeBytes([{ ...base, contrast: 1.5, trimStart: 0, trimEnd: 30 }], settings, {}).bytes;
  assert.ok(half < full && half > full * 0.4);
});
