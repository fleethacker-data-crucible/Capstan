// Library on disk, driven through the real UI in headless Chromium against tests/serve.mjs (which mirrors
// the host's /api/files routes):
//   import media in one browser profile -> it is copied to the host's library in the background;
//   open the saved project in a NEW profile (empty IndexedDB, same host) -> the media is found there;
//   a failing host never blocks an edit and is reported in the status bar.
// Usage: node tests/e2e/run-all.mjs library-host   (or CAPSTAN_URL=... node this file)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });
const TOKEN = 'test-token';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const fixture = (name) => readFileSync(`tests/fixtures/${name}`);
const hostFetch = (path, init = {}) => fetch(base + path, { ...init, headers: { 'X-Capstan-Token': TOKEN, ...(init.headers ?? {}) } });
const hostIndex = async () => (await (await hostFetch('/api/files')).json()).files;

const browser = await chromium.launch();
const errors = [];
const apiRequests = [];
async function newProfile() {
  // A new context has its own IndexedDB, like another port or a browser profile that was cleared.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 500/.test(m.text()) && errors.push(m.text()));
  page.on('request', (r) => r.url().includes('/api/files') && apiRequests.push({ method: r.method(), url: r.url(), token: r.headers()['x-capstan-token'] }));
  return { context, page };
}
const idbMedia = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('capstan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('media')) return resolve([]);
          const s = db.transaction('media').objectStore('media');
          const keys = s.getAllKeys();
          keys.onsuccess = () => {
            const all = s.getAll();
            all.onsuccess = () => resolve(keys.result.map((k, i) => [String(k), all.result[i].size]));
          };
        };
      }),
  );
const status = async (page) => ((await page.locator('.statusbar .message').textContent()) ?? '').trim();
const previewPixel = (page, fx, fy) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.preview-canvas');
      const d = c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );

// ---------- profile A: import, and the host gets a copy ----------
const A = await newProfile();
const a = A.page;
await a.goto(base + '/');
await a.waitForSelector('.welcome');
await a.getByRole('button', { name: 'Go to the editor' }).click();
await a.waitForSelector('.media-bin');
await a.waitForSelector('.library-line');
check('the status bar says "Library on disk" when the host has a library', ((await a.locator('.library-line').textContent()) ?? '').startsWith('Library on disk'));

await a.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png']);
await a.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2, null, { timeout: 20000 });
check('an import does not wait for the host: both items are in the bin', (await a.locator('.bin-item').count()) === 2);
await a.locator('.bin-item', { hasText: 'card.png' }).dblclick();
await a.waitForSelector('.clip');

const want = new Map([
  [fixture('clip.webm').length, sha(fixture('clip.webm'))],
  [fixture('card.png').length, sha(fixture('card.png'))],
]);
let mine = [];
for (let i = 0; i < 100; i++) {
  mine = (await hostIndex()).filter((f) => want.has(f.size));
  if (mine.length >= 2) break;
  await a.waitForTimeout(100);
}
check('the host library received both files', mine.length >= 2, JSON.stringify(mine));
const ids = await idbMedia(a);
check('IndexedDB still holds both (it stays the primary store)', ids.length === 2, JSON.stringify(ids));
let allSame = ids.length === 2;
for (const [id, size] of ids) {
  const res = await hostFetch(`/api/files/${id}`);
  const body = Buffer.from(await res.arrayBuffer());
  allSame = allSame && res.status === 200 && body.length === size && sha(body) === want.get(size);
}
check('the host serves each file back byte for byte', allSame);
check('every /api/files request from the page carried the session token', apiRequests.length > 0 && apiRequests.every((r) => r.token === TOKEN), JSON.stringify(apiRequests.filter((r) => r.token !== TOKEN).slice(0, 2)));
await a.waitForFunction(() => !/saving/.test(document.querySelector('.library-line')?.textContent ?? ''), null, { timeout: 10000 });
check('the Library line settles to "Library on disk" with nothing pending', ((await a.locator('.library-line').textContent()) ?? '').trim() === 'Library on disk');
const pixelA = await previewPixel(a, 0.5, 0.5);
await a.screenshot({ path: `${out}/library-host-a.png` });

