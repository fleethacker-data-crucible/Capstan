// The command registry: every command runs against a sample project and answers with the documented
// envelope; arguments are checked and coerced; destructive commands need a confirmation; a dry run
// changes nothing; commands that need the page say so; the description is stable.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURSOR_SHAPES, DEFAULT_CURSOR_FX } from '../../src/engine/cursor';
import {
  COMMAND_NAME,
  CommandError,
  type ResultEnvelope,
  describeCommands,
  exitCodeFor,
  getCommand,
  listCommands,
  runCommand,
} from '../../src/engine/commands/registry';
import { CURSOR_RANGES } from '../../src/engine/commands/effects-commands';
import { type Project, createProject, parseProject } from '../../src/engine/project';
import { cases, ok, sample } from './helpers/command-sample';

const all = listCommands();
const pure = all.filter((c) => c.needs === 'project');
const browser = all.filter((c) => c.needs === 'browser');
const snapshot = (p: Project) => JSON.stringify(p);

describe('registry', () => {
  test('names are unique and read "noun verb"', () => {
    const names = all.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(COMMAND_NAME);
  });

  test('both kinds are registered, and every command documents itself', () => {
    expect(pure.length).toBeGreaterThan(60);
    expect(browser.length).toBeGreaterThan(20);
    for (const c of all) {
      expect(c.summary.length).toBeGreaterThan(8);
      expect(c.result.length).toBeGreaterThan(8);
      const seen = new Set<string>();
      for (const i of c.inputs) {
        expect(seen.has(i.name)).toBe(false);
        seen.add(i.name);
        expect(i.name).toMatch(/^[a-z][A-Za-z0-9]*$/);
        expect(i.description.length).toBeGreaterThan(3);
        if (i.type === 'enum') expect(i.values?.length).toBeGreaterThan(0);
        else expect(i.values).toBeUndefined();
        if (i.min !== undefined && i.max !== undefined) expect(i.min).toBeLessThanOrEqual(i.max);
        if (i.min !== undefined || i.max !== undefined || i.integer) expect(i.type).toBe('number');
        if (i.many) expect(i.type).toBe('id');
      }
      for (const k of c.atLeastOne ?? []) expect(seen.has(k)).toBe(true);
    }
  });

  test('the brief’s areas are all there', () => {
    const names = new Set(all.map((c) => c.name));
    const want = [
      'project set', 'project resize', 'track add', 'track remove', 'track update', 'media add', 'media remove',
      'clip add', 'clip move', 'clip trim', 'clip split', 'clip delete', 'clip duplicate', 'clip props', 'clip speed', 'clip freeze', 'clip extend',
      'clip crop', 'clip group', 'clip ungroup', 'clip detach-audio', 'clip close-gaps', 'clip remove-gap',
      'annotation add', 'annotation update', 'annotation remove', 'annotation duplicate', 'annotation move',
      'redaction add', 'redaction update', 'redaction remove', 'zoom add', 'zoom update', 'zoom remove',
      'keyframe set', 'keyframe remove', 'transition set', 'transition clear', 'behavior set', 'behavior clear', 'effects set', 'effects clear',
      'audio fade', 'audio point-set', 'audio duck',
      'caption set', 'caption add', 'caption update', 'caption remove', 'caption split', 'caption merge', 'caption shift', 'caption export-srt', 'caption export-vtt',
      'marker add', 'marker rename', 'marker move', 'marker remove', 'marker chapter', 'range set', 'range clear', 'cursor settings',
      'export mp4', 'export gif', 'export png', 'export wav', 'export m4a', 'media import', 'record start', 'record stop', 'package save', 'package open', 'library add',
    ];
    for (const n of want) expect(names.has(n)).toBe(true);
  });
});

