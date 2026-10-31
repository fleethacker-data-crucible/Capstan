// Waveform peaks: decoded once per media item (main thread, async, cached), reduced to min / max per 10 ms plus
// a level envelope that ducking uses. The numeric part (computePeaks) is pure and unit-tested.
import { levelEnvelopeDb } from './dsp/duck';
import { setLevelEnvelope } from './gain';

export const PEAK_RATE = 100;

export interface Peaks {
  /** Seconds of source audio covered. */
  duration: number;
  /** Bins per second. */
  rate: number;
  min: Float32Array;
  max: Float32Array;
  /** Level of each bin in dBFS. */
  levelDb: Float32Array;
}

/** Reduces planar audio to min / max / level per 1/rate seconds. */
export function computePeaks(channels: Float32Array[], sampleRate: number, rate = PEAK_RATE): Peaks {
  const len = channels.length ? channels[0].length : 0;
  const per = sampleRate / rate;
  const count = Math.max(1, Math.ceil(len / per));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.min(len, Math.floor((b + 1) * per)));
    let lo = 0;
    let hi = 0;
    for (const ch of channels) {
      for (let i = from; i < to && i < len; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { duration: len / sampleRate, rate, min, max, levelDb: levelEnvelopeDb(channels, sampleRate, rate) };
}

/** Largest |sample| in the source-time window [from, to) seconds, as [min, max]. */
export function peakWindow(p: Peaks, from: number, to: number): [number, number] {
  const a = Math.max(0, Math.floor(from * p.rate));
  const b = Math.min(p.min.length, Math.max(a + 1, Math.ceil(to * p.rate)));
  let lo = 0;
  let hi = 0;
  for (let i = a; i < b; i++) {
    if (p.min[i] < lo) lo = p.min[i];
    if (p.max[i] > hi) hi = p.max[i];
  }
  return [lo, hi];
}

/** Decodes a blob's audio, or null when it has none (a video without sound) or cannot be decoded. */
export async function decodeBlob(blob: Blob, sampleRate = 48000): Promise<AudioBuffer | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate);
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Longest media decoded for a waveform: decoding holds the whole file as floats. */
const MAX_PEAK_SECONDS = 2 * 3600;

const cache = new Map<string, Promise<Peaks | null>>();

/** Peaks for a media item, decoded on first use and cached by id (media bytes never change under an id). */
export function getPeaks(mediaId: string, duration: number, load: () => Promise<Blob | null>): Promise<Peaks | null> {
  const hit = cache.get(mediaId);
  if (hit) return hit;
  const job = (async () => {
    if (duration > MAX_PEAK_SECONDS) return null;
    const blob = await load();
    if (!blob) {
      cache.delete(mediaId); // not loaded yet: try again next time
      return null;
    }
    const buffer = await decodeBlob(blob);
    if (!buffer) return null;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const peaks = computePeaks(channels, buffer.sampleRate);
    setLevelEnvelope(mediaId, { rate: peaks.rate, db: peaks.levelDb });
    return peaks;
  })().catch(() => null);
  cache.set(mediaId, job);
  return job;
}

export function forgetPeaks(mediaId: string): void {
  cache.delete(mediaId);
}
