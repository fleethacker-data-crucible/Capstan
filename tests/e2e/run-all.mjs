// Runs every tests/e2e/*.e2e.mjs against a test server on a free port, so several runs (or several
// worktrees) never fight over port 8790. Pass name fragments to run only some:
//   node tests/e2e/run-all.mjs annotations record
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';

const only = process.argv.slice(2);
const files = readdirSync('tests/e2e')
  .filter((f) => f.endsWith('.e2e.mjs') && (!only.length || only.some((o) => f.includes(o))))
  .sort();
if (!files.length) {
  console.error('No e2e files match', only.join(' '));
  process.exit(1);
}

const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tests/serve.mjs', String(port)], { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => server.kill();
process.on('exit', stop);

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 100));
}

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [`tests/e2e/${f}`], { stdio: 'inherit', env: { ...process.env, CAPSTAN_URL: base } });
  if (r.status !== 0) {
    failed++;
    console.log(`>>> ${f} FAILED (exit ${r.status})`);
  }
}
stop();
console.log(failed ? `\n${failed} e2e file(s) failed` : '\nAll e2e files passed');
process.exit(failed ? 1 : 0);
