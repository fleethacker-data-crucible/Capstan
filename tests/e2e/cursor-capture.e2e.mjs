// Cursor and shortcut capture through the Record dialog, against the test server's mirror of the host
// (tests/helpers/cursor-host-mirror.mjs: a circle path, two left clicks, Ctrl+C; synthetic data only).
// getDisplayMedia is the same synthetic canvas stream as record.e2e.mjs, and no fake-UI flag is passed.
// Usage: node tests/e2e/cursor-capture.e2e.mjs   (or via run-all.mjs; expects dist/ built)
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__displayCalls = [];
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
    const surface = options?.video?.displaySurface ?? 'monitor';
    const real = track.getSettings.bind(track);
    track.getSettings = () => ({ ...real(), displaySurface: surface, width: 640, height: 360 });
    track.addEventListener('ended', () => clearInterval(timer));
    return stream;
  };
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
const media = page.getByRole('region', { name: 'Media' });

const hostCalls = async () => (await (await fetch(`${base}/api/test/cursor-calls`)).json()).map((c) => `${c.method} ${c.path.replace('/api/cursor/', '')}`);
const lastDisplayCall = () => page.evaluate(() => window.__displayCalls.at(-1));
const dialog = page.getByRole('dialog');

/** Opens the Record dialog with a clean, quick setup: the entire screen, no sound, no countdown, no disk. */
async function openRecorder() {
  await media.getByRole('button', { name: 'Record screen' }).click();
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: 'The entire screen' }).check();
  await dialog.getByRole('checkbox', { name: /Record my microphone/ }).uncheck();
  await dialog.getByRole('checkbox', { name: /Record computer sound/ }).uncheck();
  await dialog.locator('#rec-countdown').selectOption('0');
}
async function waitRecording() {
  await page.waitForSelector('.rec-status.recording', { timeout: 10000 });
}
async function stopAndSave() {
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.waitForFunction(() => !document.querySelector('.record-modal'), null, { timeout: 20000 });
}

// ---- 1. the options are off by default, and say what they do ----------------------------------------
await media.getByRole('button', { name: 'Record screen' }).click();
await dialog.waitFor();
const capture = dialog.getByRole('checkbox', { name: 'Capture cursor and keys for effects' });
check('the capture option is OFF by default', !(await capture.isChecked()));
check('the capture option is unavailable for a window (a browser cannot tell where it is)', await capture.isDisabled());
check('the dialog says why', /entire screen/.test(await dialog.locator('#cursor-capture-note').textContent()));
check('no keyboard option is shown until capture is on', (await dialog.getByRole('checkbox', { name: 'Include keyboard shortcuts' }).count()) === 0);
await dialog.getByRole('radio', { name: 'The entire screen' }).check();
check('the capture option can be chosen for the entire screen', await capture.isEnabled());
const note = await dialog.locator('#cursor-capture-note').textContent();
check('the note says what is recorded and where it goes', /where the mouse pointer is/.test(note) && /buttons are pressed/.test(note) && /never leaves this computer/.test(note) && /Capstan\\recordings/.test(note), note);
await capture.check();
const keysBox = dialog.getByRole('checkbox', { name: 'Include keyboard shortcuts' });
check('the keyboard shortcut option is separate and OFF by default', (await keysBox.count()) === 1 && !(await keysBox.isChecked()));
const keysNote = await dialog.locator('#cursor-keys-note').textContent();
check('the shortcut note says typed text is never recorded', /never recorded/.test(keysNote) && /Typed letters, numbers and punctuation/.test(keysNote), keysNote);
await dialog.getByRole('button', { name: 'Cancel' }).click();
await dialog.waitFor({ state: 'hidden' });
check('reopening the dialog starts with capture off again (it is not remembered)', await (async () => {
  await media.getByRole('button', { name: 'Record screen' }).click();
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: 'The entire screen' }).check();
  const off = !(await dialog.getByRole('checkbox', { name: 'Capture cursor and keys for effects' }).isChecked());
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  return off;
})());

// ---- 2. option off: a normal recording, and the host is not called at all ---------------------------
const callsBefore = (await hostCalls()).length;
await openRecorder();
await page.getByRole('button', { name: 'Start recording' }).click();
await waitRecording();
check('with capture off there is no indicator in the recording bar', (await page.getByTestId('capture-indicator').count()) === 0);
await page.waitForTimeout(1200);
await stopAndSave();
await page.waitForSelector('.clip', { timeout: 15000 });
check('with capture off no cursor host call is made', (await hostCalls()).length === callsBefore, (await hostCalls()).join(', '));
check('with capture off the browser is not asked to hide the pointer', (await lastDisplayCall())?.video?.cursor === undefined);
check('with capture off the recording has no cursor data', !(await page.locator('.bin-sub').first().textContent()).includes('cursor data'));

