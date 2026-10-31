// Animated GIF encoder in plain TypeScript: median-cut global palette, optional Floyd-Steinberg
// dithering, variable-code-size LZW, Netscape loop extension, and optional frame differencing
// (unchanged pixels become transparent and each frame is cropped to what changed).
//
// Frames are fed one at a time and the bytes come out through `write` as they are produced, so a
// long GIF never needs the whole picture history in memory. The palette has to be known first:
// build it from a handful of sample frames with `buildPalette`.

export interface GifOptions {
  width: number;
  height: number;
  /** 0 = loop forever (default), n = repeat n more times, null = play once (no loop extension). */
  loop?: number | null;
  /** Floyd-Steinberg error diffusion (default off: flat screen content looks cleaner without it). */
  dither?: boolean;
  /** Frame differencing: later frames are cropped to the changed area, unchanged pixels transparent. */
  optimize?: boolean;
}

/** Delay of each frame in hundredths of a second, so the total follows `fps` without drifting. */
export function frameDelays(fps: number, count: number): number[] {
  const out: number[] = [];
  const unit = 100 / Math.max(1, fps);
  for (let i = 0; i < count; i++) out.push(Math.max(2, Math.round((i + 1) * unit) - Math.round(i * unit)));
  return out;
}

const KEY_BITS = 5;
const KEY_SIZE = 1 << (KEY_BITS * 3);

function keyOf(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * Median-cut palette (RGB triples, at most `colors` entries) for the pixels of the sample frames.
 * When the frames use fewer distinct colours than that, every colour is kept exactly.
 */
export function buildPalette(samples: Array<Uint8ClampedArray | Uint8Array>, colors = 256): Uint8Array {
  const n = Math.max(2, Math.min(256, Math.floor(colors)));
  const count = new Float64Array(KEY_SIZE);
  const sum = new Float64Array(KEY_SIZE * 3);
  for (const px of samples) {
    // Large frames are sampled: a stride keeps the cost bounded without changing the colour balance.
    const stride = px.length > 4 * 400_000 ? 4 * Math.ceil(px.length / 4 / 400_000) : 4;
    for (let i = 0; i + 3 < px.length; i += stride) {
      const k = keyOf(px[i], px[i + 1], px[i + 2]);
      count[k]++;
      sum[k * 3] += px[i];
      sum[k * 3 + 1] += px[i + 1];
      sum[k * 3 + 2] += px[i + 2];
    }
  }
  const bins: number[] = [];
  for (let k = 0; k < KEY_SIZE; k++) if (count[k] > 0) bins.push(k);
  const colourOf = (list: number[]): [number, number, number] => {
    let c = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const k of list) {
      c += count[k];
      r += sum[k * 3];
      g += sum[k * 3 + 1];
      b += sum[k * 3 + 2];
    }
    return [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
  };
  if (!bins.length) return new Uint8Array([0, 0, 0, 255, 255, 255]);

  interface Box {
    list: number[];
    population: number;
    channel: number;
    range: number;
  }
  const measure = (list: number[]): Box => {
    let population = 0;
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const k of list) {
      population += count[k];
      const c = [(k >> 10) & 31, (k >> 5) & 31, k & 31];
      for (let i = 0; i < 3; i++) {
        if (c[i] < lo[i]) lo[i] = c[i];
        if (c[i] > hi[i]) hi[i] = c[i];
      }
    }
    // Green carries the most visible detail: weight its range a little.
    const ranges = [hi[0] - lo[0], (hi[1] - lo[1]) * 1.2, hi[2] - lo[2]];
    const channel = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : ranges[0] >= ranges[2] ? 0 : 2;
    return { list, population, channel, range: ranges[channel] };
  };
  const boxes: Box[] = [measure(bins)];
  while (boxes.length < n) {
    // Split the box where an error would show most: many pixels spread over a wide colour range.
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.list.length < 2) continue;
      const score = b.population * (b.range + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    const box = boxes[best];
    const shift = box.channel === 0 ? 10 : box.channel === 1 ? 5 : 0;
    const sorted = [...box.list].sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31) || a - b);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += count[sorted[i]];
      cut = i + 1;
      if (acc >= box.population / 2) break;
    }
    boxes.splice(best, 1, measure(sorted.slice(0, cut)), measure(sorted.slice(cut)));
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, i) => palette.set(colourOf(b.list), i * 3));
  return palette;
}

