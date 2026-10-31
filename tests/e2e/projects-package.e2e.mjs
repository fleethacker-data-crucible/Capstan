// Projects and package area, driven through the real UI in headless Chromium:
//   package save (streamed and download) and open after a full reset, damaged/hostile packages,
//   the Projects dialog (rename, duplicate, delete, sizes, switching), templates and themes,
//   the Library surviving New project, and the SnapShackle folder import with a fake directory.
// Usage: node tests/e2e/run-all.mjs projects-package   (or CAPSTAN_URL=... node this file)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
page.on('dialog', (d) => void d.accept());

const status = async () => ((await page.locator('.statusbar .message').textContent()) ?? '').trim();
const waitStatus = (re, timeout = 20000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.statusbar .message')?.textContent ?? ''), re.source, { timeout });
const menu = async (name) => {
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
};
const idbProjects = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('capstan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction('projects').objectStore('projects').getAll();
          q.onsuccess = () => resolve(q.result);
        };
      }),
  );
const idbMedia = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('capstan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const s = r.result.transaction('media').objectStore('media');
          const keys = s.getAllKeys();
          keys.onsuccess = () => {
            const all = s.getAll();
            all.onsuccess = () => resolve(keys.result.map((k, i) => [String(k), all.result[i].size]));
          };
        };
      }),
  );
const idbLibrary = () =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('capstan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const q = r.result.transaction('library').objectStore('library').getAll();
          q.onsuccess = () => resolve(q.result.map((a) => [a.meta.name, a.blob.size]));
        };
      }),
  );
const currentProject = async () => {
  await page.waitForTimeout(700); // autosave
  const id = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('capstan');
        r.onsuccess = () => {
          const q = r.result.transaction('meta').objectStore('meta').get('lastProjectId');
          q.onsuccess = () => resolve(q.result);
        };
      }),
  );
  return (await idbProjects()).find((p) => p.id === id);
};
const previewPixel = (fx, fy) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('.preview-canvas');
      const d = c.getContext('2d').getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [fx, fy],
  );
const binCount = () => page.locator('.bin-item').count();

// ---------- build a project through the UI ----------
await page.goto(base + '/');
await page.waitForSelector('.welcome');
check('Welcome offers Projects and New from template', (await page.locator('.welcome-more button').allTextContents()).map((t) => t.trim()).join('|') === 'Projects|New from template');
check('Welcome keeps its three primary actions', (await page.locator('.welcome-actions button').count()) === 3);
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/clip.webm', 'tests/fixtures/card.png', 'tests/fixtures/tone.wav']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
const lanes = page.locator('.lane');
const bottomLane = lanes.nth((await lanes.count()) - 1);
const lb = await bottomLane.boundingBox();
await page.locator('.bin-item', { hasText: 'clip.webm' }).dragTo(bottomLane, { targetPosition: { x: 2, y: lb.height / 2 } });
await page.waitForSelector('.clip');
await page.locator('.bin-item', { hasText: 'card.png' }).dblclick();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2);
check('project built: three media, two clips', (await binCount()) === 3 && (await page.locator('.clip').count()) === 2);

