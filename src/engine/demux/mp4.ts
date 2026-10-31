// MP4 demuxer for the fast export path: finds the video track's sample table (stts, ctts, stss,
// stsc, stsz, stco/co64, edit list) in the moov box. Handles H.264 (avc1/avc3) and VP9 (vp09)
// in non-fragmented files. Anything else returns null and the export seeks as before.
import type { VideoSample, VideoTrackInfo } from './types';

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

/** Reads the sample table of the first video track in a moov box (the bytes of the whole box, header included). */
export function parseMoov(moov: Uint8Array): VideoTrackInfo | null {
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const top = boxes(moov).find((x) => x.type === 'moov');
  if (!top) return null;
  if (boxes(moov, top.start, top.end).some((x) => x.type === 'mvex')) return null; // fragmented
  const mvhd = child(moov, top, 'mvhd');
  const movieScale = mvhd ? v.getUint32(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12)) : 1000;
  for (const trak of boxes(moov, top.start, top.end).filter((x) => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!mdia || !hdlr) continue;
    if (String.fromCharCode(...moov.subarray(hdlr.start + 8, hdlr.start + 12)) !== 'vide') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const minf = child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    if (!mdhd || !stbl) return null;
    const timescale = v.getUint32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
    if (!timescale) return null;

    // ---- sample description --------------------------------------------------------------
    const stsd = child(moov, stbl, 'stsd');
    if (!stsd) return null;
    const entry = boxes(moov, stsd.start + 8, stsd.end)[0];
    if (!entry) return null;
    const width = v.getUint16(entry.start + 24);
    const height = v.getUint16(entry.start + 26);
    const kids = boxes(moov, entry.start + 78, entry.end);
    let codec: string;
    let description: Uint8Array | undefined;
    if (entry.type === 'avc1' || entry.type === 'avc3') {
      const avcC = kids.find((k) => k.type === 'avcC');
      if (!avcC || avcC.end - avcC.start < 4) return null;
      description = moov.slice(avcC.start, avcC.end);
      codec = `${entry.type}.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
      if (entry.type === 'avc3') return null; // parameter sets in the stream: let the element handle it
    } else if (entry.type === 'vp09') {
      const vpcC = kids.find((k) => k.type === 'vpcC');
      if (!vpcC) return null;
      const profile = moov[vpcC.start + 4];
      const level = moov[vpcC.start + 5];
      const depth = moov[vpcC.start + 6] >> 4;
      codec = `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
    } else {
      return null;
    }

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
    if (!stts || !stsz || !stsc || (!stco && !co64)) return null;
    const fixedSize = v.getUint32(stsz.start + 4);
    const n = v.getUint32(stsz.start + 8);
    if (n === 0) return null;
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
    if (s < n) return null;
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
    if (sample < n) return null;

    // ---- edit list: the first real edit says which media time shows at presentation time 0 ----
    let shift = 0; // media-timescale units to subtract from pts
    let delay = 0; // movie-timescale units of empty edit before the first frame
    const elst = child(moov, trak, 'edts') && child(moov, child(moov, trak, 'edts')!, 'elst');
    if (elst) {
      const version = moov[elst.start];
      const count = v.getUint32(elst.start + 4);
      let p = elst.start + 8;
      for (let i = 0; i < count; i++) {
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
    const us = (x: number) => Math.round((x * 1e6) / timescale);
    const delayUs = Math.round((delay * 1e6) / movieScale);
    const samples: VideoSample[] = [];
    for (let i = 0; i < n; i++) {
      samples.push({ offset: offsets[i], size: sizes[i], pts: us(pts[i] - shift) + delayUs, duration: Math.max(1, us(durations[i])), key: keys[i] === 1 });
    }
    return { container: 'mp4', codec, description, width, height, samples };
  }
  return null;
}

/** Finds the moov box by reading only box headers, then reads that box. Null if the file is not a plain MP4. */
export async function openMp4(blob: Blob): Promise<VideoTrackInfo | null> {
  let p = 0;
  for (let guard = 0; guard < 64 && p + 8 <= blob.size; guard++) {
    const head = new Uint8Array(await blob.slice(p, p + 16).arrayBuffer());
    if (head.length < 8) return null;
    const v = new DataView(head.buffer);
    let size = v.getUint32(0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (guard === 0 && type !== 'ftyp') return null;
    if (size === 1 && head.length >= 16) size = v.getUint32(8) * 2 ** 32 + v.getUint32(12);
    else if (size === 0) size = blob.size - p;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 256 * 1024 * 1024) return null;
      return parseMoov(new Uint8Array(await blob.slice(p, p + size).arrayBuffer()));
    }
    p += size;
  }
  return null;
}
