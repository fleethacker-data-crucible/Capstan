// MP4 demuxer for the fast export path. Finds the video track's sample table in the moov box
// (stts, ctts, stss, stsc, stsz, stco/co64, edit list) or, for a fragmented file, in its
// moof/traf/trun boxes (tfhd, tfdt, trex defaults, sample flags). Handles H.264 (avc1), VP9 (vp09),
// AV1 (av01) and HEVC (hvc1/hev1). Anything else, and any file it cannot read to the end, comes
// back as "not for the fast path" with a note saying why, and the export seeks as before.
// Nothing here throws: a truncated or corrupt file is a miss, never an error.
import { av1CodecFromSample, av1CodecString } from './av1';
import type { DemuxRead, VideoSample, VideoTrackInfo } from './types';

interface Box {
  type: string;
  /** Start of the payload. */
  start: number;
  end: number;
}

function boxes(b: Uint8Array, from = 0, to = b.length): Box[] {
  const out: Box[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = from;
  while (p + 8 <= to) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = v.getUint32(p + 8) * 2 ** 32 + v.getUint32(p + 12);
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const child = (b: Uint8Array, parent: Box, type: string): Box | undefined => boxes(b, parent.start, parent.end).find((x) => x.type === type);

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** HEVC codec string (hvc1.* / hev1.*) from the payload of an hvcC box. */
export function hevcCodecString(prefix: string, hvcC: Uint8Array): string {
  const space = ['', 'A', 'B', 'C'][hvcC[1] >> 6];
  const tier = hvcC[1] & 0x20 ? 'H' : 'L';
  const idc = hvcC[1] & 31;
  let compat = ((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]) >>> 0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = ((reversed << 1) | (compat & 1)) >>> 0;
    compat >>>= 1;
  }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length > 1 && constraints[constraints.length - 1] === 0) constraints.pop();
  return `${prefix}.${space}${idc}.${reversed.toString(16)}.${tier}${hvcC[12]}.${constraints.map((c) => c.toString(16)).join('.')}`;
}

interface TrackHead {
  trackId: number;
  timescale: number;
  codec: string;
  description?: Uint8Array;
  width: number;
  height: number;
  trak: Box;
  stbl: Box;
  /** Media-timescale units to subtract from pts (the first real edit of the edit list). */
  shift: number;
  /** Microseconds of empty edit before the first frame. */
  delayUs: number;
}

type HeadResult = { head: TrackHead } | { miss: string; codec: string | null };