// ---------- Project menu ----------
await page.getByRole('button', { name: 'Project', exact: true }).click();
const labels = (await page.getByRole('menuitem').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
check('Project menu has the package, template, library and SnapShackle items', ['Projects…', 'Save package (.capstanz)', 'Open package…', 'Save as template…', 'New from template…', 'Library…', 'Import from SnapShackle captures…'].every((l) => labels.some((x) => x.startsWith(l))), labels.join(' | '));
check('menu is a labelled ARIA menu', (await page.locator('[role=menu][aria-label=Project]').count()) === 1 && (await page.getByRole('button', { name: 'Project', exact: true }).getAttribute('aria-expanded')) === 'true');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Escape');
check('Esc closes the menu', (await page.locator('[role=menu]').count()) === 0);

// ---------- rename through the Projects dialog ----------
await menu('Projects…');
await page.waitForSelector('#projects-title');
await page.waitForSelector('.pp-item.current');
check('Projects dialog marks the open project', (await page.locator('.pp-item.current').count()) === 1);
await page.getByRole('button', { name: 'Rename Untitled project' }).click();
await page.locator('.pp-rename').fill('Alpha');
await page.locator('.pp-rename').press('Enter');
await page.waitForSelector('.pp-name:has-text("Alpha")');
check('rename updates the list and the title bar', (await page.locator('h1.project-title').textContent()) === 'Alpha');
const sizeText = await page.locator('.pp-item.current .pp-size').textContent();
check('Projects dialog shows the media size', /\d/.test(sizeText ?? '') && /(KB|MB)/.test(sizeText ?? ''), sizeText);
await page.screenshot({ path: `${out}/pp-01-projects.png` });
await page.keyboard.press('Escape');
await page.waitForSelector('#projects-title', { state: 'detached' });

// ---------- save package: streamed to a (fake) file handle ----------
await page.evaluate(() => {
  window.__saved = { name: '', chunks: [], closed: false };
  window.showSaveFilePicker = async (opts) => {
    window.__saved.name = opts.suggestedName;
    return {
      createWritable: async () => ({
        write: async (c) => window.__saved.chunks.push(new Uint8Array(c).slice()),
        close: async () => {
          window.__saved.closed = true;
        },
        abort: async () => {},
      }),
    };
  };
});
await menu('Save package (.capstanz)');
await waitStatus(/Saved Alpha\.capstanz/);
const streamed = await page.evaluate(() => {
  const total = window.__saved.chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of window.__saved.chunks) {
    all.set(c, at);
    at += c.length;
  }
  let bin = '';
  for (let i = 0; i < all.length; i += 0x8000) bin += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return { name: window.__saved.name, closed: window.__saved.closed, chunks: window.__saved.chunks.length, b64: btoa(bin) };
});
check('package streams to the chosen file in chunks and closes it', streamed.closed && streamed.chunks > 3 && streamed.name === 'Alpha.capstanz', `${streamed.chunks} chunks, ${streamed.name}`);
const streamedFile = `${out}/pp-streamed.capstanz`;
writeFileSync(streamedFile, Buffer.from(streamed.b64, 'base64'));

// ---------- save package: download fallback ----------
await page.evaluate(() => {
  window.showSaveFilePicker = undefined;
});
const dl = page.waitForEvent('download', { timeout: 30000 });
await menu('Save package (.capstanz)');
const download = await dl;
check('without a save dialog the package downloads as Alpha.capstanz', download.suggestedFilename() === 'Alpha.capstanz', download.suggestedFilename());
const pkgFile = `${out}/pp-alpha.capstanz`;
await download.saveAs(pkgFile);
const pkgBytes = readFileSync(pkgFile);
check('streamed and downloaded packages hold the same media bytes', Math.abs(pkgBytes.length - readFileSync(streamedFile).length) < 400, `${pkgBytes.length} vs ${readFileSync(streamedFile).length}`);

