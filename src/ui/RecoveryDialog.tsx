// Offers footage left on disk by a recording that never finished (a crash, a closed window, a
// failed import): import it into the project or throw it away. Checked once, when Capstan starts.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { importRecoveredSession, placeAtEnd, primaryClip } from '../engine/recording-flow';
import { ROLE_LABEL, type RecoverableSession, type RecordingStore, openRecordingStore } from '../engine/recording-store';
import { Icon } from './icons';
import { useModal } from './shell';
import type { Editor } from './useEditor';

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** The dialog frame: mounted only while there is something to offer, so focus lands on it. */
function Frame({ onLater, children }: { onLater(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, onLater);
  return (
    <div className="modal-backdrop" role="presentation">
      <div ref={ref} tabIndex={-1} className="modal fl-dialog record-modal" role="dialog" aria-modal="true" aria-labelledby="recover-title">
        {children}
      </div>
    </div>
  );
}

export function RecoveryDialog({ editor }: { editor: Editor }) {
  const [sessions, setSessions] = useState<RecoverableSession[]>([]);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const store = useRef<RecordingStore | null>(null);

  useEffect(() => {
    let stale = false;
    void openRecordingStore().then(async (s) => {
      if (!s || stale) return;
      store.current = s;
      // Imported sessions and empty ones are cleaned up here; the rest are offered.
      const left = await s.sweep().catch(() => []);
      if (!stale) setSessions(left);
    });
    return () => {
      stale = true;
    };
  }, []);

  if (!open || !sessions.length) return null;

  const remove = (session: string) => setSessions((list) => list.filter((s) => s.session !== session));

  const importSession = async (s: RecoverableSession) => {
    const st = store.current;
    if (!st) return;
    setBusy(s.session);
    setError('');
    try {
      const parts = await importRecoveredSession(st, s, (f, hints) => editor.importRecording(f, hints));
      const placed = placeAtEnd(editor.getProject(), parts, s.manifest.place);
      if (placed) {
        editor.commit(placed.project);
        editor.setSelection([primaryClip(placed)!]);
      }
      // The project still reads these files, so they are removed at the next start, not now.
      await st.markImported(s.session);
      remove(s.session);
      editor.setStatus(`Recovered ${s.manifest.name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const discard = async (s: RecoverableSession) => {
    setBusy(s.session);
    try {
      await store.current?.discard(s.session);
      remove(s.session);
    } finally {
      setBusy('');
    }
  };

  return (
    <Frame onLater={() => setOpen(false)}>
        <header className="modal-head">
          <h2 id="recover-title">Recover recordings</h2>
          <button className="icon-button" onClick={() => setOpen(false)} title="Decide later (Esc)" aria-label="Decide later">
            <Icon name="close" />
          </button>
        </header>
        <div className="record-body">
          <p className="modal-text">
            {sessions.length === 1 ? 'A recording was' : `${sessions.length} recordings were`} left on this computer when Capstan last closed. Import {sessions.length === 1 ? 'it' : 'them'} into
            the project, or discard {sessions.length === 1 ? 'it' : 'them'}.
          </p>
          <ul className="recover-list">
            {sessions.map((s) => (
              <li key={s.session} className="recover-item" data-session={s.session}>
                <div className="recover-info">
                  <strong>{s.manifest.name}</strong>
                  <span className="hint">
                    {s.manifest.complete ? 'Finished, not yet in a project' : 'Interrupted'} · {mb(s.totalBytes)} · {s.parts.map((p) => ROLE_LABEL[p.role].toLowerCase()).join(', ')}
                  </span>
                </div>
                <div className="recover-actions">
                  <button className="button" disabled={!!busy} onClick={() => void discard(s)} aria-label={`Discard ${s.manifest.name}`}>
                    Discard
                  </button>
                  <button className="button primary" disabled={!!busy} onClick={() => void importSession(s)} aria-label={`Import ${s.manifest.name}`}>
                    {busy === s.session ? 'Importing…' : 'Import'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="button" data-autofocus onClick={() => setOpen(false)}>
            Decide later
          </button>
        </div>
    </Frame>
  );
}
