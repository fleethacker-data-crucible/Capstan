// Speech-to-text through the real UI against the test server's mirror of the host (fake engine, so the text is
// made up): import tone.wav, Transcribe in the Captions tab, three captions land in the list and on the lane,
// one undo removes them, Replace swaps them, Cancel changes nothing, and the no-recogniser message shows when
// the mirror has no recogniser. Also checks the WAV the page sends: mono, 16 kHz, 16-bit.
// Usage: node tests/e2e/speech.e2e.mjs   (or via run-all.mjs speech)
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

/** Tells the test server's speech mirror which cultures are installed and how long a fake job takes. */
const setMirror = async (state) => (await fetch(`${base}/api/test/speech`, { method: 'POST', body: JSON.stringify(state) })).json();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/status of (4|5)\d\d/.test(m.text()) && errors.push(m.text()));

const captionRows = () => page.locator('.caption-row');
const laneItems = () => page.locator('.overlay-lane .overlay-item.kind-captions');
const blurFocus = () => page.locator('.transport .timecode').click();

await setMirror({ cultures: ['en-US', 'en-GB'], delayMs: 0 });
await page.goto(base + '/');
await page.getByRole('button', { name: 'Go to the editor' }).click();
await page.waitForSelector('.media-bin');
await page.setInputFiles('.bin-actions input[type=file]', ['tests/fixtures/tone.wav']);
await page.waitForFunction(() => document.querySelectorAll('.bin-item').length === 1, null, { timeout: 20000 });
await page.locator('.bin-item').dblclick();
await page.waitForSelector('.clip');

await page.getByRole('tab', { name: 'Captions' }).click();
await page.waitForSelector('.captions-panel');
const section = page.locator('.transcribe');
await section.getByLabel('Language').waitFor();

// ---- the words the UI must carry ----
const text = (await section.textContent()) ?? '';
check('the UI says quality depends on the installed Windows speech pack', /depends on the speech language pack installed in Windows/.test(text));
check('the UI says nothing leaves the PC', /nothing leaves it/.test(text));
check('the UI states the limits (noisy audio, other languages)', /noisy audio/.test(text) && /languages without a Windows speech pack/.test(text));
check('the fake recogniser is labelled as a test recogniser', /Test recogniser/.test(text));
check('the installed languages are listed', (await section.getByLabel('Language').locator('option').allTextContents()).join() === 'en-US,en-GB');
check('no captions and no lane before transcribing', (await captionRows().count()) === 0 && (await laneItems().count()) === 0);

// ---- transcribe the timeline ----
await section.getByRole('button', { name: 'Transcribe' }).click();
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3, null, { timeout: 20000 });
check('three captions appear in the Captions tab', (await captionRows().count()) === 3);
check('they carry the recogniser text', (await captionRows().nth(0).locator('textarea').inputValue()) === 'This is the first fake caption.' && (await captionRows().nth(2).locator('textarea').inputValue()) === 'This is the third fake caption.');
check('and three captions sit on the timeline lane', (await laneItems().count()) === 3);
check('the result is announced with a hint to check the text', /Added 3 captions/.test((await page.locator('.transcribe-note').textContent()) ?? '') && /Check the text/.test((await page.locator('.transcribe-note').textContent()) ?? ''));

// What the page sent: one request, language en-US, 2 s of mono 16 kHz audio.
const seen = (await (await fetch(`${base}/api/test/speech`)).json()).requests;
check('one request, for en-US, with about 2 s of 16 kHz mono audio', seen.length === 1 && seen[0].culture === 'en-US' && Math.abs(seen[0].seconds - 2) < 0.1, JSON.stringify(seen));

// The captions are editable like any others.
await captionRows().nth(0).locator('textarea').fill('Edited by hand');
await blurFocus();
check('a transcribed caption can be edited', (await captionRows().nth(0).locator('textarea').inputValue()) === 'Edited by hand');
await page.keyboard.press('Control+z');
check('that edit undoes on its own', (await captionRows().nth(0).locator('textarea').inputValue()) === 'This is the first fake caption.');

// ---- one undo removes them all ----
await blurFocus();
await page.keyboard.press('Control+z');
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 0);
check('one undo takes all the transcribed captions away', (await captionRows().count()) === 0 && (await laneItems().count()) === 0);
await page.keyboard.press('Control+Shift+z');
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 3);
check('and redo brings them back', (await captionRows().count()) === 3);

