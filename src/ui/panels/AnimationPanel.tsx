import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Animation area: zoom-n-pan, transitions, behaviors. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'animation', label: 'Motion' };

export function AnimationPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
