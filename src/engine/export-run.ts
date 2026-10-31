// Runs one export from a settings object (format, size, range, ...) and reports what it wrote.
// The dialog and the batch queue both go through here, so a preset behaves the same either way.
import { exportM4a, exportWav } from './audio-export';
import { defaultExportOptions, exportMp4 } from './export';
import { exportFramePng, exportGif } from './export-image';
import type { ByteSink } from './mp4/muxer';
import { type Project, projectDuration } from './project';
import { type ExportSettings, QUALITY_FACTOR, outputFps, outputSize } from './presets';
import { type FileHandleLike, openSink } from './sinks';

export interface RunProgress {
  fraction: number;
  detail: string;
}

export interface RunExportOptions {
  blobs: (mediaId: string) => Promise<Blob | null>;
  /** Timeline time for a PNG frame (the playhead). */
  time: number;
  /** A file chosen by the user: the export streams into it instead of building a Blob. */
  handle?: FileHandleLike | null;
  onProgress?: (p: RunProgress) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  format: ExportSettings['format'];
  /** Present unless the file was streamed to disk. */
  blob: Blob | null;
  bytes: number;
  streamed: boolean;
  /** One line for the results list, e.g. "H.264 + AAC, 8.0 s". */
  summary: string;
  /** True when the hardware video encoder stalled and the software one produced the file. */
  softwareFallback?: boolean;
  /** Source pictures taken from the sequential decoder (fast) or by seeking (seek). */
  decode?: { fast: number; seek: number };
}

export function rangeFor(project: Project, settings: ExportSettings) {
  if (settings.range !== 'marks') return undefined;
  if (!project.range) throw new Error('Set the in and out marks first: press I and O on the timeline, or drag in the ruler.');
  return project.range;
}

const seconds = (n: number) => `${n.toFixed(1)} s`;

export async function runExport(project: Project, settings: ExportSettings, options: RunExportOptions): Promise<RunResult> {
  if (!(projectDuration(project) > 0)) throw new Error('The timeline is empty');
  const { blobs, signal } = options;
  const report = (fraction: number, detail: string) => options.onProgress?.({ fraction, detail });
  const range = rangeFor(project, settings);
  const { width, height } = outputSize(project, settings.size);
  const fps = outputFps(project, settings.fps);
  const sink: (() => Promise<ByteSink>) | undefined = options.handle ? () => openSink(options.handle!) : undefined;
  const format = settings.format;

  if (format === 'png') {
    report(0.1, 'Drawing the frame…');
    const blob = await exportFramePng(project, blobs, options.time, { width, height, captions: settings.captions, fast: settings.fast });
    if (sink) {
      const s = await sink();
      await s.write(new Uint8Array(await blob.arrayBuffer()), 0);
      await s.close();
    }
    report(1, 'Done');
    return { format, blob: sink ? null : blob, bytes: blob.size, streamed: !!sink, summary: `${width}×${height} picture` };
  }

  if (format === 'gif') {
    const r = await exportGif(
      project,
      blobs,
      {
        width,
        height,
        fps,
        colors: settings.gifColors,
        dither: settings.gifDither,
        optimize: settings.gifOptimize,
        loop: settings.gifLoop ? 0 : null,
        captions: settings.captions,
        fast: settings.fast,
        range,
        openSink: sink,
      },
      (p) => report(p.fraction, p.stage === 'video' ? `Frame ${p.frame} of ${p.frames}` : p.stage === 'preparing' ? 'Building the palette…' : 'Writing the file…'),
      signal,
    );
    return { format, blob: r.blob, bytes: r.bytes, streamed: r.streamed, decode: r.decode, summary: `${r.frames} frames, ${seconds(r.seconds)}` };
  }

  if (format === 'wav' || format === 'm4a') {
    const run = format === 'wav' ? exportWav : exportM4a;
    const r = await run(project, blobs, { range, openSink: sink }, (p) => report(p.fraction, p.stage === 'finishing' ? 'Writing the file…' : 'Mixing audio…'), signal);
    return { format, blob: r.blob, bytes: r.bytes, streamed: r.streamed, summary: `${r.codec === 'pcm16' ? '16-bit PCM' : 'AAC'}, ${r.sampleRate / 1000} kHz stereo, ${seconds(r.seconds)}` };
  }

  const base = defaultExportOptions({ ...project, width, height, fps });
  const r = await exportMp4(
    project,
    blobs,
    {
      ...base,
      videoBitrate: Math.round(base.videoBitrate * QUALITY_FACTOR[settings.quality]),
      includeAudio: settings.includeAudio,
      captions: settings.captions,
      fast: settings.fast,
      range,
      openSink: sink,
    },
    (p) =>
      report(
        p.fraction,
        p.stage === 'audio' ? 'Mixing audio…' : p.stage === 'video' ? `Frame ${p.frame} of ${p.frames}` : p.stage === 'finishing' ? 'Writing the file…' : 'Preparing…',
      ),
    signal,
  );
  return {
    format,
    blob: r.blob,
    bytes: r.bytes,
    streamed: r.streamed,
    summary: `H.264${r.audioCodec ? ` + ${r.audioCodec === 'aac' ? 'AAC' : 'Opus'}` : ', no audio'}, ${seconds(r.seconds)}`,
    softwareFallback: r.encoder === 'software',
    decode: r.decode,
  };
}
