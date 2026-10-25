import { useEffect, useRef, useState } from 'react';
import { addClip } from '../engine/ops';
import { projectDuration } from '../engine/project';
import { ScreenRecorder } from '../engine/recorder';
import { timecode } from './format';
import { Icon } from './icons';
import type { Editor } from './useEditor';

export function RecordDialog({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [microphone, setMicrophone] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [addToTimeline, setAddToTimeline] = useState(true);
  const [state, setState] = useState<'setup' | 'recording' | 'paused' | 'saving'>('setup');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<ScreenRecorder | null>(null);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setElapsed(recorder.current?.elapsed ?? 0), 200);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => () => recorder.current?.cancel(), []);

  const finish = async () => {
    const r = recorder.current;
    if (!r) return;
    setState('saving');
    try {
      const rec = await r.stop();
      recorder.current = null;
      const file = new File([rec.blob], rec.name, { type: rec.blob.type });
      const [media] = await editor.importFiles([file]);
      if (media && addToTimeline) {
        const current = editor.getProject();
        const placed = addClip(current, media.id, projectDuration(current));
        if (placed.clipId) {
          editor.commit(placed.project);
          editor.setSelection([placed.clipId]);
        }
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setState('setup');
    }
  };

  const start = async () => {
    setError('');
    const r = new ScreenRecorder();
    r.onEnded = () => void finish();
    try {
      await r.start({ microphone, systemAudio, frameRate: editor.project.fps >= 50 ? 60 : 30 });
      recorder.current = r;
      setElapsed(0);
      setState('recording');
    } catch (e) {
      const err = e as Error;
      setError(err.name === 'NotAllowedError' ? 'Screen sharing was cancelled or blocked.' : err.message);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="record-title">
        <header className="modal-head">
          <h2 id="record-title">Record screen</h2>
          {state === 'setup' && (
            <button className="icon-button" onClick={onClose} title="Close">
              <Icon name="close" size={16} />
            </button>
          )}
        </header>
        {state === 'setup' ? (
          <>
            <p className="modal-text">
              Your browser will ask which screen, window or tab to record. The recording stays on this computer.
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
              <button className="button" onClick={onClose}>
                Cancel
              </button>
              <button className="button primary" onClick={() => void start()}>
                <Icon name="record" size={16} />
                Start recording
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
