// The page owns the local host (TechStack.md, "Lifecycle rules"): it sends a heartbeat every 5 s
// and a leaving beacon on pagehide; the host stops itself once no Capstan page is alive. Export
// and recording run in this page, so while they run the heartbeat says "busy" and the host waits
// longer before giving up on a late beat.

const HEADER = 'X-Capstan-Token';
let busyCount = 0;

/** What the status bar says about the local host: the last heartbeat's answer. */
export type EngineState = 'connecting' | 'running' | 'disconnected' | 'stopped' | 'standalone';
let engine: EngineState = 'connecting';
const engineListeners = new Set<(s: EngineState) => void>();

function setEngine(s: EngineState) {
  if (s === engine) return;
  engine = s;
  for (const fn of engineListeners) fn(s);
}

/** Subscribes to engine state changes; calls back at once with the current state. Returns the unsubscribe function. */
export function onEngineState(fn: (s: EngineState) => void): () => void {
  engineListeners.add(fn);
  fn(engine);
  return () => engineListeners.delete(fn);
}

/** The per-launch token the host writes into index.html. Empty when the page was not served by the host. */
export function sessionToken(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="capstan-session"]');
  const t = meta?.content ?? '';
  return t && !t.startsWith('__') ? t : '';
}

/** Marks in-page work (export, recording) that must not be cut off. Returns the release function. */
export function markBusy(): () => void {
  busyCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busyCount = Math.max(0, busyCount - 1);
  };
}

export function isBusy(): boolean {
  return busyCount > 0;
}

function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

/** Starts the heartbeat; returns a function that stops it. */
export function startHeartbeat(intervalMs = 5000): () => void {
  const token = sessionToken();
  if (!token) {
    // Opened as files or from the test server: there is no host to report on.
    setEngine('standalone');
    return () => {};
  }
  // One id per page load: a reload is a new page that beats at once, so the old one's leaving
  // signal never stops the host; several windows each count until they close.
  const tab = newTabId();
  const send = () => {
    try {
      void fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HEADER]: token },
        body: JSON.stringify({ tab, hidden: document.visibilityState === 'hidden', busy: isBusy() }),
        keepalive: true,
      })
        .then((res) => {
          if (engine !== 'stopped') setEngine(res.ok ? 'running' : 'disconnected');
        })
        .catch(() => {
          if (engine !== 'stopped') setEngine('disconnected');
        });
    } catch {
      /* the host is gone; nothing to do */
    }
  };
  const onHide = (e: PageTransitionEvent) => {
    // Kept in the back/forward cache: not gone, it beats again on pageshow if restored.
    if (e.persisted) return;
    // sendBeacon is what browsers deliver during unload; it cannot set headers, so the token goes
    // in the body, which the host accepts on this one route only.
    const body = JSON.stringify({ tab, leaving: true, session: token });
    let sent = false;
    try {
      sent = !!navigator.sendBeacon?.('/api/heartbeat', new Blob([body], { type: 'application/json' }));
    } catch {
      sent = false;
    }
    if (!sent) {
      try {
        void fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', [HEADER]: token }, body, keepalive: true }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  };
  const onShow = () => send();
  const onVisible = () => send();
  send();
  const timer = window.setInterval(send, intervalMs);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** Asks the host to stop ("End session"). */
export async function endSession(): Promise<void> {
  const token = sessionToken();
  if (!token) throw new Error('This page was not opened by Launch-Capstan.bat, so there is no session to end.');
  const res = await fetch('/api/session/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', [HEADER]: token }, body: '{}' });
  if (!res.ok) throw new Error(`Capstan did not stop (HTTP ${res.status}).`);
  setEngine('stopped');
}
