// Ducking: a level envelope of the narration and an envelope follower that turns it into a gain for the music.

export interface DuckOptions {
  /** Narration counts as speaking above this level, dBFS. */
  thresholdDb: number;
  /** How far the other audio is pulled down while speaking, dB (positive). */
  reductionDb: number;
  /** Seconds the gain takes to fall (about 63 %) once speech starts. */
  attack: number;
  /** Seconds the gain takes to come back once speech stops. */
  release: number;
  /** Seconds the gain stays down across short pauses between words. Default 0.2. */
  hold?: number;
}

export const DEFAULT_DUCK: DuckOptions = { thresholdDb: -40, reductionDb: 12, attack: 0.05, release: 0.5, hold: 0.2 };

/** Level of a signal (all channels averaged by power) in dBFS, one value per 1/rate seconds. */
export function levelEnvelopeDb(channels: Float32Array[], sampleRate: number, rate = 100): Float32Array {
  if (!channels.length) return new Float32Array(0);
  const len = channels[0].length;
  const per = sampleRate / rate;
  const count = Math.max(1, Math.ceil(len / per));
  const out = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(len, Math.floor((b + 1) * per));
    let sum = 0;
    for (const ch of channels) for (let i = from; i < to; i++) sum += ch[i] * ch[i];
    const n = (to - from) * channels.length;
    out[b] = n > 0 ? Math.max(-120, 10 * Math.log10(sum / n + 1e-12)) : -120;
  }
  return out;
}

/** Follows the level envelope and returns the linear gain (1 = untouched, down to the reduction) per envelope step. */
export function duckEnvelope(levelDb: ArrayLike<number>, rate: number, o: DuckOptions): Float32Array {
  const out = new Float32Array(levelDb.length);
  const attack = Math.exp(-1 / (Math.max(0.001, o.attack) * rate));
  const release = Math.exp(-1 / (Math.max(0.001, o.release) * rate));
  const hold = Math.round((o.hold ?? 0.2) * rate);
  const reduction = -Math.abs(o.reductionDb);
  let db = 0;
  let sinceSpeech = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levelDb.length; i++) {
    if (levelDb[i] > o.thresholdDb) sinceSpeech = 0;
    else sinceSpeech++;
    const target = sinceSpeech <= hold ? reduction : 0;
    const a = target < db ? attack : release;
    db = a * db + (1 - a) * target;
    out[i] = 10 ** (db / 20);
  }
  return out;
}
