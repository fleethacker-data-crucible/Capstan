import { useEffect, useState } from 'react';
import { HOTKEY_ACTIONS, type HotkeyAction, KEY_NAMES, MODIFIER_NAMES, defaultBindings, formatBinding, parseBinding } from '../engine/hotkeys-host';
import { applyHotkeyBindings, forgetHotkeyBindings, hotkeysWork, useHotkeyStatus } from './hotkeys';

/** The note on the first use of the browser's picker. Shown in the Record dialog and used by the tests. */
export const PICKER_NOTE =
  'Screen capture still needs the browser’s share picker. The browser opens it only after you click inside Capstan, and it never lets a key press from another program open it. Choose what to share once, here; the hotkeys then start, pause and stop the recording while you work in other windows.';

export const NOT_IN_SHOT_NOTE =
  'Capstan cannot hide its own window from a screen capture. Windows only lets a program hide windows that belong to that program, and Capstan’s window belongs to your browser. To keep Capstan out of the recording, record a browser tab or a single window (the default here) instead of the entire screen.';

interface Draft {
  mods: string[];
  key: string;
}
type Drafts = Record<HotkeyAction, Draft>;

/** Splits a binding the host reported (always valid) into the controls' parts. */
function toDraft(text: string): Draft {
  const p = parseBinding(text);
  return p.ok ? { mods: p.modifiers, key: p.key } : { mods: [], key: 'F9' };
}
function toDrafts(b: Record<HotkeyAction, string>): Drafts {
  return { 'start-stop': toDraft(b['start-stop']), 'pause-resume': toDraft(b['pause-resume']), marker: toDraft(b.marker) };
}
const textOf = (d: Draft) => formatBinding(d.mods, d.key);

/** Summary of what is wrong, in words for the person recording. */
export function describeKey(k: { binding: string; registered: boolean; reason: string }, test: boolean): string {
  if (k.registered) return test ? 'Simulated (test mode)' : 'Active';
  return `Not active: ${k.reason || 'the key could not be registered.'}`;
}

export function HotkeysPanel({ armFirst, onArmFirst }: { armFirst: boolean; onArmFirst(v: boolean): void }) {
  const { status, supported } = useHotkeyStatus();
  const [draft, setDraft] = useState<Drafts>(() => toDrafts(defaultBindings()));
  const [errors, setErrors] = useState<Partial<Record<HotkeyAction, string>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = status ? JSON.stringify(status.bindings) : '';
  useEffect(() => {
    if (status) setDraft(toDrafts(status.bindings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  const works = hotkeysWork(status);
  const usable = !!status && status.available && status.running;
  const keyOf = (a: HotkeyAction) => status?.keys.find((k) => k.action === a);
  const draftText = (a: HotkeyAction) => textOf(draft[a]);
  const dirty = !!status && HOTKEY_ACTIONS.some(({ action }) => draftText(action) !== status.bindings[action]);
  const allowedKeys = status?.allowed.keys.length ? status.allowed.keys : [...KEY_NAMES];

  const edit = (action: HotkeyAction, mods: string[], key: string) => {
    setDraft((d) => ({ ...d, [action]: { mods, key } }));
    setErrors((e) => ({ ...e, [action]: undefined }));
    setMessage('');
  };

  const apply = async (wanted: Partial<Record<HotkeyAction, string>>) => {
    setBusy(true);
    setErrors({});
    const out = await applyHotkeyBindings(wanted);
    setBusy(false);
    if (!out.ok) {
      if (out.action) setErrors({ [out.action]: out.error });
      setMessage(out.error);
      return;
    }
    const failed = out.status.failed;
    setMessage(
      failed.length
        ? failed.map((f) => `${f.binding}: ${f.reason}`).join(' ')
        : 'Hotkeys updated.',
    );
  };

  return (
    <fieldset className="options record-group hotkeys-panel">
      <legend>Hotkeys</legend>
      {!supported && <p className="hint">Hotkeys and the tray icon come from Capstan’s Windows host. Start Capstan with Launch-Capstan.bat to use them.</p>}
      {supported && !status && <p className="hint">Asking the host about hotkeys…</p>}
      {supported && status && !status.available && <p className="hint">Hotkeys are not available: {status.reason || 'the host could not start them.'}</p>}
      {supported && status && status.available && !status.running && <p className="hint">{status.reason || 'The tray was closed.'}</p>}
      {usable && status?.test && <p className="hint">Test mode: keys are simulated and there is no tray icon.</p>}

      <p className="hint hotkeys-note">{PICKER_NOTE}</p>
      <label className="check">
        <input type="checkbox" checked={armFirst && works} disabled={!works} onChange={(e) => onArmFirst(e.target.checked)} />
        Choose what to share now, then start with the hotkey
      </label>

      {usable && (
        <div className="hotkey-rows">
          {HOTKEY_ACTIONS.map(({ action, label }) => {
            const { mods, key } = draft[action];
            const k = keyOf(action);
            const err = errors[action];
            const applied = draftText(action) === status?.bindings[action];
            const ok = k?.registered && applied;
            return (
              <div key={action} className="hotkey-row" role="group" aria-label={`${label} hotkey`}>
                <span className="hotkey-name">{label}</span>
                <span className="hotkey-mods">
                  {MODIFIER_NAMES.map((m) => (
                    <label key={m} className="check">
                      <input
                        type="checkbox"
                        checked={mods.includes(m)}
                        onChange={(e) => edit(action, e.target.checked ? [...mods, m] : mods.filter((x) => x !== m), key)}
                      />
                      {m}
                    </label>
                  ))}
                </span>
                <select aria-label={`${label} key`} value={key} onChange={(e) => edit(action, mods, e.target.value)}>
                  {allowedKeys.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span className={`hotkey-state ${err ? 'bad' : ok ? 'good' : k ? 'bad' : ''}`} data-testid={`hotkey-state-${action}`}>
                  {err ? err : k ? (!applied ? 'Not applied yet' : describeKey(k, !!status?.test)) : ''}
                </span>
              </div>
            );
          })}
          <div className="hotkey-actions">
            <button className="button" disabled={busy || !dirty} onClick={() => void apply(Object.fromEntries(HOTKEY_ACTIONS.map(({ action }) => [action, draftText(action)])))}>
              Apply hotkeys
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                forgetHotkeyBindings();
                void apply(defaultBindings());
              }}
            >
              Reset to defaults
            </button>
          </div>
          {message && (
            <p className="hint" role="status" data-testid="hotkey-message">
              {message}
            </p>
          )}
        </div>
      )}

      <details className="hotkeys-help">
        <summary>Keeping Capstan out of the recording</summary>
        <p className="hint">{status?.captureExclusion?.possible === false && status.captureExclusion.reason ? status.captureExclusion.reason : NOT_IN_SHOT_NOTE}</p>
      </details>
    </fieldset>
  );
}

/** One line shown while recording: which keys do what. Empty when the keys are not active. */
export function hotkeyHint(bindings: Record<HotkeyAction, string>): string {
  return `${bindings['start-stop']} stops, ${bindings['pause-resume']} pauses or resumes, ${bindings.marker} adds a marker.`;
}
