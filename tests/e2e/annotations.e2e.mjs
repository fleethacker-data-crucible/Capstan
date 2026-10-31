// Annotations through the real UI in headless Chromium: add every kind from the Notes tab, check the
// picture's pixels, drag / resize / rotate with the preview tool, spotlight, sketch motion, delete,
// undo, the timeline lane, reload, and the export path (OffscreenCanvas draw plus a tiny MP4 export).
// Synthetic fixtures only (tests/fixtures/card.png). Usage: node tests/e2e/annotations.e2e.mjs
//   (or: node tests/e2e/run-all.mjs annotations)   Run `bun run build` first.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out';
mkdirSync(out, { recursive: true });
mkdirSync('tests/e2e/.build', { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

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

const px = (x, y) =>
  page.evaluate(([x, y]) => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
const settle = () => page.waitForTimeout(220);
const seek = async (s) => {
  await page.locator('.ruler').click({ position: { x: 60 * s + 0.5, y: 10 } });
  await settle();
};
const frame = () => page.locator('.canvas-frame').boundingBox();
const toPage = async (x, y) => {
  const b = await frame();
  const k = b.width / 1920;
  return { x: b.x + x * k, y: b.y + y * k, k };
};
/** Drags from one canvas-pixel position to another with the mouse. */
const dragCanvas = async (from, to) => {
  const a = await toPage(from[0], from[1]);
  const b = await toPage(to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await settle();
};
const clickCanvas = async (x, y) => {
  const p = await toPage(x, y);
  await page.mouse.click(p.x, p.y);
  await settle();
};
const handleCentre = async (name) => {
  const b = await page.locator(`.ann-handle[data-h="${name}"]`).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Drags a selection handle by a displacement in canvas pixels. */
const dragHandle = async (name, dx, dy) => {
  const h = await handleCentre(name);
  const { k } = await toPage(0, 0);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x + (dx * k) / 2, h.y + (dy * k) / 2, { steps: 4 });
  await page.mouse.move(h.x + dx * k, h.y + dy * k, { steps: 4 });
  await page.mouse.up();
  await settle();
};
const num = async (id) => Number(await page.locator(id).inputValue());
const clickKeyTarget = () => page.locator('.transport .timecode').click(); // takes focus out of any field
const countAnnotations = () => page.locator('.overlay-lane .overlay-item.kind-annotations').count();
const addKind = async (name) => {
  await page.getByRole('button', { name, exact: true }).click();
  await settle();
};

await seek(1);
const base1 = {
  centre: await px(960, 540),
  corner: await px(300, 500), // card blue, outside the default spotlight
  mid: await px(1110, 540),
  armStart: await px(816, 620),
  armEnd: await px(1104, 460),
  left: await px(780, 540),
  right: await px(1230, 540),
};

// The Notes tab and the Add buttons.
await page.getByRole('tab', { name: 'Notes' }).click();
const kinds = await page.locator('.ann-add-grid[aria-label="Add an annotation"] button').allTextContents();
check('Notes tab offers every kind', kinds.map((s) => s.trim()).join('|') === 'Text|Callout|Rectangle|Ellipse|Arrow|Line|Highlight|Spotlight', kinds.join('|'));
check('Notes tab offers blur and pixelate regions too', (await page.locator('.ann-add-grid[aria-label="Add a cover"] button').count()) === 2);

// ---- Rectangle: add, fill, pixel.
await addKind('Rectangle');
check('adding a rectangle selects it and shows its inspector', await page.locator('section[aria-label="Rectangle"]').isVisible());
check('a lane row appears under the tracks', (await countAnnotations()) === 1);
check('an outline-only rectangle leaves its inside alone', near(await px(960, 540), base1.centre, 2));
await page.getByLabel('No fill colour').click();
await page.locator('#ann-fill').fill('#00ff00');
await page.waitForTimeout(900);
await settle();
check('rectangle fill is drawn on the preview', near(await px(960, 540), [0, 255, 0], 3), `rgb(${await px(960, 540)})`);
check('the selection box and handles show on the picture', (await page.locator('.annotation-box .ann-handle').count()) === 9);

// ---- Move by dragging in the preview.
const left0 = await num('#f-left');
await dragCanvas([960, 540], [1060, 540]);
const left1 = await num('#f-left');
check('dragging the rectangle moves it', Math.abs(left1 - left0 - 100) <= 3, `${left0} -> ${left1}`);
check('picture follows: old left edge clear, new right edge filled', near(await px(780, 540), base1.left, 2) && near(await px(1230, 540), [0, 255, 0], 3));

// ---- Resize with the east handle.
const w0 = await num('#f-box-width');
await dragHandle('e', 100, 0);
const w1 = await num('#f-box-width');
check('the east handle widens the box', Math.abs(w1 - w0 - 100) <= 3, `${w0} -> ${w1}`);
await clickKeyTarget();
await page.keyboard.press('Control+z');
await settle();
check('one resize drag is one undo step', Math.abs((await num('#f-box-width')) - w0) <= 1);
await page.keyboard.press('Control+Shift+z');
await settle();
check('redo brings the resize back', Math.abs((await num('#f-box-width')) - w1) <= 1);

// ---- Rotate.
const centre = { x: left1 + w1 / 2, y: 540 };
const rot = await handleCentre('rotate');
const target = await toPage(centre.x + 300, centre.y);
await page.mouse.move(rot.x, rot.y);
await page.mouse.down();
await page.mouse.move((rot.x + target.x) / 2, (rot.y + target.y) / 2, { steps: 5 });
await page.mouse.move(target.x, target.y, { steps: 5 });
await page.mouse.up();
await settle();
check('the rotate handle turns the box (snaps to 90)', (await num('#f-rotation')) === 90, String(await num('#f-rotation')));
check('rotated, the rectangle reaches above its old top edge', near(await px(Math.round(centre.x), 330), [0, 255, 0], 3), `rgb(${await px(Math.round(centre.x), 330)})`);

// ---- Delete key, undo.
await page.keyboard.press('Delete');
await settle();
check('Delete removes the annotation', near(await px(1110, 540), base1.mid, 2) && (await countAnnotations()) === 0);
await page.keyboard.press('Control+z');
await settle();
check('undo brings the annotation back', (await countAnnotations()) === 1 && near(await px(Math.round(centre.x), 540), [0, 255, 0], 3));
await clickCanvas(centre.x, 540);
await page.keyboard.press('Delete');
await settle();
check('deleted again', (await countAnnotations()) === 0);

// ---- Spotlight: dims everything outside.
await addKind('Spotlight');
await settle();
const dim = await px(300, 500);
check('spotlight darkens the outside', dim[2] < base1.corner[2] * 0.45 && dim[2] > base1.corner[2] * 0.25, `${base1.corner} -> ${dim}`);
check('spotlight leaves the lit centre clear', near(await px(960, 540), base1.centre, 3), `rgb(${await px(960, 540)})`);
await page.screenshot({ path: `${out}/annotations-spotlight.png` });
await page.keyboard.press('Delete');
await settle();
check('spotlight removed, outside is back to normal', near(await px(300, 500), base1.corner, 2));

// ---- Highlight blends yellow over the picture.
await addKind('Highlight');
const hl = await px(960, 540);
const want = base1.centre.map((v, i) => v * 0.65 + [255, 225, 74][i] * 0.35);
check('highlight tints the picture translucently', near(hl, want, 6), `rgb(${hl}) want ~${want.map(Math.round)}`);
await page.keyboard.press('Delete');
await settle();

// ---- Ellipse, line, text and blur regions.
await seek(1);
await addKind('Ellipse');
await page.getByLabel('No fill colour').click();
await page.locator('#ann-fill').fill('#0000ff');
await page.waitForTimeout(900);
await settle();
check('ellipse fill is drawn at its centre, not in its corners', near(await px(960, 540), [0, 0, 255], 3));
const ellCorner = await px(765, 415); // inside the 420x260 box, outside the ellipse
check('the ellipse leaves the box corners alone', !near(ellCorner, [0, 0, 255], 20), `rgb(${ellCorner})`);
await clickCanvas(960, 540);
await page.keyboard.press('Delete');
await settle();
await addKind('Line');
const lineAt = await px(960, 540);
check('a line is drawn through the middle of its box', lineAt[0] > 200 && lineAt[1] < 120, `rgb(${lineAt})`);
await page.keyboard.press('Delete');
await settle();
await addKind('Text');
await page.locator('#ann-text').fill('Hello');
await page.locator('#ann-colour').fill('#ff0000');
await page.waitForTimeout(900);
await settle();
const textReds = await page.evaluate(() => {
  const c = document.querySelector('.preview-canvas');
  const d = c.getContext('2d').getImageData(640, 480, 640, 120).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++;
  return n;
});
check('text is drawn in the chosen colour', textReds > 300, `${textReds} red px`);
await page.getByRole('button', { name: 'Fit height to text' }).click();
await settle();
check('fit height shrinks the box to one line of text', (await num('#f-box-height')) < 120, String(await num('#f-box-height')));
await page.keyboard.press('Delete');
await settle();
check('the text annotation is gone', (await countAnnotations()) === 0 && near(await px(960, 540), base1.centre, 2));
await page.getByRole('button', { name: 'Blur region', exact: true }).click();
await settle();
check('Blur region adds a blur region and selects it', (await page.locator('.region-box').count()) === 1 && (await countAnnotations()) === 0);
await page.keyboard.press('Delete');
await settle();

// ---- Arrow with sketch motion.
await seek(1);
await addKind('Arrow');
await page.locator('#f-draw-on-over').fill('2');
await page.locator('#f-draw-on-over').press('Enter');
await settle();
check('at its start a drawing-on arrow shows nothing yet', near(await px(816, 620), base1.armStart, 2));
await seek(2);
const early = await px(816, 620);
const late = await px(1104, 460);
check('half-way through, the near end is drawn', early[0] > 200 && early[1] < 120, `rgb(${early})`);
check('half-way through, the far end is not drawn yet', near(late, base1.armEnd, 2), `rgb(${late})`);
await page.screenshot({ path: `${out}/annotations-sketch-mid.png` });
await seek(4);
const done = await px(1104, 460);
check('after the draw-on time the whole arrow is there', done[0] > 200 && done[1] < 120, `rgb(${done})`);
await clickCanvas(960, 540); // on the arrow's shaft
await page.keyboard.press('Delete');
await settle();
check('the arrow is removed by clicking it and pressing Delete', (await countAnnotations()) === 0);

// ---- Callout: text, tail.
await seek(1);
await addKind('Callout');
await page.locator('#ann-text').fill('Look here');
await page.waitForTimeout(900);
await settle();
const cream = await px(745, 480);
check('callout body is filled', near(cream, [255, 247, 204], 3), `rgb(${cream})`);
check('callout tail is drawn below the box', near(await px(831, 640), [255, 247, 204], 3), `rgb(${await px(831, 640)})`);
const darkCount = () =>
  page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(760, 490, 400, 100).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 100) n++;
    return n;
  });
const sans = await darkCount();
check('callout text is drawn', sans > 80, `${sans} dark px`);
await page.getByRole('button', { name: 'Bold', exact: true }).click();
await settle();
const bold = await darkCount();
check('bold changes the text rendering', bold !== sans && bold > sans, `${sans} -> ${bold}`);
await page.locator('#ann-font').selectOption('mono');
await settle();
const mono = await darkCount();
check('font choice changes the text rendering', mono !== bold && mono > 80, `${bold} -> ${mono}`);
await page.locator('#ann-colour').fill('#ff0000');
await page.waitForTimeout(900);
await settle();
const reds = await page.evaluate(() => {
  const c = document.querySelector('.preview-canvas');
  const d = c.getContext('2d').getImageData(760, 490, 400, 100).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++;
  return n;
});
check('text colour applies', reds > 80, `${reds} red px`);
await page.screenshot({ path: `${out}/annotations-callout.png` });
await dragHandle('tail', 429, -150); // tip (831, 690) -> (1260, 540)
const oldTail = await px(831, 640);
const newTail = await px(1220, 540);
check('callout tail moved to the right side', near(newTail, [255, 247, 204], 3) && !near(oldTail, [255, 247, 204], 3), `old rgb(${oldTail}) new rgb(${newTail})`);

// ---- Timeline lane: drag the block to move the callout in time.
const startBefore = await num('#f-start');
const item = page.locator('.overlay-lane .overlay-item.kind-annotations.selected');
const ib = await item.boundingBox();
await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2);
await page.mouse.down();
await page.mouse.move(ib.x + ib.width / 2 + 30, ib.y + ib.height / 2, { steps: 4 });
await page.mouse.move(ib.x + ib.width / 2 + 60, ib.y + ib.height / 2, { steps: 4 });
await page.mouse.up();
await settle();
const startAfter = await num('#f-start');
check('dragging the lane block moves the annotation in time', startAfter > startBefore + 0.7, `${startBefore} -> ${startAfter}`);
await seek(1);
check('so it is gone from the old moment', !near(await px(745, 480), [255, 247, 204], 6));
await seek(3);
check('and shows at the new one', near(await px(745, 480), [255, 247, 204], 3));

