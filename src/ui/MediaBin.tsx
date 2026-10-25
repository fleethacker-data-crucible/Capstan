import { useRef } from 'react';
import { addClip } from '../engine/ops';
import type { MediaItem } from '../engine/project';
import { bytes, shortDuration } from './format';
import { Icon, type IconName } from './icons';
import { MEDIA_DRAG_TYPE } from './Timeline';
import type { Editor } from './useEditor';

const KIND_ICON: Record<MediaItem['kind'], IconName> = { video: 'film', audio: 'wave', image: 'image' };

export function MediaBin({ editor, time, onRecord }: { editor: Editor; time: number; onRecord(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const { project } = editor;

  const addToTimeline = (m: MediaItem) => {
    const r = addClip(editor.project, m.id, time);
    if (r.clipId) {
      editor.commit(r.project);
      editor.setSelection([r.clipId]);
    }
  };

  return (
    <section className="panel media-bin" aria-label="Media">
      <header className="panel-head">
        <h2>Media</h2>
        <span className="count">{project.media.length || ''}</span>
      </header>
      <div className="bin-actions">
        <button className="button primary" onClick={onRecord}>
          <Icon name="record" size={16} />
          Record screen
        </button>
        <button className="button" onClick={() => input.current?.click()}>
          <Icon name="import" size={16} />
          Import media
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept="video/*,audio/*,image/*,.mkv,.mov"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) void editor.importFiles(files);
          }}
        />
      </div>
      {project.media.length === 0 ? (
        <p className="bin-empty">
          Recordings and imported files appear here. You can also drop video, audio or image files anywhere in the window.
        </p>
      ) : (
        <ul className="bin-list">
          {project.media.map((m) => {
            const used = project.clips.filter((c) => c.mediaId === m.id).length;
            return (
              <li
                key={m.id}
                className="bin-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => addToTimeline(m)}
                title={`${m.name}\nDouble-click or drag to add to the timeline`}
              >
                <div className={`bin-thumb kind-${m.kind}`}>
                  {m.thumb ? <img src={m.thumb} alt="" draggable={false} /> : <Icon name={KIND_ICON[m.kind]} size={22} />}
                  {m.kind !== 'image' && <span className="bin-duration">{shortDuration(m.duration)}</span>}
                </div>
                <div className="bin-meta">
                  <span className="bin-name">{m.name}</span>
                  <span className="bin-sub">
                    {m.kind === 'audio' ? 'Audio' : `${m.width}×${m.height}`} · {bytes(m.bytes)}
                    {used ? ` · used ${used}×` : ''}
                  </span>
                </div>
                <div className="bin-item-actions">
                  <button className="icon-button small" title="Add at playhead" onClick={() => addToTimeline(m)}>
                    <Icon name="plus" size={15} />
                  </button>
                  <button
                    className="icon-button small"
                    title="Remove from project"
                    onClick={() => {
                      if (used && !window.confirm(`Remove ${m.name}? Its ${used} clip(s) will be removed from the timeline.`)) return;
                      void editor.deleteMedia(m.id);
                    }}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
