// Test-only static server that mirrors the PowerShell host's routing and security headers,
// so browser tests run on Linux CI. Not shipped; Windows users run Start-Capstan.ps1.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopCapstan } from '../scripts/stop-capstan.mjs';

// On Windows a running Capstan host holds port 8790; stop it first and say so.
stopCapstan('serve');

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.argv[2] ?? 8790);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};
export const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const heartbeats = [];

// ---- SnapShackle captures (mirror of modules/Captures.ps1; only CAPSTAN_TEST_CAPTURES is read here) ----
// Same paths, status codes and JSON shapes as the host. The folder comes from the test variable only;
// without it the page sees "snapshackle": false, as on a computer with no SnapShackle.
const CAPTURE_TYPES = {
  '.png': ['image/png', 'image'],
  '.jpg': ['image/jpeg', 'image'],
  '.jpeg': ['image/jpeg', 'image'],
  '.webp': ['image/webp', 'image'],
  '.gif': ['image/gif', 'image'],
  '.mp4': ['video/mp4', 'video'],
  '.webm': ['video/webm', 'video'],
};
const CAPTURE_LIMIT = 500;
const OCR_MAX_BYTES = 20480;
const isCaptureName = (n) =>
  typeof n === 'string' &&
  /^[A-Za-z0-9 _.()+-]{1,120}$/.test(n) &&
  !n.includes('..') &&
  !/[. ]$/.test(n) &&
  !n.startsWith(' ') &&
  !!CAPTURE_TYPES[extname(n).toLowerCase()] &&
  !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n.split('.')[0].replace(/ +$/, ''));
async function capturesRoot() {
  const dir = process.env.CAPSTAN_TEST_CAPTURES;
  if (!dir || !isAbsolute(dir)) return null;
  try {
    const st = await lstat(resolve(dir));
    return st.isDirectory() && !st.isSymbolicLink() ? resolve(dir) : null;
  } catch {
    return null;
  }
}
async function plainFile(root, leaf) {
  try {
    const full = resolve(root, leaf);
    if (resolve(full, '..') !== root) return null;
    const st = await lstat(full);
    return st.isFile() && !st.isSymbolicLink() ? { full, st } : null;
  } catch {
    return null;
  }
}
async function readOcr(root, name) {
  const f = await plainFile(root, `${name}.meta.json`);
  if (!f || f.st.size > 524288) return '';
  try {
    const ocr = JSON.parse((await readFile(f.full, 'utf8')).replace(/^\uFEFF/, '')).ocr;
    if (typeof ocr !== 'string') return '';
    let buf = Buffer.from(ocr, 'utf8');
    if (buf.length > OCR_MAX_BYTES) buf = buf.subarray(0, OCR_MAX_BYTES);
    return buf.toString('utf8').replace(/\uFFFD+$/, '');
  } catch {
    return '';
  }
}
async function captureList(root) {
  const usable = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isFile() || !isCaptureName(e.name)) continue;
    const st = await lstat(join(root, e.name));
    usable.push({ name: e.name, size: st.size, mtime: st.mtimeMs });
  }
  usable.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const captures = [];
  for (const f of usable.slice(0, CAPTURE_LIMIT)) {
    const ocr = await readOcr(root, f.name);
    captures.push({ name: f.name, size: f.size, modified: new Date(f.mtime).toISOString(), kind: CAPTURE_TYPES[extname(f.name).toLowerCase()][1], hasOcr: ocr.trim() !== '', ocr });
  }
  return { captures, total: usable.length, limit: CAPTURE_LIMIT };
}
async function handleCaptures(req, res, rawPath) {
  const json = (status, body, extra = {}) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, ...extra }).end(JSON.stringify(body));
  if (req.headers['x-capstan-token'] !== 'test-token') return json(403, { error: 'Invalid session' });
  const base = '/api/snapshackle/captures';
  const p = rawPath.split(/[?#]/)[0];
  const isList = p === base || p === `${base}/`;
  if (!isList && !p.startsWith(`${base}/`)) return json(404, { error: 'Route not found' });
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, { allow: 'GET' });
  const root = await capturesRoot();
  if (!root) return json(404, { error: 'No SnapShackle captures folder found' });
  if (isList) return json(200, await captureList(root));
  let name = null;
  try {
    name = decodeURIComponent(p.slice(base.length + 1));
  } catch {
    name = null;
  }
  if (!isCaptureName(name)) return json(400, { error: 'Invalid capture name' });
  const file = await plainFile(root, name);
  if (!file) return json(404, { error: 'Capture not found' });
  res.writeHead(200, {
    'content-type': CAPTURE_TYPES[extname(name).toLowerCase()][0],
    'content-length': file.st.size,
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file.full, { highWaterMark: 1048576 }).on('error', () => res.destroy()).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/snapshackle/captures' || url.pathname.startsWith('/api/snapshackle/captures/')) {
    await handleCaptures(req, res, req.url ?? '/');
    return;
  }
  let file;
  if (url.pathname === '/') file = join(root, 'dist/index.html');
  else if (url.pathname.startsWith('/assets/')) file = join(root, 'dist', normalize(url.pathname));
  else if (url.pathname.startsWith('/fixtures/')) file = join(root, 'tests', normalize(url.pathname));
  else if (url.pathname === '/harness') file = join(root, 'tests/e2e/harness.html');
  else if (url.pathname.startsWith('/e2e/')) file = join(root, 'tests/e2e', normalize(url.pathname.slice(5)));
  else if (url.pathname === '/harness.js') file = join(root, 'tests/e2e/.build/harness.js');
  else if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
    // Mirrors the host: token in X-Capstan-Token, or in the JSON body for this route only (sendBeacon).
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {}
    const token = req.headers['x-capstan-token'] ?? body.session;
    if (token !== 'test-token') {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    heartbeats.push({ tab: body.tab, leaving: !!body.leaving, busy: !!body.busy, hidden: !!body.hidden, header: !!req.headers['x-capstan-token'] });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, autoStop: false }));
    return;
  } else if (url.pathname === '/api/test/heartbeats') {
    // Test-only: what the page sent, so e2e tests can check the lifecycle signals.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(heartbeats));
    return;
  } else if (url.pathname === '/api/session/stop' && req.method === 'POST') {
    // The test server keeps running so later suites still work; it only records the request.
    const ok = req.headers['x-capstan-token'] === 'test-token';
    if (ok) heartbeats.push({ stop: true });
    res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { ok: true, stopping: true } : { error: 'Invalid session' }));
    return;
  } else if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'Capstan', host: 'test-server', offline: true, snapshackle: !!(await capturesRoot()) }));
    return;
  }
  if (!file || !file.startsWith(root)) {
    res.writeHead(404).end();
    return;
  }
  try {
    let body = await readFile(file);
    if (file.endsWith('index.html')) body = Buffer.from(body.toString().replaceAll('__SESSION_TOKEN__', 'test-token'));
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`test server http://127.0.0.1:${port}/`));
