import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Editing area: caption list and editor. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'captions', label: 'Captions' };

export function CaptionsPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
