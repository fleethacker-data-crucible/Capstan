// Volume levelling: measure the loudness of a clip, squeeze its dynamics gently, bring it to a target level and
// keep the peaks under a ceiling with a short look-ahead limiter.
//
// Loudness here is gated RMS in dBFS: 400 ms blocks (100 ms hop), blocks below -70 dBFS dropped, then blocks
// more than 10 dB under the average of the rest dropped (the BS.1770 gating scheme, without the K-weighting
// filter). It is a practical stand-in for LUFS, not a calibrated meter.

export interface LevelOptions {
  /** Loudness to reach, dBFS (gated RMS). Default -18. */
  targetDb?: number;
  /** 0..1: how much the compressor squeezes the dynamics. 0 = none, 1 = ratio 4:1. Default 0.5. */
  amount?: number;
  /** Peak ceiling, dBFS. Default -1. */
  ceilingDb?: number;
}

export interface LevelResult {
  channels: Float32Array[];
  beforeDb: number;
  afterDb: number;
  makeupDb: number;
  /** Deepest gain reduction applied by the compressor and limiter together, dB (positive). */
  maxReductionDb: number;
}

const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
const toLin = (db: number) => 10 ** (db / 20);

/** Gated RMS loudness of the channels together, dBFS. -Infinity when the audio is silent. */
export function loudnessDb(channels: Float32Array[], sampleRate: number): number {
  if (!channels.length || !channels[0].length) return Number.NEGATIVE_INFINITY;
  const len = channels[0].length;
  const block = Math.max(1, Math.round(sampleRate * 0.4));
  const hop = Math.max(1, Math.round(sampleRate * 0.1));
  const powers: number[] = [];
  for (let s = 0; s === 0 || s + block <= len; s += hop) {
    const end = Math.min(len, s + block);
    let sum = 0;
    for (const ch of channels) for (let i = s; i < end; i++) sum += ch[i] * ch[i];
    powers.push(sum / ((end - s) * channels.length));
  }
  const abs = 10 ** (-70 / 10);
  const loud = powers.filter((p) => p > abs);
  if (!loud.length) return Number.NEGATIVE_INFINITY;
  const mean = loud.reduce((a, b) => a + b, 0) / loud.length;
  const rel = mean * 0.1;
  const kept = loud.filter((p) => p >= rel);
  const gated = kept.reduce((a, b) => a + b, 0) / kept.length;
  return 10 * Math.log10(gated);
}

/** Highest absolute sample of any channel, dBFS. */
export function peakDb(channels: Float32Array[]): number {
  let m = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) m = Math.max(m, Math.abs(ch[i]));
  return m > 0 ? toDb(m) : Number.NEGATIVE_INFINITY;
}

/** Feed-forward compressor with a soft knee and a linked peak detector. Returns the gain per sample (linear). */
export function compressorGain(channels: Float32Array[], sampleRate: number, thresholdDb: number, ratio: number): Float32Array {
  const len = channels[0].length;
  const gain = new Float32Array(len);
  const attack = Math.exp(-1 / (0.01 * sampleRate));
  const release = Math.exp(-1 / (0.15 * sampleRate));
  const knee = 6;
  let env = 0;
  for (let i = 0; i < len; i++) {
    let a = 0;
    for (const ch of channels) a = Math.max(a, Math.abs(ch[i]));
    env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a;
    const level = toDb(env);
    const over = level - thresholdDb;
    let reduction = 0;
    if (over > knee / 2) reduction = (over * (1 - 1 / ratio));
    else if (over > -knee / 2) reduction = ((1 - 1 / ratio) * (over + knee / 2) ** 2) / (2 * knee);
    gain[i] = toLin(-reduction);
  }
  return gain;
}

/** Look-ahead peak limiter. Returns per-sample gain (<= 1) that keeps |x * gain| at or under `ceiling`. */
export function limiterGain(channels: Float32Array[], sampleRate: number, ceiling: number, gainIn?: Float32Array, pre = 1): Float32Array {
  const len = channels[0].length;
  const look = Math.max(2, Math.round(sampleRate * 0.005));
  const need = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let a = 0;
    for (const ch of channels) a = Math.max(a, Math.abs(ch[i]));
    a *= pre * (gainIn ? gainIn[i] : 1);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  // Sliding minimum over [i - look, i + look], then a moving average of 2 * look + 1 samples: the result never
  // exceeds `need` at any sample and ramps smoothly into and out of each peak.
  const min = new Float32Array(len);
  const deque = new Int32Array(len);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < len + look; i++) {
    if (i < len) {
      while (tail > head && need[deque[tail - 1]] >= need[i]) tail--;
      deque[tail++] = i;
    }
    const centre = i - look;
    if (centre >= 0) {
      while (deque[head] < centre - look) head++;
      min[centre] = need[deque[head]];
    }
  }
  const out = new Float32Array(len);
  const width = 2 * look + 1;
  const at = (j: number) => (j < 0 || j >= len ? 1 : min[j]);
  let sum = 0;
  for (let j = -look; j <= look; j++) sum += at(j);
  for (let i = 0; i < len; i++) {
    out[i] = Math.min(1, sum / width);
    sum += at(i + look + 1) - at(i - look);
  }
  return out;
}

/** Levels the audio: gentle compression, makeup gain to `targetDb`, then the limiter. Silence is returned unchanged. */
export function levelAudio(input: Float32Array[], sampleRate: number, opts: LevelOptions = {}): LevelResult {
  const target = opts.targetDb ?? -18;
  const amount = Math.min(1, Math.max(0, opts.amount ?? 0.5));
  const ceiling = toLin(opts.ceilingDb ?? -1);
  const before = loudnessDb(input, sampleRate);
  if (!Number.isFinite(before)) {
    return { channels: input.map((c) => c.slice()), beforeDb: before, afterDb: before, makeupDb: 0, maxReductionDb: 0 };
  }
  const len = input[0].length;
  let comp: Float32Array | null = null;
  if (amount > 0) {
    // The threshold sits just above the clip's own average level, so quiet and loud clips are treated alike.
    comp = compressorGain(input, sampleRate, before + 3 - 6 * amount, 1 + 3 * amount);
  }
  const compressed = comp ? input.map((c) => c.map((x, i) => x * comp![i])) : input;
  const afterComp = loudnessDb(compressed, sampleRate);
  let makeup = Math.max(-40, Math.min(40, target - afterComp));
  // The limiter eats a little loudness when peaks hit the ceiling, so measure and correct once or twice.
  let limit: Float32Array = limiterGain(compressed, sampleRate, ceiling, undefined, toLin(makeup));
  for (let pass = 0; pass < 2; pass++) {
    const trial = compressed.map((c) => c.map((x, i) => x * toLin(makeup) * limit[i]));
    const got = loudnessDb(trial, sampleRate);
    if (!Number.isFinite(got) || Math.abs(got - target) < 0.2) break;
    makeup = Math.max(-40, Math.min(40, makeup + (target - got)));
    limit = limiterGain(compressed, sampleRate, ceiling, undefined, toLin(makeup));
  }
  const g = toLin(makeup);
  let worst = 1;
  const channels = compressed.map((c) =>
    c.map((x, i) => {
      const y = x * g * limit[i];
      return y > ceiling ? ceiling : y < -ceiling ? -ceiling : y;
    }),
  );
  for (let i = 0; i < len; i++) worst = Math.min(worst, (comp ? comp[i] : 1) * limit[i]);
  return { channels, beforeDb: before, afterDb: loudnessDb(channels, sampleRate), makeupDb: makeup, maxReductionDb: -toDb(worst) };
}
