// Pure maths for clip effects: the colour matrix and the chroma key. This is the reference the WebGL2
// shader (fx-gl.ts) is checked against, and the CPU fallback when WebGL2 is unavailable. No DOM here.

export interface ColourFx {
  on: boolean;
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
  /** -100..100 (-100 = greyscale) */
  saturation: number;
  /** -180..180 degrees */
  hue: number;
  /** Colourise colour, #rrggbb. */
  tint: string;
  /** 0..100: how far the picture is pulled to the tint. */
  tintAmount: number;
}

export interface ChromaFx {
  on: boolean;
  /** The colour to remove, #rrggbb. */
  key: string;
  /** 0..100: how far from the key colour still counts as key. */
  tolerance: number;
  /** 0..100: width of the soft edge beyond the tolerance. */
  softness: number;
  /** 0..100: how much of the key colour's cast is pulled out of what is kept. */
  spill: number;
}

export type Rgb = [number, number, number];

/** Parses #rrggbb (or #rgb) into 0..1 floats; anything else is black. */
export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export const LUMA: Rgb = [0.2126, 0.7152, 0.0722];
const luma = (r: number, g: number, b: number): number => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface ColourParams {
  /** Added to every channel. */
  offset: number;
  /** Multiplier about mid grey. */
  contrast: number;
  /** Multiplier of the distance from luma. */
  saturation: number;
  /** Row-major 3x3 hue rotation (the CSS hue-rotate matrix). */
  hue: number[];
  tint: Rgb;
  tintAmount: number;
}

export function hueMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

/** Derived numbers for the colour pass, or null when the settings change nothing. */
export function colourParams(c: ColourFx | undefined): ColourParams | null {
  if (!c || !c.on) return null;
  const p: ColourParams = {
    offset: (c.brightness / 100) * 0.5,
    contrast: 1 + c.contrast / 100,
    saturation: 1 + c.saturation / 100,
    hue: hueMatrix(c.hue),
    tint: hexToRgb(c.tint),
    tintAmount: c.tintAmount / 100,
  };
  const identity = p.offset === 0 && p.contrast === 1 && p.saturation === 1 && c.hue === 0 && p.tintAmount === 0;
  return identity ? null : p;
}

export interface ChromaParams {
  key: Rgb;
  /** The key colour's (Cb, Cr). */
  keyCbCr: [number, number];
  /** Unit vector of the key colour's cast (key minus its luma); zero for a grey key. */
  keyDir: Rgb;
  /** Distance in CbCr space up to which a pixel is fully removed. */
  t0: number;
  /** Width of the soft edge beyond t0. */
  softWidth: number;
  /** 0..1 */
  spill: number;
}

export function cbcr(r: number, g: number, b: number): [number, number] {
  return [-0.169 * r - 0.331 * g + 0.5 * b, 0.5 * r - 0.419 * g - 0.081 * b];
}

export function chromaParams(c: ChromaFx | undefined): ChromaParams | null {
  if (!c || !c.on) return null;
  const key = hexToRgb(c.key);
  const l = luma(...key);
  const dir: Rgb = [key[0] - l, key[1] - l, key[2] - l];
  const len = Math.hypot(...dir);
  return {
    key,
    keyCbCr: cbcr(...key),
    keyDir: len < 1e-4 ? [0, 0, 0] : [dir[0] / len, dir[1] / len, dir[2] / len],
    t0: (c.tolerance / 100) * 0.6,
    softWidth: (c.softness / 100) * 0.4,
    spill: c.spill / 100,
  };
}

/**
 * One pixel through the chroma key then the colour pass. Input and output are straight (not
 * premultiplied) RGBA as 0..1 floats. `out` is written and returned.
 */
export function processPixel(colour: ColourParams | null, chroma: ChromaParams | null, r: number, g: number, b: number, a: number, out: number[] = [0, 0, 0, 0]): number[] {
  if (chroma) {
    const [cb, cr] = cbcr(r, g, b);
    const d = Math.hypot(cb - chroma.keyCbCr[0], cr - chroma.keyCbCr[1]);
    let k = clamp01((d - chroma.t0) / Math.max(chroma.softWidth, 1e-4));
    k = k * k * (3 - 2 * k);
    a *= k;
    if (chroma.spill > 0) {
      const w = 1 - clamp01((d - chroma.t0) / (chroma.softWidth + 0.5));
      const l = luma(r, g, b);
      const amount = Math.max(0, (r - l) * chroma.keyDir[0] + (g - l) * chroma.keyDir[1] + (b - l) * chroma.keyDir[2]);
      const f = amount * chroma.spill * w;
      r = clamp01(r - chroma.keyDir[0] * f);
      g = clamp01(g - chroma.keyDir[1] * f);
      b = clamp01(b - chroma.keyDir[2] * f);
    }
  }
  if (colour) {
    r = clamp01(r + colour.offset);
    g = clamp01(g + colour.offset);
    b = clamp01(b + colour.offset);
    r = clamp01((r - 0.5) * colour.contrast + 0.5);
    g = clamp01((g - 0.5) * colour.contrast + 0.5);
    b = clamp01((b - 0.5) * colour.contrast + 0.5);
    let l = luma(r, g, b);
    r = clamp01(l + (r - l) * colour.saturation);
    g = clamp01(l + (g - l) * colour.saturation);
    b = clamp01(l + (b - l) * colour.saturation);
    const h = colour.hue;
    const hr = clamp01(h[0] * r + h[1] * g + h[2] * b);
    const hg = clamp01(h[3] * r + h[4] * g + h[5] * b);
    const hb = clamp01(h[6] * r + h[7] * g + h[8] * b);
    r = hr;
    g = hg;
    b = hb;
    if (colour.tintAmount > 0) {
      l = luma(r, g, b);
      const t = colour.tint;
      // Shadows tend to the tint's shade, highlights to white, so the picture keeps its light and dark.
      let tr: number, tg: number, tb: number;
      if (l < 0.5) {
        tr = t[0] * l * 2;
        tg = t[1] * l * 2;
        tb = t[2] * l * 2;
      } else {
        const m = (l - 0.5) * 2;
        tr = t[0] + (1 - t[0]) * m;
        tg = t[1] + (1 - t[1]) * m;
        tb = t[2] + (1 - t[2]) * m;
      }
      r += (tr - r) * colour.tintAmount;
      g += (tg - g) * colour.tintAmount;
      b += (tb - b) * colour.tintAmount;
    }
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
  out[3] = a;
  return out;
}

/** Runs the chroma key and colour pass over straight RGBA bytes, in place (the CPU fallback). */
export function processImageData(data: Uint8ClampedArray, colour: ColourParams | null, chroma: ChromaParams | null): void {
  const out = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    processPixel(colour, chroma, data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, a / 255, out);
    data[i] = Math.round(out[0] * 255);
    data[i + 1] = Math.round(out[1] * 255);
    data[i + 2] = Math.round(out[2] * 255);
    data[i + 3] = Math.round(out[3] * 255);
  }
}
