# Video Merging Tool

A cross-platform desktop app (Windows + Linux) that scans a folder of videos,
orders them by the time they were recorded, lets you fine-tune the order on a
drag-and-drop timeline, and merges them into a single file.

- **Lossless by default** — when all clips share the same codec, resolution and
  frame rate, the clips are stream-copied (`-c copy`), so the merge is instant
  and the quality is byte-for-byte identical to the originals.
- **Automatic re-encode fallback** — if clips have mixed formats, the app
  normalizes them to a common spec and re-encodes (H.264 / AAC, CRF 18) so the
  merge still works.
- **Smart ordering** — clips are sorted by embedded capture time
  (`creation_time` metadata), falling back to a date in the filename, then the
  file's created/modified time. Each row shows which source was used.
- **Drag-to-reorder timeline** — reorder clips in the list *or* the timeline
  strip at the bottom; the two stay in sync.
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

## Run from source

```bash
npm install     # downloads Electron + the FFmpeg binaries for your OS
npm start
```

Run `npm install` on each OS you want to use it on — the correct FFmpeg binary
is fetched for the current platform.

## Tests

```bash
npm test            # fast unit tests (ordering, compatibility, FFmpeg arg building)
npm run test:engine # headless end-to-end smoke test of the real FFmpeg pipeline
```

`npm test` uses Node's built-in test runner (no extra dependencies) and runs in
under a second. `npm run test:engine` generates a few clips and exercises both
the lossless and re-encode merge paths end to end — handy for confirming the
bundled FFmpeg works after installing on a new OS (e.g. Linux).

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
5. Optionally click **📂 Save to…** to choose the output location up front
   (otherwise you'll be prompted when you merge).
6. Click **Merge ▶** and watch the progress bar.

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

## Project layout

| File | Role |
|------|------|
| `main.js` | Electron main process; owns windows and IPC. |
| `preload.js` | Safe `window.api` bridge to the renderer. |
| `src/metadata.js` | Pure logic: file detection, capture-time resolution, compatibility keys, ordering. |
| `src/ffargs.js` | Pure logic: FFmpeg argument/filter-graph construction and progress parsing. |
| `src/ffmpeg.js` | Spawns ffprobe/ffmpeg for probing, thumbnails, and both merge paths. |
| `src/scanner.js` | Directory scan that wires `ffmpeg` + `metadata` together. |
| `renderer/` | The UI (HTML/CSS/JS): clip list, timeline, merge controls. |
| `test/` | Unit tests for the pure modules (`npm test`). |
| `selftest.js` | End-to-end engine smoke test (`npm run test:engine`). |
| `.github/workflows/ci.yml` | CI: unit tests + Windows installer build. |

## Supported containers

`.mp4 .mov .mkv .avi .m4v .webm .mts .m2ts .ts .wmv .flv .3gp .mpg .mpeg .vob
.ogv .mxf` and more. The merged output can be saved as MP4, MKV, MOV, M4V,
WebM or AVI.

## License

MIT
