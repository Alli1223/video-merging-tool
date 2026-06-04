'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseFps, concatPath, concatListContent, isMp4Like,
  buildCopyArgs, reencodeTarget, buildReencodeArgs, parseProgressTime, computePercent
} = require('../src/ffargs');

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

test('buildReencodeArgs builds an A/V concat graph and injects silent audio', () => {
  const clips = [
    { path: '/a.mp4', width: 1280, height: 720, fps: 30, hasAudio: true, duration: 5 },
    { path: '/b.mp4', width: 640, height: 480, fps: 30, hasAudio: false, duration: 3 } // no audio
  ];
  const { args, filterComplex } = buildReencodeArgs(clips, '/out.mp4', '/tmp/f.txt');
  const s = args.join(' ');

  assert.equal(args.filter((x) => x === '-i').length, 3);   // 2 real inputs + 1 anullsrc
  assert.ok(s.includes('anullsrc'));                         // silent track injected (input)
  assert.ok(s.includes('-filter_complex_script /tmp/f.txt')); // graph via file, not inline
  assert.ok(filterComplex.includes('concat=n=2:v=1:a=1'));   // 2 segments, video + audio
  assert.ok(filterComplex.includes('scale=1280:720'));       // target = largest dims
  assert.ok(!filterComplex.includes('scale=1920'));
  assert.ok(s.includes('libx264'));
  assert.ok(s.includes('-c:a') && s.includes('aac'));
  assert.equal(args[args.length - 1], '/out.mp4');
});

test('buildReencodeArgs handles all-audioless clips (no audio track)', () => {
  const clips = [
    { path: '/a.mp4', width: 1280, height: 720, fps: 30, hasAudio: false, duration: 5 },
    { path: '/b.mp4', width: 1280, height: 720, fps: 30, hasAudio: false, duration: 3 }
  ];
  const { args, filterComplex } = buildReencodeArgs(clips, '/out.mp4', '/tmp/f.txt');
  const s = args.join(' ');
  assert.ok(filterComplex.includes('concat=n=2:v=1:a=0'));
  assert.ok(s.includes('-an'));
  assert.ok(!filterComplex.includes('anullsrc'));
  assert.ok(!s.includes('anullsrc'));
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
