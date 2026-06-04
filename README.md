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

To confirm the FFmpeg pipeline works on a fresh machine (handy on Linux), run
the headless smoke test — it generates a few clips and exercises both the
lossless and re-encode merge paths:

```bash
npm test
```

## Build a standalone app

```bash
npm run dist          # build for the current OS
npm run dist:win      # Windows installer (.exe / NSIS)
npm run dist:linux    # Linux AppImage
```

Output lands in `dist/`.

## How to use

1. Click **Open Folder…** and pick a folder containing your videos.
2. The app probes every video, reads its metadata and lists the clips oldest
   → newest. A badge shows whether a lossless merge is possible.
3. Reorder clips by dragging rows in the list or tiles in the timeline. Use the
   **Order** dropdown to re-sort by date or name, or remove clips with **✕**.
4. Leave **Re-encode** off for a lossless stream-copy (enabled automatically and
   locked on when clips have mixed formats).
5. Click **Merge ▶**, choose where to save, and watch the progress bar.

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
| `src/ffmpeg.js` | ffprobe metadata, thumbnails, and both merge paths. |
| `src/scanner.js` | Directory scan + capture-time ordering. |
| `renderer/` | The UI (HTML/CSS/JS): clip list, timeline, merge controls. |
| `selftest.js` | Headless integration test of the merge engine (`npm test`). |

## Supported containers

`.mp4 .mov .mkv .avi .m4v .webm .mts .m2ts .ts .wmv .flv .3gp .mpg .mpeg .vob
.ogv .mxf` and more. The merged output can be saved as MP4, MKV, MOV, M4V,
WebM or AVI.

## License

MIT
