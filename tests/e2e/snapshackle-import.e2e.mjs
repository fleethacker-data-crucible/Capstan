// Import SnapShackle captures through the host (issue #26), driven through the real UI in headless Chromium.
// The captures are synthetic PNGs with .meta.json sidecars in a temp folder; the folder reaches the test
// server through CAPSTAN_TEST_CAPTURES (the same seam the PowerShell host has), so this file starts its
// own test server and ignores CAPSTAN_URL. Nothing real is read and no desktop is captured.
// Usage: node tests/e2e/run-all.mjs snapshackle-import
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

mkdirSync('tests/e2e/.out', { recursive: true });
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ---- synthetic captures ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
const png = (w, h, [r, g, b]) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([r, g, (b + x * 2) & 255], y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

const dir = mkdtempSync(join(tmpdir(), 'capstan-snap-'));
const now = Date.now();
const put = (name, bytes, minutesAgo, ocr) => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  const t = new Date(now - minutesAgo * 60_000);
  utimesSync(p, t, t);
  if (ocr !== undefined) writeFileSync(`${p}.meta.json`, JSON.stringify({ tags: [], note: '', ocr }));
};
const INVOICE = 'Quarterly invoice 4711\nsecond line of text';
put('SnapShackle-20261031-100000.png', png(96, 60, [200, 40, 40]), 1, INVOICE);
put('SnapShackle-20261031-095000.png', png(96, 60, [40, 160, 60]), 10, 'Meeting notes: launch plan');
put('SnapShackle-20261030-170000.png', png(96, 60, [40, 60, 200]), 60);
copyFileSync('tests/fixtures/clip.webm', join(dir, 'SnapShackle-20261030-120000.webm'));
{
  const t = new Date(now - 120 * 60_000);
  utimesSync(join(dir, 'SnapShackle-20261030-120000.webm'), t, t);
}
put('SnapShackle-20261029-080000.png', png(96, 60, [200, 200, 40]), 200, 'Invoice 99 is overdue');
writeFileSync(join(dir, 'notes.txt'), 'not a capture');
writeFileSync(join(dir, 'evil.exe'), 'MZ');
const names = ['SnapShackle-20261031-100000.png', 'SnapShackle-20261031-095000.png', 'SnapShackle-20261030-170000.png', 'SnapShackle-20261030-120000.webm', 'SnapShackle-20261029-080000.png'];

// ---- own test server with the test folder ----
const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tests/serve.mjs', String(port)], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CAPSTAN_TEST_CAPTURES: dir } });
const cleanup = () => {
  server.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp folder: leave it */
  }
};
process.on('exit', cleanup);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on('dialog', (d) => void d.accept());

const status = async () => ((await page.locator('.statusbar .message').textContent()) ?? '').trim();
const waitStatus = (re, timeout = 20000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.statusbar .message')?.textContent ?? ''), re.source, { timeout });
const binCount = () => page.locator('.bin-item').count();
const openMenu = async () => {
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  return page.getByRole('menuitem', { name: /SnapShackle/ });
};
const dialog = () => page.getByRole('dialog', { name: 'Import SnapShackle captures' });
const rows = () => dialog().locator('[data-capture]');
const rowNames = () => rows().evaluateAll((els) => els.map((e) => e.getAttribute('data-capture')));
const idbProject = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('capstan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction('projects').objectStore('projects').getAll();
          q.onsuccess = () => resolve(q.result);
        };
      }),
  );

