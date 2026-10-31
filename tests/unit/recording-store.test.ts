import { describe, expect, test } from 'bun:test';
import {
  DiskSink,
  MemorySink,
  RecordingStore,
  type StoreDir,
  manifestName,
  mimeFor,
  newManifest,
  newSessionId,
  parseEntryName,
  parseManifest,
  partFileName,
  segmentName,
  stampName,
} from '../../src/engine/recording-store';

/** An in-memory directory. Like OPFS, a writable only commits its data when it is closed. */
function memoryDir(options: { failWritesAfter?: number } = {}) {
  const files = new Map<string, Blob>();
  let writes = 0;
  const dir: StoreDir = {
    async getFileHandle(name, o) {
      if (!files.has(name)) {
        if (!o?.create) throw new Error(`NotFoundError: ${name}`);
        files.set(name, new Blob());
      }
      return {
        async getFile() {
          return new File([files.get(name)!], name);
        },
        async createWritable() {
          const parts: Array<Blob | string> = [];
          return {
            async write(d) {
              if (options.failWritesAfter !== undefined && writes >= options.failWritesAfter) throw new Error('QuotaExceededError');
              writes++;
              parts.push(d);
            },
            async close() {
              files.set(name, new Blob(parts));
            },
          };
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async names() {
      return [...files.keys()];
    },
  };
  return { dir, files };
}

const chunk = (n: number, fill = 1) => new Blob([new Uint8Array(n).fill(fill)]);

describe('names', () => {
  test('stamp and part names use dots, not colons, in local time', () => {
    const d = new Date(2026, 9, 30, 9, 5, 7);
    expect(stampName(d)).toBe('2026-10-30 09.05.07');
    expect(partFileName('screen', d, 'webm')).toBe('Recording 2026-10-30 09.05.07.webm');
    expect(partFileName('webcam', d, 'mp4')).toBe('Webcam 2026-10-30 09.05.07.mp4');
    expect(partFileName('mic', d, 'webm')).toBe('Microphone 2026-10-30 09.05.07.webm');
    expect(partFileName('system', d, 'webm')).toBe('System audio 2026-10-30 09.05.07.webm');
  });

  test('session ids are sortable, dot free and parse back', () => {
    const id = newSessionId(new Date(2026, 9, 30, 9, 5, 7), () => 0.5);
    expect(id).toMatch(/^rec-20261030-090507-[0-9a-z]{4}$/);
    expect(id.includes('.')).toBe(false);
    expect(newSessionId(new Date(2026, 9, 30, 9, 5, 8), () => 0) > id).toBe(true);
  });

  test('segment and manifest names round-trip; strangers are ignored', () => {
    const s = 'rec-20261030-090507-abcd';
    expect(segmentName(s, 'webcam', 12, 'webm')).toBe(`${s}.webcam.000012.webm`);
    expect(parseEntryName(segmentName(s, 'webcam', 12, 'webm'))).toEqual({ kind: 'segment', session: s, role: 'webcam', seq: 12, ext: 'webm' });
    expect(parseEntryName(manifestName(s))).toEqual({ kind: 'manifest', session: s });
    for (const bad of ['.probe', 'notes.txt', `${s}.video.000001.webm`, `${s}.mic.x.webm`, 'other.screen.000001.webm', `${s}.screen.000001`]) {
      expect(parseEntryName(bad)).toBeNull();
    }
  });

  test('audio roles get audio MIME types', () => {
    expect(mimeFor('screen', 'webm')).toBe('video/webm');
    expect(mimeFor('webcam', 'mp4')).toBe('video/mp4');
    expect(mimeFor('mic', 'webm')).toBe('audio/webm');
    expect(mimeFor('system', 'mp4')).toBe('audio/mp4');
  });
});

describe('manifest', () => {
  test('parses what it wrote and repairs odd values', () => {
    const m = newManifest('rec-20261030-090507-abcd', 1000, { width: 640, height: 360, place: { pip: false, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } });
    expect(parseManifest(JSON.stringify(m))).toEqual(m);
    expect(parseManifest('not json')).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 2 }))).toBeNull();
    const odd = parseManifest(JSON.stringify({ version: 1, session: 'rec-x', seconds: 'a', place: {} }));
    expect(odd?.seconds).toBe(0);
    expect(odd?.place.pip).toBe(true);
  });
});

