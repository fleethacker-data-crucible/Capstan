import type { ReactElement } from 'react';
import type { ClipDecorProps } from '../ClipDecor';
import { EditBadges } from './EditBadges';

// Editing and effects areas: small badges for speed, freeze, crop, effects.
export function ClipBadges(props: ClipDecorProps): ReactElement | null {
  return <EditBadges {...props} />;
}
