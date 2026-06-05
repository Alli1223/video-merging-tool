'use strict';

// Fetches royalty-free background music on demand from the Internet Archive.
//
// We use a curated list of hand-vetted items that are genuinely original,
// instrumental lo-fi / chill albums released under CC0 (public domain — no
// attribution required, any use allowed). The Internet Archive exposes a
// no-API-key metadata endpoint and predictable download URLs, which makes it a
// durable source that won't rot the way a scraped site or a keyed API would.
//
// Defense in depth: even though the seed items are verified, the licence is
// re-checked at runtime from the item's metadata before any track is used, so
// a mislabeled or changed item is skipped rather than trusted. Downloaded
// tracks are cached locally, so the network is only touched the first time.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const log = require('./logger');

const UA = 'VideoMergingTool (+https://github.com/Alli1223/video-merging-tool)';

// Hand-vetted CC0 (public-domain) chill music on the Internet Archive, grouped
// into "vibes". Every identifier was verified track-by-track to be original
// instrumental music (not covers/remixes of copyrighted songs, which sometimes
// carry a misleading CC0 tag — and not hours-long DJ mixes or sample packs).
// The licence is also re-checked at runtime before anything is used.

// Joel Putman's catalogue: many individual CC0 lo-fi / 8-bit / ambient pieces
// (~1.5–4 min each). Used as the pool for the "Lo-fi beats" vibe.
const JOEL_PUTMAN = [
  'AtticSpace', 'SweetDream_690', 'Allege', 'Tweet_78', 'So123_546',
  'Stall456', 'Collect_199', 'Scratch_196', 'Zone44', 'Speck44', 'Cartel44'
];

// Verified multi-track CC0 albums.
const VHS_JAZZ = 'vcr-and-vhs-jazz';            // "virtual metropolis" — late-night VHS jazz (15 tracks)
const PARTICLE_DREAMS = 'particle-dreams-moonlight'; // "moonlight" — soft, dreamy chill (9 tracks)

// Each vibe maps to a set of source items. `mix` blends everything for variety.
const VIBES = [
  { key: 'mix', label: '🎲 Chill mix (variety)', description: 'A blend of every style below', items: [VHS_JAZZ, PARTICLE_DREAMS, ...JOEL_PUTMAN] },
  { key: 'lofi', label: '🎧 Lo-fi beats', description: 'Mellow lo-fi / 8-bit instrumentals', items: JOEL_PUTMAN.slice() },
  { key: 'jazzy', label: '🎷 Jazzy & nocturnal', description: 'Smoky, late-night VHS jazz', items: [VHS_JAZZ] },
  { key: 'dreamy', label: '🌙 Dreamy & mellow', description: 'Soft, romantic, dreamy chill', items: [PARTICLE_DREAMS] }
];
const DEFAULT_VIBE = 'mix';

function listVibes() {
  return VIBES.map((v) => ({ key: v.key, label: v.label, description: v.description }));
}
function getVibe(key) {
  return VIBES.find((v) => v.key === key) || VIBES.find((v) => v.key === DEFAULT_VIBE);
}

// Licence URLs we treat as "free, no attribution required". CC0 and the public
// domain mark both mean exactly that; attribution licences (…/licenses/by/…)
// are deliberately NOT matched here.
const PUBLIC_DOMAIN_MARKERS = ['publicdomain/zero', 'publicdomain/mark', 'creativecommons.org/publicdomain'];

// Ignore multi-hour "mix" files and sub-20s stingers — we want loopable tracks.
const MIN_TRACK_SECONDS = 20;
const MAX_TRACK_SECONDS = 15 * 60;

