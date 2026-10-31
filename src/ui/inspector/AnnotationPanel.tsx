import { type ReactElement, useEffect, useRef } from 'react';
import { type AnnotationPatch, duplicateAnnotation, removeAnnotation, reorderAnnotation, updateAnnotation } from '../../engine/annotationOps';
import {
  type AnnotationStyle,
  type BoxShape,
  FONT_KEYS,
  FONT_LABELS,
  type FontKey,
  KIND_LABELS,
  type TextAlign,
  canSketch,
  fitTextHeight,
  hasText,
  isLineKind,
} from '../../engine/annotations';
import type { Project } from '../../engine/project';
import { projectDuration } from '../../engine/project';
import { timecode } from '../format';
import { Icon } from '../icons';
import { Field } from './Field';
import type { InspectorProps } from './types';

const COMMIT_DELAY_MS = 700;

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D | null {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/** A colour picker with a "none" switch, for optional fills and outlines. */
function ColourField({
  id,
  label,
  value,
  optional,
  fallback,
  onTyping,
  onNow,
  onBlur,
}: {
  id: string;
  label: string;
  value: string;
  optional: boolean;
  fallback: string;
  onTyping(v: string): void;
  onNow(v: string): void;
  onBlur(): void;
}): ReactElement {
  return (
    <div className="field wide ann-colour">
      <label htmlFor={id}>{label}</label>
      <div className="ann-colour-row">
        <input id={id} type="color" value={value || fallback} aria-label={label} onChange={(e) => onTyping(e.target.value)} onBlur={onBlur} />
        {optional && (
          <label className="check ann-none">
            <input type="checkbox" checked={!value} aria-label={`No ${label.toLowerCase()}`} onChange={(e) => onNow(e.target.checked ? '' : fallback)} />
            None
          </label>
        )}
      </div>
    </div>
  );
}

// Annotations area: the panel shown when an annotation is selected.
export function AnnotationPanel({ editor, time, onSeek }: InspectorProps): ReactElement | null {
  const { project, selection } = editor;
  const a = selection.length === 1 ? project.annotations.find((x) => x.id === selection[0]) : undefined;
  const before = useRef<Project | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = a?.id;

  const flush = () => {
    clearTimeout(timer.current);
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  // Switching to another item (or leaving) records whatever was still being typed.
  useEffect(() => flush, [id]);

  if (!a) return null;

  const begin = () => {
    if (!before.current) before.current = editor.getProject();
  };
  /** Shows a change now; recorded by a field's own commit (sliders) or by flush. */
  const live = (patch: AnnotationPatch) => {
    begin();
    editor.preview(updateAnnotation(editor.getProject(), a.id, patch));
  };
  /** Shows a change now and records it shortly after the last keystroke or colour change. */
  const typing = (patch: AnnotationPatch) => {
    live(patch);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, COMMIT_DELAY_MS);
  };
  /** One undo step for a discrete choice. */
  const now = (patch: AnnotationPatch) => {
    flush();
    editor.commit(updateAnnotation(editor.getProject(), a.id, patch));
  };
  const style = (patch: Partial<AnnotationStyle>) => ({ style: patch });

  const s = a.style;
  const line = isLineKind(a.kind);
  const text = hasText(a.kind);
  const spot = a.kind === 'spotlight';
  const boxy = a.kind === 'text' || a.kind === 'callout' || a.kind === 'rect' || a.kind === 'highlight' || spot;
  const end = Math.max(60, projectDuration(project), a.start + a.duration);
  const index = project.annotations.findIndex((x) => x.id === a.id);

  return (
    <section className="panel inspector annotation-panel" aria-label={KIND_LABELS[a.kind]}>
      <header className="panel-head">
        <h2>{KIND_LABELS[a.kind]}</h2>
      </header>
      <p className="hint">
        Shown from {timecode(a.start, project.fps)} for {timecode(a.duration, project.fps)}. Drag it in the preview; handles resize, rotate
        {a.kind === 'callout' ? ' and aim the tail' : line ? ' the end points' : ''}.
      </p>

      {text && (
        <div className="fields">
          <div className="field wide">
            <label htmlFor="ann-text">Text</label>
            <textarea
              id="ann-text"
              className="fl-input ann-text"
              rows={3}
              maxLength={1000}
              value={a.text}
              onChange={(e) => typing({ text: e.target.value })}
              onBlur={flush}
            />
          </div>
          <button
            className="button"
            onClick={() => {
              const ctx = measurer();
              if (ctx) now({ height: fitTextHeight(ctx, a) });
            }}
          >
            Fit height to text
          </button>
        </div>
      )}

      {text && (
        <div className="fields" role="group" aria-label="Text style">
          <div className="field wide">
            <label htmlFor="ann-font">Font</label>
            <select id="ann-font" value={s.font} onChange={(e) => now(style({ font: e.target.value as FontKey }))}>
              {FONT_KEYS.map((f) => (
                <option key={f} value={f}>
                  {FONT_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <Field label="Font size" value={s.size} min={8} max={240} step={1} unit="px" onPreview={(v) => live(style({ size: v }))} onCommit={flush} />
          <div className="ann-toggles">
            <button className={`button${s.bold ? ' on' : ''}`} aria-pressed={s.bold} aria-label="Bold" title="Bold" onClick={() => now(style({ bold: !s.bold }))}>
              <b>B</b>
            </button>
            <button className={`button${s.italic ? ' on' : ''}`} aria-pressed={s.italic} aria-label="Italic" title="Italic" onClick={() => now(style({ italic: !s.italic }))}>
              <i>I</i>
            </button>
            <select aria-label="Text alignment" value={s.align} onChange={(e) => now(style({ align: e.target.value as TextAlign }))}>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </div>
          <ColourField id="ann-colour" label="Text colour" value={s.color} optional={false} fallback="#ffffff" onTyping={(v) => typing(style({ color: v }))} onNow={() => undefined} onBlur={flush} />
        </div>
      )}

      <div className="fields" role="group" aria-label="Shape style">
        {(a.kind === 'highlight' || spot) && (
          <div className="field wide">
            <label htmlFor="ann-shape">Shape</label>
            <select id="ann-shape" value={a.shape} onChange={(e) => now({ shape: e.target.value as BoxShape })}>
              <option value="rect">Box</option>
              <option value="ellipse">Ellipse</option>
            </select>
          </div>
        )}
        {!line && (
          <ColourField
            id="ann-fill"
            label={spot ? 'Dim colour' : 'Fill colour'}
            value={s.fill}
            optional={!spot}
            fallback={a.kind === 'highlight' ? '#ffe14a' : '#fff7cc'}
            onTyping={(v) => typing(style({ fill: v }))}
            onNow={(v) => now(style({ fill: v }))}
            onBlur={flush}
          />
        )}
        {!line && !spot && <Field label="Fill opacity" value={s.fillAlpha * 100} min={0} max={100} step={1} unit="%" onPreview={(v) => live(style({ fillAlpha: v / 100 }))} onCommit={flush} />}
        {spot && <Field label="Dimming" value={s.dim * 100} min={0} max={100} step={1} unit="%" onPreview={(v) => live(style({ dim: v / 100 }))} onCommit={flush} />}
        {spot && <Field label="Soft edge" value={s.feather} min={0} max={200} step={1} unit="px" onPreview={(v) => live(style({ feather: v }))} onCommit={flush} />}
        {!spot && a.kind !== 'highlight' && (
          <ColourField
            id="ann-stroke"
            label={line ? 'Line colour' : 'Outline colour'}
            value={s.stroke}
            optional={!line}
            fallback="#ff3b30"
            onTyping={(v) => typing(style({ stroke: v }))}
            onNow={(v) => now(style({ stroke: v, ...(v && s.strokeWidth <= 0 ? { strokeWidth: 4 } : {}) }))}
            onBlur={flush}
          />
        )}
        {!spot && a.kind !== 'highlight' && (
          <Field label={line ? 'Line width' : 'Outline width'} value={s.strokeWidth} min={0} max={40} step={1} unit="px" onPreview={(v) => live(style({ strokeWidth: v }))} onCommit={flush} />
        )}
        {boxy && a.shape !== 'ellipse' && <Field label="Corner radius" value={s.radius} min={0} max={200} step={1} unit="px" onPreview={(v) => live(style({ radius: v }))} onCommit={flush} />}
        {!spot && a.kind !== 'highlight' && (
          <label className="check ann-shadow">
            <input type="checkbox" checked={s.shadow} onChange={(e) => now(style({ shadow: e.target.checked }))} />
            Soft shadow
          </label>
        )}
      </div>

      {canSketch(a.kind) && (
        <div className="fields" role="group" aria-label="Sketch motion">
          <Field label="Draw on over" value={a.sketch} min={0} max={10} step={0.1} unit="s" onPreview={(v) => live({ sketch: v })} onCommit={flush} />
          <p className="hint ann-hint">0 keeps it fully drawn. Otherwise the outline draws itself from the start over this many seconds.</p>
        </div>
      )}

      <div className="fields" role="group" aria-label="Timing and position">
        <Field label="Start" value={a.start} min={0} max={end} step={0.1} unit="s" onPreview={(v) => live({ start: v })} onCommit={flush} />
        <Field label="Duration" value={a.duration} min={0.1} max={Math.max(30, a.duration)} step={0.1} unit="s" onPreview={(v) => live({ duration: v })} onCommit={flush} />
        <Field label="Opacity" value={a.opacity * 100} min={0} max={100} step={1} unit="%" onPreview={(v) => live({ opacity: v / 100 })} onCommit={flush} />
        {!line && <Field label="Rotation" value={a.rotation} min={-180} max={180} step={1} unit="°" onPreview={(v) => live({ rotation: v })} onCommit={flush} />}
        <Field label="Left" value={a.x} min={-project.width} max={project.width * 2} step={1} unit="px" onPreview={(v) => live({ x: v })} onCommit={flush} />
        <Field label="Top" value={a.y} min={-project.height} max={project.height * 2} step={1} unit="px" onPreview={(v) => live({ y: v })} onCommit={flush} />
        <Field label="Box width" value={a.width} min={1} max={project.width * 2} step={1} unit="px" onPreview={(v) => live({ width: v })} onCommit={flush} />
        <Field label="Box height" value={a.height} min={1} max={project.height * 2} step={1} unit="px" onPreview={(v) => live({ height: v })} onCommit={flush} />
      </div>

      <div className="inspector-actions">
        <button className="button" onClick={() => onSeek(a.start)}>
          Go to start
        </button>
        <button
          className="button"
          onClick={() => {
            flush();
            const r = duplicateAnnotation(editor.getProject(), a.id);
            if (r.id) {
              editor.commit(r.project);
              editor.setSelection([r.id]);
            }
          }}
        >
          <Icon name="copy" />
          Duplicate
        </button>
        <button
          className="button"
          disabled={index >= project.annotations.length - 1}
          onClick={() => {
            flush();
            editor.commit(reorderAnnotation(editor.getProject(), a.id, 'front'));
          }}
        >
          Bring to front
        </button>
        <button
          className="button"
          disabled={index <= 0}
          onClick={() => {
            flush();
            editor.commit(reorderAnnotation(editor.getProject(), a.id, 'back'));
          }}
        >
          Send to back
        </button>
        <button
          className="button"
          onClick={() => {
            flush();
            editor.commit(removeAnnotation(editor.getProject(), a.id));
            editor.setSelection([]);
          }}
        >
          <Icon name="trash" />
          Delete
        </button>
      </div>
      {(a.start > time || a.start + a.duration <= time) && <p className="hint ann-hint">The playhead is outside this annotation, so it is not shown in the preview.</p>}
    </section>
  );
}
