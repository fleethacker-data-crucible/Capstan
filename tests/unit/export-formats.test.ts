import { expect, test } from 'bun:test';
import { openMp4 } from '../../src/engine/demux/mp4';
import { openWebm } from '../../src/engine/demux/webm';
import { frameIndexAt, keyBefore, presentationOrder } from '../../src/engine/fastdecode';
import { Mp4Muxer } from '../../src/engine/mp4/muxer';
import {
  BUILTIN_PRESETS,
  DEFAULT_SETTINGS,
  allPresets,
  describeSettings,
  loadLastSettings,
  loadUserPresets,
  outputSize,
  parsePresets,
  parseSettings,
  saveLastSettings,
  saveUserPresets,
  withPreset,
  withoutPreset,
} from '../../src/engine/presets';
import { createProject, parseProject } from '../../src/engine/project';
import { clipWindow, exportSpan, makeRange, parseRange, setRange, setRangeIn, setRangeOut } from '../../src/engine/range';
import { fileSink, memorySink, uniqueName } from '../../src/engine/sinks';

// ---- range -------------------------------------------------------------------------------

test('a range is validated when read and survives a project round trip', () => {
  expect(parseRange({ start: 1, end: 3 })).toEqual({ start: 1, end: 3 });
  expect(parseRange({ start: -2, end: 3 })).toEqual({ start: 0, end: 3 });
  expect(parseRange({ start: 3, end: 3 })).toBeUndefined();
  expect(parseRange({ start: 'a', end: 3 })).toBeUndefined();
  expect(parseRange(null)).toBeUndefined();
  const p = setRange(createProject('x', 320, 180, 30), { start: 1, end: 2.5 });
  expect(parseProject(JSON.parse(JSON.stringify(p))).range).toEqual({ start: 1, end: 2.5 });
  expect(parseProject(JSON.parse(JSON.stringify(createProject()))).range).toBeUndefined();
});

test('I and O marks keep the range sensible', () => {
  let p = createProject('x', 320, 180, 30);
  p = setRangeIn(p, 2, 10);
  expect(p.range).toEqual({ start: 2, end: 10 });
  p = setRangeOut(p, 6);
  expect(p.range).toEqual({ start: 2, end: 6 });
  // An out mark before the in mark restarts the range from zero.
  p = setRangeOut(p, 1);
  expect(p.range).toEqual({ start: 0, end: 1 });
  // An in mark past the out mark extends the range to the end of the timeline.
  p = setRangeIn(p, 4, 10);
  expect(p.range).toEqual({ start: 4, end: 10 });
  expect(setRangeIn(p, 10, 10)).toBe(p);
  expect(setRange(p, undefined).range).toBeUndefined();
  expect(setRange(p, p.range)).toBe(p);
  expect(setRange(createProject(), undefined).range).toBeUndefined();
  expect(makeRange(5, 2)).toEqual({ start: 2, end: 5 });
});

test('the export span clips the marks to the timeline', () => {
  expect(exportSpan(0, undefined)).toBeNull();
  expect(exportSpan(8, undefined)).toEqual({ start: 0, end: 8 });
  expect(exportSpan(8, { start: 2, end: 20 })).toEqual({ start: 2, end: 8 });
  expect(exportSpan(8, { start: 9, end: 12 })).toBeNull();
  expect(exportSpan(8, { start: 1, end: 3 })).toEqual({ start: 1, end: 3 });
});

test('clip audio windows are cut to the export range, with speed', () => {
  const clip = { start: 2, in: 1, duration: 4 }; // plays 2..6, source 1..5
  expect(clipWindow(clip, 0, 10)).toEqual({ when: 2, offset: 1, duration: 4 });
  // Range starts inside the clip: start at once, skip the part before it.
  expect(clipWindow(clip, 3, 10)).toEqual({ when: 0, offset: 2, duration: 3 });
  // Range ends inside the clip.
  expect(clipWindow(clip, 0, 4)).toEqual({ when: 2, offset: 1, duration: 2 });
  // Range wholly inside, rebased to zero.
  expect(clipWindow(clip, 3, 5)).toEqual({ when: 0, offset: 2, duration: 2 });
  expect(clipWindow(clip, 6, 9)).toBeNull();
  expect(clipWindow(clip, 0, 2)).toBeNull();
  // Double speed consumes twice the source.
  expect(clipWindow({ start: 0, in: 0, duration: 4, speed: 2 }, 1, 3)).toEqual({ when: 0, offset: 2, duration: 4 });
});