const metadataUrl = (id) => `https://archive.org/metadata/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// HTTP (with redirect handling — archive.org's /download/ URLs 302 to a
// datanode, and metadata can redirect too).
// ---------------------------------------------------------------------------
function httpGet(rawUrl, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume(); // drain and discard the redirect body
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects: ' + rawUrl));
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpGet(next, redirectsLeft - 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + code + ' for ' + rawUrl));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('Request timed out: ' + rawUrl)));
  });
}

function getJson(url) {
  return httpGet(url).then((res) => new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      body += d;
      if (body.length > 25 * 1024 * 1024) { res.destroy(); reject(new Error('Metadata response too large')); }
    });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    res.on('error', reject);
  }));
}

// Download a URL to dest (atomically, via a .part temp file), reporting bytes.
function downloadTo(url, dest, onBytes) {
  return httpGet(url).then((res) => new Promise((resolve, reject) => {
    const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
    let received = 0;
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const fail = (e) => { try { out.destroy(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} reject(e); };
    res.on('data', (d) => { received += d.length; if (onBytes) onBytes(received, total); });
    res.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      try { fs.renameSync(tmp, dest); resolve({ bytes: received }); }
      catch (e) { fail(e); }
    });
    res.pipe(out);
  }));
}

// ---------------------------------------------------------------------------
// Internet Archive item → track list
// ---------------------------------------------------------------------------
function encodeName(name) {
  return name.split('/').map(encodeURIComponent).join('/');
}
function directFileUrl(server, dir, name) {
  const d = dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return `https://${server}${d}/${encodeName(name)}`;
}
function downloadFileUrl(id, name) {
  return `https://archive.org/download/${encodeURIComponent(id)}/${encodeName(name)}`;
}
function isPublicDomain(licenseUrl) {
  const l = String(licenseUrl || '').toLowerCase();
  return PUBLIC_DOMAIN_MARKERS.some((m) => l.includes(m));
}

// Archive.org's file `length` is sometimes seconds ("176.34") and sometimes a
// clock string ("2:56" or "1:02:03"), depending on who derived the item. Parse
// both so the track-length filter doesn't wrongly drop colon-formatted items.
function parseLength(v) {
  if (v == null) return 0;
  const s = String(v).trim();
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : 0;
}

// Fetch one item's metadata, verify it is public domain, and return its usable
// audio tracks. Returns [] (and logs) for anything we can't or shouldn't use.
async function listTracksForItem(id) {
  let meta;
  try { meta = await getJson(metadataUrl(id)); }
  catch (e) { log.warn('music: metadata fetch failed for', id, '-', String((e && e.message) || e)); return []; }

  const m = meta.metadata || {};
  if (!isPublicDomain(m.licenseurl)) {
    log.warn('music: skipping', id, '— not a public-domain licence:', m.licenseurl || '(none)');
    return [];
  }

  const server = meta.server || meta.d1 || null;
  const dir = meta.dir || '';
  const files = Array.isArray(meta.files) ? meta.files : [];

  const audio = files
    .filter((f) => f && f.name && /mp3|ogg vorbis|flac/i.test(String(f.format || '')))
    .map((f) => ({ name: f.name, format: String(f.format || ''), length: parseLength(f.length), title: f.title || null }));

  // Each track is usually offered as MP3 plus an Ogg/FLAC derivative — keep the
  // MP3 to avoid downloading the same track twice.
  const hasMp3 = audio.some((f) => /mp3/i.test(f.format));
  const chosen = hasMp3 ? audio.filter((f) => /mp3/i.test(f.format)) : audio;

  const creator = Array.isArray(m.creator) ? m.creator.join(', ') : (m.creator || 'Unknown artist');
  return chosen
    .filter((f) => f.length === 0 || (f.length >= MIN_TRACK_SECONDS && f.length <= MAX_TRACK_SECONDS))
    .map((f) => ({
      id,
      name: f.name,
      length: f.length,
      title: f.title || f.name.replace(/\.[^.]+$/, ''),
      album: m.title || id,
      creator,
      url: server ? directFileUrl(server, dir, f.name) : downloadFileUrl(id, f.name),
      fallbackUrl: downloadFileUrl(id, f.name)
    }));
}

