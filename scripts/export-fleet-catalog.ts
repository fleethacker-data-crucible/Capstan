// Writes actions/editor-catalog.json from the command registry. The PowerShell action
// module loads this file; it does not reimplement the editor.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeCommands } from '../src/engine/commands/registry';

const root = join(import.meta.dir, '..');
const doc = describeCommands();
writeFileSync(join(root, 'actions', 'editor-catalog.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${doc.commands.length} commands`);
