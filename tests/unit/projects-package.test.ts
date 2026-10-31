import { expect, test } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import { addClip, addMedia } from '../../src/engine/ops';
import { PackageError, mediaEntryName, readPackage, writePackage } from '../../src/engine/package';
import { type MediaItem, createProject } from '../../src/engine/project';
import { cloneProject, copyName, isEmptyProject, summariseProject } from '../../src/engine/projects';
import { type DirHandleLike, type FileHandleLike, collectCaptureFiles } from '../../src/engine/snapshackle';
import { BUILTIN_TEMPLATES, createTemplate, instantiateTemplate, parseTemplate } from '../../src/engine/templates';
import { THEMES, applyThemeToProject, getTheme, themeFontStack } from '../../src/engine/themes';
import { BlobSink, ZipError, crc32, openZip, unsafeEntryName, writeZip } from '../../src/engine/zip';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function zipOf(sources: Parameters<typeof writeZip>[0]): Promise<Uint8Array> {
  const sink = new BlobSink();
  await writeZip(sources, sink);
  return new Uint8Array(await sink.blob().arrayBuffer());
}

function bytesOf(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x >> 16;
  }
  return b;
}

// ---------- CRC and names ----------

test('crc32 matches the standard check value and continues across chunks', () => {
  expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array(0))).toBe(0);
  const a = enc.encode('hello ');
  const b = enc.encode('world');
  expect(crc32(b, crc32(a))).toBe(crc32(enc.encode('hello world')));
});

test('unsafe entry names are refused', () => {
  for (const bad of ['../evil.txt', 'a/../../b', '/abs.txt', 'C:/win.txt', 'a\\b.txt', 'a//b', './a', 'a/./b', '', 'a\u0000b', 'x'.repeat(300)]) {
    expect(unsafeEntryName(bad)).not.toBeNull();
  }
  for (const good of ['project.json', 'media/med_1-clip.webm', 'media/', 'a b/c.txt', 'Ünï.txt']) {
    expect(unsafeEntryName(good)).toBeNull();
  }
});

// ---------- zip round trip ----------

test('zip round trip: stored and deflated entries come back byte for byte', async () => {
  const big = bytesOf(300_000, 7);
  const text = enc.encode(JSON.stringify({ hello: 'world', list: Array.from({ length: 500 }, (_, i) => i) }));
  const bytes = await zipOf([
    { name: 'a.json', data: text, method: 'deflate' },
    { name: 'media/big.bin', data: new Blob([big as BlobPart]), method: 'store' },
    { name: 'empty.txt', data: new Uint8Array(0), method: 'store' },
    { name: 'ü/名前.txt', data: enc.encode('unicode name'), method: 'deflate' },
  ]);
  const zip = await openZip(new Blob([bytes as BlobPart]));
  expect(zip.entries.map((e) => e.name)).toEqual(['a.json', 'media/big.bin', 'empty.txt', 'ü/名前.txt']);
  expect(zip.find('a.json')!.method).toBe(8);
  expect(zip.find('media/big.bin')!.method).toBe(0);
  expect(await zip.bytes(zip.find('a.json')!)).toEqual(text);
  expect(await zip.bytes(zip.find('media/big.bin')!)).toEqual(big);
  expect((await zip.bytes(zip.find('empty.txt')!)).length).toBe(0);
  expect(await zip.text(zip.find('ü/名前.txt')!)).toBe('unicode name');
  expect(zip.find('media/big.bin')!.crc).toBe(crc32(big));
});

test('the deflate entries are standard deflate (node zlib can inflate them)', async () => {
  const text = enc.encode('abc'.repeat(5000));
  const bytes = await zipOf([{ name: 't.txt', data: text, method: 'deflate' }]);
  const zip = await openZip(new Blob([bytes as BlobPart]));
  const e = zip.find('t.txt')!;
  expect(e.method).toBe(8);
  expect(e.compressedSize).toBeLessThan(200);
  // Local header is 30 + name bytes; the data follows.
  const start = e.offset + 30 + 't.txt'.length;
  expect(dec.decode(inflateRawSync(bytes.subarray(start, start + e.compressedSize)))).toBe('abc'.repeat(5000));
});

test('the archive layout is a valid zip: signatures, data descriptor, end record', async () => {
  const bytes = await zipOf([{ name: 'x.bin', data: enc.encode('payload'), method: 'store' }]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(6, true) & 0x0808).toBe(0x0808);
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  const descriptorAt = 30 + 5 + 7;
  expect(view.getUint32(descriptorAt, true)).toBe(0x08074b50);
  expect(view.getUint32(descriptorAt + 4, true)).toBe(crc32(enc.encode('payload')));
  expect(view.getUint32(descriptorAt + 8, true)).toBe(7);
});

