// Offline MP4 export. Frames are rendered one by one with the same compositor as the preview
// (each video seeked to the exact frame time), encoded with WebCodecs H.264, and the audio is
// mixed with an OfflineAudioContext and encoded as AAC (or Opus where AAC is unavailable).
import { type BlobLookup, type FrameRenderer, createFrameRenderer } from './frames';
import { type AudioTrackConfig, type ByteSink, Mp4Muxer } from './mp4/muxer';
import { type Clip, type Project, clipSpeed, findMedia, projectDuration } from './project';
import { type TimeRange, clipWindow, exportSpan } from './range';

export type { BlobLookup } from './frames';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** Video bits per second. */
  videoBitrate: number;
  includeAudio: boolean;
  /** Burn the project's captions into the picture (default true). */
  captions?: boolean;
  /** Export only this stretch of the timeline (seconds); times in the file start at 0. */
  range?: TimeRange;
  /**
   * Stream the file: called once per attempt to open the destination. The MP4 is written to it as
   * frames are encoded (moov at the end), so memory stays flat and `ExportResult.blob` is null.
   */
  openSink?: () => Promise<ByteSink>;
  /** Decode source video in order with WebCodecs rather than seeking per frame (default true; falls back by itself). */
  fast?: boolean;
}

export interface ExportProgress {
  stage: 'preparing' | 'audio' | 'video' | 'finishing';
  /** 0..1 */
  fraction: number;
  frame?: number;
  frames?: number;
}

export interface ExportResult {
  /** The finished file, or null when it was streamed to a sink. */
  blob: Blob | null;
  /** Size of the finished file in bytes. */
  bytes: number;
  streamed: boolean;
  /** How the source pictures were obtained: `fast` from the sequential decoder, `seek` by seeking an element. */
  decode: { fast: number; seek: number };
  videoCodec: string;
  audioCodec: string | null;
  frames: number;
  seconds: number;
  /** 'software' when the hardware encoder stalled or failed and the export was redone. */
  encoder: 'hardware' | 'software';
}

export const SAMPLE_RATE = 48000;
const AUDIO_FRAMES = 1024;

export function defaultExportOptions(project: Project): ExportOptions {
  const pixels = project.width * project.height;
  return {
    width: project.width,
    height: project.height,
    fps: project.fps,
    videoBitrate: Math.round(Math.min(40e6, Math.max(2e6, pixels * project.fps * 0.12))),
    includeAudio: true,
  };
}

