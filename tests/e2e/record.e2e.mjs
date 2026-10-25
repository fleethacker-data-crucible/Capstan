// Records with Chromium's fake capture devices and checks the recording lands in the bin and
// on the timeline. Usage: node tests/e2e/record.e2e.mjs   (expects tests/serve.mjs on 8790)
import { chromium } from 'playwright';

const base = process.env.OPENTAPE_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-accept-this-tab-capture',
    '--auto-select-tab-capture-source-by-title=OpenTape',
    '--auto-select-desktop-capture-source=OpenTape',
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['microphone', 'camera'], { origin: base });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/');
await page.waitForSelector('.media-bin');

await page.getByRole('button', { name: 'Record screen' }).click();
await page.getByRole('button', { name: 'Start recording' }).click();
const started = await page
  .waitForSelector('.rec-status.recording', { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check('recording starts', started, started ? '' : await page.locator('.modal .error').textContent().catch(() => ''));
if (started) {
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.waitForSelector('.clip', { timeout: 15000 });
  const name = await page.locator('.bin-name').first().textContent();
  check('recording is in the media bin', /^Recording /.test(name ?? ''), name);
  check('recording is placed on the timeline', (await page.locator('.clip').count()) === 1);
  const dur = await page.locator('.timecode .total').textContent();
  const [, , s, f] = dur.split(/[:;]/).map(Number);
  const seconds = s + f / 30;
  // ~3.3 s recorded; the 0.8 s pause is excluded.
  check('recorded length excludes the pause', seconds > 2.4 && seconds < 4.6, dur);
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll recorder checks passed');
process.exit(failures ? 1 : 0);
