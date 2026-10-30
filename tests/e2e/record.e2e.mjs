// Drives the record dialog with a synthetic capture stream and checks the recording lands in the
// bin and on the timeline. Usage: node tests/e2e/record.e2e.mjs   (expects tests/serve.mjs on 8790)
//
// getDisplayMedia is replaced by a canvas stream before the page loads, and no fake-UI flag is
// passed: on a Windows runner or workstation, Chromium's fake capture UI shares the real desktop.
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.grantPermissions(['microphone'], { origin: base });
await context.addInitScript(() => {
  window.__displayCalls = [];
  window.__reportSurface = null; // when set, the stub claims to share this instead of what was asked for
  navigator.mediaDevices.getDisplayMedia = async (options) => {
    window.__displayCalls.push(JSON.parse(JSON.stringify(options ?? {})));
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    let n = 0;
    const draw = () => {
      g.fillStyle = `hsl(${(n * 9) % 360} 55% 40%)`;
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.font = '64px sans-serif';
      g.fillText(String(n++), 40, 200);
    };
    draw();
    const timer = setInterval(draw, 33);
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    const surface = window.__reportSurface ?? options?.video?.displaySurface ?? 'monitor';
    const real = track.getSettings.bind(track);
    track.getSettings = () => ({ ...real(), displaySurface: surface, width: 640, height: 360 });
    track.addEventListener('ended', () => clearInterval(timer));
    return stream;
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/');
// An empty project opens on the Welcome view; this test drives the editor's Media panel.
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
const media = page.getByRole('region', { name: 'Media' });

// ---- a tab was asked for, the browser shared a screen: refused, nothing recorded ----
await media.getByRole('button', { name: 'Record screen' }).click();
await page.getByRole('radio', { name: 'A browser tab' }).check();
await page.evaluate(() => (window.__reportSurface = 'monitor'));
await page.getByRole('button', { name: 'Start recording' }).click();
const refusal = await page.locator('.modal .error').textContent({ timeout: 5000 }).catch(() => '');
check('wrong surface is refused', /Nothing was recorded/.test(refusal ?? ''), refusal);
check('no recording started after a refusal', (await page.locator('.rec-status').count()) === 0);
const asked = await page.evaluate(() => window.__displayCalls.at(-1));
check('tab request asks for a browser surface', asked?.video?.displaySurface === 'browser', JSON.stringify(asked?.video));
check('tab request excludes screens from the picker', asked?.monitorTypeSurfaces === 'exclude' && asked?.selfBrowserSurface === 'exclude');
check('capture is capped at the canvas size', asked?.video?.width?.max === 1920 && asked?.video?.height?.max === 1080);
await page.evaluate(() => (window.__reportSurface = null));

// ---- a window, as asked: record, pause/resume, stop ----
await page.getByRole('radio', { name: 'A window' }).check();
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
