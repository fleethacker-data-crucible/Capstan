// The Fleet action bridge. Buttons keep their editor behaviour. Host actions (End session,
// host status) go through the local API, which calls the same PowerShell function as the CLI.
// The session token is sent only as a header. It is never copied into markup.
import { useEffect, useSyncExternalStore } from 'react';
import { sessionToken } from './lifecycle';

export interface FleetCall {
  ok: boolean;
  httpStatus: number;
  message: string;
}

type ConfirmState = { message: string; okLabel: string; resolve: (yes: boolean) => void } | null;

interface Chrome {
  status: string;
  alert: string;
  confirm: ConfirmState;
}

let chrome: Chrome = { status: '', alert: '', confirm: null };
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function patch(next: Partial<Chrome>) {
  chrome = { ...chrome, ...next };
  emit();
}

export function fleetStatus(text: string) {
  patch({ status: text, alert: '' });
}

export function fleetAlert(text: string) {
  patch({ alert: text, status: '' });
}

export function fleetConfirm(message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    patch({ confirm: { message, okLabel, resolve } });
  });
}

function closeConfirm(yes: boolean) {
  const current = chrome.confirm;
  if (!current) return;
  patch({ confirm: null });
  current.resolve(yes);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFleetChrome(): Chrome {
  return useSyncExternalStore(subscribe, () => chrome, () => chrome);
}

function readable(body: unknown, status: number): string {
  if (!body || typeof body !== 'object') {
    if (status === 404) return 'That action is not available on this server.';
    return 'Capstan could not run that action.';
  }
  const rec = body as { error?: { code?: unknown; message?: unknown } | string };
  const message = rec.error && typeof rec.error === 'object' && typeof rec.error.message === 'string' ? rec.error.message : '';
  const code = rec.error && typeof rec.error === 'object' ? rec.error.code : '';
  if (code === 'E_CONFIRM') return message || 'This action discards or replaces data. Confirm it to continue.';
  if (message) return message;
  return 'Capstan could not run that action.';
}

/** POST /api/actions/<id>. Same function the CLI calls. The token stays in the header. */
export async function invokeFleetAction(action: string, args: Record<string, unknown>, opts?: { confirmed?: boolean; dryRun?: boolean }): Promise<FleetCall> {
  const token = sessionToken();
  if (!token) {
    return { ok: false, httpStatus: 0, message: 'This page was not opened by Launch-Capstan.bat, so there is no local action API.' };
  }
  let res: Response;
  try {
    res = await fetch('/api/actions/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Capstan-Token': token },
      body: JSON.stringify({ args, confirmed: !!opts?.confirmed, dryRun: !!opts?.dryRun }),
    });
  } catch {
    return { ok: false, httpStatus: 0, message: 'Capstan could not reach the local action API.' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
    return { ok: true, httpStatus: res.status, message: 'Done.' };
  }
  return { ok: false, httpStatus: res.status, message: readable(body, res.status) };
}

/** Mirrors disabled onto aria-disabled for action buttons, without changing what they do. */
function syncActionButtons() {
  for (const el of document.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
    if (el.getAttribute('aria-busy') === 'true') continue;
    el.setAttribute('aria-disabled', el.disabled ? 'true' : 'false');
  }
}

export function FleetActionChrome() {
  const state = useFleetChrome();
  useEffect(() => {
    syncActionButtons();
    const obs = new MutationObserver(() => syncActionButtons());
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    if (!state.confirm) return;
    const node = document.getElementById('fleet-confirm-cancel');
    node?.focus();
  }, [state.confirm]);
  return (
    <>
      <span className="fleet-live fleet-status" role="status" aria-live="polite">
        {state.status}
      </span>
      <span className="fleet-live fleet-alert" role="alert" aria-live="assertive">
        {state.alert}
      </span>
      {state.confirm && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal fl-dialog fleet-confirm" role="dialog" aria-modal="true" aria-labelledby="fleet-confirm-title">
            <header className="modal-head">
              <h2 id="fleet-confirm-title">Confirm</h2>
            </header>
            <p className="modal-text">{state.confirm.message}</p>
            <div className="modal-actions">
              <button id="fleet-confirm-cancel" className="button" type="button" onClick={() => closeConfirm(false)}>
                Cancel
              </button>
              <button className="button primary" type="button" onClick={() => closeConfirm(true)}>
                {state.confirm.okLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