// ---- presets -----------------------------------------------------------------------------

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), data };
}

test('settings are clamped and defaulted', () => {
  expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  const s = parseSettings({ format: 'exe', size: 99999, fps: 500, gifColors: 1, range: 'marks', quality: 'high', stream: 1 });
  expect(s.format).toBe('mp4');
  expect(s.size).toBe(4320);
  expect(s.fps).toBe(60);
  expect(s.gifColors).toBe(2);
  expect(s.range).toBe('marks');
  expect(s.quality).toBe('high');
  expect(s.stream).toBe(false);
});

test('built-in presets cover the common cases and describe themselves', () => {
  const names = BUILTIN_PRESETS.map((p) => p.name);
  expect(names).toEqual(['YouTube 1080p', 'Small 720p', 'GIF 480', 'Audio only']);
  const project = { width: 1920, height: 1080, fps: 30 };
  expect(describeSettings(BUILTIN_PRESETS[2].settings, project)).toContain('GIF 854×480');
  expect(describeSettings(BUILTIN_PRESETS[3].settings, project)).toBe('M4A');
  expect(outputSize({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
  expect(outputSize({ width: 1000, height: 1001 }, 'project')).toEqual({ width: 1000, height: 1002 });
});

test('user presets are saved, replaced by name, deleted, and reloaded', () => {
  const storage = fakeStorage();
  let list = allPresets(loadUserPresets(storage)).filter((p) => !p.builtin);
  list = withPreset(list, '  My gif  ', { ...DEFAULT_SETTINGS, format: 'gif' });
  list = withPreset(list, 'Other', DEFAULT_SETTINGS);
  list = withPreset(list, 'my GIF', { ...DEFAULT_SETTINGS, format: 'gif', gifColors: 64 });
  expect(list.map((p) => p.name)).toEqual(['my GIF', 'Other']);
  expect(withPreset(list, '   ', DEFAULT_SETTINGS)).toBe(list);
  expect(saveUserPresets(list, storage)).toBe(true);
  const back = loadUserPresets(storage);
  expect(back.map((p) => p.name)).toEqual(['my GIF', 'Other']);
  expect(back[0].settings.gifColors).toBe(64);
  expect(withoutPreset(back, back[0].id).map((p) => p.name)).toEqual(['Other']);
  expect(allPresets(back).length).toBe(BUILTIN_PRESETS.length + 2);
});

test('storage that is missing, blocked or corrupt never breaks the dialog', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  expect(loadUserPresets(blocked)).toEqual([]);
  expect(saveUserPresets([], blocked)).toBe(false);
  expect(saveUserPresets([], null)).toBe(false);
  expect(loadLastSettings(blocked)).toEqual(DEFAULT_SETTINGS);
  expect(() => saveLastSettings(DEFAULT_SETTINGS, blocked)).not.toThrow();
  expect(parsePresets('{not json')).toEqual([]);
  expect(parsePresets('[1,{"name":"ok","settings":{"format":"wav"}},{"name":""}]').map((p) => p.name)).toEqual(['ok']);
  const s = fakeStorage();
  saveLastSettings({ ...DEFAULT_SETTINGS, format: 'png', size: 480 }, s);
  expect(loadLastSettings(s).format).toBe('png');
});

// ---- sinks -------------------------------------------------------------------------------

test('file names in a batch folder never collide', () => {
  expect(uniqueName('Demo', 'mp4', [])).toBe('Demo.mp4');
  expect(uniqueName('Demo', 'mp4', ['Demo.mp4'])).toBe('Demo (2).mp4');
  expect(uniqueName('Demo', 'mp4', ['Demo.mp4', 'Demo (2).mp4'])).toBe('Demo (3).mp4');
});

test('the file sink writes every chunk at its position and aborts cleanly', async () => {
  const calls: Array<{ position: number; length: number }> = [];
  let closed = false;
  let aborted = false;
  const sink = fileSink({
    async write(d) {
      calls.push({ position: d.position, length: d.data.length });
    },
    async close() {
      closed = true;
    },
    async abort() {
      aborted = true;
    },
  });
  await sink.write(new Uint8Array(10), 0);
  await sink.write(new Uint8Array(5), 10);
  await sink.write(new Uint8Array(100).subarray(10, 20), 3);
  expect(calls).toEqual([
    { position: 0, length: 10 },
    { position: 10, length: 5 },
    { position: 3, length: 10 },
  ]);
  await sink.close();
  await sink.abort?.();
  expect(closed && aborted).toBe(true);
});

// ---- streaming MP4 muxer -----------------------------------------------------------------

const AVCC = new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0, 1]);

