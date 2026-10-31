// Visual effects, in headless Chromium with pixel checks.
//   Part A: the effect pipeline on synthetic layers (WebGL2 shader vs the pure CPU reference, the CPU
//           fallback, an off-screen canvas as export uses, rounded corners, shadow, blend, device frames).
//   Part B: the real UI (Inspector + Effects tab) and the preview canvas pixels.
//   Part C: one tiny exported frame decoded with ffmpeg contains the effect.
// Usage: node tests/e2e/visual-effects.e2e.mjs   (CAPSTAN_URL, or via run-all.mjs; needs ffmpeg on PATH)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// The harness bundle: bun build tests/e2e/fx-harness.ts --outdir tests/e2e/.build --target browser
const build = spawnSync('bun', ['build', 'tests/e2e/fx-harness.ts', '--outdir', 'tests/e2e/.build', '--target', 'browser'], { encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(1);
}

// SwiftShader gives headless Chromium a software WebGL2, so the shader path runs on any machine.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

// ---------------------------------------------------------------- Part A: pipeline
await page.goto(base + '/');
await page.addScriptTag({ path: 'tests/e2e/.build/fx-harness.js', type: 'module' });
await page.waitForFunction(() => !!window.fxh);

const W = 200, H = 120, CW = 320, CH = 200;
const OX = (CW - W) / 2, OY = (CH - H) / 2;
const render = (effects, extra = {}) => page.evaluate((o) => window.fxh.render(o), { effects, w: W, h: H, width: CW, height: CH, background: '#ff0000', ...extra });
const px = (r, x, y) => {
  const i = (y * CW + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
};
const SRC_GREEN = [OX + 20, OY + 60]; // inside the green backdrop
const SRC_BLUE = [OX + 100, OY + 45]; // inside the blue box (35%..65% x, 25%..65% y)

const plain = await render({ blend: 'normal' });
check('WebGL2 is available in the test browser', (await page.evaluate(() => window.fxh.backend())) === 'webgl2', 'shader path under test');
const g0 = px(plain, ...SRC_GREEN);
check('without effects the source is untouched', near(g0, [0, 255, 0, 255], 1), String(g0));

// Colour: shader output equals the CPU reference on every pixel.
const colourFx = { colour: { brightness: 20, contrast: 15, saturation: -30, hue: 40, tint: '#d9a441', tintAmount: 25 } };
const gl = await render(colourFx);
const cpu = await render(colourFx, { cpu: true });
const ref = await page.evaluate((fx) => window.fxh.reference(200, 120, fx), colourFx);
let maxGl = 0, maxCpu = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = px(gl, x + OX, y + OY), c = px(cpu, x + OX, y + OY);
    for (let k = 0; k < 3; k++) {
      const r = ref[(y * W + x) * 4 + k];
      maxGl = Math.max(maxGl, Math.abs(a[k] - r));
      maxCpu = Math.max(maxCpu, Math.abs(c[k] - r));
    }
  }
}
check('colour matrix: WebGL2 shader matches the reference (max 3 levels)', maxGl <= 3, `max diff ${maxGl}`);
check('colour matrix: CPU fallback matches the reference (max 1 level)', maxCpu <= 1, `max diff ${maxCpu}`);
check('colour matrix changes the picture', !near(px(gl, ...SRC_BLUE), [0, 0, 255, 255], 20));

// Individual controls, against hand-computed values.
const bright = px(await render({ colour: { brightness: 40 } }), ...SRC_BLUE);
check('brightness +40 lifts blue (0,0,255) to about (51,51,255)', near(bright, [51, 51, 255, 255], 3), String(bright));
const grey = px(await render({ colour: { saturation: -100 } }), ...SRC_BLUE);
check('saturation -100 turns blue to its luma grey (about 18)', near(grey, [18, 18, 18, 255], 3) && Math.abs(grey[0] - grey[2]) <= 1, String(grey));
const hue = px(await render({ colour: { hue: 120 } }), ...SRC_GREEN);
check('hue +120 turns the green backdrop away from pure green', hue[1] < 250 && hue[0] + hue[2] > 30, String(hue));
const tinted = px(await render({ colour: { saturation: -100, tint: '#ff8000', tintAmount: 100 } }), OX + 100, OY + 100);
check('colourise paints a grey-ish area in the tint colour', tinted[0] > tinted[1] && tinted[1] > tinted[2], String(tinted));

