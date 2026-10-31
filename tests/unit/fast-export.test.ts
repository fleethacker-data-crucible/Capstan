import { expect, test } from 'bun:test';
import { av1CodecFromSample, av1CodecString } from '../../src/engine/demux/av1';
import { type DecodeDecision, choosePath, codecFamily, describeDecisions } from '../../src/engine/demux/choose';
import { hevcCodecString, openMp4, readMp4 } from '../../src/engine/demux/mp4';
import { readWebm } from '../../src/engine/demux/webm';
import { readVideo } from '../../src/engine/fastdecode';

// ---- a tiny fragmented-MP4 writer, so the box parsing is tested on bytes made here ------------

type Bytes = Uint8Array | number[];

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const join = (...parts: Bytes[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const box = (type: string, ...parts: Bytes[]): Uint8Array => {
  const body = join(...parts);
  return join(u32(8 + body.length), Array.from(type, (c) => c.charCodeAt(0)), body);
};
const full = (type: string, version: number, flags: number, ...parts: Bytes[]) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

const KEY = 0x02000000; // sample_depends_on = 2: a key frame
const DELTA = 0x01010000; // depends on others, non-sync

function moov(opts: { timescale: number; trackId: number; withSecondTrack?: boolean }): Uint8Array {
  const avc1 = box('avc1', new Array(24).fill(0), u16(320), u16(180), new Array(50).fill(0), box('avcC', [1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0, 1]));
  const track = (id: number, handler: string, entry: Uint8Array) =>
    box(
      'trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(id), new Array(68).fill(0)),
      box(
        'mdia',
        full('mdhd', 0, 0, u32(0), u32(0), u32(opts.timescale), u32(0), u16(0), u16(0)),
        full('hdlr', 0, 0, u32(0), Array.from(handler, (c) => c.charCodeAt(0)), new Array(13).fill(0)),
        box('minf', box('stbl', full('stsd', 0, 0, u32(1), entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)))),
      ),
    );
  const trex = (id: number) => full('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0));
  const tracks = [track(opts.trackId, 'vide', avc1)];
  const trexes = [trex(opts.trackId)];
  if (opts.withSecondTrack) {
    tracks.push(track(opts.trackId + 1, 'soun', box('mp4a', new Array(28).fill(0))));
    trexes.push(trex(opts.trackId + 1));
  }
  return box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(opts.timescale), u32(0), new Array(80).fill(0)), ...tracks, box('mvex', ...trexes));
}

interface Run {
  /** Sample sizes; the bytes of sample n are all equal to `fill + n`. */
  sizes: number[];
  durations?: number[];
  flags?: number[];
  ctos?: number[];
  firstFlags?: number;
  version?: 0 | 1;
  /** Leave the data offset out (the data then starts where the previous run's ended / at base-data-offset). */
  noDataOffset?: boolean;
}
interface Traf {
  trackId: number;
  /** Absent: the trex defaults (zero) apply, so durations come from the runs. */
  baseTime?: number;
  defaultFlags?: number;
  defaultDuration?: number;
  /** Write base-data-offset so the runs need no data offset. */
  explicitBase?: boolean;
  baseIsMoof?: boolean;
  runs: Run[];
}

