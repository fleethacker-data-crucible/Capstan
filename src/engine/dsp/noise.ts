// Spectral-gating noise reduction.
//
// 1. Hann-windowed STFT (75 % overlap).
// 2. The noise profile is the mean power spectrum of the quietest frames (or of a region the user marks).
// 3. Each frame gets a per-bin gain from a power-subtraction rule: 1 - over * noise / power, floored.
// 4. The gain mask is cleaned: isolated bins and isolated frames are dropped (musical-noise control).
// 5. Inverse FFT and overlap-add.
//
// Limit: with the automatic profile the clip needs a stretch where only the noise is present. A noise that is
// present in every frame together with the wanted sound (a hum under a constant tone) is treated as wanted
// unless the user marks a noise-only region.
import { FFT, hannWindow } from './fft';

export interface NoiseOptions {
  /** 0..1. 0 = gentle (about 8 dB), 1 = strong (about 32 dB). Default 0.6. */
  strength?: number;
  /** A region of the input (seconds) that holds only noise. Default: the quietest frames. */
  profile?: { start: number; end: number };
  fftSize?: number;
  /** Awaited now and then so a long clip does not freeze the page. */
  yieldToUi?: () => Promise<void>;
}

/** The attenuation floor and the over-subtraction factor for a strength. */
export function noiseParams(strength: number): { floorDb: number; over: number } {
  const s = Math.min(1, Math.max(0, strength));
  return { floorDb: -(8 + 24 * s), over: 1.5 + 2.5 * s };
}

function dbToLin(db: number): number {
  return 10 ** (db / 20);
}

/** Picks the frames used to learn the noise: the quietest ones, widened to every frame within ~2 dB of them. */
function pickQuietFrames(energies: number[]): number[] {
  const idx = energies.map((_, i) => i).sort((a, b) => energies[a] - energies[b]);
  const lowest = idx.slice(0, Math.max(4, Math.floor(idx.length * 0.1)));
  const ref = energies[lowest[Math.floor(lowest.length / 2)]];
  const cap = Math.max(4, Math.floor(idx.length * 0.4));
  const chosen: number[] = [];
  for (const i of idx) {
    if (chosen.length >= cap) break;
    if (chosen.length < 4 || energies[i] <= ref * 1.6) chosen.push(i);
  }
  return chosen;
}

export async function reduceNoise(input: Float32Array, sampleRate: number, opts: NoiseOptions = {}): Promise<Float32Array> {
  const N = opts.fftSize ?? (sampleRate >= 32000 ? 2048 : 1024);
  const hop = N / 4;
  const bins = N / 2 + 1;
  const len = input.length;
  const { floorDb, over } = noiseParams(opts.strength ?? 0.6);
  const floor = dbToLin(floorDb);
  const out = new Float32Array(len);
  const frames = Math.ceil((len + N - hop) / hop) + 1;
  if (len < N * 2) {
    out.set(input);
    return out;
  }
  const fft = new FFT(N);
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const startOf = (f: number) => f * hop - (N - hop);
  const load = (f: number) => {
    const s = startOf(f);
    for (let n = 0; n < N; n++) {
      const i = s + n;
      re[n] = i >= 0 && i < len ? input[i] * win[n] : 0;
      im[n] = 0;
    }
  };

  // ---- noise profile ------------------------------------------------------------------------------------
  const candidates: number[] = [];
  const energies: number[] = [];
  const region = opts.profile
    ? { a: Math.max(0, Math.floor(opts.profile.start * sampleRate)), b: Math.min(len, Math.floor(opts.profile.end * sampleRate)) }
    : null;
  for (let f = 0; f < frames; f++) {
    const s = startOf(f);
    if (s < 0 || s + N > len) continue;
    if (region && (s < region.a || s + N > region.b)) continue;
    let e = 0;
    for (let n = 0; n < N; n++) {
      const x = input[s + n] * win[n];
      e += x * x;
    }
    candidates.push(f);
    energies.push(e);
  }
  if (!candidates.length) {
    out.set(input);
    return out;
  }
  const chosen = region ? candidates.map((_, i) => i) : pickQuietFrames(energies);
  const noisePow = new Float64Array(bins);
  for (const ci of chosen) {
    load(candidates[ci]);
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) noisePow[k] += re[k] * re[k] + im[k] * im[k];
  }
  for (let k = 0; k < bins; k++) noisePow[k] /= chosen.length;

  // ---- filter, three frames in flight (previous, current, next) -----------------------------------------
  const slotRe = [0, 1, 2].map(() => new Float64Array(N));
  const slotIm = [0, 1, 2].map(() => new Float64Array(N));
  const slotGain = [0, 1, 2].map(() => new Float32Array(bins));
  const raw = new Float32Array(bins);
  const eroded = new Float32Array(bins);
  const gain = new Float32Array(bins);

  const analyse = (f: number) => {
    const slot = f % 3;
    load(f);
    fft.forward(re, im);
    slotRe[slot].set(re);
    slotIm[slot].set(im);
    for (let k = 0; k < bins; k++) {
      const pow = re[k] * re[k] + im[k] * im[k];
      const g = pow > 0 ? Math.sqrt(Math.max(0, 1 - (over * noisePow[k]) / pow)) : 0;
      raw[k] = g < floor ? floor : g > 1 ? 1 : g;
    }
    // Opening across frequency: a lone bin that passes the gate is noise, a tone passes in at least three.
    for (let k = 0; k < bins; k++) eroded[k] = Math.min(raw[Math.max(0, k - 1)], raw[k], raw[Math.min(bins - 1, k + 1)]);
    const g = slotGain[slot];
    for (let k = 0; k < bins; k++) g[k] = Math.max(eroded[Math.max(0, k - 1)], eroded[k], eroded[Math.min(bins - 1, k + 1)]);
  };

  const synth = (f: number) => {
    const slot = f % 3;
    const cur = slotGain[slot];
    const prev = f > 0 ? slotGain[(f + 2) % 3] : null;
    const next = f < frames - 1 ? slotGain[(f + 1) % 3] : null;
    for (let k = 0; k < bins; k++) {
      // Across time a lone frame that passes the gate is a click of noise; speech and tones span frames.
      const around = prev && next ? Math.max(prev[k], next[k]) : prev ? prev[k] : next ? next[k] : cur[k];
      gain[k] = Math.min(cur[k], around);
    }
    const r = slotRe[slot];
    const q = slotIm[slot];
    for (let k = 0; k < bins; k++) {
      r[k] *= gain[k];
      q[k] *= gain[k];
      if (k > 0 && k < N / 2) {
        r[N - k] *= gain[k];
        q[N - k] *= gain[k];
      }
    }
    fft.inverse(r, q);
    const s = startOf(f);
    for (let n = 0; n < N; n++) {
      const i = s + n;
      if (i >= 0 && i < len) out[i] += (r[n] * win[n]) / 1.5;
    }
  };

  const tick = opts.yieldToUi;
  analyse(0);
  for (let f = 1; f < frames; f++) {
    analyse(f);
    synth(f - 1);
    if (tick && f % 256 === 0) await tick();
  }
  synth(frames - 1);
  return out;
}

/** Root-mean-square level of a stretch of samples, in dBFS (-Infinity for silence). */
export function rmsDb(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  const a = Math.max(0, from);
  const b = Math.min(samples.length, to);
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return b > a ? 10 * Math.log10(sum / (b - a)) : Number.NEGATIVE_INFINITY;
}
