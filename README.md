# Video Merging Tool

A cross-platform desktop app (Windows + Linux) that scans a folder of videos,
orders them by the time they were recorded, lets you fine-tune the order on a
drag-and-drop timeline, and merges them into a single file.

- **Lossless by default** — when all clips share the same codec, resolution and
  frame rate, the clips are stream-copied (`-c copy`), so the merge is instant
  and the quality is byte-for-byte identical to the originals.
- **Choose the output, keep quality** — set a target resolution (up to 4K) and
  frame rate (**Settings → Output & encoding**); clips already at the target are
  kept **bit-for-bit lossless** and only the others are re-encoded to it. Quality
  ranges from near-lossless (default) to true lossless.
- **NVIDIA GPU (NVENC) encoding** — hardware-accelerated **H.264 or HEVC/H.265**,
  auto-detected with an automatic CPU (x264/x265) fallback. Your preferences are
  saved between sessions.
- **Integrity verification & automatic repair** — optional (on by default): a
  single pass after the merge checks the output for corruption (decode errors,
  truncation) and auto-re-encodes any clip that turns out to be damaged, so one
  bad file can't silently ruin the export. Small files are decoded in full;
  large ones are spot-checked to stay fast — or turn it off entirely for big
  merges you trust.
- **Split for upload limits** — set a max file size (**Settings → Max file
  size**) and the output is split into `name_part1`, `name_part2`, … at clip
  boundaries, each file under the limit. Presets cover YouTube's 256 GB upload
  cap and FAT32's 4 GB, and every part gets the full verification pass.
- **Smart ordering** — clips are sorted by embedded capture time
  (`creation_time` metadata), falling back to a date in the filename, then the
  file's created/modified time. Each row shows which source was used.
- **Drag-to-reorder timeline** — reorder clips in the list *or* the timeline
  strip at the bottom; the two stay in sync.
- **Per-clip contrast, saturation & trim** — select a clip and, in the preview
  pane, adjust its contrast or colour saturation, or drag the start/end handles
  to cut its beginning and end (all with a live preview). Only the clips you edit
  are re-encoded; the rest stay lossless.
- **Bundled FFmpeg** — `ffmpeg` and `ffprobe` ship via npm
  (`ffmpeg-static` / `ffprobe-static`); nothing else to install.
- **Shuffle & manual control** — randomize the order with one click (**🔀 Shuffle**),
  drag to fine-tune, or remove clips you don't want.
- **One-click "drop mismatched"** — when clips have differing formats, remove the
  odd ones out so the rest merge losslessly without re-encoding.
- **Choose where it saves** — set the output file up front, or be prompted at merge time.
- **Self-updating** — the installed app checks the GitHub releases on launch and
  can download & install the newest version from within the app.

![overview](docs/overview.png)

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (only needed to install/run from
  source; a packaged build needs nothing).

The app is written in **TypeScript** (strict mode). The source `.ts` files
compile to plain JavaScript in `out/`, which is what Electron actually runs.

## Run from source

```bash
npm install     # downloads Electron + the FFmpeg binaries for your OS
npm start       # compiles TypeScript to out/, then launches Electron
```

`npm start` runs `npm run build` (`tsc` + copying the static renderer assets and
icons into `out/`) before starting Electron. Run `npm install` on each OS you
want to use it on — the correct FFmpeg binary is fetched for the current platform.

## Tests

```bash
npm test            # type-checks + runs the fast unit tests
npm run test:engine # type-checks + headless end-to-end test of the real FFmpeg pipeline
npm run typecheck   # type-check only (tsc --noEmit), no output emitted
```

`npm test` first compiles the project (so a type error anywhere fails the run),
then uses Node's built-in test runner against the compiled tests in `out/test/`.
`npm run test:engine` generates a few clips and exercises the lossless,
re-encode, background-music, and size-split merge paths end to end — including
a deliberately corrupted clip that must be detected and repaired, the spot-check
verifier used for large outputs, and a verification-disabled run — handy for
confirming the bundled FFmpeg works after installing on a new OS (e.g. Linux).

## Build a standalone app

```bash
npm run dist          # build for the current OS
npm run dist:win      # Windows: NSIS setup .exe + portable .exe
npm run dist:linux    # Linux AppImage
```

Output lands in `dist/`:

| File | What it is |
|------|------------|
| `VideoMergingTool-Setup-<version>.exe` | NSIS installer (lets you pick the install dir, adds a Start-menu shortcut). |
| `VideoMergingTool-Portable-<version>.exe` | Self-contained portable build — run it from anywhere, no install. |

