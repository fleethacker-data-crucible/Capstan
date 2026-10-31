import { type ReactElement, useState } from 'react';
import { updateClipAudio } from '../../engine/audioops';
import { DEFAULT_DUCK } from '../../engine/dsp/duck';
import { findMedia } from '../../engine/project';
import { bakeClipAudio } from '../audioBake';
import type { ToolboxProps } from '../toolboxTabs';

// Audio area: shortcuts that apply audio processing to the selected clip. The sliders for each live in the
// Inspector's Audio section.
export const enabled = true;
export const tab = { id: 'audio', label: 'Audio' };

export function AudioPanel({ editor }: ToolboxProps): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const { project, selection } = editor;
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined;
  const media = clip && findMedia(project, clip.mediaId);
  const usable = !!clip && !!media && media.kind !== 'image' && media.hasAudio;
  const locked = !!clip && !!project.tracks.find((t) => t.id === clip.trackId)?.locked;
  const off = !usable || locked;

  const run = async (kind: 'noise' | 'level') => {
    if (!clip) return;
    setBusy(true);
    setNote(kind === 'noise' ? 'Removing noise…' : 'Levelling…');
    setNote(await bakeClipAudio(editor, clip.id, kind, { strength: 0.6, targetDb: -18, amount: 0.5 }));
    setBusy(false);
  };
  const edit = (patch: Parameters<typeof updateClipAudio>[2], msg: string) => {
    if (!clip) return;
    editor.commit(updateClipAudio(editor.getProject(), clip.id, patch));
    setNote(msg);
  };

  return (
    <section className="panel audio-panel" aria-label="Audio tools">
      <header className="panel-head">
        <h2>Audio</h2>
      </header>
      <p className="hint">
        Select a clip on the timeline, then fade it, level it, remove noise, or duck other tracks under it. The Inspector has the settings.
      </p>
      {!usable && <p className="hint">Select a clip that has sound to use these.</p>}
      <div className="audio-shortcuts">
        <button className="button" disabled={off} onClick={() => edit({ fadeIn: Math.min(0.5, (clip?.duration ?? 1) / 2) }, 'Fade in 0.5 s.')}>
          Fade in 0.5 s
        </button>
        <button className="button" disabled={off} onClick={() => edit({ fadeOut: Math.min(0.5, (clip?.duration ?? 1) / 2) }, 'Fade out 0.5 s.')}>
          Fade out 0.5 s
        </button>
        <button className="button" disabled={off || busy} onClick={() => void run('level')}>
          Level volume
        </button>
        <button className="button" disabled={off || busy} onClick={() => void run('noise')}>
          Remove noise
        </button>
        <button
          className="button"
          disabled={off}
          aria-pressed={!!clip?.audio?.duck}
          onClick={() => edit({ duck: clip?.audio?.duck ? undefined : { ...DEFAULT_DUCK } }, clip?.audio?.duck ? 'Ducking off.' : 'Other tracks will duck under this clip.')}
        >
          {clip?.audio?.duck ? 'Stop ducking others' : 'Duck others under this clip'}
        </button>
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
