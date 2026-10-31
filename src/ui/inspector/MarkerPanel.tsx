import { type ReactElement, useRef } from 'react';
import { MAX_MARKER_NAME, moveMarker, removeMarker, renameMarker, setMarkerChapter } from '../../engine/markers';
import { type Project, projectDuration } from '../../engine/project';
import { timecode } from '../format';
import { Icon } from '../icons';
import { Field } from './Field';
import type { InspectorProps } from './types';

// The panel shown when a marker is selected.
export function MarkerPanel({ editor, time, onSeek }: InspectorProps): ReactElement | null {
  const { project, selection } = editor;
  const before = useRef<Project | null>(null);
  const marker = selection.length === 1 ? project.markers.find((m) => m.id === selection[0]) : undefined;
  if (!marker) return null;

  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };

  return (
    <section className="panel inspector" aria-label="Marker">
      <header className="panel-head">
        <h2>Marker</h2>
      </header>
      <div className="fields">
        <div className="field wide">
          <label htmlFor="marker-name">Name</label>
          <input
            id="marker-name"
            type="text"
            maxLength={MAX_MARKER_NAME}
            value={marker.name}
            onFocus={begin}
            onChange={(e) => {
              begin();
              editor.preview(renameMarker(editor.getProject(), marker.id, e.target.value));
            }}
            onBlur={commit}
          />
        </div>
        <Field
          label="Time"
          value={marker.time}
          min={0}
          max={Math.max(projectDuration(project), marker.time, 1)}
          step={0.05}
          unit="s"
          onPreview={(v) => {
            begin();
            editor.preview(moveMarker(editor.getProject(), marker.id, v));
          }}
          onCommit={commit}
        />
        <label className="check">
          <input type="checkbox" checked={marker.chapter} onChange={(e) => editor.commit(setMarkerChapter(editor.getProject(), marker.id, e.target.checked))} />
          Chapter: written to the exported video and offered as a chapters file
        </label>
      </div>
      <p className="hint">At {timecode(marker.time, project.fps)}. The playhead is at {timecode(time, project.fps)}.</p>
      <div className="inspector-actions">
        <button className="button" onClick={() => onSeek(marker.time)}>
          Go to marker
        </button>
        <button className="button" onClick={() => editor.commit(moveMarker(editor.getProject(), marker.id, time))}>
          Move to playhead
        </button>
        <button
          className="button"
          onClick={() => {
            editor.commit(removeMarker(editor.getProject(), marker.id));
            editor.setSelection([]);
          }}
        >
          <Icon name="trash" />
          Delete marker
        </button>
      </div>
    </section>
  );
}
