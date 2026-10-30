// Extras drawn inside a timeline clip: waveform, speed and effect badges, keyframe marks.
import type { Clip, MediaItem } from '../engine/project';
import { ClipBadges } from './decor/ClipBadges';
import { KeyframeMarks } from './decor/KeyframeMarks';
import { Waveform } from './decor/Waveform';
import type { Editor } from './useEditor';

export interface ClipDecorProps {
  editor: Editor;
  clip: Clip;
  media: MediaItem | undefined;
  /** Timeline pixels per second. */
  zoom: number;
}

export function ClipDecor(props: ClipDecorProps) {
  return (
    <>
      <Waveform {...props} />
      <KeyframeMarks {...props} />
      <ClipBadges {...props} />
    </>
  );
}