// ---- 3. capture on, shortcuts on: record 2 s with a pause --------------------------------------------
await openRecorder();
await dialog.getByRole('checkbox', { name: 'Capture cursor and keys for effects' }).check();
await dialog.getByRole('checkbox', { name: 'Include keyboard shortcuts' }).check();
const before = (await hostCalls()).length;
await page.getByRole('button', { name: 'Start recording' }).click();
await waitRecording();
const asked = await lastDisplayCall();
check('the browser is asked to leave the pointer out, so Capstan can draw it', asked?.video?.cursor === 'never', JSON.stringify(asked?.video));
const indicator = page.getByTestId('capture-indicator');
check('the recording bar shows that cursor and shortcuts are being captured', (await indicator.textContent()) === 'Capturing cursor and shortcuts', await indicator.textContent().catch(() => ''));
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Pause' }).click();
check('pausing says capture is paused too', (await indicator.textContent()) === 'Cursor capture paused');
await page.waitForTimeout(700);
await page.getByRole('button', { name: 'Resume' }).click();
check('resuming brings the indicator back', (await indicator.textContent()) === 'Capturing cursor and shortcuts');
await page.waitForTimeout(1000);
await stopAndSave();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2, null, { timeout: 15000 });
const seen = (await hostCalls()).slice(before);
check('the host is called in order: status, start, pause, resume, stop', seen.join(',') === 'GET status,POST start,POST pause,POST resume,POST stop', seen.join(','));
check('the new recording is marked as having cursor data', (await page.locator('.bin-sub').nth(1).textContent()).includes('cursor data'), await page.locator('.bin-sub').nth(1).textContent());
check('the first (capture off) recording still has none', !(await page.locator('.bin-sub').nth(0).textContent()).includes('cursor data'));

// ---- 4. the cursor tab and the effects draw the captured data ----------------------------------------
await page.getByRole('tab', { name: 'Cursor' }).click();
await page.locator('.cursor-panel').waitFor();
const summaries = await page.getByTestId('cursor-summary').allTextContents();
const mine = summaries.find((s) => /^\d+ positions/.test(s)) ?? '';
const m = /^(\d+) positions, (\d+) clicks, (\d+) keys$/.exec(mine);
check('the Cursor tab lists positions, 2 clicks and 1 shortcut for the new recording', !!m && Number(m[2]) === 2 && Number(m[3]) === 1, mine);
check('positions run at about 60 a second for the 2 s recording', !!m && Number(m[1]) > 90 && Number(m[1]) < 135, mine);
check('the first recording says it has no cursor data', summaries.some((s) => s.startsWith('No cursor data')));
check('the drawn cursor is turned on for the new recording', await page.getByLabel('Draw the cursor').isChecked());

// Put the clip we want to look at first on the timeline: the second clip starts where the first one ends.
const clipStart = await page.evaluate(() => {
  const clips = [...document.querySelectorAll('.clip')];
  const ruler = document.querySelector('.ruler').getBoundingClientRect();
  return clips.map((c) => (c.getBoundingClientRect().left - ruler.left) / 60).sort((a, b) => a - b);
});
const t0 = clipStart[1]; // seconds on the timeline where the captured recording starts
const seek = async (t) => {
  await page.locator('.ruler').click({ position: { x: Math.round((t0 + t) * 60), y: 10 } });
  await page.waitForTimeout(450);
};
const snap = () =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    window.__snap = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  });
const diff = (x0, y0, x1, y1, th = 24) =>
  page.evaluate(
    ([x0, y0, x1, y1, th]) => {
      const c = document.querySelector('.preview-canvas');
      const now = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const was = window.__snap;
      let changed = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * c.width + x) * 4;
          if (Math.max(Math.abs(now.data[i] - was.data[i]), Math.abs(now.data[i + 1] - was.data[i + 1]), Math.abs(now.data[i + 2] - was.data[i + 2])) > th) changed++;
        }
      }
      return changed;
    },
    [x0, y0, x1, y1, th],
  );
const settle = () => page.waitForTimeout(350);
const [cw, ch] = await page.evaluate(() => {
  const c = document.querySelector('.preview-canvas');
  return [c.width, c.height];
});
const px = (fx, fy) => [Math.round(fx * cw), Math.round(fy * ch)];

