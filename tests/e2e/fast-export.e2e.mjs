// Fast export beyond plain H.264 MP4 and VP8/VP9 WebM (issue #28): fragmented MP4, AV1 in MP4 and
// WebM, and HEVC only where the browser says it can decode it. For every synthetic fixture the
// path the export takes is checked (and explained), the sequentially decoded frames are compared
// with the seeked frames, and a clip that falls back (HEVC without decoder support, a truncated
// file) must do so without an error and still export.
//
// Fixtures (tests/fixtures, each under 15 KB, 320x180, 1 s, 15 fps, ffmpeg testsrc: a moving bar and
// a running clock, so every frame is different; made with ffmpeg -f lavfi -i testsrc=size=320x180:rate=15:duration=1
// -an -pix_fmt yuv420p, then):
//   h264-frag.mp4        -c:v libx264 -g 8 -bf 2 -movflags frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets
//                        (2 fragments, B-frames, negative composition offsets)
//   h264-frag-sidx.mp4   -c:v libx264 -g 8 -bf 0 -movflags frag_keyframe+empty_moov+default_base_moof+global_sidx   (a sidx box before the fragments)
//   h264-frag-bframes.mp4 -c:v libx264 -g 8 -bf 2 -movflags frag_keyframe+empty_moov+default_base_moof   (B-frames, first picture 0.133 s in; see below)
//   av1.mp4             -c:v libaom-av1 -cpu-used 8 -crf 40 -b:v 0 -g 8                                  (plain MP4)
//   av1-frag.mp4        the same with the fragmented movflags
//   av1.webm            the same as WebM
//   hevc.mp4            -c:v libx265 -tag:v hvc1 -x265-params keyint=8                                  (only attempted where WebCodecs says yes)
//   h264-avc3.mp4       -c:v libx264 -g 8 -bf 2 -tag:v avc3                                              (declined: parameter sets in the stream)
// Usage: node tests/e2e/run-all.mjs fast-export   (needs `bun run build` and the harness build)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const out = 'tests/e2e/.out/fast-export';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const countFrames = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim());
const decodeErrors = (file) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};

/** Mean absolute difference per colour channel (0 to 255) allowed between a decoded and a seeked frame. */
const TOLERANCE = 3;

/**
 * The frames drawn by the fast path against ffmpeg's decode of the same file, which does not depend on
 * how the media element seeks. One time inside each picture's span; every picture must be closest to
 * its own ffmpeg frame (not a neighbour) and within TOLERANCE of it.
 */
