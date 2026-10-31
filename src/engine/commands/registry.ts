// The command registry: every GUI action is also a named command (`clip split`, `marker add`,
// `annotation add` ...), following the Fleet CLI parity proposal.
//
//   runCommand(project, 'clip split', { time: 2.5 })
//     -> { schema: 'capstan.result/1', command, ok: true, result, project }
//     -> { schema: 'capstan.result/1', command, ok: false, errorType, error }
//
// Commands over plain data (`needs: 'project'`) are pure: a Project goes in, the next Project comes
// out. Commands that need the live page (export, recording, import of media bytes, packages,
// library) are registered with full typed inputs and answer `needs-browser`; the host bridge
// (issue #33) implements those.
//
// Nothing in the editor imports this module, so it adds nothing to the browser bundle.
import type { Project } from '../project';
import { annotationCommands } from './annotation-commands';
import { audioCommands } from './audio-commands';
import { browserCommands } from './browser-commands';
import { captionCommands } from './caption-commands';
import { clipCommands } from './clip-commands';
import { type Args, type CommandDef, CommandError, type ErrorType, type InputSpec } from './define';
import { effectsCommands } from './effects-commands';
import { motionCommands } from './motion-commands';
import { projectCommands } from './project-commands';

export type { Args, CommandDef, CommandNeeds, ErrorType, InputSpec, InputType } from './define';
export { CommandError } from './define';

export const RESULT_SCHEMA = 'capstan.result/1';
export const COMMANDS_SCHEMA = 'capstan.commands/1';

