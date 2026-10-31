// Clip editing through the real UI: copy/paste, multi-clip drag, grouping, magnetic tracks and gaps,
// speed and freeze frame (checked on the picture), crop by dragging handles (checked on the picture),
// detach audio, shortcuts and undo. Uses the synthetic fixtures only.
// Usage: node tests/e2e/clip-editing.e2e.mjs   (or via run-all.mjs clip-editing)
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
const errors = [];
const PX = 60; // timeline pixels per second at the default zoom
const LANE_CLIPS = '.lane:not(.overlay-lane) .clip';

/** A new browser context with clip.webm imported and placed at 0 s: one 3 s clip. */
async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + '/');
  await page.getByRole('button', { name: 'Go to the editor' }).click();
  await page.waitForSelector('.media-bin');
  await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm']);
  await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
  await page.locator('.bin-item').dblclick();
  await page.waitForSelector(LANE_CLIPS);
  await page.waitForTimeout(300);
  return page;
}

/** Every clip in the lanes: seconds from the timeline origin, width in seconds, lane index, class, label. */
async function clips(page) {
  return page.evaluate(
    ([sel, px]) => {
      const lanes = [...document.querySelectorAll('.lane:not(.overlay-lane)')];
      const origin = lanes[0].getBoundingClientRect().left;
      return [...document.querySelectorAll(sel)]
        .map((el, index) => {
          const r = el.getBoundingClientRect();
          const lane = lanes.findIndex((l) => l.contains(el));
          return { index, start: (r.left - origin) / px, len: r.width / px, lane, cls: el.className, label: el.getAttribute('aria-label') ?? '', selected: el.classList.contains('selected') };
        })
        .sort((a, b) => a.lane - b.lane || a.start - b.start);
    },
    [LANE_CLIPS, PX],
  );
}

const near = (a, b, tol = 0.06) => Math.abs(a - b) <= tol;
const seek = async (page, t) => {
  await page.locator('.ruler').click({ position: { x: Math.max(1, t * PX), y: 10 } });
  await page.waitForTimeout(500);
};
const clipAt = async (page, start, lane) => {
  const list = await clips(page);
  const hit = list.find((c) => near(c.start, start, 0.1) && (lane === undefined || c.lane === lane));
  if (!hit) throw new Error(`no clip at ${start}s: ${JSON.stringify(list.map((c) => [c.start, c.len, c.lane]))}`);
  return page.locator(LANE_CLIPS).nth(hit.index);
};
/** Drags the bin's clip onto the first clip's lane at `at` seconds. */
async function dropSecond(page, at) {
  const lane = (await clips(page))[0].lane;
  await page.locator('.bin-item').dragTo(page.locator('.lane').nth(lane), { targetPosition: { x: at * PX, y: 29 } });
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, LANE_CLIPS);
}
const selectedCount = async (page) => (await page.locator(`${LANE_CLIPS}.selected`).count());
const ctrl = (page, key) => page.keyboard.press(`Control+${key}`);

/** A coarse picture of the preview canvas: a 20x12 grid of RGB samples. */
async function grab(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.preview-canvas');
    const ctx = c.getContext('2d');
    const out = [];
    for (let j = 0; j < 12; j++) for (let i = 0; i < 20; i++) out.push(...ctx.getImageData(Math.floor(((i + 0.5) * c.width) / 20), Math.floor(((j + 0.5) * c.height) / 12), 1, 1).data.slice(0, 3));
    return out;
  });
}
const dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
const pixel = (page, fx, fy) =>
  page.evaluate(([x, y]) => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [fx, fy]);
const isBlue = ([r, g, b]) => b > 200 && r < 70 && g < 70;
const isRed = ([r, g, b]) => r > 200 && g < 70 && b < 70;
const isMagenta = ([r, g, b]) => r > 200 && b > 200 && g < 70;
const isCyan = ([r, g, b]) => g > 200 && b > 200 && r < 70;
const isBlack = ([r, g, b]) => r + g + b < 30;

