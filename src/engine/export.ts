// Offline MP4 export. Frames are rendered one by one with the same compositor as the preview
// (each video seeked to the exact frame time), encoded with WebCodecs H.264, and the audio is
// mixed with an OfflineAudioContext and encoded as AAC (or Opus where AAC is unavailable).
import { drawFrame } from './compositor';
import { seekTo } from './media';
import { type AudioTrackConfig, Mp4Muxer } from './mp4/muxer';
import { type Clip, type Project, activeClipsAt, findMedia, projectDuration } from './project';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** Video bits per second. */
  videoBitrate: number;
  includeAudio: boolean;
}

export interface ExportProgress {
  stage: 'preparing' | 'audio' | 'video' | 'finishing';
  /** 0..1 */
  fraction: number;
  frame?: number;
  frames?: number;
}

export interface ExportResult {
  blob: Blob;
  videoCodec: string;
  audioCodec: string | null;
  frames: number;
  seconds: number;
}

export type BlobLookup = (mediaId: string) => Promise<Blob | null>;

const SAMPLE_RATE = 48000;
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

export async function pickVideoConfig(o: ExportOptions): Promise<VideoEncoderConfig> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no WebCodecs video encoder. Use a current Edge or Chrome.');
  }
  if (o.width % 2 || o.height % 2) throw new Error('Width and height must be even numbers for H.264');
  for (const codec of avcCandidates(o.width, o.height, o.fps)) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
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

export async function pickAudioConfig(): Promise<{ config: AudioEncoderConfig; codec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const candidates: Array<{ config: AudioEncoderConfig; codec: 'aac' | 'opus' }> = [
    { codec: 'aac', config: { codec: 'mp4a.40.2', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192000 } },
    { codec: 'opus', config: { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 160000 } },
  ];
  for (const c of candidates) {
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
  return !!media && media.kind !== 'image' && media.hasAudio && !track?.muted && clip.props.volume > 0;
}

/** Mixes every audible clip into one stereo buffer covering the whole timeline. */
export async function mixAudio(project: Project, blobs: BlobLookup, seconds: number): Promise<AudioBuffer | null> {
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
    if (!buffer) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = clip.props.volume;
    source.connect(gain).connect(ctx.destination);
    source.start(clip.start, clip.in, clip.duration);
    any = true;
  }
  if (!any) return null;
  return ctx.startRendering();
}

function waitForQueue(encoder: { encodeQueueSize: number }, max: number): Promise<void> {
  if (encoder.encodeQueueSize <= max) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => (encoder.encodeQueueSize <= max ? resolve() : setTimeout(check, 2));
    check();
  });
}

function abortError(): Error {
  return new DOMException('Export cancelled', 'AbortError');
}

