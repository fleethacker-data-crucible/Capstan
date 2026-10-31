// Prints the command registry as JSON (schema capstan.commands/1): every command with each input's
// type, required flag and allowed values or range. This is the document `commands --json` shows.
//
//   bun scripts/commands.ts              JSON on stdout
//   bun scripts/commands.ts --out FILE   the same, written to FILE as UTF-8 without a byte order mark
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describeCommands } from '../src/engine/commands/registry';

const args = process.argv.slice(2);
let out: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out = args[++i];
  else {
    console.error('Usage: bun scripts/commands.ts [--out FILE]');
    process.exit(2);
  }
}

const text = `${JSON.stringify(describeCommands(), null, 2)}\n`;

if (out !== undefined) {
  const file = resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  // A string is written as UTF-8 with no byte order mark.
  writeFileSync(file, text, 'utf8');
  console.error(`Wrote ${file}`);
} else {
  process.stdout.write(text);
}