// Chroma key.
const keyFx = { chroma: { key: '#00ff00', tolerance: 40, softness: 12, spill: 60 } };
const keyed = await render(keyFx);
check('green screen: the green backdrop shows the red background through', near(px(keyed, ...SRC_GREEN), [255, 0, 0, 255], 2), String(px(keyed, ...SRC_GREEN)));
check('green screen: the blue subject stays', near(px(keyed, ...SRC_BLUE), [0, 0, 255, 255], 2), String(px(keyed, ...SRC_BLUE)));
check('green screen: the red bar stays red', near(px(keyed, OX + 100, OY + 5), [255, 0, 0, 255], 2));
const keyedCpu = await render(keyFx, { cpu: true });
let keyDiff = 0, keyedTotal = 0;
for (let i = 0; i < keyed.data.length; i += 4) {
  for (let k = 0; k < 3; k++) keyDiff = Math.max(keyDiff, Math.abs(keyed.data[i + k] - keyedCpu.data[i + k]));
  keyedTotal++;
}
check('green screen: shader and CPU fallback agree on all pixels (max 4 levels)', keyDiff <= 4, `max diff ${keyDiff} over ${keyedTotal} px`);
const soft = px(await render({ chroma: { key: '#00ff00', tolerance: 0, softness: 0, spill: 0 } }), ...SRC_GREEN);
check('green screen: tolerance 0, softness 0 still removes the exact key colour', near(soft, [255, 0, 0, 255], 2), String(soft));
const wide = await render({ chroma: { key: '#00ff00', tolerance: 5, softness: 60, spill: 0 } });
const gradPx = px(wide, OX + 100, OY + 108); // bottom gradient strip (colours far from green)
check('green screen: colours far from the key are kept', !near(gradPx, [255, 0, 0, 255], 40), String(gradPx));

// Rounded corners, circle mask.
const rounded = await render({ radius: 30 });
check('rounded corners: the corner pixel is the background', near(px(rounded, OX + 1, OY + 1), [255, 0, 0, 255], 2), String(px(rounded, OX + 1, OY + 1)));
check('rounded corners: the middle of the edge is still picture', near(px(rounded, OX + 100, OY + 20), [0, 255, 0, 255], 2));
const circle = await render({ mask: 'circle' });
check('circle mask: the corner is the background, the centre is picture', near(px(circle, OX + 3, OY + 3), [255, 0, 0, 255], 2) && near(px(circle, ...SRC_BLUE), [0, 0, 255, 255], 2));
const edge = px(circle, OX + 100 - 59 + 40, OY + 5);
check('circle mask: the top of the box (outside the circle) is background', near(px(circle, OX + 100, OY + 1), [255, 0, 0, 255], 2), String(edge));

// Border.
const bordered = await render({ border: { width: 8, colour: '#ffffff' } });
check('border: edge pixels take the border colour, inside is picture', near(px(bordered, OX + 3, OY + 60), [255, 255, 255, 255], 2) && near(px(bordered, OX + 20, OY + 60), [0, 255, 0, 255], 2));

// Shadow: darkens the red background just outside the clip, away from where there is none.
const shadowed = await render({ shadow: { blur: 16, dx: 0, dy: 10, colour: '#000000', opacity: 70 } });
const below = px(shadowed, CW / 2, OY + H + 6);
const far = px(shadowed, 3, CH - 3);
check('shadow: the background just below the clip is darker', below[0] < 200 && below[0] > 0, String(below));
check('shadow: far from the clip the background is untouched', near(far, [255, 0, 0, 255], 1), String(far));
const shadowRound = px(await render({ shadow: { blur: 20, dx: 0, dy: 0, colour: '#000000', opacity: 100 }, radius: 40 }), OX + 3, OY + 3);
check('shadow follows rounded corners (corner pixel is lightly shadowed background, not picture)', shadowRound[1] < 40 && shadowRound[0] < 250 && shadowRound[0] > 120, String(shadowRound));

