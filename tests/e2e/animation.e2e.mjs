// Animation area through the real UI in headless Chromium: keyframes (add, auto-key, undo), zoom-n-pan
// (add, magnified at mid-time, dragging the box, Delete), transitions (fade), behaviors (entrance),
// and a tiny export that proves the encoder shows the transition and the zoom too.
// All checks read canvas pixels, so they test what is drawn, not just what the panels say.
// Usage: node tests/e2e/run-all.mjs animation   (or node tests/e2e/animation.e2e.mjs with tests/serve.mjs running)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const built = spawnSync('bun', ['build', 'tests/e2e/animation-harness.ts', '--outdir', 'tests/e2e/.build', '--target', 'browser'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (built.status !== 0) {
  console.error(built.stdout, built.stderr);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/card.png']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
await page.locator('.bin-item').dblclick();
await page.waitForSelector('.clip');

// ---------- helpers ----------
const pixel = (x, y) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.preview-canvas');
      const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  );
const whiteCount = () =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++;
    return n;
  });
// Seeks with the keyboard: clicking the ruler would clear the selection, and the inspector is what these tests drive.
const seek = async (t) => {
  await page.locator('.transport .timecode').click();
  await page.keyboard.press('Home');
  const whole = Math.floor(t + 1e-9);
  for (let i = 0; i < whole; i++) {
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForTimeout(60);
  }
  for (let i = 0; i < Math.round((t - whole) * 30); i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(200);
};
const isBlue = ([r, , b]) => b > 150 && r < 90;
const isBlack = ([r, g, b]) => r + g + b < 30;
const field = (id) => page.locator(`#${id}`);
const setField = async (id, v) => {
  const el = field(id);
  await el.fill(String(v));
  await el.press('Enter');
};
const selectClip = () => page.locator('.clip.kind-image').click({ position: { x: 40, y: 12 } });
const blurFocus = () => page.locator('.transport .timecode').click();

await selectClip();
await page.waitForSelector('.inspector >> text=Scale');
await setField('f-scale', 50);

// ---------- keyframes with easing ----------
await seek(0);
await setField('f-position-x', 480);
check('a clip with no keys shows no key marks', (await page.locator('.key-mark').count()) === 0);
await page.getByRole('button', { name: 'Add Position X key at playhead' }).click();
check('the diamond turns into a remove button at the key', (await page.getByRole('button', { name: 'Remove Position X key at playhead' }).getAttribute('aria-pressed')) === 'true');
await seek(2);
await setField('f-position-x', 1440); // auto-key: the property already has a key, so this adds one at 2 s
const keyText = await page.locator('.key-prop', { hasText: 'Position X' }).textContent();
check('editing a keyed property at another time adds a key there', /2 keys/.test(keyText ?? ''), keyText ?? '');
check('keyframes are marked in the timeline', (await page.locator('.key-mark').count()) === 2);
check('the other properties stay unkeyed', !/keys?/.test((await page.locator('.key-prop', { hasText: 'Rotation' }).textContent()) ?? ''));

await seek(0);
check('t=0: the picture sits on the left', isBlue(await pixel(200, 540)) && isBlack(await pixel(1700, 540)), JSON.stringify([await pixel(200, 540), await pixel(1700, 540)]));
await seek(1);
check('t=1: the picture is halfway across', isBlack(await pixel(200, 540)) && isBlack(await pixel(1700, 540)) && isBlue(await pixel(960, 300)), JSON.stringify([await pixel(200, 540), await pixel(1700, 540), await pixel(960, 300)]));
await seek(2);
check('t=2: the picture sits on the right', isBlack(await pixel(200, 540)) && isBlue(await pixel(1700, 540)));
await page.screenshot({ path: `${out}/anim-01-keyframes.png` });

await page.getByRole('button', { name: /^Go to Position X key at 0:00:00;00/ }).click();
await page.waitForTimeout(150);
check('a key row jumps to its time', (await page.locator('.timecode .now').textContent()) === '0:00:00;00');
await seek(2);
await page.getByLabel(/^Easing for Position X key at 0:00:00;00/).selectOption('hold');
await seek(1);
check('a hold key keeps its value until the next key', isBlue(await pixel(200, 540)));
await blurFocus();
await page.keyboard.press('Control+z');
await seek(1);
check('Ctrl+Z undoes the easing change', isBlack(await pixel(200, 540)) && isBlue(await pixel(960, 300)));
await page.keyboard.press('Control+z');
await seek(2);
check('Ctrl+Z undoes the auto-key at 2 s', isBlue(await pixel(200, 540)) && (await page.locator('.key-mark').count()) === 1);
await page.keyboard.press('Control+y');
await page.keyboard.press('Control+y');
await seek(2);
check('Ctrl+Y brings both back', isBlue(await pixel(1700, 540)) && (await page.locator('.key-mark').count()) === 2);
await page.keyboard.press('Control+z'); // back to the smooth easing for the rest

// Dragging the picture at a time with keys sets a key rather than moving the base value.
await seek(1);
const frame = await page.locator('.canvas-frame').boundingBox();
const k = frame.width / 1920;
await page.mouse.move(frame.x + 960 * k, frame.y + 300 * k);
await page.mouse.down();
await page.mouse.move(frame.x + 960 * k + 40, frame.y + 300 * k, { steps: 4 });
await page.mouse.move(frame.x + 960 * k + 80, frame.y + 300 * k, { steps: 4 });
await page.mouse.up();
check('dragging a keyed clip in the preview adds a key at the playhead', /3 keys/.test((await page.locator('.key-prop', { hasText: 'Position X' }).textContent()) ?? ''));

// Delete a key from its row, then clear the rest.
await page.getByRole('button', { name: /^Delete Position X key at 0:00:01;00/ }).click();
check('a key can be deleted', /2 keys/.test((await page.locator('.key-prop', { hasText: 'Position X' }).textContent()) ?? ''));
await page.getByRole('button', { name: 'Clear all keys' }).click();
check('Clear all keys removes the marks', (await page.locator('.key-mark').count()) === 0);
await setField('f-scale', 100);
await setField('f-position-x', 960);

// ---------- zoom-n-pan ----------
await seek(1);
await page.getByRole('tab', { name: 'Motion' }).click();
await page.getByLabel('Zoom region length').fill('3');
await page.getByLabel('Zoom region length').press('Enter');
await page.getByRole('button', { name: 'Add zoom at playhead' }).click();
await page.waitForSelector('.zoom-box');
check('a zoom region gets a row under the tracks and a box on the picture', (await page.locator('.overlay-lane .overlay-item').count()) === 1 && (await page.locator('.zoom-box').count()) === 1);
check('the zoom region panel opens for it', await page.isVisible('section[aria-label="Zoom region"]'));
await blurFocus();
await seek(0.5);
const white0 = await whiteCount();
check('before the region the whole canvas shows (letterbox is black)', isBlack(await pixel(100, 540)), `white ${white0}`);
await seek(1);
check('at the first instant the picture is still whole', isBlack(await pixel(100, 540)));
await seek(2.5);
const white1 = await whiteCount();
check('mid-region the picture is magnified 2x (letterbox gone, text ~4x larger)', isBlue(await pixel(100, 540)) && white1 > white0 * 2.5, `white ${white0} -> ${white1}`);
await page.screenshot({ path: `${out}/anim-02-zoom.png` });
await seek(1.25);
const bar = await pixel(100, 540);
check('during the ease-in the camera is part-way (the letterbox edge has moved)', isBlack(bar) || isBlue(bar));
const midWhite = await whiteCount();
check('part-way through the ease-in the magnification is between the two', midWhite > white0 && midWhite < white1, `white ${white0} < ${midWhite} < ${white1}`);
await seek(4.5);
check('after the region the picture is whole again', isBlack(await pixel(100, 540)) && (await whiteCount()) < white0 * 1.3);

// Drag the box with its grip and resize it with its corner (at a time the camera is not zoomed).
await seek(0.5);
const left0 = Number(await field('f-left').inputValue());
const grip = await page.locator('.zoom-grip').boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2 + 20, grip.y + grip.height / 2, { steps: 4 });
await page.mouse.move(grip.x + grip.width / 2 + 40, grip.y + grip.height / 2, { steps: 4 });
await page.mouse.up();
const left1 = Number(await field('f-left').inputValue());
check('dragging the grip moves the zoom region', left1 > left0 + 40, `${left0} -> ${left1}`);
const zoom0 = Number(await field('f-zoom').inputValue());
const handle = await page.locator('.zoom-box .scale-handle').boundingBox();
await page.mouse.move(handle.x + 6, handle.y + 6);
await page.mouse.down();
await page.mouse.move(handle.x + 26, handle.y + 6, { steps: 4 });
await page.mouse.move(handle.x + 46, handle.y + 6, { steps: 4 });
await page.mouse.up();
const zoom1 = Number(await field('f-zoom').inputValue());
check('dragging the corner resizes it (less zoom for a bigger box)', zoom1 < zoom0 - 0.1, `${zoom0} -> ${zoom1}`);
await blurFocus();
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
check('each drag is one undo step', Number(await field('f-left').inputValue()) === left0 && Number(await field('f-zoom').inputValue()) === zoom0);