export async function exportMp4(
  project: Project,
  blobs: BlobLookup,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const seconds = projectDuration(project);
  if (seconds <= 0) throw new Error('The timeline is empty');
  onProgress({ stage: 'preparing', fraction: 0 });
  const videoConfig = await pickVideoConfig(options);
  const audioChoice = options.includeAudio ? await pickAudioConfig() : null;

  // ---- audio ---------------------------------------------------------------------------
  let mixed: AudioBuffer | null = null;
  if (audioChoice) {
    onProgress({ stage: 'audio', fraction: 0.02 });
    mixed = await mixAudio(project, blobs, seconds);
  }
  if (signal?.aborted) throw abortError();

  const audioConfig: AudioTrackConfig | null =
    mixed && audioChoice ? { codec: audioChoice.codec, sampleRate: SAMPLE_RATE, channels: 2 } : null;
  const muxer = new Mp4Muxer(
    { codec: 'avc', width: options.width, height: options.height, description: new Uint8Array() },
    audioConfig,
  );

  let failure: Error | null = null;
  const fail = (e: unknown) => {
    failure ??= e instanceof Error ? e : new Error(String(e));
  };

  if (mixed && audioChoice) {
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc) muxer.setAudioDescription(toBytes(desc));
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addAudioSample(data, chunk.timestamp, chunk.duration ?? (AUDIO_FRAMES / SAMPLE_RATE) * 1e6);
      },
      error: fail,
    });
    encoder.configure(audioChoice.config);
    const left = mixed.getChannelData(0);
    const right = mixed.getChannelData(1);
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
      await waitForQueue(encoder, 32);
      if (failure) throw failure;
      if (signal?.aborted) {
        encoder.close();
        throw abortError();
      }
    }
    await encoder.flush();
    encoder.close();
  }
  if (failure) throw failure;

  // ---- video ---------------------------------------------------------------------------
  const canvas = new OffscreenCanvas(options.width, options.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
  const scale = { x: options.width / project.width, y: options.height / project.height };
  const scaled: Project = {
    ...project,
    width: options.width,
    height: options.height,
    clips: project.clips.map((c) => ({
      ...c,
      props: { ...c.props, x: c.props.x * scale.x, y: c.props.y * scale.y },
    })),
  };

  const urlFor = new Map<string, string>();
  const videos = new Map<string, HTMLVideoElement>();
  const bitmaps = new Map<string, ImageBitmap>();
  for (const media of project.media) {
    if (media.kind === 'audio' || !project.clips.some((c) => c.mediaId === media.id)) continue;
    const blob = await blobs(media.id);
    if (!blob) throw new Error(`Media missing from storage: ${media.name}`);
    if (media.kind === 'image') bitmaps.set(media.id, await createImageBitmap(blob));
    else urlFor.set(media.id, URL.createObjectURL(blob));
  }
  // One element per video clip, so cuts between two parts of a file never fight over a seek.
  const elementFor = async (clip: Clip): Promise<HTMLVideoElement | null> => {
    let el = videos.get(clip.id);
    if (!el) {
      const url = urlFor.get(clip.mediaId);
      if (!url) return null;
      el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      const ready = new Promise<void>((resolve, reject) => {
        el!.addEventListener('loadeddata', () => resolve(), { once: true });
        el!.addEventListener('error', () => reject(new Error('A video could not be decoded')), { once: true });
      });
      el.src = url;
      await ready;
      videos.set(clip.id, el);
    }
    return el;
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc) muxer.setVideoDescription(toBytes(desc));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      muxer.addVideoSample(data, chunk.timestamp, chunk.duration ?? 1e6 / options.fps, chunk.type === 'key');
    },
    error: fail,
  });
  encoder.configure(videoConfig);

  const frames = Math.max(1, Math.round(seconds * options.fps));
  const keyEvery = Math.max(1, Math.round(options.fps * 2));
  try {
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw abortError();
      if (failure) throw failure;
      const t = f / options.fps;
      const active = activeClipsAt(scaled, t);
      for (const clip of active) {
        const media = findMedia(scaled, clip.mediaId);
        if (media?.kind !== 'video') continue;
        const el = await elementFor(clip);
        // A hair past the frame time so float error never lands on the previous frame.
        if (el) await seekTo(el, Math.min(media.duration, clip.in + (t - clip.start) + 1e-3));
      }
      drawFrame(ctx, scaled, t, (clip) => {
        const media = findMedia(scaled, clip.mediaId);
        if (media?.kind === 'image') return bitmaps.get(media.id) ?? null;
        return videos.get(clip.id) ?? null;
      });
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((f * 1e6) / options.fps),
        duration: Math.round(1e6 / options.fps),
      });
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      await waitForQueue(encoder, 8);
      if (f % 5 === 0 || f === frames - 1) {
        onProgress({ stage: 'video', fraction: 0.05 + 0.9 * ((f + 1) / frames), frame: f + 1, frames });
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    onProgress({ stage: 'finishing', fraction: 0.97 });
    const blob = muxer.finalize();
    onProgress({ stage: 'finishing', fraction: 1 });
    return {
      blob,
      videoCodec: videoConfig.codec,
      audioCodec: audioConfig ? audioConfig.codec : null,
      frames,
      seconds,
    };
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    for (const el of videos.values()) {
      el.removeAttribute('src');
      el.load();
    }
    for (const url of urlFor.values()) URL.revokeObjectURL(url);
    for (const b of bitmaps.values()) b.close();
  }
}

function toBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const view = source as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}