/** The first video track of a moov box: timescale, sample description and edit list. */
function readHead(moov: Uint8Array, top: Box): HeadResult {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const mvhd = child(moov, top, 'mvhd');
  const movieScale = mvhd ? v.getUint32(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12)) : 1000;
  for (const trak of boxes(moov, top.start, top.end).filter((x) => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!mdia || !hdlr) continue;
    if (String.fromCharCode(...moov.subarray(hdlr.start + 8, hdlr.start + 12)) !== 'vide') continue;
    const tkhd = child(moov, trak, 'tkhd');
    const mdhd = child(moov, mdia, 'mdhd');
    const minf = child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    if (!tkhd || !mdhd || !stbl) return { miss: 'the video track has no sample table', codec: null };
    const trackId = v.getUint32(tkhd.start + (moov[tkhd.start] === 1 ? 20 : 12));
    const timescale = v.getUint32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
    if (!timescale) return { miss: 'the video track has no timescale', codec: null };

    // ---- sample description --------------------------------------------------------------
    const stsd = child(moov, stbl, 'stsd');
    const entry = stsd && boxes(moov, stsd.start + 8, stsd.end)[0];
    if (!entry) return { miss: 'the video track has no sample description', codec: null };
    const width = v.getUint16(entry.start + 24);
    const height = v.getUint16(entry.start + 26);
    const kids = boxes(moov, entry.start + 78, entry.end);
    let codec: string;
    let description: Uint8Array | undefined;
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      const avcC = kids.find((k) => k.type === 'avcC');
      if (!avcC || avcC.end - avcC.start < 4) return { miss: 'the H.264 track has no usable avcC box', codec: null };
      description = moov.slice(avcC.start, avcC.end);
      codec = `${entry.type}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
      // Parameter sets in the stream: let the element handle it.
      if (entry.type === 'avc3') return { miss: 'H.264 with its parameter sets in the stream (avc3) is left to the element', codec };
    } else if (entry.type === 'vp09') {
      const vpcC = kids.find((k) => k.type === 'vpcC');
      if (!vpcC || vpcC.end - vpcC.start < 7) return { miss: 'the VP9 track has no usable vpcC box', codec: null };
      const profile = moov[vpcC.start + 4];
      const level = moov[vpcC.start + 5];
      const depth = moov[vpcC.start + 6] >> 4;
      codec = `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
    } else if (entry.type === 'av01') {
      const av1C = kids.find((k) => k.type === 'av1C');
      // Some muxers leave av1C empty (ffmpeg with empty_moov): then the sequence header in the first
      // key frame names the profile and level, read once the samples are known (see withAv1Codec).
      codec = (av1C && av1CodecString(moov.subarray(av1C.start, av1C.end))) || AV1_UNKNOWN;
      // AV1 carries its sequence header in the key frames; a decoder is not given the av1C record.
    } else if (entry.type === 'hvc1' || entry.type === 'hev1') {
      const hvcC = kids.find((k) => k.type === 'hvcC');
      if (!hvcC || hvcC.end - hvcC.start < 23) return { miss: 'the HEVC track has no usable hvcC box', codec: null };
      description = moov.slice(hvcC.start, hvcC.end);
      codec = hevcCodecString(entry.type, description);
    } else {
      return { miss: `the video codec ${JSON.stringify(entry.type)} is not one the fast path reads`, codec: entry.type };
    }

    // ---- edit list: the first real edit says which media time shows at presentation time 0 ----
    let shift = 0;
    let delay = 0; // movie-timescale units of empty edit before the first frame
    const edts = child(moov, trak, 'edts');
    const elst = edts && child(moov, edts, 'elst');
    if (elst) {
      const version = moov[elst.start];
      const count = v.getUint32(elst.start + 4);
      let p = elst.start + 8;
      for (let i = 0; i < count && p + 12 <= elst.end; i++) {
        const segment = version === 1 ? v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4) : v.getUint32(p);
        const media = version === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
        p += version === 1 ? 20 : 12;
        if (media === -1) delay += segment;
        else {
          shift = media;
          break;
        }
      }
    }
    return { head: { trackId, timescale, codec, description, width, height, trak, stbl, shift, delayUs: Math.round((delay * 1e6) / movieScale) } };
  }
  return { miss: 'the file has no video track', codec: null };
}

const miss = (note: string, codec: string | null = null): DemuxRead => ({ info: null, container: 'mp4', codec, note });

/** Stands in for the codec string of an AV1 track whose av1C record is empty. */
export const AV1_UNKNOWN = 'av01';

/** Fills in the codec string of an AV1 track from the first key frame, when the file's own record was empty. */
export async function withAv1Codec(blob: Blob, read: DemuxRead, container: 'mp4' | 'webm'): Promise<DemuxRead> {
  const info = read.info;
  if (!info || info.codec !== AV1_UNKNOWN) return read;
  const first = info.samples.find((s) => s.key) ?? info.samples[0];
  const codec = first ? av1CodecFromSample(new Uint8Array(await blob.slice(first.offset, first.offset + Math.min(first.size, 512)).arrayBuffer())) : null;
  if (!codec) return { info: null, container, codec: 'av01', note: 'the AV1 track has no av1C record and its sequence header could not be read' };
  return { ...read, info: { ...info, codec }, codec };
}

