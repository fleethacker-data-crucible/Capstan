import type { ReactElement } from 'react';
import type { CursorFx } from '../../engine/cursor';
import type { InspectorProps } from './types';

const EFFECTS: Array<[keyof CursorFx, string]> = [
  ['showCursor', 'cursor'],
  ['highlight', 'halo'],
  ['magnify', 'loupe'],
  ['spotlight', 'spotlight'],
  ['clickRings', 'click rings'],
  ['clickSound', 'click sounds'],
  ['keys', 'key callouts'],
];

// Cursor area: a short summary of the cursor effects in the project panel. The controls are in the Cursor tab.
export function CursorSection({ editor }: InspectorProps): ReactElement | null {
  const { project } = editor;
  const withData = project.media.filter((m) => m.cursor).length;
  const fx = project.cursorFx;
  if (!withData && !fx) return null;
  const on = fx?.enabled ? EFFECTS.filter(([k]) => fx[k]).map(([, label]) => label) : [];
  return (
    <section className="inspector-section" aria-label="Cursor effects summary">
      <h3>Cursor effects</h3>
      <p className="hint" data-testid="cursor-section-summary">
        Cursor data on {withData} recording{withData === 1 ? '' : 's'}. {on.length ? `On: ${on.join(', ')}.` : 'No effects on.'} Change them in the Cursor tab.
      </p>
    </section>
  );
}