/** One moof + mdat. `fill` makes the sample bytes recognisable; returns the box bytes and where each sample's data is, relative to the moof. */
function fragment(trafs: Traf[], at: number, fill: number): { bytes: Uint8Array; placed: Array<{ trackId: number; offset: number; size: number; value: number }> } {
  const build = (mdatStart: number) => {
    const placed: Array<{ trackId: number; offset: number; size: number; value: number }> = [];
    let cursor = 0; // within the mdat payload
    let n = 0;
    const trafBoxes = trafs.map((t) => {
      let tfFlags = 0;
      const tfParts: Bytes[] = [u32(t.trackId)];
      if (t.explicitBase) {
        tfFlags |= 0x1;
        tfParts.push(u32(0), u32(at + mdatStart));
      }
      if (t.defaultDuration !== undefined) {
        tfFlags |= 0x8;
        tfParts.push(u32(t.defaultDuration));
      }
      if (t.defaultFlags !== undefined) {
        tfFlags |= 0x20;
        tfParts.push(u32(t.defaultFlags));
      }
      if (t.baseIsMoof !== false && !t.explicitBase) tfFlags |= 0x20000;
      const kids: Uint8Array[] = [full('tfhd', 0, tfFlags, ...tfParts)];
      if (t.baseTime !== undefined) kids.push(full('tfdt', 0, 0, u32(t.baseTime)));
      for (const run of t.runs) {
        let flags = 0x200;
        const head: Bytes[] = [u32(run.sizes.length)];
        if (!run.noDataOffset) {
          flags |= 0x1;
          head.push(u32(mdatStart + cursor)); // relative to the moof, as default-base-is-moof says
        }
        if (run.firstFlags !== undefined) {
          flags |= 0x4;
          head.push(u32(run.firstFlags));
        }
        if (run.durations) flags |= 0x100;
        if (run.flags) flags |= 0x400;
        if (run.ctos) flags |= 0x800;
        const body = run.sizes.flatMap((size, i) => [
          ...(run.durations ? u32(run.durations[i]) : []),
          ...u32(size),
          ...(run.flags ? u32(run.flags[i]) : []),
          ...(run.ctos ? u32(run.ctos[i] >>> 0) : []),
        ]);
        kids.push(full('trun', run.version ?? 0, flags, ...head, body));
        run.sizes.forEach((size) => {
          placed.push({ trackId: t.trackId, offset: mdatStart + cursor, size, value: fill + n++ });
          cursor += size;
        });
      }
      return box('traf', ...kids);
    });
    return { moofBytes: box('moof', full('mfhd', 0, 0, u32(1)), ...trafBoxes), placed, total: cursor };
  };
  const probe = build(0);
  const mdatStart = probe.moofBytes.length + 8;
  const real = build(mdatStart);
  const data = new Uint8Array(real.total);
  for (const p of real.placed) data.fill(p.value & 255, p.offset - mdatStart, p.offset - mdatStart + p.size);
  return { bytes: join(real.moofBytes, box('mdat', data)), placed: real.placed };
}

interface Built {
  file: Uint8Array;
  samples: Array<{ trackId: number; offset: number; size: number; value: number }>;
}

/** ftyp + moov + optional sidx + fragments. */
function build(fragments: Traf[][], opts: { timescale?: number; sidx?: boolean; withSecondTrack?: boolean } = {}): Built {
  const head = join(box('ftyp', [0x69, 0x73, 0x6f, 0x6d], u32(0), [0x69, 0x73, 0x6f, 0x6d]), moov({ timescale: opts.timescale ?? 1000, trackId: 1, withSecondTrack: opts.withSecondTrack }));
  const sidx = opts.sidx ? full('sidx', 0, 0, u32(1), u32(1000), u32(0), u32(0), u16(0), u16(1), u32(100), u32(1000), u32(0x90000000)) : new Uint8Array(0);
  let file = join(head, sidx);
  const samples: Built['samples'] = [];
  let fill = 1;
  for (const traf of fragments) {
    const f = fragment(traf, file.length, fill);
    for (const p of f.placed) samples.push({ ...p, offset: file.length + p.offset });
    fill += f.placed.length;
    file = join(file, f.bytes);
  }
  return { file, samples };
}

const blobOf = (b: Uint8Array) => new Blob([b]);

// ---- the fragment parser -----------------------------------------------------------------------

test('fragments with several runs: sizes, offsets, times and keys come from the trun entries', async () => {
  const { file, samples } = build([
    // Fragment 1: one run, explicit sizes and durations; the key frame is marked by first-sample-flags.
    [{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [10, 20, 30, 40], durations: [40, 40, 40, 40], firstFlags: KEY }] }],
    // Fragment 2: its decode time continues from the tfdt, with two runs and per-sample flags.
    [
      {
        trackId: 1,
        baseTime: 160,
        runs: [
          { sizes: [15, 25], durations: [40, 40], flags: [KEY, DELTA] },
          { sizes: [35, 45], durations: [40, 80], flags: [DELTA, DELTA] },
        ],
      },
    ],
  ]);
  const read = await readMp4(blobOf(file));
  expect(read.note).toBe('');
  const info = read.info!;
  expect(info.fragmented).toBe(true);
  expect(info.codec).toBe('avc1.64001f');
  expect(info.width).toBe(320);
  expect(info.height).toBe(180);
  expect(info.samples.map((s) => s.size)).toEqual([10, 20, 30, 40, 15, 25, 35, 45]);
  expect(info.samples.map((s) => s.pts)).toEqual([0, 40, 80, 120, 160, 200, 240, 280].map((ms) => ms * 1000));
  expect(info.samples.map((s) => s.duration)).toEqual([40, 40, 40, 40, 40, 40, 40, 80].map((ms) => ms * 1000));
  expect(info.samples.map((s) => s.key)).toEqual([true, false, false, false, true, false, false, false]);
  // Each sample's offset lands on its own bytes.
  const bytes = file;
  info.samples.forEach((s, i) => {
    expect(s.offset).toBe(samples[i].offset);
    expect(bytes[s.offset]).toBe(samples[i].value);
    expect(bytes[s.offset + s.size - 1]).toBe(samples[i].value);
  });
});