/** Decode-order video samples with B-frame style reordering: pts runs 0, 3, 1, 2, 6, 4, 5, ... */
function videoSamples(count: number, fps = 30): Array<{ i: number; ts: number; key: boolean; data: Uint8Array }> {
  const order = [0, 3, 1, 2];
  const out = [];
  for (let i = 0; i < count; i++) {
    const g = Math.floor(i / 4) * 4;
    const display = g + order[i % 4];
    out.push({ i, ts: Math.round((display * 1e6) / fps) + 66667, key: i % 30 === 0, data: new Uint8Array(100 + (i % 7) * 13).fill((i % 250) + 1) });
  }
  return out;
}

function makeMuxer(sink?: ReturnType<typeof memorySink>) {
  const m = new Mp4Muxer({ codec: 'avc', width: 320, height: 180, description: AVCC }, { codec: 'aac', sampleRate: 48000, channels: 2, description: new Uint8Array([0x11, 0x90]) }, { sink });
  return m;
}

function feedAudio(m: Mp4Muxer, seconds: number): void {
  const n = Math.ceil((seconds * 48000) / 1024);
  for (let i = 0; i < n; i++) m.addAudioSample(new Uint8Array(200).fill(7), Math.round((i * 1024 * 1e6) / 48000), (1024 * 1e6) / 48000);
}

test('a streaming muxer writes to the sink before it is finalised and the file demuxes back to the same samples', async () => {
  const sink = memorySink();
  const m = makeMuxer(sink);
  feedAudio(m, 4);
  m.endTrack('audio');
  const samples = videoSamples(120);
  const writesAtStart = sink.writes.length;
  let writesBeforeFinal = 0;
  for (const s of samples) {
    m.addVideoSample(s.data, s.ts, 33333, s.key);
    await m.drain(1 << 20);
    if (s.i === 100) writesBeforeFinal = sink.writes.length;
  }
  expect(writesBeforeFinal).toBeGreaterThan(writesAtStart + 3);
  expect(sink.closed).toBe(false);
  // Memory stays flat: everything handed over is already in the sink except the open chunks.
  expect(m.bytesWritten).toBeGreaterThan(samples.slice(0, 80).reduce((n, s) => n + s.data.length, 0));
  const size = await m.finalizeStream();
  expect(sink.closed).toBe(true);
  const file = sink.bytes();
  expect(file.length).toBe(size);

  // The mdat uses a 64-bit size that was patched in place.
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const ftypSize = dv.getUint32(0);
  expect(String.fromCharCode(...file.subarray(4, 8))).toBe('ftyp');
  expect(dv.getUint32(ftypSize)).toBe(1);
  expect(String.fromCharCode(...file.subarray(ftypSize + 4, ftypSize + 8))).toBe('mdat');
  const mdatSize = dv.getUint32(ftypSize + 8) * 2 ** 32 + dv.getUint32(ftypSize + 12);
  expect(String.fromCharCode(...file.subarray(ftypSize + mdatSize + 4, ftypSize + mdatSize + 8))).toBe('moov');

  const track = await openMp4(new Blob([file]));
  expect(track).not.toBeNull();
  expect(track!.codec).toBe('avc1.64001f');
  expect(track!.samples.length).toBe(120);
  const base = samples[0].ts;
  samples.forEach((s, i) => {
    const d = track!.samples[i];
    expect(d.size).toBe(s.data.length);
    expect(d.key).toBe(s.key);
    expect(Math.abs(d.pts - (s.ts - base))).toBeLessThan(40);
    // The bytes at the sample's offset are the bytes that were added.
    expect(file[d.offset]).toBe(s.data[0]);
    expect(file[d.offset + d.size - 1]).toBe(s.data[0]);
  });
});

