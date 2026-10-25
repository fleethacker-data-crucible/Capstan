import { useRef } from 'react';
import { duplicateClip, updateClipProps, updateProject } from '../engine/ops';
import { type ClipProps, type Project, defaultProps, findMedia } from '../engine/project';
import { timecode } from './format';
import { Icon } from './icons';
import type { Editor } from './useEditor';

const SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '1440p (2560×1440)', width: 2560, height: 1440 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: 'Vertical (1080×1920)', width: 1080, height: 1920 },
  { label: 'Square (1080×1080)', width: 1080, height: 1080 },
];

/**
 * A slider + number pair. Dragging previews the change; letting go records one undo step.
 */
function Field({
  label,
  value,
  min,
  max,
  step,
  unit,
  onPreview,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onPreview(v: number): void;
  onCommit(): void;
}) {
  const id = `f-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        aria-label={label}
        onChange={(e) => onPreview(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <div className="number">
        <input
          id={id}
          type="number"
          step={step}
          value={Number.isInteger(step) ? Math.round(value) : Math.round(value * 100) / 100}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onPreview(v);
          }}
          onBlur={onCommit}
          onKeyDown={(e) => e.key === 'Enter' && onCommit()}
        />
        {unit && <span>{unit}</span>}
      </div>
    </div>
  );
}

export function Inspector({ editor }: { editor: Editor }) {
  const { project, selection } = editor;
  const before = useRef<Project | null>(null);
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;

  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.project, before.current);
    before.current = null;
  };

  if (!clip) {
    const size = SIZES.find((s) => s.width === project.width && s.height === project.height);
    return (
      <section className="panel inspector" aria-label="Project settings">
        <header className="panel-head">
          <h2>Project</h2>
        </header>
        <div className="fields">
          <div className="field wide">
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              type="text"
              value={project.name}
              onFocus={begin}
              onChange={(e) => {
                begin();
                editor.preview(updateProject(editor.project, { name: e.target.value.slice(0, 120) }));
              }}
              onBlur={commit}
            />
          </div>
          <div className="field wide">
            <label htmlFor="project-size">Canvas</label>
            <select
              id="project-size"
              value={size ? size.label : 'custom'}
              onChange={(e) => {
                const s = SIZES.find((x) => x.label === e.target.value);
                if (!s) return;
                // Keep clips in the same relative place on the new canvas.
                const kx = s.width / project.width;
                const ky = s.height / project.height;
                const resized = updateProject(project, { width: s.width, height: s.height });
                editor.commit({
                  ...resized,
                  clips: resized.clips.map((c) => ({ ...c, props: { ...c.props, x: c.props.x * kx, y: c.props.y * ky } })),
                });
              }}
            >
              {!size && <option value="custom">{`${project.width}×${project.height}`}</option>}
              {SIZES.map((s) => (
                <option key={s.label}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="project-fps">Frame rate</label>
            <select
              id="project-fps"
              value={project.fps}
              onChange={(e) => editor.commit(updateProject(project, { fps: Number(e.target.value) }))}
            >
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="project-bg">Background</label>
            <input
              id="project-bg"
              type="color"
              value={project.background}
              onFocus={begin}
              onChange={(e) => {
                begin();
                editor.preview(updateProject(editor.project, { background: e.target.value }));
              }}
              onBlur={commit}
            />
          </div>
        </div>
        <p className="hint">Select a clip on the timeline or in the preview to change its position, size and volume.</p>
      </section>
    );
  }

  const media = findMedia(project, clip.mediaId);
  const set = (patch: Partial<ClipProps>) => {
    begin();
    editor.preview(updateClipProps(editor.project, clip.id, patch));
  };
  const visual = media?.kind !== 'audio';
  const audible = media?.kind !== 'image';
  const locked = !!project.tracks.find((t) => t.id === clip.trackId)?.locked;

  return (
    <section className="panel inspector" aria-label="Clip properties">
      <header className="panel-head">
        <h2 title={media?.name}>{media?.name ?? 'Clip'}</h2>
      </header>
      <dl className="clip-timing">
        <div>
          <dt>Starts</dt>
          <dd>{timecode(clip.start, project.fps)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{timecode(clip.duration, project.fps)}</dd>
        </div>
        <div>
          <dt>From source</dt>
          <dd>{timecode(clip.in, project.fps)}</dd>
        </div>
      </dl>
      {locked && <p className="hint">This clip is on a locked track. Unlock the track to edit it.</p>}
      <fieldset className="fields" disabled={locked}>
        {visual && (
          <>
            <Field label="Scale" value={clip.props.scale * 100} min={5} max={400} step={1} unit="%" onPreview={(v) => set({ scale: v / 100 })} onCommit={commit} />
            <Field label="Position X" value={clip.props.x} min={-project.width} max={project.width * 2} step={1} unit="px" onPreview={(v) => set({ x: v })} onCommit={commit} />
            <Field label="Position Y" value={clip.props.y} min={-project.height} max={project.height * 2} step={1} unit="px" onPreview={(v) => set({ y: v })} onCommit={commit} />
            <Field label="Rotation" value={clip.props.rotation} min={-180} max={180} step={1} unit="°" onPreview={(v) => set({ rotation: v })} onCommit={commit} />
            <Field label="Opacity" value={clip.props.opacity * 100} min={0} max={100} step={1} unit="%" onPreview={(v) => set({ opacity: v / 100 })} onCommit={commit} />
          </>
        )}
        {audible && (
          <Field label="Volume" value={clip.props.volume * 100} min={0} max={200} step={1} unit="%" onPreview={(v) => set({ volume: v / 100 })} onCommit={commit} />
        )}
      </fieldset>
      <div className="inspector-actions">
        <button
          className="button"
          disabled={locked}
          onClick={() => {
            const d = defaultProps(project);
            editor.commit(updateClipProps(project, clip.id, { ...d, volume: clip.props.volume }));
          }}
        >
          Reset position
        </button>
        <button
          className="button"
          disabled={locked}
          onClick={() => {
            const r = duplicateClip(project, clip.id);
            if (r.clipId) {
              editor.commit(r.project);
              editor.setSelection([r.clipId]);
            }
          }}
        >
          <Icon name="copy" size={15} />
          Duplicate
        </button>
      </div>
    </section>
  );
}