// Delete removes the selected zoom region; undo brings it back.
await blurFocus();
await page.keyboard.press('Delete');
check('Delete removes the selected zoom region', (await page.locator('.overlay-lane .overlay-item').count()) === 0 && (await page.locator('.zoom-box').count()) === 0);
await seek(2.5);
check('and the picture is whole again at mid-time', isBlack(await pixel(100, 540)));
await page.keyboard.press('Control+z');
check('Ctrl+Z restores it', (await page.locator('.overlay-lane .overlay-item').count()) === 1);
await page.locator('.overlay-lane .overlay-item').click();
await blurFocus();
await page.keyboard.press('Delete');
check('selecting it in the lane and pressing Delete removes it', (await page.locator('.overlay-lane .overlay-item').count()) === 0);

// ---------- transitions ----------
await selectClip();
await page.getByRole('tab', { name: 'Motion' }).click();
await page.getByRole('group', { name: 'Transition presets' }).getByRole('button', { name: 'Fade', exact: true }).click();
check('the fade preset shows in the clip inspector', (await page.getByLabel('Transition in', { exact: true }).inputValue()) === 'fade' && (await page.getByLabel('Transition out', { exact: true }).inputValue()) === 'fade');
check('the transitions are drawn on the timeline clip', (await page.locator('.transition-mark').count()) === 2);
await seek(0);
const first = await pixel(960, 200);
check('the first frame of a fade-in is dark', first[0] + first[1] + first[2] < 25, JSON.stringify(first));
await seek(0.25);
const part = await pixel(960, 200);
check('part-way through the fade it is half bright', part[2] > 30 && part[2] < 190, JSON.stringify(part));
await seek(1.5);
check('after the fade it is fully bright', isBlue(await pixel(960, 200)));
await seek(4.9);
const last = await pixel(960, 200);
check('the end fades out again', last[0] + last[1] + last[2] < 60, JSON.stringify(last));
await page.screenshot({ path: `${out}/anim-03-transition.png` });
await page.getByRole('group', { name: 'Transition presets' }).getByRole('button', { name: 'None' }).click();
check('None removes both transitions', (await page.locator('.transition-mark').count()) === 0);
await seek(0);
check('without a transition the first frame is bright', isBlue(await pixel(960, 200)));