describe('MemorySink', () => {
  test('joins chunks in order', async () => {
    const s = new MemorySink();
    s.push(chunk(3, 1));
    s.push(chunk(2, 2));
    const blob = await s.finish('video/webm');
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('video/webm');
    expect(s.received).toBe(5);
    expect(s.onDisk).toBe(false);
  });
});

describe('DiskSink', () => {
  test('writes a segment once enough bytes are waiting, and the bytes grow while recording', async () => {
    const { dir, files } = memoryDir();
    const sink = new DiskSink(dir, 'rec-a', 'screen', 'webm', { flushBytes: 100, flushMs: 1e9 });
    sink.push(chunk(60));
    expect(files.size).toBe(0); // below the threshold: still waiting
    sink.push(chunk(60));
    await sink.finish('video/webm').then(() => undefined);
    expect([...files.keys()]).toEqual([segmentName('rec-a', 'screen', 1, 'webm')]);
    expect(sink.written).toBe(120);
  });

  test('flushes by time too, and keeps segment order', async () => {
    const { dir } = memoryDir();
    let now = 0;
    const sink = new DiskSink(dir, 'rec-a', 'webcam', 'webm', { flushBytes: 1e9, flushMs: 1000, now: () => now });
    sink.push(chunk(10, 1));
    now = 500;
    sink.push(chunk(10, 2));
    now = 1200;
    sink.push(chunk(10, 3)); // flushes 1+2+3 as segment 1
    now = 1300;
    sink.push(chunk(10, 4));
    now = 2500;
    sink.push(chunk(10, 5)); // flushes 4+5 as segment 2
    const blob = await sink.finish('video/webm');
    expect(sink.segments).toBe(2);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.filter((_, i) => i % 10 === 0))).toEqual([1, 2, 3, 4, 5]);
    expect(blob.size).toBe(50);
  });

  test('finish flushes what is left and returns every byte', async () => {
    const { dir } = memoryDir();
    const sink = new DiskSink(dir, 'rec-a', 'mic', 'webm', { flushBytes: 1e9, flushMs: 1e9 });
    sink.push(chunk(7));
    sink.push(chunk(5));
    const blob = await sink.finish('audio/webm');
    expect(blob.size).toBe(12);
    expect(blob.type).toBe('audio/webm');
    expect(sink.onDisk).toBe(true);
  });

  test('falls back to memory when a write fails, without losing or reordering data', async () => {
    const { dir, files } = memoryDir({ failWritesAfter: 1 });
    let fallback: Error | null = null;
    const sink = new DiskSink(dir, 'rec-a', 'screen', 'webm', { flushBytes: 10, flushMs: 1e9, onFallback: (e) => (fallback = e) });
    sink.push(chunk(10, 1)); // segment 1 succeeds
    await new Promise((r) => setTimeout(r, 0));
    sink.push(chunk(10, 2)); // fails: goes to memory
    sink.push(chunk(10, 3));
    const blob = await sink.finish('video/webm');
    expect(sink.onDisk).toBe(false);
    expect(fallback).not.toBeNull();
    expect(files.size).toBe(1);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.filter((_, i) => i % 10 === 0))).toEqual([1, 2, 3]);
  });
});