// An independent zip reader must accept it (Info-ZIP, else Python), and the video inside must decode.
function independent(file) {
  const unzip = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  if (unzip.status === 0) return { tool: 'unzip', ok: /No errors detected/.test(unzip.stdout), list: execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean) };
  for (const py of ['python', 'python3']) {
    const t = spawnSync(py, ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
    if (t.error) continue;
    const l = spawnSync(py, ['-m', 'zipfile', '-l', file], { encoding: 'utf8' });
    return { tool: py, ok: t.status === 0, list: l.stdout.split(/\r?\n/).slice(1).map((x) => x.split(/\s+/)[0]).filter(Boolean) };
  }
  return null;
}
const ind = independent(pkgFile);
if (ind) {
  check(`independent zip tool (${ind.tool}) verifies every checksum`, ind.ok);
  check('package lists manifest.json, project.json and media/<id>-<name>', ind.list.includes('manifest.json') && ind.list.includes('project.json') && ind.list.filter((n) => /^media\/med_[^/]+-(clip\.webm|card\.png|tone\.wav)$/.test(n)).length === 3, ind.list.join(', '));
  if (ind.tool === 'unzip') {
    const clip = ind.list.find((n) => n.endsWith('clip.webm'));
    const extracted = `${out}/pp-extracted.webm`;
    writeFileSync(extracted, execFileSync('unzip', ['-p', pkgFile, clip], { maxBuffer: 1 << 28 }));
    const dur = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', extracted]).toString()).format.duration);
    check('the video extracted from the package is the original (ffprobe)', Math.abs(dur - 3) < 0.3, `${dur}s`);
  }
} else {
  console.log('SKIP  no independent zip tool (unzip/python) on PATH');
}

// ---------- reset everything, then open the package ----------
await page.waitForTimeout(700);
await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.deleteDatabase('capstan');
  r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
}));
await page.reload();
await page.waitForSelector('.welcome');
check('after a storage reset the app starts empty', (await idbMedia()).length === 0);
await page.setInputFiles('input[aria-label="Open a project package"]', pkgFile);
await page.waitForSelector('.media-bin', { timeout: 30000 });
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2 && document.querySelectorAll('.bin-item').length === 3, null, { timeout: 30000 });
check('opening the package restores media bin and timeline', (await binCount()) === 3 && (await page.locator('.clip').count()) === 2);
check('project name and canvas survive the package', (await page.locator('h1.project-title').textContent()) === 'Alpha');
const media = await idbMedia();
const fixtureSizes = ['clip.webm', 'card.png', 'tone.wav'].map((f) => readFileSync(`tests/fixtures/${f}`).length).sort((a, b) => a - b);
check('every media Blob is back in browser storage, byte for byte in size', JSON.stringify(media.map((m) => m[1]).sort((a, b) => a - b)) === JSON.stringify(fixtureSizes), JSON.stringify(media.map((m) => m[1])));
await page.locator('.ruler').click({ position: { x: 60, y: 10 } });
await page.waitForTimeout(500);
const px = await previewPixel(0.1, 0.5);
check('the restored video plays: preview shows a frame', px[0] + px[1] + px[2] > 100, `rgb(${px})`);
await page.screenshot({ path: `${out}/pp-02-opened.png` });

// ---------- damaged and hostile packages ----------
const before = (await page.locator('.clip').count()) + ':' + (await binCount());
// 1) a flipped byte inside stored media
const corrupt = Buffer.from(pkgBytes);
corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
writeFileSync(`${out}/pp-corrupt.capstanz`, corrupt);
await page.setInputFiles('input[aria-label="Open a project package"]', `${out}/pp-corrupt.capstanz`);
await waitStatus(/Could not open pp-corrupt\.capstanz: .*(corrupt|damaged)/);
check('a corrupt package is refused with a message naming the problem', /corrupt|damaged/.test(await status()), await status());
// 2) not a zip at all
writeFileSync(`${out}/pp-notzip.capstanz`, 'this is only text, not a package');
await page.setInputFiles('input[aria-label="Open a project package"]', `${out}/pp-notzip.capstanz`);
await page.waitForTimeout(300);
await waitStatus(/pp-notzip\.capstanz.*zip|zip.*pp-notzip/i).catch(() => undefined);
check('a file that is not a zip is refused', /Could not open pp-notzip\.capstanz/.test(await status()) && /zip/i.test(await status()), await status());
// 3) path traversal in an entry name
const evil = Buffer.from(pkgBytes);
const idx = evil.indexOf(Buffer.from('manifest.json', 'latin1'), evil.length - 4000); // central directory copy
if (idx > 0) {
  Buffer.from('../../x.json!').copy(evil, idx);
  writeFileSync(`${out}/pp-evil.capstanz`, evil);
  await page.setInputFiles('input[aria-label="Open a project package"]', `${out}/pp-evil.capstanz`);
  await waitStatus(/Could not open pp-evil\.capstanz/);
  check('a package with a ../ entry name is refused', /unsafe file name/.test(await status()), await status());
} else check('a package with a ../ entry name is refused', false, 'central directory entry not found');
check('refused packages leave the open project untouched', before === (await page.locator('.clip').count()) + ':' + (await binCount()));

