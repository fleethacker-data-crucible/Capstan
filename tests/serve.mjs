// Test-only static server that mirrors the PowerShell host's routing and security headers,
// so browser tests run on Linux CI. Not shipped; Windows users run Start-Capstan.ps1.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  let file;
  if (url.pathname === '/') file = join(root, 'dist/index.html');
  else if (url.pathname.startsWith('/assets/')) file = join(root, 'dist', normalize(url.pathname));
  else if (url.pathname.startsWith('/fixtures/')) file = join(root, 'tests', normalize(url.pathname));
  else if (url.pathname === '/harness') file = join(root, 'tests/e2e/harness.html');
  else if (url.pathname === '/harness.js') file = join(root, 'tests/e2e/.build/harness.js');
  else if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ app: 'Capstan', host: 'test-server', offline: true }));
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