// Blend modes against the red background.
const mult = await render({ blend: 'multiply' });
check('multiply: green x red = black; the red bar stays red', near(px(mult, ...SRC_GREEN), [0, 0, 0, 255], 2) && near(px(mult, OX + 100, OY + 5), [255, 0, 0, 255], 2));
const scr = px(await render({ blend: 'screen' }), ...SRC_BLUE);
check('screen: blue over red = magenta (255,0,255)', near(scr, [255, 0, 255, 255], 2), String(scr));
const add = px(await render({ blend: 'add' }), ...SRC_GREEN);
check('add: green over red = yellow (255,255,0)', near(add, [255, 255, 0, 255], 2), String(add));
const diff = px(await render({ blend: 'difference' }), ...SRC_GREEN);
check('difference: green vs red = yellow (255,255,0)', near(diff, [255, 255, 0, 255], 2), String(diff));

// Device frames: each draws its device around a smaller picture, with the box corner left as background.
const frameShots = {};
for (const kind of ['browser', 'laptop', 'phone', 'tablet', 'monitor']) {
  const r = await render({ frame: { kind, tone: 'dark' } });
  frameShots[kind] = r;
  const centre = px(r, CW / 2, CH / 2);
  const changed = r.data.reduce((n, v, i) => n + (i % 4 === 0 && Math.abs(v - plain.data[i]) > 8 ? 1 : 0), 0);
  check(`frame ${kind}: draws device art and keeps the picture inside`, changed > 2500 && near(centre, [0, 0, 255, 255], 2), `centre ${centre}, ${changed} px changed`);
}
check('frame laptop: the base under the screen is metal, not the red background', (() => {
  const p = px(frameShots.laptop, CW / 2 + 60, OY + H - 4);
  return !near(p, [255, 0, 0, 255], 30);
})());
check('frame browser: the title bar above the picture is drawn', (() => {
  for (let y = 0; y < CH; y++) if (near(px(frameShots.browser, OX + 40, y).slice(0, 3), [34, 39, 48], 6)) return true;
  return false;
})());
check('frames differ from each other', new Set(Object.values(frameShots).map((r) => r.data.reduce((h, v) => (h * 31 + v) | 0, 7))).size === 5);
const lightFrame = await render({ frame: { kind: 'phone', tone: 'light' } });
check('frame tone light vs dark changes the bezel', JSON.stringify(px(lightFrame, CW / 2, CH / 2 - 54)) !== JSON.stringify(px(frameShots.phone, CW / 2, CH / 2 - 54)) || lightFrame.data.join() !== frameShots.phone.data.join());

// Off-screen canvas (what export draws on) gives the same picture.
const offFx = { chroma: keyFx.chroma, radius: 24, shadow: { blur: 10, dx: 0, dy: 6, colour: '#000000', opacity: 50 }, colour: { saturation: 20 } };
const onScreen = await render(offFx);
const offScreen = await render(offFx, { offscreen: true });
check('off-screen (export) canvas renders the same as the preview canvas', JSON.stringify(onScreen.data) === JSON.stringify(offScreen.data));

// Fast path: no effects, and an effect that is switched off, draw exactly the plain picture.
const off = await render({ colour: { on: false, saturation: -100 }, chroma: { on: false }, shadow: { on: false }, frame: { kind: 'laptop', on: false } });
check('switched-off effects draw the plain picture', JSON.stringify(off.data) === JSON.stringify(plain.data));