/** The shape every command name must have: a lower-case noun, a space, a lower-case verb (kebab-case; digits allowed, as in `export mp4`). */
export const COMMAND_NAME = /^[a-z]+ [a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const ALL: CommandDef[] = [
  ...projectCommands,
  ...clipCommands,
  ...annotationCommands,
  ...motionCommands,
  ...effectsCommands,
  ...audioCommands,
  ...captionCommands,
  ...browserCommands,
];

const TABLE = new Map<string, CommandDef>();
for (const def of ALL) {
  // A mistake in a command file, caught the first time the registry loads (and by the tests).
  if (!COMMAND_NAME.test(def.name)) throw new Error(`Command name "${def.name}" is not "noun verb"`);
  if (TABLE.has(def.name)) throw new Error(`Command "${def.name}" is registered twice`);
  TABLE.set(def.name, def);
}

/** Every command, sorted by name. */
export function listCommands(): readonly CommandDef[] {
  return [...TABLE.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function getCommand(name: string): CommandDef | undefined {
  return TABLE.get(normaliseName(name));
}

const normaliseName = (name: string): string => String(name ?? '').trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------------

/** What a dry run reports instead of a new project. */
export interface ChangeSummary {
  /** Item counts before and after, for lists in the project. */
  counts: Record<string, { before: number; after: number }>;
  added: string[];
  removed: string[];
  modified: string[];
  /** Project-level fields that changed (name, size, background ...). */
  fields: string[];
}

export interface OkEnvelope {
  schema: typeof RESULT_SCHEMA;
  command: string;
  ok: true;
  result: unknown;
  dryRun?: true;
  /** Dry run only: what the command would change. */
  changes?: ChangeSummary;
  /** Not on a dry run: the project after the command. */
  project?: Project;
}

export interface ErrorEnvelope {
  schema: typeof RESULT_SCHEMA;
  command: string;
  ok: false;
  errorType: ErrorType;
  error: string;
}

export type ResultEnvelope = OkEnvelope | ErrorEnvelope;

export interface RunOptions {
  /** Check the command and say what it would change; the project is not returned. */
  dryRun?: boolean;
  /** Needed by destructive commands: the API form of `--yes`. */
  confirm?: boolean;
}

const failure = (command: string, errorType: ErrorType, error: string): ErrorEnvelope => ({ schema: RESULT_SCHEMA, command, ok: false, errorType, error });

/** 0 for success, 1 when the command failed (or needs the browser), 2 for a usage error or a missing confirmation. */
export function exitCodeFor(envelope: ResultEnvelope): 0 | 1 | 2 {
  if (envelope.ok) return 0;
  return envelope.errorType === 'usage' || envelope.errorType === 'needs-confirm' ? 2 : 1;
}

// ---------------------------------------------------------------------------------------------
// Input checking
// ---------------------------------------------------------------------------------------------

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function coerce(spec: InputSpec, raw: unknown): { value?: unknown; error?: string } {
  const bad = (what: string) => ({ error: `"${spec.name}" ${what}` });
  switch (spec.type) {
    case 'number': {
      let n: number;
      if (typeof raw === 'number') n = raw;
      else if (typeof raw === 'string' && NUMBER_TEXT.test(raw.trim())) n = Number(raw.trim());
      else return bad('must be a number');
      if (!Number.isFinite(n)) return bad('must be a finite number');
      if (spec.integer && !Number.isInteger(n)) return bad('must be a whole number');
      if (spec.min !== undefined && n < spec.min) return bad(`must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return bad(`must be at most ${spec.max}`);
      return { value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (t === 'true') return { value: true };
        if (t === 'false') return { value: false };
      }
      return bad('must be true or false');
    }
    case 'enum': {
      const text = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
      if (text === undefined || !spec.values?.includes(text)) return bad(`must be one of: ${spec.values?.join(', ')}`);
      return { value: text };
    }
    case 'id': {
      if (spec.many) {
        const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : undefined;
        if (!list || !list.every((x) => typeof x === 'string')) return bad('must be an id, several ids separated by commas, or an array of ids');
        const ids = list.map((x: string) => x.trim()).filter(Boolean);
        return ids.length ? { value: ids } : bad('needs at least one id');
      }
      if (typeof raw !== 'string' || !raw.trim()) return bad('must be an id (a non-empty string)');
      return { value: raw.trim() };
    }
    case 'json': {
      if (typeof raw === 'string') {
        try {
          return { value: JSON.parse(raw) };
        } catch {
          return bad('must be JSON (an object or array, or a string holding JSON)');
        }
      }
      if (raw !== null && typeof raw === 'object') return { value: raw };
      return bad('must be JSON (an object or array, or a string holding JSON)');
    }
    default:
      return typeof raw === 'string' ? { value: raw } : bad('must be a string');
  }
}

/** Checks `args` against the command's inputs. Returns the coerced arguments or a usage message. */
export function validateArgs(def: CommandDef, args: unknown): { args: Args } | { error: string } {
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { error: 'The arguments must be an object of name and value pairs' };
  const given = args as Record<string, unknown>;
  const known = new Set(def.inputs.map((i) => i.name));
  const problems: string[] = [];
  for (const key of Object.keys(given)) {
    if (!known.has(key) && given[key] !== undefined) problems.push(`Unknown argument "${key}"${known.size ? ` (this command takes: ${[...known].join(', ')})` : ' (this command takes no arguments)'}`);
  }
  const out: Args = {};
  for (const spec of def.inputs) {
    const raw = given[spec.name];
    if (raw === undefined) {
      if (spec.required) problems.push(`Missing required argument "${spec.name}"`);
      continue;
    }
    const c = coerce(spec, raw);
    if (c.error) problems.push(c.error);
    else out[spec.name] = c.value;
  }
  if (!problems.length && def.atLeastOne && !def.atLeastOne.some((k) => out[k] !== undefined)) {
    problems.push(`Give at least one of: ${def.atLeastOne.join(', ')}`);
  }
  return problems.length ? { error: problems.join('; ') } : { args: out };
}

// ---------------------------------------------------------------------------------------------
// Dry-run summary
// ---------------------------------------------------------------------------------------------

const LISTS = ['tracks', 'clips', 'media', 'redactions', 'captions', 'annotations', 'zooms', 'markers'] as const;
const FIELDS = ['name', 'width', 'height', 'fps', 'background', 'id', 'range', 'cursorFx'] as const;

/** What differs between two projects, by id. */
export function summariseChanges(before: Project, after: Project): ChangeSummary {
  const summary: ChangeSummary = { counts: {}, added: [], removed: [], modified: [], fields: [] };
  for (const list of LISTS) {
    const a = before[list] as Array<{ id: string }>;
    const b = after[list] as Array<{ id: string }>;
    summary.counts[list] = { before: a.length, after: b.length };
    const was = new Map(a.map((x) => [x.id, JSON.stringify(x)]));
    const now = new Map(b.map((x) => [x.id, JSON.stringify(x)]));
    for (const [id, text] of now) {
      if (!was.has(id)) summary.added.push(id);
      else if (was.get(id) !== text) summary.modified.push(id);
    }
    for (const id of was.keys()) if (!now.has(id)) summary.removed.push(id);
  }
  for (const f of FIELDS) if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) summary.fields.push(f);
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/**
 * Runs one command over a project. Never throws: every problem comes back as a failure envelope.
 * `usage` for an unknown command or bad arguments, `needs-confirm` for a destructive command without
 * `confirm: true`, `needs-browser` for commands only the page can run, `failed` when the command
 * understood its arguments but could not do the work.
 */
export function runCommand(project: Project, name: string, args: unknown = {}, options: RunOptions = {}): ResultEnvelope {
  const command = normaliseName(name);
  try {
    const def = TABLE.get(command);
    if (!def) return failure(command, 'usage', `Unknown command "${command}". Run "commands" to list them.`);
    const checked = validateArgs(def, args);
    if ('error' in checked) return failure(command, 'usage', checked.error);
    if (def.needs === 'browser') {
      return failure(command, 'needs-browser', `"${command}" needs the running Capstan page; it cannot run over plain project data. The host bridge runs it.`);
    }
    if (!project || typeof project !== 'object' || !Array.isArray(project.clips)) return failure(command, 'failed', 'There is no project to run the command on');
    if (def.destructive && !options.dryRun && options.confirm !== true) {
      return failure(command, 'needs-confirm', `"${command}" discards or replaces data. Run it again with confirm: true (on a command line, --yes), or preview it with dryRun.`);
    }
    const out = def.run(project, checked.args);
    if (options.dryRun) {
      return { schema: RESULT_SCHEMA, command, ok: true, result: out.result, dryRun: true, changes: summariseChanges(project, out.project) };
    }
    return { schema: RESULT_SCHEMA, command, ok: true, result: out.result, project: out.project };
  } catch (e) {
    if (e instanceof CommandError) return failure(command, e.errorType, e.message);
    return failure(command, 'failed', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------------------------
// Description (for `commands --json`)
// ---------------------------------------------------------------------------------------------

export interface CommandDescription {
  name: string;
  summary: string;
  needs: CommandDef['needs'];
  destructive: boolean;
  cliOnly?: true;
  inputs: Array<{
    name: string;
    type: InputSpec['type'];
    required: boolean;
    description: string;
    values?: string[];
    min?: number;
    max?: number;
    integer?: true;
    many?: true;
  }>;
  atLeastOne?: string[];
  result: string;
}

export interface CommandsDocument {
  schema: typeof COMMANDS_SCHEMA;
  app: 'capstan';
  commands: CommandDescription[];
}

/** Every command with every input's type, required flag and allowed values or range. Same input, same output. */
export function describeCommands(): CommandsDocument {
  return {
    schema: COMMANDS_SCHEMA,
    app: 'capstan',
    commands: listCommands().map((def) => ({
      name: def.name,
      summary: def.summary,
      needs: def.needs,
      destructive: !!def.destructive,
      ...(def.cliOnly ? { cliOnly: true as const } : {}),
      inputs: def.inputs.map((i) => ({
        name: i.name,
        type: i.type,
        required: i.required,
        description: i.description,
        ...(i.values ? { values: [...i.values] } : {}),
        ...(i.min !== undefined ? { min: i.min } : {}),
        ...(i.max !== undefined ? { max: i.max } : {}),
        ...(i.integer ? { integer: true as const } : {}),
        ...(i.many ? { many: true as const } : {}),
      })),
      ...(def.atLeastOne ? { atLeastOne: [...def.atLeastOne] } : {}),
      result: def.result,
    })),
  };
}