/** Reads the sample table of the first video track in a plain moov box (the bytes of the whole box, header included). */
export function readMoov(moov: Uint8Array): DemuxRead {
  try {
    const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    const top = boxes(moov).find((x) => x.type === 'moov');
    if (!top) return miss('no moov box');
    if (boxes(moov, top.start, top.end).some((x) => x.type === 'mvex')) return miss('the file is fragmented, and its fragments were not read');
    const found = readHead(moov, top);
    if ('miss' in found) return miss(found.miss, found.codec);
    const { head } = found;
    const { stbl, timescale } = head;

    // ---- sample tables --------------------------------------------------------------------
    const full = (type: string) => {
      const b = child(moov, stbl, type);
      return b ? { b, count: v.getUint32(b.start + 4), base: b.start + 8 } : null;
    };
    const stts = full('stts');
    const stsz = child(moov, stbl, 'stsz');
    const stsc = full('stsc');
    const stco = full('stco');
    const co64 = full('co64');
    if (!stts || !stsz || !stsc || (!stco && !co64)) return miss('the sample table is incomplete', head.codec);
    const fixedSize = v.getUint32(stsz.start + 4);
    const n = v.getUint32(stsz.start + 8);
    if (n === 0) return miss('the video track has no samples', head.codec);
    if (!fixedSize && stsz.start + 12 + n * 4 > stsz.end) return miss('the sample size table is cut short', head.codec);
    const sizes = new Array<number>(n);
    for (let i = 0; i < n; i++) sizes[i] = fixedSize || v.getUint32(stsz.start + 12 + i * 4);

    const dts = new Array<number>(n);
    const durations = new Array<number>(n);
    let s = 0;
    let t = 0;
    for (let i = 0; i < stts.count && s < n; i++) {
      const c = v.getUint32(stts.base + i * 8);
      const d = v.getUint32(stts.base + i * 8 + 4);
      for (let j = 0; j < c && s < n; j++, s++) {
        dts[s] = t;
        durations[s] = d;
        t += d;
      }
    }
    if (s < n) return miss('the time-to-sample table is shorter than the sample count', head.codec);
    const pts = dts.slice();
    const ctts = full('ctts');
    if (ctts) {
      const signed = moov[ctts.b.start] === 1;
      let k = 0;
      for (let i = 0; i < ctts.count && k < n; i++) {
        const c = v.getUint32(ctts.base + i * 8);
        const o = signed ? v.getInt32(ctts.base + i * 8 + 4) : v.getUint32(ctts.base + i * 8 + 4);
        for (let j = 0; j < c && k < n; j++, k++) pts[k] += o;
      }
    }
    const keys = new Uint8Array(n);
    const stss = full('stss');
    if (stss) for (let i = 0; i < stss.count; i++) keys[v.getUint32(stss.base + i * 4) - 1] = 1;
    else keys.fill(1);

    // Where each sample sits: walk the chunks.
    const offsets = new Array<number>(n);
    const chunkCount = (stco ?? co64)!.count;
    const chunkBase = (stco ?? co64)!.base;
    const runs: Array<[number, number]> = [];
    for (let i = 0; i < stsc.count; i++) runs.push([v.getUint32(stsc.base + i * 12), v.getUint32(stsc.base + i * 12 + 4)]);
    let sample = 0;
    let r = 0;
    for (let c = 1; c <= chunkCount && sample < n; c++) {
      while (r + 1 < runs.length && runs[r + 1][0] <= c) r++;
      let pos = stco ? v.getUint32(chunkBase + (c - 1) * 4) : v.getUint32(chunkBase + (c - 1) * 8) * 2 ** 32 + v.getUint32(chunkBase + (c - 1) * 8 + 4);
      for (let j = 0; j < runs[r][1] && sample < n; j++, sample++) {
        offsets[sample] = pos;
        pos += sizes[sample];
      }
    }
    if (sample < n) return miss('the chunk table does not cover every sample', head.codec);

    const us = (x: number) => Math.round((x * 1e6) / timescale);
    const samples: VideoSample[] = [];
    for (let i = 0; i < n; i++) {
      samples.push({ offset: offsets[i], size: sizes[i], pts: us(pts[i] - head.shift) + head.delayUs, duration: Math.max(1, us(durations[i])), key: keys[i] === 1 });
    }
    const info: VideoTrackInfo = { container: 'mp4', codec: head.codec, description: head.description, width: head.width, height: head.height, samples };
    return { info, container: 'mp4', codec: head.codec, note: '' };
  } catch {
    return miss('the moov box is damaged');
  }
}

/** Reads the sample table of the first video track in a plain moov box. Null if it is not one the fast path reads. */
export function parseMoov(moov: Uint8Array): VideoTrackInfo | null {
  return readMoov(moov).info;
}

// ---- fragmented files --------------------------------------------------------------------

interface Trex {
  duration: number;
  size: number;
  flags: number;
}

/** sample_is_non_sync_sample, bit 16 of the sample flags. */
const NON_SYNC = 0x10000;

class Fragments {
  readonly samples: Array<{ offset: number; size: number; dts: number; cto: number; duration: number; key: boolean }> = [];
  /** Decode time the next sample without a tfdt starts at. */
  private nextDecode = 0;
  /** End (file offset) of the data of the previous traf, for fragments that do not use default-base-is-moof. */
  private prevEnd = 0;

  constructor(
    private readonly trackId: number,
    private readonly trex: Map<number, Trex>,
  ) {}

