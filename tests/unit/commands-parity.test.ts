// Parity between the GUI and the command registry.
//
// 1. PARITY. src/engine/commands/inventory.ts lists every user-visible editor action and the command
//    that does the same. Every entry must name a registered command, and every registered command
//    must be used by at least one entry or be marked `cliOnly: true`.
//
// 2. UI RATCHET. Today most UI files call the engine's edit operations directly (ops, editops,
//    annotationOps, ...) instead of going through the command registry. Rewriting every handler is out of
//    scope for the change that added the registry, so this test only stops it getting worse: it counts,
//    per file under src/ui, the operation functions imported from the engine's edit modules, and
//    compares the counts with the committed allowlist tests/unit/ui-direct-ops.allowlist.json. A file
//    that is not on the list, or whose count grew, fails the test. When a handler is moved onto the
//    registry, lower the file's number (or delete its line): the list should only ever shrink.
//    To regenerate it after lowering counts: UPDATE_UI_OPS_ALLOWLIST=1 bun test tests/unit/commands-parity.test.ts
//    (this refuses to raise a count or add a file).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWLIST, type Counts, KNOWN_EDIT_MODULES, directOpImports, findEditModules, root, scanUi } from './helpers/ui-ops-scan';
import { GUI_ACTIONS } from '../../src/engine/commands/inventory';
import { COMMAND_NAME, listCommands } from '../../src/engine/commands/registry';

const root = join(import.meta.dir, '..', '..');
const commands = listCommands();
const names = new Set(commands.map((c) => c.name));

describe('GUI parity', () => {
  test('there is an inventory with real entries', () => {
    expect(GUI_ACTIONS.length).toBeGreaterThan(100);
  });

  test('ids are unique and read <place>.<action>', () => {
    const ids = GUI_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of GUI_ACTIONS) {
      expect(a.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
      expect(a.area.length).toBeGreaterThan(2);
      expect(a.label.length).toBeGreaterThan(2);
    }
  });

  test('every inventory entry names a registered command', () => {
    const missing = GUI_ACTIONS.filter((a) => !names.has(a.command)).map((a) => `${a.id} -> ${a.command}`);
    expect(missing).toEqual([]);
    for (const a of GUI_ACTIONS) expect(a.command).toMatch(COMMAND_NAME);
  });

  test('every registered command is used by an inventory entry, or is marked cliOnly', () => {
    const used = new Set(GUI_ACTIONS.map((a) => a.command));
    const orphans = commands.filter((c) => !used.has(c.name) && !c.cliOnly).map((c) => c.name);
    expect(orphans).toEqual([]);
  });

  test('a cliOnly command is not also reachable from the GUI', () => {
    const used = new Set(GUI_ACTIONS.map((a) => a.command));
    expect(commands.filter((c) => c.cliOnly && used.has(c.name)).map((c) => c.name)).toEqual([]);
  });

  test('browser-only commands are in the inventory, so the bridge has a list to implement', () => {
    const used = new Set(GUI_ACTIONS.map((a) => a.command));
    for (const c of commands.filter((x) => x.needs === 'browser')) expect(used.has(c.name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// UI ratchet
// ---------------------------------------------------------------------------------------------

function loadAllowlist(): Counts {
  const doc = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as { files: Counts };
  return doc.files;
}

describe('UI ratchet: new UI code calls the command registry, not the edit operations', () => {
  const modules = new Set([...KNOWN_EDIT_MODULES, ...findEditModules()]);
  const counts = scanUi(modules);

  test('the scanner finds the edit modules and the imports it should', () => {
    for (const m of KNOWN_EDIT_MODULES) expect(existsSync(join(root, 'src', 'engine', `${m}.ts`))).toBe(true);
    for (const m of ['ops', 'editops', 'annotationOps', 'captionops', 'markers', 'zoom', 'animate', 'fx-ops', 'audioops', 'cursorops', 'range']) {
      expect(modules.has(m)).toBe(true);
    }
    // Models, parsers and the like are not edit modules.
    for (const m of ['project', 'anim', 'player', 'compositor', 'storage']) expect(modules.has(m)).toBe(false);
    expect(Object.keys(counts).length).toBeGreaterThan(10);
  });

  test('the scanner reads imports the way it claims to', () => {
    const set = new Set(['ops', 'zoom']);
    const src = [
      "import { addTrack, type Foo, removeTrack as drop } from '../engine/ops';",
      "import type { Bar } from '../engine/zoom';",
      "import { a,\n  b } from '../../engine/zoom';",
      "import { x } from '../engine/project';",
      "import * as all from '../engine/ops';",
    ].join('\n');
    expect(directOpImports(src, set).sort()).toEqual(['ops.*', 'ops.addTrack', 'ops.removeTrack', 'zoom.a', 'zoom.b']);
  });

  test('the allowlist is committed and well formed', () => {
    const list = loadAllowlist();
    for (const [file, n] of Object.entries(list)) {
      expect(file.startsWith('src/ui/')).toBe(true);
      expect(Number.isInteger(n) && n > 0).toBe(true);
      expect(existsSync(join(root, file))).toBe(true);
    }
  });

  test('no UI file imports edit operations that are not on the allowlist, and no count grows', () => {
    const list = loadAllowlist();
    const problems: string[] = [];
    for (const [file, n] of Object.entries(counts)) {
      if (!(file in list)) problems.push(`${file} imports ${n} engine edit operation(s) and is not on the allowlist`);
      else if (n > list[file]) problems.push(`${file} imports ${n} engine edit operation(s); the allowlist allows ${list[file]}`);
    }
    if (problems.length) {
      throw new Error(
        `${problems.join('\n')}\n\nDo not call the engine's edit operations (ops, editops, annotationOps ...) from the UI. ` +
          'Call the command registry instead (src/engine/commands: runCommand), so the GUI and the command line share one code path. ' +
          'If a command is missing, add it there and list the action in src/engine/commands/inventory.ts. ' +
          'tests/unit/ui-direct-ops.allowlist.json may only shrink.',
      );
    }
  });

  // Run with UPDATE_UI_OPS_ALLOWLIST=1 after moving handlers onto the registry: lowers counts and drops files
  // that no longer import edit operations. It never raises a count or adds a file.
  test.skipIf(process.env.UPDATE_UI_OPS_ALLOWLIST !== '1')('rewrites the allowlist with the lower counts', () => {
    const list = loadAllowlist();
    const next: Counts = {};
    for (const [f, n] of Object.entries(counts)) if (f in list) next[f] = Math.min(n, list[f]);
    writeFileSync(ALLOWLIST, `${JSON.stringify({ comment: COMMENT, files: next }, null, 2)}
`, 'utf8');
  });
});

const COMMENT =
  'Per file under src/ui: how many engine edit operations it imports directly. May only shrink. New UI code calls the command registry (src/engine/commands) instead. See tests/unit/commands-parity.test.ts.';