describe('every command over plain data runs against the sample project', () => {
  const { p, ids } = sample();
  const args = cases(ids);

  test('the sample project is a sound project', () => {
    expect(p.clips.length).toBe(7);
    expect(() => parseProject(JSON.parse(snapshot(p)))).not.toThrow();
    expect(p.cursorFx).toBeDefined();
  });

  test('there is a case for every such command and for no other', () => {
    expect(Object.keys(args).sort()).toEqual(pure.map((c) => c.name).sort());
  });

  for (const def of pure) {
    test(def.name, () => {
      const before = snapshot(p);
      const env = runCommand(p, def.name, args[def.name], { confirm: true });
      if (!env.ok) throw new Error(`${env.errorType}: ${env.error}`);
      expect(env.schema).toBe('capstan.result/1');
      expect(env.command).toBe(def.name);
      expect(env.ok).toBe(true);
      expect(env.dryRun).toBeUndefined();
      expect(env.result).toBeDefined();
      expect(() => JSON.stringify(env.result)).not.toThrow();
      // The input is never changed, and what comes back is still a valid project.
      expect(snapshot(p)).toBe(before);
      expect(env.project).toBeDefined();
      expect(() => parseProject(JSON.parse(snapshot(env.project as Project)))).not.toThrow();
      expect(exitCodeFor(env)).toBe(0);
    });
  }
});

describe('commands change the project, or say they only read', () => {
  const { p, ids } = sample();
  const args = cases(ids);
  const READ_ONLY = ['project show', 'project save', 'zoom suggest', 'caption export-srt', 'caption export-vtt', 'marker export-chapters'];
  const strip = (q: Project) => JSON.stringify({ ...q, updatedAt: 0 });

  for (const def of pure) {
    test(def.name, () => {
      const env = ok(runCommand(p, def.name, args[def.name], { confirm: true }));
      const changed = strip(env.project as Project) !== strip(p);
      expect(changed).toBe(!READ_ONLY.includes(def.name));
    });
  }
});

