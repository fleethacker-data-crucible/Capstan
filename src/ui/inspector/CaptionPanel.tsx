import { type ReactElement, useRef } from 'react';
import { mergeWithNext, removeCaption, retimeCaption, splitCaption, updateCaptionText } from '../../engine/captionops';
import { MAX_CAPTION_CHARS, type Project, projectDuration } from '../../engine/project';
import { timecode } from '../format';
import { Icon } from '../icons';
import { Field } from './Field';
import type { InspectorProps } from './types';

/** A whole-number field for frame positions. Commits on blur or Enter. */
function FrameField({ id, label, value, onPreview, onCommit }: { id: string; label: string; value: number; onPreview(v: number): void; onCommit(): void }): ReactElement {
  return (
    <div className="field wide">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={0}
        step={1}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onPreview(Math.max(0, Math.round(v)));
        }}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === 'Enter' && onCommit()}
      />
    </div>
  );
}

// The caption editor shown when a caption is selected.
export function CaptionPanel({ editor, time, onSeek }: InspectorProps): ReactElement | null {
  const { project, selection } = editor;
  const before = useRef<Project | null>(null);
  const caption = selection.length === 1 ? project.captions.find((c) => c.id === selection[0]) : undefined;
  if (!caption) return null;

  const fps = project.fps;
  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  const retime = (patch: { start?: number; end?: number }) => {
    begin();
    editor.preview(retimeCaption(editor.getProject(), caption.id, patch));
  };
  const end = Math.max(projectDuration(project), caption.end);
  const index = project.captions.findIndex((c) => c.id === caption.id);
  const hasNext = index >= 0 && index + 1 < project.captions.length;
  const canSplit = time > caption.start + 0.05 && time < caption.end - 0.05;

  return (
    <section className="panel inspector" aria-label="Caption">
      <header className="panel-head">
        <h2>Caption {index + 1}</h2>
        <span className="count">{`${project.captions.length}`}</span>
      </header>
      <div className="fields">
        <div className="field wide">
          <label htmlFor="caption-text">Caption text</label>
          <textarea
            id="caption-text"
            className="caption-text"
            rows={4}
            maxLength={MAX_CAPTION_CHARS}
            value={caption.text}
            onFocus={begin}
            onChange={(e) => {
              begin();
              editor.preview(updateCaptionText(editor.getProject(), caption.id, e.target.value));
            }}
            onBlur={commit}
          />
        </div>
        <Field label="Start" value={caption.start} min={0} max={end} step={0.05} unit="s" onPreview={(v) => retime({ start: v })} onCommit={commit} />
        <Field label="End" value={caption.end} min={0} max={end + 5} step={0.05} unit="s" onPreview={(v) => retime({ end: v })} onCommit={commit} />
        <FrameField id="caption-start-frame" label={`Start frame (${fps} fps)`} value={Math.round(caption.start * fps)} onPreview={(f) => retime({ start: f / fps })} onCommit={commit} />
        <FrameField id="caption-end-frame" label="End frame" value={Math.round(caption.end * fps)} onPreview={(f) => retime({ end: f / fps })} onCommit={commit} />
      </div>
      <dl className="clip-timing">
        <div>
          <dt>Starts</dt>
          <dd>{timecode(caption.start, fps)}</dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>{timecode(caption.end, fps)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{`${Math.round((caption.end - caption.start) * fps)} frames`}</dd>
        </div>
      </dl>
      <div className="inspector-actions">
        <button className="button" onClick={() => onSeek(caption.start)}>
          Go to start
        </button>
        <button
          className="button"
          disabled={!canSplit}
          title={canSplit ? 'Cut this caption in two at the playhead' : 'Move the playhead inside the caption to split it'}
          onClick={() => {
            const r = splitCaption(editor.getProject(), time, caption.id);
            if (r.ids.length) {
              editor.commit(r.project);
              editor.setSelection([r.ids[0]]);
            }
          }}
        >
          <Icon name="split" />
          Split at playhead
        </button>
        <button
          className="button"
          disabled={!hasNext}
          onClick={() => {
            const r = mergeWithNext(editor.getProject(), caption.id);
            if (r.id) {
              editor.commit(r.project);
              editor.setSelection([r.id]);
            }
          }}
        >
          Merge with next
        </button>
        <button
          className="button"
          onClick={() => {
            editor.commit(removeCaption(editor.getProject(), caption.id));
            editor.setSelection([]);
          }}
        >
          <Icon name="trash" />
          Delete caption
        </button>
      </div>
    </section>
  );
}
