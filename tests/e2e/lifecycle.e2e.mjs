// The page owns the local host: heartbeat on load, a sendBeacon "leaving" signal on close (token in
// the body, since a beacon cannot set headers), a fresh page id after reload, and End session.
// Usage: node tests/e2e/lifecycle.e2e.mjs   (expects tests/serve.mjs on port 8790)
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const beats = async () => (await fetch(base + '/api/test/heartbeats')).json();
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const all = await beats();
    if (pred(all)) return all;
    await new Promise((r) => setTimeout(r, 100));
  }
  return beats();
};

const skip = (await beats()).length;
const fresh = (all) => all.slice(skip);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/');
await page.waitForSelector('.statusbar');

let all = fresh(await waitFor((a) => fresh(a).some((b) => b.tab && !b.leaving)));
const first = all.find((b) => b.tab && !b.leaving);
check('page sends a heartbeat on load, with the session header', !!first && first.header, JSON.stringify(first));

await page.reload();
await page.waitForSelector('.statusbar');
all = fresh(await waitFor((a) => fresh(a).some((b) => b.tab && b.tab !== first.tab && !b.leaving)));
const left = all.find((b) => b.tab === first.tab && b.leaving);
const second = all.find((b) => b.tab && b.tab !== first.tab && !b.leaving);
check('reload sends a leaving beacon with the token in the body (no header)', !!left && !left.header, JSON.stringify(left));
check('the reloaded page beats with a new page id', !!second);

// A second window counts on its own.
const other = await context.newPage();
await other.goto(base + '/');
await other.waitForSelector('.statusbar');
all = fresh(await waitFor((a) => new Set(fresh(a).filter((b) => b.tab && !b.leaving).map((b) => b.tab)).size >= 3));
check('a second window has its own page id', new Set(all.filter((b) => b.tab && !b.leaving).map((b) => b.tab)).size >= 3);
await other.close({ runBeforeUnload: false });
all = fresh(await waitFor((a) => fresh(a).filter((b) => b.leaving).length >= 2));
check('closing a window sends its leaving beacon', all.filter((b) => b.leaving).length >= 2);

// End session opens the action confirm dialog. Cancel is the default; confirming ends the session.
await page.getByRole('button', { name: 'End session' }).click();
const confirm = page.getByRole('dialog', { name: 'Confirm' });
await confirm.waitFor();
await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'fleet-confirm-cancel');
check('End session asks before it stops, and Cancel is the focused button', true);
await confirm.getByRole('button', { name: 'End session' }).click();
await page.waitForSelector('text=Session ended', { timeout: 5000 });
all = fresh(await beats());
check('End session asks the host to stop', all.some((b) => b.stop));

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll lifecycle checks passed');
process.exit(failures ? 1 : 0);