describe('what the commands do', () => {
  const { p, ids } = sample();
  const run = (name: string, a: Record<string, unknown>, from: Project = p) => ok(runCommand(from, name, a, { confirm: true }));

  test('clip split cuts one clip in two and reports the new half', () => {
    const env = run('clip split', { time: 10, clips: ids.c1 });
    expect((env.project as Project).clips.length).toBe(p.clips.length + 1);
    expect((env.result as { created: string[] }).created.length).toBe(1);
  });

  test('clip add puts media on the timeline', () => {
    const env = run('clip add', { media: ids.mAud, start: 50 });
    expect((env.result as { start: number }).start).toBe(50);
  });

  test('clip delete reports what went and ripple closes the gap', () => {
    const env = run('clip delete', { clips: ids.c1, ripple: true });
    expect((env.result as { removed: string[] }).removed).toEqual([ids.c1]);
    const c4 = (env.project as Project).clips.find((c) => c.id === ids.c4);
    expect(c4?.start).toBeLessThan(25);
  });

  test('clip group then ungroup', () => {
    const grouped = run('clip group', { clips: [ids.c1, ids.c2] });
    expect((grouped.result as { group: string }).group).toBeTruthy();
    const loose = run('clip ungroup', { clips: ids.c1 }, grouped.project as Project);
    expect((loose.result as { clips: string[] }).clips.sort()).toEqual([ids.c1, ids.c2].sort());
    // The sample already holds a group of two; ungrouping one member frees both.
    expect((run('clip ungroup', { clips: ids.c6 }).result as { clips: string[] }).clips.sort()).toEqual([ids.c5, ids.c6].sort());
  });

  test('clip detach-audio makes a linked audio clip', () => {
    const env = run('clip detach-audio', { clip: ids.c1 });
    const made = (env.project as Project).clips.find((c) => c.id === (env.result as { audioClip: string }).audioClip);
    expect(made?.audioOnly).toBe(true);
    expect(made?.linkId).toBeTruthy();
  });

  test('project resize keeps items in the same relative place', () => {
    const env = run('project resize', { width: 3840, height: 2160 });
    const q = env.project as Project;
    expect(q.width).toBe(3840);
    const before = p.clips.find((c) => c.id === ids.c1)!;
    expect(q.clips.find((c) => c.id === ids.c1)!.props.x).toBe(before.props.x * 2);
  });

  test('project save returns the file text and project open reads it back', () => {
    const saved = run('project save', {}).result as { fileName: string; text: string };
    expect(saved.fileName).toBe('Sample project.capstan');
    const opened = run('project open', { project: saved.text });
    expect((opened.project as Project).clips.length).toBe(p.clips.length);
  });

  test('project open refuses text that is not a project', () => {
    const env = runCommand(p, 'project open', { project: '{"hello":1}' }, { confirm: true });
    expect(env.ok).toBe(false);
    expect(!env.ok && env.errorType).toBe('failed');
  });

  test('caption set reads SRT and WebVTT, and the exports read back', () => {
    const set = run('caption set', { text: cases(ids)['caption set'].text });
    const q = set.project as Project;
    expect(q.captions.map((c) => c.text)).toEqual(['Hello there', 'Second cue']);
    const srt = run('caption export-srt', {}, q).result as { text: string; count: number; fileName: string };
    expect(srt.count).toBe(2);
    expect(srt.text.startsWith('1\n00:00:00,500 --> 00:00:02,000\nHello there')).toBe(true);
    const vtt = run('caption export-vtt', {}, q).result as { text: string };
    expect(vtt.text.startsWith('WEBVTT\n\n1\n00:00:00.500 --> 00:00:02.000')).toBe(true);
    const again = run('caption set', { text: vtt.text }, createProject('x'));
    expect((again.project as Project).captions.length).toBe(2);
  });

  test('caption export fails clearly when there are no captions', () => {
    const env = runCommand(createProject('x'), 'caption export-srt');
    expect(!env.ok && env.errorType).toBe('failed');
  });

  test('marker commands and chapter export', () => {
    const added = run('marker add', { time: 1, name: 'Intro', chapter: true });
    const q = added.project as Project;
    expect(q.markers.map((m) => m.name)).toEqual(['Intro', 'Chapter one']);
    const moved = run('marker move', { marker: ids.mk, time: 0 }, q).project as Project;
    expect(moved.markers[0].time).toBe(0);
    const text = run('marker export-chapters', { format: 'text' }, q).result as { text: string; count: number; fileName: string };
    expect(text.count).toBe(2);
    expect(text.text).toBe('0:00 Start\n0:01 Intro\n0:05 Chapter one\n');
    expect(text.fileName).toBe('Sample project chapters.txt');
    const vtt = run('marker export-chapters', { format: 'vtt' }, q).result as { text: string };
    expect(vtt.text.startsWith('WEBVTT')).toBe(true);
    const none = runCommand(createProject('x'), 'marker export-chapters', { format: 'text' });
    expect(!none.ok && none.errorType).toBe('failed');
    const off = run('marker chapter', { marker: ids.mk, chapter: false });
    expect((off.result as { marker: { chapter: boolean } }).marker.chapter).toBe(false);
  });

  test('keyframes: set, ease, remove, clear', () => {
    const set = run('keyframe set', { clip: ids.c1, prop: 'x', time: 2, value: 10 });
    expect((set.result as { keys: unknown[] }).keys.length).toBe(1);
    const remove = run('keyframe remove', { clip: ids.c1, prop: 'x', time: 2 }, set.project as Project);
    expect((remove.result as { keys: unknown[] }).keys.length).toBe(0);
    const missing = runCommand(p, 'keyframe remove', { clip: ids.c1, prop: 'x', time: 2 });
    expect(!missing.ok && missing.errorType).toBe('failed');
  });

  test('behavior set checks the preset against the stage', () => {
    const env = runCommand(p, 'behavior set', { clip: ids.c1, stage: 'enter', type: 'pulse' });
    expect(!env.ok && env.errorType).toBe('usage');
  });

  test('zoom suggest reads the cursor data and zoom accept adds what it finds', () => {
    const found = run('zoom suggest', {}).result as { regions: Array<Record<string, unknown>> };
    expect(Array.isArray(found.regions)).toBe(true);
    const added = run('zoom accept', { regions: found.regions.length ? found.regions : cases(ids)['zoom accept'].regions });
    expect((added.project as Project).zooms.length).toBeGreaterThan(p.zooms.length);
  });

  test('cursor settings: every field has an input and the ranges match what the project keeps', () => {
    const def = getCommand('cursor settings')!;
    const names = new Set(def.inputs.map((i) => i.name));
    for (const key of Object.keys(DEFAULT_CURSOR_FX)) if (key !== 'image') expect(names.has(key)).toBe(true);
    for (const [key, [min, max]] of Object.entries(CURSOR_RANGES)) {
      const low = run('cursor settings', { [key]: min }).result as { cursorFx: Record<string, number> };
      const high = run('cursor settings', { [key]: max }).result as { cursorFx: Record<string, number> };
      expect(low.cursorFx[key]).toBeCloseTo(min, 6);
      expect(high.cursorFx[key]).toBeCloseTo(max, 6);
    }
    for (const shape of CURSOR_SHAPES) expect(run('cursor settings', { shape }).result).toBeDefined();
  });

  test('annotation update changes text, timing and style together', () => {
    const env = run('annotation update', { annotation: ids.ann, text: 'Changed', start: 3, duration: 6, style: { bold: true } });
    const a = (env.result as { annotation: { text: string; start: number; duration: number; style: { bold: boolean } } }).annotation;
    expect(a.text).toBe('Changed');
    expect(a.start).toBe(3);
    expect(a.duration).toBe(6);
    expect(a.style.bold).toBe(true);
  });

  test('a locked track refuses edits with a failed envelope', () => {
    const locked = run('track update', { track: p.clips.find((c) => c.id === ids.c1)!.trackId, locked: true }).project as Project;
    const env = runCommand(locked, 'clip props', { clip: ids.c1, scale: 2 });
    expect(!env.ok && env.errorType).toBe('failed');
    expect(exitCodeFor(env)).toBe(1);
  });
});

