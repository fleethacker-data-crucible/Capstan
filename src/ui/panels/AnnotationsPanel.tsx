import type { ReactElement } from 'react';
import { addAnnotation, applyStylePreset } from '../../engine/annotationOps';
import { ANNOTATION_KINDS, type AnnotationKind, KIND_LABELS, STYLE_PRESETS } from '../../engine/annotations';
import { addRedaction } from '../../engine/ops';
import { Icon } from '../icons';
import type { ToolboxProps } from '../toolboxTabs';

// Annotations area: add text, callouts, shapes, arrows, highlights and spotlights at the playhead.
export const enabled = true;
export const tab = { id: 'annotations', label: 'Notes' };

const HINTS: Record<AnnotationKind, string> = {
  text: 'Words over the picture',
  callout: 'Speech bubble with a tail you aim',
  rect: 'Outlined box',
  ellipse: 'Outlined oval',
  arrow: 'Points at something',
  line: 'Straight line',
  highlight: 'Translucent marker box',
  spotlight: 'Dims everything outside a soft box',
};

export function AnnotationsPanel({ editor, time }: ToolboxProps): ReactElement {
  const { project, selection } = editor;
  const selected = selection.length === 1 ? project.annotations.find((a) => a.id === selection[0]) : undefined;

  const add = (kind: AnnotationKind) => {
    const r = addAnnotation(editor.getProject(), kind, time);
    if (!r.id) {
      editor.setStatus('Too many annotations in this project.');
      return;
    }
    editor.commit(r.project);
    editor.setSelection([r.id]);
  };

  const addCover = (mode: 'blur' | 'pixelate') => {
    const r = addRedaction(editor.getProject(), time, { mode });
    editor.commit(r.project);
    editor.setSelection([r.id]);
  };

  return (
    <section className="panel annotations-panel" aria-label="Annotations">
      <header className="panel-head">
        <h2>Annotations</h2>
        <span className="count">{project.annotations.length || ''}</span>
      </header>
      <p className="hint">Adds at the playhead for four seconds. Click it in the preview to move, resize or rotate; edit its text and style in the inspector.</p>
      <div className="ann-add-grid" role="group" aria-label="Add an annotation">
        {ANNOTATION_KINDS.map((kind) => (
          <button key={kind} className="button ann-add" title={HINTS[kind]} onClick={() => add(kind)}>
            <Icon name="plus" />
            {KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      <h3 className="ann-heading">Hide details</h3>
      <div className="ann-add-grid" role="group" aria-label="Add a cover">
        <button className="button ann-add" title="Blur everything beneath a box" onClick={() => addCover('blur')}>
          <Icon name="plus" />
          Blur region
        </button>
        <button className="button ann-add" title="Pixelate everything beneath a box" onClick={() => addCover('pixelate')}>
          <Icon name="plus" />
          Pixelate region
        </button>
      </div>
      <h3 className="ann-heading">Style presets</h3>
      {selected ? (
        <div className="ann-presets" role="group" aria-label="Style presets for the selected annotation">
          {STYLE_PRESETS.filter((p) => p.kinds.includes(selected.kind)).map((p) => (
            <button key={p.id} className="button" onClick={() => editor.commit(applyStylePreset(editor.getProject(), selected.id, p))}>
              {p.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">Select an annotation to apply a preset.</p>
      )}
      {project.annotations.length > 0 && (
        <>
          <h3 className="ann-heading">In this project</h3>
          <ul className="region-list" aria-label="Annotations in this project">
            {project.annotations.map((a, i) => (
              <li key={a.id}>
                <button className={`region-item${selection.includes(a.id) ? ' on' : ''}`} aria-pressed={selection.includes(a.id)} onClick={() => editor.setSelection([a.id])}>
                  {i + 1}. {KIND_LABELS[a.kind]}
                  {a.text ? `: ${a.text.slice(0, 18)}` : ''}
                  <span>{a.start.toFixed(1)}s</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