test('a sample is a key frame unless its flags say non-sync, whichever of trun, first-sample-flags, tfhd or trex gave them', async () => {
  const { file } = build([
    [
      { trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [5, 5], durations: [10, 10] }] }, // both from tfhd: not keys
      { trackId: 1, runs: [{ sizes: [5, 5, 5], durations: [10, 10, 10], flags: [0, 0x10000, 0x02000000] }] }, // flags 0 = sync
    ],
    // No flags anywhere: the trex default (0) applies, so every sample is a sync sample.
    [{ trackId: 1, baseTime: 50, runs: [{ sizes: [5, 5], durations: [10, 10] }] }],
  ]);
  // The first sample must be a key frame for the track to be usable: this file starts with a delta.
  const bad = await readMp4(blobOf(file));
  expect(bad.info).toBeNull();
  expect(bad.note).toMatch(/not a key frame/);
  const ok = build([
    [{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [5, 5], durations: [10, 10], firstFlags: KEY }] }],
    [{ trackId: 1, runs: [{ sizes: [5, 5, 5], durations: [10, 10, 10], flags: [0, 0x10000, 0x02000000] }] }],
    [{ trackId: 1, baseTime: 50, runs: [{ sizes: [5, 5], durations: [10, 10] }] }],
  ]);
  const info = (await readMp4(blobOf(ok.file))).info!;
  expect(info.samples.map((s) => s.key)).toEqual([true, false, true, false, true, true, true]);
  // No tfdt in the second fragment: its time continues from the end of the first.
  expect(info.samples.map((s) => s.pts / 1000)).toEqual([0, 10, 20, 30, 40, 50, 60]);
});

test('negative composition offsets in a version 1 trun move every time later by the most negative one', async () => {
  // Decode order I P B B; presented I B B P. Offsets 0, +80, -40, -40 on a 40-tick step.
  const { file } = build([[{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [8, 8, 8, 8], durations: [40, 40, 40, 40], firstFlags: KEY, ctos: [0, 80, -40, -40], version: 1 }] }]]);
  const info = (await readMp4(blobOf(file))).info!;
  expect(info.samples.map((s) => s.pts / 1000)).toEqual([40, 160, 80, 120]);
  // Presented in order, the pictures come out as samples 0, 2, 3, 1.
  const order = info.samples.map((s, i) => [s.pts, i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  expect(order).toEqual([0, 2, 3, 1]);
});

test('positive composition offsets leave the first picture where the file puts it', async () => {
  const { file } = build([[{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [8, 8, 8, 8], durations: [40, 40, 40, 40], firstFlags: KEY, ctos: [80, 200, 40, 40] }] }]]);
  const info = (await readMp4(blobOf(file))).info!;
  expect(info.samples.map((s) => s.pts / 1000)).toEqual([80, 240, 120, 160]);
});

test('a sidx box in front of the fragments changes nothing', async () => {
  const frags: Traf[][] = [
    [{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [9, 9], durations: [40, 40], firstFlags: KEY }] }],
    [{ trackId: 1, baseTime: 80, defaultFlags: DELTA, runs: [{ sizes: [9, 9], durations: [40, 40], firstFlags: KEY }] }],
  ];
  const plain = await readMp4(blobOf(build(frags).file));
  const withSidx = await readMp4(blobOf(build(frags, { sidx: true }).file));
  expect(withSidx.info).not.toBeNull();
  expect(withSidx.info!.samples.map((s) => [s.size, s.pts, s.key])).toEqual(plain.info!.samples.map((s) => [s.size, s.pts, s.key]));
});

