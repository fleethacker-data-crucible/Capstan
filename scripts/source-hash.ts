// Hash of everything that goes into dist/. Line endings are normalised so a Windows checkout
// hashes the same as Linux CI.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function sourceHash(root: string): string {
  const files = [
    ...walk(join(root, 'src')),
    join(root, 'VERSION'),
    join(root, 'scripts/build.ts'),
    join(root, 'vendor/fleet/fleet.css'),
    join(root, 'assets/brand/mark.svg'),
  ].sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(root, f).replaceAll('\\', '/') + '\0');
    h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return h.digest('hex');
}
