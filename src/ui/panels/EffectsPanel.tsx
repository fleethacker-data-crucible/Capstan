import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Visual effects area: effect presets and device frames. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'effects', label: 'Effects' };

export function EffectsPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