// ============================================================================================
// A. Speed and freeze frame
// ============================================================================================
{
  const page = await fresh();
  const clip = await clipAt(page, 0);
  await clip.click({ position: { x: 20, y: 10 } });
  await page.waitForSelector('#clip-speed-slider');
  check('the inspector shows a speed control with presets', (await page.locator('.speed-preset').count()) === 6);

  await seek(page, 1.5);
  const at15 = await grab(page);
  await seek(page, 0.75);
  const at075 = await grab(page);
  check('the picture differs between 0.75 s and 1.5 s at normal speed', dist(at15, at075) > 3, dist(at15, at075).toFixed(1));

  await clip.click({ position: { x: 20, y: 10 } }); // the ruler click deselected it
  await page.getByRole('button', { name: '2×', exact: true }).click();
  await page.waitForTimeout(200);
  let list = await clips(page);
  check('2x speed halves the clip on the timeline', near(list[0].len, 1.5), `${list[0].len.toFixed(2)} s`);
  check('the clip shows a speed badge', (await page.locator('.clip-badge-speed').count()) === 1);
  check('the inspector shows the resulting length', /Length 0:00:01;15/.test(await page.locator('.speed-result').innerText()), await page.locator('.speed-result').innerText());
  await seek(page, 0.75);
  const fast075 = await grab(page);
  check('at 2x the picture at 0.75 s is the normal-speed picture from 1.5 s', dist(fast075, at15) < dist(fast075, at075) / 2 && dist(fast075, at15) < 6, `to 1.5s: ${dist(fast075, at15).toFixed(1)}, to 0.75s: ${dist(fast075, at075).toFixed(1)}`);

  await clip.click({ position: { x: 20, y: 10 } });
  await page.locator('#clip-speed-slider').focus();
  await page.keyboard.press('Home'); // slider to 0.1x
  await page.waitForTimeout(200);
  list = await clips(page);
  check('the slider reaches 0.1x (a 30 s clip)', near(list[0].len, 30, 0.5), `${list[0].len.toFixed(1)} s`);
  await ctrl(page, 'z');
  await page.getByRole('button', { name: '1×', exact: true }).click();
  list = await clips(page);
  check('1x puts the clip back to 3 s', near(list[0].len, 3));
  check('the speed badge goes away', (await page.locator('.clip-badge-speed').count()) === 0);

  // Freeze frame at 1 s for 2 s.
  await seek(page, 1);
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  await page.locator('#hold-seconds').fill('2');
  await page.getByRole('button', { name: 'Freeze frame' }).click();
  await page.waitForTimeout(300);
  list = await clips(page);
  check('freeze frame splits the clip and adds a hold', list.length === 3, JSON.stringify(list.map((c) => [c.start.toFixed(2), c.len.toFixed(2)])));
  const hold = list.find((c) => c.cls.includes('freeze'));
  check('the hold is 2 s long and sits at the playhead', !!hold && near(hold.len, 2) && near(hold.start, 1));
  check('the rest of the clip moved later by the hold', near(list[2].start, 3) && near(list[2].len, 2));
  await seek(page, 1.3);
  const h1 = await grab(page);
  await seek(page, 2.7);
  const h2 = await grab(page);
  check('the picture does not move during the hold', dist(h1, h2) < 2, dist(h1, h2).toFixed(1));
  await seek(page, 3.2);
  const after = await grab(page);
  await seek(page, 3.9);
  const after2 = await grab(page);
  check('the clip after the hold plays on', dist(after, after2) > 1, dist(after, after2).toFixed(1));
  await ctrl(page, 'z');
  check('undo removes the freeze', (await clips(page)).length === 1);

  // Extend frame: a hold after the clip's end.
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  await page.getByRole('button', { name: 'Extend frame' }).click();
  await page.waitForTimeout(200);
  list = await clips(page);
  check('extend frame adds a 2 s hold after the clip', list.length === 2 && list[1].cls.includes('freeze') && near(list[1].start, 3) && near(list[1].len, 2));
  await page.screenshot({ path: `${out}/clip-editing-speed.png` });
  await page.context().close();
}

