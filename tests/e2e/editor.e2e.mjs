// Drives the real editor UI in headless Chromium: import, place, trim, split, undo, playback,
// persistence across reload, and export through the dialog. Screenshots go to tests/e2e/.out.
// Usage: node tests/e2e/editor.e2e.mjs   (expects tests/serve.mjs on port 8790)
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

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base + '/');
await page.waitForSelector('.welcome');
await page.screenshot({ path: `${out}/00-welcome.png` });
check('an empty project opens on the Welcome view with the emblem', await page.isVisible('text=Haul in your footage.') && (await page.locator('.welcome img.welcome-emblem:visible').count()) === 1);
check('Welcome offers record, import and open', (await page.locator('.welcome-actions button').allTextContents()).map((t) => t.trim()).join('|') === 'Record screen|Import media|Open project');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.screenshot({ path: `${out}/01-empty.png` });
check('empty state guides the user', await page.isVisible('text=Record your screen or import media'));

// Import fixtures through the file picker.
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png', 'tests/fixtures/tone.wav']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
check('three items in the media bin', (await page.locator('.bin-item').count()) === 3);

// Drag the video from the bin onto the bottom-most lane at ~0s.
const lanes = page.locator('.lane');
const laneCount = await lanes.count();
const bottomLane = lanes.nth(laneCount - 1);
const lb = await bottomLane.boundingBox();
await page.locator('.bin-item', { hasText: 'clip.webm' }).dragTo(bottomLane, { targetPosition: { x: 2, y: lb.height / 2 } });
await page.waitForSelector('.clip');
check('drag from bin places a clip', (await page.locator('.clip').count()) === 1);

// Double-click the card: it is added at the playhead (0s) and goes to a free track.
await page.locator('.bin-item', { hasText: 'card.png' }).dblclick();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
check('double-click adds a second clip', (await page.locator('.clip').count()) === 2);

// Move the card clip to 3s by dragging it along its lane (zoom default 60 px/s).
const card = page.locator('.clip.kind-image');
const cb = await card.boundingBox();
await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
await page.mouse.down();
await page.mouse.move(cb.x + cb.width / 2 + 90, cb.y + cb.height / 2, { steps: 8 });
await page.mouse.move(cb.x + cb.width / 2 + 180, cb.y + cb.height / 2, { steps: 8 });
await page.mouse.up();
const cardLeft = (await card.boundingBox()).x - cb.x;
check('dragging moves the clip (snaps to video end at 3s)', Math.abs(cardLeft - 180) <= 2, `${cardLeft}px`);

// Preview should show the video at t=1.
await page.locator('.ruler').click({ position: { x: 60, y: 10 } });
await page.waitForTimeout(400);
const tc = await page.locator('.timecode .now').textContent();
check('clicking the ruler seeks', tc === '0:00:01;00', tc);
const lit = await page.evaluate(() => {
  const c = document.querySelector('.preview-canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(c.width * 0.1, c.height * 0.5, 1, 1).data;
  return [d[0], d[1], d[2]];
});
check('preview canvas shows the video frame', lit[0] + lit[1] + lit[2] > 100, `rgb(${lit})`);

// Split the video at 1s, then undo and redo.
await page.locator('.clip.kind-video').click({ position: { x: 20, y: 10 } });
await page.keyboard.press('s');
check('S splits the clip under the playhead', (await page.locator('.clip.kind-video').count()) === 2);
await page.keyboard.press('Control+z');
check('Ctrl+Z undoes the split', (await page.locator('.clip.kind-video').count()) === 1);
await page.keyboard.press('Control+y');
check('Ctrl+Y redoes the split', (await page.locator('.clip.kind-video').count()) === 2);

// Trim the end of the card clip from 8s back to 6s by dragging its right edge.
const cardBox = await card.boundingBox();
await page.mouse.move(cardBox.x + cardBox.width - 2, cardBox.y + cardBox.height / 2);
await page.mouse.down();
await page.mouse.move(cardBox.x + cardBox.width - 122, cardBox.y + cardBox.height / 2, { steps: 10 });
await page.mouse.up();
const trimmedWidth = (await card.boundingBox()).width;
check('dragging the right edge trims the clip', Math.abs(trimmedWidth - 180) <= 3, `${trimmedWidth}px`);

// Inspector: select the card and scale it to 50%.
await card.click({ position: { x: 40, y: 12 } });
await page.waitForSelector('.inspector >> text=Scale');
const scaleInput = page.locator('#f-scale');
await scaleInput.fill('50');
await scaleInput.press('Enter');
check('inspector scale edits the clip', (await scaleInput.inputValue()) === '50');

// Playback advances time. Move focus out of the inspector field first: shortcuts are
// deliberately ignored while typing.
await page.locator('.transport .timecode').click();
await page.keyboard.press('Home');
check('Home goes to the start', (await page.locator('.timecode .now').textContent()) === '0:00:00;00');
await page.keyboard.press('Space');
await page.waitForTimeout(1500);
await page.keyboard.press('Space');
const played = await page.locator('.timecode .now').textContent();
const [, , secs, frames] = played.split(/[:;]/).map(Number);
const playedSeconds = secs + frames / 30;
check('Space plays and pauses', playedSeconds > 1.0 && playedSeconds < 2.5, played);
await page.waitForTimeout(400);
check('time holds while paused', (await page.locator('.timecode .now').textContent()) === played);
await page.screenshot({ path: `${out}/02-editing.png` });

// Persistence: reload and the project comes back from IndexedDB.
await page.waitForTimeout(700);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 3, null, { timeout: 15000 });
check('project and media survive a reload', (await page.locator('.bin-item').count()) === 3);

// Export through the dialog.
await page.locator('.toolbar .button.export').click();
await page.waitForSelector('#export-title');
await page.screenshot({ path: `${out}/03-export-dialog.png` });
const downloadPromise = page.waitForEvent('download', { timeout: 240000 });
await page.locator('.modal .button.primary').click();
const download = await downloadPromise;
const file = `${out}/ui-export.mp4`;
await download.saveAs(file);
await page.waitForSelector('.modal .success');
await page.screenshot({ path: `${out}/04-exported.png` });
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const dur = Number(probe.format.duration);
check('UI export is a valid MP4 of the timeline length', probe.streams[0]?.codec_name === 'h264' && Math.abs(dur - 6) < 0.15, `${dur}s`);
check('UI export is 1920x1080', probe.streams.some((s) => s.width === 1920 && s.height === 1080));

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll editor checks passed');
process.exit(failures ? 1 : 0);
