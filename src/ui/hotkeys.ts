// The page's link to the host's global hotkeys and tray (see engine/hotkeys-host.ts and modules/Hotkeys.ps1).
// One client per page. Components register a handler for the events; the newest handler is asked first, and
// returning true means "handled". The Record dialog is the newest while it is open; the App is the fallback.
import { useEffect, useState } from 'react';
import {
  type ConfigOutcome,
  HOTKEY_STORAGE_KEY,
  HotkeyClient,
  type HotkeyAction,
  type HotkeyEvent,
  type HotkeyStatus,
  type TrayState,
  parseStoredBindings,
} from '../engine/hotkeys-host';
import { isBusy, sessionToken } from './lifecycle';

export type HotkeyHandler = (event: HotkeyEvent) => boolean | void;

const handlers: HotkeyHandler[] = [];
const listeners = new Set<(s: HotkeyStatus | null) => void>();
let client: HotkeyClient | null = null;
let users = 0;
let restored = false;
let removeVisibility: (() => void) | null = null;

/** True when this page was opened by the Windows host (it carries the session token). */
export function hotkeysSupported(): boolean {
  return sessionToken() !== '';
}

export function hotkeyStatus(): HotkeyStatus | null {
  return client?.status ?? null;
}

function dispatch(event: HotkeyEvent) {
  for (let i = handlers.length - 1; i >= 0; i--) {
    try {
      if (handlers[i](event) === true) return;
    } catch {
      /* a failing handler never blocks the others */
    }
  }
}

function remembered(): Record<HotkeyAction, string> | null {
  try {
    return parseStoredBindings(window.localStorage.getItem(HOTKEY_STORAGE_KEY));
  } catch {
    return null;
  }
}

function onStatus(s: HotkeyStatus | null) {
  // The host starts with the default keys; the user's choice is remembered here and sent once per page load.
  if (!restored && s?.available && s.running && client) {
    restored = true;
    const saved = remembered();
    if (saved && (Object.keys(saved) as HotkeyAction[]).some((a) => saved[a] !== s.bindings[a])) void client.configure(saved);
  }
  for (const fn of listeners) fn(s);
}

/** Starts polling the host. Returns the function that stops it. Counted, so React's double mount is harmless. */
export function startHotkeys(): () => void {
  const token = sessionToken();
  if (!token) return () => {};
  users++;
  if (!client) {
    client = new HotkeyClient({
      token,
      onEvent: dispatch,
      onStatus,
      isVisible: () => document.visibilityState === 'visible',
      // A recording (or one waiting for its hotkey) must stay controllable with Capstan hidden or minimised.
      keepAlive: () => isBusy(),
    });
    const wake = () => client?.wake();
    document.addEventListener('visibilitychange', wake);
    removeVisibility = () => document.removeEventListener('visibilitychange', wake);
    restored = false;
    client.start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users = Math.max(0, users - 1);
    if (users === 0 && client) {
      client.stop();
      client = null;
      removeVisibility?.();
      removeVisibility = null;
    }
  };
}

/** Registers a handler; the newest one is asked first. Returns the function that removes it. */
export function onHotkey(handler: HotkeyHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Tells the host what the recorder is doing (the tray icon and menu follow it). */
export function setTrayState(state: TrayState): void {
  client?.setState(state);
}

/** Wakes the poll loop, e.g. when the recorder became active. */
export function wakeHotkeys(): void {
  client?.wake();
}

/** Applies and remembers new bindings. */
export async function applyHotkeyBindings(wanted: Partial<Record<HotkeyAction, string>>): Promise<ConfigOutcome> {
  if (!client) return { ok: false, error: 'Hotkeys need Capstan’s Windows host. Start Capstan with Launch-Capstan.bat.' };
  const out = await client.configure(wanted);
  if (out.ok) {
    try {
      window.localStorage.setItem(HOTKEY_STORAGE_KEY, JSON.stringify(out.status.bindings));
    } catch {
      /* not remembered */
    }
  }
  return out;
}

export async function refreshHotkeyStatus(): Promise<void> {
  await client?.refresh();
}

export function forgetHotkeyBindings(): void {
  try {
    window.localStorage.removeItem(HOTKEY_STORAGE_KEY);
  } catch {
    /* nothing to forget */
  }
}

/** The host's hotkey status, kept current. `supported` is false when Capstan was not opened by the host. */
export function useHotkeyStatus(): { status: HotkeyStatus | null; supported: boolean } {
  const [status, setStatus] = useState<HotkeyStatus | null>(() => hotkeyStatus());
  useEffect(() => {
    listeners.add(setStatus);
    setStatus(hotkeyStatus());
    // Always ask again when a dialog opens, so a key another program took meanwhile shows up.
    void refreshHotkeyStatus();
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  return { status, supported: hotkeysSupported() };
}

/** True when the start/stop key is registered, so a recording can be controlled from another program. */
export function hotkeysWork(status: HotkeyStatus | null): boolean {
  return !!status && status.available && status.running && status.registered.includes('start-stop');
}
