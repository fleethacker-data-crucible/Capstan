import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Cursor area: cursor effects and key callouts. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'cursor', label: 'Cursor' };

export function CursorPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