test('writer refuses unsafe names, duplicates (any case) and too many entries', async () => {
  const sink = new BlobSink();
  await expect(writeZip([{ name: '../x', data: enc.encode('x') }], sink)).rejects.toThrow(ZipError);
  await expect(writeZip([{ name: '/x', data: enc.encode('x') }], sink)).rejects.toThrow(/absolute/);
  await expect(
    writeZip(
      [
        { name: 'A.txt', data: enc.encode('1') },
        { name: 'a.txt', data: enc.encode('2') },
      ],
      sink,
    ),
  ).rejects.toThrow(/same name/);
  await expect(writeZip([{ name: 'a', data: enc.encode('1') }, { name: 'b', data: enc.encode('2') }], sink, { limits: { maxEntries: 1 } })).rejects.toThrow(/Too many/);
});

// ---------- hostile and damaged archives ----------

/** Builds a minimal zip by hand with exact control over the headers (for attack cases). */
function rawZip(entries: Array<{ name: string; data: Uint8Array; method?: number; crc?: number; size?: number; csize?: number; flags?: number }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let pos = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const method = e.method ?? 0;
    const crc = e.crc ?? crc32(e.data);
    const csize = e.csize ?? e.data.length;
    const size = e.size ?? e.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, csize, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, csize, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, pos, true);
    c.set(name, 46);
    central.push(c);
    parts.push(local, e.data);
    pos += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, pos, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const blobOf = (b: Uint8Array) => new Blob([b as BlobPart]);

test('reader rejects path traversal, absolute and drive-letter names from the central directory', async () => {
  for (const name of ['../evil.txt', 'media/../../evil.txt', '/etc/passwd', 'C:/Windows/x.dll', 'a\\..\\b']) {
    await expect(openZip(blobOf(rawZip([{ name, data: enc.encode('x') }])))).rejects.toThrow(/unsafe file name/);
  }
});

test('reader rejects duplicate names, encryption and unknown compression methods', async () => {
  await expect(
    openZip(
      blobOf(
        rawZip([
          { name: 'a.txt', data: enc.encode('1') },
          { name: 'A.TXT', data: enc.encode('2') },
        ]),
      ),
    ),
  ).rejects.toThrow(/twice/);
  await expect(openZip(blobOf(rawZip([{ name: 'a.txt', data: enc.encode('1'), flags: 1 }])))).rejects.toThrow(/encrypted/);
  await expect(openZip(blobOf(rawZip([{ name: 'a.txt', data: enc.encode('1'), method: 12 }])))).rejects.toThrow(/compression method/);
});

test('size caps: entry count, per-entry size, total size and expansion ratio', async () => {
  const many = rawZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: enc.encode('x') })));
  await expect(openZip(blobOf(many), { maxEntries: 4 })).rejects.toThrow(/too many/);
  const one = rawZip([{ name: 'big.bin', data: new Uint8Array(100) }]);
  await expect(openZip(blobOf(one), { maxEntryBytes: 99 })).rejects.toThrow(/larger than allowed/);
  const two = rawZip([
    { name: 'a.bin', data: new Uint8Array(60) },
    { name: 'b.bin', data: new Uint8Array(60) },
  ]);
  await expect(openZip(blobOf(two), { maxTotalBytes: 100 })).rejects.toThrow(/total size/);
  // A tiny deflate stream that claims to be 50 MB: the classic bomb shape.
  const bomb = rawZip([{ name: 'bomb.bin', data: new Uint8Array([3, 0]), method: 8, size: 50_000_000, crc: 0 }]);
  await expect(openZip(blobOf(bomb))).rejects.toThrow(/zip bomb/);
});

test('a deflate stream that really expands past its declared size is cut off', async () => {
  const real = await zipOf([{ name: 'z.bin', data: new Uint8Array(200_000), method: 'deflate' }]);
  const zip = await openZip(blobOf(real));
  const entry = zip.find('z.bin')!;
  expect(entry.method).toBe(8);
  // Lie about the size (smaller than the truth): the reader must refuse rather than expand it all.
  await expect(zip.blob({ ...entry, size: 1000 })).rejects.toThrow(/beyond its declared size/);
});