describe('arguments are checked and coerced', () => {
  const { p, ids } = sample();
  const usageOf = (name: string, a: unknown): string => {
    const env = runCommand(p, name, a, { confirm: true });
    expect(env.ok).toBe(false);
    if (env.ok) return '';
    expect(env.errorType).toBe('usage');
    expect(exitCodeFor(env)).toBe(2);
    return env.error;
  };

  test('strings from a command line become numbers and booleans', () => {
    const env = ok(runCommand(p, 'clip split', { time: '10', clips: ids.c1 }));
    expect((env.project as Project).clips.length).toBe(p.clips.length + 1);
    const del = ok(runCommand(p, 'clip delete', { clips: ids.c1, ripple: 'true' }, { confirm: true }));
    expect((del.project as Project).clips.find((c) => c.id === ids.c4)!.start).toBeLessThan(25);
    const notRipple = ok(runCommand(p, 'clip delete', { clips: ids.c1, ripple: 'false' }, { confirm: true }));
    expect((notRipple.project as Project).clips.find((c) => c.id === ids.c4)!.start).toBe(25);
    ok(runCommand(p, 'clip speed', { clip: ids.c1, speed: '2.5' }));
  });

  test('numbers must look like numbers', () => {
    expect(usageOf('clip split', { time: 'soon' })).toContain('must be a number');
    expect(usageOf('clip split', { time: '' })).toContain('must be a number');
    expect(usageOf('clip split', { time: Number.NaN })).toContain('finite');
    expect(usageOf('clip split', { time: Number.POSITIVE_INFINITY })).toContain('finite');
    expect(usageOf('clip split', { time: true })).toContain('must be a number');
  });

  test('required arguments', () => {
    expect(usageOf('clip split', {})).toContain('Missing required argument "time"');
    expect(usageOf('clip split', undefined)).toContain('Missing required argument "time"');
    expect(usageOf('clip speed', { clip: ids.c1 })).toContain('"speed"');
  });

  test('enums', () => {
    expect(usageOf('annotation add', { kind: 'triangle', start: 1 })).toContain('must be one of: text, callout');
    expect(usageOf('clip trim', { clip: ids.c1, edge: 'middle', time: 3 })).toContain('"edge"');
  });

  test('ranges and whole numbers', () => {
    expect(usageOf('clip speed', { clip: ids.c1, speed: 9 })).toContain('at most 8');
    expect(usageOf('clip speed', { clip: ids.c1, speed: 0.01 })).toContain('at least 0.1');
    expect(usageOf('clip split', { time: -1 })).toContain('at least 0');
    expect(usageOf('project resize', { width: 100.5, height: 200 })).toContain('whole number');
    expect(usageOf('project resize', { width: 10, height: 200 })).toContain('at least 16');
    expect(usageOf('clip props', { clip: ids.c1, opacity: 2 })).toContain('at most 1');
  });

  test('unknown arguments are refused, with the ones that are known', () => {
    const msg = usageOf('clip split', { time: 1, colour: 'red' });
    expect(msg).toContain('Unknown argument "colour"');
    expect(msg).toContain('time');
    expect(usageOf('project show', { anything: 1 })).toContain('takes no arguments');
  });

  test('ids: one, several separated by commas, or an array', () => {
    expect(usageOf('clip delete', { clips: '' })).toContain('"clips"');
    expect(usageOf('clip delete', { clips: [1, 2] })).toContain('"clips"');
    expect(usageOf('clip props', { clip: 7, scale: 1 })).toContain('must be an id');
    const env = ok(runCommand(p, 'clip delete', { clips: ` ${ids.c1} , ${ids.c4} ` }, { confirm: true }));
    expect((env.result as { removed: string[] }).removed.sort()).toEqual([ids.c1, ids.c4].sort());
    ok(runCommand(p, 'clip delete', { clips: [ids.c1, ids.c4] }, { confirm: true }));
  });

  test('json arguments take an object or the text of one', () => {
    expect(usageOf('effects set', { clips: ids.c1, effects: '{not json' })).toContain('must be JSON');
    expect(usageOf('effects set', { clips: ids.c1, effects: 5 })).toContain('must be JSON');
    expect(usageOf('effects set', { clips: ids.c1, effects: '[1]' })).toContain('effects must be an object');
    ok(runCommand(p, 'effects set', { clips: ids.c1, effects: '{"radius": 8}' }));
    ok(runCommand(p, 'effects set', { clips: ids.c1, effects: { radius: 8 } }));
  });

  test('at least one of several optional arguments', () => {
    expect(usageOf('clip props', { clip: ids.c1 })).toContain('Give at least one of');
    expect(usageOf('project set', {})).toContain('Give at least one of: name, fps, background');
  });

  test('values only run can judge are usage errors too', () => {
    expect(usageOf('project set', { background: 'red' })).toContain('#rrggbb');
    expect(usageOf('annotation update', { annotation: ids.ann, style: 5 })).toContain('must be JSON');
    expect(usageOf('annotation update', { annotation: ids.ann, style: '[]' })).toContain('style must be an object');
  });

  test('the argument list must be an object', () => {
    expect(usageOf('clip split', [1, 2])).toContain('must be an object');
    expect(usageOf('clip split', 'time=1')).toContain('must be an object');
  });

  test('an unknown command is a usage error; the name is tidied', () => {
    const env = runCommand(p, 'clip slice', { time: 1 });
    expect(!env.ok && env.errorType).toBe('usage');
    expect(!env.ok && env.error).toContain('Unknown command');
    expect(runCommand(p, '  clip   split ', { time: 10, clips: ids.c1 }).ok).toBe(true);
    expect(runCommand(p, 'clip   split ', { time: 10 }).command).toBe('clip split');
  });

  test('missing things are failed, not usage', () => {
    const env = runCommand(p, 'clip props', { clip: 'nope', scale: 1 });
    expect(!env.ok && env.errorType).toBe('failed');
    expect(!env.ok && env.error).toContain('No clip with id "nope"');
    expect(exitCodeFor(env)).toBe(1);
  });
});