test('streaming and blob output demux to the same sample table', async () => {
  const sink = memorySink();
  const a = makeMuxer(sink);
  const b = makeMuxer();
  for (const m of [a, b]) {
    feedAudio(m, 2);
    m.endTrack('audio');
    for (const s of videoSamples(60)) m.addVideoSample(s.data, s.ts, 33333, s.key);
  }
  await a.finalizeStream();
  const x = await openMp4(new Blob([sink.bytes()]));
  const y = await openMp4(b.finalize());
  expect(x!.samples.map((s) => [s.size, s.key, s.pts])).toEqual(y!.samples.map((s) => [s.size, s.key, s.pts]));
});

test('chunks of both tracks are interleaved in time order in the stream', async () => {
  const sink = memorySink();
  const m = makeMuxer(sink);
  feedAudio(m, 3);
  m.endTrack('audio');
  for (const s of videoSamples(90)) m.addVideoSample(s.data, s.ts, 33333, s.key);
  await m.finalizeStream();
  const file = sink.bytes();
  // Walk mdat: audio samples are filled with 7, video with 1..250. Find the first byte of each run.
  const runs: Array<'a' | 'v'> = [];
  let last = '';
  const start = new DataView(file.buffer, file.byteOffset).getUint32(0) + 16;
  for (let i = start; i < start + 60000 && i < file.length; i += 1) {
    const k = file[i] === 7 ? 'a' : 'v';
    if (k !== last) {
      runs.push(k);
      last = k;
    }
  }
  // Several alternations, not one block of audio followed by all the video.
  expect(runs.length).toBeGreaterThan(4);
});

test('a failing sink surfaces on drain and the muxer stops writing', async () => {
  let n = 0;
  const m = new Mp4Muxer({ codec: 'avc', width: 320, height: 180, description: AVCC }, null, {
    sink: {
      write: async () => {
        if (++n > 2) throw new Error('disk full');
      },
      close: () => undefined,
    },
  });
  for (const s of videoSamples(80)) m.addVideoSample(s.data, s.ts, 33333, s.key);
  await expect(m.drain(0)).rejects.toThrow('disk full');
  await expect(m.finalizeStream()).rejects.toThrow('disk full');
});

test('drain waits for a slow sink so memory cannot run ahead of the disk', async () => {
  const written: number[] = [];
  const m = new Mp4Muxer({ codec: 'avc', width: 320, height: 180, description: AVCC }, null, {
    sink: {
      write: async (d) => {
        await new Promise((r) => setTimeout(r, 5));
        written.push(d.length);
      },
      close: () => undefined,
    },
  });
  for (const s of videoSamples(70)) m.addVideoSample(s.data, s.ts, 33333, s.key);
  const before = written.length;
  await m.drain(0);
  expect(written.length).toBeGreaterThan(before);
});

test('an audio-only streaming file is an M4A with a sound track and no video', async () => {
  const sink = memorySink();
  const m = new Mp4Muxer(null, { codec: 'aac', sampleRate: 48000, channels: 2, description: new Uint8Array([0x11, 0x90]) }, { sink });
  feedAudio(m, 2);
  await m.finalizeStream();
  const file = sink.bytes();
  expect(String.fromCharCode(...file.subarray(8, 12))).toBe('M4A ');
  const text = String.fromCharCode(...file);
  expect(text.includes('soun')).toBe(true);
  expect(text.includes('vide')).toBe(false);
  expect(await openMp4(new Blob([file]))).toBeNull();
});

