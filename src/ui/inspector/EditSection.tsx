import { type ReactElement, useRef, useState } from 'react';
import { canChangeSpeed, canDetachAudio, cropForAspect, deleteBundle, detachAudio, extendFrame, freezeFrame, setClipCrop, setClipSpeed, speedClamp, unlinkClips } from '../../engine/editops';
import { type Clip, type Project, MAX_SPEED, MIN_SPEED, clipEnd, clipSpeed, findMedia } from '../../engine/project';
import { cropMode, useCropMode } from '../cropMode';
import { copySelection, cutSelection, duplicateSelection, groupSelection, selectedClips, ungroupSelection } from '../editActions';
import { EditIcon } from '../editIcons';
import { timecode } from '../format';
import { Icon } from '../icons';
import { Field } from './Field';
import type { ClipSectionProps, InspectorProps } from './types';

const PRESETS = [0.25, 0.5, 1, 2, 4, 8];
const ASPECTS: Array<{ label: string; value: number | null }> = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
];

const speedToSlider = (s: number) => Math.round((Math.log(speedClamp(s) / MIN_SPEED) / Math.log(MAX_SPEED / MIN_SPEED)) * 1000);
const sliderToSpeed = (v: number) => Math.round(MIN_SPEED * (MAX_SPEED / MIN_SPEED) ** (v / 1000) * 100) / 100;
const fmtSpeed = (s: number) => `${Math.round(s * 100) / 100}×`;

