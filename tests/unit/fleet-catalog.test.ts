// The editor catalog the PowerShell module loads stays aligned with the command registry,
// and every data-action in the GUI names an action that catalog or the host catalog registers.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeCommands } from '../../src/engine/commands/registry';

const root = join(import.meta.dir, '../..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

test('editor catalog matches the command registry', () => {
  const live = describeCommands();
  const saved = JSON.parse(read('actions/editor-catalog.json'));
  expect(saved.schema).toBe(live.schema);
  expect(saved.commands.map((c: { name: string }) => c.name).sort()).toEqual(live.commands.map((c) => c.name).sort());
  const byName = new Map(saved.commands.map((c: { name: string }) => [c.name, c]));
  for (const cmd of live.commands) {
    const row = byName.get(cmd.name) as { destructive?: boolean; needs: string; inputs: { name: string }[] };
    expect(row.needs).toBe(cmd.needs);
    expect(!!row.destructive).toBe(!!cmd.destructive);
    expect(row.inputs.map((i) => i.name)).toEqual(cmd.inputs.map((i) => i.name));
  }
});

test('host catalog ids are app.noun.verb and session end is not registered twice', () => {
  const host = JSON.parse(read('actions/host-catalog.json')) as { actions: { id: string; noun: string; verb: string }[] };
  const editor = JSON.parse(read('actions/editor-catalog.json')) as { commands: { name: string }[] };
  const editorIds = new Set(editor.commands.filter((c) => c.name !== 'session end').map((c) => 'capstan.' + c.name.replace(' ', '.')));
  for (const action of host.actions) {
    expect(action.id).toBe(`capstan.${action.noun}.${action.verb}`);
    expect(action.id).toMatch(/^capstan\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
    expect(editorIds.has(action.id)).toBe(false);
  }
  expect(host.actions.some((a) => a.id === 'capstan.session.end')).toBe(true);
  expect(host.actions.some((a) => a.id === 'capstan.file.show')).toBe(true);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('every GUI data-action names a registered action', () => {
  const host = JSON.parse(read('actions/host-catalog.json')) as { actions: { id: string }[] };
  const editor = JSON.parse(read('actions/editor-catalog.json')) as { commands: { name: string }[] };
  const ids = new Set<string>([
    ...host.actions.map((a) => a.id),
    ...editor.commands.filter((c) => c.name !== 'session end').map((c) => 'capstan.' + c.name.replace(' ', '.')),
  ]);
  const found: string[] = [];
  for (const file of walk(join(root, 'src'))) {
    if (!/\.(tsx|html|jsx)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    let at = 0;
    while ((at = text.indexOf('data-action', at)) >= 0) {
      const slice = text.slice(at, at + 400);
      for (const m of slice.matchAll(/capstan\.[a-z0-9-]+\.[a-z0-9-]+/g)) found.push(m[0]);
      at += 'data-action'.length;
    }
  }
  expect(found.length).toBeGreaterThan(10);
  for (const id of found) expect(ids.has(id), id).toBe(true);
});

test('the host exposes the action routes and does not log the session token from them', () => {
  const host = read('Start-Capstan.ps1');
  expect(host).toContain('Register-CapstanActions');
  expect(host).toContain('Invoke-CapstanFleetRoute');
  const routes = read('modules/FleetRoutes.ps1');
  expect(routes).toContain("'/api/commands'");
  expect(routes).toContain("'/api/help'");
  expect(routes).toContain("'/api/actions/'");
  expect(routes).toContain("'/api/jobs'");
  expect(routes).not.toMatch(/Write-Host[^\n]*[Tt]oken/);
  expect(routes).not.toContain('ContainsKey');
});