  /** Adds the samples of one moof box (`b` is the whole box, `at` its file offset). Throws on a damaged one. */
  addMoof(b: Uint8Array, at: number): void {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const top = boxes(b).find((x) => x.type === 'moof');
    if (!top) throw new Error('no moof');
    this.prevEnd = at;
    let first = true;
    for (const traf of boxes(b, top.start, top.end).filter((x) => x.type === 'traf')) {
      const kids = boxes(b, traf.start, traf.end);
      const tfhd = kids.find((x) => x.type === 'tfhd');
      if (!tfhd) throw new Error('traf without tfhd');
      const tfFlags = v.getUint32(tfhd.start) & 0xffffff;
      const id = v.getUint32(tfhd.start + 4);
      let p = tfhd.start + 8;
      let baseOffset: number | null = null;
      if (tfFlags & 0x1) {
        baseOffset = v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4);
        p += 8;
      }
      if (tfFlags & 0x2) p += 4;
      const fallback = this.trex.get(id) ?? { duration: 0, size: 0, flags: 0 };
      const def: Trex = { ...fallback };
      if (tfFlags & 0x8) {
        def.duration = v.getUint32(p);
        p += 4;
      }
      if (tfFlags & 0x10) {
        def.size = v.getUint32(p);
        p += 4;
      }
      if (tfFlags & 0x20) def.flags = v.getUint32(p);
      const base = baseOffset ?? (tfFlags & 0x20000 || first ? at : this.prevEnd);
      first = false;
      const mine = id === this.trackId;
      const tfdt = kids.find((x) => x.type === 'tfdt');
      if (mine && tfdt) {
        this.nextDecode = b[tfdt.start] === 1 ? v.getUint32(tfdt.start + 4) * 2 ** 32 + v.getUint32(tfdt.start + 8) : v.getUint32(tfdt.start + 4);
      }
      let end = base; // where the data of this traf ends
      for (const trun of kids.filter((x) => x.type === 'trun')) {
        const flags = v.getUint32(trun.start) & 0xffffff;
        const signed = b[trun.start] === 1;
        const count = v.getUint32(trun.start + 4);
        let q = trun.start + 8;
        let dataAt = end;
        if (flags & 0x1) {
          dataAt = base + v.getInt32(q);
          q += 4;
        }
        let firstFlags: number | null = null;
        if (flags & 0x4) {
          firstFlags = v.getUint32(q);
          q += 4;
        }
        const perSample = ((flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0)) | 0;
        if (q + count * perSample > trun.end) throw new Error('trun cut short');
        for (let i = 0; i < count; i++) {
          const duration = flags & 0x100 ? v.getUint32(q) : def.duration;
          if (flags & 0x100) q += 4;
          const size = flags & 0x200 ? v.getUint32(q) : def.size;
          if (flags & 0x200) q += 4;
          let sflags = def.flags;
          if (i === 0 && firstFlags !== null) sflags = firstFlags;
          if (flags & 0x400) {
            if (!(i === 0 && firstFlags !== null)) sflags = v.getUint32(q);
            q += 4;
          }
          let cto = 0;
          if (flags & 0x800) {
            cto = signed ? v.getInt32(q) : v.getUint32(q);
            q += 4;
          }
          if (mine) {
            this.samples.push({ offset: dataAt, size, dts: this.nextDecode, cto, duration, key: (sflags & NON_SYNC) === 0 });
            this.nextDecode += duration;
          }
          dataAt += size;
        }
        end = dataAt;
      }
      this.prevEnd = end;
    }
  }
}

/** Reads one box header at `pos`: its type and total size (0 for "to the end of the file"). */
async function headerAt(blob: Blob, pos: number): Promise<{ type: string; size: number } | null> {
  const head = new Uint8Array(await blob.slice(pos, pos + 16).arrayBuffer());
  if (head.length < 8) return null;
  const v = new DataView(head.buffer);
  let size = v.getUint32(0);
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (size === 1) {
    if (head.length < 16) return null;
    size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
  } else if (size === 0) size = blob.size - pos;
  return { type, size };
}

const MAX_BOX = 256 * 1024 * 1024;

/**
 * Reads an MP4 by its box headers: finds moov, and, when it declares fragments (mvex), reads every
 * moof. The picture data is never read. A sidx box is not needed (the fragments are found by walking
 * the file), so a file with or without one comes out the same.
 */
