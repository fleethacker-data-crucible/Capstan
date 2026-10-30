import { useEffect, useRef, useState } from 'react';
import { addClip } from '../engine/ops';
import { projectDuration } from '../engine/project';
import { type CaptureSurface, SURFACE_LABEL, ScreenRecorder } from '../engine/recorder';
import { download, timecode } from './format';
import { Icon } from './icons';
import { markBusy } from './lifecycle';
import { useModal } from './shell';
import type { Editor } from './useEditor';

export function RecordDialog({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [addToTimeline, setAddToTimeline] = useState(true);
  const [surface, setSurface] = useState<CaptureSurface>('window');
  const [state, setState] = useState<'setup' | 'recording' | 'paused' | 'saving'>('setup');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [unsaved, setUnsaved] = useState<File | null>(null);
  const [starting, setStarting] = useState(false);
  const recorder = useRef<ScreenRecorder | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Esc closes only while the close button is shown: never mid-recording.
  useModal(dialogRef, state === 'setup' ? onClose : undefined);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setElapsed(recorder.current?.elapsed ?? 0), 200);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => () => recorder.current?.cancel(), []);

  // Recording and saving run in this page; tell the host so it never gives up on this window meanwhile.
  const active = state !== 'setup';
  useEffect(() => (active ? markBusy() : undefined), [active]);

  const finish = async () => {
    const r = recorder.current;
    if (!r) return;
    setState('saving');
    let file: File | null = null;
    try {
      const rec = await r.stop();
      recorder.current = null;
      file = new File([rec.blob], rec.name, { type: rec.blob.type });
      const media = await editor.importRecording(file, { duration: rec.seconds, width: rec.width, height: rec.height });
      if (addToTimeline) {
        const current = editor.getProject();
        const placed = addClip(current, media.id, projectDuration(current));
        if (placed.clipId) {
          editor.commit(placed.project);
          editor.setSelection([placed.clipId]);
        }
      }
      onClose();
    } catch (e) {
      // Keep the footage: the file can still be saved even if it could not join the project.
      if (file) setUnsaved(file);
      setError(`${(e as Error).message}${file ? ' Save the recording file so it is not lost.' : ''}`);
      setState('setup');
    }
  };

  const start = async () => {
    setError('');
    setUnsaved(null);
    setStarting(true);
    const r = new ScreenRecorder();
    r.onEnded = () => void finish();
    try {
      const { width, height, fps } = editor.project;
      await r.start({ microphone, systemAudio, frameRate: fps >= 50 ? 60 : 30, surface, maxWidth: width, maxHeight: height });
      recorder.current = r;
      setElapsed(0);
      setState('recording');
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'NotAllowedError' ? 'Screen sharing was cancelled or blocked.' : err.message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className="modal fl-dialog" role="dialog" aria-modal="true" aria-labelledby="record-title">
        <header className="modal-head">
          <h2 id="record-title">Record screen</h2>
          {state === 'setup' && (
            <button className="icon-button" onClick={onClose} title="Close (Esc)">
              <Icon name="close" />
            </button>
          )}
        </header>
        {state === 'setup' ? (
          <>
            <fieldset className="options surface-choice">
              <legend>What to record</legend>
              {(['browser', 'window', 'monitor'] as CaptureSurface[]).map((s) => (
                <label key={s} className="check">
                  <input type="radio" name="surface" value={s} checked={surface === s} onChange={() => setSurface(s)} />
                  {s === 'browser' ? 'A browser tab' : s === 'window' ? 'A window' : 'The entire screen'}
                </label>
              ))}
            </fieldset>
            <p className="modal-text">
              {surface === 'monitor'
                ? 'Your browser will ask which screen to record. Everything on it is captured.'
                : `Your browser will ask which ${SURFACE_LABEL[surface]} to record. Screens are not offered, and anything else is refused.`}{' '}
              Larger sources are scaled to the {editor.project.width}×{editor.project.height} canvas. The recording stays on this computer.
            </p>
            <label className="check">
              <input type="checkbox" checked={microphone} onChange={(e) => setMicrophone(e.target.checked)} />
              Record my microphone
            </label>
            <label className="check">
              <input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} />
              Record computer sound (choose “Share audio” in the browser prompt)
            </label>
            <label className="check">
              <input type="checkbox" checked={addToTimeline} onChange={(e) => setAddToTimeline(e.target.checked)} />
              Add the recording to the end of the timeline
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="modal-actions">
              {unsaved && (
                <button className="button" onClick={() => download(unsaved, unsaved.name)}>
                  Save recording file
                </button>
              )}
              <button className="button" onClick={onClose}>
                Cancel
              </button>
              <button className="button primary" disabled={starting} onClick={() => void start()}>
                <Icon name="record" size={16} />
                {starting ? 'Starting…' : 'Start recording'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={`rec-status ${state}`}>
              <span className="rec-dot" aria-hidden />
              <span className="rec-time">{timecode(elapsed)}</span>
              <span>{state === 'paused' ? 'Paused' : state === 'saving' ? 'Saving…' : 'Recording'}</span>
            </div>
            <p className="modal-text">Switch to what you want to record. Come back here, or use the browser’s “Stop sharing” bar, to finish.</p>
            <div className="modal-actions">
              {state === 'recording' && (
                <button
                  className="button"
                  onClick={() => {
                    recorder.current?.pause();
                    setState('paused');
                  }}
                >
                  Pause
                </button>
              )}
              {state === 'paused' && (
                <button
                  className="button"
                  onClick={() => {
                    recorder.current?.resume();
                    setState('recording');
                  }}
                >
                  Resume
                </button>
              )}
              <button className="button primary" disabled={state === 'saving'} onClick={() => void finish()}>
                Stop and save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