/** Variable-code-size LZW as GIF uses it (clear and end codes, table reset at 4096 entries). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  const emit = (code: number) => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  emit(clear);
  if (indices.length) {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const b = indices[i];
      const key = (prefix << 8) | b;
      const hit = dict.get(key);
      if (hit !== undefined) {
        prefix = hit;
        continue;
      }
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        dict = new Map();
        size = minCodeSize + 1;
        next = eoi + 1;
      } else {
        if (next >= 1 << size) size++;
        dict.set(key, next++);
      }
      prefix = b;
    }
    emit(prefix);
  }
  emit(eoi);
  if (accBits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

function subBlocks(data: Uint8Array): Uint8Array {
  const blocks = Math.ceil(data.length / 255);
  const out = new Uint8Array(data.length + blocks + 1);
  let o = 0;
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    out[o++] = n;
    out.set(data.subarray(i, i + n), o);
    o += n;
  }
  out[o] = 0;
  return out;
}

export class GifEncoder {
  private readonly tableBits: number;
  private readonly transparent: number;
  private readonly colourCount: number;
  private readonly cache = new Int16Array(KEY_SIZE).fill(-1);
  private previous: Uint8Array | null = null;
  private done = false;
  /** Frames written so far. */
  frames = 0;

  constructor(
    private readonly options: GifOptions,
    private readonly palette: Uint8Array,
    private readonly write: (bytes: Uint8Array) => void,
  ) {
    const { width, height } = options;
    if (width < 1 || height < 1 || width > 65535 || height > 65535) throw new Error('GIF size out of range');
    this.colourCount = palette.length / 3;
    if (this.colourCount < 1 || this.colourCount > 256 || !Number.isInteger(this.colourCount)) throw new Error('A GIF palette has 1 to 256 colours');
    this.transparent = options.optimize ? this.colourCount : -1;
    const entries = this.colourCount + (options.optimize ? 1 : 0);
    if (entries > 256) throw new Error('Frame differencing needs one palette slot: use at most 255 colours');
    this.tableBits = Math.max(1, Math.ceil(Math.log2(entries)));
    this.writeHeader();
  }

  private writeHeader(): void {
    const { width, height, loop } = this.options;
    const table = 1 << this.tableBits;
    const head: number[] = [...'GIF89a'].map((c) => c.charCodeAt(0));
    head.push(width & 255, width >> 8, height & 255, height >> 8);
    head.push(0x80 | (7 << 4) | (this.tableBits - 1), 0, 0);
    const pal = new Uint8Array(table * 3);
    pal.set(this.palette);
    const out = new Uint8Array(head.length + pal.length);
    out.set(head, 0);
    out.set(pal, head.length);
    this.write(out);
    if (loop !== null) {
      const l = Math.max(0, Math.min(65535, Math.round(loop ?? 0)));
      this.write(Uint8Array.from([0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, l & 255, l >> 8, 0]));
    }
  }

  /** Index of the palette colour closest to the colour (cached per 5-bit cell). */
  private nearest(r: number, g: number, b: number): number {
    const k = keyOf(r, g, b);
    const hit = this.cache[k];
    if (hit >= 0) return hit;
    // Compare against the cell's centre, so every pixel of a cell maps alike.
    const cr = ((k >> 10) << 3) | 4;
    const cg = (((k >> 5) & 31) << 3) | 4;
    const cb = ((k & 31) << 3) | 4;
    const idx = this.closest(cr, cg, cb);
    this.cache[k] = idx;
    return idx;
  }

  private closest(r: number, g: number, b: number): number {
    const p = this.palette;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.colourCount; i++) {
      const dr = p[i * 3] - r;
      const dg = p[i * 3 + 1] - g;
      const db = p[i * 3 + 2] - b;
      // Weighted like the eye: green counts most.
      const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (d < bestD) {
        bestD = d;
        best = i;
        if (d === 0) break;
      }
    }
    return best;
  }

  /** Maps RGBA pixels to palette indices (dithered if asked). Alpha is ignored: frames are opaque. */
  quantize(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
    const { width, height } = this.options;
    const out = new Uint8Array(width * height);
    if (!this.options.dither) {
      for (let i = 0, o = 0; o < out.length; i += 4, o++) out[o] = this.nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
      return out;
    }
    const p = this.palette;
    let cur = new Float32Array((width + 2) * 3);
    let nxt = new Float32Array((width + 2) * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const e = (x + 1) * 3;
        const r = Math.min(255, Math.max(0, rgba[i] + cur[e]));
        const g = Math.min(255, Math.max(0, rgba[i + 1] + cur[e + 1]));
        const b = Math.min(255, Math.max(0, rgba[i + 2] + cur[e + 2]));
        const idx = this.closest(Math.round(r), Math.round(g), Math.round(b));
        out[y * width + x] = idx;
        const er = r - p[idx * 3];
        const eg = g - p[idx * 3 + 1];
        const eb = b - p[idx * 3 + 2];
        for (let c = 0; c < 3; c++) {
          const err = c === 0 ? er : c === 1 ? eg : eb;
          cur[e + 3 + c] += (err * 7) / 16;
          nxt[e - 3 + c] += (err * 3) / 16;
          nxt[e + c] += (err * 5) / 16;
          nxt[e + 3 + c] += err / 16;
        }
      }
      [cur, nxt] = [nxt, cur];
      nxt.fill(0);
    }
    return out;
  }

  /** Adds a frame of `width * height` RGBA pixels shown for `delayCs` hundredths of a second. */
  addFrame(rgba: Uint8ClampedArray | Uint8Array, delayCs: number): void {
    if (this.done) throw new Error('The GIF is finished');
    const { width, height } = this.options;
    if (rgba.length < width * height * 4) throw new Error('Frame has fewer pixels than the GIF size');
    const indices = this.quantize(rgba);
    let x = 0;
    let y = 0;
    let w = width;
    let h = height;
    let data = indices;
    let transparent = false;
    if (this.options.optimize && this.previous) {
      const prev = this.previous;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
          if (indices[row * width + col] !== prev[row * width + col]) {
            if (col < minX) minX = col;
            if (col > maxX) maxX = col;
            if (row < minY) minY = row;
            if (row > maxY) maxY = row;
          }
        }
      }
      if (maxX < 0) {
        // Nothing changed: a single transparent pixel keeps the timing.
        x = 0;
        y = 0;
        w = 1;
        h = 1;
        data = Uint8Array.of(this.transparent);
      } else {
        x = minX;
        y = minY;
        w = maxX - minX + 1;
        h = maxY - minY + 1;
        data = new Uint8Array(w * h);
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const i = indices[(y + row) * width + x + col];
            data[row * w + col] = i === prev[(y + row) * width + x + col] ? this.transparent : i;
          }
        }
      }
      transparent = true;
    }
    this.previous = indices;
    const delay = Math.max(0, Math.min(65535, Math.round(delayCs)));
    const gce = Uint8Array.of(0x21, 0xf9, 4, (1 << 2) | (transparent ? 1 : 0), delay & 255, delay >> 8, transparent ? this.transparent : 0, 0);
    const desc = Uint8Array.of(0x2c, x & 255, x >> 8, y & 255, y >> 8, w & 255, w >> 8, h & 255, h >> 8, 0);
    const minCode = Math.max(2, this.tableBits);
    this.write(gce);
    this.write(desc);
    this.write(Uint8Array.of(minCode));
    this.write(subBlocks(lzwEncode(data, minCode)));
    this.frames++;
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.write(Uint8Array.of(0x3b));
  }
}

/** Convenience for small cases and tests: palette from the frames themselves, whole file at once. */
export function encodeGif(
  frames: Array<Uint8ClampedArray | Uint8Array>,
  fps: number,
  options: GifOptions & { colors?: number },
): Uint8Array {
  const colors = Math.min(options.colors ?? 256, options.optimize ? 255 : 256);
  const palette = buildPalette(frames, colors);
  const parts: Uint8Array[] = [];
  const enc = new GifEncoder(options, palette, (b) => parts.push(b));
  const delays = frameDelays(fps, frames.length);
  frames.forEach((f, i) => enc.addFrame(f, delays[i]));
  enc.finish();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
