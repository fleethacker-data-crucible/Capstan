import type { ReactElement } from 'react';
import type { ToolboxProps } from '../toolboxTabs';

// Annotations area: add text, callouts, shapes, arrows, highlights. Set `enabled` to true once the panel has content: a disabled tab is not shown.
export const enabled = false;
export const tab = { id: 'annotations', label: 'Notes' };

export function AnnotationsPanel(_props: ToolboxProps): ReactElement | null {
  return null;
}