// Editing area: speed, freeze frame, crop, detach audio for the selected clip.
export function EditSection({ editor, clip, locked, time }: ClipSectionProps): ReactElement | null {
  const { project } = editor;
  const media = findMedia(project, clip.mediaId);
  const before = useRef<Project | null>(null);
  const [ripple, setRipple] = useState(true);
  const [holdSeconds, setHoldSeconds] = useState('2');
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const crop = useCropMode();
  if (!media) return null;

  const speed = clipSpeed(clip);
  const visual = media.kind !== 'audio' && !clip.audioOnly;
  const hasSpeed = canChangeSpeed(project, clip);
  const cropping = crop.clipId === clip.id;
  const held = Math.max(0.1, Math.min(60, Number(holdSeconds) || 2));

  const previewSpeed = (v: number) => {
    if (!before.current) before.current = editor.getProject();
    editor.preview(setClipSpeed(before.current, clip.id, v, { ripple }));
  };
  const commitSpeed = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  const setCrop = (patch: Partial<NonNullable<Clip['crop']>>) => {
    if (!before.current) before.current = editor.getProject();
    const current = editor.getProject().clips.find((x) => x.id === clip.id)?.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    editor.preview(setClipCrop(editor.getProject(), clip.id, { ...current, ...patch }));
  };
  const commitCrop = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  const c = clip.crop ?? { x: 0, y: 0, width: 1, height: 1 };

  const freeze = () => {
    const r = freezeFrame(project, clip.id, time, held, { ripple });
    if (!r.clipId) {
      editor.setStatus('Move the playhead onto this clip to freeze a frame there');
      return;
    }
    editor.commit(r.project);
    editor.setSelection([r.clipId]);
    editor.setStatus(`Froze a frame for ${held} s`);
  };
  const extend = () => {
    const r = extendFrame(project, clip.id, held, { ripple });
    if (!r.clipId) {
      editor.setStatus('No room after this clip. Tick "Move later clips" to make room');
      return;
    }
    editor.commit(r.project);
    editor.setStatus(`Held the last frame for ${held} s`);
  };
  const detach = () => {
    const r = detachAudio(project, clip.id);
    if (!r.audioClipId) return;
    editor.commit(r.project);
    editor.setStatus('Audio detached to its own clip. The two stay linked');
  };

  return (
    <>
      {hasSpeed && (
        <section className="inspector-section edit-section" aria-labelledby="speed-heading">
          <h3 id="speed-heading">Speed</h3>
          <fieldset className="fields" disabled={locked}>
            <div className="field speed-field">
              <label htmlFor="clip-speed-slider">Playback speed</label>
              <input
                id="clip-speed-slider"
                type="range"
                min={0}
                max={1000}
                step={1}
                value={speedToSlider(speed)}
                aria-label="Speed"
                aria-valuetext={fmtSpeed(speed)}
                onChange={(e) => previewSpeed(sliderToSpeed(Number(e.target.value)))}
                onPointerUp={commitSpeed}
                onKeyUp={commitSpeed}
              />
              <div className="number">
                <input
                  type="number"
                  aria-label="Speed multiplier"
                  min={MIN_SPEED}
                  max={MAX_SPEED}
                  step={0.05}
                  value={speedDraft ?? String(Math.round(speed * 100) / 100)}
                  onChange={(e) => setSpeedDraft(e.target.value)}
                  onBlur={() => {
                    const v = Number(speedDraft);
                    setSpeedDraft(null);
                    if (speedDraft !== null && Number.isFinite(v) && v > 0) editor.commit(setClipSpeed(editor.getProject(), clip.id, v, { ripple }));
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <span>×</span>
              </div>
            </div>
            <div className="speed-presets" role="group" aria-label="Speed presets">
              {PRESETS.map((p) => (
                <button key={p} className="button speed-preset" aria-pressed={Math.abs(speed - p) < 0.005} onClick={() => editor.commit(setClipSpeed(editor.getProject(), clip.id, p, { ripple }))}>
                  {fmtSpeed(p)}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="hint speed-result" role="status">
            Length {timecode(clip.duration, project.fps)} on the timeline, {timecode(clip.duration * speed, project.fps)} of source.
          </p>
        </section>
      )}

      {visual && media.kind !== 'image' && (
        <section className="inspector-section edit-section" aria-labelledby="hold-heading">
          <h3 id="hold-heading">Freeze and extend</h3>
          <fieldset className="fields" disabled={locked}>
            <div className="field wide">
              <label htmlFor="hold-seconds">Hold for (seconds)</label>
              <input id="hold-seconds" type="number" min={0.1} max={60} step={0.5} value={holdSeconds} onChange={(e) => setHoldSeconds(e.target.value)} />
            </div>
            <label className="check">
              <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} />
              <span>Move later clips to make room</span>
            </label>
          </fieldset>
          <div className="inspector-actions">
            <button className="button" disabled={locked || !!clip.freeze || time < clip.start || time > clipEnd(clip)} onClick={freeze} title="Hold the picture at the playhead">
              <EditIcon name="freeze" />
              Freeze frame
            </button>
            <button className="button" disabled={locked} onClick={extend} title="Hold this clip's last picture after it ends">
              Extend frame
            </button>
          </div>
        </section>
      )}

      {visual && (
        <section className="inspector-section edit-section" aria-labelledby="crop-heading">
          <h3 id="crop-heading">Crop</h3>
          <div className="inspector-actions">
            <button className={`button${cropping ? ' on' : ''}`} aria-pressed={cropping} disabled={locked} onClick={() => cropMode.toggle(clip.id)}>
              <EditIcon name="crop" />
              {cropping ? 'Done cropping' : 'Crop'}
            </button>
            <button className="button" disabled={locked || !clip.crop} onClick={() => editor.commit(setClipCrop(editor.getProject(), clip.id, undefined))}>
              Reset crop
            </button>
          </div>
          {(cropping || clip.crop) && (
            <fieldset className="fields" disabled={locked}>
              <div className="field wide">
                <label htmlFor="crop-aspect">Shape</label>
                <select
                  id="crop-aspect"
                  value={ASPECTS.findIndex((a) => (a.value === null ? crop.aspect === null : crop.aspect !== null && Math.abs(a.value - crop.aspect) < 1e-6))}
                  onChange={(e) => {
                    const a = ASPECTS[Number(e.target.value)];
                    cropMode.setAspect(a.value);
                    if (a.value !== null) editor.commit(setClipCrop(editor.getProject(), clip.id, cropForAspect(media, clip.crop, a.value)));
                  }}
                >
                  {ASPECTS.map((a, i) => (
                    <option key={a.label} value={i}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <Field label="Crop left" value={c.x * 100} min={0} max={98} step={1} unit="%" onPreview={(v) => setCrop({ x: v / 100 })} onCommit={commitCrop} />
              <Field label="Crop top" value={c.y * 100} min={0} max={98} step={1} unit="%" onPreview={(v) => setCrop({ y: v / 100 })} onCommit={commitCrop} />
              <Field label="Crop width" value={c.width * 100} min={2} max={100} step={1} unit="%" onPreview={(v) => setCrop({ width: v / 100 })} onCommit={commitCrop} />
              <Field label="Crop height" value={c.height * 100} min={2} max={100} step={1} unit="%" onPreview={(v) => setCrop({ height: v / 100 })} onCommit={commitCrop} />
            </fieldset>
          )}
          <p className="hint">{cropping ? 'Drag the handles on the picture, or drag inside the frame to move it.' : 'Turn Crop on to frame part of the picture.'}</p>
        </section>
      )}

      {media.kind === 'video' && !clip.audioOnly && (
        <section className="inspector-section edit-section" aria-labelledby="detach-heading">
          <h3 id="detach-heading">Audio</h3>
          {clip.muteAudio ? (
            <p className="hint">This picture is silent: its sound plays from the linked audio clip, and they move, trim, split and delete together.</p>
          ) : !media.hasAudio ? (
            <p className="hint">This video has no sound to detach.</p>
          ) : (
            <p className="hint">Split the sound onto its own clip to cut, fade or move it apart from the picture.</p>
          )}
          <div className="inspector-actions">
            <button className="button" disabled={!canDetachAudio(project, clip)} onClick={detach}>
              <EditIcon name="detach" />
              Detach audio
            </button>
            {clip.linkId && (
              <button className="button" disabled={locked} onClick={() => editor.commit(unlinkClips(editor.getProject(), [clip.id]))} title="Stop moving these clips together">
                <EditIcon name="link" />
                Unlink
              </button>
            )}
          </div>
        </section>
      )}
      {clip.audioOnly && (
        <section className="inspector-section edit-section" aria-labelledby="detach-heading">
          <h3 id="detach-heading">Detached audio</h3>
          <p className="hint">Sound only. It stays linked to its picture clip, so the two move, trim, split and delete together.</p>
          <div className="inspector-actions">
            {clip.linkId && (
              <button className="button" disabled={locked} onClick={() => editor.commit(unlinkClips(editor.getProject(), [clip.id]))}>
                <EditIcon name="link" />
                Unlink
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/** Shown when several clips are selected: clipboard, grouping and delete. */
export function MultiClipPanel({ editor }: Pick<InspectorProps, 'editor'>): ReactElement {
  const { project } = editor;
  const ids = selectedClips(editor);
  const clips = project.clips.filter((c) => ids.includes(c.id));
  const grouped = clips.length > 0 && clips.every((c) => c.groupId && c.groupId === clips[0].groupId);
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map(clipEnd));
  return (
    <section className="panel inspector" aria-label="Selected clips">
      <header className="panel-head">
        <h2>{clips.length} clips selected</h2>
      </header>
      <dl className="clip-timing">
        <div>
          <dt>From</dt>
          <dd>{timecode(start, project.fps)}</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>{timecode(end, project.fps)}</dd>
        </div>
        <div>
          <dt>Group</dt>
          <dd>{grouped ? 'Yes' : 'No'}</dd>
        </div>
      </dl>
      <p className="hint">Drag any selected clip on the timeline to move them all together. Grouped clips select, move, trim and delete as one.</p>
      <div className="inspector-actions">
        {grouped ? (
          <button className="button" onClick={() => ungroupSelection(editor)}>
            <EditIcon name="group" />
            Ungroup
          </button>
        ) : (
          <button className="button" onClick={() => groupSelection(editor)}>
            <EditIcon name="group" />
            Group
          </button>
        )}
        <button className="button" onClick={() => copySelection(editor)}>
          <Icon name="copy" />
          Copy
        </button>
        <button className="button" onClick={() => cutSelection(editor)}>
          Cut
        </button>
        <button className="button" onClick={() => duplicateSelection(editor)}>
          Duplicate
        </button>
        <button
          className="button"
          onClick={() => {
            editor.commit(deleteBundle(editor.getProject(), ids));
            editor.setSelection([]);
          }}
        >
          <Icon name="trash" />
          Delete
        </button>
      </div>
    </section>
  );
}
