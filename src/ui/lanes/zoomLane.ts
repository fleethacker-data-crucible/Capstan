import type { OverlayLane } from './index';

// Animation area: the zoom-n-pan row under the tracks.
export const zoomLane: OverlayLane = {
  id: 'zooms',
  label: 'Zoom',
  items: () => [],
  update: (project) => project,
};
