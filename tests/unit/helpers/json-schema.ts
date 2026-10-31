// A small JSON Schema (draft 2020-12) validator for the tests, so the published project schema can be
// checked without adding a dependency. It supports what docs/project.schema.json uses:
//
//   type (including "integer" and a list of types), enum, const, properties, required,
//   additionalProperties (true, false or a schema), items, minItems, maxItems, minProperties,
//   minimum, maximum, exclusiveMinimum, exclusiveMaximum, minLength, maxLength, pattern,
//   oneOf, anyOf, allOf, not, and $ref to a local "#/$defs/..." (or "#") pointer.
//
// Keywords that only describe ($schema, $id, title, description, $comment, default, examples, $defs and
// anything starting "x-") are ignored. Any other keyword THROWS, so a schema can never lean on
// something this file silently skips.

export type Schema = { [key: string]: unknown };

const IGNORED = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', '$defs']);
const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
]);

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function isType(v: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    case 'string':
    case 'boolean':
      return typeof v === type;
    default:
      throw new Error(`Unsupported type "${type}" in schema`);
  }
}

/** Structural equality for enum and const (JSON values). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (kindOf(a) !== kindOf(b) || a === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => same(x, (b as unknown[])[i]));
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  return ak.length === bk.length && ak.every((k) => same((a as Schema)[k], (b as Schema)[k]));
}

function resolve(root: Schema, ref: string): Schema {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) throw new Error(`Only local references are supported, got "${ref}"`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (node === null || typeof node !== 'object' || !(key in (node as object))) throw new Error(`Unresolved reference "${ref}"`);
    node = (node as Schema)[key];
  }
  if (node === null || typeof node !== 'object') throw new Error(`Reference "${ref}" is not a schema`);
  return node as Schema;
}

function check(root: Schema, schema: Schema | boolean, value: unknown, path: string, errors: string[]): void {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push(`${path || '/'}: not allowed`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !IGNORED.has(key) && !key.startsWith('x-')) throw new Error(`Unsupported schema keyword "${key}"`);
  }
  const at = path || '/';
  const fail = (message: string) => errors.push(`${at}: ${message}`);

  if (typeof schema.$ref === 'string') check(root, resolve(root, schema.$ref), value, path, errors);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => isType(value, t))) {
      fail(`expected ${types.join(' or ')}, got ${kindOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !same(value, schema.const)) fail(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => same(value, e))) fail(`must be one of ${JSON.stringify(schema.enum)}`);

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`${value} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`${value} is above the maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(`${value} must be above ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(`${value} must be below ${schema.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) fail(`shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) fail(`longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((v, i) => check(root, schema.items as Schema, v, `${path}/${i}`, errors));
  }
  if (isType(value, 'object')) {
    const obj = value as Schema;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    if (typeof schema.minProperties === 'number' && Object.keys(obj).length < schema.minProperties) fail(`fewer than ${schema.minProperties} properties`);
    for (const name of (schema.required ?? []) as string[]) if (!(name in obj)) fail(`missing required "${name}"`);
    for (const [name, v] of Object.entries(obj)) {
      if (name in props) check(root, props[name], v, `${path}/${name}`, errors);
      else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        check(root, schema.additionalProperties as Schema | boolean, v, `${path}/${name}`, errors);
      }
    }
  }

  const sub = (list: unknown): Schema[] => list as Schema[];
  if (Array.isArray(schema.allOf)) for (const s of sub(schema.allOf)) check(root, s, value, path, errors);
  if (Array.isArray(schema.anyOf)) {
    const results = sub(schema.anyOf).map((s) => validateAgainst(root, s, value, path));
    if (!results.some((r) => r.length === 0)) fail(`matches none of anyOf (${results.map((r) => r[0]).join(' | ')})`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = sub(schema.oneOf).filter((s) => validateAgainst(root, s, value, path).length === 0).length;
    if (matching !== 1) fail(`matches ${matching} of oneOf, expected exactly 1`);
  }
  if (schema.not !== undefined && validateAgainst(root, schema.not as Schema, value, path).length === 0) fail('must not match the "not" schema');
}

function validateAgainst(root: Schema, schema: Schema | boolean, value: unknown, path: string): string[] {
  const errors: string[] = [];
  check(root, schema, value, path, errors);
  return errors;
}

/** Every problem found, as "/path: message" lines; an empty list means the value is valid. */
export function validate(schema: Schema, value: unknown): string[] {
  return validateAgainst(schema, schema, value, '');
}