test('corrupt data and a bad checksum are reported by file name', async () => {
  const bytes = await zipOf([{ name: 'media/a.bin', data: enc.encode('0123456789'), method: 'store' }]);
  const damaged = bytes.slice();
  damaged[30 + 'media/a.bin'.length + 3] ^= 0xff; // flip a data byte
  const zip = await openZip(blobOf(damaged));
  await expect(zip.blob(zip.find('media/a.bin')!)).rejects.toThrow(/media\/a\.bin" is corrupt/);
});

test('truncated and non-zip files are refused with a clear message', async () => {
  await expect(openZip(blobOf(enc.encode('this is not a zip file at all')))).rejects.toThrow(/not a zip/);
  const bytes = await zipOf([{ name: 'a.txt', data: enc.encode('hello world'), method: 'store' }]);
  await expect(openZip(blobOf(bytes.slice(0, bytes.length - 30)))).rejects.toThrow(ZipError);
});

test('a lying local header (name differs from the directory) is caught on read', async () => {
  const bytes = await zipOf([{ name: 'a.txt', data: enc.encode('hello'), method: 'store' }]);
  const tampered = bytes.slice();
  tampered[30] = 'b'.charCodeAt(0); // local header says b.txt
  const zip = await openZip(blobOf(tampered));
  await expect(zip.blob(zip.find('a.txt')!)).rejects.toThrow(/headers disagree/);
});

// ---------- package ----------

function sampleProject() {
  let p = createProject('Package test', 640, 360, 30);
  const media: MediaItem[] = [
    { id: 'med_video', name: 'My clip (1).webm', kind: 'video', mime: 'video/webm', bytes: 0, duration: 3, width: 320, height: 180, hasAudio: false, createdAt: 1 },
    { id: 'med_image', name: 'card.png', kind: 'image', mime: 'image/png', bytes: 0, duration: 0, width: 64, height: 64, hasAudio: false, createdAt: 2, thumb: 'data:image/jpeg;base64,AAAA' },
  ];
  const blobs = new Map<string, Blob>([
    ['med_video', new Blob([bytesOf(50_000, 3) as BlobPart], { type: 'video/webm' })],
    ['med_image', new Blob([bytesOf(2_000, 5) as BlobPart], { type: 'image/png' })],
  ]);
  for (const m of media) {
    m.bytes = blobs.get(m.id)!.size;
    p = addMedia(p, m);
  }
  p = addClip(p, 'med_video', 0, p.tracks[0].id).project;
  p = addClip(p, 'med_image', 4, p.tracks[1].id).project;
  return { project: p, blobs };
}

async function packed(project = sampleProject()) {
  const sink = new BlobSink();
  await writePackage(project.project, async (id) => project.blobs.get(id) ?? null, sink, { appVersion: 'test' });
  return sink.blob();
}

test('package round trip: project and every media Blob come back identical', async () => {
  const src = sampleProject();
  const pkg = await packed(src);
  const opened = await readPackage(pkg);
  expect(opened.manifest.format).toBe('capstanz');
  expect(opened.manifest.formatVersion).toBe(1);
  expect(opened.manifest.appVersion).toBe('test');
  expect(opened.project.id).toBe(src.project.id);
  expect(opened.project.name).toBe('Package test');
  expect(opened.project.clips.length).toBe(2);
  expect(opened.project.media.map((m) => m.id)).toEqual(['med_video', 'med_image']);
  expect(opened.project.media[1].thumb).toBe('data:image/jpeg;base64,AAAA');
  for (const [id, blob] of src.blobs) {
    const back = opened.blobs.get(id)!;
    expect(back.size).toBe(blob.size);
    expect(back.type).toBe(blob.type);
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array(await blob.arrayBuffer()));
  }
});

test('package entry names: manifest, project and media/<id>-<safe name>', async () => {
  const zip = await openZip(await packed());
  expect(zip.entries.map((e) => e.name)).toEqual(['manifest.json', 'project.json', 'media/med_video-My clip _1_.webm', 'media/med_image-card.png']);
  expect(mediaEntryName('a/b', '../../x.txt')).toBe('media/a_b-_.._x.txt');
  expect(unsafeEntryName(mediaEntryName('a/b', '../../x.txt'))).toBeNull();
  expect(unsafeEntryName(mediaEntryName('..', '..'))).toBeNull();
});

test('saving a package with media missing from storage fails and names the file', async () => {
  const src = sampleProject();
  src.blobs.delete('med_image');
  const sink = new BlobSink();
  await expect(writePackage(src.project, async (id) => src.blobs.get(id) ?? null, sink)).rejects.toThrow(/card\.png/);
});

