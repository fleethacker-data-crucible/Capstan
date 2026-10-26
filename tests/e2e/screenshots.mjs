// Captures the README screenshots in both Fleet themes (docs/UNIFIED-UI.md section 11), using only
// the repository's own test media, so no real recording or project ever ends up in docs/.
//   node tests/serve.mjs 8790   (in another window)
//   node tests/e2e/screenshots.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:8790';
const out = 'docs/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [theme, scheme] of [['night-watch', 'dark'], ['chart-room', 'light']]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // Each run starts from an empty project with the sidebar expanded to show the brand.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('capstan-sidebar', 'expanded');
    } catch {}
  });
  await page.goto(base + '/');
  await page.evaluate(async () => {
    for (const db of (await indexedDB.databases?.()) ?? []) if (db.name) indexedDB.deleteDatabase(db.name);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Go to the editor' }).click();
  await page.waitForSelector('.media-bin');
  await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png', 'tests/fixtures/tone.wav']);
  await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3);
  // Lay the clip and the card on the timeline, then park the playhead inside both.
  const lanes = page.locator('.lane');
  const lastLane = lanes.nth((await lanes.count()) - 1);
  const firstLane = lanes.nth(0);
  await page.locator('.bin-item').nth(0).dragTo(lastLane, { targetPosition: { x: 20, y: 20 } });
  await page.locator('.bin-item').nth(1).dragTo(firstLane, { targetPosition: { x: 200, y: 20 } });
  await page.locator('.ruler').click({ position: { x: 150, y: 10 } });
  await page.locator('.clip.kind-image').click({ position: { x: 150, y: 12 } });
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${out}/editor-${theme}.png` });
  console.log(`saved ${out}/editor-${theme}.png`);
  await context.close();
}
await browser.close();
