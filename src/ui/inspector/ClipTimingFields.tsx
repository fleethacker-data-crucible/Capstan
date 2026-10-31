import { useState } from 'react';
import { moveClip, trimEnd } from '../../engine/ops';
import type { Clip } from '../../engine/project';
import type { Editor } from '../useEditor';

const round = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Typed start and length for a clip, so timing can be set without dragging. A value is applied when the
 * field loses focus or Enter is pressed; if the neighbouring clips leave no room, the field says so and
 * goes back to the real value.
 */
export function ClipTimingFields({ editor, clip, locked }: { editor: Editor; clip: Clip; locked: boolean }) {
  const { project } = editor;
  const [draft, setDraft] = useState<{ start?: string; length?: string }>({});
  const step = 1 / project.fps;

  const apply = (field: 'start' | 'length') => {
    const text = draft[field];
    setDraft((d) => ({ ...d, [field]: undefined }));
    if (text === undefined) return;
    const value = Number(text);
    if (!Number.isFinite(value)) return;
    const current = editor.getProject();
    const target = current.clips.find((c) => c.id === clip.id);
    if (!target) return;
    if (field === 'start') {
      if (Math.abs(value - target.start) < 1e-6) return;
      const next = moveClip(current, clip.id, Math.max(0, value));
      if (next === current) editor.setStatus('The clip cannot start there: another clip is in the way.');
      else {
        editor.commit(next);
        editor.setStatus(`Clip now starts at ${round(Math.max(0, value))} s.`);
      }
    } else {
      if (Math.abs(value - target.duration) < 1e-6) return;
      const next = trimEnd(current, clip.id, target.start + value);
      if (next === current) editor.setStatus('The clip cannot be that length: the next clip or the end of the media is in the way.');
      else {
        editor.commit(next);
        editor.setStatus(`Clip is now ${round(next.clips.find((c) => c.id === clip.id)?.duration ?? value)} s long.`);
      }
    }
  };

  const field = (name: 'start' | 'length', label: string, value: number, min: number) => (
    <div className="field wide">
      <label htmlFor={`clip-${name}`}>{label}</label>
      <input
        id={`clip-${name}`}
        type="number"
        min={min}
        step={step}
        value={draft[name] ?? round(value)}
        onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
        onBlur={() => apply(name)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply(name);
          } else if (e.key === 'Escape') {
            setDraft((d) => ({ ...d, [name]: undefined }));
          }
        }}
      />
    </div>
  );

  return (
    <fieldset className="fields" disabled={locked} aria-label="Clip timing">
      {field('start', 'Start (seconds)', clip.start, 0)}
      {field('length', 'Length (seconds)', clip.duration, step)}
    </fieldset>
  );
}