// ---- Add keeps what is there; Replace swaps the captions in the stretch ----
await section.getByRole('button', { name: 'Transcribe' }).click();
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 6, null, { timeout: 20000 });
check('Add keeps the existing captions (3 + 3)', (await captionRows().count()) === 6);
await section.getByLabel('Captions').selectOption('replace');
await section.getByRole('button', { name: 'Transcribe' }).click();
await page.waitForFunction(() => /replacing 6/.test(document.querySelector('.transcribe-note')?.textContent ?? ''), null, { timeout: 20000 });
check('Replace swaps the captions in that stretch (3 left)', (await captionRows().count()) === 3);
await blurFocus();
await page.keyboard.press('Control+z');
await page.waitForFunction(() => document.querySelectorAll('.caption-row').length === 6);
check('Replace is one undo step', (await captionRows().count()) === 6);

// ---- the selected clip as the stretch ----
await page.locator('.clip').first().click();
await section.getByLabel('Transcribe', { exact: true }).selectOption('clip');
check('with a clip selected, the selected clip can be transcribed', (await section.getByLabel('Transcribe', { exact: true }).inputValue()) === 'clip');

// ---- Cancel changes nothing ----
await setMirror({ delayMs: 6000 });
await section.getByLabel('Captions').selectOption('add');
await section.getByRole('button', { name: 'Transcribe' }).click();
await section.getByRole('button', { name: 'Cancel' }).waitFor();
check('progress is shown while it runs', (await page.getByRole('progressbar', { name: 'Transcription progress' }).count()) === 1);
await page.waitForTimeout(600);
await section.getByRole('button', { name: 'Cancel' }).click();
await page.waitForFunction(() => /cancelled/.test(document.querySelector('.transcribe-note')?.textContent ?? ''), null, { timeout: 10000 });
check('Cancel says so and adds nothing', (await captionRows().count()) === 6 && (await section.getByRole('button', { name: 'Cancel' }).count()) === 0);
check('Transcribe is available again', await section.getByRole('button', { name: 'Transcribe' }).isEnabled());

// ---- no recogniser installed ----
await setMirror({ cultures: [], delayMs: 0 });
await page.getByRole('tab', { name: 'Media' }).click();
await page.getByRole('tab', { name: 'Captions' }).click();
await section.getByText('No Windows speech recogniser is installed').waitFor({ timeout: 10000 });
const help = (await section.textContent()) ?? '';
check('the no-recogniser message says how to add the Windows speech language pack', /Settings > Time & language > Language & region/.test(help) && /Speech recognition/.test(help));
check('and Transcribe is disabled', await section.getByRole('button', { name: 'Transcribe' }).isDisabled());
await setMirror({ cultures: ['en-US'] });
await section.getByRole('button', { name: 'Check again' }).click();
await section.getByLabel('Language').waitFor();
check('Check again finds a recogniser once one is installed', (await section.getByLabel('Language').locator('option').allTextContents()).join() === 'en-US');

// ---- what the host refuses ----
await setMirror({ cultures: ['en-US'] });
const post = (query, type, size) =>
  page.evaluate(
    async ([q, t, n]) => {
      const meta = document.querySelector('meta[name="capstan-session"]').content;
      const res = await fetch(`/api/speech/transcribe${q}`, { method: 'POST', headers: { 'X-Capstan-Token': meta, 'Content-Type': t }, body: new Uint8Array(n) });
      return { status: res.status, code: (await res.json()).code };
    },
    [query, type, size],
  );
const bad = await post('?culture=en-US', 'audio/wav', 100);
check('bytes that are not a WAV are refused as unsupported-format (400)', bad.status === 400 && bad.code === 'unsupported-format', JSON.stringify(bad));
const wrongType = await post('?culture=en-US', 'application/json', 100);
check('another content type is refused (400)', wrongType.status === 400 && wrongType.code === 'unsupported-type', JSON.stringify(wrongType));
const german = await post('?culture=de-DE', 'audio/wav', 100);
check('a language with no recogniser is refused with no-recogniser (501)', german.status === 501 && german.code === 'no-recogniser', JSON.stringify(german));
const noToken = await page.evaluate(async () => (await fetch('/api/speech/status')).status);
check('a request without the session token is refused', noToken === 403);

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('speech e2e passed');
