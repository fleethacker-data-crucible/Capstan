// Reads a .cursor.json with Capstan's own parser and prints its counts; exit code 1 (with the reason) when
// the file is refused. Used by tests/ps/CursorCapture.Tests.ps1 to check the host's writer against the real
// parser when bun is on the PATH.  Usage: bun tests/helpers/validate-sidecar.ts <file>
import { readFileSync } from 'node:fs';
import { CURSOR_LIMITS, parseSidecar } from '../../src/engine/cursor';

try {
  const text = readFileSync(process.argv[2], 'utf8');
  const d = parseSidecar(text);
  const ok = d.samples.length <= CURSOR_LIMITS.samples && d.clicks.length <= CURSOR_LIMITS.clicks && d.keys.length <= CURSOR_LIMITS.keys;
  console.log(`samples=${d.samples.length} clicks=${d.clicks.length} keys=${d.keys.length} bytes=${text.length}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(`refused: ${(e as Error).message}`);
  process.exit(1);
}
