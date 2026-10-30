import type { ReactElement } from 'react';
import { EFFECT_PRESETS, mergeEffects } from '../../engine/fx';
import { updateClipEffects } from '../../engine/fx-ops';
import { findMedia } from '../../engine/project';
import type { ToolboxProps } from '../toolboxTabs';

// Visual effects area: one-click presets (green screen, rounded card, device frames, colour looks).
export const enabled = true;
export const tab = { id: 'effects', label: 'Effects' };

export function EffectsPanel({ editor }: ToolboxProps): ReactElement {
  const { project, selection } = editor;
  const targets = project.clips.filter((c) => selection.includes(c.id) && findMedia(project, c.mediaId)?.kind !== 'audio');
  const ids = targets.map((c) => c.id);
  const locked = targets.some((c) => project.tracks.find((t) => t.id === c.trackId)?.locked);
  const disabled = targets.length === 0 || locked;

  return (
    <section className="panel fx-panel" aria-label="Effects">
      <header className="panel-head">
        <h2>Effects</h2>
      </header>
      <p className="hint">
        {targets.length === 0
          ? 'Select a video or image clip, then click a look to apply it. Presets stack: fine-tune each one in the clip properties.'
          : `Applies to ${targets.length === 1 ? 'the selected clip' : `${targets.length} selected clips`}. Fine-tune in the clip properties.`}
      </p>
      <div className="fx-presets" role="group" aria-label="Effect presets">
        {EFFECT_PRESETS.map((p) => (
          <button
            key={p.id}
            className="fx-preset"
            disabled={disabled}
            title={p.hint}
            onClick={() => editor.commit(updateClipEffects(editor.project, ids, (cur) => mergeEffects(cur, p.build(editor.project.height))))}
          >
            <strong>{p.label}</strong>
            <span>{p.hint}</span>
          </button>
        ))}
      </div>
      <div className="inspector-actions">
        <button className="button" disabled={disabled || !targets.some((c) => c.effects)} onClick={() => editor.commit(updateClipEffects(editor.project, ids, () => undefined))}>
          Clear effects
        </button>
      </div>
    </section>
  );
}