// ---------------------------------------------------------------------------
// Selection + caching
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Round-robin across albums (after shuffling within each) so the pool draws
// variety from every source rather than 10 tracks off one album.
function pickVaried(candidates, k) {
  const byItem = new Map();
  for (const t of candidates) {
    if (!byItem.has(t.id)) byItem.set(t.id, []);
    byItem.get(t.id).push(t);
  }
  const queues = shuffle(Array.from(byItem.values()).map((list) => shuffle(list)));
  const out = [];
  let added = true;
  while (out.length < k && added) {
    added = false;
    for (const q of queues) {
      if (q.length && out.length < k) { out.push(q.shift()); added = true; }
    }
  }
  return out;
}

function cacheNameFor(track) {
  // Keep it filesystem-safe and bounded, preserving the extension at the tail.
  return (track.id + '__' + track.name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-180);
}

function clampPct(fraction) {
  return Math.max(0, Math.min(100, Math.round((fraction || 0) * 100)));
}

// A small manifest records what's been downloaded (file + provenance) so a
// populated cache can be reused instantly, with no network call and no need to
// re-derive credits — important for "fetch on demand": you download once, then
// every later merge (even offline) just reuses the cache.
function manifestPath(cacheDir) { return path.join(cacheDir, 'manifest.json'); }

function loadManifest(cacheDir) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(cacheDir), 'utf8'));
    const tracks = Array.isArray(data.tracks) ? data.tracks : [];
    return tracks.filter((t) => t && t.file && fs.existsSync(path.join(cacheDir, t.file)));
  } catch (_) { return []; }
}

function saveManifest(cacheDir, tracks) {
  try { fs.writeFileSync(manifestPath(cacheDir), JSON.stringify({ tracks }, null, 2)); }
  catch (e) { log.warn('music: could not write cache manifest:', String((e && e.message) || e)); }
}

// Build the { trackPaths, credits, totalSeconds } result from manifest entries.
// Credits are grouped per artist (case-insensitively) so a vibe made of many
// single-track items — e.g. one artist's lo-fi catalogue — shows one clean
// credit ("Artist — N tracks") rather than the same name repeated.
function resultFromEntries(cacheDir, entries) {
  const byCreator = new Map();
  for (const e of entries) {
    const key = String(e.creator || 'Unknown artist').trim().toLowerCase();
    if (!byCreator.has(key)) {
      byCreator.set(key, { creator: e.creator || 'Unknown artist', license: e.license || 'CC0 (Public Domain)', source: e.source || 'Internet Archive', albums: new Set() });
    }
    byCreator.get(key).albums.add(e.album);
  }
  const credits = Array.from(byCreator.values()).map((c) => {
    const albums = Array.from(c.albums);
    return { creator: c.creator, album: albums.length > 1 ? `${albums.length} tracks` : albums[0], license: c.license, source: c.source };
  });
  return {
    trackPaths: entries.map((e) => path.join(cacheDir, e.file)),
    credits,
    totalSeconds: entries.reduce((s, e) => s + (e.length || 0), 0)
  };
}

function vibeCacheDir(baseDir, vibeKey) {
  return path.join(baseDir, String(vibeKey).replace(/[^a-z0-9_-]/gi, '') || DEFAULT_VIBE);
}