describe('RecordingStore recovery', () => {
  const when = new Date(2026, 9, 30, 9, 5, 7).getTime();

  async function record(store: RecordingStore, session: string, roles: Array<[Parameters<RecordingStore['sink']>[1], number]>, patch = {}) {
    await store.begin(
      newManifest(session, when, {
        name: 'Recording 2026-10-30 09.05.07.webm',
        parts: Object.fromEntries(roles.map(([r]) => [r, { ext: 'webm', mime: mimeFor(r, 'webm') }])),
        ...patch,
      }),
    );
    for (const [role, bytes] of roles) {
      const sink = store.sink(session, role, 'webm', { flushBytes: 1, flushMs: 1e9 });
      sink.push(chunk(bytes));
      sink.push(chunk(bytes));
      await sink.finish('video/webm');
    }
  }

  test('lists leftover sessions with sizes per part', async () => {
    const { dir } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-aaaa', [
      ['screen', 100],
      ['webcam', 40],
    ]);
    const list = await new RecordingStore(dir).list();
    expect(list).toHaveLength(1);
    expect(list[0].session).toBe('rec-20261030-090507-aaaa');
    expect(list[0].parts.map((p) => [p.role, p.bytes, p.segments])).toEqual([
      ['screen', 200, 2],
      ['webcam', 80, 2],
    ]);
    expect(list[0].totalBytes).toBe(280);
    expect(list[0].manifest.complete).toBe(false); // never marked finished: an interrupted recording
  });

  test('total size on disk grows as chunks are written', async () => {
    const { dir } = memoryDir();
    const store = new RecordingStore(dir);
    const s = 'rec-20261030-090507-bbbb';
    await store.begin(newManifest(s, when));
    const sink = store.sink(s, 'screen', 'webm', { flushBytes: 50, flushMs: 1e9 });
    const sizes: number[] = [];
    for (let i = 0; i < 4; i++) {
      sink.push(chunk(50));
      await new Promise((r) => setTimeout(r, 0));
      sizes.push(await store.sizeOf(s));
    }
    expect(sizes[3]).toBeGreaterThan(sizes[0]);
    expect(sizes.every((n, i) => i === 0 || n >= sizes[i - 1])).toBe(true);
  });

  test('sessions without a manifest are still found, from their file names', async () => {
    const { dir, files } = memoryDir();
    files.set(segmentName('rec-20261030-090507-cccc', 'screen', 1, 'webm'), chunk(10));
    files.set(segmentName('rec-20261030-090507-cccc', 'mic', 1, 'webm'), chunk(4));
    const [only] = await new RecordingStore(dir).list();
    expect(only.manifest.name).toBe('Recording 2026-10-30 09.05.07.webm');
    expect(only.parts.map((p) => [p.role, p.mime])).toEqual([
      ['screen', 'video/webm'],
      ['mic', 'audio/webm'],
    ]);
  });

  test('load joins segments into one File per part with the right name and type', async () => {
    const { dir } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-dddd', [
      ['screen', 30],
      ['mic', 5],
    ]);
    const loaded = await new RecordingStore(dir).load('rec-20261030-090507-dddd');
    expect(loaded.map((l) => l.role)).toEqual(['screen', 'mic']);
    expect(loaded[0].file.size).toBe(60);
    expect(loaded[0].file.name).toBe('Recording 2026-10-30 09.05.07.webm');
    expect(loaded[1].file.type).toBe('audio/webm');
    expect(loaded[1].file.name).toBe('Microphone 2026-10-30 09.05.07.webm');
  });

  test('a session another window is recording is neither listed nor swept', async () => {
    const { dir } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-eeee', [['screen', 10]]);
    const other = new RecordingStore(dir, { activeSessions: async () => new Set(['rec-20261030-090507-eeee']) });
    expect(await other.list()).toHaveLength(0);
    await other.sweep();
    expect(await store.list()).toHaveLength(1);
  });

  test('sweep removes imported and empty sessions and keeps the rest', async () => {
    const { dir, files } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-ffff', [['screen', 10]]);
    await record(store, 'rec-20261030-090508-gggg', [['screen', 10]]);
    await store.begin(newManifest('rec-20261030-090509-hhhh', when)); // manifest only: nothing recorded
    await store.markImported('rec-20261030-090507-ffff');
    const keep = await store.sweep();
    expect(keep.map((s) => s.session)).toEqual(['rec-20261030-090508-gggg']);
    expect([...files.keys()].every((n) => n.startsWith('rec-20261030-090508-gggg'))).toBe(true);
  });

  test('discard deletes every file of the session only', async () => {
    const { dir, files } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-iiii', [
      ['screen', 10],
      ['webcam', 10],
    ]);
    await record(store, 'rec-20261030-090508-jjjj', [['screen', 10]]);
    await store.discard('rec-20261030-090507-iiii');
    expect([...files.keys()].every((n) => n.startsWith('rec-20261030-090508-jjjj'))).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  test('update merges into the manifest', async () => {
    const { dir } = memoryDir();
    const store = new RecordingStore(dir);
    await record(store, 'rec-20261030-090507-kkkk', [['screen', 10]]);
    await store.update('rec-20261030-090507-kkkk', { complete: true, seconds: 12.5 });
    const [s] = await new RecordingStore(dir).list();
    expect(s.manifest.complete).toBe(true);
    expect(s.manifest.seconds).toBe(12.5);
    expect(s.manifest.name).toBe('Recording 2026-10-30 09.05.07.webm');
  });
});
