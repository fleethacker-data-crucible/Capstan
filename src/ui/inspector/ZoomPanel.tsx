import { type ReactElement, useRef } from 'react';
import { EASE_NAMES, type EaseName } from '../../engine/anim';
import { type Project, projectDuration } from '../../engine/project';
import { type ZoomRegion, MAX_ZOOM, duplicateZoom, regionCamera, removeZoom, updateZoom, zoomRect } from '../../engine/zoom';
import { timecode } from '../format';
import { Icon } from '../icons';
import { Field } from './Field';
import type { InspectorProps } from './types';

const EASE_LABEL: Record<EaseName, string> = { linear: 'Linear', in: 'Ease in', out: 'Ease out', inOut: 'Ease in and out', hold: 'Hold', back: 'Overshoot', bounce: 'Bounce' };

// Animation area: the panel shown when a zoom-n-pan region is selected.
export function ZoomPanel({ editor, onSeek }: InspectorProps): ReactElement | null {
  const { project, selection } = editor;
  const region = selection.length === 1 ? project.zooms.find((z) => z.id === selection[0]) : undefined;
  const before = useRef<Project | null>(null);
  if (!region) return null;
  const index = project.zooms.indexOf(region);
  const set = (patch: Partial<Omit<ZoomRegion, 'id'>>) => {
    if (!before.current) before.current = editor.project;
    editor.preview(updateZoom(editor.project, region.id, patch));
  };
  const commit = () => {
    if (before.current) editor.commit(editor.project, before.current);
    before.current = null;
  };
  const end = Math.max(projectDuration(project), region.start + region.duration);
  const level = regionCamera(region, project).scale;
  const centre = { x: region.x + region.width / 2, y: region.y + region.height / 2 };
  return (
    <section className="panel inspector" aria-label="Zoom region">
      <header className="panel-head">
        <h2>{`Zoom ${index + 1}`}</h2>
      </header>
      <p className="hint">
        The picture zooms onto the box from {timecode(region.start, project.fps)} for {timecode(region.duration, project.fps)}, then zooms back out. Drag the box in the preview to move it, or its corner to resize.
      </p>
      <div className="fields">
        <Field label="Zoom" value={level} min={1.1} max={MAX_ZOOM} step={0.1} unit="×" onPreview={(v) => set(zoomRect(project, v, centre))} onCommit={commit} />
        <Field label="Left" value={region.x} min={0} max={project.width} step={1} unit="px" onPreview={(v) => set({ x: v })} onCommit={commit} />
        <Field label="Top" value={region.y} min={0} max={project.height} step={1} unit="px" onPreview={(v) => set({ y: v })} onCommit={commit} />
        <Field label="Starts at" value={region.start} min={0} max={end} step={0.1} unit="s" onPreview={(v) => set({ start: v })} onCommit={commit} />
        <Field label="Length" value={region.duration} min={0.1} max={Math.max(1, end)} step={0.1} unit="s" onPreview={(v) => set({ duration: v })} onCommit={commit} />
        <Field label="Zoom in over" value={region.easeIn} min={0} max={Math.max(0.1, region.duration)} step={0.1} unit="s" onPreview={(v) => set({ easeIn: v })} onCommit={commit} />
        <Field label="Zoom out over" value={region.easeOut} min={0} max={Math.max(0.1, region.duration)} step={0.1} unit="s" onPreview={(v) => set({ easeOut: v })} onCommit={commit} />
        <div className="field wide">
          <label htmlFor="zoom-ease">Easing</label>
          <select id="zoom-ease" value={region.ease} onChange={(e) => editor.commit(updateZoom(project, region.id, { ease: e.target.value as EaseName }))}>
            {EASE_NAMES.filter((n) => n !== 'hold').map((n) => (
              <option key={n} value={n}>
                {EASE_LABEL[n]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="inspector-actions">
        <button className="button" onClick={() => onSeek(region.start)}>
          Go to start
        </button>
        <button
          className="button"
          onClick={() => {
            const r = duplicateZoom(project, region.id);
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
          onClick={() => {
            editor.commit(removeZoom(project, region.id));
            editor.setSelection([]);
          }}
        >
          <Icon name="trash" />
          Delete region
        </button>
      </div>
    </section>
  );
}
