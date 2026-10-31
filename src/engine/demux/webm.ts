// WebM (Matroska) demuxer for the fast export path. Reads the first video track's blocks with their
// file offsets: only element headers and block headers are read, never the picture data. Handles
// recorder files (unknown-size segment and clusters, no cues, no duration) and plain files. VP8,
// VP9 and AV1 (CodecPrivate is the av1C record); anything else (lacing, encryption, other codecs)
// is a miss with a note saying why, and the export seeks. Nothing here throws.
import { av1CodecString } from './av1';
import { AV1_UNKNOWN, withAv1Codec } from './mp4';
import type { DemuxRead, VideoSample, VideoTrackInfo } from './types';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
};

/** Elements whose children we read in place instead of skipping. */
const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Cluster, ID.BlockGroup]);

/** Reads a blob through a sliding window, so header reads do not each cost a slice. */
class Reader {
  private win = new Uint8Array(0);
  private winStart = 0;
  constructor(
    private blob: Blob,
    private windowSize = 1 << 20,
  ) {}

  get size(): number {
    return this.blob.size;
  }

  async bytes(pos: number, len: number): Promise<Uint8Array> {
    if (pos < this.winStart || pos + len > this.winStart + this.win.length) {
      const start = pos;
      const end = Math.min(this.blob.size, pos + Math.max(len, this.windowSize));
      this.win = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
      this.winStart = start;
    }
    return this.win.subarray(pos - this.winStart, pos - this.winStart + len);
  }
}

interface Header {
  id: number;
  /** Payload size, or -1 when unknown. */
  size: number;
  /** Bytes taken by the id and size fields. */
  header: number;
}

async function readHeader(r: Reader, pos: number): Promise<Header | null> {
  if (pos >= r.size) return null;
  const first = await r.bytes(pos, Math.min(12, r.size - pos));
  if (first.length < 2) return null;
  const idLen = first[0] >= 0x80 ? 1 : first[0] >= 0x40 ? 2 : first[0] >= 0x20 ? 3 : first[0] >= 0x10 ? 4 : 0;
  if (!idLen || first.length < idLen + 1) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + first[i];
  const s0 = first[idLen];
  let sizeLen = 1;
  while (sizeLen <= 8 && !(s0 & (0x80 >> (sizeLen - 1)))) sizeLen++;
  if (sizeLen > 8 || first.length < idLen + sizeLen) return null;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const b = first[idLen + i];
    size = size * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? -1 : size, header: idLen + sizeLen };
}

async function readUint(r: Reader, pos: number, size: number): Promise<number> {
  const b = await r.bytes(pos, size);
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[i];
  return v;
}

/** The vint at the start of a block: the track number and the bytes it took. */
function vint(b: Uint8Array): { value: number; length: number } {
  let length = 1;
  while (length <= 8 && !(b[0] & (0x80 >> (length - 1)))) length++;
  let value = b[0] & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + b[i];
  return { value, length };
}

interface RawTrack {
  number: number;
  type: number;
  codec: string;
  width: number;
  height: number;
  priv?: Uint8Array;
}

const miss = (note: string, codec: string | null = null): DemuxRead => ({ info: null, container: 'webm', codec, note });

export async function openWebm(blob: Blob): Promise<VideoTrackInfo | null> {
  return (await readWebm(blob)).info;
}

export async function readWebm(blob: Blob): Promise<DemuxRead> {
  try {
    return await readWebmUnsafe(blob);
  } catch {
    return miss('the file is damaged');
  }
}