describe('destructive commands', () => {
  const { p, ids } = sample();
  const destructive = pure.filter((c) => c.destructive);
  const args = cases(ids);

  test('some commands are destructive', () => {
    expect(destructive.map((c) => c.name)).toEqual(expect.arrayContaining(['clip delete', 'track remove', 'media remove', 'project new', 'caption set', 'caption clear']));
  });

  for (const def of destructive) {
    test(`${def.name} refuses without confirm`, () => {
      const before = snapshot(p);
      for (const options of [undefined, {}, { confirm: false }]) {
        const env = runCommand(p, def.name, args[def.name], options);
        expect(env.ok).toBe(false);
        if (env.ok) return;
        expect(env.errorType).toBe('needs-confirm');
        expect(exitCodeFor(env)).toBe(2);
        expect('project' in env).toBe(false);
      }
      expect(snapshot(p)).toBe(before);
      expect(runCommand(p, def.name, args[def.name], { confirm: true }).ok).toBe(true);
    });

    test(`${def.name} can be previewed without confirm`, () => {
      const env = runCommand(p, def.name, args[def.name], { dryRun: true });
      expect(env.ok).toBe(true);
    });
  }

  test('commands that are not destructive do not ask', () => {
    for (const def of pure.filter((c) => !c.destructive)) {
      expect(runCommand(p, def.name, args[def.name]).ok).toBe(true);
    }
  });

  test('a usage error comes before the confirmation check', () => {
    const env = runCommand(p, 'clip delete', {});
    expect(!env.ok && env.errorType).toBe('usage');
  });
});

