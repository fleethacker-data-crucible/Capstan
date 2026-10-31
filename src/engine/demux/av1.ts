// AV1 codec strings for WebCodecs ("av01.P.LLT.DD"). Normally they come from the av1C record of
// the MP4 sample entry or the WebM CodecPrivate. Some muxers write an empty av1C when the file
// starts before the first picture is encoded (ffmpeg with empty_moov), so the string can also be
// read from the sequence header OBU at the start of the first key frame.

/** Codec string from the 4 fixed bytes of an av1C record (or a WebM CodecPrivate). Null if they are not a valid record. */
export function av1CodecString(av1C: Uint8Array): string | null {
  if (av1C.length < 4 || av1C[0] !== 0x81) return null; // marker 1, version 1
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 31;
  const tier = av1C[2] & 0x80 ? 'H' : 'M';
  const depth = av1C[2] & 0x40 ? (av1C[2] & 0x20 ? 12 : 10) : 8;
  return format(profile, level, tier, depth);
}

const format = (profile: number, level: number, tier: string, depth: number) => `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;

class Bits {
  private pos = 0;
  constructor(private readonly b: Uint8Array) {}
  bit(): number {
    const byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new RangeError('out of bits');
    return (byte >> (7 - (this.pos++ & 7))) & 1;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  skip(n: number): void {
    for (let i = 0; i < n; i++) this.bit();
  }
}

/** Reads a leb128 number from an OBU header. */
function leb128(b: Uint8Array, at: number): { value: number; length: number } | null {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = b[at + i];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (!(byte & 0x80)) return { value, length: i + 1 };
  }
  return null;
}

/**
 * Codec string from the sequence header OBU found at the start of a key frame (a temporal unit in
 * the "low overhead" format MP4 and WebM use). Null when there is none or it is unusual enough that
 * guessing would be worse than seeking.
 */
export function av1CodecFromSample(sample: Uint8Array): string | null {
  try {
    let at = 0;
    while (at < sample.length) {
      const header = sample[at];
      const type = (header >> 3) & 15;
      const extension = (header & 4) !== 0;
      if (!(header & 2)) return null; // no size field: the OBU runs to the end, which a sample never needs
      const size = leb128(sample, at + 1 + (extension ? 1 : 0));
      if (!size) return null;
      const body = at + 1 + (extension ? 1 : 0) + size.length;
      if (type === 1) return fromSequenceHeader(sample.subarray(body, body + size.value));
      at = body + size.value;
    }
  } catch {
    /* a damaged header is not worth a guess */
  }
  return null;
}

function fromSequenceHeader(obu: Uint8Array): string | null {
  const r = new Bits(obu);
  const profile = r.bits(3);
  r.skip(1); // still_picture
  const reduced = r.bit() === 1;
  let level: number;
  let tier = 0;
  let timingInfo = false;
  let decoderModel = false;
  let bufferDelayLength = 0;
  if (reduced) level = r.bits(5);
  else {
    timingInfo = r.bit() === 1;
    if (timingInfo) {
      r.skip(64); // num_units_in_display_tick, time_scale
      if (r.bit()) {
        // equal_picture_interval: num_ticks_per_picture_minus_1 as uvlc
        let zeros = 0;
        while (r.bit() === 0) if (++zeros > 31) return null;
        r.skip(zeros);
      }
      decoderModel = r.bit() === 1;
      if (decoderModel) {
        bufferDelayLength = r.bits(5) + 1;
        r.skip(32);
        r.skip(5);
        r.skip(5);
      }
    }
    const initialDisplayDelay = r.bit() === 1;
    const count = r.bits(5) + 1;
    level = 0;
    for (let i = 0; i < count; i++) {
      r.skip(12); // operating_point_idc
      const l = r.bits(5);
      const t = l > 7 ? r.bit() : 0;
      if (i === 0) {
        level = l;
        tier = t;
      }
      if (decoderModel && r.bit()) r.skip(bufferDelayLength * 2 + 1);
      if (initialDisplayDelay && r.bit()) r.skip(4);
    }
  }
  const widthBits = r.bits(4) + 1;
  const heightBits = r.bits(4) + 1;
  r.skip(widthBits + heightBits);
  if (!reduced && r.bit()) r.skip(7); // frame ids
  r.skip(3); // 128x128 superblocks, filter intra, intra edge filter
  if (!reduced) {
    r.skip(4); // interintra, masked compound, warped motion, dual filter
    const orderHint = r.bit() === 1;
    if (orderHint) r.skip(2);
    const chooseScreenTools = r.bit() === 1;
    const forceScreenTools = chooseScreenTools ? 2 : r.bit();
    if (forceScreenTools > 0 && r.bit() === 0) r.skip(1); // seq_choose_integer_mv, else seq_force_integer_mv
    if (orderHint) r.skip(3);
  }
  r.skip(3); // superres, cdef, restoration
  const high = r.bit() === 1;
  const depth = profile === 2 && high ? (r.bit() ? 12 : 10) : high ? 10 : 8;
  return format(profile, level, tier ? 'H' : 'M', depth);
}
