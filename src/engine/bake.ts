// "Bake" a clip's sound through the DSP: decode the media, run noise removal or levelling over all of it, and
// return a WAV. The editor adds that WAV to the bin and swaps the clip to it (applyProcessedAudio), which is
// undoable. The original media is never touched.
import { levelAudio } from './dsp/level';
import { reduceNoise } from './dsp/noise';
import { encodeWav } from './dsp/wav';
import { decodeBlob } from './peaks';

export type BakeKind = 'noise' | 'level';

export interface BakeParams {
  /** Noise removal strength 0..1. */
  strength?: number;
  /** A stretch of the source (seconds) that holds only noise; default is the quietest part. */
  profile?: { start: number; end: number };
  /** Levelling: target loudness dBFS and compression amount 0..1. */
  targetDb?: number;
  amount?: number;
}

export interface BakeResult {
  wav: Uint8Array;
  sampleRate: number;
  seconds: number;
  /** One line for the status bar. */
  summary: string;
}

const fmt = (db: number) => (Number.isFinite(db) ? `${db.toFixed(1)} dB` : 'silence');

/** The processing itself, on planar float audio. */
export async function processChannels(
  channels: Float32Array[],
  sampleRate: number,
  kind: BakeKind,
  params: BakeParams = {},
  yieldToUi?: () => Promise<void>,
): Promise<{ channels: Float32Array[]; summary: string }> {
  if (kind === 'noise') {
    const out: Float32Array[] = [];
    for (const ch of channels) out.push(await reduceNoise(ch, sampleRate, { strength: params.strength, profile: params.profile, yieldToUi }));
    return { channels: out, summary: 'Noise removed' };
  }
  const r = levelAudio(channels, sampleRate, { targetDb: params.targetDb, amount: params.amount });
  return { channels: r.channels, summary: `Levelled from ${fmt(r.beforeDb)} to ${fmt(r.afterDb)}` };
}

/** Decodes `blob`, processes it and encodes 16-bit WAV. Throws when the media has no decodable audio. */
export async function bakeBlob(blob: Blob, kind: BakeKind, params: BakeParams = {}): Promise<BakeResult> {
  const buffer = await decodeBlob(blob);
  if (!buffer) throw new Error('This media has no audio the browser can decode');
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
  const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const done = await processChannels(channels, buffer.sampleRate, kind, params, yieldToUi);
  return { wav: encodeWav(done.channels, buffer.sampleRate, 16), sampleRate: buffer.sampleRate, seconds: buffer.duration, summary: done.summary };
}
