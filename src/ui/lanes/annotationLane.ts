import { KIND_LABELS } from '../../engine/annotations';
import { setAnnotationTiming } from '../../engine/annotationOps';
import type { OverlayLane } from './index';

/** The annotations row under the tracks: one block per annotation, labelled by kind and text, with move and trim. */
export const annotationLane: OverlayLane = {
  id: 'annotations',
  label: 'Notes',
  items: (project) =>
    project.annotations.map((a) => ({
      id: a.id,
      start: a.start,
      duration: a.duration,
      label: a.text.trim() ? `${KIND_LABELS[a.kind]}: ${a.text.trim().replace(/\s+/g, ' ').slice(0, 24)}` : KIND_LABELS[a.kind],
    })),
  update: (project, id, patch) => setAnnotationTiming(project, id, patch),
};
