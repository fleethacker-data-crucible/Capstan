// Cursor effects through the real UI: import clip.webm, attach a SYNTHETIC cursor sidecar (test data
// only, see tests/helpers/cursor-synth.mjs), turn the effects on and check the picture on the preview
// canvas at known times, then smart focus + undo, click sounds, persistence, and the export mix.
// Usage: node tests/e2e/cursor-effects.e2e.mjs   (or via run-all.mjs; expects dist/ built)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shortCursor } from '../helpers/cursor-synth.mjs';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// The synthetic sidecar files.
const sidecar = `${out}/clip.cursor.json`;
writeFileSync(sidecar, JSON.stringify({ format: 'capstan-cursor', version: 1, ...shortCursor() }));
const badSidecar = `${out}/bad.cursor.json`;
writeFileSync(badSidecar, JSON.stringify({ version: 3, samples: [[0, 0, 0]] }));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Count the click sounds the preview starts (they are AudioBuffer sources; the video's own audio is not).
await context.addInitScript(() => {
  window.__clickStarts = 0;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.__clickStarts++;
    return start.apply(this, args);
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
await page.locator('.bin-item').dblclick();
await page.waitForSelector('.clip');

// ---- helpers ----------------------------------------------------------------------------------
const seek = async (t) => {
  await page.locator('.ruler').click({ position: { x: Math.round(t * 60), y: 10 } });
  await page.waitForTimeout(350);
};
const snap = () =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return [c.width, c.height];
  });
/** Pixels in the rectangle that differ from the last snapshot by more than `th` in any channel, and the mean brightness before and after. */
const diff = (x0, y0, x1, y1, th = 24) =>
  page.evaluate(
    ([x0, y0, x1, y1, th]) => {
      const c = document.querySelector('.preview-canvas');
      const now = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const was = window.__snap;
      let changed = 0;
      let before = 0;
      let after = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * c.width + x) * 4;
          const d = Math.max(Math.abs(now.data[i] - was.data[i]), Math.abs(now.data[i + 1] - was.data[i + 1]), Math.abs(now.data[i + 2] - was.data[i + 2]));
          if (d > th) changed++;
          before += was.data[i] + was.data[i + 1] + was.data[i + 2];
          after += now.data[i] + now.data[i + 1] + now.data[i + 2];
          n++;
        }
      }
      return { changed, before: before / n / 3, after: after / n / 3 };
    },
    [x0, y0, x1, y1, th],
  );
const settle = () => page.waitForTimeout(300);
const panel = page.locator('.cursor-panel');

// ---- attach cursor data -----------------------------------------------------------------------
await page.getByRole('tab', { name: 'Cursor' }).click();
await panel.waitFor();
check('the Cursor tab shows a recording with no data yet', (await page.getByTestId('cursor-summary').textContent()).startsWith('No cursor data (clip.cursor.json)'));
check('the panel says plainly that cursor capture is not built in', (await panel.textContent()).includes('cannot read your mouse or keyboard while it records another app'));

await page.setInputFiles('input[aria-label="Attach cursor data to clip.webm"]', badSidecar);
await page.waitForSelector('.cfx-error');
check('a bad file is refused with a reason', /version/i.test(await page.locator('.cfx-error').textContent()), await page.locator('.cfx-error').textContent());
check('a refused file attaches nothing', (await page.getByTestId('cursor-summary').textContent()).startsWith('No cursor data'));

await page.setInputFiles('input[aria-label="Attach cursor data to clip.webm"]', sidecar);
await page.waitForFunction(() => document.querySelector('[data-testid=cursor-summary]')?.textContent?.includes('91 positions'));
check('attaching a sidecar loads its positions, clicks and keys', (await page.getByTestId('cursor-summary').textContent()) === '91 positions, 3 clicks, 4 keys', await page.getByTestId('cursor-summary').textContent());
check('attaching clears the error', (await page.locator('.cfx-error').count()) === 0);

// One undo step removes it; redo brings it back.
await page.locator('.transport .timecode').click();
await page.keyboard.press('Control+z');
check('undo detaches the cursor data', (await page.getByTestId('cursor-summary').textContent()).startsWith('No cursor data'));
await page.keyboard.press('Control+y');
check('redo attaches it again', (await page.getByTestId('cursor-summary').textContent()).includes('91 positions'));