// ---------------------------------------------------------------- Part B: the real UI
const tmp = mkdtempSync(join(tmpdir(), 'capstan-fx-'));
const gsPng = join(tmp, 'greenscreen.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360', '-vf', 'drawbox=x=224:y=90:w=192:h=180:color=0x0000ff:t=fill', '-frames:v', '1', gsPng]);

const ui = await context.newPage();
ui.on('pageerror', (e) => errors.push(e.message));
await ui.goto(base + '/');
await ui.getByRole('button', { name: 'Go to the editor' }).click();
await ui.waitForSelector('.media-bin');
await ui.setInputFiles('.bin-actions input[type=file]', [gsPng]);
await ui.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
await ui.locator('#project-bg').fill('#ff0000');
await ui.locator('.bin-item').dblclick();
await ui.waitForSelector('.clip');
await ui.locator('.ruler').click({ position: { x: 30, y: 10 } });
await ui.waitForTimeout(300);

const canvasPx = async (fx, fy) =>
  ui.evaluate(([a, b]) => {
    const c = document.querySelector('.preview-canvas');
    const d = c.getContext('2d').getImageData(Math.round(a * (c.width - 1)), Math.round(b * (c.height - 1)), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, [fx, fy]);
const settle = () => ui.waitForTimeout(250);

const box = await ui.locator('.canvas-frame').boundingBox();
await ui.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await ui.waitForSelector('#fx-heading');
check('the Inspector shows an Effects section for a selected clip', true);
check('picture starts as the fixture: green backdrop, blue subject', near(await canvasPx(0.1, 0.5), [0, 255, 0, 255], 2) && near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2));

// Green screen through the UI.
await ui.getByLabel('Remove a colour (green screen)').check();
await settle();
const keyedUi = await canvasPx(0.1, 0.5);
check('UI green screen: the project background (red) shows through the green backdrop', near(keyedUi, [255, 0, 0, 255], 2), String(keyedUi));
check('UI green screen: the blue subject stays', near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2));
check('UI green screen: the control set appears (key colour, tolerance, softness, spill)', (await ui.locator('#f-key-tolerance, #f-edge-softness, #f-spill-suppression, #fx-key-colour').count()) === 4);
await ui.getByLabel('Remove a colour (green screen)').uncheck();
await settle();
check('turning green screen off brings the backdrop back', near(await canvasPx(0.1, 0.5), [0, 255, 0, 255], 2));

// Brightness / saturation through the UI, with undo.
await ui.getByLabel('Colour adjustment').check();
await ui.locator('#f-brightness').fill('40');
await ui.locator('#f-brightness').press('Enter');
await settle();
check('UI brightness +40: blue becomes about (51,51,255)', near(await canvasPx(0.5, 0.5), [51, 51, 255, 255], 3), String(await canvasPx(0.5, 0.5)));
await ui.keyboard.press('Control+z');
await settle();
check('one slider change is one undo step', near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2), String(await canvasPx(0.5, 0.5)));
await ui.keyboard.press('Control+Shift+z');
await ui.locator('#f-brightness').fill('0');
await ui.locator('#f-brightness').press('Enter');
await ui.locator('#f-saturation').fill('-100');
await ui.locator('#f-saturation').press('Enter');
await settle();
const greyUi = await canvasPx(0.5, 0.5);
check('UI saturation -100: blue becomes grey (about 18)', near(greyUi, [18, 18, 18, 255], 3), String(greyUi));
await ui.getByRole('button', { name: 'Reset effects' }).click();
await settle();
check('Reset effects restores the original picture', near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2) && (await ui.locator('#f-brightness').count()) === 0);