async function againstFfmpeg(name) {
  const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'default=noprint_wrappers=1:nokey=1', `tests/fixtures/${name}`])
    .toString()
    .trim()
    .split(/\s+/)
    .map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', `tests/fixtures/${name}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  const size = 320 * 180 * 4;
  const count = raw.length / size;
  // The clip is 1.000 s long; a picture that starts at or after that (the last one of a B-frame file
  // can) is never shown, so it is not asked for.
  const shown = pts.map((t, j) => ({ t, j })).filter(({ t }) => t + 0.02 < 1);
  const fast = (await page.evaluate(([n, t]) => window.framePixels(n, t, true), [name, shown.map(({ t }) => t + 0.02)])).map((b) => Buffer.from(b, 'base64'));
  const diff = (a, j) => {
    let d = 0;
    for (let i = 0; i < size; i += 4) d += Math.abs(a[i] - raw[j * size + i]) + Math.abs(a[i + 1] - raw[j * size + i + 1]) + Math.abs(a[i + 2] - raw[j * size + i + 2]);
    return d / ((size / 4) * 3);
  };
  let worst = 0;
  let wrong = 0;
  shown.forEach(({ j }, n) => {
    const own = diff(fast[n], j);
    worst = Math.max(worst, own);
    for (let k = 0; k < count; k++) if (k !== j && diff(fast[n], k) <= own) wrong++;
  });
  return { count, pictures: pts.length, checked: shown.length, worst, wrong };
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[browser]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${base}/harness`);
await page.waitForFunction(() => document.title === 'harness-ready');

// Frame times in the 15 fps clips: across the fragment boundary (key frame at frame 8, 0.533 s),
// then backwards, which restarts the decoder at a key frame.
const TIMES = [0, 0.2, 0.5333, 0.9333, 0.1, 0.4667, 0.6, 0];

const FIXTURES = [
  { name: 'h264-frag.mp4', container: 'mp4', codec: /^avc1\./, fragmented: true, note: 'fragmented H.264, B-frames, negative composition offsets' },
  { name: 'h264-frag-sidx.mp4', container: 'mp4', codec: /^avc1\./, fragmented: true, note: 'fragmented H.264 with a sidx box' },
  // Chrome's media element drops the last two pictures of the first fragment of this file when seeked
  // (it shows the next key frame instead), so a seeked reference cannot be exact. The fast path decodes
  // every picture, and is held to ffmpeg's own decode instead; the seek comparison is only printed.
  { name: 'h264-frag-bframes.mp4', container: 'mp4', codec: /^avc1\./, fragmented: true, note: 'fragmented H.264, B-frames, positive offsets', seekQuirk: true },
  { name: 'av1.mp4', container: 'mp4', codec: /^av01\./, fragmented: false, note: 'AV1 in a plain MP4' },
  { name: 'av1-frag.mp4', container: 'mp4', codec: /^av01\./, fragmented: true, note: 'AV1 in a fragmented MP4' },
  { name: 'av1.webm', container: 'webm', codec: /^av01\./, fragmented: false, note: 'AV1 in WebM' },
  { name: 'hevc.mp4', container: 'mp4', codec: /^hvc1\./, fragmented: false, note: 'HEVC in MP4 (only attempted where supported)' },
];

for (const f of FIXTURES) {
  const tag = `[${f.name}]`;
  const p = await page.evaluate((n) => window.pathFor(n), f.name);
  check(`${tag} demuxed: ${f.container}, ${p.codec}, ${p.samples} samples`, p.container === f.container && f.codec.test(p.codec ?? '') && p.samples === 15 && p.keys >= 2 && p.fragmented === f.fragmented, JSON.stringify({ ...p, choice: undefined, expected: undefined }));
  check(`${tag} the path chosen is the one choosePath gives for the browser's isConfigSupported answer (${p.supported})`, p.choice.path === p.expected.path && p.choice.reason === p.expected.reason && p.hasSource === (p.choice.path === 'fast'));
  console.log(`      ${f.note}: ${p.choice.path} - ${p.choice.reason}`);

  if (p.choice.path === 'fast') {
    const c = await page.evaluate(([n, t]) => window.compareDecode(n, t), [f.name, TIMES]);
    const worst = Math.max(...c.out.map((o) => o.same));
    const exact = c.out.every((o) => o.same < TOLERANCE && o.same <= o.neighbour);
    if (f.seekQuirk) check(`${tag} the sequential decoder supplied every picture (the seeked comparison is not asserted for this file)`, c.stats.fast === TIMES.length && c.stats.seek === 0, `worst vs seeked ${worst.toFixed(2)}`);
    else check(`${tag} decoded frames match the seeked frames (mean diff < ${TOLERANCE}, no worse than the next picture)`, exact && c.stats.fast === TIMES.length && c.stats.seek === 0, `worst ${worst.toFixed(2)}, stats ${JSON.stringify(c.stats)}`);
    const g = await againstFfmpeg(f.name);
    check(`${tag} every picture is the one ffmpeg decodes (mean diff < ${TOLERANCE}, closest to its own frame)`, g.count === g.pictures && g.checked >= 13 && g.worst < TOLERANCE && g.wrong === 0, `${g.checked} of ${g.count} pictures, worst ${g.worst.toFixed(2)}, mismatched ${g.wrong}`);
    console.log(`      fast ${c.fastMs.toFixed(0)} ms, seek ${c.slowMs.toFixed(0)} ms; diffs ${c.out.map((o) => `${o.same.toFixed(1)}/${o.neighbour.toFixed(1)}`).join(' ')}`);

    const fast = await page.evaluate((n) => window.fastExport(n), f.name);
    writeFileSync(`${out}/${f.name}.fast.mp4`, Buffer.from(fast.base64, 'base64'));
    const slow = await page.evaluate((n) => window.fastExport(n, { fast: false }), f.name);
    check(`${tag} export: every picture from the sequential decoder`, fast.info.decode.fast > 0 && fast.info.decode.seek === 0 && fast.info.decisions[0]?.path === 'fast', JSON.stringify(fast.info.decode));
    check(`${tag} export: the status says "fast decode" and the result explains the path`, fast.details.some((d) => /Frame \d+ of \d+ · fast decode$/.test(d)) && /WebCodecs/.test(fast.info.decisions[0]?.reason ?? ''), fast.details.at(-1));
    check(`${tag} export: with Fast off every picture is seeked, and the reason says so`, slow.info.decode.fast === 0 && slow.info.decode.seek > 0 && /switched off/.test(slow.info.decisions[0]?.reason ?? ''));
    const n = countFrames(`${out}/${f.name}.fast.mp4`);
    // One frame per 1/15 s of the clip as the browser reports its length (the sidx file reports 1.13 s).
    const expected = Math.round(fast.info.mediaDuration * 15);
    check(`${tag} export: a valid MP4 with one frame per 1/15 s of the clip`, n === expected && n >= 15 && decodeErrors(`${out}/${f.name}.fast.mp4`) === '', `${n} frames, clip ${fast.info.mediaDuration.toFixed(3)} s`);
  } else {
    check(`${tag} falls back to seeking with a reason that names the codec`, p.choice.path === 'seek' && /HEVC|AV1|browser|decode/i.test(p.choice.reason), p.choice.reason);
    // The seeking path needs the browser's media element to play the file. Where it can, the export
    // must finish and say it seeked; where it cannot (HEVC in a build without it), nothing more can be done.
    const ex = await page.evaluate((n) => window.fastExport(n).then((r) => r, (e) => ({ error: String(e?.message ?? e) })), f.name);
    if (ex.error) check(`${tag} the element cannot play it either, so the export is refused with a plain message`, /could not be decoded|decode/i.test(ex.error), ex.error);
    else {
      check(`${tag} the export finished by seeking`, ex.info.decode.fast === 0 && ex.info.decode.seek > 0 && ex.info.decisions[0]?.path === 'seek', JSON.stringify(ex.info.decode));
      check(`${tag} the export status names the reason`, ex.details.some((d) => /seeking /.test(d)) && /seeked/.test(ex.info.summary));
    }
  }
}

