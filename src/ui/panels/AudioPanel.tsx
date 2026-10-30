import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Audio area: audio effects and processing. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'audio', label: 'Audio' };

export function AudioPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
