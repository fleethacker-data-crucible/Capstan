// Picture exports: a single frame as PNG, and the timeline (or part of it) as an animated GIF.
// Both draw with the same compositor as the preview and the MP4 export (see frames.ts).
import { type DecodeDecision, describeDecisions } from './demux/choose';
import { type BlobLookup, createFrameRenderer } from './frames';
import { GifEncoder, buildPalette, frameDelays } from './gif';
import type { ByteSink } from './mp4/muxer';
import { type Project, projectDuration } from './project';
import { type TimeRange, exportSpan } from './range';

export interface PngOptions {
  width: number;
  height: number;
  captions?: boolean;
  fast?: boolean;
}

/** The frame at `time` seconds as a PNG, drawn at the given size. */
export async function exportFramePng(project: Project, blobs: BlobLookup, time: number, options: PngOptions): Promise<Blob> {
  const duration = projectDuration(project);
  if (!(duration > 0)) throw new Error('The timeline is empty');
  const renderer = await createFrameRenderer(project, blobs, { width: options.width, height: options.height, captions: options.captions, fast: options.fast });
  try {
    // The last frame of the timeline sits just before its end: keep the playhead inside it.
    await renderer.render(Math.min(Math.max(0, time), Math.max(0, duration - 1e-3)));
    return await renderer.canvas.convertToBlob({ type: 'image/png' });
  } finally {
    renderer.close();
  }
}

export interface GifExportOptions {
  width: number;
  height: number;
  /** Frames per second, 1..50 (browsers play GIFs slower than 2 centiseconds per frame at 10 fps). */
  fps: number;
  /** Palette size, 2..256. */
  colors: number;
  dither: boolean;
  /** Frame differencing (smaller files). */
  optimize: boolean;
  /** 0 = loop forever, null = play once. */
  loop: number | null;
  captions?: boolean;
  fast?: boolean;
  range?: TimeRange;
  /** Write the GIF to this destination as it is produced (blob is then null). */
  openSink?: () => Promise<ByteSink>;
}

export interface GifProgress {
  stage: 'preparing' | 'video' | 'finishing';
  fraction: number;
  frame?: number;
  frames?: number;
  /** How the source video is being decoded and why. */
  decode?: string;
}

export interface GifResult {
  blob: Blob | null;
  bytes: number;
  streamed: boolean;
  decode: { fast: number; seek: number };
  decisions: DecodeDecision[];
  frames: number;
  seconds: number;
}

/** How many frames feed the shared palette. */
const PALETTE_SAMPLES = 12;

export async function exportGif(
  project: Project,
  blobs: BlobLookup,
  options: GifExportOptions,
  onProgress: (p: GifProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<GifResult> {
  const span = exportSpan(projectDuration(project), options.range);
  if (!span) throw new Error(options.range ? 'The in and out marks cover nothing on the timeline' : 'The timeline is empty');
  const fps = Math.min(50, Math.max(1, options.fps));
  const seconds = span.end - span.start;
  const frames = Math.max(1, Math.round(seconds * fps));
  const aborted = () => new DOMException('Export cancelled', 'AbortError');
  onProgress({ stage: 'preparing', fraction: 0 });
  const renderer = await createFrameRenderer(project, blobs, { width: options.width, height: options.height, captions: options.captions, readback: true, fast: options.fast });
  const sink = options.openSink ? await options.openSink() : null;
  try {
    // One palette for the whole GIF, from frames spread evenly across it.
    const samples: Uint8ClampedArray[] = [];
    const count = Math.min(PALETTE_SAMPLES, frames);
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) throw aborted();
      const f = count === 1 ? 0 : Math.round((i * (frames - 1)) / (count - 1));
      await renderer.render(span.start + f / fps);
      samples.push(renderer.pixels());
      onProgress({ stage: 'preparing', fraction: 0.1 * ((i + 1) / count) });
    }
    const colors = Math.min(options.colors, options.optimize ? 255 : 256);
    const palette = buildPalette(samples, colors);
    samples.length = 0;

    const parts: Uint8Array[] = [];
    let position = 0;
    let pending: Uint8Array[] = [];
    const flush = async () => {
      if (!sink || !pending.length) return;
      const size = pending.reduce((n, p) => n + p.length, 0);
      const joined = new Uint8Array(size);
      let o = 0;
      for (const p of pending) {
        joined.set(p, o);
        o += p.length;
      }
      pending = [];
      await sink.write(joined, position);
      position += size;
    };
    const encoder = new GifEncoder(
      { width: options.width, height: options.height, loop: options.loop, dither: options.dither, optimize: options.optimize },
      palette,
      (bytes) => (sink ? pending.push(bytes) : parts.push(bytes)),
    );
    const delays = frameDelays(fps, frames);
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw aborted();
      await renderer.render(span.start + f / fps);
      encoder.addFrame(renderer.pixels(), delays[f]);
      await flush();
      if (f % 3 === 0 || f === frames - 1) onProgress({ stage: 'video', fraction: 0.1 + 0.88 * ((f + 1) / frames), frame: f + 1, frames, decode: describeDecisions(renderer.decisions) });
    }
    encoder.finish();
    onProgress({ stage: 'finishing', fraction: 0.99 });
    if (sink) {
      await flush();
      await sink.close();
      onProgress({ stage: 'finishing', fraction: 1 });
      return { blob: null, bytes: position, streamed: true, decode: { ...renderer.stats }, decisions: renderer.decisions.map((d) => ({ ...d })), frames, seconds };
    }
    const blob = new Blob(parts as BlobPart[], { type: 'image/gif' });
    onProgress({ stage: 'finishing', fraction: 1 });
    return { blob, bytes: blob.size, streamed: false, decode: { ...renderer.stats }, decisions: renderer.decisions.map((d) => ({ ...d })), frames, seconds };
  } catch (e) {
    await sink?.abort?.();
    throw e;
  } finally {
    renderer.close();
  }
}