test('a trun without a data offset follows a base-data-offset, and runs follow each other', async () => {
  const { file, samples } = build([
    [
      {
        trackId: 1,
        baseTime: 0,
        explicitBase: true,
        defaultFlags: DELTA,
        runs: [
          { sizes: [11, 12], durations: [40, 40], firstFlags: KEY, noDataOffset: true },
          { sizes: [13], durations: [40], noDataOffset: true },
        ],
      },
    ],
  ]);
  const info = (await readMp4(blobOf(file))).info!;
  expect(info.samples.map((s) => s.size)).toEqual([11, 12, 13]);
  info.samples.forEach((s, i) => {
    expect(s.offset).toBe(samples[i].offset);
    expect(file[s.offset]).toBe(samples[i].value);
  });
});

test('a moof holding another track too: its data is skipped but still counted in the offsets', async () => {
  const { file, samples } = build(
    [
      [
        { trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [10, 10], durations: [40, 40], firstFlags: KEY }] },
        { trackId: 2, baseTime: 0, runs: [{ sizes: [7, 7, 7], durations: [20, 20, 20] }] },
      ],
      [
        { trackId: 2, baseTime: 60, runs: [{ sizes: [7], durations: [20] }] },
        { trackId: 1, baseTime: 80, defaultFlags: DELTA, runs: [{ sizes: [10, 10], durations: [40, 40], firstFlags: KEY }] },
      ],
    ],
    { withSecondTrack: true },
  );
  const info = (await readMp4(blobOf(file))).info!;
  expect(info.samples.length).toBe(4);
  const video = samples.filter((s) => s.trackId === 1);
  info.samples.forEach((s, i) => {
    expect(s.offset).toBe(video[i].offset);
    expect(file[s.offset]).toBe(video[i].value);
  });
  expect(info.samples.map((s) => s.pts / 1000)).toEqual([0, 40, 80, 120]);
});

test('fragmented files without video, without fragments, or with the fragments first are declined with a note', async () => {
  const head = build([]).file;
  expect((await readMp4(blobOf(head))).note).toMatch(/no video samples/);
  const frag = build([[{ trackId: 1, baseTime: 0, runs: [{ sizes: [4], durations: [40], firstFlags: KEY }] }]]).file;
  const ftypLen = new DataView(frag.buffer).getUint32(0);
  const moovLen = new DataView(frag.buffer).getUint32(ftypLen);
  const swapped = join(frag.subarray(0, ftypLen), frag.subarray(ftypLen + moovLen), frag.subarray(ftypLen, ftypLen + moovLen));
  expect((await readMp4(blobOf(swapped))).info).toBeNull();
});

test('truncated files are declined, never thrown at, and never point outside the file', async () => {
  const sources = [build([[{ trackId: 1, baseTime: 0, defaultFlags: DELTA, runs: [{ sizes: [30, 30, 30], durations: [40, 40, 40], firstFlags: KEY }] }], [{ trackId: 1, baseTime: 120, defaultFlags: DELTA, runs: [{ sizes: [30, 30], durations: [40, 40], firstFlags: KEY }] }]]).file];
  sources.push(new Uint8Array(await Bun.file('tests/fixtures/h264-frag.mp4').arrayBuffer()));
  sources.push(new Uint8Array(await Bun.file('tests/fixtures/av1-frag.mp4').arrayBuffer()));
  sources.push(new Uint8Array(await Bun.file('tests/fixtures/av1.mp4').arrayBuffer()));
  let declined = 0;
  let accepted = 0;
  for (const src of sources) {
    for (let len = 0; len < src.length; len += len < 1600 ? 1 : 11) {
      const cut = src.subarray(0, len);
      const read = await readMp4(blobOf(cut));
      if (read.info) {
        accepted++;
        for (const s of read.info.samples) expect(s.offset + s.size).toBeLessThanOrEqual(len);
      } else {
        declined++;
        expect(read.note.length).toBeGreaterThan(0);
      }
    }
  }
  expect(declined).toBeGreaterThan(accepted);
  // Cut inside the last fragment's data: the damage is named.
  const real = sources[1];
  const inLast = await readMp4(blobOf(real.subarray(0, real.length - 300)));
  expect(inLast.info).toBeNull();
  expect(inLast.note).toMatch(/cut off|outside the file/);
});

