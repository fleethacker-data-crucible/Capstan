// Exports a fixture timeline in headless Chromium and validates the MP4 with ffprobe/ffmpeg.
// Usage: node tests/e2e/export.e2e.mjs   (expects tests/serve.mjs on port 8790)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = process.env.CAPSTAN_URL ?? 'http://127.0.0.1:8790';
const outDir = 'tests/e2e/.out';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[browser]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`${base}/harness`);
await page.waitForFunction(() => document.title === 'harness-ready');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

for (const audio of [true, false]) {
  const t0 = Date.now();
  const { base64, info } = await page.evaluate((a) => window.runExport({ audio: a }), audio);
  const file = `${outDir}/export-${audio ? 'av' : 'v'}.mp4`;
  writeFileSync(file, Buffer.from(base64, 'base64'));
  console.log(`exported ${file} in ${Date.now() - t0} ms`, JSON.stringify(info));

  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString(),
  );
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  check(`[${audio ? 'a+v' : 'v'}] has H.264 video`, v?.codec_name === 'h264', v?.codec_name);
  check(`[${audio ? 'a+v' : 'v'}] 640x360`, v?.width === 640 && v?.height === 360, `${v?.width}x${v?.height}`);
  const dur = Number(probe.format.duration);
  check(`[${audio ? 'a+v' : 'v'}] duration ≈ 8s`, Math.abs(dur - 8) < 0.15, String(dur));
  const frames = Number(
    execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString().trim(),
  );
  check(`[${audio ? 'a+v' : 'v'}] 240 decodable frames`, frames === 240, String(frames));
  if (audio) {
    check('[a+v] has audio track', !!a && ['aac', 'opus'].includes(a.codec_name), a?.codec_name);
    check('[a+v] audio 48 kHz stereo', a?.sample_rate === '48000' && a?.channels === 2, `${a?.sample_rate} ${a?.channels}`);
    // The tone clip covers 4.5-6.5s and the videos' own audio ends at 4s, so 7-8s is silent.
    const db = (from, len) => {
      // No shell: run ffmpeg directly and read volumedetect's report from stderr (exit code ignored, as before).
      const r = spawnSync('ffmpeg', ['-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const m = /mean_volume: (-?[\d.]+|-inf)/.exec(out);
      return m ? Number(m[1].replace('-inf', '-999')) : -999;
    };
    const loud = db(5, 1);
    const quiet = db(7, 0.9);
    check('[a+v] tone audible at 5s', loud > -30, `${loud} dB`);
    check('[a+v] silence at 7s', !(quiet > -60), `${quiet} dB`);
  } else {
    check('[v] no audio track', !a);
  }
  // Full decode must be error-free.
  let decodeErrors = '';
  try {
    decodeErrors = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    decodeErrors = String(e.stderr ?? e);
  }
  check(`[${audio ? 'a+v' : 'v'}] clean full decode`, decodeErrors.trim() === '', decodeErrors.slice(0, 200));
  // Spot-check content: frame at 5s is the blue card, frame at 2s has the moving test pattern.
  for (const [t, label] of [[2, 'video'], [5, 'card']]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', `${outDir}/frame-${label}.png`]);
  }
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-ss', '5', '-i', file, '-frames:v', '1', '-vf', 'crop=10:10:120:40,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  check(`[${audio ? 'a+v' : 'v'}] card is blue at 5s`, rgb[2] > 150 && rgb[0] < 80, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll export checks passed');
process.exit(failures ? 1 : 0);