describe('dry run', () => {
  const { p, ids } = sample();
  const args = cases(ids);

  for (const def of pure) {
    test(`${def.name} reports and returns no project`, () => {
      const before = snapshot(p);
      const env = runCommand(p, def.name, args[def.name], { dryRun: true });
      if (!env.ok) throw new Error(`${env.errorType}: ${env.error}`);
      expect(env.dryRun).toBe(true);
      expect('project' in env).toBe(false);
      expect(env.changes).toBeDefined();
      expect(env.changes!.counts.clips.before).toBe(p.clips.length);
      expect(snapshot(p)).toBe(before);
    });
  }

  test('says what would change, by id', () => {
    const split = runCommand(p, 'clip split', { time: 10, clips: ids.c1 }, { dryRun: true });
    expect(split.ok && split.changes!.counts.clips).toEqual({ before: p.clips.length, after: p.clips.length + 1 });
    expect(split.ok && split.changes!.added.length).toBe(1);
    expect(split.ok && split.changes!.modified).toEqual([ids.c1]);
    const del = runCommand(p, 'clip delete', { clips: ids.c4 }, { dryRun: true });
    expect(del.ok && del.changes!.removed).toEqual([ids.c4]);
    const set = runCommand(p, 'project set', { name: 'Else' }, { dryRun: true });
    expect(set.ok && set.changes!.fields).toEqual(['name']);
  });

  test('still checks the arguments and still fails when the command would fail', () => {
    expect(runCommand(p, 'clip split', {}, { dryRun: true }).ok).toBe(false);
    const missing = runCommand(p, 'clip props', { clip: 'nope', scale: 1 }, { dryRun: true });
    expect(!missing.ok && missing.errorType).toBe('failed');
  });
});

describe('commands that need the page', () => {
  const minimal = (def: (typeof browser)[number]): Record<string, unknown> => {
    const a: Record<string, unknown> = {};
    for (const i of def.inputs) {
      if (!i.required) continue;
      a[i.name] = i.type === 'enum' ? i.values![0] : i.type === 'number' ? (i.min ?? 1) : i.type === 'boolean' ? true : i.type === 'json' ? {} : 'x';
    }
    return a;
  };

  test('there are browser commands for export, import, recording, packages and the library', () => {
    const names = new Set(browser.map((c) => c.name));
    for (const n of ['export mp4', 'export gif', 'export png', 'export wav', 'export m4a', 'media import', 'record start', 'record stop', 'package save', 'package open', 'library add']) {
      expect(names.has(n)).toBe(true);
    }
  });

  for (const def of browser) {
    test(`${def.name} says needs-browser`, () => {
      const { p } = sample();
      const env = runCommand(p, def.name, minimal(def), { confirm: true });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.errorType).toBe('needs-browser');
      expect(env.error).toContain('running Capstan page');
      expect(exitCodeFor(env)).toBe(1);
      expect(() => def.run(p, {})).toThrow(CommandError);
      // The inputs are still checked first.
      const bad = runCommand(p, def.name, { surprise: 1 });
      expect(!bad.ok && bad.errorType).toBe('usage');
    });
  }

  test('typed inputs are enforced before the browser is asked', () => {
    const { p } = sample();
    const bad = runCommand(p, 'export gif', { colors: 1000 });
    expect(!bad.ok && bad.errorType).toBe('usage');
    const fine = runCommand(p, 'export gif', { colors: '64', range: 'marks' });
    expect(!fine.ok && fine.errorType).toBe('needs-browser');
  });

  test('a dry run of one is still needs-browser', () => {
    const { p } = sample();
    const env = runCommand(p, 'export mp4', {}, { dryRun: true });
    expect(!env.ok && env.errorType).toBe('needs-browser');
  });
});

