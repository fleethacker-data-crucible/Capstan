// The preview tool registry: selecting and dragging a clip, and adding, dragging and resizing a blur
// region, through the real UI. Also checks the overlay lane for blur regions under the tracks.
// Usage: node tests/e2e/preview-tools.e2e.mjs   (or via run-all.mjs)
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
await page.locator('.ruler').click({ position: { x: 30, y: 10 } });
await page.waitForTimeout(300);

const canvas = page.locator('.canvas-frame');
const box = await canvas.boundingBox();

// Click the picture: the clip is selected and shows its selection box.
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
check('clicking the picture selects the clip', (await page.locator('.selection-box').count()) === 1);

// Drag it right by ~100 preview px; the Inspector position X grows.
const x0 = Number(await page.locator('#f-position-x').inputValue());
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 5 });
await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
await page.mouse.up();
const x1 = Number(await page.locator('#f-position-x').inputValue());
check('dragging the picture moves the clip', x1 > x0 + 50, `${x0} -> ${x1}`);
await page.keyboard.press('Control+z');
check('one drag is one undo step', Number(await page.locator('#f-position-x').inputValue()) === x0);

// Scale handle.
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
const s0 = Number(await page.locator('#f-scale').inputValue());
const handle = await page.locator('.selection-box .scale-handle').boundingBox();
await page.mouse.move(handle.x + 6, handle.y + 6);
await page.mouse.down();
await page.mouse.move(handle.x + 40, handle.y + 30, { steps: 6 });
await page.mouse.up();
const s1 = Number(await page.locator('#f-scale').inputValue());
check('the scale handle resizes the clip', s1 !== s0, `${s0} -> ${s1}`);

// Blur region: add at the playhead, it gets a lane row and a dashed box; drag and resize it.
await page.locator('.transport .timecode').click();
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Add blur region at playhead' }).click();
await page.waitForSelector('.region-box');
check('a blur region shows in an overlay lane', (await page.locator('.overlay-lane .overlay-item').count()) === 1);
const left0 = Number(await page.locator('#f-left').inputValue());
const rb = await page.locator('.region-box').boundingBox();
await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
await page.mouse.down();
await page.mouse.move(rb.x + rb.width / 2 + 40, rb.y + rb.height / 2, { steps: 5 });
await page.mouse.up();
check('dragging a blur region moves it', Number(await page.locator('#f-left').inputValue()) > left0 + 20);
const w0 = Number(await page.locator('#f-width').inputValue());
const rh = await page.locator('.region-box .scale-handle').boundingBox();
await page.mouse.move(rh.x + 6, rh.y + 6);
await page.mouse.down();
await page.mouse.move(rh.x + 46, rh.y + 16, { steps: 5 });
await page.mouse.up();
check('the region handle resizes it', Number(await page.locator('#f-width').inputValue()) > w0 + 20);

// Moving the region by its lane item changes its start time.
const item = page.locator('.overlay-lane .overlay-item');
const ib = await item.boundingBox();
await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
await page.mouse.down();
await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2, { steps: 6 });
await page.mouse.up();
const ib2 = await item.boundingBox();
check('dragging the lane item moves the region in time', ib2.x > ib.x + 30, `${ib.x} -> ${ib2.x}`);

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll preview tool checks passed');
process.exit(failures ? 1 : 0);
