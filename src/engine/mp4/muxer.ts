// Minimal ISO-BMFF (MP4) writer for WebCodecs output: one H.264 video track and one AAC or
// Opus audio track. Writes a progressive ("faststart") file: ftyp, moov, then mdat, with
// samples interleaved in roughly one-second chunks so players can start immediately.

export interface VideoTrackConfig {
  codec: 'avc';
  width: number;
  height: number;
  /** AVCDecoderConfigurationRecord (WebCodecs decoderConfig.description with format "avc"). */
  description: Uint8Array;
  timescale?: number;
}

export interface AudioTrackConfig {
  codec: 'aac' | 'opus';
  sampleRate: number;
  channels: number;
  /** AAC: AudioSpecificConfig. Opus: OpusHead (optional). */
  description?: Uint8Array;
}

interface Sample {
  /** Dropped (set empty) once the bytes have gone to a streaming sink. */
  data: Uint8Array;
  /** Byte length, kept after `data` is released. */
  size: number;
  /** Presentation time in the track timescale. */
  pts: number;
  duration: number;
  key: boolean;
}

interface TrackState {
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  samples: Sample[];
}

const MOVIE_TIMESCALE = 1000;

class Bytes {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.length, v);
    this.length += 2;
    return this;
  }

  u24(v: number): this {
    return this.u8((v >>> 16) & 0xff).u16(v & 0xffff);
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
    return this;
  }

  u64(v: number): this {
    return this.u32(Math.floor(v / 2 ** 32)).u32(v % 2 ** 32);
  }

  str(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  done(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length);
  }
}

function box(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + children.reduce((s, c) => s + c.length, 0);
  const b = new Bytes().u32(size).str(type);
  for (const c of children) b.bytes(c);
  return b.done();
}

function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return box(type, new Bytes().u8(version).u24(flags).done(), ...children);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
function matrix(b: Bytes): Bytes {
  for (const m of MATRIX) b.u32(m);
  return b;
}

/** Variable-length MPEG-4 descriptor (tag + size). */
function descriptor(tag: number, body: Uint8Array): Uint8Array {
  const b = new Bytes().u8(tag);
  let size = body.length;
  const sizeBytes: number[] = [];
  do {
    sizeBytes.unshift(size & 0x7f);
    size >>>= 7;
  } while (size > 0);
  sizeBytes.forEach((s, i) => b.u8(i < sizeBytes.length - 1 ? s | 0x80 : s));
  return b.bytes(body).done();
}

/** AAC-LC AudioSpecificConfig, used when the encoder does not supply one. */
export function aacAudioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const index = rates.indexOf(sampleRate);
  if (index < 0) throw new Error(`Unsupported AAC sample rate ${sampleRate}`);
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
}

/** Where a streaming muxer sends its bytes: a file on disk (File System Access or OPFS), or anything else. */
export interface ByteSink {
  /** Writes `data` at byte `position` of the output (always given; appends arrive in order). */
  write(data: Uint8Array, position: number): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(): Promise<void> | void;
}

export interface MuxerOptions {
  /**
   * Streaming mode: ftyp, then a 64-bit-size mdat that grows as samples arrive, then moov at the
   * end (and the mdat size patched in place). Memory stays flat. The output sink must accept
   * positional writes (files do). Without a sink the muxer builds a faststart Blob in finalize().
   */
  sink?: ByteSink;
}

const EMPTY = new Uint8Array(0);

export class Mp4Muxer {
  private video: TrackState | null = null;
  private audio: TrackState | null = null;
  private finished = false;
  // ---- streaming state (only used with a sink) ----
  private readonly sink: ByteSink | null;
  private writes: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private queuedBytes = 0;
  private position = 0;
  private mdatStart = 0;
  private origin = new Map<TrackState, number>();
  private open = new Map<TrackState, Chunk>();
  private ready = new Map<TrackState, Chunk[]>();
  private floor = new Map<TrackState, number>();
  private ended = new Set<TrackState>();
  private emitted: Chunk[] = [];
  private offsets = new Map<Chunk, number>();
  /** Number of write calls handed to the sink so far (tests and progress use it). */
  writeCount = 0;

