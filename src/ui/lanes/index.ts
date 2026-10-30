// Overlay lanes: timed items that are not clips (blur regions, annotations, captions, zoom-n-pan)
// get a row under the tracks where they can be selected, moved and trimmed. A lane shows only
// while it has items. Each area adds its own lane file and one line below.
import { updateRedaction } from '../../engine/ops';
import type { Project } from '../../engine/project';
import { annotationLane } from './annotationLane';
import { captionLane } from './captionLane';
import { zoomLane } from './zoomLane';

export interface LaneItem {
  id: string;
  start: number;
  duration: number;
  label: string;
}

export interface OverlayLane {
  id: string;
  label: string;
  items(project: Project): LaneItem[];
  /** Moves or resizes one item. Returns the project unchanged when nothing applies. */
  update(project: Project, id: string, patch: { start?: number; duration?: number }): Project;
}

const redactionLane: OverlayLane = {
  id: 'redactions',
  label: 'Blur',
  items: (p) => p.redactions.map((r, i) => ({ id: r.id, start: r.start, duration: r.duration, label: `${r.mode === 'pixelate' ? 'Pixelate' : 'Blur'} ${i + 1}` })),
  update: (p, id, patch) => updateRedaction(p, id, patch),
};

export const OVERLAY_LANES: OverlayLane[] = [annotationLane, redactionLane, zoomLane, captionLane];
