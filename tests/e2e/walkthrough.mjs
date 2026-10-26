// Captures the walkthrough screenshots (docs/walkthrough/README.md) from the current build, 1440x900,
// Night watch theme. The demo media is made here, so no real recording or project ends up in docs/:
// demo-title.png is a plain title card and demo-clip.webm is a 10-second recording of Capstan's own
// welcome screen.
//   node tests/serve.mjs 8790   (in another window)
//   node tests/e2e/walkthrough.mjs
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'docs/assets/walkthrough';
const demo = 'tests/e2e/.out/demo';
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

// Demo media.
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(
    `<body style="margin:0;width:1920px;height:1080px;display:grid;place-items:center;background:#101c44;color:#fff;font:bold 200px sans-serif">Capstan demo</body>`,
  );
  await page.screenshot({ path: `${demo}/demo-title.png` });
  await ctx.close();
}
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: 'dark',
    recordVideo: { dir: `${demo}/raw`, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForSelector('.welcome');
  await page.waitForTimeout(9_800);
  await ctx.close();
  const [raw] = readdirSync(`${demo}/raw`);
  renameSync(join(demo, 'raw', raw), `${demo}/demo-clip.webm`);
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 1 });
const page = await context.newPage();
const shot = async (name) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`saved ${out}/${name}.png`);
};

// Start from an empty project with the default (collapsed) sidebar and theme.
await page.goto(base + '/');
await page.evaluate(async () => {
  try {
    window.localStorage.clear();
  } catch {}
  for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
});
await page.reload();
await page.waitForSelector('.welcome');
await shot('01-first-launch');

await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', [`${demo}/demo-clip.webm`, `${demo}/demo-title.png`]);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 2);
await shot('02-import-media');

// Clip on track 1 at 0s, title card on track 2 at 0s, then split the clip at 5s (60 px/s).
const lanes = page.locator('.lane');
const count = await lanes.count();
await page.locator('.bin-item', { hasText: 'demo-clip.webm' }).dragTo(lanes.nth(count - 1), { targetPosition: { x: 2, y: 20 } });
await page.locator('.bin-item', { hasText: 'demo-title.png' }).dragTo(lanes.nth(count - 2), { targetPosition: { x: 2, y: 20 } });
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
await page.locator('.ruler').click({ position: { x: 300, y: 10 } });
await page.locator('.clip.kind-video').click({ position: { x: 20, y: 12 } });
await page.keyboard.press('s');
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 3);
await page.locator('.clip.kind-video').first().click({ position: { x: 20, y: 12 } });
await shot('03-timeline-edit');

// Select the title card with the playhead at 1.5s.
await page.locator('.ruler').click({ position: { x: 90, y: 10 } });
await page.locator('.clip.kind-image').click({ position: { x: 150, y: 12 } });
await shot('04-clip-properties');

await page.locator('.bin-actions button', { hasText: 'Record screen' }).click();
await page.waitForSelector('[aria-labelledby="record-title"]');
await shot('05-record-dialog');
await page.getByRole('button', { name: 'Cancel' }).click();

await page.locator('.toolbar button', { hasText: 'Export video' }).click();
await page.waitForSelector('[aria-labelledby="export-title"]');
await shot('06-export-dialog');

await browser.close();