> Builds are unsigned, so Windows SmartScreen may show a "Windows protected your
> PC" prompt the first time — choose **More info → Run anyway**. Add a code-signing
> certificate to `electron-builder` config to remove it.

## Continuous integration / releases

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push/PR to
`main`:

1. **Unit tests** on Ubuntu (`npm test`).
2. **Windows build** — runs the FFmpeg engine smoke test, then builds the NSIS
   setup and portable `.exe` and uploads them as downloadable workflow artifacts.

To cut a release, push a tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The pipeline then attaches both `.exe` files — plus the `latest.yml` update
metadata that powers in-app auto-update — to a GitHub Release for that tag.

## How to use

1. Click **Open Folder…** and pick a folder containing your videos.
2. The app probes every video, reads its metadata and lists the clips oldest
   → newest. A badge shows whether a lossless merge is possible.
3. Reorder clips by dragging rows in the list or tiles in the timeline (which
   scrolls horizontally when there are many). Use the **Order** dropdown to
   re-sort by date or name, hit **🔀 Shuffle** for a random order, or remove clips
   with **✕**.
4. If the badge shows **⚠ Mixed formats**, either leave **Re-encode** on, or click
   **Drop N mismatched** to remove the odd-format clips so the rest merge
   losslessly.
5. Click a clip to preview it. In the preview pane you can adjust its **contrast**
   and **saturation** and **trim its start/end** with the sliders (a ✎ marks
   edited clips). Edited clips are re-encoded; untouched clips stay lossless.