// The Media bin offers the same action and marks the item.
await page.getByRole('tab', { name: 'Media' }).click();
check('the media bin marks an item with cursor data', (await page.locator('.bin-sub').textContent()).includes('cursor data'), await page.locator('.bin-sub').textContent());
check('the media bin has an attach action for video', (await page.locator('button[aria-label="Attach cursor data to clip.webm"]').count()) === 1);
await page.getByRole('tab', { name: 'Cursor' }).click();

// ---- effects on the picture -------------------------------------------------------------------
// The cursor rests at (0.25, 0.30) of the 1920x1080 frame = (480, 324) until 1 s.
const CX = 480;
const CY = 324;
await seek(0.3);
await snap();
check('with no effect on, the picture is untouched (same frame twice)', (await diff(0, 0, 1920, 1080)).changed === 0);

// Highlight halo.
await page.getByLabel('Highlight halo').check();
await settle();
let d = await diff(CX - 80, CY - 80, CX + 80, CY + 80);
check('highlight halo tints the area around the cursor', d.changed > 3000, `${d.changed} px changed`);
d = await diff(1400, 800, 1800, 1000);
check('the halo leaves the rest of the picture alone', d.changed === 0, `${d.changed} px changed`);
await page.getByLabel('Highlight halo').uncheck();
await settle();
check('turning the halo off restores the picture', (await diff(0, 0, 1920, 1080)).changed === 0);

// Spotlight.
await page.getByLabel('Spotlight', { exact: true }).check();
await settle();
d = await diff(1400, 800, 1800, 1000);
check('spotlight dims everything outside the circle', d.changed > 20000 && d.after < d.before * 0.55, `${d.changed} px, brightness ${d.before.toFixed(0)} -> ${d.after.toFixed(0)}`);
d = await diff(CX - 20, CY - 20, CX + 20, CY + 20);
check('spotlight leaves the circle bright', d.changed === 0, `${d.changed} px changed`);
await page.screenshot({ path: `${out}/cursor-spotlight.png` });
await page.getByLabel('Spotlight', { exact: true }).uncheck();

// Magnify loupe.
await page.getByLabel('Magnify under the cursor').check();
await settle();
d = await diff(CX - 160, CY - 160, CX + 160, CY + 160, 8);
check('magnify draws a loupe at the cursor', d.changed > 400, `${d.changed} px changed`);
d = await diff(1400, 800, 1800, 1000);
check('the loupe stays near the cursor', d.changed === 0);
await page.getByLabel('Magnify under the cursor').uncheck();

// The drawn cursor: shapes, hide, replace image.
await settle();
await snap();
await page.getByLabel('Draw the cursor').check();
await settle();
d = await diff(CX - 4, CY - 4, CX + 70, CY + 70);
check('the drawn cursor appears with its tip on the cursor position', d.changed > 400, `${d.changed} px changed`);
d = await diff(CX - 60, CY - 60, CX - 6, CY - 6);
check('nothing is drawn up and to the left of the tip', d.changed === 0, `${d.changed} px changed`);
await page.screenshot({ path: `${out}/cursor-arrow.png` });
await snap();
await page.locator('#cursor-shape').selectOption('hand');
await settle();
d = await diff(CX - 40, CY - 4, CX + 80, CY + 80);
check('another shape changes the picture', d.changed > 100, `${d.changed} px changed`);
await page.locator('#cursor-shape').selectOption('pointer');
await settle();
await snap();
await page.setInputFiles('input[aria-label="Replace cursor image"]', 'tests/fixtures/card.png');
await page.waitForSelector('button:has-text("Use built-in shapes")');
await settle();
d = await diff(CX - 40, CY - 4, CX + 120, CY + 120);
check('a replacement cursor image is drawn', d.changed > 400, `${d.changed} px changed`);
await page.screenshot({ path: `${out}/cursor-image.png` });
await page.getByRole('button', { name: 'Use built-in shapes' }).click();
await settle();
await page.locator('#cursor-shape').selectOption('arrow');
await page.setInputFiles('input[aria-label="Replace cursor image"]', 'tests/fixtures/clip.webm');
await page.waitForSelector('.cfx-error');
check('a video is refused as a cursor image', /PNG, SVG/.test(await page.locator('.cfx-error').textContent()));
await page.getByLabel('Draw the cursor').uncheck();
await settle();
await seek(0.3);
await snap();
await page.getByLabel('Draw the cursor').check();
await settle();
check('(the cursor is drawn again)', (await diff(CX - 4, CY - 4, CX + 70, CY + 70)).changed > 400);
await page.getByLabel('Draw the cursor').uncheck();
await settle();
check('hiding the cursor removes it', (await diff(0, 0, 1920, 1080)).changed === 0);