async function readWebmUnsafe(blob: Blob): Promise<DemuxRead> {
  const r = new Reader(blob);
  const head = await readHeader(r, 0);
  if (!head || head.id !== ID.EBML || head.size < 0) return { info: null, container: null, codec: null, note: 'not a WebM' };
  let pos = head.header + head.size;
  let timecodeScale = 1_000_000;
  const tracks: RawTrack[] = [];
  let current: RawTrack | null = null;
  let videoNumber = -1;
  let clusterTime = 0;
  const blocks: Array<{ offset: number; size: number; time: number; key: boolean; duration: number }> = [];
  let group: { key: boolean; duration: number } | null = null;
  let earliest = Infinity;

  for (let guard = 0; guard < 50_000_000; guard++) {
    const h = await readHeader(r, pos);
    if (!h) break;
    const body = pos + h.header;
    if (MASTERS.has(h.id)) {
      if (h.id === ID.TrackEntry) {
        current = { number: 0, type: 0, codec: '', width: 0, height: 0 };
        tracks.push(current);
      } else if (h.id === ID.BlockGroup) group = { key: true, duration: 0 };
      pos = body; // read the children next
      continue;
    }
    if (h.size < 0) return miss('an element of unknown size where a size is needed'); // unknown size on a non-master element
    switch (h.id) {
      case ID.TimecodeScale:
        timecodeScale = await readUint(r, body, h.size);
        break;
      case ID.TrackNumber:
        if (current) current.number = await readUint(r, body, h.size);
        break;
      case ID.TrackType:
        if (current) current.type = await readUint(r, body, h.size);
        break;
      case ID.CodecID:
        if (current) current.codec = String.fromCharCode(...(await r.bytes(body, h.size)));
        break;
      case ID.CodecPrivate:
        if (current) current.priv = (await r.bytes(body, h.size)).slice();
        break;
      case ID.PixelWidth:
        if (current) current.width = await readUint(r, body, h.size);
        break;
      case ID.PixelHeight:
        if (current) current.height = await readUint(r, body, h.size);
        break;
      case ID.Timecode:
        clusterTime = await readUint(r, body, h.size);
        break;
      case ID.ReferenceBlock:
        if (group) group.key = false;
        break;
      case ID.BlockDuration:
        if (group) group.duration = await readUint(r, body, h.size);
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        if (videoNumber < 0) {
          const v = tracks.find((t) => t.type === 1);
          if (!v) return miss('the file has no video track');
          videoNumber = v.number;
        }
        const hdr = await r.bytes(body, Math.min(h.size, 12));
        const t = vint(hdr);
        const rel = (hdr[t.length] << 8) | hdr[t.length + 1];
        // A media element starts its clock at the earliest block of any track.
        earliest = Math.min(earliest, clusterTime + (rel > 0x7fff ? rel - 0x10000 : rel));
        if (t.value === videoNumber) {
          const flags = hdr[t.length + 2];
          if (flags & 0x06) return miss('the video blocks use lacing'); // not used for video, bail out rather than guess
          const signed = rel > 0x7fff ? rel - 0x10000 : rel;
          const dataStart = body + t.length + 3;
          blocks.push({
            offset: dataStart,
            size: h.size - (t.length + 3),
            time: clusterTime + signed,
            key: h.id === ID.SimpleBlock ? (flags & 0x80) !== 0 : (group?.key ?? true),
            duration: group?.duration ?? 0,
          });
        }
        if (h.id === ID.Block) group = null;
        break;
      }
      default:
        break;
    }
    pos = body + h.size;
  }

  const track = tracks.find((t) => t.type === 1);
  if (!track) return miss('the file has no video track');
  let codec: string;
  if (track.codec === 'V_VP8') codec = 'vp8';
  else if (track.codec === 'V_VP9') codec = 'vp09.00.10.08';
  else if (track.codec === 'V_AV1') {
    // CodecPrivate is the av1C record; if it is missing or empty the key frame's sequence header names the codec.
    codec = (track.priv && av1CodecString(track.priv)) || AV1_UNKNOWN;
  } else return miss(`the video codec ${track.codec || '(unnamed)'} is not one the fast path reads`, track.codec || null);
  if (!blocks.length) return miss('the video track has no blocks', codec);
  const toUs = (t: number) => Math.round((t * timecodeScale) / 1000);
  blocks.sort((a, b) => a.time - b.time);
  const first = Math.min(earliest, blocks[0].time);
  const samples: VideoSample[] = blocks.map((b, i) => {
    const next = blocks[i + 1]?.time;
    const dur = b.duration ? toUs(b.duration) : next !== undefined && next > b.time ? toUs(next - b.time) : i > 0 ? toUs(b.time - blocks[i - 1].time) : 33333;
    return { offset: b.offset, size: b.size, pts: toUs(b.time - first), duration: Math.max(1, dur), key: b.key };
  });
  if (!samples[0].key) return miss('the first video block is not a key frame', codec);
  const last = samples.reduce((m, s) => Math.max(m, s.offset + s.size), 0);
  if (last > blob.size) return miss('the file is cut off inside a video block', codec);
  const info: VideoTrackInfo = { container: 'webm', codec, width: track.width, height: track.height, samples };
  return await withAv1Codec(blob, { info, container: 'webm', codec, note: '' }, 'webm');
}
