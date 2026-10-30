import type { OverlayLane } from './index';

// Editing area: the captions row under the tracks.
export const captionLane: OverlayLane = {
  id: 'captions',
  label: 'Captions',
  items: () => [],
  update: (project) => project,
};
