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

export async function probeMedia(file: Blob & { name?: string }, nameOverride?: string): Promise<MediaItem> {
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
    const duration = await resolveDuration(el);
    if (!duration) throw new Error(`${name}: could not read the media duration`);
    if (kind === 'audio') {
      return { ...base, duration, width: 0, height: 0, hasAudio: true };
    }
    const video = el as HTMLVideoElement;
    await seekTo(video, Math.min(1, duration / 3));
    return {
      ...base,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: true,
      thumb: thumbFrom(video, video.videoWidth, video.videoHeight),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
