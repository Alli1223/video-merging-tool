'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLength, listVibes, getVibe, VIBES } = require('../src/music');

// Archive.org reports a file's length as either seconds ("176.34") or a clock
// string ("2:56" / "1:02:03"). Both must parse so the track-length filter
// doesn't silently drop colon-formatted items (which dropped a whole vibe).
test('parseLength handles seconds and clock strings', () => {
  assert.equal(parseLength('176.34'), 176.34);   // plain seconds
  assert.equal(parseLength('2:56'), 176);         // M:SS
  assert.equal(parseLength('0:30'), 30);          // M:SS under a minute
  assert.equal(parseLength('1:02:03'), 3723);     // H:MM:SS
  assert.equal(parseLength(155.04), 155.04);      // already a number
  assert.equal(parseLength(''), 0);
  assert.equal(parseLength(null), 0);
  assert.equal(parseLength('n/a'), 0);
});

test('listVibes exposes the expected selectable vibes', () => {
  const vibes = listVibes();
  const keys = vibes.map((v) => v.key);
  assert.deepEqual(keys, ['mix', 'lofi', 'jazzy', 'dreamy']);
  // Every vibe has a human label + description for the dropdown.
  for (const v of vibes) {
    assert.ok(v.label && typeof v.label === 'string');
    assert.ok(v.description && typeof v.description === 'string');
  }
});

test('getVibe resolves keys and falls back to the mix default', () => {
  assert.equal(getVibe('lofi').key, 'lofi');
  assert.equal(getVibe('jazzy').key, 'jazzy');
  assert.equal(getVibe('nonsense').key, 'mix'); // unknown -> default
  assert.equal(getVibe(undefined).key, 'mix');
});

test('the mix vibe blends every source item from the specific vibes', () => {
  const mixItems = new Set(getVibe('mix').items);
  for (const v of VIBES) {
    if (v.key === 'mix') continue;
    for (const item of v.items) {
      assert.ok(mixItems.has(item), `mix should include ${item} from ${v.key}`);
    }
  }
  // Source items are unique within a vibe (no accidental duplicate downloads).
  for (const v of VIBES) {
    assert.equal(new Set(v.items).size, v.items.length, `${v.key} has duplicate items`);
  }
});
