import type { ReactElement } from 'react';
import { ANIM_PROPS } from '../../engine/anim';
import { effectiveTransitionSeconds } from '../../engine/transitions';
import type { ClipDecorProps } from '../ClipDecor';

// Animation area: marks where the clip has keyframes, and the stretch each transition covers.
export function KeyframeMarks({ clip, zoom }: ClipDecorProps): ReactElement | null {
  const times = new Set<number>();
  for (const prop of ANIM_PROPS) {
    // Volume points are drawn by the audio area.
    if (prop === 'volume') continue;
    for (const k of clip.keys?.[prop] ?? []) times.add(Math.round(k.t * 1000) / 1000);
  }
  const inLen = effectiveTransitionSeconds(clip.transitionIn, clip.duration);
  const outLen = effectiveTransitionSeconds(clip.transitionOut, clip.duration);
  if (!times.size && !inLen && !outLen) return null;
  return (
    <>
      {inLen > 0 && <span className="transition-mark in" style={{ width: inLen * zoom }} title={`Transition in: ${clip.transitionIn!.type}`} aria-hidden />}
      {outLen > 0 && <span className="transition-mark out" style={{ width: outLen * zoom }} title={`Transition out: ${clip.transitionOut!.type}`} aria-hidden />}
      {[...times].map((t) => (
        <span key={t} className="key-mark" style={{ left: t * zoom }} aria-hidden />
      ))}
    </>
  );
}
