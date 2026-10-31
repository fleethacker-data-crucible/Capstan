import { useRef, useState } from 'react';
import { formatSrt, parseSubtitles } from '../engine/captions';
import { keyedProps, updateClipPropsAt } from '../engine/animate';
import { addRedaction, duplicateClip, removeRedaction, resizeCanvas, setCaptions, updateClipProps, updateProject, updateRedaction } from '../engine/ops';
import { type ClipProps, type Project, type Redaction, defaultProps, findMedia, projectDuration } from '../engine/project';
import { download, safeFileName, timecode } from './format';
import { Icon } from './icons';
import { AnimationSection } from './inspector/AnimationSection';
import { AnnotationPanel } from './inspector/AnnotationPanel';
import { AudioSection } from './inspector/AudioSection';
import { CaptionPanel } from './inspector/CaptionPanel';
import { CursorSection } from './inspector/CursorSection';
import { EditSection } from './inspector/EditSection';
import { EffectsSection } from './inspector/EffectsSection';
import { Field } from './inspector/Field';
import { MarkerPanel } from './inspector/MarkerPanel';
import { ProjectSections } from './inspector/ProjectSections';
import { ZoomPanel } from './inspector/ZoomPanel';
import type { Editor } from './useEditor';

const SIZES: Array<{ label: string; width: number; height: number }> = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '1440p (2560×1440)', width: 2560, height: 1440 },
  { label: '4K (3840×2160)', width: 3840, height: 2160 },
  { label: 'Vertical (1080×1920)', width: 1080, height: 1920 },
  { label: 'Square (1080×1080)', width: 1080, height: 1080 },
];