test('corrupt files never throw: they are declined or still point inside the file', async () => {
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const sources = [
    new Uint8Array(await Bun.file('tests/fixtures/h264-frag.mp4').arrayBuffer()),
    new Uint8Array(await Bun.file('tests/fixtures/h264-bframes.mp4').arrayBuffer()).subarray(0, 4000),
    new Uint8Array(await Bun.file('tests/fixtures/av1-frag.mp4').arrayBuffer()),
  ];
  for (const src of sources) {
    for (let i = 0; i < 400; i++) {
      const copy = src.slice();
      const hits = 1 + rand(4);
      // Mostly the first 900 bytes (moov) and the fragment headers, where a flipped byte matters.
      for (let h = 0; h < hits; h++) copy[rand(i % 2 ? 900 : copy.length)] = rand(256);
      const read = await readMp4(blobOf(copy));
      if (read.info) {
        expect(read.info.samples.length).toBeGreaterThan(0);
        for (const s of read.info.samples) expect(s.offset + s.size).toBeLessThanOrEqual(copy.length);
      }
    }
  }
  // Garbage that merely starts like an MP4.
  const junk = join(box('ftyp', [1, 2, 3, 4], u32(0)), Array.from({ length: 300 }, (_, i) => (i * 37) & 255));
  const read = await readMp4(blobOf(junk));
  expect(read.info).toBeNull();
});

test('corrupt WebM files never throw either', async () => {
  const src = new Uint8Array(await Bun.file('tests/fixtures/av1.webm').arrayBuffer());
  let seed = 99;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 300; i++) {
    const copy = src.slice(0, i % 3 === 0 ? 100 + rand(src.length - 100) : src.length);
    for (let h = 0; h < 1 + rand(3); h++) copy[rand(copy.length)] = rand(256);
    const read = await readWebm(blobOf(copy));
    if (read.info) for (const s of read.info.samples) expect(s.offset + s.size).toBeLessThanOrEqual(copy.length);
  }
});

// ---- the synthetic fixtures (tests/fixtures; made with ffmpeg, see tests/e2e/fast-export.e2e.mjs) --------------

const fixture = (name: string) => Bun.file(`tests/fixtures/${name}`) as unknown as Blob;

test('h264-frag.mp4: fragmented H.264 with B-frames and negative composition offsets', async () => {
  const read = await readMp4(fixture('h264-frag.mp4'));
  const info = read.info!;
  expect(info.fragmented).toBe(true);
  expect(info.codec.startsWith('avc1.')).toBe(true);
  expect(info.samples.length).toBe(15);
  expect(info.samples.filter((s) => s.key).length).toBe(2);
  expect(info.samples[0].key).toBe(true);
  // The offsets are negative in the file; the first picture is shown one frame in, as the element does.
  expect(info.samples[0].pts).toBe(66667);
  const sorted = info.samples.map((s) => s.pts).sort((a, b) => a - b);
  expect(sorted[1] - sorted[0]).toBeGreaterThan(66000);
  expect(sorted[1] - sorted[0]).toBeLessThan(67000);
  expect(info.samples.some((s, i) => i > 0 && s.pts < info.samples[i - 1].pts)).toBe(true); // reordered
});

test('h264-frag-sidx.mp4 has a sidx box and reads like the others', async () => {
  const bytes = new Uint8Array(await fixture('h264-frag-sidx.mp4').arrayBuffer());
  expect(String.fromCharCode(...bytes.subarray(0, 4000)).includes('sidx')).toBe(true);
  const info = (await readMp4(fixture('h264-frag-sidx.mp4'))).info!;
  expect(info.fragmented).toBe(true);
  expect(info.samples.length).toBe(15);
  expect(info.samples[0].pts).toBe(0);
});

test('h264-frag-bframes.mp4: positive offsets put the first picture 0.133 s in', async () => {
  const info = (await readMp4(fixture('h264-frag-bframes.mp4'))).info!;
  expect(info.samples[0].pts).toBe(133333);
  expect(info.samples.length).toBe(15);
});