// Click rings: a left press at 0.5 s, ring lasts 0.6 s.
await seek(0.6);
await snap();
await page.getByLabel('Click rings').check();
await settle();
d = await diff(CX - 70, CY - 70, CX + 70, CY + 70, 10);
check('a click ring is drawn 0.1 s after the click', d.changed > 150, `${d.changed} px changed`);
await page.screenshot({ path: `${out}/cursor-ring.png` });
await page.getByLabel('Click rings').uncheck();
await seek(1.4);
await snap();
await page.getByLabel('Click rings').check();
await settle();
d = await diff(CX - 200, CY - 200, CX + 200, CY + 200, 10);
check('the ring is gone 0.9 s after the click', d.changed === 0, `${d.changed} px changed`);
await page.getByLabel('Click rings').uncheck();

// Keystroke bubble: Ctrl+C at 2.45 s.
await seek(2.6);
await snap();
await page.getByLabel('Keystroke callouts').check();
await settle();
d = await diff(760, 930, 1160, 1010, 24);
check('a key bubble appears at the bottom after Ctrl+C', d.changed > 1500, `${d.changed} px changed`);
await page.screenshot({ path: `${out}/cursor-keys.png` });
const afterCtrl = d.changed;
await page.getByLabel('Keystroke callouts').uncheck();
await seek(2.95);
await snap();
await page.getByLabel('Keystroke callouts').check();
await settle();
d = await diff(600, 850, 1320, 1010, 24);
await page.getByLabel('Keystroke callouts').uncheck();
await seek(0.3);
await snap();
await page.getByLabel('Keystroke callouts').check();
await settle();
check('no bubble before any key is pressed', (await diff(0, 0, 1920, 1080)).changed === 0);
check('a second bubble stacks above the first once "hi" is typed', d.changed > afterCtrl * 0.5, `${d.changed} px changed vs ${afterCtrl}`);
await page.getByLabel('Keystroke callouts').uncheck();

// Master switch.
await page.getByLabel('Highlight halo').check();
await seek(0.3);
await snap();
await page.getByLabel('Cursor effects on').uncheck();
await settle();
d = await diff(CX - 80, CY - 80, CX + 80, CY + 80);
check('the master switch turns every effect off at once', d.changed > 3000, `${d.changed} px changed`);
await page.getByLabel('Cursor effects on').check();
await page.getByLabel('Highlight halo').uncheck();

// ---- click sounds in the preview --------------------------------------------------------------
await page.getByLabel('Click sounds').check();
await seek(0.6);
const before = await page.evaluate(() => window.__clickStarts);
await seek(0.2);
check('scrubbing across a click is silent', (await page.evaluate(() => window.__clickStarts)) === before);
await page.locator('.transport .timecode').click();
await page.keyboard.press('Space');
await page.waitForTimeout(900);
await page.keyboard.press('Space');
const played = (await page.evaluate(() => window.__clickStarts)) - before;
check('playing across a click plays the click sound', played >= 1 && played <= 2, `${played} sounds`);
await page.getByLabel('Click sounds').uncheck();

// ---- smart focus ------------------------------------------------------------------------------
check('no zoom regions to start with', (await page.getByTestId('zoom-count').textContent()).startsWith('0 zoom regions'));
await page.getByRole('button', { name: 'Suggest zooms' }).click();
await page.waitForSelector('.cfx-suggestions li');
const suggestions = await page.locator('.cfx-suggestions li').count();
check('smart focus suggests zoom regions from the clicks', suggestions >= 1, `${suggestions} suggestions`);
check('suggesting adds nothing yet', (await page.getByTestId('zoom-count').textContent()).startsWith('0 zoom regions'));
await page.screenshot({ path: `${out}/cursor-panel.png` });
await page.getByRole('button', { name: /^Add \d+ zoom/ }).click();
check('accepting adds the suggestions to the project', (await page.getByTestId('zoom-count').textContent()).startsWith(`${suggestions} zoom region`), await page.getByTestId('zoom-count').textContent());
await page.locator('.transport .timecode').click();
await page.keyboard.press('Control+z');
check('undo takes them out again in one step', (await page.getByTestId('zoom-count').textContent()).startsWith('0 zoom regions'));