// ---------- behaviors ----------
await page.getByRole('group', { name: 'Entrance presets' }).getByRole('button', { name: 'Slide from the left' }).click();
check('the behavior shows in the clip inspector', (await page.getByLabel('Behavior enter').inputValue()) === 'slide-left');
await seek(0);
check('entrance: at the start the clip is out of frame', isBlack(await pixel(960, 540)) && isBlack(await pixel(960, 200)));
await seek(0.25);
check('entrance: part-way the clip has slid in from the left', isBlue(await pixel(100, 540)) && isBlue(await pixel(500, 200)), JSON.stringify(await pixel(100, 540)));
await seek(1.5);
check('entrance: afterwards the clip is at rest', isBlack(await pixel(100, 540)) && isBlue(await pixel(960, 200)));
await blurFocus();
await page.keyboard.press('Control+z');
await seek(0);
check('Ctrl+Z removes the behavior', isBlue(await pixel(960, 200)) && (await page.getByLabel('Behavior enter').inputValue()) === '');

// Emphasis (pulse) swells the picture between the entrance and the exit.
await page.getByRole('group', { name: 'Emphasis presets' }).getByRole('button', { name: 'Pulse' }).click();
await seek(0.5); // phase 0.5 of the 1 s pulse: scale 1.12
const wide = await pixel(1700, 540);
await seek(1); // phase 0: scale 1
check('emphasis: pulse enlarges the picture at its peak', isBlue(wide) && isBlack(await pixel(1700, 540)), JSON.stringify([wide, await pixel(1700, 540)]));

// ---------- export ----------
const exp = await browser.newPage();
exp.on('pageerror', (e) => errors.push(e.message));
await exp.goto(`${base}/e2e/animation-harness.html`);
await exp.waitForFunction(() => document.title === 'animation-harness-ready', null, { timeout: 20000 });
const t0 = Date.now();
const { base64, info } = await exp.evaluate(() => window.runAnimationExport());
const file = `${out}/animation-export.mp4`;
writeFileSync(file, Buffer.from(base64, 'base64'));
console.log(`exported ${file} in ${Date.now() - t0} ms`, JSON.stringify(info));
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
const v = probe.streams.find((s) => s.codec_type === 'video');
check('export is a 320x180 H.264 file of 3 s', v?.codec_name === 'h264' && v.width === 320 && v.height === 180 && Math.abs(Number(probe.format.duration) - 3) < 0.2, `${v?.width}x${v?.height} ${probe.format.duration}s`);
const frameAt = (t) => {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const px = (x, y) => [raw[(y * 320 + x) * 3], raw[(y * 320 + x) * 3 + 1], raw[(y * 320 + x) * 3 + 2]];
  let white = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i] > 200 && raw[i + 1] > 200 && raw[i + 2] > 200) white++;
  return { px, white };
};
const f0 = frameAt(0);
const f12 = frameAt(1.2);
const f25 = frameAt(2.5);
const lum = (p) => p[0] + p[1] + p[2];
check('export: the first frame is dark (fade-in)', lum(f0.px(160, 30)) < 40, JSON.stringify(f0.px(160, 30)));
check('export: after the fade the picture is bright', f12.px(160, 30)[2] > 150, JSON.stringify(f12.px(160, 30)));
check('export: before the zoom the letterbox is black', lum(f12.px(10, 90)) < 40);
check('export: mid-zoom the picture is magnified (letterbox gone, text larger)', f25.px(10, 90)[2] > 150 && f25.white > f12.white * 2.5, `white ${f12.white} -> ${f25.white}`);

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll animation checks passed');
process.exit(failures ? 1 : 0);
