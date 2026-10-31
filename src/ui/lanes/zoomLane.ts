import { updateZoom } from '../../engine/zoom';
import type { OverlayLane } from './index';

// Animation area: the zoom-n-pan row under the tracks.
export const zoomLane: OverlayLane = {
  id: 'zooms',
  label: 'Zoom',
  items: (p) => p.zooms.map((z, i) => ({ id: z.id, start: z.start, duration: z.duration, label: `Zoom ${i + 1}` })),
  update: (p, id, patch) => updateZoom(p, id, patch),
};