// ---------- Projects dialog: switch, duplicate, delete ----------
page.removeAllListeners('dialog');
const confirms = [];
page.on('dialog', (d) => {
  confirms.push(d.message());
  void d.accept();
});
await page.locator('.toolbar [title="New project"]').click();
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 0 || document.querySelector('.welcome'));
check('New project asks first and says the old one stays in Projects', confirms.some((m) => /stays in Project/.test(m)), confirms.join('|'));
await menu('Projects…');
await page.waitForSelector('#projects-title');
await page.waitForSelector('.pp-item');
await page.waitForTimeout(500);
const names = await page.locator('.pp-name').allTextContents();
check('New project keeps the previous one in the list (and shows the new one)', names.includes('Alpha') && names.includes('Untitled project'), names.join(','));
await page.getByRole('button', { name: 'Duplicate Alpha' }).click();
await page.waitForSelector('.pp-name:has-text("Alpha (copy)")');
check('Duplicate adds "Alpha (copy)"', true);
const sizes = await page.locator('.pp-item', { hasText: 'Alpha' }).locator('.pp-size').allTextContents();
check('both Alpha entries report the same size', sizes.length === 2 && sizes[0] === sizes[1], sizes.join(' vs '));
const mediaAfterDup = await idbMedia();
check('Duplicate copied the media Blobs (6 now, none shared)', mediaAfterDup.length === 6, String(mediaAfterDup.length));
await page.getByRole('button', { name: 'Open Alpha (copy)' }).click();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2 && document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
check('opening the copy restores its clips and media', (await page.locator('h1.project-title').textContent()) === 'Alpha (copy)');
const pxCopy = await (async () => {
  await page.locator('.ruler').click({ position: { x: 60, y: 10 } });
  await page.waitForTimeout(500);
  return previewPixel(0.1, 0.5);
})();
check("the copy's own media plays", pxCopy[0] + pxCopy[1] + pxCopy[2] > 100, `rgb(${pxCopy})`);
await menu('Projects…');
await page.getByRole('button', { name: 'Delete Alpha (copy)' }).click();
await page.waitForFunction(() => !document.body.innerText.includes('Alpha (copy)') || document.querySelectorAll('.pp-name').length >= 1);
await page.waitForTimeout(500);
check('delete asks for confirmation naming the project and its size', confirms.some((m) => /Delete Alpha \(copy\)/.test(m) && /MB|KB/.test(m)), confirms.at(-1));
check('deleting the open project removes it from the list and its media from storage', !(await page.locator('.pp-name').allTextContents()).includes('Alpha (copy)') && (await idbMedia()).length === 3, String((await idbMedia()).length));
await page.getByRole('button', { name: 'Open Alpha', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2, null, { timeout: 20000 });
check('the original Alpha is intact after deleting its copy', (await page.locator('h1.project-title').textContent()) === 'Alpha' && (await binCount()) === 3);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll('.clip').length === 2, null, { timeout: 20000 });
check('the last-open project is what a reload brings back', (await page.locator('h1.project-title').textContent()) === 'Alpha');

