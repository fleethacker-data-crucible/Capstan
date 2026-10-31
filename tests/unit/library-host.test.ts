// The page's client for the host's on-disk media library, against a fake fetch (no server, no browser).
import { describe, expect, test } from 'bun:test';
import { HOST_CHUNK_BYTES, HostLibrary, type HostFileInfo, type HostLibraryLike, type UploadOptions, isLibraryId, sha256Hex, sniffMime } from '../../src/engine/library-host';
import { LibraryMirror } from '../../src/engine/library-mirror';

// ---------- a fake host: the same routes as modules/Library.ps1, in memory ----------
interface Upload {
  size: number;
  chunk: number;
  parts: Map<number, Uint8Array>;
}
function fakeHost(options: { chunk?: number; ignoreRange?: boolean; failPuts?: (part: number, attempt: number) => 'network' | 500 | null } = {}) {
  const chunk = options.chunk ?? 1000;
  const files = new Map<string, Uint8Array>();
  const uploads = new Map<string, Upload>();
  const log: string[] = [];
  const tokens = new Set<string | null>();
  const attempts = new Map<string, number>();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    tokens.add(headers.get('x-capstan-token'));
    const url = new URL(input, 'http://127.0.0.1:1');
    log.push(`${method} ${url.pathname}${url.search}`);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (headers.get('x-capstan-token') !== 'tok') return json(403, { error: 'Invalid session' });
    if (url.pathname === '/api/health') return json(200, { library: true, libraryMaxBytes: 1e9 });
    const m = /^\/api\/files(?:\/([^/]+?)(\/complete)?)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'Route not found', code: 'not_found' });
    const [, id, complete] = m;
    if (!id) {
      if (method === 'GET') return json(200, { files: [...files].map(([k, v]) => ({ id: k, size: v.length, modified: '2026-01-01T00:00:00.000Z' })) });
      const b = JSON.parse(String(init.body)) as { id: string; size: number; sha256?: string };
      const old = uploads.get(b.id);
      if (old) {
        if (old.size !== b.size) return json(409, { code: 'upload_exists', error: 'x' });
        return json(200, { id: b.id, size: b.size, chunkSize: chunk, parts: Math.ceil(b.size / chunk), received: [...old.parts.keys()], resumed: true });
      }
      uploads.set(b.id, { size: b.size, chunk, parts: new Map() });
      return json(200, { id: b.id, size: b.size, chunkSize: chunk, parts: Math.ceil(b.size / chunk), received: [], resumed: false });
    }
    if (complete) {
      const u = uploads.get(id);
      if (!u) return json(404, { code: 'no_upload', error: 'x' });
      const count = Math.ceil(u.size / u.chunk);
      if (u.parts.size !== count) return json(409, { code: 'incomplete', error: 'x', missing: [] });
      const out = new Uint8Array(u.size);
      for (const [p, bytes] of u.parts) out.set(bytes, p * u.chunk);
      files.set(id, out);
      uploads.delete(id);
      return json(200, { ok: true, id });
    }
    if (method === 'PUT') {
      const u = uploads.get(id);
      if (!u) return json(404, { code: 'no_upload', error: 'x' });
      const part = Number(url.searchParams.get('part'));
      const key = `${id}#${part}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const fail = options.failPuts?.(part, attempt);
      if (fail === 'network') throw new TypeError('network down');
      if (fail === 500) return json(500, { code: 'failed', error: 'The library request failed' });
      u.parts.set(part, new Uint8Array(await (init.body as Blob).arrayBuffer()));
      return json(200, { ok: true, part });
    }
    if (method === 'DELETE') {
      const only = url.searchParams.get('upload');
      const had = uploads.delete(id);
      const had2 = !only && files.delete(id);
      return had || had2 ? json(200, { ok: true }) : json(404, { code: 'not_found', error: 'x' });
    }
    if (method === 'GET') {
      const f = files.get(id);
      if (!f) return json(404, { code: 'not_found', error: 'x' });
      const r = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range') ?? '');
      if (!r || options.ignoreRange) return new Response(f, { status: 200 });
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), f.length - 1);
      if (a >= f.length) return json(416, { code: 'bad_range', error: 'x' });
      return new Response(f.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${f.length}` } });
    }
    return json(405, { error: 'Method not allowed' });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, files, uploads, log, tokens };
}
const bytesOf = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed + (i >> 8)) & 255;
  return b;
};
const make = (host: ReturnType<typeof fakeHost>, extra: Partial<ConstructorParameters<typeof HostLibrary>[0]> = {}) => new HostLibrary({ fetch: host.fetch, token: () => 'tok', retryDelayMs: 0, ...extra });
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe('ids', () => {
  test('the host pattern, and the reserved device names', () => {
    for (const ok of ['a', 'med_lq1x2y3', 'x-1', 'a'.repeat(80)]) expect(isLibraryId(ok)).toBe(true);
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'C:\\x', 'con', 'nul', 'com1', 'lpt9', 'x:stream', 'ABC', 'a b', 'a.', 'a.txt', 'a'.repeat(81), 'a\n', '%2e%2e']) expect(isLibraryId(bad)).toBe(false);
  });
});

