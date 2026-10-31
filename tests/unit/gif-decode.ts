// Small independent GIF decoder used as the reference for the encoder tests: it follows the GIF89a
// spec (LZW with growing code size, local/global palettes, transparency, disposal) and shares no
// code with src/engine/gif.ts.
export interface DecodedFrame {
  /** The composited canvas after this frame, RGBA. */
  rgba: Uint8Array;
  delayCs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  transparentIndex: number | null;
}

export interface DecodedGif {
  width: number;
  height: number;
  loop: number | null;
  frames: DecodedFrame[];
}

function lzwDecode(data: Uint8Array, minCode: number, pixels: number): Uint8Array {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const out = new Uint8Array(pixels);
  let o = 0;
  let size = minCode + 1;
  let next = eoi + 1;
  // Table entries as (prefix, suffix); strings are rebuilt by walking prefixes.
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let prev = -1;
  let acc = 0;
  let bits = 0;
  let p = 0;
  const stack = new Uint8Array(4097);
  while (o < pixels) {
    while (bits < size) {
      if (p >= data.length) return out;
      acc |= data[p++] << bits;
      bits += 8;
    }
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    let sp = 0;
    let cur = code;
    if (prev === -1) {
      out[o++] = suffix[code];
      prev = code;
      continue;
    }
    if (code >= next) {
      // KwKwK case: the string is prev + first char of prev.
      let c = prev;
      while (prefix[c] !== -1) c = prefix[c];
      stack[sp++] = suffix[c];
      cur = prev;
    }
    while (cur !== -1) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    const first = stack[sp - 1];
    while (sp > 0 && o < pixels) out[o++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    prev = code;
  }
  return out;
}

export function decodeGif(buf: Uint8Array): DecodedGif {
  const sig = String.fromCharCode(...buf.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error(`Not a GIF: ${sig}`);
  const u16 = (i: number) => buf[i] | (buf[i + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const packed = buf[10];
  let p = 13;
  let globalPalette: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1);
    globalPalette = buf.subarray(p, p + n * 3);
    p += n * 3;
  }
  const frames: DecodedFrame[] = [];
  let loop: number | null = null;
  let delay = 0;
  let transparent: number | null = null;
  let disposal = 0;
  let canvas = new Uint8Array(width * height * 4);
  let previousCanvas = canvas.slice();
  let lastDisposal = 0;
  let lastRect = { x: 0, y: 0, w: 0, h: 0 };
  for (;;) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        const flags = buf[p + 1];
        disposal = (flags >> 2) & 7;
        delay = u16(p + 2);
        transparent = flags & 1 ? buf[p + 4] : null;
      } else if (label === 0xff) {
        const name = String.fromCharCode(...buf.subarray(p + 1, p + 12));
        if (name === 'NETSCAPE2.0') loop = u16(p + 14);
      }
      while (buf[p] !== 0) p += buf[p] + 1;
      p++;
      continue;
    }
    if (b !== 0x2c) throw new Error(`Unexpected block 0x${b?.toString(16)} at ${p - 1}`);
    const x = u16(p);
    const y = u16(p + 2);
    const w = u16(p + 4);
    const h = u16(p + 6);
    const ip = buf[p + 8];
    p += 9;
    let palette = globalPalette;
    if (ip & 0x80) {
      const n = 1 << ((ip & 7) + 1);
      palette = buf.subarray(p, p + n * 3);
      p += n * 3;
    }
    const minCode = buf[p++];
    const chunks: number[] = [];
    while (buf[p] !== 0) {
      for (let i = 0; i < buf[p]; i++) chunks.push(buf[p + 1 + i]);
      p += buf[p] + 1;
    }
    p++;
    const idx = lzwDecode(Uint8Array.from(chunks), minCode, w * h);
    // Apply the previous frame's disposal before drawing this one.
    if (lastDisposal === 2) {
      for (let row = 0; row < lastRect.h; row++) {
        for (let col = 0; col < lastRect.w; col++) canvas.fill(0, ((lastRect.y + row) * width + lastRect.x + col) * 4, ((lastRect.y + row) * width + lastRect.x + col) * 4 + 4);
      }
    } else if (lastDisposal === 3) canvas = previousCanvas.slice();
    previousCanvas = canvas.slice();
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const v = idx[row * w + col];
        if (v === transparent) continue;
        const o = ((y + row) * width + x + col) * 4;
        canvas[o] = palette![v * 3];
        canvas[o + 1] = palette![v * 3 + 1];
        canvas[o + 2] = palette![v * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    frames.push({ rgba: canvas.slice(), delayCs: delay, x, y, width: w, height: h, transparentIndex: transparent });
    lastDisposal = disposal;
    lastRect = { x, y, w, h };
    delay = 0;
    transparent = null;
    disposal = 0;
  }
  return { width, height, loop, frames };
}