  constructor(
    private videoConfig: VideoTrackConfig | null,
    private audioConfig: AudioTrackConfig | null,
    options: MuxerOptions = {},
  ) {
    let id = 1;
    if (videoConfig) this.video = { id: id++, kind: 'video', timescale: videoConfig.timescale ?? 90000, samples: [] };
    if (audioConfig) this.audio = { id: id++, kind: 'audio', timescale: audioConfig.sampleRate, samples: [] };
    if (!this.video && !this.audio) throw new Error('An MP4 needs at least one track');
    this.sink = options.sink ?? null;
    if (this.sink) {
      const ftyp = this.ftyp();
      this.emit(ftyp);
      this.mdatStart = ftyp.length;
      this.emit(new Bytes().u32(1).str('mdat').u64(0).done());
    }
  }

  private ftyp(): Uint8Array<ArrayBuffer> {
    return this.video
      ? box('ftyp', new Bytes().str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41').done())
      : box('ftyp', new Bytes().str('M4A ').u32(0x200).str('M4A ').str('mp42').str('isom').str('iso2').done());
  }

  /** Video description often only arrives with the first encoded chunk's metadata. */
  setVideoDescription(description: Uint8Array): void {
    if (this.videoConfig) this.videoConfig.description = description;
  }

  setAudioDescription(description: Uint8Array): void {
    if (this.audioConfig) this.audioConfig.description = description;
  }

  /** Adds an encoded sample. Times are in microseconds, as WebCodecs reports them. */
  addVideoSample(data: Uint8Array, timestampUs: number, durationUs: number, key: boolean): void {
    this.add(this.video, data, timestampUs, durationUs, key);
  }

  addAudioSample(data: Uint8Array, timestampUs: number, durationUs: number): void {
    this.add(this.audio, data, timestampUs, durationUs, true);
  }

  private add(track: TrackState | null, data: Uint8Array, ts: number, dur: number, key: boolean): void {
    if (!track) throw new Error('Track not configured');
    if (this.finished) throw new Error('Muxer already finalized');
    const k = track.timescale / 1e6;
    let pts = Math.round(ts * k);
    const sample: Sample = { data, size: data.length, pts, duration: Math.max(1, Math.round(dur * k)), key };
    if (!this.sink) {
      track.samples.push(sample);
      return;
    }
    // Streaming: times are rebased on the track's first sample, and samples are grouped into
    // roughly one-second chunks as they arrive.
    if (!this.origin.has(track)) this.origin.set(track, pts);
    pts -= this.origin.get(track)!;
    sample.pts = pts;
    track.samples.push(sample);
    const floor = Math.max(this.floor.get(track) ?? 0, pts);
    this.floor.set(track, floor);
    let current = this.open.get(track);
    if (!current || floor - current.start >= track.timescale) {
      if (current) this.queue(track).push(current);
      current = { track, samples: [], start: floor, bytes: 0 };
      this.open.set(track, current);
    }
    current.samples.push(sample);
    current.bytes += data.length;
    this.pump();
  }

  private queue(track: TrackState): Chunk[] {
    let q = this.ready.get(track);
    if (!q) this.ready.set(track, (q = []));
    return q;
  }

  /** Writes ready chunks to the sink in time order, once every unfinished track has one waiting. */
  private pump(): void {
    const tracks = [this.video, this.audio].filter((t): t is TrackState => !!t);
    for (;;) {
      let head: Chunk | null = null;
      for (const t of tracks) {
        const q = this.ready.get(t);
        if (q?.length) {
          const c = q[0];
          if (!head || c.start / t.timescale < head.start / head.track.timescale) head = c;
        } else if (!this.ended.has(t)) {
          return; // this track has not produced a whole chunk yet; its next one may start earlier
        }
      }
      if (!head) return;
      this.ready.get(head.track)!.shift();
      this.offsets.set(head, this.position);
      this.emitted.push(head);
      for (const s of head.samples) {
        this.emit(s.data);
        s.data = EMPTY;
      }
    }
  }

  private emit(data: Uint8Array, position?: number): void {
    const at = position ?? this.position;
    if (position === undefined) this.position += data.length;
    const sink = this.sink!;
    this.queuedBytes += data.length;
    this.writeCount++;
    this.writes = this.writes.then(async () => {
      if (this.writeError) return;
      try {
        await sink.write(data, at);
      } catch (e) {
        this.writeError = e;
      } finally {
        this.queuedBytes -= data.length;
      }
    });
  }

  /** Streaming only: resolves when no more than `maxBytes` wait to be written. Throws if a write failed. */
  async drain(maxBytes = 0): Promise<void> {
    while (this.queuedBytes > maxBytes && !this.writeError) await this.writes;
    if (this.writeError) throw this.writeError;
  }

  /** Bytes handed to the sink so far (streaming only). */
  get bytesWritten(): number {
    return this.position;
  }

  /** Streaming: declares that a track will receive no more samples (lets its chunks flush). */
  endTrack(kind: 'video' | 'audio'): void {
    const t = kind === 'video' ? this.video : this.audio;
    if (!t || !this.sink) return;
    const current = this.open.get(t);
    if (current) {
      this.queue(t).push(current);
      this.open.delete(t);
    }
    this.ended.add(t);
    this.pump();
  }

  /** Streaming: stops writing and aborts the sink (which discards the partial file where it can). */
  async abort(): Promise<void> {
    this.finished = true;
    await this.writes.catch(() => undefined);
    await this.sink?.abort?.();
  }

  /**
   * Streaming: writes the rest of the chunks, the moov box and the final mdat size, then closes
   * the sink. Resolves to the file size.
   */
  async finalizeStream(): Promise<number> {
    if (!this.sink) throw new Error('finalizeStream needs a sink');
    if (this.finished) throw new Error('Muxer already finalized');
    this.finished = true;
    this.endTrack('video');
    this.endTrack('audio');
    const tracks = [this.video, this.audio].filter((t): t is TrackState => !!t && t.samples.length > 0);
    if (!tracks.length) {
      await this.sink.abort?.();
      throw new Error('Nothing was encoded');
    }
    this.pump();
    const payloadEnd = this.position;
    const co64 = payloadEnd > 0xfffffff0 - 1_000_000;
    const moov = this.moov(tracks, this.emitted, this.offsets, co64);
    this.emit(moov);
    this.emit(new Bytes().u64(payloadEnd - this.mdatStart).done(), this.mdatStart + 8);
    await this.drain(0);
    await this.sink.close();
    return this.position;
  }

  /** Produces the file. Sample data is referenced, not copied, so memory stays flat. */
  finalize(): Blob {
    if (this.sink) throw new Error('This muxer streams to a sink: call finalizeStream()');
    if (this.finished) throw new Error('Muxer already finalized');
    this.finished = true;
    const tracks = [this.video, this.audio].filter((t): t is TrackState => !!t && t.samples.length > 0);
    if (!tracks.length) throw new Error('Nothing was encoded');
    for (const t of tracks) normaliseTimes(t);

    // Interleave: chunks of up to ~1 second per track, ordered by start time.
    const chunks = buildChunks(tracks);
    const mdatPayload = chunks.reduce((s, c) => s + c.bytes, 0);
    const large = mdatPayload + 16 > 0xffffffff;
    const ftyp = this.ftyp();
    const useCo64 = ftyp.length + mdatPayload > 0xfffffff0 - 1_000_000;
    // Box sizes do not depend on offset values: measure once, then write real offsets.
    let moov = this.moov(tracks, chunks, chunkOffsets(chunks, 0), useCo64);
    const mdatHeaderSize = large ? 16 : 8;
    const dataStart = ftyp.length + moov.length + mdatHeaderSize;
    moov = this.moov(tracks, chunks, chunkOffsets(chunks, dataStart), useCo64);
    const mdatHeader = large
      ? new Bytes().u32(1).str('mdat').u64(mdatPayload + 16).done()
      : new Bytes().u32(mdatPayload + 8).str('mdat').done();
    const parts: BlobPart[] = [ftyp, moov, mdatHeader];
    for (const c of chunks) for (const s of c.samples) parts.push(s.data as Uint8Array<ArrayBuffer>);
    return new Blob(parts, { type: 'video/mp4' });
  }

  private moov(tracks: TrackState[], chunks: Chunk[], offsets: Map<Chunk, number>, co64: boolean): Uint8Array<ArrayBuffer> {
    const movieDuration = Math.max(...tracks.map((t) => (trackDuration(t) / t.timescale) * MOVIE_TIMESCALE));
    const mvhd = fullBox(
      'mvhd',
      0,
      0,
      matrix(
        new Bytes()
          .u32(0)
          .u32(0)
          .u32(MOVIE_TIMESCALE)
          .u32(Math.round(movieDuration))
          .u32(0x00010000)
          .u16(0x0100)
          .zeros(10),
      )
        .zeros(24)
        .u32(tracks.length + 1)
        .done(),
    );
    const traks = tracks.map((t) =>
      this.trak(
        t,
        chunks.filter((c) => c.track === t),
        offsets,
        co64,
      ),
    );
    return box('moov', mvhd, ...traks);
  }

  private trak(t: TrackState, chunks: Chunk[], offsets: Map<Chunk, number>, co64: boolean): Uint8Array {
    const isVideo = t.kind === 'video';
    const vc = this.videoConfig;
    const duration = trackDuration(t);
    const movieDur = Math.round((duration / t.timescale) * MOVIE_TIMESCALE);
    const tkhd = fullBox(
      'tkhd',
      0,
      3,
      matrix(
        new Bytes()
          .u32(0)
          .u32(0)
          .u32(t.id)
          .u32(0)
          .u32(movieDur)
          .zeros(8)
          .u16(0)
          .u16(0)
          .u16(isVideo ? 0 : 0x0100)
          .u16(0),
      )
        .u32(isVideo && vc ? vc.width * 0x10000 : 0)
        .u32(isVideo && vc ? vc.height * 0x10000 : 0)
        .done(),
    );
    const mdhd = fullBox(
      'mdhd',
      0,
      0,
      new Bytes().u32(0).u32(0).u32(t.timescale).u32(duration).u16(0x55c4).u16(0).done(),
    );
    const hdlr = fullBox(
      'hdlr',
      0,
      0,
      new Bytes()
        .u32(0)
        .str(isVideo ? 'vide' : 'soun')
        .zeros(12)
        .str(isVideo ? 'Capstan Video' : 'Capstan Audio')
        .u8(0)
        .done(),
    );
    const header = isVideo
      ? fullBox('vmhd', 0, 1, new Bytes().zeros(8).done())
      : fullBox('smhd', 0, 0, new Bytes().zeros(4).done());
    const dinf = box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1).done(), fullBox('url ', 0, 1)));
    const stbl = box('stbl', ...this.sampleTables(t, chunks, offsets, co64));
    const minf = box('minf', header, dinf, stbl);
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  }

  private sampleEntry(t: TrackState): Uint8Array {
    if (t.kind === 'video') {
      const vc = this.videoConfig!;
      if (!vc.description?.length) throw new Error('Missing H.264 decoder configuration');
      const body = new Bytes()
        .zeros(6)
        .u16(1)
        .zeros(16)
        .u16(vc.width)
        .u16(vc.height)
        .u32(0x00480000)
        .u32(0x00480000)
        .u32(0)
        .u16(1)
        // compressorname: fixed 32 bytes (length byte + name + padding).
        .u8(7)
        .str('Capstan')
        .zeros(24)
        .u16(0x0018)
        .i16(-1)
        .done();
      return box('avc1', body, box('avcC', vc.description));
    }
    const ac = this.audioConfig!;
    const audioBody = () =>
      new Bytes()
        .zeros(6)
        .u16(1)
        .zeros(8)
        .u16(ac.channels)
        .u16(16)
        .u16(0)
        .u16(0)
        .u32(Math.min(65535, ac.sampleRate) * 0x10000)
        .done();
    if (ac.codec === 'aac') {
      const asc = ac.description?.length ? ac.description : aacAudioSpecificConfig(ac.sampleRate, ac.channels);
      const decoderSpecific = descriptor(0x05, asc);
      const decoderConfig = descriptor(
        0x04,
        new Bytes().u8(0x40).u8(0x15).u24(0).u32(0).u32(0).bytes(decoderSpecific).done(),
      );
      const sl = descriptor(0x06, new Uint8Array([0x02]));
      const es = descriptor(0x03, new Bytes().u16(t.id).u8(0).bytes(decoderConfig).bytes(sl).done());
      return box('mp4a', audioBody(), fullBox('esds', 0, 0, es));
    }
    // Opus in ISO-BMFF: "Opus" sample entry with a dOps box (big-endian, unlike OpusHead).
    let preSkip = 312;
    const head = ac.description;
    if (head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead') {
      preSkip = head[10] | (head[11] << 8);
    }
    const dOps = box(
      'dOps',
      new Bytes().u8(0).u8(ac.channels).u16(preSkip).u32(ac.sampleRate).i16(0).u8(0).done(),
    );
    return box('Opus', audioBody(), dOps);
  }

  private sampleTables(t: TrackState, chunks: Chunk[], offsets: Map<Chunk, number>, co64: boolean): Uint8Array[] {
    const samples = chunks.flatMap((c) => c.samples);
    const stsd = fullBox('stsd', 0, 0, new Bytes().u32(1).done(), this.sampleEntry(t));

    // Decode times: samples are stored in decode order; DTS is the sorted PTS sequence.
    const dts = samples.map((s) => s.pts).sort((a, b) => a - b);
    const sttsRuns: Array<[number, number]> = [];
    for (let i = 0; i < samples.length; i++) {
      const delta = i + 1 < samples.length ? dts[i + 1] - dts[i] : samples[i].duration;
      const last = sttsRuns[sttsRuns.length - 1];
      if (last && last[1] === delta) last[0]++;
      else sttsRuns.push([1, delta]);
    }
    const stts = new Bytes().u32(sttsRuns.length);
    for (const [n, d] of sttsRuns) stts.u32(n).u32(d);

    const out: Uint8Array[] = [stsd, fullBox('stts', 0, 0, stts.done())];

    const offsetsNeeded = samples.some((s, i) => s.pts !== dts[i]);
    if (offsetsNeeded) {
      const runs: Array<[number, number]> = [];
      samples.forEach((s, i) => {
        const o = s.pts - dts[i];
        const last = runs[runs.length - 1];
        if (last && last[1] === o) last[0]++;
        else runs.push([1, o]);
      });
      const ctts = new Bytes().u32(runs.length);
      for (const [n, o] of runs) ctts.u32(n).i32(o);
      out.push(fullBox('ctts', 1, 0, ctts.done()));
    }

    if (t.kind === 'video') {
      const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
      if (keys.length < samples.length) {
        const stss = new Bytes().u32(keys.length);
        for (const k of keys) stss.u32(k);
        out.push(fullBox('stss', 0, 0, stss.done()));
      }
    }

    const stscRuns: Array<[number, number]> = [];
    chunks.forEach((c, i) => {
      const last = stscRuns[stscRuns.length - 1];
      if (!last || last[1] !== c.samples.length) stscRuns.push([i + 1, c.samples.length]);
    });
    const stsc = new Bytes().u32(stscRuns.length);
    for (const [first, n] of stscRuns) stsc.u32(first).u32(n).u32(1);
    out.push(fullBox('stsc', 0, 0, stsc.done()));

    const stsz = new Bytes().u32(0).u32(samples.length);
    for (const s of samples) stsz.u32(s.size);
    out.push(fullBox('stsz', 0, 0, stsz.done()));

    const co = new Bytes().u32(chunks.length);
    for (const c of chunks) {
      const o = offsets.get(c)!;
      if (co64) co.u64(o);
      else co.u32(o);
    }
    out.push(fullBox(co64 ? 'co64' : 'stco', 0, 0, co.done()));
    return out;
  }
}