describe('describeCommands', () => {
  const doc = describeCommands();

  test('is the capstan.commands/1 document', () => {
    expect(doc.schema).toBe('capstan.commands/1');
    expect(doc.app).toBe('capstan');
    expect(doc.commands.length).toBe(all.length);
  });

  test('is stable: same JSON every time, sorted by name', () => {
    expect(JSON.stringify(describeCommands())).toBe(JSON.stringify(describeCommands()));
    const names = doc.commands.map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  test('carries every input’s type, required flag and allowed values', () => {
    const split = doc.commands.find((c) => c.name === 'clip split')!;
    expect(split.needs).toBe('project');
    expect(split.destructive).toBe(false);
    expect(split.inputs.find((i) => i.name === 'time')).toMatchObject({ type: 'number', required: true, min: 0 });
    expect(split.inputs.find((i) => i.name === 'clips')).toMatchObject({ type: 'id', required: false, many: true });
    const trim = doc.commands.find((c) => c.name === 'clip trim')!;
    expect(trim.inputs.find((i) => i.name === 'edge')).toMatchObject({ type: 'enum', values: ['start', 'end'] });
    const speed = doc.commands.find((c) => c.name === 'clip speed')!;
    expect(speed.inputs.find((i) => i.name === 'speed')).toMatchObject({ min: 0.1, max: 8 });
    expect(doc.commands.find((c) => c.name === 'clip delete')!.destructive).toBe(true);
    expect(doc.commands.find((c) => c.name === 'export mp4')!.needs).toBe('browser');
  });

  test('describes only the six input types', () => {
    const types = new Set(doc.commands.flatMap((c) => c.inputs.map((i) => i.type)));
    for (const t of types) expect(['string', 'number', 'boolean', 'enum', 'id', 'json']).toContain(t);
    expect(types.size).toBe(6);
  });
});

describe('the runner never throws', () => {
  const junk: unknown[] = [undefined, null, 0, 'text', [], [1], { x: 1 }, { time: { nested: true } }, () => 1, Symbol.iterator.toString()];

  test('whatever the arguments are', () => {
    const { p } = sample();
    for (const def of all) {
      for (const a of junk) {
        let env: ResultEnvelope | undefined;
        expect(() => {
          env = runCommand(p, def.name, a);
        }).not.toThrow();
        expect(env!.schema).toBe('capstan.result/1');
        expect([0, 1, 2]).toContain(exitCodeFor(env!));
      }
    }
  });

  test('whatever the project is', () => {
    const { ids } = sample();
    const args = cases(ids);
    for (const bad of [undefined, null, 5, 'project', {}, { clips: 'no' }]) {
      for (const def of pure) {
        let env: ResultEnvelope | undefined;
        expect(() => {
          env = runCommand(bad as unknown as Project, def.name, args[def.name], { confirm: true });
        }).not.toThrow();
        expect(env!.ok).toBe(false);
      }
    }
  });

  test('whatever the name is', () => {
    const { p } = sample();
    for (const n of [undefined, null, 5, '', ' ', {}, 'a', 'clip', 'clip split extra'] as unknown[]) {
      const env = runCommand(p, n as string, {});
      expect(env.ok).toBe(false);
    }
  });
});

describe('exit codes', () => {
  const env = (errorType: 'usage' | 'failed' | 'needs-browser' | 'needs-confirm'): ResultEnvelope => ({ schema: 'capstan.result/1', command: 'x y', ok: false, errorType, error: 'e' });
  test('0 for success, 1 for failed, 2 for usage', () => {
    expect(exitCodeFor({ schema: 'capstan.result/1', command: 'x y', ok: true, result: {} })).toBe(0);
    expect(exitCodeFor(env('failed'))).toBe(1);
    expect(exitCodeFor(env('usage'))).toBe(2);
    expect(exitCodeFor(env('needs-confirm'))).toBe(2);
    expect(exitCodeFor(env('needs-browser'))).toBe(1);
  });
});

describe('scripts/commands.ts', () => {
  const script = join(import.meta.dir, '..', '..', 'scripts', 'commands.ts');

  test('prints the description as JSON on stdout', () => {
    const r = Bun.spawnSync([process.execPath, script]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual(describeCommands());
  });

  test('--out writes UTF-8 without a byte order mark', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capstan-commands-'));
    try {
      const file = join(dir, 'nested', 'commands.json');
      const r = Bun.spawnSync([process.execPath, script, '--out', file]);
      expect(r.exitCode).toBe(0);
      const bytes = readFileSync(file);
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes[0]).toBe('{'.charCodeAt(0));
      expect(JSON.parse(bytes.toString('utf8'))).toEqual(describeCommands());
      expect(r.stdout.toString()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unknown option is a usage error', () => {
    expect(Bun.spawnSync([process.execPath, script, '--bogus']).exitCode).toBe(2);
    expect(Bun.spawnSync([process.execPath, script, '--out']).exitCode).toBe(2);
  });
});
