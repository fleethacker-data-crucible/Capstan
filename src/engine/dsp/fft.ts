// In-place radix-2 complex FFT. Pure TypeScript, no browser APIs, so the DSP can be unit-tested anywhere.

export class FFT {
  readonly size: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** Forward transform of (re, im), in place. */
  forward(re: Float64Array, im: Float64Array): void {
    this.run(re, im, -1);
  }

  /** Inverse transform in place, scaled by 1/size so forward then inverse restores the input. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.run(re, im, 1);
    const s = 1 / this.size;
    for (let i = 0; i < this.size; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  private run(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = sign * this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** Periodic Hann window: overlap-adds to a constant at hop sizes of size / 4 (sum of squares = 1.5). */
export function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}
