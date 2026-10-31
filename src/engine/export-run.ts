// Runs one export from a settings object (format, size, range, ...) and reports what it wrote.
// The dialog and the batch queue both go through here, so a preset behaves the same either way.
import { exportM4a, exportWav } from './audio-export';
import type { DecodeDecision } from './demux/choose';
import { defaultExportOptions, exportMp4 } from './export';
import { exportFramePng, exportGif } from './export-image';
import type { ByteSink } from './mp4/muxer';
import { type Project, projectDuration } from './project';
import { type ExportSettings, QUALITY_FACTOR, allPresets, outputFps, outputSize, parseSettings } from './presets';
import type { TimeRange } from './range';
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
  /** Any other destination (a CLI file, a test sink): the export streams into it. Wins over `handle`. */
  openSink?: () => Promise<ByteSink>;
  /** An explicit stretch of the timeline; overrides the settings' range choice and the project marks. */
  range?: TimeRange;
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
  /** Per video file: decoded in order (fast) or seeked, and why. Empty when the project has no video. */
  decisions?: DecodeDecision[];
}

export function rangeFor(project: Project, settings: ExportSettings) {
  if (settings.range !== 'marks') return undefined;
  if (!project.range) throw new Error('Set the in and out marks first: press I and O on the timeline, or drag in the ruler.');
  return project.range;
}

const seconds = (n: number) => `${n.toFixed(1)} s`;

/** The results-list line, with a note on any video that was seeked (the slow way) and why. */
function withDecode(summary: string, decisions: DecodeDecision[] | undefined): string {
  const seeks = (decisions ?? []).filter((d) => d.path === 'seek');
  return seeks.length ? `${summary}; seeked ${seeks.map((d) => `${d.media} (${d.reason})`).join(', ')}` : summary;
}

/** The progress line: the frame, and how the video is being decoded once that is known. */
function frameLine(frame: number | undefined, frames: number | undefined, decode: string | undefined): string {
  return `Frame ${frame} of ${frames}${decode ? ` · ${decode}` : ''}`;
}

export async function runExport(project: Project, settings: ExportSettings, options: RunExportOptions): Promise<RunResult> {
  if (!(projectDuration(project) > 0)) throw new Error('The timeline is empty');
  const { blobs, signal } = options;
  const report = (fraction: number, detail: string) => options.onProgress?.({ fraction, detail });
  const range = options.range ?? rangeFor(project, settings);
  const { width, height } = outputSize(project, settings.size);
  const fps = outputFps(project, settings.fps);
  const sink: (() => Promise<ByteSink>) | undefined = options.openSink ?? (options.handle ? () => openSink(options.handle!) : undefined);
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
      (p) => report(p.fraction, p.stage === 'video' ? frameLine(p.frame, p.frames, p.decode) : p.stage === 'preparing' ? 'Building the palette…' : 'Writing the file…'),
      signal,
    );
    return { format, blob: r.blob, bytes: r.bytes, streamed: r.streamed, decode: r.decode, decisions: r.decisions, summary: withDecode(`${r.frames} frames, ${seconds(r.seconds)}`, r.decisions) };
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
        p.stage === 'audio' ? 'Mixing audio…' : p.stage === 'video' ? frameLine(p.frame, p.frames, p.decode) : p.stage === 'finishing' ? 'Writing the file…' : 'Preparing…',
      ),
    signal,
  );
  return {
    format,
    blob: r.blob,
    bytes: r.bytes,
    streamed: r.streamed,
    summary: withDecode(`H.264${r.audioCodec ? ` + ${r.audioCodec === 'aac' ? 'AAC' : 'Opus'}` : ', no audio'}, ${seconds(r.seconds)}`, r.decisions),
    softwareFallback: r.encoder === 'software',
    decode: r.decode,
    decisions: r.decisions,
  };
}

/**
 * A whole export as plain data, for callers that have no dialog (a CLI or API command, scripts):
 * name a preset or give settings, choose the range, say where the bytes go. Everything in it can be
 * written as JSON apart from the sink opener.
 */
export interface ExportRequest {
  /** Name of a built-in or saved preset (case-insensitive). */
  preset?: string;
  /** Settings applied on top of the preset (or the defaults). */
  settings?: Partial<ExportSettings>;
  /** 'whole' (default), 'marks' (the project's in/out), or explicit seconds. */
  range?: 'whole' | 'marks' | TimeRange;
  /** Timeline time for a PNG frame (default 0). */
  time?: number;
  /** Where to send the bytes; omit to get a Blob in the result. */
  output?: { openSink: () => Promise<ByteSink> };
  /** Saved presets to search besides the built-in ones. */
  userPresets?: Parameters<typeof allPresets>[0];
}

/** Resolves a request to the settings it runs with (throws for an unknown preset name). */
export function resolveRequest(request: ExportRequest): ExportSettings {
  let base: unknown = {};
  if (request.preset) {
    const found = allPresets(request.userPresets ?? []).find((p) => p.name.toLowerCase() === request.preset!.toLowerCase());
    if (!found) throw new Error(`No export preset called "${request.preset}"`);
    base = found.settings;
  }
  const merged = { ...(base as object), ...(request.settings ?? {}) } as Record<string, unknown>;
  if (request.range === 'marks') merged.range = 'marks';
  else if (request.range === 'whole') merged.range = 'whole';
  return parseSettings(merged);
}

export function exportWith(
  project: Project,
  request: ExportRequest,
  deps: { blobs: (mediaId: string) => Promise<Blob | null>; onProgress?: (p: RunProgress) => void; signal?: AbortSignal },
): Promise<RunResult> {
  const settings = resolveRequest(request);
  return runExport(project, settings, {
    blobs: deps.blobs,
    time: request.time ?? 0,
    range: request.range && typeof request.range === 'object' ? request.range : undefined,
    openSink: request.output?.openSink,
    onProgress: deps.onProgress,
    signal: deps.signal,
  });
}
