// Renders single frames of a project for export: the same compositor as the preview, with every
// video clip seeked to the exact source time. Shared by the MP4, GIF and PNG exports.
import { drawFrame } from './compositor';
import type { VideoTrackInfo } from './demux/types';
import { FastVideoSource, demuxVideo } from './fastdecode';
import { seekTo } from './media';
import { resizeCanvas } from './ops';
import { type Clip, type Project, activeClipsAt, findMedia, sourceTimeAt } from './project';

export type BlobLookup = (mediaId: string) => Promise<Blob | null>;

export interface FrameRenderer {
  /** The canvas every frame is drawn on (reused; copy out what you need before the next render). */
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  /** Video pictures taken from the sequential decoder (fast) and by seeking an element (seek). */
  readonly stats: { fast: number; seek: number };
  /** Draws the timeline at `time` seconds, seeking each active video to its exact frame. */
  render(time: number): Promise<void>;
  /** RGBA pixels of the frame just rendered (a copy). */
  pixels(): Uint8ClampedArray;
  /** Releases the video elements, object URLs and bitmaps. */
  close(): void;
}

export interface FrameRendererOptions {
  width: number;
  height: number;
  /** Burn the captions into the picture (default true). */
  captions?: boolean;
  /** Fill the canvas with an opaque background (default true, as MP4 and GIF have no alpha). */
  alpha?: boolean;
  /** The caller will read pixels back every frame (GIF): keeps the canvas in CPU memory. */
  readback?: boolean;
  /**
   * Decode video with WebCodecs, in order, instead of seeking an element to every frame
   * (default true). A clip the fast path cannot handle, or that fails midway, seeks as before.
   */
  fast?: boolean;
}

export async function createFrameRenderer(project: Project, blobs: BlobLookup, options: FrameRendererOptions): Promise<FrameRenderer> {
  const canvas = new OffscreenCanvas(options.width, options.height);
  const ctx = canvas.getContext('2d', { alpha: options.alpha === true, willReadFrequently: options.readback === true });
  if (!ctx) throw new Error('OffscreenCanvas 2D is not available');
  // Clip positions and blur regions follow the output size.
  const scaled: Project = resizeCanvas(project, options.width, options.height);

  const urlFor = new Map<string, string>();
  const videos = new Map<string, HTMLVideoElement>();
  const bitmaps = new Map<string, ImageBitmap>();
  const stats = { fast: 0, seek: 0 };
  const fastOn = options.fast !== false;
  const fastInfo = new Map<string, Promise<VideoTrackInfo | null>>();
  const fastSource = new Map<string, FastVideoSource>();
  /** Clips the fast path cannot do (unsupported file, or it failed midway): they seek. */
  const fastUnavailable = new Set<string>();
  const fastBitmap = new Map<string, ImageBitmap>();
  const fastFor = async (clip: Clip): Promise<FastVideoSource | null> => {
    if (!fastOn || fastUnavailable.has(clip.id)) return null;
    const open = fastSource.get(clip.id);
    if (open) return open;
    const blob = await blobs(clip.mediaId);
    let info = fastInfo.get(clip.mediaId);
    if (!info) {
      info = blob ? demuxVideo(blob) : Promise.resolve(null);
      fastInfo.set(clip.mediaId, info);
    }
    const source = blob ? await FastVideoSource.open(blob, await info) : null;
    if (source) fastSource.set(clip.id, source);
    else fastUnavailable.add(clip.id);
    return source;
  };
  const close = () => {
    for (const s of fastSource.values()) s.close();
    fastSource.clear();
    fastBitmap.clear();
    for (const el of videos.values()) {
      el.removeAttribute('src');
      el.load();
    }
    videos.clear();
    for (const url of urlFor.values()) URL.revokeObjectURL(url);
    urlFor.clear();
    for (const b of bitmaps.values()) b.close();
    bitmaps.clear();
  };
  try {
    for (const media of project.media) {
      if (media.kind === 'audio' || !project.clips.some((c) => c.mediaId === media.id)) continue;
      const blob = await blobs(media.id);
      if (!blob) throw new Error(`Media missing from storage: ${media.name}`);
      if (media.kind === 'image') bitmaps.set(media.id, await createImageBitmap(blob));
      else urlFor.set(media.id, URL.createObjectURL(blob));
    }
  } catch (e) {
    close();
    throw e;
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

  return {
    canvas,
    width: options.width,
    height: options.height,
    stats,
    async render(t: number): Promise<void> {
      const active = activeClipsAt(scaled, t);
      for (const clip of active) {
        const media = findMedia(scaled, clip.mediaId);
        if (media?.kind !== 'video') continue;
        // A hair past the frame time so float error never lands on the previous frame.
        const at = Math.min(media.duration, sourceTimeAt(clip, t) + 1e-3);
        const fast = await fastFor(clip);
        if (fast) {
          try {
            fastBitmap.set(clip.id, await fast.frameAt(at));
            stats.fast++;
            continue;
          } catch {
            // The decoder failed midway: this clip seeks from here on.
            fast.close();
            fastSource.delete(clip.id);
            fastUnavailable.add(clip.id);
            fastBitmap.delete(clip.id);
          }
        }
        const el = await elementFor(clip);
        if (el) {
          await seekTo(el, at);
          stats.seek++;
        }
      }
      // Fast sources of clips that have ended are released, so decoders do not pile up.
      for (const [id, source] of [...fastSource]) {
        if (!active.some((c) => c.id === id)) {
          source.close();
          fastSource.delete(id);
          fastBitmap.delete(id);
        }
      }
      drawFrame(
        ctx,
        scaled,
        t,
        (clip) => {
          const media = findMedia(scaled, clip.mediaId);
          if (media?.kind === 'image') return bitmaps.get(media.id) ?? null;
          return fastBitmap.get(clip.id) ?? videos.get(clip.id) ?? null;
        },
        { captions: options.captions !== false },
      );
    },
    pixels: () => ctx.getImageData(0, 0, options.width, options.height).data,
    close,
  };
}