test('AV1: the codec string comes from av1C, or from the sequence header when ffmpeg left av1C empty', async () => {
  const plain = (await readMp4(fixture('av1.mp4'))).info!;
  expect(plain.codec).toBe('av01.0.00M.08');
  expect(plain.fragmented).toBeUndefined();
  expect(plain.samples.length).toBe(15);
  // empty_moov: ffmpeg writes av1C with no payload; the first key frame names the codec.
  const frag = (await readMp4(fixture('av1-frag.mp4'))).info!;
  expect(frag.codec).toBe('av01.0.00M.08');
  expect(frag.fragmented).toBe(true);
  expect(frag.samples.length).toBe(15);
  const web = (await readWebm(fixture('av1.webm'))).info!;
  expect(web.codec).toBe('av01.0.00M.08');
  expect(web.container).toBe('webm');
  expect(web.samples.length).toBe(15);
  expect(web.samples[0].key).toBe(true);
  // The same stream in three wrappers has the same pictures.
  expect(web.samples.map((s) => s.size)).toEqual(plain.samples.map((s) => s.size));
  expect(frag.samples.map((s) => s.size)).toEqual(plain.samples.map((s) => s.size));
});

test('AV1 codec strings from an av1C record and from a sequence header', async () => {
  expect(av1CodecString(Uint8Array.from([0x81, 0x04, 0x0c, 0x00]))).toBe('av01.0.04M.08');
  expect(av1CodecString(Uint8Array.from([0x81, 0x4d, 0x60, 0x00]))).toBe('av01.2.13M.12'); // profile 2, level 13, 12-bit
  expect(av1CodecString(Uint8Array.from([0x81, 0x08, 0x40, 0x00]))).toBe('av01.0.08M.10');
  expect(av1CodecString(Uint8Array.from([0x81, 0x08, 0xc0, 0x00]))).toBe('av01.0.08H.10');
  // An empty or wrong record is not trusted.
  expect(av1CodecString(new Uint8Array(0))).toBeNull();
  expect(av1CodecString(Uint8Array.from([0x01, 0x00, 0x00, 0x00]))).toBeNull();
  // Sequence header OBU of the av1.webm key frame, found past a temporal delimiter.
  const info = (await readWebm(fixture('av1.webm'))).info!;
  const file = new Uint8Array(await fixture('av1.webm').arrayBuffer());
  const first = file.subarray(info.samples[0].offset, info.samples[0].offset + info.samples[0].size);
  expect(av1CodecFromSample(first)).toBe('av01.0.00M.08');
  expect(av1CodecFromSample(new Uint8Array([1, 2, 3]))).toBeNull();
  expect(av1CodecFromSample(new Uint8Array(0))).toBeNull();
});

test('HEVC: the codec string and description come from hvcC, and the track is read for the fast path to judge', async () => {
  const info = (await readMp4(fixture('hevc.mp4'))).info!;
  expect(info.codec).toBe('hvc1.1.6.L60.90');
  expect(info.description!.length).toBeGreaterThan(23);
  expect(info.samples.length).toBe(15);
  // Main profile level 4.1 with the usual constraint flags (B0), compatibility flags 0x60000000.
  const hvcC = new Uint8Array(23);
  hvcC[1] = 0x01;
  hvcC.set([0x60, 0, 0, 0], 2);
  hvcC.set([0xb0, 0, 0, 0, 0, 0], 6);
  hvcC[12] = 123;
  expect(hevcCodecString('hvc1', hvcC)).toBe('hvc1.1.6.L123.b0');
  hvcC[1] = 0x20 | 0x02; // high tier, profile 2
  hvcC.set([0x20, 0, 0, 0], 2);
  expect(hevcCodecString('hev1', hvcC)).toBe('hev1.2.4.H123.b0');
});

test('other files and codecs are declined with a reason, not an error', async () => {
  const wav = await readVideo(fixture('tone.wav'));
  expect(wav.info).toBeNull();
  expect(wav.note.length).toBeGreaterThan(0);
  const avc3 = await readMp4(fixture('h264-avc3.mp4'));
  expect(avc3.info).toBeNull();
  expect(avc3.codec).toMatch(/^avc3\./);
  expect(avc3.note).toMatch(/avc3/);
  // Existing plain files are still read (the e2e and the muxer tests cover them in depth).
  expect((await openMp4(fixture('h264-bframes.mp4')))!.samples.length).toBe(60);
});

