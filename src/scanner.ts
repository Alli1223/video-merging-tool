import { promises as fsp } from 'fs';
import type { Stats } from 'fs';
import path from 'path';
import * as ffmpeg from './ffmpeg';
import { isVideoFile, resolveCaptureTime, compatKey, sortClips } from './metadata';
import * as log from './logger';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ProbedFile {
  file: string;
  meta: ProbeResult;
  stat: Stats;
}

// Probe a list of files with bounded concurrency.
async function probeAll(files: string[]): Promise<ProbedFile[]> {
  const concurrency = Math.min(6, files.length || 1);
  const results: (ProbedFile | null)[] = new Array(files.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < files.length) {
      const i = cursor++;
      const file = files[i];
      try {
        const [meta, stat] = await Promise.all([
          ffmpeg.probeFile(file),
          fsp.stat(file)
        ]);
        results[i] = { file, meta, stat };
      } catch (e) {
        log.warn('Could not probe', file, '-', errMsg(e));
        results[i] = null; // unreadable / not a real media file — drop it
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results.filter((r): r is ProbedFile => r !== null);
}

export async function scanDirectory(dir: string): Promise<ScanResult> {
  log.info('Scanning directory:', dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && isVideoFile(e.name))
    .map((e) => path.join(dir, e.name));
  log.info(`Found ${files.length} file(s) with a video extension`);

  const probed = await probeAll(files);

  let idCounter = 0;
  const clips: Clip[] = probed
    .filter((p) => p.meta.hasVideo) // only keep entries with a real video stream
    .map(({ file, meta, stat }) => {
      const name = path.basename(file);
      const capture = resolveCaptureTime(meta, stat, name);
      return {
        id: ++idCounter,
        path: file,
        name,
        ext: path.extname(file).replace('.', '').toLowerCase(),
        size: stat.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        vcodec: meta.vcodec,
        acodec: meta.acodec,
        pixfmt: meta.pixfmt,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        hasVideo: meta.hasVideo,
        hasAudio: meta.hasAudio,
        sortTime: capture.time,
        timeSource: capture.source,
        compatKey: compatKey(meta)
      };
    });

  const stats: ScanStats = { matched: files.length, probed: probed.length, withVideo: clips.length };
  log.info(`Scan complete: ${stats.matched} matched, ${stats.probed} probed OK, ${stats.withVideo} with a video stream`);

  // Default order: oldest first by capture time, name as a tiebreaker.
  return { dir, clips: sortClips(clips, 'date-asc'), stats };
}