try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Project', exact: true }).waitFor();

  // ---- the host reports the folder ----
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  check('health reports snapshackle: true when the folder exists', health.snapshackle === true, JSON.stringify(health));

  const item = await openMenu();
  await page.waitForFunction(() => /newest captures/.test(document.querySelector('[data-menu-id=snapshackle]')?.textContent ?? ''));
  check('the menu item says it lists captures', /newest captures/.test((await item.textContent()) ?? ''));
  check('the menu item is enabled', await item.isEnabled());
  await item.click();
  await dialog().waitFor();
  await rows().first().waitFor();

  // ---- the list ----
  check('the list shows the five captures and skips the text file and the exe', (await rowNames()).length === 5, (await rowNames()).join(', '));
  check('the list is newest first', JSON.stringify(await rowNames()) === JSON.stringify(names), (await rowNames()).join(', '));
  const firstRow = rows().first();
  check('a row shows the first line of the OCR text', ((await firstRow.textContent()) ?? '').includes('Quarterly invoice 4711') && !((await firstRow.textContent()) ?? '').includes('second line'));
  check('a row shows the date and size', /\d{4}/.test((await firstRow.textContent()) ?? '') && /(B|KB)/.test((await firstRow.textContent()) ?? ''));
  await page.waitForFunction(() => document.querySelectorAll('.snap-item img').length >= 3, null, { timeout: 15000 });
  const thumbs = await page.evaluate(() => [...document.querySelectorAll('.snap-item img')].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 5) })));
  check('thumbnails are drawn from the images (blob URLs, real pictures)', thumbs.length >= 3 && thumbs.every((t) => t.w > 0 && t.h > 0 && t.src === 'blob:'), JSON.stringify(thumbs));
  check('the video row has an icon, not a thumbnail', (await dialog().locator('[data-capture$=".webm"] img').count()) === 0);
  check('the dialog says nothing is changed and offers no write', /only reads/i.test((await dialog().textContent()) ?? ''));
  await page.screenshot({ path: 'tests/e2e/.out/snapshackle-list.png' });

  // ---- search over names and OCR text ----
  const search = page.getByLabel('Search captures by name or text');
  await search.fill('invoice');
  check('searching text inside the pictures finds both invoices', JSON.stringify(await rowNames()) === JSON.stringify([names[0], names[4]]), (await rowNames()).join(', '));
  await search.fill('INVOICE 4711');
  check('every word must match, case-insensitively', JSON.stringify(await rowNames()) === JSON.stringify([names[0]]));
  await search.fill('20261030');
  check('searching names finds them', (await rowNames()).length === 2);
  await search.fill('zzz-nothing');
  check('no match says so', /No capture matches/.test((await dialog().textContent()) ?? ''));
  await search.fill('');

  // ---- multi-select and import ----
  check('Import is disabled until something is ticked', await dialog().getByRole('button', { name: 'Import', exact: true }).isDisabled());
  await rows().nth(0).locator('input[type=checkbox]').check();
  await rows().nth(3).locator('input[type=checkbox]').check();
  await rows().nth(4).locator('input[type=checkbox]').check();
  check('the button counts the ticked captures', await dialog().getByRole('button', { name: 'Import 3 captures' }).isVisible());
  const before = await binCount();
  await dialog().getByRole('button', { name: 'Import 3 captures' }).click();
  await dialog().waitFor({ state: 'detached', timeout: 30000 });
  await waitStatus(/Imported 3 SnapShackle captures with their OCR text/);
  check('the chosen captures are in the media bin', (await binCount()) === before + 3, `bin has ${await binCount()}`);
  const titles = await page.locator('.bin-item').evaluateAll((els) => els.map((e) => ({ name: e.querySelector('.bin-name')?.textContent, title: e.getAttribute('title') })));
  const inv = titles.find((t) => t.name === names[0]);
  const old = titles.find((t) => t.name === names[4]);
  const vid = titles.find((t) => t.name === names[3]);
  check('the media tooltip carries the OCR text', !!inv && inv.title.includes('Quarterly invoice 4711') && inv.title.includes('second line of text'), inv?.title);
  check('the second capture has its own OCR text', !!old && old.title.includes('Invoice 99 is overdue'));
  check('a capture without OCR text has the plain tooltip', !!vid && !vid.title.includes('Text in the picture'));
  check('the bin does not show the captures that were not ticked', !titles.some((t) => t.name === names[1] || t.name === names[2]));
  await page.waitForTimeout(800);
  const stored = (await idbProject()).flatMap((p) => p.media);
  check('the description is saved in the project', stored.filter((m) => m.description).length === 2 && stored.find((m) => m.name === names[0])?.description === INVOICE, JSON.stringify(stored.map((m) => [m.name, !!m.description])));

  await page.reload();
  await page.locator('.bin-item').first().waitFor();
  const afterReload = await page.locator('.bin-item').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  check('the OCR text is still the tooltip after a reload', afterReload.some((t) => t.includes('Quarterly invoice 4711')));

  // ---- a file that cannot be read ----
  await (await openMenu()).click();
  await dialog().waitFor();
  await rows().first().waitFor();
  await rows().nth(1).locator('input[type=checkbox]').check(); // 095000
  await rows().nth(2).locator('input[type=checkbox]').check(); // 170000
  unlinkSync(join(dir, names[1]));
  await dialog().getByRole('button', { name: 'Import 2 captures' }).click();
  await page.waitForFunction(() => /Could not read/.test(document.querySelector('[role=dialog] [role=alert]')?.textContent ?? ''), null, { timeout: 20000 });
  const alert = (await dialog().getByRole('alert').textContent()) ?? '';
  check('a capture that was removed is named with a reason', alert.includes(names[1]) && /no longer in the folder/.test(alert), alert);
  check('the others were still imported', alert.includes('Imported 1 of 2'), alert);
  check('the status bar tells the same', /Imported 1 of 2/.test(await status()), await status());
  check('the one that failed stays ticked to try again', await dialog().getByRole('button', { name: 'Import 1 capture', exact: true }).isVisible());
  await dialog().getByRole('button', { name: 'Cancel' }).click();

  // ---- nothing in the folder ----
  for (const n of names) {
    for (const f of [n, `${n}.meta.json`]) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* already gone */
      }
    }
  }
  await (await openMenu()).click();
  await dialog().waitFor();
  await dialog().getByText(/nothing in the SnapShackle Captures folder/i).waitFor();
  check('an empty folder says there is nothing in it', true);
  check('an empty folder offers the folder picker', await dialog().getByRole('button', { name: /Choose another folder/ }).isVisible());
  await dialog().getByRole('button', { name: 'Cancel' }).click();

  // ---- the host's routes, from the page, with hostile names ----
  put('SnapShackle-ok.png', png(16, 16, [1, 2, 3]), 1, 'ok');
  writeFileSync(join(dir, '..', 'capstan-outside-secret.png'), 'OUTSIDE-THE-FOLDER');
  const http = await page.evaluate(async () => {
    const token = document.querySelector('meta[name=capstan-session]').content;
    const get = async (path, init = {}) => {
      const r = await fetch(path, { ...init, headers: { 'X-Capstan-Token': token, ...(init.headers ?? {}) } });
      const body = await r.text();
      return { status: r.status, type: r.headers.get('content-type'), body: body.slice(0, 200), allow: r.headers.get('allow') };
    };
    const hostile = ['..%5csecret.png', '..%5Ccapstan-outside-secret.png', '..%2fcapstan-outside-secret.png', '%2e%2e%2fcapstan-outside-secret.png', '..%255ccapstan-outside-secret.png', 'a%2fb.png', 'C%3a%5cx.png', 'con.png', 'x.png%3astream', 'x.png.', 'x.png%20', 'evil.exe', 'notes.txt', 'SnapShackle-ok.png.meta.json', 'x.svg'];
    const out = {};
    for (const h of hostile) out[h] = await get(`/api/snapshackle/captures/${h}`);
    return {
      out,
      ok: await get('/api/snapshackle/captures/SnapShackle-ok.png'),
      list: await get('/api/snapshackle/captures'),
      noToken: (await fetch('/api/snapshackle/captures')).status,
      noTokenFile: (await fetch('/api/snapshackle/captures/SnapShackle-ok.png')).status,
      post: await get('/api/snapshackle/captures', { method: 'POST', body: '{}' }),
    };
  });
  check('a capture is served with its image type', http.ok.status === 200 && http.ok.type === 'image/png');
  check('every hostile name is refused and nothing outside the folder leaks', Object.entries(http.out).every(([, r]) => r.status !== 200 && !r.body.includes('OUTSIDE-THE-FOLDER') && !r.body.includes('MZ')), JSON.stringify(Object.entries(http.out).filter(([, r]) => r.status === 200)));
  check('hostile names are 400 or 404, never a server error', Object.values(http.out).every((r) => r.status === 400 || r.status === 404), JSON.stringify(Object.entries(http.out).map(([k, r]) => [k, r.status])));
  check('the routes need the session token', http.noToken === 403 && http.noTokenFile === 403);
  check('POST is 405 with Allow: GET', http.post.status === 405 && http.post.allow === 'GET');
  unlinkSync(join(dir, '..', 'capstan-outside-secret.png'));

  // ---- no folder at all: the folder picker stays the fallback ----
  rmSync(dir, { recursive: true, force: true });
  await page.evaluate(() => {
    window.__picked = 0;
    window.showDirectoryPicker = async () => {
      window.__picked++;
      const e = new Error('cancelled');
      e.name = 'AbortError';
      throw e;
    };
  });
  const gone = await openMenu();
  await page.waitForFunction(() => /No SnapShackle folder found/.test(document.querySelector('[data-menu-id=snapshackle]')?.textContent ?? ''));
  check('without a folder the menu says so and offers the picker', /pick one by hand/.test((await gone.textContent()) ?? '') && (await gone.isEnabled()));
  const health2 = await page.evaluate(async () => (await fetch('/api/health')).json());
  check('health reports snapshackle: false without the folder', health2.snapshackle === false);
  const lst = await page.evaluate(async () => {
    const r = await fetch('/api/snapshackle/captures', { headers: { 'X-Capstan-Token': document.querySelector('meta[name=capstan-session]').content } });
    return { status: r.status, body: await r.json() };
  });
  check('the list without a folder is a 404 with a clear message', lst.status === 404 && /No SnapShackle captures folder found/.test(lst.body.error));
  await gone.click();
  await waitStatus(/Import cancelled/);
  check('clicking it falls back to the folder picker', (await page.evaluate(() => window.__picked)) === 1 && (await page.getByRole('dialog').count()) === 0);

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the test ran to the end', false, String(e?.stack ?? e));
  await page.screenshot({ path: 'tests/e2e/.out/snapshackle-failure.png' }).catch(() => undefined);
} finally {
  await browser.close();
  cleanup();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
