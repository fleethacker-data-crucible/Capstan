import { type ReactElement, useState } from 'react';
import { setClipBehavior, setClipTransition } from '../../engine/animate';
import { BEHAVIOR_LABELS, EMPHASIS_TYPES, ENTER_TYPES, EXIT_TYPES } from '../../engine/behaviors';
import { findMedia } from '../../engine/project';
import { TRANSITION_LABELS, TRANSITION_TYPES } from '../../engine/transitions';
import { addZoom, MAX_ZOOM, zoomRect } from '../../engine/zoom';
import { timecode } from '../format';
import { Icon } from '../icons';
import { SecondsInput } from '../inspector/SecondsInput';
import type { ToolboxProps } from '../toolboxTabs';

export const enabled = true;
export const tab = { id: 'animation', label: 'Motion' };

type Where = 'in' | 'out' | 'both';

// Animation area: zoom-n-pan, transitions, behaviors.
export function AnimationPanel({ editor, time, onSeek }: ToolboxProps): ReactElement | null {
  const { project, selection } = editor;
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;
  const media = clip && findMedia(project, clip.mediaId);
  const visual = !!clip && media?.kind !== 'audio';
  const locked = !!clip && !!project.tracks.find((t) => t.id === clip.trackId)?.locked;
  const [level, setLevel] = useState(2);
  const [focusX, setFocusX] = useState(50);
  const [focusY, setFocusY] = useState(50);
  const [length, setLength] = useState(3);
  const [where, setWhere] = useState<Where>('both');
  const [seconds, setSeconds] = useState(0.5);

  const applyTransition = (type: string) => {
    if (!clip) return;
    let next = project;
    if (where !== 'out') next = setClipTransition(next, clip.id, 'in', { type, duration: seconds });
    if (where !== 'in') next = setClipTransition(next, clip.id, 'out', { type, duration: seconds });
    editor.commit(next);
  };
  const clearTransition = () => {
    if (!clip) return;
    let next = project;
    if (where !== 'out') next = setClipTransition(next, clip.id, 'in', undefined);
    if (where !== 'in') next = setClipTransition(next, clip.id, 'out', undefined);
    editor.commit(next);
  };
  const applyBehavior = (stage: 'enter' | 'emphasis' | 'exit', type: string | undefined) => {
    if (!clip) return;
    editor.commit(setClipBehavior(project, clip.id, stage, type ? { type, duration: stage === 'emphasis' ? 1 : seconds } : undefined));
  };

  return (
    <section className="panel motion-panel" aria-label="Motion">
      <header className="panel-head">
        <h2>Motion</h2>
      </header>
      <div className="motion-scroll">
        <section className="inspector-section" aria-labelledby="zoompan-heading">
          <h3 id="zoompan-heading">Zoom-n-pan</h3>
          <p className="hint">Magnify part of the picture for a while, then zoom back out. Two regions in a row pan from one to the other.</p>
          <div className="fields">
            <div className="field">
              <label htmlFor="motion-zoom-level">Zoom level</label>
              <input type="range" min={1.2} max={8} step={0.1} value={level} aria-label="Zoom level" onChange={(e) => setLevel(Number(e.target.value))} />
              <div className="number">
                <input id="motion-zoom-level" type="number" min={1.1} max={MAX_ZOOM} step={0.1} value={level} onChange={(e) => Number.isFinite(Number(e.target.value)) && setLevel(Math.min(MAX_ZOOM, Math.max(1.1, Number(e.target.value))))} />
                <span>×</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="motion-focus-x">Focus across</label>
              <input type="range" min={0} max={100} step={1} value={focusX} aria-label="Focus across" onChange={(e) => setFocusX(Number(e.target.value))} />
              <div className="number">
                <input id="motion-focus-x" type="number" min={0} max={100} step={1} value={focusX} onChange={(e) => Number.isFinite(Number(e.target.value)) && setFocusX(Number(e.target.value))} />
                <span>%</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="motion-focus-y">Focus down</label>
              <input type="range" min={0} max={100} step={1} value={focusY} aria-label="Focus down" onChange={(e) => setFocusY(Number(e.target.value))} />
              <div className="number">
                <input id="motion-focus-y" type="number" min={0} max={100} step={1} value={focusY} onChange={(e) => Number.isFinite(Number(e.target.value)) && setFocusY(Number(e.target.value))} />
                <span>%</span>
              </div>
            </div>
            <div className="anim-row">
              <span className="anim-label">Length</span>
              <SecondsInput label="Zoom region length" value={length} min={0.2} max={600} onChange={setLength} />
            </div>
          </div>
          <button
            className="button"
            onClick={() => {
              const rect = zoomRect(project, level, { x: (focusX / 100) * project.width, y: (focusY / 100) * project.height });
              const r = addZoom(project, time, { ...rect, duration: length });
              editor.commit(r.project);
              editor.setSelection([r.id]);
            }}
          >
            <Icon name="zoomIn" />
            Add zoom at playhead
          </button>
          {project.zooms.length > 0 && (
            <ul className="region-list" aria-label="Zoom regions">
              {project.zooms.map((z, i) => (
                <li key={z.id}>
                  <button
                    className="region-item"
                    aria-pressed={selection.includes(z.id)}
                    onClick={() => {
                      editor.setSelection([z.id]);
                      onSeek(z.start);
                    }}
                  >
                    {`Zoom ${i + 1}`}
                    <span>{`${timecode(z.start, project.fps)} – ${timecode(z.start + z.duration, project.fps)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="inspector-section" aria-labelledby="transitions-heading">
          <h3 id="transitions-heading">Transitions</h3>
          <p className="hint">{clip && visual ? 'Applied to the selected clip.' : 'Select a video or image clip to give it a transition.'}</p>
          <div className="fields">
            <div className="anim-row">
              <label htmlFor="motion-where">Apply to</label>
              <select id="motion-where" value={where} onChange={(e) => setWhere(e.target.value as Where)}>
                <option value="both">Start and end</option>
                <option value="in">Start only</option>
                <option value="out">End only</option>
              </select>
            </div>
            <div className="anim-row">
              <span className="anim-label">Length</span>
              <SecondsInput label="Preset length" value={seconds} onChange={setSeconds} />
            </div>
          </div>
          <div className="preset-grid" role="group" aria-label="Transition presets">
            {TRANSITION_TYPES.map((t) => (
              <button key={t} className="button preset" disabled={!clip || !visual || locked} onClick={() => applyTransition(t)}>
                {TRANSITION_LABELS[t]}
              </button>
            ))}
            <button className="button preset" disabled={!clip || !visual || locked} onClick={clearTransition}>
              None
            </button>
          </div>
        </section>

        <section className="inspector-section" aria-labelledby="behaviors-heading">
          <h3 id="behaviors-heading">Behaviors</h3>
          <p className="hint">{clip && visual ? 'Entrance, emphasis and exit presets for the selected clip.' : 'Select a video or image clip to give it a behavior.'}</p>
          {(
            [
              ['enter', 'Entrance', ENTER_TYPES],
              ['emphasis', 'Emphasis', EMPHASIS_TYPES],
              ['exit', 'Exit', EXIT_TYPES],
            ] as const
          ).map(([stage, title, types]) => (
            <div key={stage} className="preset-block">
              <h4 className="anim-sub">{title}</h4>
              <div className="preset-grid" role="group" aria-label={`${title} presets`}>
                {types.map((t) => (
                  <button key={t} className={`button preset${clip?.behavior?.[stage]?.type === t ? ' on' : ''}`} aria-pressed={clip?.behavior?.[stage]?.type === t} disabled={!clip || !visual || locked} onClick={() => applyBehavior(stage, t)}>
                    {BEHAVIOR_LABELS[t]}
                  </button>
                ))}
                <button className="button preset" disabled={!clip || !visual || locked || !clip.behavior?.[stage]} onClick={() => applyBehavior(stage, undefined)}>
                  None
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}