test('finalize() on a streaming muxer and finalizeStream() on a blob muxer are refused', async () => {
  expect(() => makeMuxer(memorySink()).finalize()).toThrow();
  await expect(makeMuxer().finalizeStream()).rejects.toThrow();
});

// ---- demuxers against real files ---------------------------------------------------------

test('the MP4 demuxer reads an ffmpeg H.264 file with B-frames and an edit list', async () => {
  const blob = Bun.file('tests/fixtures/h264-bframes.mp4') as unknown as Blob;
  const track = await openMp4(blob);
  expect(track).not.toBeNull();
  expect(track!.container).toBe('mp4');
  expect(track!.codec.startsWith('avc1.')).toBe(true);
  expect(track!.width).toBe(320);
  expect(track!.height).toBe(180);
  expect(track!.samples.length).toBe(60);
  expect(track!.samples[0].key).toBe(true);
  expect(track!.samples.filter((s) => s.key).length).toBeGreaterThanOrEqual(2);
  const order = presentationOrder(track!.samples);
  // Presentation starts at zero and steps by one frame (33.3 ms).
  expect(track!.samples[order[0]].pts).toBe(0);
  expect(Math.abs(track!.samples[order[1]].pts - 33333)).toBeLessThan(40);
  expect(Math.abs(track!.samples[order[59]].pts - 59 * 33333)).toBeLessThan(200);
  // B-frames: decode order differs from presentation order.
  expect(order.some((v, i) => v !== i)).toBe(true);
  // Every sample lies inside the file.
  for (const s of track!.samples) expect(s.offset + s.size).toBeLessThanOrEqual(blob.size);
});

test('the WebM demuxer reads a recorder file (unknown sizes, no cues) and finds VP9 key frames', async () => {
  const blob = Bun.file('tests/fixtures/clip.webm') as unknown as Blob;
  const track = await openWebm(blob);
  expect(track).not.toBeNull();
  expect(track!.container).toBe('webm');
  expect(track!.codec).toBe('vp09.00.10.08');
  expect(track!.width).toBe(640);
  expect(track!.height).toBe(360);
  expect(track!.samples.length).toBeGreaterThan(60);
  expect(track!.samples[0].key).toBe(true);
  const pts = track!.samples.map((s) => s.pts);
  expect(pts[0]).toBeLessThan(100_000);
  expect([...pts].sort((a, b) => a - b)).toEqual(pts);
  const span = pts[pts.length - 1] / 1e6;
  expect(span).toBeGreaterThan(2.5);
  expect(span).toBeLessThan(3.2);
});

test('mp4 and webm sniffing leaves other files alone', async () => {
  expect(await openMp4(new Blob([new Uint8Array(100)]))).toBeNull();
  expect(await openWebm(new Blob([new Uint8Array(100)]))).toBeNull();
  expect(await openMp4(Bun.file('tests/fixtures/tone.wav') as unknown as Blob)).toBeNull();
});

test('frame lookup picks the last frame at or before the time and the key frame to restart from', () => {
  const samples = [0, 3, 1, 2, 4].map((p, i) => ({ offset: i, size: 1, pts: p * 1000, duration: 1000, key: i === 0 || i === 4 }));
  const order = presentationOrder(samples);
  expect(order).toEqual([0, 2, 3, 1, 4]);
  expect(order[frameIndexAt(samples, order, 1500)]).toBe(2);
  expect(order[frameIndexAt(samples, order, 3000)]).toBe(1);
  expect(order[frameIndexAt(samples, order, -50)]).toBe(0);
  expect(order[frameIndexAt(samples, order, 99999)]).toBe(4);
  expect(keyBefore(samples, 3)).toBe(0);
  expect(keyBefore(samples, 4)).toBe(4);
});
