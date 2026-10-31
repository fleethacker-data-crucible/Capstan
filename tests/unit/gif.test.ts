import { expect, test } from 'bun:test';
import { GifEncoder, buildPalette, encodeGif, frameDelays, lzwEncode } from '../../src/engine/gif';
import { decodeGif } from './gif-decode';

function solid(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return px;
}

/** Left half red, right half blue, with a moving green square so frames differ. */
function scene(w: number, h: number, step: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inSquare = x >= step * 3 && x < step * 3 + 6 && y >= 4 && y < 10;
      const c = inSquare ? [0, 200, 0] : x < w / 2 ? [220, 20, 20] : [20, 20, 220];
      px.set([c[0], c[1], c[2], 255], o);
    }
  }
  return px;
}

test('frame delays follow the frame rate without drifting', () => {
  const d = frameDelays(15, 15);
  expect(d.reduce((a, b) => a + b, 0)).toBe(100);
  expect(frameDelays(10, 3)).toEqual([10, 10, 10]);
  expect(Math.min(...frameDelays(60, 12))).toBeGreaterThanOrEqual(2);
});

test('LZW round trip survives table resets on noisy data', () => {
  // Pseudo-random bytes force the table past 4096 entries several times.
  let seed = 12345;
  const data = new Uint8Array(60000);
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (seed >> 16) & 0x0f;
  }
  const w = 200;
  const h = data.length / w;
  const palette = new Uint8Array(16 * 3);
  for (let i = 0; i < 16; i++) palette.set([i * 16, 255 - i * 16, i * 8], i * 3);
  const rgba = new Uint8Array(data.length * 4);
  data.forEach((v, i) => rgba.set([palette[v * 3], palette[v * 3 + 1], palette[v * 3 + 2], 255], i * 4));
  const gif = encodeGif([rgba], 10, { width: w, height: h, colors: 16 });
  const out = decodeGif(gif);
  expect(out.frames.length).toBe(1);
  expect(Buffer.from(out.frames[0].rgba).equals(Buffer.from(rgba))).toBe(true);
  expect(lzwEncode(new Uint8Array(0), 2).length).toBeGreaterThan(0);
});

test('a flat-colour animation decodes to the exact frames, delays and loop count', () => {
  const frames = [0, 1, 2, 3, 4].map((s) => scene(64, 16, s));
  const gif = encodeGif(frames, 10, { width: 64, height: 16, loop: 0 });
  expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe('GIF89a');
  expect(gif[gif.length - 1]).toBe(0x3b);
  const out = decodeGif(gif);
  expect(out.width).toBe(64);
  expect(out.height).toBe(16);
  expect(out.frames.length).toBe(5);
  expect(out.loop).toBe(0);
  expect(out.frames.map((f) => f.delayCs)).toEqual([10, 10, 10, 10, 10]);
  frames.forEach((f, i) => expect(Buffer.from(out.frames[i].rgba).equals(Buffer.from(f.map((v, k) => (k % 4 === 3 ? 255 : v))))).toBe(true));
});

test('loop null writes no loop extension', () => {
  const gif = encodeGif([solid(8, 8, [1, 2, 3])], 10, { width: 8, height: 8, loop: null });
  expect(decodeGif(gif).loop).toBeNull();
  expect(Buffer.from(gif).includes(Buffer.from('NETSCAPE2.0'))).toBe(false);
});

test('frame differencing crops and makes unchanged pixels transparent but decodes to the same pictures', () => {
  const frames = [0, 1, 2, 3].map((s) => scene(64, 16, s));
  const plain = encodeGif(frames, 10, { width: 64, height: 16 });
  const opt = encodeGif(frames, 10, { width: 64, height: 16, optimize: true });
  const a = decodeGif(plain);
  const b = decodeGif(opt);
  expect(b.frames.length).toBe(4);
  b.frames.forEach((f, i) => expect(Buffer.from(f.rgba).equals(Buffer.from(a.frames[i].rgba))).toBe(true));
  expect(b.frames[1].width).toBeLessThan(64);
  expect(b.frames[1].transparentIndex).not.toBeNull();
  expect(opt.length).toBeLessThan(plain.length);
});

test('an unchanged frame becomes a one-pixel transparent frame that keeps its delay', () => {
  const f = scene(32, 16, 1);
  const gif = encodeGif([f, f, f], 20, { width: 32, height: 16, optimize: true });
  const out = decodeGif(gif);
  expect(out.frames.length).toBe(3);
  expect(out.frames[1].width).toBe(1);
  expect(out.frames[1].delayCs).toBe(5);
  expect(Buffer.from(out.frames[2].rgba).equals(Buffer.from(out.frames[0].rgba))).toBe(true);
});

test('a smooth gradient is quantised close to the source, and dithering keeps the average colour', () => {
  const w = 128;
  const h = 32;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.set([Math.round((x / (w - 1)) * 255), Math.round((y / (h - 1)) * 255), 128, 255], (y * w + x) * 4);
  }
  for (const dither of [false, true]) {
    const gif = encodeGif([px], 10, { width: w, height: h, colors: 32, dither });
    const dec = decodeGif(gif).frames[0].rgba;
    let err = 0;
    let meanSrc = 0;
    let meanOut = 0;
    for (let i = 0; i < w * h; i++) {
      err += Math.abs(dec[i * 4] - px[i * 4]) + Math.abs(dec[i * 4 + 1] - px[i * 4 + 1]) + Math.abs(dec[i * 4 + 2] - px[i * 4 + 2]);
      meanSrc += px[i * 4];
      meanOut += dec[i * 4];
    }
    expect(err / (w * h * 3)).toBeLessThan(dither ? 30 : 22);
    expect(Math.abs(meanSrc - meanOut) / (w * h)).toBeLessThan(6);
  }
});

test('median cut keeps every colour when there are few, and respects the palette limit', () => {
  const a = solid(4, 4, [10, 20, 30]);
  const b = solid(4, 4, [200, 100, 50]);
  const pal = buildPalette([a, b], 256);
  expect(pal.length).toBe(6);
  const set = new Set([0, 1].map((i) => `${pal[i * 3]},${pal[i * 3 + 1]},${pal[i * 3 + 2]}`));
  expect(set.has('10,20,30')).toBe(true);
  expect(set.has('200,100,50')).toBe(true);
  const noisy = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) noisy.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, 255], i * 4);
  expect(buildPalette([noisy], 16).length).toBeLessThanOrEqual(16 * 3);
});

test('the encoder streams bytes as frames arrive and refuses frames after finish', () => {
  const chunks: number[] = [];
  const pal = buildPalette([solid(4, 4, [255, 0, 0])], 2);
  const enc = new GifEncoder({ width: 4, height: 4 }, pal, (b) => chunks.push(b.length));
  const afterHeader = chunks.length;
  enc.addFrame(solid(4, 4, [255, 0, 0]), 5);
  expect(chunks.length).toBeGreaterThan(afterHeader);
  enc.finish();
  expect(() => enc.addFrame(solid(4, 4, [255, 0, 0]), 5)).toThrow();
  expect(enc.frames).toBe(1);
});

test('frame differencing needs a spare palette slot', () => {
  const pal = new Uint8Array(256 * 3);
  expect(() => new GifEncoder({ width: 2, height: 2, optimize: true }, pal, () => undefined)).toThrow();
});