6. Optionally click **📂 Save to…** to choose the output location up front
   (otherwise you'll be prompted when you merge).
7. Click **Merge ▶** and watch the progress bar.

## Automatic updates

The **installed** (NSIS) build checks the GitHub releases each time it launches.
When a newer release exists, a banner appears at the top:

- **Installed app:** click **Download & install**; when it finishes, click
  **Restart & install** to apply it.
- **Portable build / running from source:** self-replacement isn't possible, so
  the banner instead offers **Open releases page** to grab the latest manually.

Updates come straight from the
[Releases](https://github.com/Alli1223/video-merging-tool/releases) page —
electron-updater reads the `latest.yml` published with each tagged build. Auto-
update takes effect from the first release that includes this feature onward.

## Lossless: the fine print

True lossless merging (`-c copy`) only works when clips are byte-compatible —
same video codec, resolution, pixel format, frame rate, and same audio codec /
sample rate / channel layout. Clips straight off one camera or phone session
almost always match. When they don't, the **⚠ Mixed formats** badge appears and
the app switches to the re-encode path, which re-renders the video and is
therefore not bit-for-bit lossless (though CRF 18 is visually near-lossless).

In a mixed merge, clips that already match the target are still stream-copied
losslessly and only the others are re-encoded (e.g. a 4K clip is downscaled to a
1080p target). Those per-clip segments are joined through **MPEG-TS**, which
repeats the codec parameter sets in-band, so a copied original and a re-encoded
clip — which carry *different* parameters, especially when the re-encode uses a
GPU (NVENC) encoder — decode correctly side by side. (Joining them as MP4 instead
keeps only the first clip's parameters and silently corrupts every re-encoded
clip.) A consequence: a mixed **HEVC** output is tagged `hev1` rather than `hvc1`,
which plays everywhere except some older Apple/QuickTime players; pure-lossless
merges keep their original tag.

## Integrity verification & automatic repair

Stream copy (`-c copy`) never decodes the footage, so a source file with a
damaged bitstream — a camera that lost power, a flaky SD card, a bad download —
would previously be copied into the merged file verbatim, and FFmpeg would
still exit successfully. With **Settings → Verify output** on (the default), the
merge ends with a single integrity pass over the finished file instead of taking
that on faith:

1. **One pass, after the merge.** The merge itself runs at full speed — clips
   are no longer decoded one-by-one as they go (that tripled the time on a big
   lossless merge). Instead the finished file is checked once:
   - **Small outputs** (≤ 2 GB) are decoded end to end with `-v error`, and the
     decodable length is compared with the expected total — so a damaged source
     copied through, a bad join, or a truncated write is caught before playback.
   - **Large outputs** (a 256 GB upload-split part, say) are **spot-checked** so
     verification stays fast: the container is probed and a handful of short
     windows are decoded across the timeline. This is much quicker than decoding
     hundreds of GB but can miss damage that falls between the sampled points.
2. **Automatic repair (only when something is wrong).** If the check fails, the
   merge is rebuilt per-clip *with* full per-segment verification — each clip is
   decoded and stream copies are **CRC-32 compared against their source** (via
   FFmpeg's `crc` muxer, container-independent) — to pinpoint and re-encode just
   the damaged clip(s); decoding conceals the damaged regions instead of copying
   them. The result panel reports what was repaired (e.g. *"1 corrupted clip was
   detected and re-encoded"*) and ends with *"integrity verified ✓"*.
3. **Bad clips are cut out, never the whole job.** A clip that can't be turned
   into a usable segment — it won't encode at all, or it still fails its check
   after a re-encode — is **dropped** from the merge and the rest finishes
   normally; the result lists which clips were left out. So one corrupt file in a
   long batch costs you that clip, not the entire export, and never an endless
   re-encode restart. Any full re-encode the engine does (e.g. after a failed
   join) runs **clip-by-clip** so memory stays flat — it never opens every input
   at once.

Because the heavy per-clip decoding now happens **only when corruption is
actually detected**, a clean merge pays just one quick pass (or none, if you
turn verification off). Heavily damaged footage may still show visual artifacts
where data was destroyed — that information is gone — but the exported file
itself is structurally clean and plays smoothly. In the rare case something
still can't be verified after repair, the file is kept and the status line tells
you exactly what couldn't be confirmed (also logged via **Settings → Open log
file**).

**Turning it off.** Verification is a checkbox in **Settings → Output &
encoding**. Even one pass over a 256 GB file is a lot of reading, so for very
large merges from sources you trust, unchecking **Verify output** skips the
check entirely and gets you the raw merge speed.

## Splitting for upload limits (YouTube's 256 GB, FAT32's 4 GB, …)

Some destinations cap the size of a single file — YouTube rejects uploads over
**256 GB** (or 12 hours), FAT32 drives can't hold a file over 4 GB. Set
**Settings → Max file size** and the merge splits the output into
`name_part1.mp4`, `name_part2.mp4`, … with every file under the limit:

- **Splits happen at clip boundaries** — no clip is ever cut mid-scene, and
  each part is a normal standalone video (clips that match the target are
  still stream-copied losslessly within their part).
- **Parts are planned from per-clip sizes** — exact file sizes for
  stream-copied clips, a deliberately conservative bitrate model for
  re-encoded ones. Every finished part is then measured against the limit;
  if real-world bitrate beat the estimate, the part is automatically split in
  half and redone, so the limit holds regardless.
- **Every part gets the integrity check** described above (when it's enabled),
  and the timeline summary shows roughly how many files to expect before you
  merge.
- If everything fits under the limit, you just get the single file you asked
  for — no `_part1` suffix.

A merge that can never satisfy the limit (a single clip whose exact size is
already over it) fails up front with an explanation instead of wasting an
encode.

## Project layout

| File | Role |
|------|------|
| `main.ts` | Electron main process; owns windows and IPC. |
| `preload.ts` | Safe `window.api` bridge to the renderer (typed against the `Api` contract). |
| `src/global.d.ts` | Shared ambient types: the domain model and the `window.api` IPC contract. |
| `src/metadata.ts` | Pure logic: file detection, capture-time resolution, compatibility keys, ordering. |
| `src/ffargs.ts` | Pure logic: FFmpeg argument/filter-graph construction, progress parsing, and the integrity verdict (`assessIntegrity`). |
| `src/ffmpeg.ts` | Spawns ffprobe/ffmpeg for probing, thumbnails, both merge paths, and the verification/repair pass. |
| `src/scanner.ts` | Directory scan that wires `ffmpeg` + `metadata` together. |
| `src/music.ts` | Fetches & caches CC0 background music from the Internet Archive. |
| `renderer/` | The UI: `index.html`, `styles.css`, and `renderer.ts` (clip list, timeline, controls). |
| `test/` | Unit tests for the pure modules (`npm test`). |
| `selftest.ts` | End-to-end engine smoke test (`npm run test:engine`). |
| `tsconfig.json` | TypeScript config (strict). Compiles `.ts` → `out/`. |
| `scripts/copy-assets.js` | Build step: copies HTML/CSS/icons into `out/` next to the compiled JS. |
| `.github/workflows/ci.yml` | CI: unit tests + Windows installer build. |

## Supported containers

`.mp4 .mov .mkv .avi .m4v .webm .mts .m2ts .ts .wmv .flv .3gp .mpg .mpeg .vob
.ogv .mxf` and more. The merged output can be saved as MP4, MKV, MOV, M4V,
WebM or AVI.

## License

MIT
