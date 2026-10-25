// Build and serve scripts stop any running OpenTape host first (TechStack.md, "Lifecycle rules"):
// a running host serves the old dist/ and holds port 8790. The host only runs on Windows, so
// elsewhere there is nothing to stop. Prints what was stopped.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function stopOpenTape(label = 'OpenTape') {
  if (process.platform !== 'win32') return;
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const r = spawnSync(ps, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Stop-OpenTape.ps1'), '-Quiet'], { encoding: 'utf8' });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.error) console.warn(`[${label}] Could not run Stop-OpenTape.ps1: ${r.error.message}`);
  else console.log(`[${label}] ${text || 'No running OpenTape to stop.'}`);
}
