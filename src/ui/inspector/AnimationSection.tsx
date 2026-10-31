import type { ReactElement } from 'react';
import { AUTO_KEY_PROPS, addClipKey, keyAt, keyedProps, removeClipKey, setClipBehavior, setClipTransition, setKeyEase, clearClipKeys } from '../../engine/animate';
import { type AnimProp, EASE_NAMES, type EaseName } from '../../engine/anim';
import { BEHAVIOR_LABELS, EMPHASIS_TYPES, ENTER_TYPES, EXIT_TYPES } from '../../engine/behaviors';
import { findMedia } from '../../engine/project';
import { TRANSITION_LABELS, TRANSITION_TYPES } from '../../engine/transitions';
import { timecode } from '../format';
import { SecondsInput } from './SecondsInput';
import type { ClipSectionProps } from './types';

const PROP_LABEL: Record<string, string> = { x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity' };
const EASE_LABEL: Record<EaseName, string> = { linear: 'Linear', in: 'Ease in', out: 'Ease out', inOut: 'Ease in and out', hold: 'Hold', back: 'Overshoot', bounce: 'Bounce' };

function showValue(prop: AnimProp, v: number): string {
  if (prop === 'scale' || prop === 'opacity') return `${Math.round(v * 100)}%`;
  if (prop === 'rotation') return `${Math.round(v)}°`;
  return `${Math.round(v)} px`;
}

function Diamond({ on }: { on: boolean }): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

// Animation area: keyframes, transitions and behavior for the selected clip.
export function AnimationSection({ editor, clip, time, onSeek, locked }: ClipSectionProps): ReactElement | null {
  const { project } = editor;
  const media = findMedia(project, clip.mediaId);
  if (media?.kind === 'audio') return null;
  const inside = time >= clip.start - 1e-6 && time <= clip.start + clip.duration + 1e-6;
  const local = Math.min(clip.duration, Math.max(0, time - clip.start));
  const current = keyedProps(clip, time);
  const act = (next: typeof project) => editor.commit(next);

  const transitionRow = (edge: 'in' | 'out') => {
    const value = edge === 'in' ? clip.transitionIn : clip.transitionOut;
    const name = edge === 'in' ? 'Transition in' : 'Transition out';
    return (
      <div className="anim-row" key={edge}>
        <label htmlFor={`anim-tr-${edge}`}>{edge === 'in' ? 'In' : 'Out'}</label>
        <select
          id={`anim-tr-${edge}`}
          aria-label={name}
          value={value?.type ?? ''}
          disabled={locked}
          onChange={(e) => act(setClipTransition(project, clip.id, edge, e.target.value ? { type: e.target.value, duration: value?.duration ?? 0.5 } : undefined))}
        >
          <option value="">None</option>
          {TRANSITION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRANSITION_LABELS[t]}
            </option>
          ))}
        </select>
        {value && <SecondsInput label={`${name} length`} value={value.duration} disabled={locked} onChange={(v) => act(setClipTransition(project, clip.id, edge, { ...value, duration: v }))} />}
      </div>
    );
  };

  const behaviorRow = (stage: 'enter' | 'emphasis' | 'exit', title: string, types: readonly string[]) => {
    const value = clip.behavior?.[stage];
    return (
      <div className="anim-row" key={stage}>
        <label htmlFor={`anim-bh-${stage}`}>{title}</label>
        <select
          id={`anim-bh-${stage}`}
          aria-label={`Behavior ${title.toLowerCase()}`}
          value={value?.type ?? ''}
          disabled={locked}
          onChange={(e) => act(setClipBehavior(project, clip.id, stage, e.target.value ? { type: e.target.value, duration: value?.duration ?? (stage === 'emphasis' ? 1 : 0.5) } : undefined))}
        >
          <option value="">None</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {BEHAVIOR_LABELS[t]}
            </option>
          ))}
        </select>
        {value && <SecondsInput label={`${title} behavior length`} value={value.duration} disabled={locked} onChange={(v) => act(setClipBehavior(project, clip.id, stage, { ...value, duration: v }))} />}
      </div>
    );
  };

  const keyed = AUTO_KEY_PROPS.filter((p) => clip.keys?.[p]?.length);

  return (
    <section className="inspector-section animation-section" aria-labelledby="anim-heading">
      <h3 id="anim-heading">Animation</h3>
      <p className="hint">Press a diamond to set a key at the playhead. Once a property has keys, changing it at another time adds a key there.</p>
      <ul className="key-props" aria-label="Keyframes">
        {AUTO_KEY_PROPS.map((prop) => {
          const label = PROP_LABEL[prop];
          const here = keyAt(clip, prop, local);
          const count = clip.keys?.[prop]?.length ?? 0;
          return (
            <li key={prop} className="key-prop">
              <span className="key-label">{label}</span>
              <span className="key-value">{showValue(prop, current[prop])}</span>
              <button
                className={`icon-button small key-diamond${here ? ' on' : ''}`}
                aria-pressed={!!here}
                aria-label={here ? `Remove ${label} key at playhead` : `Add ${label} key at playhead`}
                title={!inside ? 'Move the playhead onto the clip first' : here ? `Remove the ${label} key here` : `Set a ${label} key at the playhead`}
                disabled={locked || !inside}
                onClick={() => act(here ? removeClipKey(project, clip.id, prop, local) : addClipKey(project, clip.id, prop, time))}
              >
                <Diamond on={!!here} />
              </button>
              <span className="key-count" aria-hidden>
                {count ? `${count} key${count === 1 ? '' : 's'}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {keyed.length > 0 && (
        <div className="key-lists">
          {keyed.map((prop) => (
            <div key={prop} className="key-list" role="group" aria-label={`${PROP_LABEL[prop]} keys`}>
              {clip.keys![prop]!.map((k) => {
                const when = timecode(k.t, project.fps);
                return (
                  <div className="key-item" key={k.t}>
                    <button className="key-jump" title="Go to this key" aria-label={`Go to ${PROP_LABEL[prop]} key at ${when}`} onClick={() => onSeek(clip.start + k.t)}>
                      <Diamond on />
                      <span>{when}</span>
                    </button>
                    <span className="key-value">{showValue(prop, k.v)}</span>
                    <select
                      aria-label={`Easing for ${PROP_LABEL[prop]} key at ${when}`}
                      value={k.ease}
                      disabled={locked}
                      onChange={(e) => act(setKeyEase(project, clip.id, prop, k.t, e.target.value as EaseName))}
                    >
                      {EASE_NAMES.map((n) => (
                        <option key={n} value={n}>
                          {EASE_LABEL[n]}
                        </option>
                      ))}
                    </select>
                    <button className="icon-button small" disabled={locked} title="Delete this key" aria-label={`Delete ${PROP_LABEL[prop]} key at ${when}`} onClick={() => act(removeClipKey(project, clip.id, prop, k.t))}>
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          <button className="button" disabled={locked} onClick={() => act(clearClipKeys(project, clip.id))}>
            Clear all keys
          </button>
        </div>
      )}
      <h4 className="anim-sub">Transitions</h4>
      <div className="anim-rows">{(['in', 'out'] as const).map(transitionRow)}</div>
      <h4 className="anim-sub">Behaviors</h4>
      <div className="anim-rows">
        {behaviorRow('enter', 'Enter', ENTER_TYPES)}
        {behaviorRow('emphasis', 'Emphasis', EMPHASIS_TYPES)}
        {behaviorRow('exit', 'Exit', EXIT_TYPES)}
      </div>
    </section>
  );
}