// ---- choosing the path ---------------------------------------------------------------------------

test('codec strings map to families', () => {
  expect(codecFamily('avc1.64001f')).toBe('h264');
  expect(codecFamily('vp8')).toBe('vp8');
  expect(codecFamily('vp09.00.10.08')).toBe('vp9');
  expect(codecFamily('av01.0.04M.08')).toBe('av1');
  expect(codecFamily('hvc1.1.6.L93.B0')).toBe('hevc');
  expect(codecFamily('hev1.1.6.L93.B0')).toBe('hevc');
  expect(codecFamily('mp4v.20.9')).toBe('other');
  expect(codecFamily(null)).toBe('other');
});

test('choosePath: fast only for a container and codec the demuxers read and a decoder the browser has', () => {
  const fast = [
    ['mp4', 'avc1.64001f'],
    ['mp4', 'vp09.00.10.08'],
    ['mp4', 'av01.0.04M.08'],
    ['mp4', 'hvc1.1.6.L93.B0'],
    ['webm', 'vp8'],
    ['webm', 'vp09.00.10.08'],
    ['webm', 'av01.0.04M.08'],
  ] as const;
  for (const [container, codec] of fast) {
    const c = choosePath(container, codec, true);
    expect(c.path).toBe('fast');
    expect(c.reason).toMatch(/decoded in order with WebCodecs/);
  }
  expect(choosePath('mp4', 'avc1.64001f', true).reason).toBe('H.264 in MP4, decoded in order with WebCodecs');
  expect(choosePath('webm', 'av01.0.04M.08', true).reason).toBe('AV1 in WebM, decoded in order with WebCodecs');
});

test('choosePath: every refusal says why', () => {
  // The browser's answer decides.
  const no = choosePath('mp4', 'av01.0.04M.08', false);
  expect(no).toEqual({ path: 'seek', reason: 'this browser cannot decode AV1 (av01.0.04M.08) with WebCodecs' });
  expect(choosePath('mp4', 'hvc1.1.6.L93.B0', false).reason).toBe('HEVC is only decoded where the browser reports support, and it does not here');
  expect(choosePath('mp4', 'hvc1.1.6.L93.B0', null).path).toBe('seek');
  expect(choosePath('mp4', 'avc1.64001f', undefined).reason).toMatch(/could not ask this browser whether it decodes H\.264/);
  // Containers and codecs the demuxers do not read.
  expect(choosePath('mp4', 'vp8', true).reason).toBe('VP8 in MP4 is not read by the fast path');
  expect(choosePath('webm', 'avc1.64001f', true).reason).toBe('H.264 in WebM is not read by the fast path');
  expect(choosePath('webm', 'hvc1.1.6.L93.B0', true).path).toBe('seek');
  expect(choosePath('mp4', 'mp4v.20.9', true).reason).toBe('the codec mp4v.20.9 in this MP4 is not one the fast path reads');
  expect(choosePath('mp4', null, true).reason).toBe('the video codec in this MP4 is not one the fast path reads');
  expect(choosePath('avi', 'avc1.64001f', true).reason).toBe('the file is not an MP4 or WebM that the fast path reads');
  expect(choosePath(null, null, null).path).toBe('seek');
  // The demuxer's own reason (truncated, damaged, ...) is passed on, and beats everything else.
  expect(choosePath('mp4', 'avc1.64001f', true, 'the file is cut off inside a fragment')).toEqual({ path: 'seek', reason: 'the file is cut off inside a fragment' });
});

test('the export status names the files being seeked and why', () => {
  const fastOnly: DecodeDecision[] = [{ media: 'a.mp4', path: 'fast', reason: 'H.264 in MP4, decoded in order with WebCodecs' }];
  expect(describeDecisions([])).toBe('');
  expect(describeDecisions(fastOnly)).toBe('fast decode');
  const mixed: DecodeDecision[] = [...fastOnly, { media: 'b.mov', path: 'seek', reason: 'the file is not an MP4 or WebM that the fast path reads' }];
  expect(describeDecisions(mixed)).toBe('seeking b.mov (the file is not an MP4 or WebM that the fast path reads)');
});
