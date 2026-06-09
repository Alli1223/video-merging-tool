import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVideoFile, parseFilenameDate, resolveCaptureTime, compatKey, sortClips
} from '../src/metadata';

test('isVideoFile detects video extensions case-insensitively', () => {
  assert.equal(isVideoFile('clip.mp4'), true);
  assert.equal(isVideoFile('CLIP.MOV'), true);
  assert.equal(isVideoFile('movie.mkv'), true);
  assert.equal(isVideoFile('notes.txt'), false);
  assert.equal(isVideoFile('archive.zip'), false);
  assert.equal(isVideoFile('no-extension'), false);
});

test('parseFilenameDate parses common camera/phone patterns', () => {
  const expected = new Date(2021, 0, 15, 14, 30, 52).getTime();
  assert.equal(parseFilenameDate('VID_20210115_143052.mp4'), expected);
  assert.equal(parseFilenameDate('2021-01-15 14.30.52.mov'), expected);
  assert.equal(parseFilenameDate('20210115143052.mkv'), expected);
  // date only (no time) -> local midnight
  assert.equal(parseFilenameDate('2021-01-15.mp4'), new Date(2021, 0, 15, 0, 0, 0).getTime());
});

test('parseFilenameDate returns null when no valid date is present', () => {
  assert.equal(parseFilenameDate('IMG1234.mov'), null);
  assert.equal(parseFilenameDate('holiday-video.mp4'), null);
  assert.equal(parseFilenameDate('2021-13-40.mp4'), null); // impossible month/day
});

test('resolveCaptureTime prefers metadata, then filename, then filesystem', () => {
  const stat = { birthtimeMs: 5000, mtimeMs: 9000 };

  const meta = resolveCaptureTime(
    { creationTimeTag: '2021-01-01T10:00:00Z' }, stat, 'VID_20200101_000000.mp4');
  assert.equal(meta.source, 'metadata');
  assert.equal(meta.time, Date.parse('2021-01-01T10:00:00Z'));

  const fromName = resolveCaptureTime(
    { creationTimeTag: null }, stat, 'VID_20200102_080000.mp4');
  assert.equal(fromName.source, 'filename');
  assert.equal(fromName.time, new Date(2020, 0, 2, 8, 0, 0).getTime());

  const created = resolveCaptureTime({ creationTimeTag: null }, stat, 'random.mp4');
  assert.equal(created.source, 'created');
  assert.equal(created.time, 5000);
});

test('resolveCaptureTime falls back to mtime when birthtime is unreliable', () => {
  const zero = resolveCaptureTime({}, { birthtimeMs: 0, mtimeMs: 9000 }, 'x.mp4');
  assert.equal(zero.source, 'modified');
  assert.equal(zero.time, 9000);

  // birthtime after mtime (clock weirdness) -> distrust it
  const after = resolveCaptureTime({}, { birthtimeMs: 99999, mtimeMs: 9000 }, 'x.mp4');
  assert.equal(after.source, 'modified');
  assert.equal(after.time, 9000);
});

test('compatKey matches for identical streams and differs otherwise', () => {
  const base = {
    vcodec: 'h264', width: 1920, height: 1080, pixfmt: 'yuv420p',
    fps: 30, acodec: 'aac', sampleRate: 48000, channels: 2
  };
  assert.equal(compatKey(base), compatKey({ ...base }));
  assert.notEqual(compatKey(base), compatKey({ ...base, height: 720 }));
  assert.notEqual(compatKey(base), compatKey({ ...base, vcodec: 'hevc' }));

  const noAudio = compatKey({ ...base, acodec: null, sampleRate: 0, channels: 0 });
  assert.notEqual(compatKey(base), noAudio);
  assert.match(noAudio, /noaudio/);
});

test('compatKey rounds frame rate so 29.97 and 30 are compatible', () => {
  const a = { vcodec: 'h264', width: 1920, height: 1080, pixfmt: 'yuv420p', fps: 29.97, acodec: 'aac', sampleRate: 48000, channels: 2 };
  const b = { ...a, fps: 30 };
  assert.equal(compatKey(a), compatKey(b));
});

test('sortClips orders by date then name, without mutating the input', () => {
  const clips = [
    { name: 'b.mp4', sortTime: 200 },
    { name: 'a.mp4', sortTime: 100 },
    { name: 'c.mp4', sortTime: 100 }
  ];
  assert.deepEqual(sortClips(clips, 'date-asc').map((c) => c.name), ['a.mp4', 'c.mp4', 'b.mp4']);
  assert.deepEqual(sortClips(clips, 'date-desc').map((c) => c.name), ['b.mp4', 'a.mp4', 'c.mp4']);
  assert.equal(clips[0].name, 'b.mp4'); // original untouched
});

test('sortClips name modes use numeric-aware comparison', () => {
  const clips = [
    { name: 'clip10.mp4', sortTime: 0 },
    { name: 'clip2.mp4', sortTime: 0 },
    { name: 'clip1.mp4', sortTime: 0 }
  ];
  assert.deepEqual(sortClips(clips, 'name-asc').map((c) => c.name),
    ['clip1.mp4', 'clip2.mp4', 'clip10.mp4']);
  assert.deepEqual(sortClips(clips, 'name-desc').map((c) => c.name),
    ['clip10.mp4', 'clip2.mp4', 'clip1.mp4']);
});