// ---- files the fast path must decline cleanly ----------------------------------------------
{
  // Cut inside its last fragment: declined, never mis-read. (The media element refuses such a file
  // too, so the export cannot be run on it; the decision is what matters.)
  const cut = await page.evaluate(() => window.pathFor('h264-frag.mp4', 700));
  check('[truncated] a fragmented MP4 cut inside its last fragment is declined, not mis-read', cut.choice.path === 'seek' && cut.samples === 0 && /cut off|truncated/.test(cut.choice.reason), cut.choice.reason);

  // H.264 with its parameter sets in the stream (avc3): the demuxer leaves it to the element, which plays it.
  const p = await page.evaluate(() => window.pathFor('h264-avc3.mp4'));
  check('[h264-avc3.mp4] declined with a reason', p.choice.path === 'seek' && !p.hasSource && /avc3|parameter sets/.test(p.choice.reason), p.choice.reason);
  const ex = await page.evaluate(() => window.fastExport('h264-avc3.mp4').then((r) => r, (e) => ({ error: String(e?.message ?? e) })));
  if (ex.error) check('[h264-avc3.mp4] the export finishes by seeking', false, ex.error);
  else {
    writeFileSync(`${out}/avc3.mp4`, Buffer.from(ex.base64, 'base64'));
    check('[h264-avc3.mp4] the export still finishes, by seeking', ex.info.decode.fast === 0 && ex.info.decode.seek > 0 && ex.info.decisions[0]?.path === 'seek', JSON.stringify(ex.info.decode));
    check('[h264-avc3.mp4] the status and the result line say why it is seeking', ex.details.some((d) => /seeking h264-avc3\.mp4 \(.*parameter sets/.test(d)) && /seeked h264-avc3\.mp4/.test(ex.info.summary), ex.details.at(-1));
    check('[h264-avc3.mp4] the result is a valid 15-frame MP4', countFrames(`${out}/avc3.mp4`) === 15 && decodeErrors(`${out}/avc3.mp4`) === '');
  }
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll fast-export checks passed');
process.exit(failures ? 1 : 0);
