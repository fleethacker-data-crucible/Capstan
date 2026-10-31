// Test-only static server that mirrors the PowerShell host's routing and security headers,
// so browser tests run on Linux CI. Not shipped; Windows users run Start-Capstan.ps1.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopCapstan } from '../scripts/stop-capstan.mjs';
import { CHUNK_MAX, failNextChunks, handleLibrary } from './library-mirror.mjs';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
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
    res.end(JSON.stringify({ app: 'Capstan', host: 'test-server', offline: true, library: true, libraryMaxBytes: 16 * 1024 ** 3, libraryChunkBytes: CHUNK_MAX }));
    return;
  } else if (url.pathname === '/api/files' || url.pathname.startsWith('/api/files/')) {
    // The on-disk media library (mirror of modules/Library.ps1, files in a temp folder).
    await handleLibrary(req, res, url, { port, token: 'test-token' });
    return;
  } else if (url.pathname === '/api/test/library-fail') {
    // Test-only: the next N chunk uploads answer 500.
    failNextChunks(Number(url.searchParams.get('count') ?? 0));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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
