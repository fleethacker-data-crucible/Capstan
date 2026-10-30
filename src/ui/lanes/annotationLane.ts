import type { OverlayLane } from './index';

// Annotations area: the annotations row under the tracks.
export const annotationLane: OverlayLane = {
  id: 'annotations',
  label: 'Notes',
  items: () => [],
  update: (project) => project,
};
