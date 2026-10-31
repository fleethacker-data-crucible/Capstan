import { expect, test } from 'bun:test';
import { encodeWav, pcm16, wavDataSize, wavHeader } from '../../src/engine/wav-export';

test('the WAV header describes 16-bit PCM exactly', () => {
  const h = wavHeader({ sampleRate: 48000, channels: 2, frames: 48000 });
  const v = new DataView(h.buffer);
  const tag = (o: number) => String.fromCharCode(...h.subarray(o, o + 4));
  expect(h.length).toBe(44);
  expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
  expect(v.getUint32(4, true)).toBe(36 + 48000 * 4);
  expect(v.getUint16(20, true)).toBe(1);
  expect(v.getUint16(22, true)).toBe(2);
  expect(v.getUint32(24, true)).toBe(48000);
  expect(v.getUint32(28, true)).toBe(48000 * 4);
  expect(v.getUint16(32, true)).toBe(4);
  expect(v.getUint16(34, true)).toBe(16);
  expect(v.getUint32(40, true)).toBe(wavDataSize({ sampleRate: 48000, channels: 2, frames: 48000 }));
});

test('PCM is interleaved, little-endian, rounded and clipped', () => {
  const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -3]);
  const right = Float32Array.from([1, 0, 0, 0, 0, 0, 0]);
  const bytes = pcm16([left, right], 0, 7);
  const v = new DataView(bytes.buffer);
  expect(bytes.length).toBe(7 * 4);
  expect(v.getInt16(0, true)).toBe(0);
  expect(v.getInt16(2, true)).toBe(32767);
  expect(v.getInt16(4, true)).toBe(16384);
  expect(v.getInt16(8, true)).toBe(-16384);
  expect(v.getInt16(12, true)).toBe(32767);
  expect(v.getInt16(16, true)).toBe(-32768);
  expect(v.getInt16(20, true)).toBe(32767); // clipped
  expect(v.getInt16(24, true)).toBe(-32768);
  expect(pcm16([left], 3, 3).length).toBe(0);
});

test('encodeWav produces a file whose size matches the header', async () => {
  const n = 100_000;
  const ch = new Float32Array(n).map((_, i) => Math.sin(i / 20));
  const blob = encodeWav([ch, ch], 48000);
  expect(blob.size).toBe(44 + n * 4);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(bytes.buffer);
  expect(v.getUint32(40, true)).toBe(n * 4);
  // A sample from the middle matches the source.
  const i = 54321;
  expect(v.getInt16(44 + i * 4, true)).toBe(Math.round(ch[i] * 32767 * (ch[i] < 0 ? 32768 / 32767 : 1)));
});

test('a file past the 4 GB WAV limit is refused', () => {
  expect(() => wavHeader({ sampleRate: 48000, channels: 2, frames: 2 ** 31 })).toThrow();
});
