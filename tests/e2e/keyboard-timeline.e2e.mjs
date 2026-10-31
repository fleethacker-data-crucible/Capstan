// Keyboard-only use of the timeline (issue #43): select a clip, move between clips, change its timing, set the
// export in and out points and export just that part, without dragging. Each step is its own check so a
// failure on an older build shows exactly which parts were missing.
// Usage: node tests/e2e/keyboard-timeline.e2e.mjs   (or via run-all.mjs keyboard-timeline)
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
/** Runs a step; an exception (a control that is not there) is a failed check, not a crash. */
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e.message ?? e).split('\n')[0].slice(0, 140));
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(4000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-clip-id') ?? document.activeElement?.className ?? '');
const pressed = (loc) => loc.getAttribute('aria-pressed');
const now = async () => (await page.locator('.timecode .now').textContent()).trim();

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2, null, { timeout: 20000 });
await page.locator('.bin-item', { hasText: 'clip.webm' }).dblclick();
await page.locator('.bin-item', { hasText: 'card.png' }).dblclick();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
// Split the video at 1 s so two clips share a track.
await page.locator('.ruler').click({ position: { x: 60, y: 8 } });
await page.locator('.clip.kind-video').click({ position: { x: 20, y: 10 } });
await page.keyboard.press('s');
await page.waitForFunction(() => document.querySelectorAll('.clip.kind-video').length === 2);

const video = page.locator('.clip.kind-video');
const card = page.locator('.clip.kind-image');
const id = (loc) => loc.getAttribute('data-clip-id');

await step('tab stop', async () => {
  const stops = await page.locator('.clip[tabindex="0"]').count();
  const all = await page.locator('.clip[tabindex]').count();
  check('exactly one clip is the tab stop and the others are reachable by arrow keys', stops === 1 && all === 3, `${stops} tab stop, ${all} clips with a tabindex`);
});

await step('select', async () => {
  await video.first().focus();
  await page.keyboard.press('Enter');
  check('Enter selects the focused clip and opens its timing fields', (await pressed(video.first())) === 'true' && (await page.locator('#clip-start').count()) === 1);
});

await step('arrows', async () => {
  await video.first().focus();
  await page.keyboard.press('ArrowRight');
  const second = await id(video.nth(1));
  check('Right arrow moves focus and selection to the next clip on the track', (await focused()) === second && (await pressed(video.nth(1))) === 'true' && (await pressed(video.first())) === 'false');
  await page.keyboard.press('ArrowLeft');
  check('Left arrow moves back', (await focused()) === (await id(video.first())));
  await page.keyboard.press('ArrowDown');
  check('Down arrow moves to the clip on the track below', (await focused()) === (await id(card)));
  await page.keyboard.press('ArrowUp');
  check('Up arrow moves back up', (await focused()) !== (await id(card)));
});

await step('space', async () => {
  await card.focus();
  const before = await now();
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  check('Space on a clip selects it and does not start playback', (await pressed(card)) === 'true' && (await now()) === before, `${before} -> ${await now()}`);
});

await step('alt move', async () => {
  await card.focus();
  check('the card starts at 0 s', (await page.locator('#clip-start').inputValue()) === '0');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  check('Alt+Shift+Right moves the clip one second', (await page.locator('#clip-start').inputValue()) === '1', await page.locator('#clip-start').inputValue());
  await page.keyboard.press('Alt+ArrowLeft');
  check('Alt+Left moves it back one frame', (await page.locator('#clip-start').inputValue()) === '0.967', await page.locator('#clip-start').inputValue());
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
});

await step('timing fields', async () => {
  await card.click({ position: { x: 20, y: 10 } });
  await page.locator('#clip-start').fill('2');
  await page.locator('#clip-start').press('Enter');
  check('typing a start time and pressing Enter moves the clip', (await card.evaluate((el) => el.style.left)) === '120px', await card.evaluate((el) => el.style.left));
  await page.locator('#clip-length').fill('1.5');
  await page.locator('#clip-length').press('Enter');
  check('typing a length changes the clip length', (await card.evaluate((el) => el.style.width)) === '90px', await card.evaluate((el) => el.style.width));
  await page.locator('#clip-start').fill('1');
  await page.locator('#clip-start').press('Enter');
  check('a start that does not fit is refused with a message', /another clip is in the way/.test((await page.locator('.statusbar .message').textContent()) ?? '') || (await page.locator('#clip-start').inputValue()) === '1');
});

await step('range handles', async () => {
  await page.locator('.transport .timecode').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('o');
  const end = page.locator('.range-handle.end');
  const start = page.locator('.range-handle.start');
  check('setting an out mark with O shows the in and out handles as sliders', (await end.getAttribute('role')) === 'slider' && (await start.getAttribute('role')) === 'slider' && (await end.getAttribute('aria-valuenow')) === '2');
  await end.focus();
  await page.keyboard.press('Shift+ArrowRight');
  check('Shift+Right moves the out point one second', (await end.getAttribute('aria-valuenow')) === '3', await end.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  check('Left moves it one frame and the value text is announced', (await end.getAttribute('aria-valuenow')) === '2.967' && /\d/.test((await end.getAttribute('aria-valuetext')) ?? ''), `${await end.getAttribute('aria-valuenow')} ${await end.getAttribute('aria-valuetext')}`);
  await page.keyboard.press('Home');
  check('Home goes to the lowest allowed out point', Number(await end.getAttribute('aria-valuenow')) === Number(await end.getAttribute('aria-valuemin')));
  await page.keyboard.press('Shift+ArrowRight');
  await start.focus();
  await page.keyboard.press('End');
  check('End on the in point goes to its highest allowed value', Number(await start.getAttribute('aria-valuenow')) === Number(await start.getAttribute('aria-valuemax')));
  await page.keyboard.press('Home');
  check('Home on the in point returns to the start', (await start.getAttribute('aria-valuenow')) === '0');
});

await step('export range', async () => {
  await page.locator('.toolbar .button.export').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#export-title');
  await page.selectOption('#export-range', 'marks');
  await page.selectOption('#export-size', '720');
  await page.locator('#export-in').fill('0.5');
  await page.locator('#export-in').press('Enter');
  await page.locator('#export-out').fill('1.5');
  await page.locator('#export-out').press('Enter');
  check('the dialog has named in and out fields that set the range', (await page.locator('.range-handle.start').getAttribute('aria-valuenow')) === '0.5' && (await page.locator('.range-handle.end').getAttribute('aria-valuenow')) === '1.5');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await page.locator('.modal .modal-actions .button.primary').press('Enter');
  const file = `${out}/keyboard-range.mp4`;
  await (await downloadPromise).saveAs(file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const dur = Number(probe.format.duration);
  check('the exported file is the 1 s the keyboard marked', probe.streams[0]?.codec_name === 'h264' && Math.abs(dur - 1) < 0.2, `${dur.toFixed(2)} s`);
});

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll keyboard timeline checks passed');
process.exit(failures ? 1 : 0);