test('opening: a zip that is not a Capstan package, or lacks project.json, is explained', async () => {
  const plain = new Blob([(await zipOf([{ name: 'readme.txt', data: enc.encode('hi') }])) as BlobPart]);
  await expect(readPackage(plain)).rejects.toThrow(/not a Capstan package/);
  const noProject = new Blob([(await zipOf([{ name: 'manifest.json', data: enc.encode('{"format":"capstanz","formatVersion":1,"media":[]}') }])) as BlobPart]);
  await expect(readPackage(noProject)).rejects.toThrow(/no project\.json/);
  const wrongFormat = new Blob([(await zipOf([{ name: 'manifest.json', data: enc.encode('{"format":"other"}') }, { name: 'project.json', data: enc.encode('{}') }])) as BlobPart]);
  await expect(readPackage(wrongFormat)).rejects.toThrow(/not a Capstan package/);
  const newer = new Blob([(await zipOf([{ name: 'manifest.json', data: enc.encode('{"format":"capstanz","formatVersion":99,"media":[]}') }, { name: 'project.json', data: enc.encode('{}') }])) as BlobPart]);
  await expect(readPackage(newer)).rejects.toThrow(/newer Capstan/);
  await expect(readPackage(new Blob([enc.encode('garbage garbage garbage garbage')]))).rejects.toThrow(PackageError);
});

test('opening: project.json that fails validation is reported, and nothing opens', async () => {
  const manifest = enc.encode('{"format":"capstanz","formatVersion":1,"media":[]}');
  const bad = new Blob([(await zipOf([{ name: 'manifest.json', data: manifest }, { name: 'project.json', data: enc.encode('{"version":2}') }])) as BlobPart]);
  await expect(readPackage(bad)).rejects.toThrow(/project\.json is not a usable Capstan project/);
  const notJson = new Blob([(await zipOf([{ name: 'manifest.json', data: manifest }, { name: 'project.json', data: enc.encode('{oops') }])) as BlobPart]);
  await expect(readPackage(notJson)).rejects.toThrow(/project\.json is not a usable/);
});

