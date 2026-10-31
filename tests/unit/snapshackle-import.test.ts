// SnapShackle captures through the host: the page-side list and import logic (src/engine/snapshackleHost.ts),
// the description field on media, and static checks that the host files stay wired and ASCII.
// The host's own path rules are exercised on Windows by tests/ps/Captures.Tests.ps1.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DESCRIPTION_CHARS, createProject, parseProject } from '../../src/engine/project';
import {
  HOST_CAPTURE_LIMIT,
  HOST_IMPORT_MAX,
  HOST_OCR_MAX_CHARS,
  type HostCapture,
  HostCaptureError,
  captureMime,
  captureUrl,
  fetchCaptureList,
  filterCaptures,
  firstOcrLine,
  hostHasSnapshackle,
  isCaptureName,
  loadCaptureFiles,
  parseCaptureList,
} from '../../src/engine/snapshackleHost';

const root = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const cap = (name: string, minutesAgo: number, ocr = ''): HostCapture => ({
  name,
  size: 100,
  modified: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString(),
  kind: /\.(mp4|webm)$/i.test(name) ? 'video' : 'image',
  hasOcr: ocr.trim() !== '',
  ocr,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------- names ----------

test('capture names: the host rules, applied on the page too', () => {
  for (const ok of ['SnapShackle-20260101-120000-123-abcd1234.png', 'a.png', 'My Shot (2).JPG', 'x_y-z+1.webp', 'clip.mp4', 'c.jpeg', 'a.b.gif', `${'a'.repeat(116)}.png`]) {
    expect(isCaptureName(ok)).toBe(true);
  }
  const hostile = [
    '..\\x.png', '../x.png', '..%5cx.png', 'a/b.png', 'a\\b.png', 'C:\\x.png', 'C:x.png', '\\\\server\\share\\x.png',
    'con.png', 'CON.PNG', 'nul.png', 'com1.png', 'LPT9.webp', 'con .png', 'aux.x.png',
    'x.png:stream', 'x.png::$DATA', 'x.png.', 'x.png ', ' x.png', '.', '..', '', '.png', 'x',
    'x.exe', 'x.svg', 'x.html', 'x.png.meta.json', 'x.png.exe', 'x%2e.png', 'x.png\n', 'x\n.png', 'x*.png', 'x".png', 'x\u00e9.png',
    `${'a'.repeat(117)}.png`,
  ];
  for (const bad of hostile) expect(isCaptureName(bad)).toBe(false);
  expect(isCaptureName(null)).toBe(false);
  expect(isCaptureName(5)).toBe(false);
});

test('capture URL encodes the name as one segment; MIME comes from the extension', () => {
  expect(captureUrl('My Shot (2).png')).toBe('/api/snapshackle/captures/My%20Shot%20(2).png');
  expect(captureUrl('a+b.png')).toBe('/api/snapshackle/captures/a%2Bb.png');
  expect(captureMime('a.PNG')).toBe('image/png');
  expect(captureMime('a.jpeg')).toBe('image/jpeg');
  expect(captureMime('a.webm')).toBe('video/webm');
  expect(captureMime('a.mp4')).toBe('video/mp4');
});

// ---------- parsing the host's list ----------

test('parseCaptureList keeps good items, drops bad ones, caps OCR text, keeps newest first', () => {
  const list = parseCaptureList({
    total: 9,
    captures: [
      { name: 'old.png', size: 1, modified: '2026-01-01T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: '' },
      { name: 'new.png', size: 2, modified: '2026-02-01T00:00:00.000Z', kind: 'image', hasOcr: true, ocr: 'x'.repeat(HOST_OCR_MAX_CHARS + 500) },
      { name: '..\\evil.png', size: 1, modified: '2026-03-01T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: '' },
      { name: 'virus.exe', size: 1, modified: '2026-03-01T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: '' },
      { name: 'new.png', size: 2, modified: '2026-02-01T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: '' },
      { name: 'nodate.png', size: 1, modified: 'yesterday', kind: 'image', hasOcr: false, ocr: '' },
      { name: 'clip.webm', size: 3, modified: '2026-01-15T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: 7 },
      null,
      'text',
    ],
  });
  expect(list.captures.map((c) => c.name)).toEqual(['new.png', 'clip.webm', 'old.png']);
  expect(list.captures[0].ocr.length).toBe(HOST_OCR_MAX_CHARS);
  expect(list.captures[0].hasOcr).toBe(true);
  // The kind comes from the extension, not from what the host claims.
  expect(list.captures[1].kind).toBe('video');
  expect(list.captures[1].ocr).toBe('');
  expect(list.total).toBe(9);
});

test('parseCaptureList survives garbage and keeps at most 500', () => {
  expect(parseCaptureList(null)).toEqual({ captures: [], total: 0 });
  expect(parseCaptureList('nope')).toEqual({ captures: [], total: 0 });
  expect(parseCaptureList({ captures: 'x' })).toEqual({ captures: [], total: 0 });
  const many = Array.from({ length: 650 }, (_, i) => ({ name: `c${i}.png`, size: 1, modified: new Date(2026, 0, 1, 0, i).toISOString(), kind: 'image', hasOcr: false, ocr: '' }));
  const list = parseCaptureList({ captures: many, total: 650 });
  expect(list.captures.length).toBe(HOST_CAPTURE_LIMIT);
  expect(list.total).toBe(650);
});

test('firstOcrLine and search over names and OCR text', () => {
  expect(firstOcrLine('\n  \n  Invoice 4711  \nsecond')).toBe('Invoice 4711');
  expect(firstOcrLine('')).toBe('');
  expect(firstOcrLine('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`);
  const all = [cap('Shot-1.png', 1, 'Quarterly invoice 4711'), cap('Shot-2.png', 2, 'Meeting notes'), cap('Invoice-scan.png', 3), cap('clip.webm', 4)];
  expect(filterCaptures(all, '').length).toBe(4);
  expect(filterCaptures(all, '  ').length).toBe(4);
  expect(filterCaptures(all, 'INVOICE').map((c) => c.name)).toEqual(['Shot-1.png', 'Invoice-scan.png']);
  expect(filterCaptures(all, 'invoice 4711').map((c) => c.name)).toEqual(['Shot-1.png']);
  expect(filterCaptures(all, 'shot-2 notes').map((c) => c.name)).toEqual(['Shot-2.png']);
  expect(filterCaptures(all, 'nothing like this')).toEqual([]);
});

// ---------- talking to the host ----------

test('hostHasSnapshackle: true only when health says so; every failure means no', async () => {
  const seen: Array<{ url: string; token: string | undefined }> = [];
  const ok = async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, token: init?.headers?.['X-Capstan-Token'] });
    return json({ app: 'Capstan', snapshackle: true });
  };
  expect(await hostHasSnapshackle('tok', ok)).toBe(true);
  expect(seen).toEqual([{ url: '/api/health', token: 'tok' }]);
  expect(await hostHasSnapshackle('tok', async () => json({ snapshackle: false }))).toBe(false);
  expect(await hostHasSnapshackle('tok', async () => json({ snapshackle: 'true' }))).toBe(false);
  expect(await hostHasSnapshackle('tok', async () => json({}))).toBe(false);
  expect(await hostHasSnapshackle('tok', async () => json({ snapshackle: true }, 403))).toBe(false);
  expect(await hostHasSnapshackle('tok', async () => Promise.reject(new Error('down')))).toBe(false);
  expect(await hostHasSnapshackle('', ok)).toBe(false);
});

test('fetchCaptureList: sends the token, says why when it fails', async () => {
  let token: string | undefined;
  const list = await fetchCaptureList(
    'tok',
    async (_url, init) => {
      token = init?.headers?.['X-Capstan-Token'];
      return json({ captures: [{ name: 'a.png', size: 1, modified: '2026-01-01T00:00:00.000Z', kind: 'image', hasOcr: false, ocr: '' }], total: 1 });
    },
  );
  expect(token).toBe('tok');
  expect(list.captures.length).toBe(1);

  const none = await fetchCaptureList('tok', async () => json({ error: 'No SnapShackle captures folder found' }, 404)).catch((e: unknown) => e);
  expect(none).toBeInstanceOf(HostCaptureError);
  expect((none as HostCaptureError).code).toBe('no-folder');
  expect((none as Error).message).toMatch(/No SnapShackle Captures folder/);

  const bad = await fetchCaptureList('tok', async () => json({}, 500)).catch((e: unknown) => e);
  expect((bad as HostCaptureError).code).toBe('host');
  expect((bad as Error).message).toContain('500');

  const down = await fetchCaptureList('tok', async () => Promise.reject(new TypeError('fetch failed'))).catch((e: unknown) => e);
  expect((down as HostCaptureError).code).toBe('network');

  const junk = await fetchCaptureList('tok', async () => new Response('not json', { status: 200 })).catch((e: unknown) => e);
  expect((junk as HostCaptureError).code).toBe('host');
});

test('loadCaptureFiles: oldest first, OCR kept per file, a file that cannot be read is reported, not fatal', async () => {
  const chosen = [cap('b.png', 1, 'text of b'), cap('a.png', 5), cap('gone.png', 3, 'lost'), cap('empty.png', 4), cap('clip.webm', 2)];
  const asked: string[] = [];
  const fetchFn = async (url: string) => {
    asked.push(decodeURIComponent(url.split('/').pop() ?? ''));
    if (url.endsWith('gone.png')) return json({ error: 'Capture not found' }, 404);
    if (url.endsWith('empty.png')) return new Response(new Uint8Array(0), { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  const progress: string[] = [];
  const out = await loadCaptureFiles(chosen, 'tok', fetchFn, undefined, (done, total, name) => progress.push(`${done}/${total} ${name}`));
  expect(asked).toEqual(['a.png', 'empty.png', 'gone.png', 'clip.webm', 'b.png']);
  expect(out.files.map((f) => f.name)).toEqual(['a.png', 'clip.webm', 'b.png']);
  expect(out.files.map((f) => f.type)).toEqual(['image/png', 'video/webm', 'image/png']);
  expect(out.files[2].lastModified).toBe(Date.parse(chosen[0].modified));
  expect([...out.descriptions.values()]).toEqual(['text of b']);
  expect(out.descriptions.get(out.files[2])).toBe('text of b');
  expect(out.failed).toEqual([
    { name: 'empty.png', reason: 'the file is empty' },
    { name: 'gone.png', reason: 'it is no longer in the folder' },
  ]);
  expect(progress[0]).toBe('0/5 a.png');
});

test('loadCaptureFiles never asks the host for a name the host would refuse', async () => {
  let calls = 0;
  const out = await loadCaptureFiles([cap('..\\x.png', 1), cap('con.png', 2)], 'tok', async () => {
    calls++;
    return new Response('x');
  });
  expect(calls).toBe(0);
  expect(out.files).toEqual([]);
  expect(out.failed.length).toBe(2);
});

test('an aborted import stops instead of reporting every file as failed', async () => {
  const ac = new AbortController();
  const fetchFn = async () => {
    ac.abort();
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await expect(loadCaptureFiles([cap('a.png', 1), cap('b.png', 2)], 'tok', fetchFn, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

test('at most 100 captures are imported at a time', () => {
  expect(HOST_IMPORT_MAX).toBe(100);
});

// ---------- the description on a media item ----------

const media = (extra: Record<string, unknown>) => ({
  id: 'med_1', name: 'a.png', kind: 'image', mime: 'image/png', bytes: 1, duration: 0, width: 1, height: 1, hasAudio: false, createdAt: 1, ...extra,
});
const withMedia = (extra: Record<string, unknown>) => ({ ...createProject('p'), media: [media(extra)] });

test('MediaItem.description survives a project round trip and is capped on load', () => {
  const kept = parseProject(JSON.parse(JSON.stringify(withMedia({ description: 'Invoice 4711\nline two' }))));
  expect(kept.media[0].description).toBe('Invoice 4711\nline two');
  const long = parseProject(withMedia({ description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1000) }));
  expect(long.media[0].description?.length).toBe(MAX_DESCRIPTION_CHARS);
});

test('a description that is not text, or blank, is dropped on load', () => {
  for (const bad of [5, null, {}, ['a'], '', '   \n ']) {
    expect('description' in parseProject(withMedia({ description: bad })).media[0]).toBe(false);
  }
  expect('description' in parseProject(withMedia({})).media[0]).toBe(false);
});

// ---------- host wiring, checked statically (PowerShell does not run on the Linux build machine) ----------

test('Start-Capstan.ps1 loads Captures.ps1 and hooks the two routes and the health flag', () => {
  const host = read('Start-Capstan.ps1');
  expect(host).toContain("modules/Captures.ps1");
  expect(host).toContain("'/api/snapshackle/captures'");
  expect(host).toContain('Invoke-CapstanCaptureRoute');
  expect(host).toContain('snapshackle=[bool](Get-CapstanCapturesRoot)');
  // The routes sit after the session-token check, never before it.
  expect(host.indexOf('/api/snapshackle/captures')).toBeGreaterThan(host.indexOf('# Everything below needs the per-launch session token'));
});

test('Captures.ps1 is read-only, ASCII and takes no path from a request', () => {
  const ps = read('modules/Captures.ps1');
  expect(/[^\x00-\x7f]/.test(ps)).toBe(false);
  expect(read('tests/ps/Captures.Tests.ps1').match(/[^\x00-\x7f]/)).toBeNull();
  expect(ps.replace(/<#[\s\S]*?#>/, '')).not.toMatch(/WriteAll|Set-Content|Out-File|Add-Content|Remove-Item|New-Item|Move-Item|Copy-Item|\bInvoke-WebRequest\b|Invoke-RestMethod|Add-Type/);
  expect(ps).toContain('CAPSTAN_TEST_CAPTURES');
  expect(ps).toContain('ReparsePoint');
  expect(ps).toContain("'\\A[A-Za-z0-9 _.()+-]{1,120}\\z'");
  expect(ps).toContain('CapstanCaptureLimit = 500');
  expect(ps).toContain("'.meta.json'");
  // Only these three folders, in this order.
  expect(ps.indexOf("'SnapShackle', 'Captures'")).toBeLessThan(ps.indexOf("'CutterMk', 'Captures'"));
  expect(ps.indexOf("'CutterMk', 'Captures'")).toBeLessThan(ps.indexOf("'Lasso', 'Captures'"));
});

test('the transport streams files in buffers of at most 1 MB', () => {
  const t = read('modules/LocalHttp.ps1');
  expect(t).toContain('const int StreamChunk=1048576;');
  expect(t).toContain('public void SetStream(Stream source,long length)');
  expect(t).toContain('StatusCode==405?"Method Not Allowed"');
});

test('Captures.Tests.ps1 is part of the CI windows-host job', () => {
  expect(read('.github/workflows/tests.yml')).toContain('tests\\ps\\Captures.Tests.ps1');
});

test('the test server mirrors the routes and the health flag', () => {
  const s = read('tests/serve.mjs');
  expect(s).toContain('/api/snapshackle/captures');
  expect(s).toContain('CAPSTAN_TEST_CAPTURES');
  expect(s).toContain('snapshackle: !!(await capturesRoot())');
  expect(s).toContain("'x-capstan-token'");
});

test('docs/ARCHITECTURE.md has the Security notes for the captures routes', () => {
  const a = read('docs/ARCHITECTURE.md');
  expect(a).toContain('Security notes: SnapShackle captures');
  expect(a).toContain('Researcher');
});