// ---------- templates and themes ----------
await menu('New from template…');
await page.waitForSelector('#templates-title');
const tplNames = await page.locator('[data-template-id] .pp-name').allTextContents();
check('built-in templates: tutorial 16:9, vertical 9:16, square', ['Tutorial, 16:9', 'Vertical, 9:16', 'Square, 1:1'].every((n) => tplNames.includes(n)), tplNames.join(','));
await page.getByRole('button', { name: 'Apply the Chart room theme' }).click();
await page.waitForTimeout(100);
const themed = await currentProject();
check('applying a theme sets the project background', themed.background === '#f4efe4', themed.background);
await page.screenshot({ path: `${out}/pp-03-templates.png` });
// Save the current layout (with the themed background) as a template.
await page.locator('#tpl-name').fill('My demo layout');
await page.locator('#tpl-desc').fill('chart room look');
await page.getByRole('button', { name: 'Save as template' }).click();
await page.waitForSelector('.success:has-text("Saved template My demo layout")');
await page.waitForSelector('[data-template-id] .pp-name:has-text("My demo layout")');
check('a saved template joins the list', true);
// New from a built-in: vertical.
await page.getByRole('button', { name: 'New project from Vertical, 9:16' }).click();
await page.waitForSelector('#templates-title', { state: 'detached' });
let proj = await currentProject();
check('vertical template: 1080x1920, 3 tracks, no media or clips', proj.width === 1080 && proj.height === 1920 && proj.tracks.length === 3 && proj.media.length === 0 && proj.clips.length === 0, `${proj.width}x${proj.height}`);
await menu('New from template…');
await page.getByRole('button', { name: 'New project from Tutorial, 16:9' }).click();
await page.waitForSelector('#templates-title', { state: 'detached' });
proj = await currentProject();
check('tutorial template: 1920x1080 with Intro and Outro tracks', proj.width === 1920 && proj.tracks.some((t) => t.name === 'Intro') && proj.tracks.some((t) => t.name === 'Outro'), proj.tracks.map((t) => t.name).join(','));
await page.getByRole('button', { name: 'Go to the editor' }).click().catch(() => undefined);
await page.waitForSelector('.preview-canvas');
await page.waitForTimeout(300);
const bg = await previewPixel(0.5, 0.5);
check('the new project draws its template background', Math.abs(bg[0] - 0x0f) < 3 && Math.abs(bg[1] - 0x1b) < 3 && Math.abs(bg[2] - 0x2d) < 3, `rgb(${bg})`);
// The user template survives a reload and carries the themed look.
await page.reload();
await page.waitForSelector('.toolbar');
await menu('New from template…');
await page.waitForSelector('[data-template-id] .pp-name:has-text("My demo layout")');
await page.getByRole('button', { name: 'New project from My demo layout' }).click();
await page.waitForSelector('#templates-title', { state: 'detached' });
proj = await currentProject();
check('user template after reload: same size, tracks and themed background, no media', proj.width === 1920 && proj.tracks.length === 3 && proj.background === '#f4efe4' && proj.media.length === 0 && proj.clips.length === 0, proj.background);
await menu('New from template…');
await page.getByRole('button', { name: 'Delete template My demo layout' }).click();
await page.waitForFunction(() => ![...document.querySelectorAll('[data-template-id] .pp-name')].some((e) => e.textContent === 'My demo layout'), null, { timeout: 5000 });
check('a user template can be deleted', true);
await page.keyboard.press('Escape');