// Save the project file (the edit only; the media is not in it).
const [download] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Save project file' }).click()]);
const projectFile = `${out}/library-host.capstan`;
await download.saveAs(projectFile);
await A.context.close();

// ---------- profile B: nothing in IndexedDB; the same host ----------
const B = await newProfile();
const b = B.page;
await b.goto(base + '/');
await b.waitForSelector('.welcome');
check('the new profile starts with no media in IndexedDB', (await idbMedia(b)).length === 0);
await b.setInputFiles('input[accept=".capstan,.capstanz,application/json,application/zip"]', projectFile);
await b.waitForSelector('.bin-item', { timeout: 20000 });
await b.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2, null, { timeout: 20000 });
check('the project opens with both media in the bin', (await b.locator('.bin-item').count()) === 2);
const st = await status(b);
check('no "not in this browser" warning: the media was found on the host', !/not in this browser/.test(st), st);
const cached = await idbMedia(b);
check('what was read from the host is kept in this browser too', cached.length === 2 && cached.every(([id, size]) => ids.some(([i, s]) => i === id && s === size)), JSON.stringify(cached));
await b.waitForSelector('.clip');
await b.waitForTimeout(500);
const pixelB = await previewPixel(b, 0.5, 0.5);
check('the preview draws the recovered picture (same pixel as before)', pixelB.every((v, i) => Math.abs(v - pixelA[i]) <= 4) && pixelB.some((v) => v > 8), JSON.stringify([pixelA, pixelB]));
await b.screenshot({ path: `${out}/library-host-b.png` });

// ---------- a failing host never blocks an edit and is reported ----------
// Fail every chunk until switched off below: a slow runner may retry in the background many times, and a
// budget that runs out would let a later retry succeed and make the checks below race.
await hostFetch('/api/test/library-fail?count=100000'); // not an /api/files route: no token needed, test server only
await b.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/tone.wav']);
await b.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
check('with the host failing, the import still lands in the bin', (await b.locator('.bin-item').count()) === 3);
await b.locator('.bin-item', { hasText: 'tone.wav' }).dblclick();
await b.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
check('and the edit goes on (clip added)', (await b.locator('.clip').count()) === 2);
await b.waitForFunction(() => /library on disk/i.test(document.querySelector('.statusbar .message')?.textContent ?? '') || /last copy failed/.test(document.querySelector('.library-line')?.textContent ?? ''), null, { timeout: 20000 });
await b.waitForFunction(() => /last copy failed/.test(document.querySelector('.library-line')?.textContent ?? ''), null, { timeout: 20000 });
check('the Library line says the last copy failed', /last copy failed/.test((await b.locator('.library-line').textContent()) ?? ''));
const failTitle = (await b.locator('.library-line').getAttribute('title')) ?? '';
check('its tooltip names the file and says it is still saved in the browser', failTitle.includes('tone.wav') && failTitle.includes('still saved in this browser'), failTitle);
check('the tone is in IndexedDB', (await idbMedia(b)).some(([, size]) => size === fixture('tone.wav').length));
const afterFail = await hostIndex();
check('the failed copy left nothing half-written on the host', !afterFail.some((f) => f.size === fixture('tone.wav').length), JSON.stringify(afterFail.map((f) => [f.id, f.size])));
await hostFetch('/api/test/library-fail?count=0');
await b.screenshot({ path: `${out}/library-host-b-failed.png` });

// ---------- a profile opened later backfills what the host lacks ----------
// (the tone is only in profile B's IndexedDB; opening the project again in B makes the host catch up)
await b.reload();
await b.waitForSelector('.media-bin, .welcome');
// The Welcome view can disappear by itself once the saved project has loaded, so a missing button is fine.
await b.getByRole('button', { name: 'Go to the editor' }).click({ timeout: 2000 }).catch(() => undefined);
await b.waitForSelector('.bin-item', { timeout: 20000 });
let caught = false;
for (let i = 0; i < 100 && !caught; i++) {
  caught = (await hostIndex()).some((f) => f.size === fixture('tone.wav').length);
  if (!caught) await b.waitForTimeout(100);
}
check('after a reload the host catches up with media it was missing', caught);
await B.context.close();

const real = errors.filter((e) => !/Failed to load resource/.test(e));
check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
await browser.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll library-host checks passed');