/** H.264 profiles to try, best first. Levels sized from the macroblock rate. */
function avcCandidates(width: number, height: number, fps: number): string[] {
  const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
  const level = mbps <= 108000 ? '28' : mbps <= 245760 ? '2a' : mbps <= 589824 ? '33' : '34';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`, 'avc1.640033', 'avc1.42001f'];
}

export async function pickVideoConfig(o: ExportOptions, preference: 'hardware' | 'software' = 'hardware'): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs video encoder. Use a current Edge or Chrome.');
  }
  if (o.width % 2 || o.height % 2) throw new Error('Width and height must be even numbers for H.264');
  const modes = preference === 'software' ? (['prefer-software'] as const) : (['prefer-hardware', 'no-preference'] as const);
  for (const codec of avcCandidates(o.width, o.height, o.fps)) {
    for (const hardwareAcceleration of modes) {
      const config: VideoEncoderConfig = {
        codec,
        width: o.width,
        height: o.height,
        bitrate: o.videoBitrate,
        framerate: o.fps,
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return support.config ?? config;
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new Error(`No H.264 encoder available for ${o.width}x${o.height} at ${o.fps} fps`);
}

export async function pickAudioConfig(aacOnly = false): Promise<{ config: AudioEncoderConfig; codec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const candidates: Array<{ config: AudioEncoderConfig; codec: 'aac' | 'opus' }> = [
    { codec: 'aac', config: { codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192000 } },
    { codec: 'opus', config: { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160000 } },
  ];
  for (const c of candidates) {
    if (aacOnly && c.codec !== 'aac') continue;
    try {
      if ((await AudioEncoder.isConfigSupported(c.config)).supported) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

function audible(project: Project, clip: Clip): boolean {
  const media = findMedia(project, clip.mediaId);
  const track = project.tracks.find((t) => t.id === clip.trackId);
  return !!media && media.kind !== 'image' && media.hasAudio && !track?.muted && !clip.freeze && clip.props.volume > 0;
}

/** Mixes every audible clip into one stereo buffer of `seconds`, starting at timeline time `from`. */
export async function mixAudio(project: Project, blobs: BlobLookup, seconds: number, from = 0): Promise<AudioBuffer | null> {
  const clips = project.clips.filter((c) => audible(project, c));
  if (!clips.length) return null;
  const length = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const decoded = new Map<string, AudioBuffer | null>();
  let any = false;
  for (const clip of clips) {
    if (!decoded.has(clip.mediaId)) {
      const blob = await blobs(clip.mediaId);
      let buffer: AudioBuffer | null = null;
      if (blob) {
        try {
          buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        } catch {
          buffer = null; // a video without an audio track
        }
      }
      decoded.set(clip.mediaId, buffer);
    }
    const buffer = decoded.get(clip.mediaId);
    const win = clipWindow({ start: clip.start, in: clip.in, duration: clip.duration, speed: clipSpeed(clip) }, from, from + seconds);
    if (!buffer || !win) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clip.props.volume;
    source.connect(gain).connect(ctx.destination);
    source.playbackRate.value = clipSpeed(clip);
    source.start(win.when, win.offset, win.duration);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

/** The encoder took input but produced nothing for too long (seen with some hardware H.264 encoders). */
export class EncoderStalled extends Error {
  constructor() {
    super('The video encoder stopped responding');
    this.name = 'EncoderStalled';
  }
}

export const STALL_MS = 10000;

/** Waits until the encoder's queue is at most `max`; rejects if no output arrives for `stallMs`. */
export function waitForQueue(encoder: { encodeQueueSize: number }, max: number, lastOutput: () => number, stallMs = STALL_MS): Promise<void> {
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (encoder.encodeQueueSize <= max) resolve();
      else if (performance.now() - lastOutput() > stallMs) reject(new EncoderStalled());
      else setTimeout(check, 2);
    };
    check();
  });
}

/** encoder.flush(), unless the encoder has gone quiet for `stallMs`. */
function flushOrStall(encoder: { flush(): Promise<void> }, lastOutput: () => number, stallMs = STALL_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const watch = setInterval(() => {
      if (performance.now() - lastOutput() > stallMs) {
        clearInterval(watch);
        reject(new EncoderStalled());
      }
    }, 250);
    encoder.flush().then(
      () => {
        clearInterval(watch);
        resolve();
      },
      (e) => {
        clearInterval(watch);
        reject(e);
      },
    );
  });
}

function abortError(): Error {
  return new DOMException('Export cancelled', 'AbortError');
}

type EncoderPreference = 'hardware' | 'software';

/**
 * Encodes a mixed stereo buffer with the chosen audio encoder and feeds the chunks to the muxer.
 * Shared by the MP4 export and the audio-only M4A export.
 */
export async function encodeMixedAudio(
  mixed: AudioBuffer,
  choice: { config: AudioEncoderConfig; codec: 'aac' | 'opus' },
  muxer: Mp4Muxer,
  signal?: AbortSignal,
): Promise<void> {
  let failure: Error | null = null;
  const fail = (e: unknown) => {
    failure ??= e instanceof Error ? e : new Error(String(e));
  };
  let audioOut = performance.now();
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      audioOut = performance.now();
      const desc = meta?.decoderConfig?.description;
      if (desc) muxer.setAudioDescription(toBytes(desc));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addAudioSample(data, chunk.timestamp, chunk.duration ?? (AUDIO_FRAMES / SAMPLE_RATE) * 1e6);
    },
    error: fail,
  });
  encoder.configure(choice.config);
  const left = mixed.getChannelData(0);
  const right = mixed.getChannelData(1);
  try {
    for (let offset = 0; offset < mixed.length; offset += AUDIO_FRAMES) {
      const n = Math.min(AUDIO_FRAMES, mixed.length - offset);
      const planar = new Float32Array(n * 2);
      planar.set(left.subarray(offset, offset + n), 0);
      planar.set(right.subarray(offset, offset + n), n);
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: n,
        numberOfChannels: 2,
        timestamp: Math.round((offset / SAMPLE_RATE) * 1e6),
        data: planar,
      });
      encoder.encode(data);
      data.close();
      const waitStart = performance.now();
      await waitForQueue(encoder, 32, () => Math.max(audioOut, waitStart));
      if (failure) throw failure;
      if (signal?.aborted) throw abortError();
    }
    const flushStart = performance.now();
    await flushOrStall(encoder, () => Math.max(audioOut, flushStart));
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

/**
 * Exports the timeline. If the hardware video encoder stalls or fails, the export runs again with
 * the software encoder.
 */
export async function exportMp4(
  project: Project,
  blobs: BlobLookup,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<ExportResult> {
  try {
    return await renderMp4(project, blobs, options, onProgress, signal, 'hardware');
  } catch (e) {
    const retry = e instanceof EncoderStalled || (e as { videoEncoder?: boolean }).videoEncoder;
    if (!retry || signal?.aborted) throw e;
    return renderMp4(project, blobs, options, onProgress, signal, 'software');
  }
}

/** Largest amount of encoded data allowed to wait for the disk before the export slows down. */
const SINK_BACKLOG = 8 * 1024 * 1024;

async function renderMp4(
  project: Project,
  blobs: BlobLookup,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal | undefined,
  preference: EncoderPreference,
): Promise<ExportResult> {
  const span = exportSpan(projectDuration(project), options.range);
  if (!span) throw new Error(options.range ? 'The in and out marks cover nothing on the timeline' : 'The timeline is empty');
  const seconds = span.end - span.start;
  onProgress({ stage: 'preparing', fraction: 0 });
  const videoConfig = await pickVideoConfig(options, preference);
  const audioChoice = options.includeAudio ? await pickAudioConfig() : null;

  // ---- audio ---------------------------------------------------------------------------
  let mixed: AudioBuffer | null = null;
  if (audioChoice) {
    onProgress({ stage: 'audio', fraction: 0.02 });
    mixed = await mixAudio(project, blobs, seconds, span.start);
  }
  if (signal?.aborted) throw abortError();

  const audioConfig: AudioTrackConfig | null =
    mixed && audioChoice ? { codec: audioChoice.codec, sampleRate: SAMPLE_RATE, channels: 2 } : null;
  // Streaming export: the muxer writes to the sink as samples arrive and puts moov at the end.
  const sink = options.openSink ? await options.openSink() : undefined;
  const muxer = new Mp4Muxer(
    { codec: 'avc', width: options.width, height: options.height, description: new Uint8Array() },
    audioConfig,
    { sink },
  );

  let failure: Error | null = null;
  const fail = (e: unknown) => {
    failure ??= e instanceof Error ? e : new Error(String(e));
  };

  const frames = Math.max(1, Math.round(seconds * options.fps));
  const keyEvery = Math.max(1, Math.round(options.fps * 2));
  let renderer: FrameRenderer | null = null;
  let encoder: VideoEncoder | null = null;
  try {
    if (mixed && audioChoice) await encodeMixedAudio(mixed, audioChoice, muxer, signal);
    muxer.endTrack('audio');
    if (signal?.aborted) throw abortError();

    // ---- video -------------------------------------------------------------------------
    renderer = await createFrameRenderer(project, blobs, { width: options.width, height: options.height, captions: options.captions, fast: options.fast });
    let videoOut = performance.now();
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        videoOut = performance.now();
        const desc = meta?.decoderConfig?.description;
        if (desc) muxer.setVideoDescription(toBytes(desc));
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addVideoSample(data, chunk.timestamp, chunk.duration ?? 1e6 / options.fps, chunk.type === 'key');
      },
      // Marked so exportMp4 can retry in software.
      error: (e) => fail(Object.assign(e instanceof Error ? e : new Error(String(e)), { videoEncoder: true })),
    });
    encoder.configure(videoConfig);

    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      await renderer.render(span.start + f / options.fps);
      const frame = new VideoFrame(renderer.canvas, {
        timestamp: Math.round((f * 1e6) / options.fps),
        duration: Math.round(1e6 / options.fps),
      });
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      // Seeking can take a while on its own, so the stall clock starts when the wait does.
      const waitStart = performance.now();
      await waitForQueue(encoder, 8, () => Math.max(videoOut, waitStart));
      if (sink) await muxer.drain(SINK_BACKLOG);
      if (f % 5 === 0 || f === frames - 1) {
        onProgress({ stage: 'video', fraction: 0.05 + 0.9 * ((f + 1) / frames), frame: f + 1, frames });
      }
    }
    const flushStart = performance.now();
    await flushOrStall(encoder, () => Math.max(videoOut, flushStart));
    if (failure) throw failure;
    onProgress({ stage: 'finishing', fraction: 0.97 });
    let blob: Blob | null = null;
    let bytes: number;
    if (sink) {
      bytes = await muxer.finalizeStream();
    } else {
      blob = muxer.finalize();
      bytes = blob.size;
    }
    onProgress({ stage: 'finishing', fraction: 1 });
    return {
      blob,
      bytes,
      streamed: !!sink,
      decode: { ...renderer.stats },
      videoCodec: videoConfig.codec,
      audioCodec: audioConfig ? audioConfig.codec : null,
      frames,
      seconds,
      encoder: preference,
    };
  } catch (e) {
    if (sink) await muxer.abort().catch(() => undefined);
    throw e;
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    renderer?.close();
  }
}

export function toBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const view = source as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}