// The circle: (0.5 + 0.3 cos(pi t), 0.5 + 0.3 sin(pi t)) in host time. The recorder starts a few tens of ms after the
// host session, so the picture is compared with a margin of 6% of the frame (the clock arithmetic itself is unit tested).
const M = 0.06;
await seek(0.3);
await snap();
await page.getByLabel('Draw the cursor').uncheck();
await settle();
const [cx, cy] = px(0.5 + 0.3 * Math.cos(Math.PI * 0.3), 0.5 + 0.3 * Math.sin(Math.PI * 0.3));
const m6 = Math.round(M * cw);
const near = (x, y) => diff(x - m6, y - m6, x + m6 + 70, y + m6 + 70);
let changed = await near(cx, cy);
check('the captured cursor is drawn where the circle is at 0.3 s', changed > 300, `${changed} px changed near (${cx}, ${cy})`);
changed = await diff(0, 0, Math.round(cw * 0.4), Math.round(ch * 0.4));
check('and nowhere else in the picture', changed === 0, `${changed} px changed in the top left`);
// A different time puts it somewhere else: the data moves with the playhead.
await page.getByLabel('Draw the cursor').check();
await seek(1.1);
await snap();
await page.getByLabel('Draw the cursor').uncheck();
await settle();
const [dx, dy] = px(0.5 + 0.3 * Math.cos(Math.PI * 1.1), 0.5 + 0.3 * Math.sin(Math.PI * 1.1));
check('at 1.1 s it is at the other side of the circle', (await near(dx, dy)) > 300 && (await near(cx, cy)) === 0, `expected near (${dx}, ${dy})`);
await page.getByLabel('Draw the cursor').check();

// A click ring after the first click (host time 0.5 s, cursor at (0.5, 0.8)).
await seek(0.62);
await snap();
await page.getByLabel('Click rings').check();
await settle();
const [rx, ry] = px(0.5, 0.8);
changed = await diff(rx - 160, ry - 160, rx + 160, ry + 160, 16);
check('a click ring is drawn after the captured click', changed > 100, `${changed} px changed near (${rx}, ${ry})`);
await page.getByLabel('Click rings').uncheck();

// The Ctrl+C callout after host time 0.8 s.
await seek(0.95);
await snap();
await page.getByLabel('Keystroke callouts').check();
await settle();
changed = await diff(Math.round(cw * 0.3), Math.round(ch * 0.82), Math.round(cw * 0.7), Math.round(ch * 0.96), 24);
check('a Ctrl+C bubble is drawn from the captured shortcut', changed > 800, `${changed} px changed`);
await page.getByLabel('Keystroke callouts').uncheck();

// ---- 5. no host: say so, record normally --------------------------------------------------------------
await page.route('**/api/cursor/status', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Cursor capture is not available on this computer.', code: 'unavailable' }) }));
await page.getByRole('tab', { name: 'Media' }).click();
await openRecorder();
await dialog.getByRole('checkbox', { name: 'Capture cursor and keys for effects' }).check();
await page.getByRole('button', { name: 'Start recording' }).click();
await waitRecording();
check('without the host the pointer is NOT hidden from the picture', (await lastDisplayCall())?.video?.cursor === undefined);
check('without the host there is no capture indicator', (await page.getByTestId('capture-indicator').count()) === 0);
const warn = await page.locator('.record-warning').textContent().catch(() => '');
check('without the host the dialog says so', /not available/.test(warn ?? ''), warn);
await page.waitForTimeout(900);
await stopAndSave();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 3, null, { timeout: 15000 });
check('the recording was still made', (await page.locator('.clip').count()) === 3);
check('and carries no cursor data', (await page.locator('.bin-sub').nth(2).textContent()).includes('cursor data') === false);
await page.unroute('**/api/cursor/status');

// ---- 6. the host session is free again after each recording ------------------------------------------
await openRecorder();
await dialog.getByRole('checkbox', { name: 'Capture cursor and keys for effects' }).check();
const mark = (await hostCalls()).length;
await page.getByRole('button', { name: 'Start recording' }).click();
await waitRecording();
check('a capture indicator without shortcuts says Capturing cursor', (await page.getByTestId('capture-indicator').textContent()) === 'Capturing cursor');
await page.getByRole('button', { name: 'Stop and save' }).click();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 4, null, { timeout: 15000 });
const tail = (await hostCalls()).slice(mark);
check('a second capture can start after the first one ended (one session at a time, then free)', tail.join(',') === 'GET status,POST start,POST stop', tail.join(','));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll cursor capture checks passed');
process.exit(failures ? 1 : 0);
