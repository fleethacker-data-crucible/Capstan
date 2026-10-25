// Off-workstation build: bundles the React/TypeScript editor into dist/ (plain JS + CSS).
// Run with Bun: `bun scripts/build.ts`. The Windows host only ever serves dist/.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceHash } from './source-hash';
import { stopCapstan } from './stop-capstan.mjs';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
const assets = join(dist, 'assets');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
const dev = process.argv.includes('--dev');

// A running host would keep serving the old dist/ from memory-mapped files; stop it first.
stopCapstan('build');

rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, 'src/main.tsx')],
  outdir: assets,
  naming: 'app.js',
  target: 'browser',
  format: 'esm',
  minify: !dev,
  sourcemap: dev ? 'inline' : 'none',
  define: {
    __CAPSTAN_VERSION__: JSON.stringify(version),
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

copyFileSync(join(root, 'src/styles.css'), join(assets, 'app.css'));
copyFileSync(join(root, 'src/icon.svg'), join(assets, 'icon.svg'));
writeFileSync(join(dist, 'index.html'), readFileSync(join(root, 'src/index.html'), 'utf8'));
writeFileSync(join(dist, 'VERSION'), version + '\n');
// Lets CI confirm the committed dist/ was built from the committed sources.
writeFileSync(join(dist, 'SOURCE_HASH'), sourceHash(root) + '\n');

const size = (f: string) => `${(Bun.file(join(assets, f)).size / 1024).toFixed(0)} KB`;
console.log(`Capstan ${version} built: app.js ${size('app.js')}, app.css ${size('app.css')}`);