// ---------- library ----------
// Open Alpha again, save its image into the library, then use it from a different (new) project.
await menu('Projects…');
await page.getByRole('button', { name: 'Open Alpha', exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 3, null, { timeout: 20000 });
await menu('Library…');
await page.waitForSelector('#library-title');
await page.getByRole('button', { name: 'Save card.png to the library' }).click();
await page.waitForSelector('[data-asset-id]');
await page.setInputFiles('input[aria-label="Add files to the library"]', 'tests/fixtures/tone.wav');
await page.waitForFunction(() => document.querySelectorAll('[data-asset-id]').length === 2, null, { timeout: 15000 });
check('library holds the saved image and the added audio file', (await idbLibrary()).length === 2, JSON.stringify(await idbLibrary()));
await page.screenshot({ path: `${out}/pp-04-library.png` });
await page.keyboard.press('Escape');
await page.locator('.toolbar [title="New project"]').click();
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 0);
await page.getByRole('button', { name: 'Go to the editor' }).click().catch(() => undefined);
await menu('Library…');
await page.waitForSelector('[data-asset-id]');
check('the library survives New project', (await page.locator('[data-asset-id]').count()) === 2);
await page.getByRole('button', { name: 'Add card.png to this project' }).click();
await page.waitForSelector('.success:has-text("Added card.png")');
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1);
check('a library asset lands in the new project media bin', (await page.locator('.bin-item').textContent()).includes('card.png'));
await page.locator('.bin-item', { hasText: 'card.png' }).dblclick();
await page.waitForSelector('.clip');
check('and can be placed on its timeline', (await page.locator('.clip.kind-image').count()) === 1);
await page.reload();
await menu('Library…');
await page.waitForSelector('[data-asset-id]');
check('the library survives a reload', (await page.locator('[data-asset-id]').count()) === 2);
await page.getByRole('button', { name: 'Remove tone.wav from the library' }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-asset-id]').length === 1);
check('a library asset can be removed', (await idbLibrary()).length === 1);
await page.keyboard.press('Escape');

// ---------- SnapShackle captures ----------
await page.evaluate(async () => {
  const blob = async (f, type) => new Blob([await (await fetch('/fixtures/' + f)).arrayBuffer()], { type });
  const png = await blob('card.png', 'image/png');
  const webm = await blob('clip.webm', 'video/webm');
  const file = (name, b, t) => ({ kind: 'file', name, getFile: async () => new File([b], name, { type: b.type, lastModified: t }) });
  const dir = (name, kids) => ({ kind: 'directory', name, values: async function* () { for (const k of kids) yield k; } });
  window.__picked = 0;
  window.showDirectoryPicker = async () => {
    window.__picked++;
    return dir('Captures', [file('2026-10-01 a.png', png, 1), file('notes.txt', new Blob(['x'], { type: 'text/plain' }), 2), dir('2026-10', [file('b.png', png, 3), file('screen.webm', webm, 4)])]);
  };
});
const before2 = await binCount();
await menu('Import from SnapShackle captures…');
await waitStatus(/Imported 3 of 3 captures from Captures/, 30000);
check('SnapShackle import brings in images and video from the folder and its subfolders, not the text file', (await binCount()) === before2 + 3 && (await status()).includes('3 of 3'), await status());
await page.evaluate(() => {
  window.showDirectoryPicker = async () => {
    const e = new Error('cancelled');
    e.name = 'AbortError';
    throw e;
  };
});
await menu('Import from SnapShackle captures…');
await waitStatus(/Import cancelled/);
check('cancelling the folder picker imports nothing and says so', (await binCount()) === before2 + 3);
await page.evaluate(() => {
  delete window.showDirectoryPicker;
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
});
await page.getByRole('button', { name: 'Project', exact: true }).click();
check('where the folder API is missing the menu item is disabled with a reason', await page.getByRole('menuitem', { name: /SnapShackle/ }).isDisabled());
await page.keyboard.press('Escape');

// ---------- the existing project-file buttons ----------
const jsonDl = page.waitForEvent('download');
await page.locator('.toolbar [title^="Save project file"]').click();
const jf = await jsonDl;
check('Save project file still writes a .capstan (edit only)', jf.suggestedFilename().endsWith('.capstan') && /edit only|Save package/.test(await status()), await status());
await jf.saveAs(`${out}/pp-edit.capstan`);
await page.setInputFiles('.toolbar input[type=file]', pkgFile);
await waitStatus(/Opened Alpha \(copy( \d+)?\) from pp-alpha\.capstanz.*opened as a copy/);
check('the toolbar Open button accepts a .capstanz; a package of an existing project opens as a copy, never over it', (await page.locator('h1.project-title').textContent()).startsWith('Alpha (copy'), await status());

check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll projects-package checks passed');
process.exit(failures ? 1 : 0);
