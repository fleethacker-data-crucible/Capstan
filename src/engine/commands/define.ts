// Command definitions: the types and small builders every command file uses. This file has no
// dependency on the registry, so the area files can import it without a cycle.
//
// A command is a named, typed wrapper over one or more of the pure edit operations in src/engine.
// It takes a Project (plain data) and returns the next Project and a result. Nothing here touches
// the DOM, the clock beyond what the wrapped operation does, or any global state.
import type { Project } from '../project';

export type InputType = 'string' | 'number' | 'boolean' | 'enum' | 'id' | 'json';

/** One argument a command accepts. */
export interface InputSpec {
  /** camelCase; a command line maps `--ease-in` to `easeIn`. */
  name: string;
  type: InputType;
  required: boolean;
  description: string;
  /** enum: the allowed values. */
  values?: readonly string[];
  /** number: inclusive range. */
  min?: number;
  max?: number;
  /** number: must be a whole number. */
  integer?: boolean;
  /** id: several ids are accepted (an array, or one string with commas); the value arrives as string[]. */
  many?: boolean;
}

/** Coerced, validated arguments. Optional inputs that were not given are absent. */
// (any, because each command reads the keys its own inputs declare and the registry has checked them)
export type Args = Record<string, any>;

export interface CommandOutput {
  /** The project after the command. Return the input project for commands that only read. */
  project: Project;
  /** Plain JSON data describing what happened (ids made, text exported, counts). */
  result: unknown;
}

export type CommandNeeds = 'project' | 'browser';

export interface CommandDef {
  /** `<noun> <verb>`, lower case, for example `clip split`. */
  name: string;
  summary: string;
  inputs: InputSpec[];
  /** What `result` holds on success. */
  result: string;
  /** Discards or replaces more than the thing it names; the API needs `confirm: true` (a command line, `--yes`). */
  destructive?: boolean;
  /** `project`: runs over plain data. `browser`: needs the live page (media bytes, encoders, pickers, storage). */
  needs: CommandNeeds;
  /** Not reachable from any GUI control; exempt from the GUI parity check. */
  cliOnly?: boolean;
  /** At least one of these inputs must be given (a usage error otherwise). */
  atLeastOne?: string[];
  run(project: Project, args: Args): CommandOutput;
}

export type ErrorType = 'usage' | 'failed' | 'needs-browser' | 'needs-confirm';

/** Thrown inside `run` for an expected problem; `runCommand` turns it into a failure envelope. */
export class CommandError extends Error {
  constructor(
    readonly errorType: ErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** The command understood its arguments but could not do what they ask (missing id, locked track, nothing to change). */
export function fail(message: string): never {
  throw new CommandError('failed', message);
}

/** An argument combination only `run` can see is wrong. */
export function usage(message: string): never {
  throw new CommandError('usage', message);
}

/** Returns `next`, or fails with `message` when the operation left the project as it was (it found nothing to do). */
export function changed(before: Project, next: Project, message: string): Project {
  if (next === before) return fail(message);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------------------------

interface Common {
  /** Inputs are required unless this is set. */
  optional?: boolean;
}

export function str(name: string, description: string, o: Common = {}): InputSpec {
  return { name, type: 'string', required: !o.optional, description };
}

export function num(name: string, description: string, o: Common & { min?: number; max?: number; integer?: boolean } = {}): InputSpec {
  return {
    name,
    type: 'number',
    required: !o.optional,
    description,
    ...(o.min !== undefined ? { min: o.min } : {}),
    ...(o.max !== undefined ? { max: o.max } : {}),
    ...(o.integer ? { integer: true } : {}),
  };
}

export function bool(name: string, description: string, o: Common = {}): InputSpec {
  return { name, type: 'boolean', required: !o.optional, description };
}

export function oneOf(name: string, values: readonly string[], description: string, o: Common = {}): InputSpec {
  return { name, type: 'enum', required: !o.optional, description, values: [...values] };
}

/** An id of a project item (clip, track, media, annotation ...). */
export function ref(name: string, description: string, o: Common & { many?: boolean } = {}): InputSpec {
  return { name, type: 'id', required: !o.optional, description, ...(o.many ? { many: true } : {}) };
}

/** A JSON value: an object or array, or a string holding JSON. */
export function json(name: string, description: string, o: Common = {}): InputSpec {
  return { name, type: 'json', required: !o.optional, description };
}

/** A time on the timeline in seconds. */
export const seconds = (name: string, description: string, o: Common & { max?: number } = {}): InputSpec =>
  num(name, description, { min: 0, ...(o.max !== undefined ? { max: o.max } : {}), ...(o.optional ? { optional: true } : {}) });

/** A command that only a live page can run (encoders, pickers, media bytes, browser storage). */
export function browserCommand(def: Omit<CommandDef, 'needs' | 'run'>): CommandDef {
  return {
    ...def,
    needs: 'browser',
    run: () => {
      throw new CommandError('needs-browser', `"${def.name}" needs the running Capstan page; it cannot run over plain project data. The host bridge runs it.`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Lookups that fail with a clear message
// ---------------------------------------------------------------------------------------------

export function needClip(project: Project, id: string) {
  return project.clips.find((c) => c.id === id) ?? fail(`No clip with id "${id}"`);
}

export function needTrack(project: Project, id: string) {
  return project.tracks.find((t) => t.id === id) ?? fail(`No track with id "${id}"`);
}

export function needMedia(project: Project, id: string) {
  return project.media.find((m) => m.id === id) ?? fail(`No media with id "${id}"`);
}

/** Ids of everything in `after` that was not in `before`, for a list picked by `pick`. */
export function newIds<T extends { id: string }>(before: readonly T[], after: readonly T[]): string[] {
  const had = new Set(before.map((x) => x.id));
  return after.filter((x) => !had.has(x.id)).map((x) => x.id);
}

/** The keys of `args` that were given, as a patch (drops absent keys). */
export function pick(args: Args, keys: readonly string[]): Args {
  const out: Args = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}