export async function readMp4(blob: Blob): Promise<DemuxRead> {
  try {
    let pos = 0;
    let moov: Uint8Array | null = null;
    let head: TrackHead | null = null;
    let fragments: Fragments | null = null;
    let sawFragment = false;
    for (let guard = 0; guard < 2_000_000 && pos + 8 <= blob.size; guard++) {
      const h = await headerAt(blob, pos);
      if (!h) return miss('the file is cut off inside a box header', head?.codec ?? null);
      if (guard === 0 && h.type !== 'ftyp') return { info: null, container: null, codec: null, note: 'not an MP4' };
      if (h.size < 8) return miss('a box has an impossible size', head?.codec ?? null);
      if (h.type === 'moov') {
        if (h.size > MAX_BOX) return miss('the moov box is too large');
        if (pos + h.size > blob.size) return miss('the file is cut off inside the moov box');
        moov = new Uint8Array(await blob.slice(pos, pos + h.size).arrayBuffer());
        const top = boxes(moov).find((x) => x.type === 'moov');
        if (!top) return miss('the moov box is damaged');
        const mvex = child(moov, top, 'mvex');
        if (!mvex) {
          const plain = readMoov(moov);
          // The moov box can arrive in a file whose media data was cut short: samples must be in the file.
          if (plain.info?.samples.some((x) => x.offset + x.size > blob.size)) return miss('the file is cut off inside its media data', plain.codec);
          return await withAv1Codec(blob, plain, 'mp4');
        }
        const found = readHead(moov, top);
        if ('miss' in found) return miss(found.miss, found.codec);
        head = found.head;
        const trex = new Map<number, Trex>();
        const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
        for (const x of boxes(moov, mvex.start, mvex.end).filter((k) => k.type === 'trex')) {
          trex.set(v.getUint32(x.start + 4), { duration: v.getUint32(x.start + 12), size: v.getUint32(x.start + 16), flags: v.getUint32(x.start + 20) });
        }
        fragments = new Fragments(head.trackId, trex);
      } else if (h.type === 'moof') {
        if (!head || !fragments) return miss('a fragment comes before the moov box');
        if (h.size > MAX_BOX) return miss('a fragment header is too large', head.codec);
        if (pos + h.size > blob.size) return miss('the file is cut off inside a fragment', head.codec);
        fragments.addMoof(new Uint8Array(await blob.slice(pos, pos + h.size).arrayBuffer()), pos);
        sawFragment = true;
      }
      pos += h.size;
    }
    if (!moov) return miss('no moov box');
    if (!head || !fragments) return miss('no video track');
    if (!sawFragment || !fragments.samples.length) return miss('the fragmented file has no video samples', head.codec);
    if (pos < blob.size) return miss('the file ends inside a box', head.codec);

    // Timeline of a fragmented file, as the media element (ffmpeg's demuxer) plays it, which differs
    // from the sample table of a plain file in two ways. The edit list is not applied. And when the
    // composition offsets go negative (ffmpeg's negative_cts_offsets, CMAF), every time is moved
    // later by the most negative one, so that no picture is shown before it is decoded: a file whose
    // first picture is at 0 in the trun plays with it at one frame (or two) in. Matching the element
    // keeps the export the same as the preview; the e2e test compares both on a negative-offset file.
    let lowest = 0;
    for (const s of fragments.samples) lowest = Math.min(lowest, s.cto);
    const us = (x: number) => Math.round((x * 1e6) / head!.timescale);
    const samples: VideoSample[] = [];
    for (const s of fragments.samples) {
      if (s.offset < 0 || s.size <= 0 || s.offset + s.size > blob.size) return miss('a fragment points outside the file (truncated or damaged)', head.codec);
      samples.push({ offset: s.offset, size: s.size, pts: us(s.dts + s.cto - lowest), duration: Math.max(1, us(s.duration)), key: s.key });
    }
    if (!samples[0].key) return miss('the first sample is not a key frame', head.codec);
    const info: VideoTrackInfo = { container: 'mp4', codec: head.codec, description: head.description, width: head.width, height: head.height, samples, fragmented: true };
    return await withAv1Codec(blob, { info, container: 'mp4', codec: head.codec, note: '' }, 'mp4');
  } catch {
    return miss('the file is damaged');
  }
}

/** Finds the moov box by reading only box headers, then reads it. Null if the file is not an MP4 the fast path reads. */
export async function openMp4(blob: Blob): Promise<VideoTrackInfo | null> {
  return (await readMp4(blob)).info;
}
