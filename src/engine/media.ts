// Media import: works out kind, duration and size of a file and makes a bin thumbnail.
import { type MediaItem, type MediaKind, newId } from './project';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

export function detectKind(file: { name: string; type: string }): MediaKind | null {
  const t = file.type.toLowerCase();
  if (t.startsWith('video/') || (!t && VIDEO_EXT.test(file.name))) return 'video';
  if (t.startsWith('audio/') || (!t && AUDIO_EXT.test(file.name))) return 'audio';
  if (t.startsWith('image/') || (!t && IMAGE_EXT.test(file.name))) return 'image';
  if (VIDEO_EXT.test(file.name)) return 'video';
  if (AUDIO_EXT.test(file.name)) return 'audio';
  if (IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

function once(target: EventTarget, ok: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${ok}`));
    }, timeoutMs);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('This file could not be decoded by the browser'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onError);
  });
}

/** Seeks a media element and waits until the frame at `time` is ready. */
export async function seekTo(el: HTMLMediaElement, time: number): Promise<void> {
  if (Math.abs(el.currentTime - time) < 1e-4 && el.readyState >= 2) return;
  const done = once(el, 'seeked');
  el.currentTime = time;
  await done;
}

/**
 * Recorder WebM files carry no duration; Chromium reports Infinity until playback reaches the
 * end. Seeking far past the end makes it compute the real value.
 */
async function resolveDuration(el: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  const changed = once(el, 'durationchange', 10000).catch(() => undefined);
  el.currentTime = 1e101;
  await changed;
  const d = el.duration;
  el.currentTime = 0;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function thumbFrom(source: CanvasImageSource, w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 160, 90);
  if (w > 0 && h > 0) {
    const k = Math.min(160 / w, 90 / h);
    ctx.drawImage(source, (160 - w * k) / 2, (90 - h * k) / 2, w * k, h * k);
  }
  return canvas.toDataURL('image/jpeg', 0.7);
}

/**
 * The duration to trust, from the element's header value and what the caller knows (a recorder's own
 * count). The known value wins when the header is missing or clearly shorter: Firefox can read a duration
 * from only the first part of a long recording written to disk in pieces (a 20-minute take came in as
 * 0.4 s). 0 means neither is usable and the caller has to probe.
 */
export function pickDuration(header: number, known: number): number {
  const h = Number.isFinite(header) && header > 0 ? header : 0;
  const k = Number.isFinite(known) && known > 0 ? known : 0;
  if (k && (!h || h < k * 0.95)) return k;
  return h;
}

/** What the caller already knows about a file (a fresh recording knows all three). */
export interface MediaHints {
  duration?: number;
  width?: number;
  height?: number;
}

export async function probeMedia(file: Blob & { name?: string }, nameOverride?: string, hints: MediaHints = {}): Promise<MediaItem> {
  const name = nameOverride ?? file.name ?? 'Media';
  const kind = detectKind({ name, type: file.type });
  if (!kind) throw new Error(`${name}: unsupported file type`);
  const base = { id: newId('med'), name, kind, mime: file.type, bytes: file.size, createdAt: Date.now() };
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file);
      const item: MediaItem = {
        ...base,
        duration: 0,
        width: bitmap.width,
        height: bitmap.height,
        hasAudio: false,
        thumb: thumbFrom(bitmap, bitmap.width, bitmap.height),
      };
      bitmap.close();
      return item;
    }
    const el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    el.muted = true;
    const loaded = once(el, 'loadedmetadata');
    el.src = url;
    await loaded;
    // A known duration skips the seek-past-the-end probe: browsers suspend decoding of muted
    // video in a hidden window, so that probe can stall after a recording stopped in the background.
    const known = hints.duration && hints.duration > 0 ? hints.duration : 0;
    const duration = pickDuration(el.duration, known) || (await resolveDuration(el));
    if (!duration) throw new Error(`${name}: could not read the media duration`);
    if (kind === 'audio') {
      return { ...base, duration, width: 0, height: 0, hasAudio: true };
    }
    const video = el as HTMLVideoElement;
    const width = video.videoWidth || hints.width || 0;
    const height = video.videoHeight || hints.height || 0;
    // The thumbnail is optional: without it the bin shows the media-type icon.
    let thumb: string | undefined;
    try {
      const seek = seekTo(video, Math.min(1, duration / 3));
      seek.catch(() => undefined);
      await Promise.race([seek, new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail timeout')), 4000))]);
      thumb = thumbFrom(video, width, height);
    } catch {
      thumb = undefined;
    }
    return { ...base, duration, width, height, hasAudio: true, thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}
