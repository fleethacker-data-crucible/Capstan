import { type ReactElement, useRef } from 'react';
import { addMarker, removeMarker, renameMarker, toggleMarkerChapter } from '../../engine/markers';
import type { Project } from '../../engine/project';
import { timecode } from '../format';
import { Icon } from '../icons';
import type { InspectorProps } from './types';

// Sections shown in the project panel when nothing is selected (markers list, captions editor, templates, cursor).
export function ProjectSections({ editor, time, onSeek }: InspectorProps): ReactElement | null {
  const { project, selection } = editor;
  const before = useRef<Project | null>(null);
  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  const chapters = project.markers.filter((m) => m.chapter).length;

  return (
    <section className="inspector-section" aria-labelledby="markers-heading">
      <h3 id="markers-heading">Markers</h3>
      <p className="hint">
        {project.markers.length
          ? `${project.markers.length} marker${project.markers.length === 1 ? '' : 's'}${chapters ? `, ${chapters} written as chapters in the exported video` : ''}.`
          : 'Press M to drop a marker at the playhead. Mark one as a chapter to write it into the exported video.'}
      </p>
      {project.markers.length > 0 && (
        <ul className="marker-list">
          {project.markers.map((m) => (
            <li key={m.id} className={`marker-row${selection.includes(m.id) ? ' selected' : ''}`}>
              <button
                className="marker-jump"
                title="Go to this marker"
                onClick={() => onSeek(m.time)}
              >
                {timecode(m.time, project.fps)}
              </button>
              <input
                type="text"
                className="marker-name"
                aria-label={`Name of the marker at ${timecode(m.time, project.fps)}`}
                value={m.name}
                maxLength={80}
                onFocus={begin}
                onChange={(e) => {
                  begin();
                  editor.preview(renameMarker(editor.getProject(), m.id, e.target.value));
                }}
                onBlur={commit}
              />
              <label className="marker-chapter" title="Chapter: written to the exported video and offered as a chapters file">
                <input type="checkbox" checked={m.chapter} aria-label={`Chapter: ${m.name || 'Marker'}`} onChange={() => editor.commit(toggleMarkerChapter(editor.getProject(), m.id))} />
                Ch
              </label>
              <button
                className="icon-button small"
                title="Delete marker"
                aria-label={`Delete marker ${m.name || 'Marker'}`}
                onClick={() => {
                  editor.commit(removeMarker(editor.getProject(), m.id));
                  if (selection.includes(m.id)) editor.setSelection([]);
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        className="button"
        onClick={() => {
          const r = addMarker(editor.getProject(), time);
          editor.commit(r.project);
          if (r.id) editor.setSelection([r.id]);
        }}
      >
        <Icon name="plus" />
        Add marker at playhead
      </button>
    </section>
  );
}
