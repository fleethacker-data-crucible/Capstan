import type { Clip } from '../../engine/project';
import type { Editor } from '../useEditor';

export interface InspectorProps {
  editor: Editor;
  /** Playhead position, seconds. */
  time: number;
  onSeek(t: number): void;
}

export interface ClipSectionProps extends InspectorProps {
  clip: Clip;
  /** True when the clip's track is locked: disable controls. */
  locked: boolean;
}
