import { retimeCaption } from '../../engine/captionops';
import type { OverlayLane } from './index';

const label = (text: string) => {
  const first = text.split('\n').find((l) => l.trim()) ?? '(empty)';
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
};

// The captions row under the tracks. A caption has start and end rather than a duration, so the
// lane translates: a patch with only `start` is a move, only `duration` moves the end, both trim the start.
export const captionLane: OverlayLane = {
  id: 'captions',
  label: 'Captions',
  items: (project) => project.captions.map((c) => ({ id: c.id, start: c.start, duration: c.end - c.start, label: label(c.text) })),
  update: (project, id, patch) => {
    const c = project.captions.find((x) => x.id === id);
    if (!c) return project;
    const start = patch.start ?? c.start;
    const duration = patch.duration ?? c.end - c.start;
    return retimeCaption(project, id, { start, end: start + duration });
  },
};