describe('sniffMime', () => {
  const h = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  test('recognises the formats Capstan imports', () => {
    expect(sniffMime(h(0x1a, 0x45, 0xdf, 0xa3))).toBe('video/webm');
    expect(sniffMime(new TextEncoder().encode('\0\0\0\x20ftypisom....'))).toBe('video/mp4');
    expect(sniffMime(new TextEncoder().encode('RIFF....WAVEfmt '))).toBe('audio/wav');
    expect(sniffMime(h(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMime(h(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMime(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
    expect(sniffMime(new TextEncoder().encode('OggS........'))).toBe('audio/ogg');
    expect(sniffMime(new TextEncoder().encode('ID3\x04.......'))).toBe('audio/mpeg');
  });
  test('unknown bytes give no type', () => {
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBe('');
    expect(sniffMime(new Uint8Array(0))).toBe('');
  });
});

describe('HostLibrary.probe', () => {
  test('reads the library flag with the token', async () => {
    const host = fakeHost();
    expect(await make(host).probe()).toEqual({ library: true, maxBytes: 1e9 });
  });
  test('without a session token it does not even ask', async () => {
    const host = fakeHost();
    const lib = new HostLibrary({ fetch: host.fetch, token: () => '' });
    expect((await lib.probe()).library).toBe(false);
    expect(host.log.length).toBe(0);
  });
  test('a refused token is not a library', async () => {
    const host = fakeHost();
    const lib = new HostLibrary({ fetch: host.fetch, token: () => 'wrong' });
    expect((await lib.probe()).library).toBe(false);
  });
});

describe('HostLibrary.upload', () => {
  test('sends a multi-chunk file in parts, with progress, and the host ends up with the same bytes', async () => {
    const host = fakeHost({ chunk: 1000 });
    const data = bytesOf(2500);
    const seen: Array<[number, number]> = [];
    await make(host).upload('clip_1', new Blob([data]), { onProgress: (d, t) => seen.push([d, t]) });
    expect(same(host.files.get('clip_1') as Uint8Array, data)).toBe(true);
    expect(host.log.filter((l) => l.startsWith('PUT')).map((l) => l.split('?')[1])).toEqual(['part=0', 'part=1', 'part=2']);
    expect(seen[0]).toEqual([0, 2500]);
    expect(seen.at(-1)).toEqual([2500, 2500]);
    expect(seen.map((s) => s[0])).toEqual([...seen.map((s) => s[0])].sort((a, b) => a - b));
    expect(host.uploads.size).toBe(0);
  });
  test('every request carries the session token, none goes without', async () => {
    const host = fakeHost();
    await make(host).upload('t1', new Blob([bytesOf(1500)]));
    await make(host).list();
    await make(host).download('t1');
    await make(host).remove('t1');
    expect([...host.tokens]).toEqual(['tok']);
  });
  test('init carries the size and the SHA-256 of the file', async () => {
    const seen: unknown[] = [];
    const host = fakeHost();
    const inner = host.fetch;
    const spy = ((input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/api/files') seen.push(JSON.parse(String(init.body)));
      return inner(input, init);
    }) as unknown as typeof fetch;
    const data = bytesOf(1200);
    await new HostLibrary({ fetch: spy, token: () => 'tok' }).upload('h1', new Blob([data]));
    expect(seen).toEqual([{ id: 'h1', size: 1200, sha256: await sha256Hex(new Blob([data])) }]);
  });
  test('a failed chunk is retried; a part that fails every time stops the upload and keeps what arrived', async () => {
    const flaky = fakeHost({ failPuts: (p, a) => (p === 1 && a === 1 ? 'network' : null) });
    await make(flaky).upload('f1', new Blob([bytesOf(2500)]));
    expect(flaky.files.has('f1')).toBe(true);

    const broken = fakeHost({ failPuts: (p) => (p === 1 ? 500 : null) });
    await expect(make(broken).upload('f2', new Blob([bytesOf(2500)]))).rejects.toThrow();
    expect(broken.files.has('f2')).toBe(false);
    expect([...(broken.uploads.get('f2')?.parts.keys() ?? [])]).toEqual([0]);
  });
  test('a second attempt resumes: only the missing parts are sent', async () => {
    let healthy = false;
    const host = fakeHost({ failPuts: (p) => (!healthy && p === 1 ? 'network' : null) });
    const lib = make(host, { attempts: 1 });
    const data = bytesOf(3500);
    await expect(lib.upload('r1', new Blob([data]))).rejects.toThrow();
    healthy = true;
    host.log.length = 0;
    const seen: number[] = [];
    await lib.upload('r1', new Blob([data]), { onProgress: (d) => seen.push(d) });
    const puts = host.log.filter((l) => l.startsWith('PUT')).map((l) => l.split('?')[1]);
    expect(puts).toEqual(['part=1', 'part=2', 'part=3']);
    expect(seen[0]).toBe(1000);
    expect(same(host.files.get('r1') as Uint8Array, data)).toBe(true);
  });
  test('cancelling stops sending, drops the upload on the host and rejects with an AbortError', async () => {
    const host = fakeHost();
    const ctrl = new AbortController();
    const data = bytesOf(5000);
    const p = make(host).upload('c1', new Blob([data]), { signal: ctrl.signal, onProgress: (d) => d >= 2000 && ctrl.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.files.has('c1')).toBe(false);
    expect(host.uploads.has('c1')).toBe(false);
    expect(host.log.some((l) => l.startsWith('DELETE /api/files/c1?upload=1'))).toBe(true);
    expect(host.log.filter((l) => l.startsWith('PUT')).length).toBeLessThan(5);
  });
  test('an id the host would refuse, or an empty file, never reaches the network', async () => {
    const host = fakeHost();
    await expect(make(host).upload('../x', new Blob([bytesOf(10)]))).rejects.toThrow();
    await expect(make(host).upload('con', new Blob([bytesOf(10)]))).rejects.toThrow();
    await expect(make(host).upload('ok', new Blob([]))).rejects.toThrow();
    expect(host.log.length).toBe(0);
  });
  test('a handle with an unusable chunk size is rejected', async () => {
    const host = fakeHost({ chunk: HOST_CHUNK_BYTES + 1 });
    await expect(make(host).upload('big', new Blob([bytesOf(50)]))).rejects.toThrow(/unusable/);
  });
  test('large files skip the whole-file hash (Web Crypto cannot stream)', async () => {
    const seen: unknown[] = [];
    const host = fakeHost();
    const spy = ((input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/api/files') seen.push(JSON.parse(String(init.body)));
      return host.fetch(input, init);
    }) as unknown as typeof fetch;
    await new HostLibrary({ fetch: spy, token: () => 'tok' }).upload('nohash', new Blob([bytesOf(1500)]), { sha256: undefined } as UploadOptions);
    expect(seen.length).toBe(1);
  });
});

describe('HostLibrary.download, list, remove', () => {
  test('reads a file back in ranged pieces and gives a Blob with the sniffed type', async () => {
    const host = fakeHost();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bytesOf(40)]);
    host.files.set('p1', png);
    const blob = await make(host).download('p1');
    expect(blob?.type).toBe('image/png');
    expect(same(new Uint8Array(await (blob as Blob).arrayBuffer()), png)).toBe(true);
  });
  test('a file bigger than one piece is reassembled in order, with progress', async () => {
    const host = fakeHost();
    const data = bytesOf(HOST_CHUNK_BYTES * 2 + 123);
    host.files.set('big1', data);
    const seen: number[] = [];
    const blob = await make(host).download('big1', { onProgress: (d) => seen.push(d) });
    expect(blob?.size).toBe(data.length);
    expect(same(new Uint8Array(await (blob as Blob).arrayBuffer()), data)).toBe(true);
    expect(host.log.filter((l) => l.startsWith('GET /api/files/big1')).length).toBe(3);
    expect(seen).toEqual([HOST_CHUNK_BYTES, HOST_CHUNK_BYTES * 2, data.length]);
  });
  test('a host that ignores Range still works', async () => {
    const host = fakeHost({ ignoreRange: true });
    host.files.set('w1', bytesOf(300));
    expect((await make(host).download('w1'))?.size).toBe(300);
  });
  test('unknown ids and ids the host would refuse give null', async () => {
    const host = fakeHost();
    expect(await make(host).download('nothing')).toBeNull();
    expect(await make(host).download('../x')).toBeNull();
    expect(host.log.filter((l) => l.includes('..')).length).toBe(0);
  });
  test('list and remove', async () => {
    const host = fakeHost();
    host.files.set('a1', bytesOf(5));
    host.files.set('b1', bytesOf(9));
    const lib = make(host);
    expect((await lib.list()).map((f) => [f.id, f.size])).toEqual([['a1', 5], ['b1', 9]]);
    expect(await lib.remove('a1')).toBe(true);
    expect(await lib.remove('a1')).toBe(false);
    expect((await lib.list()).map((f) => f.id)).toEqual(['b1']);
  });
});

// ---------- the write-through / fallback layer ----------
function fakeLibrary(over: Partial<HostLibraryLike> = {}) {
  const stored = new Map<string, Blob>();
  const calls: string[] = [];
  const lib: HostLibraryLike = {
    probe: async () => ({ library: true, maxBytes: 1e9 }),
    list: async () => [...stored].map(([id, b]) => ({ id, size: b.size, modified: '' }) as HostFileInfo),
    upload: async (id, blob) => {
      calls.push(`upload ${id}`);
      stored.set(id, blob);
    },
    download: async (id) => {
      calls.push(`download ${id}`);
      return stored.get(id) ?? null;
    },
    remove: async (id) => {
      calls.push(`remove ${id}`);
      return stored.delete(id);
    },
    ...over,
  };
  return { lib, stored, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('LibraryMirror', () => {
  test('store copies to the host in the background and counts what is pending', async () => {
    const f = fakeLibrary();
    const m = new LibraryMirror(() => f.lib);
    const seen: number[] = [];
    m.subscribe((s) => seen.push(s.pending));
    m.store('m1', new Blob(['hello']));
    expect(f.stored.size).toBe(0); // not synchronous: an edit never waits for it
    await settle();
    expect(f.stored.get('m1')?.size).toBe(5);
    expect(m.state).toMatchObject({ active: true, pending: 0, failed: 0 });
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(1);
  });
  test('a failed upload is reported, counted, and does not throw into the caller', async () => {
    const f = fakeLibrary({ upload: async () => { throw new Error('disk full'); } });
    const m = new LibraryMirror(() => f.lib);
    const messages: string[] = [];
    m.setReporter((t) => messages.push(t));
    expect(() => m.store('m1', new Blob(['x']), 'clip.webm')).not.toThrow();
    await settle();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('clip.webm');
    expect(messages[0]).toContain('disk full');
    expect(messages[0]).toContain('still saved in this browser');
    expect(m.state).toMatchObject({ failed: 1, pending: 0 });
    expect(m.state.lastError).toContain('disk full');
  });
  test('uploads run one at a time, in order', async () => {
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const f = fakeLibrary({
      upload: async (id) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 3));
        order.push(id);
        running--;
      },
    });
    const m = new LibraryMirror(() => f.lib);
    for (const id of ['a1', 'b1', 'c1']) m.store(id, new Blob(['x']));
    await new Promise((r) => setTimeout(r, 40));
    expect(peak).toBe(1);
    expect(order).toEqual(['a1', 'b1', 'c1']);
  });
  test('fetch reads from the host and gives null when it has nothing', async () => {
    const f = fakeLibrary();
    f.stored.set('m2', new Blob(['abc']));
    const m = new LibraryMirror(() => f.lib);
    expect((await m.fetch('m2'))?.size).toBe(3);
    expect(await m.fetch('nope')).toBeNull();
  });
  test('a failed read is reported and gives null, not an exception', async () => {
    const f = fakeLibrary({ download: async () => { throw new Error('reset'); } });
    const m = new LibraryMirror(() => f.lib);
    const messages: string[] = [];
    m.setReporter((t) => messages.push(t));
    expect(await m.fetch('m3')).toBeNull();
    expect(messages[0]).toContain('reset');
  });
  test('without a host library every call is a quiet no-op', async () => {
    for (const make of [() => null, () => fakeLibrary({ probe: async () => ({ library: false, maxBytes: 0 }) }).lib, () => fakeLibrary({ probe: async () => { throw new Error('down'); } }).lib]) {
      const m = new LibraryMirror(make);
      const messages: string[] = [];
      m.setReporter((t) => messages.push(t));
      m.store('m1', new Blob(['x']));
      m.noteLocal('m1', new Blob(['x']));
      m.forget('m1');
      expect(await m.fetch('m1')).toBeNull();
      await settle();
      expect(m.state).toMatchObject({ active: false, pending: 0, failed: 0 });
      expect(messages).toEqual([]);
    }
  });
  test('ids the host would refuse stay in the browser only', async () => {
    const f = fakeLibrary();
    const m = new LibraryMirror(() => f.lib);
    m.store('../evil', new Blob(['x']));
    m.store('Upper', new Blob(['x']));
    expect(await m.fetch('con')).toBeNull();
    await settle();
    expect(f.calls).toEqual([]);
  });
  test('noteLocal copies media the host lacks, but not what it already has', async () => {
    const f = fakeLibrary();
    f.stored.set('have', new Blob(['12345']));
    f.stored.set('changed', new Blob(['12']));
    const m = new LibraryMirror(() => f.lib);
    m.noteLocal('have', new Blob(['12345']));
    m.noteLocal('lack', new Blob(['12345']));
    m.noteLocal('changed', new Blob(['1'])); // a different size: the host's copy is out of date
    await settle();
    expect(f.calls.filter((c) => c.startsWith('upload'))).toEqual(['upload lack', 'upload changed']);
  });
  test('forget removes the host copy and cancels a pending upload', async () => {
    const f = fakeLibrary();
    const m = new LibraryMirror(() => f.lib);
    m.store('keep', new Blob(['x']));
    await settle();
    m.forget('keep');
    await settle();
    expect(f.stored.has('keep')).toBe(false);
    expect(f.calls).toContain('remove keep');
  });
  test('storing an id again while one is pending uploads only the newest', async () => {
    const f = fakeLibrary({
      upload: async (id, blob, o?: UploadOptions) => {
        await new Promise((r) => setTimeout(r, 5));
        if (o?.signal?.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' });
        f.stored.set(id, blob);
      },
    });
    const m = new LibraryMirror(() => f.lib);
    m.store('same', new Blob(['old']));
    await settle();
    m.store('same', new Blob(['newer']));
    await new Promise((r) => setTimeout(r, 40));
    expect(f.stored.get('same')?.size).toBe(5);
    expect(m.state.failed).toBe(0);
  });
});
