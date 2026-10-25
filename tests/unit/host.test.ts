// Static checks for the Windows host. PowerShell does not run on the Linux build machine, so
// these keep Start-OpenTape.ps1, the launcher and dist/ from drifting apart.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const host = read('Start-OpenTape.ps1');

test('every file the host serves exists in dist/', () => {
  const files = [...host.matchAll(/File='([^']+)'/g)].map((m) => m[1]);
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const f of files) expect(existsSync(join(root, 'dist', f))).toBe(true);
});

test('index.html carries the session token placeholder', () => {
  expect(read('dist/index.html')).toContain('__SESSION_TOKEN__');
});

test('test server and Windows host send the same Content-Security-Policy', () => {
  const psCsp = /\$ContentSecurityPolicy = "([^"]+)"/.exec(host)?.[1];
  const nodeCsp = /export const CSP =\s*"([^"]+)"/.exec(read('tests/serve.mjs'))?.[1];
  expect(psCsp).toBeTruthy();
  expect(psCsp).toBe(nodeCsp!);
  expect(psCsp).not.toContain('unsafe-inline');
});

test('host binds loopback only and checks Host, Origin and fetch site', () => {
  const transport = read('modules/LocalHttp.ps1');
  expect(transport).toContain('IPAddress.Loopback');
  expect(transport).not.toMatch(/IPAddress\.Any/);
  expect(host).toContain("Sec-Fetch-Site");
  expect(host).toContain("Origin is not authorized");
});

test('launcher uses Windows PowerShell 5.1, CRLF and the right script', () => {
  const bat = read('OpenTape.bat');
  expect(bat).toContain('\r\n');
  expect(bat).toContain('Start-OpenTape.ps1');
  expect(bat).toContain('WindowsPowerShell\\v1.0\\powershell.exe');
  expect(bat).not.toMatch(/Lasso/);
});

test('built bundle loads nothing from the network', () => {
  const js = read('dist/assets/app.js');
  const css = read('dist/assets/app.css');
  for (const text of [js, css, read('dist/index.html')]) {
    expect(text).not.toMatch(/https?:\/\/(cdn|unpkg|fonts\.googleapis|cdnjs)/);
  }
});

test('dist matches VERSION', () => {
  expect(read('dist/VERSION').trim()).toBe(read('VERSION').trim());
});

test('committed dist/ was built from the current sources (run `bun run build`)', async () => {
  const { sourceHash } = await import('../../scripts/source-hash');
  expect(read('dist/SOURCE_HASH').trim()).toBe(sourceHash(root));
});
