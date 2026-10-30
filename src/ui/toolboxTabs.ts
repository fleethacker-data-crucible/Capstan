// The left-hand toolbox: Media plus one tab per feature area. A tab shows only when its panel module
// sets `enabled`, so each area adds its own file and flips one flag.
import type { ComponentType } from 'react';
import type { Editor } from './useEditor';
import * as annotations from './panels/AnnotationsPanel';
import * as animation from './panels/AnimationPanel';
import * as audio from './panels/AudioPanel';
import * as captions from './panels/CaptionsPanel';
import * as cursor from './panels/CursorPanel';
import * as effects from './panels/EffectsPanel';

export interface ToolboxProps {
  editor: Editor;
  time: number;
  onSeek(t: number): void;
}

export interface ToolboxTab {
  id: string;
  label: string;
  Panel: ComponentType<ToolboxProps>;
}

function entry(m: { enabled: boolean; tab: { id: string; label: string } }, Panel: ComponentType<ToolboxProps>): ToolboxTab[] {
  return m.enabled ? [{ ...m.tab, Panel }] : [];
}

export const TOOLBOX_TABS: ToolboxTab[] = [
  ...entry(annotations, annotations.AnnotationsPanel),
  ...entry(effects, effects.EffectsPanel),
  ...entry(animation, animation.AnimationPanel),
  ...entry(cursor, cursor.CursorPanel),
  ...entry(audio, audio.AudioPanel),
  ...entry(captions, captions.CaptionsPanel),
];
