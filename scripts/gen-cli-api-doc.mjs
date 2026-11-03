// Builds docs/CLI-API.md from the editor catalog and the host catalog.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const editor = JSON.parse(readFileSync(join(root, 'actions/editor-catalog.json'), 'utf8'));
const host = JSON.parse(readFileSync(join(root, 'actions/host-catalog.json'), 'utf8'));

function flag(name) {
  return '--' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function sampleValue(input, forCli) {
  if (input.type === 'boolean') return forCli ? 'true' : true;
  if (input.type === 'number') return input.min ?? 1;
  if (input.type === 'enum') return input.values[0];
  if (input.type === 'id') return input.many ? (forCli ? 'id_a,id_b' : ['id_a', 'id_b']) : 'id_example';
  if (input.type === 'json') return forCli ? '{"example":true}' : { example: true };
  return 'example';
}

function sampleFromInputs(inputs, atLeastOne, forCli) {
  const args = {};
  const needed = new Set((inputs ?? []).filter((i) => i.required).map((i) => i.name));
  for (const name of atLeastOne ?? []) needed.add(name);
  for (const input of inputs ?? []) {
    if (needed.has(input.name)) args[input.name] = sampleValue(input, forCli);
  }
  return args;
}

function cliFromArgs(noun, verb, args) {
  const parts = [`capstan.ps1 ${noun} ${verb}`];
  for (const [key, value] of Object.entries(args)) {
    parts.push(flag(key));
    parts.push(typeof value === 'string' ? value : JSON.stringify(value));
  }
  parts.push('--json');
  return parts.join(' ');
}

const page = editor.commands
  .filter((c) => c.name !== 'session end')
  .map((c) => {
    const [noun, verb] = c.name.split(' ');
    const args = sampleFromInputs(c.inputs, c.atLeastOne, false);
    const cliArgs = sampleFromInputs(c.inputs, c.atLeastOne, true);
    return {
      id: `capstan.${noun}.${verb}`,
      noun,
      verb,
      summary: c.summary,
      destructive: !!c.destructive,
      needs: 'page',
      exampleArgs: args,
      cli: cliFromArgs(noun, verb, cliArgs),
    };
  });

const hostRows = host.actions.filter((a) => a.id !== 'capstan.job.run').map((a) => ({
  id: a.id,
  noun: a.noun,
  verb: a.verb,
  summary: a.summary,
  destructive: !!a.destructive,
  needs: 'host',
  exampleArgs: a.exampleArgs ?? {},
  cli: cliFromArgs(a.noun, a.verb, a.exampleArgs ?? {}),
}));

const actions = [...hostRows, ...page].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function job(action) {
  const [app, noun, verb] = action.id.split('.');
  return JSON.stringify({
    version: 1,
    steps: [{ id: 'step', app, noun, verb, args: action.exampleArgs }],
  }, null, 2);
}

function curl(action) {
  const body = JSON.stringify({ args: action.exampleArgs, dryRun: action.needs === 'page', confirmed: false });
  return `curl -sS -X POST http://127.0.0.1:8790/api/actions/${action.id} -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data '${body}'`;
}

const lines = [];
lines.push('# Capstan CLI and API');
lines.push('');
lines.push('Capstan actions follow the Fleet action framework. An action id is `capstan.<noun>.<verb>`. The CLI, the local API, and the buttons marked `data-action` name the same action. Host actions run in Windows PowerShell 5.1. Editor actions run in the open Capstan page, because they need the project, the media bytes, or a browser encoder.');
lines.push('');
lines.push('Discovery is `capstan.ps1 commands --json`. `capstan.ps1 help --json` prints the same FleetAction envelope (`v` 1, `result.actions`). `--yes` maps to `-Confirmed`.');
lines.push('');
lines.push('```powershell');
lines.push('capstan.ps1 commands --json');
lines.push('capstan.ps1 help --json');
lines.push('capstan.ps1 <noun> <verb> [--json] [--out FILE] [--yes] [--dry-run] [--option value]');
lines.push('capstan.ps1 job run --file examples/training-to-course.job.json --json');
lines.push('```');
lines.push('');
lines.push('`--yes` maps to the parameter `-Confirmed`. A destructive action does nothing without it. `--dry-run` does not change anything and does not need `--yes`. `--out FILE` writes the JSON document as UTF-8 without a BOM. `--json` prints one JSON object on standard output.');
lines.push('');
lines.push('Exit codes: `0` success, `2` `E_ARGS`, `3` `E_NOT_FOUND`, `4` `E_CONFIRM` (destructive without `--yes`), `1` `E_INTERNAL`.');
lines.push('');
lines.push('Job files are JSON only, version 1, with a `steps` array (`app`, `noun`, `verb`, `args`). The noun `job` is reserved for `capstan.ps1 job run`.');
lines.push('');
lines.push('The API is on the same loopback listener as the editor, `http://127.0.0.1:<port>/` (8790 unless that port is taken). Send the session token in the `X-Capstan-Token` header. Do not put it in the URL, the command line, a job file, or HTML. The examples below use `$CAPSTAN_TOKEN` for that header.');
lines.push('');
lines.push('| Method | Path |');
lines.push('| --- | --- |');
lines.push('| GET | `/api/commands` |');
lines.push('| GET | `/api/help` |');
lines.push('| POST | `/api/actions/<app.noun.verb>` |');
lines.push('| POST | `/api/jobs` |');
lines.push('');
lines.push('A POST body is `{ "args": { }, "confirmed": false, "dryRun": false }`.');
lines.push('');
lines.push('## Training to course');
lines.push('');
lines.push('SnapShackle writes captures. Capstan reads them and a `.capstan` project, then writes the chapter list and captions Scrimshaw can attach to the lesson. The job is [examples/training-to-course.job.json](../examples/training-to-course.job.json). Run it from the repository root.');
lines.push('');
lines.push('```powershell');
lines.push('capstan.ps1 job run --file examples/training-to-course.job.json --json');
lines.push('```');
lines.push('');
lines.push('```json');
lines.push(readFileSync(join(root, 'examples/training-to-course.job.json'), 'utf8').trimEnd());
lines.push('```');
lines.push('');
lines.push('```bash');
lines.push('curl -sS -X POST http://127.0.0.1:8790/api/jobs -H "Content-Type: application/json" -H "X-Capstan-Token: $CAPSTAN_TOKEN" --data @examples/training-to-course.job.json');
lines.push('```');
lines.push('');
lines.push(`## Actions (${actions.length})`);
lines.push('');
lines.push('Page actions answer `needs-browser` when nothing is editing. Pass `--dry-run` to check the options. Destructive actions need `--yes`.');
lines.push('');

for (const action of actions) {
  lines.push(`### ${action.id}`);
  lines.push('');
  lines.push(action.summary + (action.destructive ? ' Destructive: pass `--yes`.' : '') + (action.needs === 'page' ? ' Runs in the open editor.' : ' Runs in PowerShell.'));
  lines.push('');
  lines.push('```powershell');
  lines.push(action.cli);
  lines.push('```');
  lines.push('');
  lines.push('```json');
  lines.push(job(action));
  lines.push('```');
  lines.push('');
  lines.push('```bash');
  lines.push(curl(action));
  lines.push('```');
  lines.push('');
}

writeFileSync(join(root, 'docs/CLI-API.md'), lines.join('\n'));
console.log('wrote', actions.length, 'actions');