interface Chunk {
  track: TrackState;
  samples: Sample[];
  start: number;
  bytes: number;
}

/** File offset of each chunk when they are written back to back from `dataStart`. */
function chunkOffsets(chunks: Chunk[], dataStart: number): Map<Chunk, number> {
  let offset = dataStart;
  const offsets = new Map<Chunk, number>();
  for (const c of chunks) {
    offsets.set(c, offset);
    offset += c.bytes;
  }
  return offsets;
}

/** Shifts a track so its first presentation time is zero. */
function normaliseTimes(t: TrackState): void {
  const first = Math.min(...t.samples.map((s) => s.pts));
  if (first !== 0) for (const s of t.samples) s.pts -= first;
}

function trackDuration(t: TrackState): number {
  let end = 0;
  for (const s of t.samples) end = Math.max(end, s.pts + s.duration);
  return end;
}

function buildChunks(tracks: TrackState[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const t of tracks) {
    let current: Chunk | null = null;
    // Chunk start times must rise within a track (B-frames make raw PTS non-monotonic), or
    // the cross-track sort below could reorder one track's own chunks.
    let floor = 0;
    for (const s of t.samples) {
      floor = Math.max(floor, s.pts);
      if (!current || floor - current.start >= t.timescale) {
        current = { track: t, samples: [], start: floor, bytes: 0 };
        chunks.push(current);
      }
      current.samples.push(s);
      current.bytes += s.data.length;
    }
  }
  return chunks.sort((a, b) => a.start / a.track.timescale - b.start / b.track.timescale);
}