test('opening: media missing from the package, and media that fails its checksum, name the file', async () => {
  const src = sampleProject();
  // Missing: rebuild the package without the image entry.
  const full = await openZip(await packed(src));
  const keep = full.entries.filter((e) => !e.name.includes('card.png'));
  const sources = await Promise.all(keep.map(async (e) => ({ name: e.name, data: await full.bytes(e), method: 'store' as const })));
  const missing = new Blob([(await zipOf(sources)) as BlobPart]);
  await expect(readPackage(missing)).rejects.toThrow(/card\.png is missing from the package.*Nothing was opened/);

  // Corrupt: flip one byte inside the video's data.
  const pkgBytes = new Uint8Array(await (await packed(src)).arrayBuffer());
  const entry = (await openZip(blobOf(pkgBytes))).find('media/med_video-My clip _1_.webm')!;
  pkgBytes[entry.offset + 30 + entry.name.length + 100] ^= 0x55;
  await expect(readPackage(blobOf(pkgBytes))).rejects.toThrow(/My clip _1_\.webm" is corrupt/);
});

test('opening: an unsafe file name anywhere in the package stops the whole open', async () => {
  const pkg = rawZip([
    { name: 'manifest.json', data: enc.encode('{"format":"capstanz","formatVersion":1,"media":[]}') },
    { name: 'project.json', data: enc.encode('{}') },
    { name: '../../Startup/run.bat', data: enc.encode('calc') },
  ]);
  await expect(readPackage(blobOf(pkg))).rejects.toThrow(/unsafe file name/);
});

// ---------- projects ----------

test('summaries report media size, counts and length', () => {
  const { project } = sampleProject();
  const s = summariseProject(project);
  expect(s.mediaCount).toBe(2);
  expect(s.clipCount).toBe(2);
  expect(s.mediaBytes).toBe(52_000);
  expect(s.duration).toBeGreaterThan(4);
  expect(isEmptyProject(project)).toBe(false);
  expect(isEmptyProject(createProject())).toBe(true);
});

test('cloneProject gives new ids and re-points clips, leaving the original alone', () => {
  const { project } = sampleProject();
  const { project: copy, idMap } = cloneProject(project, 'Copy of it');
  expect(copy.id).not.toBe(project.id);
  expect(copy.name).toBe('Copy of it');
  expect(copy.media.every((m) => !project.media.some((o) => o.id === m.id))).toBe(true);
  expect(copy.clips.every((c) => copy.media.some((m) => m.id === c.mediaId))).toBe(true);
  expect(idMap.size).toBe(2);
  expect(project.media[0].id).toBe('med_video');
  expect(copyName('A', ['A (copy)'])).toBe('A (copy 2)');
  expect(copyName('A (copy)', [])).toBe('A (copy)');
});

// ---------- templates and themes ----------

test('a template keeps settings and layout but no media, clips or captions', () => {
  const { project } = sampleProject();
  const edited = { ...project, background: '#123456', tracks: project.tracks.map((t, i) => (i === 0 ? { ...t, name: 'Screen', muted: true } : t)), captions: [{ id: 'c', start: 0, end: 1, text: 'hi' }] };
  const tpl = createTemplate(edited, '  My layout  ', 'for demos');
  expect(tpl.name).toBe('My layout');
  expect(JSON.stringify(tpl)).not.toContain('med_video');
  const made = instantiateTemplate(tpl);
  expect(made.media).toEqual([]);
  expect(made.clips).toEqual([]);
  expect(made.captions).toEqual([]);
  expect(made.width).toBe(640);
  expect(made.height).toBe(360);
  expect(made.background).toBe('#123456');
  expect(made.tracks.map((t) => t.name)).toEqual(['Screen', 'Track 2', 'Track 3']);
  expect(made.tracks[0].muted).toBe(true);
  expect(made.id).not.toBe(edited.id);
  // Fresh track ids each time, so two projects never share them.
  expect(instantiateTemplate(tpl).tracks[0].id).not.toBe(made.tracks[0].id);
});

test('built-in templates all instantiate into valid projects with the advertised sizes', () => {
  const sizes = Object.fromEntries(BUILTIN_TEMPLATES.map((t) => [t.id, instantiateTemplate(t)]));
  expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  expect(sizes['builtin-tutorial-16x9'].width).toBe(1920);
  expect(sizes['builtin-tutorial-16x9'].tracks.map((t) => t.name)).toContain('Intro');
  expect(sizes['builtin-tutorial-16x9'].tracks.map((t) => t.name)).toContain('Outro');
  expect([sizes['builtin-vertical-9x16'].width, sizes['builtin-vertical-9x16'].height]).toEqual([1080, 1920]);
  expect([sizes['builtin-square-1x1'].width, sizes['builtin-square-1x1'].height]).toEqual([1080, 1080]);
  for (const t of BUILTIN_TEMPLATES) {
    expect(t.builtin).toBe(true);
    if (t.themeId) expect(getTheme(t.themeId)?.colors.background).toBe(t.body.background);
  }
});

test('parseTemplate accepts what createTemplate makes and rejects junk', () => {
  const tpl = createTemplate(createProject('x'), 'T');
  const back = parseTemplate(JSON.parse(JSON.stringify(tpl)));
  expect(back?.name).toBe('T');
  expect(parseTemplate(null)).toBeNull();
  expect(parseTemplate({ id: 'x' })).toBeNull();
  expect(parseTemplate({ id: 'x', body: { tracks: 5 } })).toBeNull();
});

test('themes: colours and font stacks resolve, and applying sets the canvas background', () => {
  expect(THEMES.length).toBeGreaterThanOrEqual(3);
  for (const t of THEMES) {
    for (const c of Object.values(t.colors)) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    for (const role of ['heading', 'body', 'mono'] as const) expect(themeFontStack(t, role).length).toBeGreaterThan(5);
  }
  const p = createProject();
  const themed = applyThemeToProject(p, getTheme('chart-room')!);
  expect(themed.background).toBe('#f4efe4');
  expect(applyThemeToProject(themed, getTheme('chart-room')!)).toBe(themed);
});

// ---------- SnapShackle folder scan ----------

function fakeFile(name: string, modified: number): FileHandleLike {
  return { kind: 'file', name, getFile: async () => new File([name], name, { lastModified: modified }) };
}
function fakeDir(name: string, children: Array<DirHandleLike | FileHandleLike>): DirHandleLike {
  return {
    kind: 'directory',
    name,
    values: async function* () {
      for (const c of children) yield c;
    },
  };
}

test('SnapShackle scan keeps images and videos, walks subfolders, skips others, returns oldest first', async () => {
  const root = fakeDir('Captures', [
    fakeFile('b.png', 200),
    fakeFile('notes.txt', 1),
    fakeFile('a.JPG', 100),
    fakeDir('2026-10', [fakeFile('c.webm', 300), fakeDir('deep', [fakeDir('deeper', [fakeDir('toodeep', [fakeFile('lost.png', 1)])])])]),
    fakeDir('.hidden', [fakeFile('h.png', 1)]),
  ]);
  const scan = await collectCaptureFiles(root);
  expect(scan.files.map((f) => f.name)).toEqual(['a.JPG', 'b.png', 'c.webm']);
  expect(scan.skipped).toBe(0);
  const capped = await collectCaptureFiles(root, 2);
  expect(capped.files.map((f) => f.name)).toEqual(['b.png', 'c.webm']);
  expect(capped.skipped).toBe(1);
});