function RedactionPanel({ editor, region, onSeek }: { editor: Editor; region: Redaction; onSeek(t: number): void }) {
  const { project } = editor;
  const before = useRef<Project | null>(null);
  const set = (patch: Partial<Omit<Redaction, 'id'>>) => {
    if (!before.current) before.current = editor.project;
    editor.preview(updateRedaction(editor.project, region.id, patch));
  };
  const commit = () => {
    if (before.current) editor.commit(editor.project, before.current);
    before.current = null;
  };
  const end = Math.max(projectDuration(project), region.start + region.duration);
  return (
    <section className="panel inspector" aria-label="Blur region">
      <header className="panel-head">
        <h2>Blur region</h2>
      </header>
      <p className="hint">Covers every track inside the box from {timecode(region.start, project.fps)} for {timecode(region.duration, project.fps)}. Drag it in the preview to move or resize it.</p>
      <div className="fields">
        <div className="field wide">
          <label htmlFor="redact-mode">Effect</label>
          <select id="redact-mode" value={region.mode} onChange={(e) => editor.commit(updateRedaction(project, region.id, { mode: e.target.value as Redaction['mode'] }))}>
            <option value="blur">Blur</option>
            <option value="pixelate">Pixelate</option>
          </select>
        </div>
        <Field label="Strength" value={region.strength} min={1} max={100} step={1} unit="%" onPreview={(v) => set({ strength: v })} onCommit={commit} />
        <Field label="Starts at" value={region.start} min={0} max={end} step={0.1} unit="s" onPreview={(v) => set({ start: v })} onCommit={commit} />
        <Field label="Length" value={region.duration} min={0.1} max={Math.max(1, end)} step={0.1} unit="s" onPreview={(v) => set({ duration: v })} onCommit={commit} />
        <Field label="Left" value={region.x} min={0} max={project.width} step={1} unit="px" onPreview={(v) => set({ x: v })} onCommit={commit} />
        <Field label="Top" value={region.y} min={0} max={project.height} step={1} unit="px" onPreview={(v) => set({ y: v })} onCommit={commit} />
        <Field label="Width" value={region.width} min={8} max={project.width} step={1} unit="px" onPreview={(v) => set({ width: v })} onCommit={commit} />
        <Field label="Height" value={region.height} min={8} max={project.height} step={1} unit="px" onPreview={(v) => set({ height: v })} onCommit={commit} />
      </div>
      <div className="inspector-actions">
        <button className="button" onClick={() => onSeek(region.start)}>
          Go to start
        </button>
        <button
          className="button"
          onClick={() => {
            editor.commit(removeRedaction(project, region.id));
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

function AnnotationSections({ editor, time, onSeek }: { editor: Editor; time: number; onSeek(t: number): void }) {
  const { project } = editor;
  const [note, setNote] = useState('');
  const importCaptions = async (file: File) => {
    try {
      const captions = parseSubtitles(await file.text());
      if (!captions.length) {
        setNote(`${file.name} has no captions Capstan can read (SRT or WebVTT).`);
        return;
      }
      editor.commit(setCaptions(project, captions));
      setNote(`Imported ${captions.length} captions from ${file.name}.`);
    } catch (e) {
      setNote(`Could not read ${file.name}: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <section className="inspector-section" aria-labelledby="blur-heading">
        <h3 id="blur-heading">Blur regions</h3>
        <p className="hint">Hide names, addresses and other personal details. A region covers every track beneath it.</p>
        {project.redactions.length > 0 && (
          <ul className="region-list">
            {project.redactions.map((r, i) => (
              <li key={r.id}>
                <button
                  className="region-item"
                  onClick={() => {
                    editor.setSelection([r.id]);
                    onSeek(r.start);
                  }}
                >
                  {`${r.mode === 'pixelate' ? 'Pixelate' : 'Blur'} ${i + 1}`}
                  <span>{`${timecode(r.start, project.fps)} – ${timecode(r.start + r.duration, project.fps)}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="button"
          onClick={() => {
            const r = addRedaction(project, time);
            editor.commit(r.project);
            editor.setSelection([r.id]);
          }}
        >
          <Icon name="plus" />
          Add blur region at playhead
        </button>
      </section>
      <section className="inspector-section" aria-labelledby="captions-heading">
        <h3 id="captions-heading">Captions</h3>
        <p className="hint">
          {project.captions.length
            ? `${project.captions.length} captions, shown in the preview and burned into exports unless you turn them off when exporting.`
            : 'Import an SRT or WebVTT file to show captions over the video.'}
        </p>
        <div className="inspector-actions">
          <label className="button file-button">
            Import captions
            <input
              type="file"
              accept=".srt,.vtt,text/vtt,application/x-subrip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importCaptions(f);
              }}
            />
          </label>
          <button className="button" disabled={!project.captions.length} onClick={() => download(new Blob([formatSrt(project.captions)], { type: 'text/plain' }), `${safeFileName(project.name)}.srt`)}>
            Save as .srt
          </button>
          <button
            className="button"
            disabled={!project.captions.length}
            onClick={() => {
              editor.commit(setCaptions(project, []));
              setNote('Captions removed.');
            }}
          >
            Remove
          </button>
        </div>
        {note && (
          <p className="hint" role="status">
            {note}
          </p>
        )}
      </section>
    </>
  );
}

export function Inspector({ editor, time, onSeek }: { editor: Editor; time: number; onSeek(t: number): void }) {
  const { project, selection } = editor;
  const before = useRef<Project | null>(null);
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;
  const region = selection.length === 1 ? project.redactions.find((r) => r.id === selection[0]) : undefined;

  const begin = () => {
    if (!before.current) before.current = editor.project;
  };
  const commit = () => {
    if (before.current) editor.commit(editor.project, before.current);
    before.current = null;
  };

  if (region) return <RedactionPanel editor={editor} region={region} onSeek={onSeek} />;

  // Panels for the other things that can be selected. Each returns null unless its item is the selection.
  const panelProps = { editor, time, onSeek };
  if (selection.length === 1 && !clip) {
    const id = selection[0];
    if (project.annotations.some((a) => a.id === id) || project.zooms.some((z) => z.id === id) || project.captions.some((c) => c.id === id) || project.markers.some((m) => m.id === id)) {
      return (
        <>
          <AnnotationPanel {...panelProps} />
          <ZoomPanel {...panelProps} />
          <CaptionPanel {...panelProps} />
          <MarkerPanel {...panelProps} />
        </>
      );
    }
  }

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
                editor.commit(resizeCanvas(project, s.width, s.height));
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
        <AnnotationSections editor={editor} time={time} onSeek={onSeek} />
        <ProjectSections {...panelProps} />
        <CursorSection {...panelProps} />
      </section>
    );
  }

  const media = findMedia(project, clip.mediaId);
  const set = (patch: Partial<ClipProps>) => {
    begin();
    editor.preview(updateClipPropsAt(editor.project, clip.id, patch, time));
  };
  // Keyframed values as they are at the playhead, so the controls show what the picture shows.
  const shown = keyedProps(clip, time);
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
            <Field label="Scale" value={shown.scale * 100} min={5} max={400} step={1} unit="%" onPreview={(v) => set({ scale: v / 100 })} onCommit={commit} />
            <Field label="Position X" value={shown.x} min={-project.width} max={project.width * 2} step={1} unit="px" onPreview={(v) => set({ x: v })} onCommit={commit} />
            <Field label="Position Y" value={shown.y} min={-project.height} max={project.height * 2} step={1} unit="px" onPreview={(v) => set({ y: v })} onCommit={commit} />
            <Field label="Rotation" value={shown.rotation} min={-180} max={180} step={1} unit="°" onPreview={(v) => set({ rotation: v })} onCommit={commit} />
            <Field label="Opacity" value={shown.opacity * 100} min={0} max={100} step={1} unit="%" onPreview={(v) => set({ opacity: v / 100 })} onCommit={commit} />
          </>
        )}
        {audible && (
          <Field label="Volume" value={clip.props.volume * 100} min={0} max={200} step={1} unit="%" onPreview={(v) => set({ volume: v / 100 })} onCommit={commit} />
        )}
      </fieldset>
      <EditSection {...panelProps} clip={clip} locked={locked} />
      <EffectsSection {...panelProps} clip={clip} locked={locked} />
      <AnimationSection {...panelProps} clip={clip} locked={locked} />
      <AudioSection {...panelProps} clip={clip} locked={locked} />
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
          <Icon name="copy" />
          Duplicate
        </button>
      </div>
    </section>
  );
}
