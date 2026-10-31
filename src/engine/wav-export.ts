// WAV (RIFF, 16-bit PCM) writer. Pure functions over Float32 channel data, so they are unit-tested
// without a browser; audio-export.ts feeds them the mixed timeline.

export interface WavFormat {
  sampleRate: number;
  channels: number;
  /** Sample frames in the file. */
  frames: number;
}

/** Size in bytes of the 16-bit PCM data for the format. */
export function wavDataSize(f: WavFormat): number {
  return f.frames * f.channels * 2;
}

/** The 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(f: WavFormat): Uint8Array {
  const data = wavDataSize(f);
  if (data + 36 > 0xffffffff) throw new Error('This audio is too long for a WAV file (4 GB limit)');
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, f.channels, true);
  v.setUint32(24, f.sampleRate, true);
  v.setUint32(28, f.sampleRate * f.channels * 2, true);
  v.setUint16(32, f.channels * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, data, true);
  return b;
}

/** Interleaves frames [from, to) of the channels as little-endian 16-bit PCM, clipping at full scale. */
export function pcm16(channels: Float32Array[], from: number, to: number): Uint8Array {
  const n = Math.max(0, to - from);
  const out = new Uint8Array(n * channels.length * 2);
  const v = new DataView(out.buffer);
  let o = 0;
  for (let i = from; i < to; i++) {
    for (const ch of channels) {
      const s = Math.max(-1, Math.min(1, ch[i] ?? 0));
      v.setInt16(o, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
      o += 2;
    }
  }
  return out;
}

/** The whole WAV file as one Blob. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const frames = channels[0]?.length ?? 0;
  const parts: BlobPart[] = [wavHeader({ sampleRate, channels: channels.length, frames }) as Uint8Array<ArrayBuffer>];
  const CHUNK = 1 << 16;
  for (let i = 0; i < frames; i += CHUNK) parts.push(pcm16(channels, i, Math.min(frames, i + CHUNK)) as Uint8Array<ArrayBuffer>);
  return new Blob(parts, { type: 'audio/wav' });
}