// ---- the project panel summary + persistence --------------------------------------------------
await page.getByLabel('Highlight halo').check();
await page.locator('#f-cursor-size').fill('200');
await page.locator('#f-cursor-size').press('Enter');
await page.waitForTimeout(800);
await page.reload();
await page.waitForSelector('.clip', { timeout: 15000 });
await page.getByRole('tab', { name: 'Cursor' }).click();
check('cursor data survives a reload', (await page.getByTestId('cursor-summary').textContent()).includes('91 positions'));
check('effect settings survive a reload', await page.getByLabel('Highlight halo').isChecked());
check('the size setting survives a reload', (await page.locator('#f-cursor-size').inputValue()) === '200');
const summary = page.getByTestId('cursor-section-summary');
check('the project panel summarises the cursor effects', (await summary.count()) === 1 && (await summary.textContent()).includes('halo'), (await summary.count()) ? await summary.textContent() : 'missing');

// Remove the data.
await page.getByRole('button', { name: 'Remove data' }).click();
check('remove data detaches it', (await page.getByTestId('cursor-summary').textContent()).startsWith('No cursor data'));

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
await browser.close();

// ---- export mix: the click sound is mixed into the audio --------------------------------------
{
  const built = spawnSync('bun', ['build', 'tests/e2e/cursor-harness.ts', '--outdir', 'tests/e2e/.build', '--target', 'browser'], { encoding: 'utf8', shell: process.platform === 'win32' });
  check('export harness builds', built.status === 0, built.stderr?.slice(0, 200));
  const js = readFileSync('tests/e2e/.build/cursor-harness.js');
  const b2 = await chromium.launch();
  const p2 = await b2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(e.message));
  await p2.route('**/harness.js', (route) => route.fulfill({ body: js, contentType: 'application/javascript; charset=utf-8' }));
  await p2.goto(`${base}/harness`);
  await p2.waitForFunction(() => document.title === 'harness-ready', null, { timeout: 15000 });

  const decode = (file) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const f = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    const peak = (from, to) => {
      let m = 0;
      for (let i = Math.floor(from * 48000); i < Math.min(f.length, Math.floor(to * 48000)); i++) m = Math.max(m, Math.abs(f[i]));
      return m;
    };
    return { peak, seconds: f.length / 48000 };
  };

  const on = await p2.evaluate(() => window.runClickExport({ clickSound: true }));
  writeFileSync(`${out}/cursor-clicks.mp4`, Buffer.from(on.base64, 'base64'));
  const a = decode(`${out}/cursor-clicks.mp4`);
  check('export with click sounds has an audio track', a.seconds > 2.5, `${a.seconds.toFixed(2)} s of audio`);
  check('the click is mixed in at 0.5 s', a.peak(0.5, 0.56) > 0.1, `peak ${a.peak(0.5, 0.56).toFixed(3)}`);
  check('the click is mixed in at 2.0 s and 2.2 s', a.peak(2.0, 2.06) > 0.1 && a.peak(2.2, 2.26) > 0.1, `${a.peak(2.0, 2.06).toFixed(3)}, ${a.peak(2.2, 2.26).toFixed(3)}`);
  check('between clicks the mix is silent', a.peak(1.0, 1.9) < 0.01 && a.peak(0.7, 1.9) < 0.01, `peak ${a.peak(1.0, 1.9).toFixed(4)}`);

  const off = await p2.evaluate(() => window.runClickExport({ clickSound: false }));
  writeFileSync(`${out}/cursor-noclicks.mp4`, Buffer.from(off.base64, 'base64'));
  const hasAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', `${out}/cursor-noclicks.mp4`]).toString().trim();
  check('without click sounds the same timeline exports with no audio', hasAudio === '', hasAudio);
  const frames = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', `${out}/cursor-clicks.mp4`]).toString().trim();
  check('the export is the clip length (3 s at 30 fps)', Math.abs(Number(frames) - 90) <= 1, frames);
  check('no export page errors', errs2.length === 0, errs2.join(' | ').slice(0, 300));
  await b2.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll cursor-effects checks passed');
process.exit(failures ? 1 : 0);
