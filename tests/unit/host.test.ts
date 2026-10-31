// Static checks for the Windows host. PowerShell does not run on the Linux build machine, so
// these keep Start-Capstan.ps1, the launcher and dist/ from drifting apart.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const host = read('Start-Capstan.ps1');

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
  const bat = read('Launch-Capstan.bat');
  expect(bat).toContain('\r\n');
  expect(bat).toContain('Start-Capstan.ps1');
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

// ---- Lifecycle (TechStack.md, "Lifecycle rules"). The behaviour itself is exercised on Windows by
// tests/ps/Lifecycle.Tests.ps1; these keep the pieces wired together on every platform.
const lifecycle = read('modules/Lifecycle.ps1');
const csharpBlocks = (text: string) => [...text.matchAll(/Add-Type -TypeDefinition @'([\s\S]*?)'@/g)].map((m) => m[1]);

test('Add-Type C# stays within C# 5 (.NET Framework 4.8.1 compiler)', () => {
  for (const cs of [...csharpBlocks(lifecycle), ...csharpBlocks(read('modules/LocalHttp.ps1')), ...csharpBlocks(read('modules/Speech.ps1'))]) {
    expect(cs).not.toMatch(/\?\.|\$"|\bnameof\b|\bout var\b|\)\s*=>/);
  }
});

test('presence rule: 20 s heartbeat timeout, 5 s leaving grace, waits for jobs', () => {
  expect(lifecycle).toContain('HeartbeatTimeout = TimeSpan.FromSeconds(20)');
  expect(lifecycle).toContain('LeavingGrace = TimeSpan.FromSeconds(5)');
  expect(lifecycle).toMatch(/if \(!Enabled \|\| !seen \|\| jobs > 0\) return false;/);
});

test('host wires the heartbeat, End session, runtime file and off switch', () => {
  expect(host).toContain("modules/Lifecycle.ps1");
  expect(host).toContain("'/api/heartbeat'");
  expect(host).toContain("'/api/session/stop'");
  expect(host).toContain('$server.TryAccept(');
  expect(host).toContain('Write-CapstanRuntimeFile');
  expect(host).toMatch(/finally \{[\s\S]*Remove-CapstanRuntimeFile/);
  expect(lifecycle).toContain('CAPSTAN_AUTO_STOP');
  expect(host).toMatch(/'\^--\?stay\$'/);
  expect(host).toMatch(/'\^--\?replace\$'/);
  expect(host).toContain('Stop it and start fresh?');
});

test('session token in a body is accepted on the heartbeat route only, never from the query string', () => {
  const bodyTokenUses = [...host.matchAll(/Get-CapstanBodyText \$body 'session'/g)];
  expect(bodyTokenUses.length).toBe(1);
  const heartbeat = host.slice(host.indexOf("if ($path -eq '/api/heartbeat'"), host.indexOf('# Everything below needs'));
  expect(heartbeat).toContain("Get-CapstanBodyText $body 'session'");
  expect(host).not.toMatch(/QueryString/);
  // The runtime file is written without the token.
  expect(lifecycle).not.toContain('$sessionToken');
  const runtimeFn = lifecycle.slice(lifecycle.indexOf('function Write-CapstanRuntimeFile'), lifecycle.indexOf('function Remove-CapstanRuntimeFile'));
  expect(runtimeFn).toContain('pid = $PID; port = $Port; url = $Url; startedAt');
  expect(runtimeFn.replace(/<#[\s\S]*?#>/, '')).not.toMatch(/token|session/i);
});

test('Stop-Capstan.ps1 finds hosts by runtime file and command line', () => {
  const stop = read('Stop-Capstan.ps1');
  expect(stop).toContain('Stop-CapstanProcesses');
  expect(lifecycle).toContain("capstan-server-*.json");
  expect(lifecycle).toContain('Test-CapstanProcessCommandLine');
  expect(lifecycle).toContain('[regex]::Escape($scriptPath)');
});

test('build and test server stop a running host first', () => {
  expect(read('scripts/build.ts')).toContain("stopCapstan('build')");
  expect(read('tests/serve.mjs')).toContain("stopCapstan('serve')");
});

test('built UI sends the heartbeat and the leaving beacon', () => {
  const js = read('dist/assets/app.js');
  expect(js).toContain('/api/heartbeat');
  expect(js).toContain('sendBeacon');
  expect(js).toContain('/api/session/stop');
  expect(js).toContain('End session');
});

test('PowerShell files are ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
  for (const f of ['Start-Capstan.ps1', 'Stop-Capstan.ps1', 'modules/Lifecycle.ps1', 'modules/LocalHttp.ps1', 'tests/ps/Lifecycle.Tests.ps1']) {
    expect(/[^\x00-\x7f]/.test(read(f))).toBe(false);
  }
});

// ---- Speech-to-text (modules/Speech.ps1, issue #24). The behaviour is exercised on Windows by tests/ps/Speech.Tests.ps1.
const speech = read('modules/Speech.ps1');

test('speech routes sit behind the session token, and the token never comes from the query string', () => {
  const tokenCheck = host.indexOf("$request.Headers['X-Capstan-Token'] -ne $sessionToken");
  const route = host.indexOf("'/api/speech/'");
  expect(tokenCheck).toBeGreaterThan(0);
  expect(route).toBeGreaterThan(tokenCheck);
  expect(host).toContain('Invoke-CapstanSpeechRoute');
  expect(host).toContain('Stop-CapstanSpeech');
  expect(speech).not.toMatch(/QueryString|X-Capstan-Token/);
});

test('speech: the fake engine is only reachable through CAPSTAN_SPEECH_ENGINE=fake', () => {
  expect(speech.match(/'fake'/g)!.length).toBeGreaterThan(0);
  expect(speech).toContain("$env:CAPSTAN_SPEECH_ENGINE -eq 'fake'");
  const code = speech.replace(/<#[\s\S]*?#>/, '');
  expect(code.match(/\$env:CAPSTAN_SPEECH_ENGINE/g)!.length).toBe(1); // one place decides
  expect(host).not.toContain('CAPSTAN_SPEECH');
  expect(read('modules/LocalHttp.ps1')).not.toContain('CAPSTAN_SPEECH');
});

test('speech: files are named from a host-made job id under %LOCALAPPDATA%\Capstan\tmp, never from the request', () => {
  expect(speech).toContain("'^[0-9a-f]{32}$'");
  expect(speech).toContain("'Capstan'");
  expect(speech).toContain('ReparsePoint');
  expect(speech).toContain('FileMode]::CreateNew');
  expect(speech).toContain('1048576'); // written in 1 MB buffers
  const route = speech.slice(speech.indexOf('function Start-CapstanSpeechJob'), speech.indexOf('function Invoke-CapstanSpeechRoute'));
  expect(route).not.toMatch(/Get-CapstanSpeechQueryValue \$Query '(path|file|name)'/);
});

test('speech: requests are limited to 30 MB WAV bodies and errors carry no exception text', () => {
  expect(speech).toContain('$script:SpeechMaxBytes = 30000000');
  expect(speech).toContain("New-CapstanSpeechError 413 'too-big'");
  const catchAll = speech.slice(speech.indexOf('} catch {', speech.indexOf('function Invoke-CapstanSpeechRoute')));
  expect(catchAll).not.toContain('$_.Exception.Message');
  expect(speech).not.toMatch(/-Message \$_|\$_\.Exception/);
});