// ============================================================================================
// B. Detach audio
// ============================================================================================
{
  const page = await fresh();
  await seek(page, 1);
  const beforePicture = await grab(page);
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  const detach = page.getByRole('button', { name: 'Detach audio' });
  check('Detach audio is offered for a video with sound', await detach.isEnabled());
  await detach.click();
  await page.waitForTimeout(300);
  let list = await clips(page);
  check('detaching audio creates a second clip', list.length === 2);
  const audio = list.find((c) => c.cls.includes('audio-only'));
  const picture = list.find((c) => !c.cls.includes('audio-only'));
  check('the new clip is an audio-only clip on another track', !!audio && audio.lane !== picture.lane && near(audio.start, 0) && near(audio.len, 3));
  check('the picture clip is marked as detached', /audio detached/.test(picture.label), picture.label);
  check('the picture still shows after detaching', dist(beforePicture, await grab(page)) < 3);

  // Linked clips move together.
  const pictureEl = page.locator(LANE_CLIPS).nth(picture.index);
  const pb = await pictureEl.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width / 2 + 60, pb.y + pb.height / 2, { steps: 6 });
  await page.mouse.move(pb.x + pb.width / 2 + 120, pb.y + pb.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  const a2 = list.find((c) => c.cls.includes('audio-only'));
  const p2 = list.find((c) => !c.cls.includes('audio-only'));
  check('dragging the picture drags the linked audio with it', near(a2.start, p2.start, 0.03) && p2.start > 1.5, `${p2.start.toFixed(2)} / ${a2.start.toFixed(2)}`);
  await ctrl(page, 'z');
  list = await clips(page);
  check('undo puts both back', list.every((c) => near(c.start, 0)));

  // Trim and split carry the link.
  const pe = page.locator(LANE_CLIPS).nth((await clips(page)).find((c) => !c.cls.includes('audio-only')).index);
  const eb = await pe.boundingBox();
  await page.mouse.move(eb.x + eb.width - 2, eb.y + eb.height / 2);
  await page.mouse.down();
  await page.mouse.move(eb.x + eb.width - 62, eb.y + eb.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  check('trimming one trims the other', list.every((c) => near(c.len, 2, 0.1)), list.map((c) => c.len.toFixed(2)).join(' '));
  await seek(page, 1);
  await page.keyboard.press('s');
  list = await clips(page);
  check('splitting splits both', list.length === 4, String(list.length));
  await ctrl(page, 'z');
  await ctrl(page, 'z');

  // Unlink, then drop the picture: the audio-only clip draws nothing.
  await page.locator(LANE_CLIPS).nth((await clips(page)).find((c) => !c.cls.includes('audio-only')).index).click({ position: { x: 20, y: 10 } });
  await page.getByRole('button', { name: 'Unlink' }).click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  list = await clips(page);
  check('after unlinking, deleting the picture leaves the audio clip', list.length === 1 && list[0].cls.includes('audio-only'));
  await seek(page, 1);
  check('an audio-only clip draws no picture', isBlack(await pixel(page, 0.5, 0.5)) && isBlack(await pixel(page, 0.1, 0.9)));
  await page.screenshot({ path: `${out}/clip-editing-detach.png` });
  await page.context().close();
}

// ============================================================================================
// C. Crop
// ============================================================================================
{
  const page = await fresh();
  await seek(page, 0.5);
  check('uncropped, the left of the picture is red', isRed(await pixel(page, 0.05, 0.9)));
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await page.waitForSelector('.crop-overlay .crop-handle-nw');
  check('crop mode draws a crop frame with eight handles', (await page.locator('.crop-handle').count()) === 8);
  const box = await page.locator('.crop-overlay').boundingBox();
  const nw = await page.locator('.crop-handle-nw').boundingBox();
  await page.mouse.move(nw.x + nw.width / 2, nw.y + nw.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 6 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const left = Number(await page.locator('#f-crop-left').inputValue());
  const top = Number(await page.locator('#f-crop-top').inputValue());
  const width = Number(await page.locator('#f-crop-width').inputValue());
  check('dragging the corner handle crops the top-left quarter away', near(left, 50, 3) && near(top, 50, 3) && near(width, 50, 3), `${left}/${top}/${width}`);
  check('while cropping the whole frame stays visible', isRed(await pixel(page, 0.05, 0.9)));
  await page.screenshot({ path: `${out}/clip-editing-crop-mode.png` });
  await page.getByRole('button', { name: 'Done cropping' }).click();
  await page.waitForTimeout(400);
  check('cropped, the left edge now shows what was in the middle (blue)', isBlue(await pixel(page, 0.05, 0.9)), String(await pixel(page, 0.05, 0.9)));
  check('the centre of the cropped picture is magenta', isMagenta(await pixel(page, 0.5, 0.9)));
  check('the right edge is cyan', isCyan(await pixel(page, 0.95, 0.9)));
  const corners = [await pixel(page, 0.01, 0.02), await pixel(page, 0.99, 0.02), await pixel(page, 0.01, 0.98), await pixel(page, 0.99, 0.98)];
  check('the cropped area fills the whole canvas (no bars)', corners.every((p) => !isBlack(p)), JSON.stringify(corners));
  check('the clip shows a crop badge', (await page.locator('.clip-badge-crop').count()) === 1);
  await page.screenshot({ path: `${out}/clip-editing-cropped.png` });

  // Edge handle with a locked 1:1 shape, then numbers.
  await page.getByRole('button', { name: 'Reset crop' }).click();
  await page.waitForTimeout(300);
  check('Reset crop restores the full picture', isRed(await pixel(page, 0.05, 0.9)));
  await ctrl(page, 'z');
  await page.waitForTimeout(300);
  check('undo brings the crop back', isBlue(await pixel(page, 0.05, 0.9)));
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  await page.locator('#crop-aspect').selectOption({ label: '1:1' });
  await page.waitForTimeout(200);
  const w = Number(await page.locator('#f-crop-width').inputValue());
  const h = Number(await page.locator('#f-crop-height').inputValue());
  check('the 1:1 preset makes a square crop (in source pixels)', near((w * 640) / (h * 360), 1, 0.05), `${w}% x ${h}%`);
  await page.locator('#f-crop-left').fill('10');
  await page.locator('#f-crop-left').press('Enter');
  check('the crop fields edit the crop', Number(await page.locator('#f-crop-left').inputValue()) === 10);
  await page.context().close();
}

// ============================================================================================
// D. Clipboard, multi-clip drag, grouping, shortcuts
// ============================================================================================
{
  const page = await fresh();
  await dropSecond(page, 4);
  let list = await clips(page);
  check('two clips on the top track at 0 s and 4 s', list.length === 2 && list[0].lane === list[1].lane && near(list[1].start, 4));
  const lane = list[0].lane;

  // Copy both, paste at the end of the timeline (the playhead cannot go past it): offsets are kept.
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  await (await clipAt(page, 4)).click({ position: { x: 20, y: 10 }, modifiers: ['Shift'] });
  check('shift-click selects both clips', (await selectedCount(page)) === 2);
  check('several clips show the multi-selection panel', await page.isVisible('text=2 clips selected'));
  await ctrl(page, 'c');
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  await ctrl(page, 'v');
  await page.waitForTimeout(250);
  list = await clips(page);
  check('Ctrl+V pastes both clips', list.length === 4);
  check('the pasted clips start at the playhead and keep their offset', near(list[2].start, 7.008) && near(list[3].start - list[2].start, 4, 0.03) && list[2].lane === lane, list.map((c) => c.start.toFixed(1)).join(' '));
  check('the pasted clips are selected', (await selectedCount(page)) === 2);
  await ctrl(page, 'z');
  check('undo removes the paste', (await clips(page)).length === 2);
  await ctrl(page, 'y');
  check('redo brings it back', (await clips(page)).length === 4);

  // Multi-clip drag: both move 2 s.
  const P = list[2].start;
  const pasted = await clipAt(page, P);
  const pb = await pasted.boundingBox();
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width / 2 + 60, pb.y + pb.height / 2, { steps: 6 });
  await page.mouse.move(pb.x + pb.width / 2 + 120, pb.y + pb.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  const d1 = list[2].start - P;
  const d2 = list[3].start - (P + 4);
  check('dragging one selected clip moves the whole selection', d1 > 1.7 && d1 < 2.3 && near(d1, d2, 0.02), `${d1.toFixed(2)} / ${d2.toFixed(2)}`);
  check('the originals did not move', near(list[0].start, 0) && near(list[1].start, 4));
  await ctrl(page, 'z');

  // Dropping the block on a clip: all-or-nothing, it slides to a free spot together.
  const ps = await clipAt(page, P);
  const sb = await ps.boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 - 100, sb.y + sb.height / 2, { steps: 6 });
  await page.mouse.move(sb.x + sb.width / 2 - 200, sb.y + sb.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  const moved = list.filter((c) => !near(c.start, 0) && !near(c.start, 4));
  const gapKept = moved[1].start - moved[0].start;
  check('a block dragged onto other clips never overlaps and keeps its offset', moved.length === 2 && near(gapKept, 4, 0.02) && list.every((c, i) => i === 0 || c.lane !== list[i - 1].lane || c.start >= list[i - 1].start + list[i - 1].len - 0.03));
  if (!near(moved[0].start, P, 0.05)) await ctrl(page, 'z'); // nothing to undo when it stayed put

  // Group.
  await page.keyboard.press('g');
  check('G groups the selection', /Grouped/.test(await page.locator('.statusbar .message').innerText()));
  check('the clips show a group badge', (await page.locator('.clip-badge-group').count()) === 2);
  await page.keyboard.press('Escape');
  check('Escape clears the selection', (await selectedCount(page)) === 0);
  await (await clipAt(page, P)).click({ position: { x: 20, y: 10 } });
  check('clicking one grouped clip selects the whole group', (await selectedCount(page)) === 2);
  const g1 = await (await clipAt(page, P + 4)).boundingBox();
  await page.mouse.move(g1.x + g1.width / 2, g1.y + g1.height / 2);
  await page.mouse.down();
  await page.mouse.move(g1.x + g1.width / 2 + 60, g1.y + g1.height / 2, { steps: 6 });
  await page.mouse.move(g1.x + g1.width / 2 + 120, g1.y + g1.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  check('dragging the second clip of a group moves the group', near(list[2].start, P + 2, 0.2) && near(list[3].start, P + 6, 0.2), `${list[2].start.toFixed(2)} / ${list[3].start.toFixed(2)}`);
  await page.keyboard.press('Delete');
  check('Delete removes the whole group', (await clips(page)).length === 2);
  await ctrl(page, 'z');
  check('undo restores it', (await clips(page)).length === 4);
  await (await clipAt(page, list[2].start)).click({ position: { x: 20, y: 10 } });
  await page.keyboard.press('Shift+G');
  await page.keyboard.press('Escape');
  await (await clipAt(page, list[2].start)).click({ position: { x: 20, y: 10 } });
  check('Shift+G ungroups: one click selects one clip', (await selectedCount(page)) === 1);

  // Cut, duplicate.
  await ctrl(page, 'x');
  check('Ctrl+X cuts the clip', (await clips(page)).length === 3);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  await ctrl(page, 'v');
  list = await clips(page);
  const end = Math.max(...list.map((c) => c.start + c.len)) - 3.008;
  check('and Ctrl+V pastes it at the playhead', list.length === 4 && list.some((c) => near(c.start, end, 0.1)), list.map((c) => c.start.toFixed(1)).join(' '));
  await ctrl(page, 'd');
  list = await clips(page);
  check('Ctrl+D duplicates the clip right after it', list.length === 5 && list.some((c) => near(c.start, end + 3.008, 0.1)));
  await page.keyboard.press('?');
  await page.waitForSelector('.shortcuts');
  const keys = await page.locator('.shortcuts').innerText();
  check('the shortcut list mentions copy, duplicate and group', /Copy, cut or paste/.test(keys) && /Duplicate/.test(keys) && /Group or ungroup/.test(keys));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${out}/clip-editing-clipboard.png` });
  await page.context().close();
}

// ============================================================================================
// E. Gaps and magnetic tracks
// ============================================================================================
{
  const page = await fresh();
  await dropSecond(page, 4);
  let list = await clips(page);
  const lane = list[0].lane;
  await page.locator('.lane').nth(lane).hover({ position: { x: 3.5 * PX, y: 25 } });
  const gapButton = page.getByRole('button', { name: /Close gap of/ });
  check('a gap in a lane offers a close-gap button', (await gapButton.count()) === 1);
  await gapButton.click();
  list = await clips(page);
  check('clicking it closes the gap', near(list[1].start, 3), list[1].start.toFixed(2));
  await ctrl(page, 'z');
  check('undo reopens it', near((await clips(page))[1].start, 4));

  const header = page.locator('.track-header:not(.overlay-header)').nth(lane);
  await header.getByRole('button', { name: 'Close gaps' }).click();
  check('the Close gaps button closes every gap on the track', near((await clips(page))[1].start, 3));
  await ctrl(page, 'z');

  await header.getByRole('button', { name: 'Magnetic track' }).click();
  check('making a track magnetic closes its gaps', near((await clips(page))[1].start, 3));
  check('the magnetic toggle is pressed', (await header.getByRole('button', { name: 'Magnetic track' }).getAttribute('aria-pressed')) === 'true');

  // Trimming the first clip pulls the next one in.
  const first = await clipAt(page, 0);
  const fb = await first.boundingBox();
  await page.mouse.move(fb.x + fb.width - 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width - 62, fb.y + fb.height / 2, { steps: 6 });
  await page.mouse.up();
  list = await clips(page);
  check('trimming on a magnetic track closes the gap', near(list[0].len, 2, 0.1) && near(list[1].start, 2, 0.1), `${list[0].len.toFixed(2)} / ${list[1].start.toFixed(2)}`);
  await ctrl(page, 'z');
  check('undo restores the trim', near((await clips(page))[0].len, 3, 0.1));

  // Deleting the first clip pulls the second to zero.
  await (await clipAt(page, 0)).click({ position: { x: 20, y: 10 } });
  await page.keyboard.press('Delete');
  list = await clips(page);
  check('deleting on a magnetic track closes up', list.length === 1 && near(list[0].start, 0), list[0]?.start.toFixed(2));
  await page.screenshot({ path: `${out}/clip-editing-magnetic.png` });
  await ctrl(page, 'z');
  await header.getByRole('button', { name: 'Magnetic track' }).click();
  check('turning magnetic off leaves clips where they are', near((await clips(page))[1].start, 3));
  await page.context().close();
}

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll clip-editing checks passed');
process.exit(failures ? 1 : 0);
