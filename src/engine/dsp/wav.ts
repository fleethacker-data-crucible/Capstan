// Minimal RIFF/WAVE writer and reader (PCM 16-bit or 32-bit float). Used to turn processed audio into a
// media item the editor can import. Audio-area code: it does not depend on any other encoder.

export type WavBitDepth = 16 | 32;

const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Encodes planar channels (all the same length) as a WAV file. 16-bit PCM by default; 32 writes IEEE float. */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth = 16): Uint8Array {
  if (!channels.length) throw new Error('No audio channels to encode');
  const frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error('Channels differ in length');
  const n = channels.length;
  const bytesPer = bitDepth / 8;
  const dataBytes = frames * n * bytesPer;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  v.setUint16(22, n, true);
  v.setUint32(24, Math.round(sampleRate), true);
  v.setUint32(28, Math.round(sampleRate) * n * bytesPer, true);
  v.setUint16(32, n * bytesPer, true);
  v.setUint16(34, bitDepth, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Number.isFinite(channels[c][i]) ? channels[c][i] : 0;
      if (bitDepth === 32) v.setFloat32(at, s, true);
      else v.setInt16(at, Math.round(clamp1(s) * (s < 0 ? 32768 : 32767)), true);
      at += bytesPer;
    }
  }
  return out;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Reads a PCM 16/24/32-bit or float32 WAV. Throws on anything else. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let format = 0;
  let n = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLen = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = v.getUint16(at + 8, true);
      n = v.getUint16(at + 10, true);
      sampleRate = v.getUint32(at + 12, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === 'data') {
      dataAt = at + 8;
      dataLen = Math.min(size, bytes.length - dataAt);
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (dataAt < 0 || n < 1) throw new Error('WAV file has no audio data');
  const isFloat = format === 3 && bits === 32;
  if (!(format === 1 && (bits === 16 || bits === 24 || bits === 32)) && !isFloat) throw new Error('Unsupported WAV format');
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * n));
  const channels = Array.from({ length: n }, () => new Float32Array(frames));
  let at = dataAt;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      let s: number;
      if (isFloat) s = v.getFloat32(at, true);
      else if (bits === 16) s = v.getInt16(at, true) / 32768;
      else if (bits === 24) s = (((bytes[at + 2] << 24) | (bytes[at + 1] << 16) | (bytes[at] << 8)) >> 8) / 8388608;
      else s = v.getInt32(at, true) / 2147483648;
      channels[c][i] = s;
      at += bytesPer;
    }
  }
  return { sampleRate, channels };
}