// ---- Persistence.
await page.waitForTimeout(800);
await page.reload();
await page.waitForSelector('.media-bin, .welcome');
if (await page.locator('.welcome').isVisible().catch(() => false)) await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.clip');
await seek(3);
check('annotations survive a reload', near(await px(745, 480), [255, 247, 204], 3) && (await countAnnotations()) === 1);

check('no page errors in the editor', errors.length === 0, errors.join(' | ').slice(0, 400));

// ---- Export path: OffscreenCanvas draw in a harness page, then a tiny real export.
execFileSync('bun', ['build', 'tests/e2e/annotations-harness.ts', '--outdir', 'tests/e2e/.build', '--target', 'browser'], { stdio: 'inherit' });
const hp = await browser.newPage();
const herrors = [];
hp.on('pageerror', (e) => herrors.push(e.message));
hp.on('console', (m) => m.type() === 'error' && herrors.push(m.text()));
await hp.route('**/harness.js', (route) => route.fulfill({ path: 'tests/e2e/.build/annotations-harness.js', contentType: 'application/javascript' }));
await hp.goto(`${base}/harness`);
await hp.waitForFunction(() => document.title === 'harness-ready');
const r0 = await hp.evaluate(() => window.annRender(0));
check('OffscreenCanvas draw: rectangle fill', near(r0.off[0], [0, 255, 0], 2), `rgb(${r0.off[0]})`);
check('OffscreenCanvas draw: highlight blend over white', near(r0.off[1], [255, 244, 192], 4), `rgb(${r0.off[1]})`);
check('OffscreenCanvas draw: outside untouched', near(r0.off[2], [255, 255, 255], 1));
check('OffscreenCanvas matches the on-screen canvas', r0.off.every((p, i) => near(p, r0.dom[i], 2)));
const r3 = await hp.evaluate(() => window.annRender(3));
check('OffscreenCanvas draw: spotlight dims outside (also the rectangle)', near(r3.off[2], [89, 89, 89], 4) && near(r3.off[0], [0, 89, 0], 4), `outside rgb(${r3.off[2]}) rect rgb(${r3.off[0]})`);
check('OffscreenCanvas draw: spotlight keeps its box lit', near(r3.off[3], [255, 255, 255], 2));
check('spotlight draws the same on both surfaces', r3.off.every((p, i) => near(p, r3.dom[i], 3)));
const r5 = await hp.evaluate(() => window.annRender(5));
check('OffscreenCanvas draw: half-drawn arrow reaches its middle only', r5.off[4][0] > r5.off[4][1] + 40 && Math.abs(r5.off[5][0] - r5.off[5][1]) < 10, `start rgb(${r5.off[4]}) end rgb(${r5.off[5]})`);

const exp = await hp.evaluate(() => window.annExport());
writeFileSync(`${out}/annotations-export.mp4`, Buffer.from(exp.base64, 'base64'));
const rgb = (x, y, t) =>
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', `${out}/annotations-export.mp4`, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
const inside = rgb(58, 88, 0.3);
const outside = rgb(250, 88, 0.3);
check('exported MP4 contains the annotation', inside[0] > 200 && inside[1] < 70 && inside[2] < 70, `rgb(${inside[0]},${inside[1]},${inside[2]})`);
check('exported MP4 shows the card elsewhere', !(outside[0] > 200 && outside[1] < 70 && outside[2] < 70), `rgb(${outside[0]},${outside[1]},${outside[2]})`);
check('no page errors in the harness', herrors.length === 0, herrors.join(' | ').slice(0, 300));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll annotation checks passed');
process.exit(failures ? 1 : 0);
