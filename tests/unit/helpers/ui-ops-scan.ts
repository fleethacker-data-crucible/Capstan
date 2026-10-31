// Finds which UI files import the engine's project-edit operations directly, for the ratchet in
// commands-parity.test.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const root = join(import.meta.dir, '..', '..', '..');

export const ALLOWLIST = join(root, 'tests', 'unit', 'ui-direct-ops.allowlist.json');

/** Engine modules that edit a project. Others with project-editing functions are found by `findEditModules`. */
export const KNOWN_EDIT_MODULES = [
  'ops',
  'editops',
  'annotationOps',
  'captionops',
  'markers',
  'zoom',
  'animate',
  'fx-ops',
  'audioops',
  'cursorops',
  'range',
  'clipboard',
  'templates',
  'themes',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const posix = (p: string) => p.replaceAll('\\', '/');

/**
 * Engine modules (not the commands themselves) that export a function taking a Project first and giving
 * a Project back: an edit operation, whatever it is called and whichever file it lives in.
 */
export function findEditModules(): string[] {
  const dir = join(root, 'src', 'engine');
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const decl = /export (?:function|const) \w+\s*(?:<[^>(]*>)?\s*=?\s*\(\s*(?:project|p)\s*:\s*(?:Project|P)\b/g;
    let m: RegExpExecArray | null;
    while ((m = decl.exec(text))) {
      // Walk to the matching close parenthesis, then read the return type.
      let depth = 0;
      let i = text.indexOf('(', m.index);
      const open = i;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) break;
      }
      const after = text.slice(i + 1, i + 200).split(/\{|=>|\n\s*\n/)[0];
      const params = text.slice(open, i);
      if (/:\s*[^;]*\bProject\b/.test(after) || /:\s*P\b/.test(after) || /\{\s*project\s*:\s*Project/.test(after) || /project:\s*Project/.test(after)) {
        found.push(file.replace(/\.ts$/, ''));
        break;
      }
      void params;
    }
  }
  return found;
}

export interface Counts {
  [file: string]: number;
}

/** The value (not type-only) names a source text imports from the edit modules. */
export function directOpImports(source: string, modules: Set<string>): string[] {
  const out: string[] = [];
  const re = /import\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const [, typeOnly, clause, from] = m;
    if (typeOnly) continue;
    const mod = /(?:^|\/)engine\/([A-Za-z0-9-]+)$/.exec(from)?.[1];
    if (!mod || !modules.has(mod)) continue;
    const star = /\*\s+as\s+(\w+)/.exec(clause);
    if (star) {
      out.push(`${mod}.*`);
      continue;
    }
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim();
        if (!name || name.startsWith('type ')) continue;
        out.push(`${mod}.${name.split(/\s+as\s+/)[0]}`);
      }
    }
    const def = /^(\w+)\s*(,|$)/.exec(clause.trim());
    if (def && !clause.trim().startsWith('{')) out.push(`${mod}.default`);
  }
  return out;
}

export function scanUi(modules: Set<string>): Counts {
  const counts: Counts = {};
  for (const file of walk(join(root, 'src', 'ui')).filter((f) => /\.(ts|tsx)$/.test(f))) {
    const n = directOpImports(readFileSync(file, 'utf8'), modules).length;
    if (n > 0) counts[posix(relative(root, file))] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