// Ensure a pool of public-domain tracks for the chosen vibe is available,
// downloading only what's missing. Each vibe caches into its own subfolder, so
// switching between vibes never re-downloads. Returns { trackPaths, credits,
// totalSeconds, vibe }.
async function fetchTracks({ cacheDir, vibe = DEFAULT_VIBE, poolSize = 8, onProgress } = {}) {
  if (!cacheDir) throw new Error('fetchTracks: cacheDir is required');
  const v = getVibe(vibe);
  const dir = vibeCacheDir(cacheDir, v.key);
  fs.mkdirSync(dir, { recursive: true });
  const emit = (stage, fraction, extra) => {
    if (onProgress) onProgress({ stage, vibe: v.key, percent: clampPct(fraction), ...(extra || {}) });
  };

  // 1) Enough already cached for this vibe? Reuse it — instant, and offline.
  const cached = loadManifest(dir);
  if (cached.length >= poolSize) {
    emit('done', 1);
    return { ...resultFromEntries(dir, pickVaried(cached, poolSize)), vibe: v.key };
  }

  // 2) Need more — list this vibe's curated CC0 items from the network. Stop
  // once we have a comfortable surplus of candidate tracks (so the "mix" vibe
  // doesn't fetch metadata for every item before downloading anything).
  emit('listing', 0);
  const seeds = shuffle(v.items.slice());
  const target = Math.max(poolSize * 2, 16);
  let candidates = [];
  for (const id of seeds) {
    try { candidates = candidates.concat(await listTracksForItem(id)); }
    catch (e) { log.warn('music: listing failed for', id, '-', String((e && e.message) || e)); }
    if (candidates.length >= target) break;
  }

  // Network unavailable — fall back to whatever is cached rather than failing.
  if (!candidates.length) {
    if (cached.length) { emit('done', 1); return { ...resultFromEntries(dir, pickVaried(cached, cached.length)), vibe: v.key }; }
    throw new Error('No public-domain music could be found right now. Check your internet connection and try again.');
  }

  // 3) Download fresh tracks we don't already have, up to poolSize.
  const cachedFiles = new Set(cached.map((t) => t.file));
  const fresh = pickVaried(candidates.filter((t) => !cachedFiles.has(cacheNameFor(t))), Math.max(0, poolSize - cached.length));
  const newEntries = [];
  let done = 0;

  for (const t of fresh) {
    const file = cacheNameFor(t);
    const dest = path.join(dir, file);
    try {
      if (!(fs.existsSync(dest) && fs.statSync(dest).size > 0)) {
        emit('downloading', done / fresh.length, { trackTitle: t.title, index: done + 1, total: fresh.length });
        try {
          await downloadTo(t.url, dest, (rcv, total) =>
            emit('downloading', (done + (total ? rcv / total : 0)) / fresh.length,
              { trackTitle: t.title, index: done + 1, total: fresh.length }));
        } catch (e1) {
          // The direct datanode URL can occasionally fail; fall back to the
          // canonical /download/ URL (which redirects to a working node).
          log.warn('music: direct download failed, retrying via /download/:', String((e1 && e1.message) || e1));
          await downloadTo(t.fallbackUrl, dest, null);
        }
      }
      newEntries.push({ file, id: t.id, album: t.album, creator: t.creator, license: 'CC0 (Public Domain)', source: 'Internet Archive', length: t.length });
    } catch (e) {
      log.warn('music: failed to fetch', t.id, t.name, '-', String((e && e.message) || e));
    }
    done++;
    emit('downloading', done / fresh.length);
  }

  const all = cached.concat(newEntries);
  if (!all.length) throw new Error('Could not download any music tracks (network problem?).');
  saveManifest(dir, all);
  emit('done', 1);
  return { ...resultFromEntries(dir, pickVaried(all, Math.min(poolSize, all.length))), vibe: v.key };
}

// ---------------------------------------------------------------------------
// Cache management + source info (for the UI)
// ---------------------------------------------------------------------------
// Total downloaded music across every vibe subfolder (excludes manifests).
function cacheInfo(cacheDir) {
  let count = 0;
  let bytes = 0;
  try {
    for (const sub of fs.readdirSync(cacheDir)) {
      const subPath = path.join(cacheDir, sub);
      let st; try { st = fs.statSync(subPath); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(subPath)) {
        if (f.endsWith('.part') || f === 'manifest.json') continue;
        try { bytes += fs.statSync(path.join(subPath, f)).size; count++; } catch (_) {}
      }
    }
  } catch (_) { /* nothing cached */ }
  return { count, bytes };
}

function clearCache(cacheDir) {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) { /* nothing cached */ }
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  return true;
}

function sourceInfo() {
  return {
    name: 'Internet Archive',
    license: 'CC0 / Public Domain',
    note: 'Public-domain (CC0) lo-fi & chill music from the Internet Archive — free to use in any project, no attribution required.',
    browseUrl: 'https://archive.org/search?query=subject%3Alofi+AND+licenseurl%3A%28%2Apublicdomain%2A%29'
  };
}

module.exports = { fetchTracks, cacheInfo, clearCache, sourceInfo, listVibes, getVibe, listTracksForItem, parseLength, VIBES };
