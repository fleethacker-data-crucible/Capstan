// Edit operations for clip effects (pure: project in, project out).
import { type ClipEffects, parseEffects } from './fx';
import { touch } from './ops';
import type { Project } from './project';

/**
 * Sets the effects of the given clips to `change(current)`. Effects that end up empty are removed
 * from the clip. Returns the same project when nothing changes.
 */
export function updateClipEffects(project: Project, clipIds: string[], change: (current: ClipEffects | undefined) => ClipEffects | undefined): Project {
  const ids = new Set(clipIds);
  let changed = false;
  const clips = project.clips.map((c) => {
    if (!ids.has(c.id)) return c;
    const next = change(c.effects);
    const clean = next ? parseEffects(next) : undefined;
    if (JSON.stringify(clean) === JSON.stringify(c.effects)) return c;
    changed = true;
    const { effects: _drop, ...rest } = c;
    void _drop;
    return clean ? { ...rest, effects: clean } : rest;
  });
  return changed ? touch(project, { clips }) : project;
}
