import type { ReactElement } from 'react';
import { type Clip, clipSpeed } from '../../engine/project';
import type { ClipDecorProps } from '../ClipDecor';
import { EditIcon, type EditIconName } from '../editIcons';
import { Icon } from '../icons';

interface Badge {
  key: string;
  text?: string;
  icon?: EditIconName | 'speakerOff';
  title: string;
}

/** What the clip-editing area has done to a clip, as short badges. */
export function editBadges(clip: Clip): Badge[] {
  const out: Badge[] = [];
  const speed = clipSpeed(clip);
  if (!clip.freeze && Math.abs(speed - 1) > 1e-3) out.push({ key: 'speed', text: `${Math.round(speed * 100) / 100}×`, title: `Speed ${Math.round(speed * 100) / 100}×` });
  if (clip.freeze) out.push({ key: 'freeze', icon: 'freeze', text: 'Hold', title: 'Freeze frame: holds one picture' });
  if (clip.crop) out.push({ key: 'crop', icon: 'crop', title: 'Cropped' });
  if (clip.muteAudio) out.push({ key: 'mute', icon: 'speakerOff', title: 'Audio detached: this picture is silent' });
  if (clip.linkId) out.push({ key: 'link', icon: 'link', title: 'Linked: moves, trims, splits and deletes with its partner' });
  if (clip.groupId) out.push({ key: 'group', icon: 'group', title: 'Grouped: selects and moves with its group' });
  return out;
}

/** Words for the clip's accessible name. */
export function editNotes(clip: Clip): string {
  const notes = editBadges(clip).map((b) => b.title.split(':')[0].toLowerCase());
  if (clip.audioOnly) notes.unshift('audio only');
  return notes.length ? `, ${notes.join(', ')}` : '';
}

export function EditBadges({ clip, zoom }: ClipDecorProps): ReactElement | null {
  const badges = editBadges(clip);
  if (!badges.length) return null;
  const roomy = clip.duration * zoom > 90;
  return (
    <span className="clip-badges" aria-hidden>
      {badges.map((b) => (
        <span key={b.key} className={`clip-badge clip-badge-${b.key}`} title={b.title}>
          {b.icon === 'speakerOff' ? <Icon name="speakerOff" size={12} /> : b.icon ? <EditIcon name={b.icon} size={12} /> : null}
          {b.text && (roomy || !b.icon) ? <span>{b.text}</span> : null}
        </span>
      ))}
    </span>
  );
}
