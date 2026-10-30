import { type ReactElement, useRef, useState } from 'react';
import { addVolumePoint, clearVolumePoints, removeVolumePoint, updateClipAudio } from '../../engine/audioops';
import { DEFAULT_DUCK } from '../../engine/dsp/duck';
import { volumeAt } from '../../engine/gain';
import { findMedia, sourceTimeAt } from '../../engine/project';
import { bakeClipAudio } from '../audioBake';
import { Field } from './Field';
import type { ClipSectionProps } from './types';

const fmtTime = (t: number) => `${t.toFixed(2)} s`;

// Audio area: fades, volume points, levelling, noise removal and ducking for the selected clip.
export function AudioSection({ editor, time, onSeek, clip, locked }: ClipSectionProps): ReactElement | null {
  const media = findMedia(editor.project, clip.mediaId);
  const before = useRef<ReturnType<typeof editor.getProject> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [noise, setNoise] = useState(60);
  const [target, setTarget] = useState(-18);
  const [amount, setAmount] = useState(50);
  const [sample, setSample] = useState<{ start: number; end: number } | null>(null);
  if (!media || media.kind === 'image' || !media.hasAudio) return null;

  const audio = clip.audio ?? {};
  const keys = clip.keys?.volume ?? [];
  const local = time - clip.start;
  const inside = local >= 0 && local <= clip.duration;
  const fadeMax = Math.max(0.1, Math.min(10, clip.duration));
  const duck = audio.duck;

  const begin = () => {
    if (!before.current) before.current = editor.getProject();
  };
  const finish = () => {
    if (before.current) editor.commit(editor.getProject(), before.current);
    before.current = null;
  };
  const setAudio = (patch: Parameters<typeof updateClipAudio>[2]) => {
    begin();
    editor.preview(updateClipAudio(editor.getProject(), clip.id, patch));
  };
  const commitNow = (next: ReturnType<typeof editor.getProject>) => editor.commit(next, editor.getProject());

  const run = async (kind: 'noise' | 'level') => {
    setBusy(true);
    setNote(kind === 'noise' ? 'Removing noise…' : 'Levelling…');
    const profile = kind === 'noise' && sample && sample.end > sample.start
      ? { start: sourceTimeAt(clip, clip.start + sample.start), end: sourceTimeAt(clip, clip.start + sample.end) }
      : undefined;
    const msg = await bakeClipAudio(editor, clip.id, kind, { strength: noise / 100, profile, targetDb: target, amount: amount / 100 });
    setNote(msg);
    setBusy(false);
  };

  return (
    <section className="inspector-section audio-section" aria-labelledby="audio-heading">
      <h3 id="audio-heading">Audio</h3>
      <fieldset className="fields" disabled={locked}>
        <Field label="Fade in" value={audio.fadeIn ?? 0} min={0} max={fadeMax} step={0.05} unit="s" onPreview={(v) => setAudio({ fadeIn: Math.max(0, v) })} onCommit={finish} />
        <Field label="Fade out" value={audio.fadeOut ?? 0} min={0} max={fadeMax} step={0.05} unit="s" onPreview={(v) => setAudio({ fadeOut: Math.max(0, v) })} onCommit={finish} />
        <div className="field wide">
          <label htmlFor="audio-fade-shape">Fade shape</label>
          <select id="audio-fade-shape" value={audio.fadeCurve ?? 'linear'} onChange={(e) => commitNow(updateClipAudio(editor.getProject(), clip.id, { fadeCurve: e.target.value === 'smooth' ? 'smooth' : undefined }))}>
            <option value="linear">Linear</option>
            <option value="smooth">Smooth (S curve)</option>
          </select>
        </div>
      </fieldset>

      <h4 className="audio-sub">Volume points</h4>
      <p className="hint">
        Points change the volume over time and replace the Volume slider. On the timeline, drag a point of the selected clip, Alt-click the line to add one, double-click a point to remove it.
      </p>
      {keys.length > 0 && (
        <ul className="audio-points" aria-label="Volume points">
          {keys.map((k) => (
            <li key={k.t}>
              <button className="button" onClick={() => onSeek(clip.start + k.t)} aria-label={`Go to the volume point at ${fmtTime(k.t)}`}>
                {fmtTime(k.t)}
              </button>
              <span>{Math.round(k.v * 100)}%</span>
              <button className="icon-button" disabled={locked} onClick={() => commitNow(removeVolumePoint(editor.getProject(), clip.id, k.t))} aria-label={`Remove the volume point at ${fmtTime(k.t)}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="inspector-actions">
        <button
          className="button"
          disabled={locked || !inside}
          title={inside ? undefined : 'Move the playhead onto this clip first'}
          onClick={() => commitNow(addVolumePoint(editor.getProject(), clip.id, local, volumeAt(clip, local)))}
        >
          Add point at playhead
        </button>
        <button className="button" disabled={locked || !keys.length} onClick={() => commitNow(clearVolumePoints(editor.getProject(), clip.id))}>
          Clear points
        </button>
      </div>

      <h4 className="audio-sub">Levelling</h4>
      <p className="hint">Evens out loud and quiet parts and brings the clip to a target loudness. Makes a new audio file in the bin and switches the clip to it; undo goes back.</p>
      <fieldset className="fields" disabled={locked || busy}>
        <Field label="Target loudness" value={target} min={-30} max={-10} step={1} unit="dB" onPreview={setTarget} onCommit={() => undefined} />
        <Field label="Compression" value={amount} min={0} max={100} step={1} unit="%" onPreview={setAmount} onCommit={() => undefined} />
      </fieldset>
      <div className="inspector-actions">
        <button className="button" disabled={locked || busy} onClick={() => void run('level')}>
          Level volume
        </button>
      </div>

      <h4 className="audio-sub">Noise removal</h4>
      <p className="hint">
        Learns the noise from the quietest part of the clip (or from a stretch you mark) and removes it. The clip needs a moment of noise with no speech in it.
      </p>
      <fieldset className="fields" disabled={locked || busy}>
        <Field label="Noise removal strength" value={noise} min={0} max={100} step={1} unit="%" onPreview={setNoise} onCommit={() => undefined} />
      </fieldset>
      <div className="inspector-actions">
        <button className="button" disabled={locked || busy || !inside} onClick={() => setSample({ start: local, end: Math.max(local, sample?.end ?? local) })}>
          Noise sample starts here
        </button>
        <button className="button" disabled={locked || busy || !inside || !sample} onClick={() => sample && setSample({ start: sample.start, end: Math.max(sample.start, local) })}>
          Noise sample ends here
        </button>
        <button className="button" disabled={!sample} onClick={() => setSample(null)}>
          Use quietest part
        </button>
      </div>
      <p className="hint">{sample && sample.end > sample.start ? `Noise sample: ${fmtTime(sample.start)} to ${fmtTime(sample.end)} of the clip.` : 'Noise sample: the quietest part of the clip.'}</p>
      <div className="inspector-actions">
        <button className="button" disabled={locked || busy} onClick={() => void run('noise')}>
          Remove noise
        </button>
      </div>

      <h4 className="audio-sub">Ducking</h4>
      <div className="field wide audio-check">
        <label htmlFor="audio-duck">
          <input
            id="audio-duck"
            type="checkbox"
            checked={!!duck}
            disabled={locked}
            onChange={(e) => commitNow(updateClipAudio(editor.getProject(), clip.id, { duck: e.target.checked ? { ...DEFAULT_DUCK } : undefined }))}
          />{' '}
          Duck other tracks while this clip is speaking
        </label>
      </div>
      {duck && (
        <fieldset className="fields" disabled={locked}>
          <Field label="Speaking above" value={duck.thresholdDb} min={-70} max={-10} step={1} unit="dB" onPreview={(v) => setAudio({ duck: { ...duck, thresholdDb: v } })} onCommit={finish} />
          <Field label="Lower others by" value={duck.reductionDb} min={0} max={40} step={1} unit="dB" onPreview={(v) => setAudio({ duck: { ...duck, reductionDb: v } })} onCommit={finish} />
          <Field label="Duck attack" value={Math.round(duck.attack * 1000)} min={5} max={1000} step={5} unit="ms" onPreview={(v) => setAudio({ duck: { ...duck, attack: v / 1000 } })} onCommit={finish} />
          <Field label="Duck release" value={Math.round(duck.release * 1000)} min={50} max={3000} step={10} unit="ms" onPreview={(v) => setAudio({ duck: { ...duck, release: v / 1000 } })} onCommit={finish} />
        </fieldset>
      )}
      <p className="hint">Put the narration on its own track. Audio on the other tracks dips while the narration is louder than the threshold, in the preview and in the export.</p>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
