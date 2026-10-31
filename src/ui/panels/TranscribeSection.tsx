import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { setCaptions } from '../../engine/ops';
import { findMedia, projectDuration } from '../../engine/project';
import { exportSpan } from '../../engine/range';
import { segmentsToCaptions } from '../../engine/transcribe';
import { markBusy } from '../lifecycle';
import { type SpeechStatus, isAbort, speechStatus } from '../speechClient';
import { transcribeSpan } from '../transcribeRun';
import type { Editor } from '../useEditor';

type Load = { kind: 'checking' } | { kind: 'ready'; status: SpeechStatus } | { kind: 'standalone' } | { kind: 'error'; message: string };

/** How to add a Windows speech language pack: shown when no recogniser is installed. */
export const NO_RECOGNISER_HELP =
  'No Windows speech recogniser is installed. Add a language in Settings > Time & language > Language & region, tick its Speech recognition feature, wait for the download, then restart Capstan.';

const preferredCulture = (cultures: string[]): string => {
  const mine = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').toLowerCase();
  return cultures.find((c) => c.toLowerCase() === mine) ?? cultures.find((c) => c.split('-')[0].toLowerCase() === mine.split('-')[0]) ?? cultures[0] ?? '';
};

// Speech-to-text for the Captions tab: the Windows recogniser through the local host, offline.
export function TranscribeSection({ editor }: { editor: Editor }): ReactElement {
  const { project, selection } = editor;
  const [load, setLoad] = useState<Load>({ kind: 'checking' });
  const [culture, setCulture] = useState('');
  const [scope, setScope] = useState<'clip' | 'range'>('range');
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ fraction: 0, detail: '' });
  const [note, setNote] = useState('');
  const abort = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    setLoad({ kind: 'checking' });
    try {
      const status = await speechStatus();
      setLoad({ kind: 'ready', status });
      setCulture((c) => (c && status.cultures.includes(c) ? c : preferredCulture(status.cultures)));
    } catch (e) {
      const err = e as Error & { code?: string };
      setLoad(err.code === 'standalone' ? { kind: 'standalone' } : { kind: 'error', message: err.message });
    }
  }, []);

  useEffect(() => {
    void check();
    return () => abort.current?.abort();
  }, [check]);

  const clip = project.clips.find((c) => selection.includes(c.id) && findMedia(project, c.mediaId)?.hasAudio);
  const duration = projectDuration(project);
  const effectiveScope = scope === 'clip' && clip ? 'clip' : 'range';
  const rangeLabel = project.range ? 'The in to out range' : 'The whole timeline';
  const installed = load.kind === 'ready' ? load.status.cultures : [];
  const missing = load.kind === 'ready' && installed.length === 0;
  const canRun = load.kind === 'ready' && !missing && !running && !!culture && duration > 0;

  const run = async () => {
    const before = editor.getProject();
    const span = effectiveScope === 'clip' && clip ? { start: clip.start, end: clip.start + clip.duration } : exportSpan(projectDuration(before), before.range);
    if (!span) {
      setNote('There is nothing on the timeline to transcribe.');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    const release = markBusy();
    setRunning(true);
    setNote('');
    setProgress({ fraction: 0, detail: 'Starting' });
    try {
      const result = await transcribeSpan({
        project: before,
        blobs: editor.sources.blob,
        span,
        clipId: effectiveScope === 'clip' ? clip?.id : undefined,
        culture,
        onProgress: (fraction, detail) => setProgress({ fraction, detail }),
        signal: controller.signal,
      });
      const captions = segmentsToCaptions(result.segments, span.start);
      if (!captions.length) {
        setNote('No speech was recognised in that part of the timeline. Captions were not changed.');
        return;
      }
      const now = editor.getProject();
      const kept = mode === 'replace' ? now.captions.filter((c) => !(c.end > span.start && c.start < span.end)) : now.captions;
      const removed = now.captions.length - kept.length;
      // One edit: Undo takes the new captions away (and brings back any that were replaced).
      editor.commit(setCaptions(now, [...kept, ...captions]));
      setNote(`Added ${captions.length} caption${captions.length === 1 ? '' : 's'}${removed ? `, replacing ${removed}` : ''}. Check the text: the recogniser is not always right. Undo takes them away.`);
    } catch (e) {
      setNote(isAbort(e) ? 'Transcription cancelled. Captions were not changed.' : (e as Error).message);
      if ((e as Error & { code?: string }).code === 'no-recogniser') void check();
    } finally {
      release();
      abort.current = null;
      setRunning(false);
    }
  };

  const pct = Math.round(progress.fraction * 100);
  return (
    <section className="transcribe" aria-label="Transcribe speech">
      <h3 className="transcribe-title">Transcribe speech</h3>
      <p className="hint">
        Turns speech into captions with the speech recogniser that comes with Windows. It runs on this PC and nothing leaves it. Quality depends on the speech language pack installed in Windows and on the language spoken; it will not match a cloud service on noisy audio, and
        languages without a Windows speech pack are not covered. Check the text afterwards.
      </p>
      {load.kind === 'checking' && <p className="hint">Checking for a Windows speech recogniser…</p>}
      {load.kind === 'standalone' && (
        <p className="hint transcribe-problem" role="status">
          Speech-to-text needs the Capstan host. Open Capstan with Launch-Capstan.bat.
        </p>
      )}
      {load.kind === 'error' && (
        <p className="hint transcribe-problem" role="status">
          {load.message}
        </p>
      )}
      {load.kind === 'ready' && load.status.engine === 'none' && (
        <p className="hint transcribe-problem" role="status">
          Windows speech recognition is not available on this computer.
        </p>
      )}
      {missing && load.status.engine !== 'none' && (
        <p className="hint transcribe-problem" role="status">
          {NO_RECOGNISER_HELP}
        </p>
      )}
      {load.kind === 'ready' && load.status.engine === 'fake' && <p className="hint">Test recogniser: the captions are made up.</p>}
      {load.kind === 'ready' && !missing && (
        <>
          <div className="field wide">
            <label htmlFor="transcribe-culture">Language</label>
            <select id="transcribe-culture" value={culture} disabled={running} onChange={(e) => setCulture(e.target.value)}>
              {installed.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="transcribe-scope">Transcribe</label>
            <select id="transcribe-scope" value={effectiveScope} disabled={running} onChange={(e) => setScope(e.target.value as 'clip' | 'range')}>
              <option value="range">{rangeLabel}</option>
              {clip && <option value="clip">The selected clip</option>}
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="transcribe-mode">Captions</label>
            <select id="transcribe-mode" value={mode} disabled={running} onChange={(e) => setMode(e.target.value as 'add' | 'replace')}>
              <option value="add">Add to the existing captions</option>
              <option value="replace">Replace the captions in that stretch</option>
            </select>
          </div>
        </>
      )}
      <div className="transcribe-actions">
        <button className="button primary" disabled={!canRun} onClick={() => void run()}>
          Transcribe
        </button>
        {running && (
          <button className="button" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
        {(load.kind === 'error' || missing) && (
          <button className="button" onClick={() => void check()}>
            Check again
          </button>
        )}
      </div>
      {running && (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Transcription progress">
          <div className="progress-bar" style={{ width: `${pct}%` }} />
          <span className="progress-text">{`${progress.detail} ${pct}%`}</span>
        </div>
      )}
      {duration === 0 && load.kind === 'ready' && !missing && <p className="hint">Add sound to the timeline first.</p>}
      {note && (
        <p className="hint transcribe-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
