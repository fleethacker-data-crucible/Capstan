// docs/CLI.md against the command registry: the generated table is current (`gen-cli-doc.ts --check`),
// every registered command is in it, and the hand-written parts keep to what is built.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeCommands, listCommands } from '../../src/engine/commands/registry';
import { CLI_DOC_PATH, END_MARKER, START_MARKER, applyCommandsBlock, cell, checkCliDoc, describeOption, renderCommandsBlock } from '../../scripts/gen-cli-doc';

const root = join(import.meta.dir, '..', '..');
const doc = readFileSync(CLI_DOC_PATH, 'utf8');
const block = doc.slice(doc.indexOf(START_MARKER) + START_MARKER.length, doc.indexOf(END_MARKER));
const rows = block
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) => line.split(/(?<!\\)\|/).map((c) => c.trim()));

function runCheck(): { status: number | null; stderr: string } {
  const run = Bun.spawnSync([process.execPath, join(root, 'scripts', 'gen-cli-doc.ts'), '--check'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { status: run.exitCode, stderr: run.stderr.toString() };
}

describe('markdown table cells', () => {
  test('backslashes are escaped before pipes, and whitespace becomes one space', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('a\\b')).toBe('a\\\\b');
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('a\nb\tc')).toBe('a b c');
  });
});

describe('docs/CLI.md', () => {
  test('`gen-cli-doc.ts --check` passes: the commands table is current', () => {
    const result = runCheck();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(checkCliDoc().upToDate).toBe(true);
  });

  test('every registered command has a row, and every row is a registered command', () => {
    const registered = listCommands().map((c) => c.name);
    const listed = rows.map((r) => r[1].replaceAll('`', ''));
    expect(registered.length).toBeGreaterThan(100);
    expect(listed.sort()).toEqual([...registered].sort());
    for (const name of registered) expect(doc).toContain(`| \`${name}\` |`);
  });

  test('each row says what the command does, marks browser-only and destructive commands, and lists every option', () => {
    const byName = new Map(describeCommands().commands.map((c) => [c.name, c]));
    for (const r of rows) {
      const c = byName.get(r[1].replaceAll('`', ''));
      expect(c).toBeDefined();
      if (!c) continue;
      expect(r[2].length).toBeGreaterThan(10);
      expect(r[2].includes('Browser only.')).toBe(c.needs === 'browser');
      expect(r[2].includes('**Needs `--yes`.**')).toBe(c.destructive);
      for (const input of c.inputs) expect(r[3]).toContain(describeOption(input));
      if (c.inputs.length === 0) expect(r[3]).toBe('');
    }
  });

  test('the counts in the table are the registry’s', () => {
    const all = listCommands();
    const browser = all.filter((c) => c.needs === 'browser').length;
    const text = `${all.length} commands: ${all.length - browser} run over plain project data and ${browser} are browser only`;
    expect(block).toContain(text);
    expect(block).toContain(`${all.filter((c) => c.destructive).length} need \`--yes\`.`);
  });

  test('an out-of-date table is noticed and put right', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capstan-cli-doc-'));
    try {
      const file = join(dir, 'CLI.md');
      const cases: Array<[string, string]> = [
        ['a command row removed', doc.replace(/^\| `clip split` .*\n/m, '')],
        ['a summary edited by hand', doc.replace('| `clip split` | ', '| `clip split` | Edited by hand. ')],
        ['an empty table', `${doc.slice(0, doc.indexOf(START_MARKER))}${START_MARKER}\n${END_MARKER}${doc.slice(doc.indexOf(END_MARKER) + END_MARKER.length)}`],
      ];
      for (const [what, stale] of cases) {
        expect(stale).not.toBe(doc);
        writeFileSync(file, stale);
        const found = checkCliDoc(file);
        expect([what, found.upToDate]).toEqual([what, false]);
        expect(found.expected).toBe(doc);
      }
      writeFileSync(file, `﻿${doc.replaceAll('\n', '\r\n')}`);
      expect(checkCliDoc(file).upToDate).toBe(true); // a byte order mark or Windows line endings are not drift
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('regenerating changes only what is between the markers', () => {
    const outside = (text: string) => [text.slice(0, text.indexOf(START_MARKER)), text.slice(text.indexOf(END_MARKER))];
    const regenerated = applyCommandsBlock(doc.replace(block, '\nstale\n'));
    expect(regenerated).toBe(doc);
    expect(outside(regenerated)).toEqual(outside(doc));
    expect(renderCommandsBlock()).toBe(block.replace(/^\n/, '').replace(/\n$/, ''));
  });

  test('a file without the markers is an error, not silently rewritten', () => {
    expect(() => applyCommandsBlock('# No table here\n')).toThrow(/commands:start/);
    expect(() => applyCommandsBlock(`${END_MARKER}\n${START_MARKER}\n`)).toThrow();
  });

  test('the file is UTF-8 without a byte order mark, with Unix line endings', () => {
    const bytes = readFileSync(CLI_DOC_PATH);
    expect(bytes[0]).not.toBe(0xef);
    expect(doc.includes('\r')).toBe(false);
  });

  test('it covers the contract: flags, exit codes, envelopes, tokens and safety', () => {
    for (const text of [
      '--json',
      '--out FILE',
      'UTF-8 without a BOM',
      '--yes',
      '--dry-run',
      '`capstan.result/1`',
      '`capstan.commands/1`',
      '`needs-browser`',
      '`needs-confirm`',
      '%LOCALAPPDATA%\\Capstan',
      '`Host` and `Origin`',
      'no CORS',
      'never goes on a command line',
    ]) {
      expect(doc).toContain(text);
    }
    for (const code of ['`0`', '`1`', '`2`']) expect(doc).toContain(`| ${code} |`);
  });

  test('it says plainly what is not built, and does not claim otherwise', () => {
    const status = doc.slice(doc.indexOf('## Status'), doc.indexOf('## Commands'));
    expect(status).toContain('The `Capstan-CLI.bat` launcher');
    expect(status).toContain('issue #33');
    expect(status).toContain('host bridge');
    expect(status).toContain('not built yet');
    expect(status).toContain('answer `needs-browser`');
    // No sentence outside the Status section may say the launcher or the bridge works, exists or ships.
    const rest = doc.replace(status, '');
    expect(rest).not.toMatch(/(launcher|bridge)[^.\n]*\b(is built|is available|ships|is included|works today|exists today)/i);
    // The launcher line is marked as planned right where it is shown.
    const afterLauncher = doc.slice(doc.indexOf('```bat'), doc.indexOf('## Status'));
    expect(afterLauncher).toMatch(/does not exist yet/);
  });
});