// Shrink the clip so the corners and shadow show, then use the Effects tab presets.
await ui.locator('#f-scale').fill('60');
await ui.locator('#f-scale').press('Enter');
await ui.getByRole('tab', { name: 'Effects' }).click();
await ui.getByRole('button', { name: /Rounded card with shadow/ }).click();
await settle();
// Clip box: 20%..80% across, 20%..80% down.
check('preset Rounded card: the clip corner is background (rounded away)', near(await canvasPx(0.2, 0.2), [255, 0, 0, 255], 4) || (await canvasPx(0.2, 0.2))[0] > 200 && (await canvasPx(0.2, 0.2))[1] < 60, String(await canvasPx(0.2, 0.2)));
const inside = await canvasPx(0.3, 0.5);
check('preset Rounded card: the picture is still there', near(inside, [0, 255, 0, 255], 2), String(inside));
const shadowPx = await canvasPx(0.5, 0.8 + 0.012);
check('preset Rounded card: shadow darkens the background below the clip', shadowPx[0] < 235 && shadowPx[0] > 40 && shadowPx[1] < 30, String(shadowPx));
check('preset Rounded card: the Inspector shows the shadow controls', (await ui.locator('#f-shadow-blur').count()) === 1 && Number(await ui.locator('#f-corner-radius').inputValue()) > 10);

// Blend mode select.
await ui.getByRole('button', { name: 'Clear effects' }).click();
await settle();
await ui.locator('#fx-blend').selectOption('multiply');
await settle();
const multUi = await canvasPx(0.3, 0.5);
check('UI blend multiply: green over the red background is black', near(multUi, [0, 0, 0, 255], 3), String(multUi));
await ui.locator('#fx-blend').selectOption('normal');

// Device frame via the Effects tab and via the Inspector select.
await ui.getByRole('button', { name: /Laptop frame/ }).click();
await settle();
check('preset Laptop frame: the Inspector select shows Laptop', (await ui.locator('#fx-frame').inputValue()) === 'laptop');
const shotFrame = await ui.locator('.preview-canvas').evaluate((c) => c.toDataURL('image/png').length);
await ui.locator('#fx-frame').selectOption('phone');
await settle();
const shotPhone = await ui.locator('.preview-canvas').evaluate((c) => c.toDataURL('image/png').length);
check('switching the frame to a phone changes the picture', shotFrame !== shotPhone);
check('frame: the picture centre is still the blue subject', near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2), String(await canvasPx(0.5, 0.5)));
await ui.getByRole('button', { name: 'Clear effects' }).click();
await settle();
check('Clear effects removes the frame', near(await canvasPx(0.2, 0.2), [0, 255, 0, 255], 2));

// Effects survive a reload (autosave -> project JSON -> parseEffects).
await ui.getByRole('button', { name: /Green screen/ }).click();
await ui.waitForTimeout(900);
await ui.reload();
await ui.getByRole('button', { name: 'Go to the editor' }).click().catch(() => undefined);
await ui.waitForSelector('.clip');
await ui.locator('.ruler').click({ position: { x: 30, y: 10 } });
await ui.waitForTimeout(500);
check('green screen survives a reload', near(await canvasPx(0.1, 0.1), [255, 0, 0, 255], 2) && near(await canvasPx(0.5, 0.5), [0, 0, 255, 255], 2), String(await canvasPx(0.1, 0.1)));

// ---------------------------------------------------------------- Part C: a tiny export
const out = join(tmp, 'fx-export.mp4');
const exported = await page.evaluate((fx) => window.fxh.exportFrame(fx), { chroma: { key: '#00ff00', tolerance: 40, softness: 12, spill: 60 } });
writeFileSync(out, Buffer.from(exported.base64, 'base64'));
check('export: a 320x180 clip with 5 frames was written', exported.frames === 5, `${exported.frames} frames`);
const sample = (x, y) => {
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.2', '-i', out, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [rgb[0], rgb[1], rgb[2]];
};
const expBg = sample(20, 20);
const expSubject = sample(158, 80);
check('export: the exported frame shows the red background through the green screen', expBg[0] > 200 && expBg[1] < 60 && expBg[2] < 60, `rgb(${expBg})`);
check('export: the exported frame keeps the blue subject', expSubject[2] > 190 && expSubject[0] < 60 && expSubject[1] < 60, `rgb(${expSubject})`);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll visual-effects checks passed');
process.exit(failures ? 1 : 0);
