// Global hotkeys and the tray icon, as seen from the page. The Windows host (modules/Hotkeys.ps1) registers the
// keys and shows the tray icon; this file is the page's side: validate bindings, long-poll the host for the
// fixed event names it queues, and report the recorder's state so the tray follows it. No DOM, no React.
//
// What travels: only the event names 'start-stop', 'pause-resume', 'marker' and 'tray-open' (host to page) and the
// binding names the user chose (page to host). No key press content is ever read or sent.
import { addMarker } from './markers';
import type { Project } from './project';

export type HotkeyAction = 'start-stop' | 'pause-resume' | 'marker';
export type HotkeyEventName = HotkeyAction | 'tray-open';
export type TrayState = 'idle' | 'recording' | 'paused';

export const HOTKEY_ACTIONS: ReadonlyArray<{ action: HotkeyAction; label: string; defaultBinding: string }> = [
  { action: 'start-stop', label: 'Start or stop recording', defaultBinding: 'Ctrl+Shift+F9' },
  { action: 'pause-resume', label: 'Pause or resume', defaultBinding: 'Ctrl+Shift+F10' },
  { action: 'marker', label: 'Add a marker', defaultBinding: 'Ctrl+Shift+F11' },
];
export const HOTKEY_LABEL: Record<HotkeyAction, string> = { 'start-stop': 'Start or stop', 'pause-resume': 'Pause or resume', marker: 'Add marker' };

export function defaultBindings(): Record<HotkeyAction, string> {
  return { 'start-stop': 'Ctrl+Shift+F9', 'pause-resume': 'Ctrl+Shift+F10', marker: 'Ctrl+Shift+F11' };
}

// ---- Binding names: the same allowlist as the host (modules/Hotkeys.ps1), checked against one shared corpus ----
export const MODIFIER_NAMES = ['Ctrl', 'Alt', 'Shift'] as const;
export const KEY_NAMES: readonly string[] = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`).filter((k) => k !== 'F12'), // F12 is reserved by Windows for debuggers
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Pause', 'PrintScreen', 'ScrollLock',
];
const keyByLower = new Map(KEY_NAMES.map((k) => [k.toLowerCase(), k]));

export type ParsedBinding = { ok: true; text: string; modifiers: string[]; key: string } | { ok: false; reason: string };

export function parseBinding(input: unknown): ParsedBinding {
  if (typeof input !== 'string') return { ok: false, reason: 'Choose a key combination.' };
  const t = input.trim();
  if (!t) return { ok: false, reason: 'Choose a key combination.' };
  if (t.length > 40) return { ok: false, reason: 'That key combination is too long.' };
  if (!/^[A-Za-z0-9+ ]+$/.test(t)) return { ok: false, reason: 'Use only modifier and key names, such as Ctrl+Shift+F9.' };
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const raw of t.split('+')) {
    const p = raw.trim();
    if (!p) return { ok: false, reason: 'Each + needs a key or modifier on both sides.' };
    const l = p.toLowerCase();
    const flag = l === 'ctrl' || l === 'control' ? 'ctrl' : l === 'alt' ? 'alt' : l === 'shift' ? 'shift' : '';
    if (flag) {
      if ((flag === 'ctrl' && ctrl) || (flag === 'alt' && alt) || (flag === 'shift' && shift)) return { ok: false, reason: 'A modifier is listed twice.' };
      if (flag === 'ctrl') ctrl = true;
      else if (flag === 'alt') alt = true;
      else shift = true;
      continue;
    }
    const k = keyByLower.get(l);
    if (!k) return { ok: false, reason: `'${p}' is not a key Capstan can use.` };
    if (key) return { ok: false, reason: 'Use one key plus modifiers.' };
    key = k;
  }
  if (!key) return { ok: false, reason: 'Add a key after the modifiers.' };
  if (!ctrl && !alt) return { ok: false, reason: 'Include Ctrl or Alt, so the key still works when you type in other programs.' };
  if (ctrl && alt && key === 'Delete') return { ok: false, reason: 'Windows keeps Ctrl+Alt+Delete for itself.' };
  const modifiers = [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift'].filter((m): m is string => !!m);
  return { ok: true, text: [...modifiers, key].join('+'), modifiers, key };
}

/** Builds the text for a modifier set and a key (the Hotkeys panel's controls). */
export function formatBinding(modifiers: Iterable<string>, key: string): string {
  const set = new Set(modifiers);
  return [...MODIFIER_NAMES.filter((m) => set.has(m)), key].join('+');
}

export type BindingsOutcome = { ok: true; bindings: Record<HotkeyAction, string> } | { ok: false; action: HotkeyAction; reason: string };

/** Checks a full or partial set (missing actions keep `current`): each valid, none shared. Returns the normalised full set. */
export function validateBindings(wanted: Partial<Record<HotkeyAction, string>>, current: Record<HotkeyAction, string> = defaultBindings()): BindingsOutcome {
  const out = { ...current };
  for (const { action } of HOTKEY_ACTIONS) {
    if (wanted[action] === undefined) continue;
    const p = parseBinding(wanted[action]);
    if (!p.ok) return { ok: false, action, reason: p.reason };
    out[action] = p.text;
  }
  for (let i = 0; i < HOTKEY_ACTIONS.length; i++) {
    for (let j = i + 1; j < HOTKEY_ACTIONS.length; j++) {
      const a = HOTKEY_ACTIONS[i].action;
      const b = HOTKEY_ACTIONS[j].action;
      if (out[a].toLowerCase() === out[b].toLowerCase()) {
        return { ok: false, action: wanted[b] !== undefined ? b : a, reason: 'Two Capstan actions cannot share a key combination.' };
      }
    }
  }
  return { ok: true, bindings: out };
}

export const HOTKEY_STORAGE_KEY = 'capstan-hotkeys';

/** Reads the remembered bindings. Anything invalid means "use the defaults" (null). */
export function parseStoredBindings(raw: string | null): Record<HotkeyAction, string> | null {
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const wanted: Partial<Record<HotkeyAction, string>> = {};
    for (const { action } of HOTKEY_ACTIONS) {
      const v = (data as Record<string, unknown>)[action];
      if (typeof v === 'string') wanted[action] = v;
    }
    const checked = validateBindings(wanted);
    return checked.ok ? checked.bindings : null;
  } catch {
    return null;
  }
}

// ---- What the page does with an event ----
export type RecordPhase = 'setup' | 'region' | 'armed' | 'countdown' | 'recording' | 'paused' | 'saving';
export type HotkeyDecision = 'start' | 'need-click' | 'go' | 'stop' | 'pause' | 'resume' | 'marker' | 'ignore';

/**
 * The browser only opens its screen picker for a click inside Capstan, so a key pressed in another program can
 * start a recording only when the picker has already been used ('armed') or the page happens to have a fresh click.
 */
export function decideHotkey(phase: RecordPhase, action: HotkeyAction, canStartNow: boolean): HotkeyDecision {
  if (action === 'start-stop') {
    if (phase === 'setup') return canStartNow ? 'start' : 'need-click';
    if (phase === 'armed' || phase === 'countdown') return 'go';
    if (phase === 'recording' || phase === 'paused') return 'stop';
    return 'ignore';
  }
  if (action === 'pause-resume') return phase === 'recording' ? 'pause' : phase === 'paused' ? 'resume' : 'ignore';
  return phase === 'recording' || phase === 'paused' ? 'marker' : 'ignore';
}

/** The tray state for a recorder phase. */
export function trayStateFor(phase: RecordPhase): TrayState {
  return phase === 'recording' ? 'recording' : phase === 'paused' ? 'paused' : 'idle';
}

/** Two marker presses closer than this are one press (key repeat, a double tap). */
export const MARKER_MIN_GAP = 0.25;
export function acceptMarkerTime(existing: readonly number[], t: number): boolean {
  if (!Number.isFinite(t) || t < 0) return false;
  return !existing.some((x) => Math.abs(x - t) < MARKER_MIN_GAP);
}

/** Puts markers taken during a recording (seconds into the recording, pauses excluded) on the timeline from `start`. */
export function applyRecordingMarkers(project: Project, start: number, times: readonly number[]): Project {
  let next = project;
  for (const t of times) next = addMarker(next, start + Math.max(0, t)).project;
  return next;
}

// ---- The host's answers ----
export interface HotkeyKeyStatus {
  action: HotkeyAction;
  binding: string;
  registered: boolean;
  reason: string;
}
export interface HotkeyStatus {
  /** False when the host has no hotkey service (turned off, or it could not start). */
  available: boolean;
  /** False after "Quit tray". */
  running: boolean;
  /** The host is in CAPSTAN_TEST_HOTKEYS=1 mode: nothing is registered with Windows. */
  test: boolean;
  state: TrayState;
  /** The id of the newest queued event. */
  last: number;
  trayVisible: boolean;
  reason: string;
  registered: HotkeyAction[];
  failed: Array<{ action: HotkeyAction; binding: string; reason: string }>;
  bindings: Record<HotkeyAction, string>;
  keys: HotkeyKeyStatus[];
  /** Whether the host can keep Capstan's own window out of a capture, and if not, why. */
  captureExclusion: { possible: boolean; reason: string } | null;
  allowed: { modifiers: string[]; keys: string[] };
}
export interface HotkeyEvent {
  id: number;
  name: HotkeyEventName;
  at: number;
}

const EVENT_NAMES: readonly string[] = ['start-stop', 'pause-resume', 'marker', 'tray-open'];

/** Reads a status answer, tolerating a host that sends less. Never throws. */
export function parseStatus(input: unknown): HotkeyStatus | null {
  if (!input || typeof input !== 'object') return null;
  const d = input as Record<string, unknown>;
  if (typeof d.available !== 'boolean') return null;
  const bindings = defaultBindings();
  const given = (d.bindings ?? {}) as Record<string, unknown>;
  for (const { action } of HOTKEY_ACTIONS) if (typeof given[action] === 'string') bindings[action] = given[action] as string;
  const keys: HotkeyKeyStatus[] = [];
  if (Array.isArray(d.keys)) {
    for (const k of d.keys as Array<Record<string, unknown>>) {
      if (!k || !HOTKEY_ACTIONS.some((a) => a.action === k.action)) continue;
      keys.push({ action: k.action as HotkeyAction, binding: String(k.binding ?? ''), registered: k.registered === true, reason: String(k.reason ?? '') });
    }
  }
  const registered = keys.filter((k) => k.registered).map((k) => k.action);
  const failed = keys.filter((k) => !k.registered).map((k) => ({ action: k.action, binding: k.binding, reason: k.reason }));
  const allowed = (d.allowed ?? {}) as Record<string, unknown>;
  const ce = d.captureExclusion as Record<string, unknown> | undefined;
  return {
    available: d.available,
    running: d.running === true,
    test: d.test === true,
    state: d.state === 'recording' || d.state === 'paused' ? d.state : 'idle',
    last: typeof d.last === 'number' && d.last >= 0 ? d.last : 0,
    trayVisible: d.trayVisible === true,
    reason: typeof d.reason === 'string' ? d.reason : '',
    registered,
    failed,
    bindings,
    keys,
    captureExclusion: ce && typeof ce.possible === 'boolean' && typeof ce.reason === 'string' ? { possible: ce.possible, reason: ce.reason } : null,
    allowed: {
      modifiers: Array.isArray(allowed.modifiers) ? (allowed.modifiers as unknown[]).filter((x): x is string => typeof x === 'string') : [...MODIFIER_NAMES],
      keys: Array.isArray(allowed.keys) ? (allowed.keys as unknown[]).filter((x): x is string => typeof x === 'string') : [...KEY_NAMES],
    },
  };
}

/** Reads an events answer. Unknown names are dropped (the host only ever sends the fixed ones). */
export function parseEvents(input: unknown): { events: HotkeyEvent[]; last: number } | null {
  if (!input || typeof input !== 'object') return null;
  const d = input as Record<string, unknown>;
  if (!Array.isArray(d.events) || typeof d.last !== 'number') return null;
  const events: HotkeyEvent[] = [];
  for (const e of d.events as Array<Record<string, unknown>>) {
    if (!e || typeof e.id !== 'number' || typeof e.name !== 'string' || !EVENT_NAMES.includes(e.name)) continue;
    events.push({ id: e.id, name: e.name as HotkeyEventName, at: typeof e.at === 'number' ? e.at : 0 });
  }
  events.sort((a, b) => a.id - b.id);
  return { events, last: d.last };
}

// ---- The client ----
const HEADER = 'X-Capstan-Token';

export interface HotkeyClientOptions {
  token: string;
  onEvent(event: HotkeyEvent): void;
  onStatus?(status: HotkeyStatus | null): void;
  fetchImpl?: typeof fetch;
  /** False while the page is hidden or minimised. Polling pauses then, unless `keepAlive` says otherwise. */
  isVisible?(): boolean;
  /** True while a recording is running or armed: keys must work with Capstan hidden, so polling goes on. */
  keepAlive?(): boolean;
  /** Seconds the host may hold one poll (the host allows at most 25). */
  waitSeconds?: number;
  /** Pause after a failed request before trying again. */
  retryMs?: number;
}

export type ConfigOutcome = { ok: true; status: HotkeyStatus } | { ok: false; error: string; action?: HotkeyAction };

export class HotkeyClient {
  status: HotkeyStatus | null = null;
  private readonly opts: HotkeyClientOptions;
  private readonly doFetch: typeof fetch;
  private generation = 0;
  private wakers: Array<() => void> = [];
  private inflight: AbortController | null = null;
  private desiredState: TrayState = 'idle';

  constructor(opts: HotkeyClientOptions) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(json = false): Record<string, string> {
    return json ? { [HEADER]: this.opts.token, 'Content-Type': 'application/json' } : { [HEADER]: this.opts.token };
  }

  private shouldPoll(): boolean {
    const visible = this.opts.isVisible ? this.opts.isVisible() : true;
    return visible || (this.opts.keepAlive?.() ?? false);
  }

  private setStatus(s: HotkeyStatus | null) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  /** Asks the host for its status. Null when the host cannot be reached. */
  async refresh(): Promise<HotkeyStatus | null> {
    try {
      const res = await this.doFetch('/api/hotkeys/status', { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = parseStatus(await res.json());
      this.setStatus(s);
      return s;
    } catch {
      return null;
    }
  }

  /** Applies bindings through the host. The host checks them again against its own allowlist. */
  async configure(wanted: Partial<Record<HotkeyAction, string>>): Promise<ConfigOutcome> {
    const checked = validateBindings(wanted, this.status?.bindings ?? defaultBindings());
    if (!checked.ok) return { ok: false, error: checked.reason, action: checked.action };
    try {
      const res = await this.doFetch('/api/hotkeys/config', { method: 'PUT', headers: this.headers(true), body: JSON.stringify({ bindings: checked.bindings }) });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const d = (data ?? {}) as Record<string, unknown>;
        const field = HOTKEY_ACTIONS.find((a) => a.action === d.field)?.action;
        return { ok: false, error: typeof d.error === 'string' ? d.error : `The host refused the change (HTTP ${res.status}).`, action: field };
      }
      const s = parseStatus(data);
      if (!s) return { ok: false, error: 'The host sent an answer Capstan could not read.' };
      this.setStatus(s);
      return { ok: true, status: s };
    } catch {
      return { ok: false, error: 'Capstan could not reach its Windows host.' };
    }
  }

  /** Tells the host what the recorder is doing, so the tray icon and menu follow it. */
  setState(state: TrayState): void {
    this.desiredState = state;
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    if (this.status && !this.status.available) return;
    try {
      await this.doFetch('/api/hotkeys/state', { method: 'POST', headers: this.headers(true), body: JSON.stringify({ state: this.desiredState }) });
    } catch {
      /* the next status refresh tries again */
    }
  }

  private running = false;

  /** Starts the poll loop. Safe to call twice. */
  start(): void {
    if (this.running) return;
    this.generation++;
    this.running = true;
    void this.loop(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.inflight?.abort();
    this.wake();
  }

  /** Call when the page's visibility or the recorder's activity changed. */
  wake(): void {
    if (!this.shouldPoll()) this.inflight?.abort();
    const wakers = this.wakers;
    this.wakers = [];
    for (const w of wakers) w();
  }

  private waitForWake(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      this.wakers.push(done);
      if (ms !== undefined) timer = setTimeout(done, ms);
    });
  }

  private async loop(gen: number): Promise<void> {
    // The newest event id this page has seen. Null = unknown: fetch the host's newest id first and skip the
    // backlog, so a key pressed while the page was hidden never starts a recording minutes later.
    let cursor: number | null = null;
    let failures = 0;
    const alive = () => this.generation === gen;
    while (alive()) {
      if (!this.shouldPoll()) {
        cursor = null;
        await this.waitForWake();
        continue;
      }
      if (cursor === null) {
        const s = await this.refresh();
        if (!alive()) return;
        if (!s) {
          failures++;
          await this.waitForWake(Math.min(this.opts.retryMs ?? 2000, 30000) * Math.min(failures, 5));
          continue;
        }
        failures = 0;
        if (!s.available || !s.running) {
          // The host has no hotkeys (or the tray was closed): stop polling until the page is woken.
          await this.waitForWake();
          continue;
        }
        cursor = s.last;
        if (s.state !== this.desiredState) void this.pushState();
      }
      const ctrl = new AbortController();
      this.inflight = ctrl;
      try {
        const wait = Math.max(0, Math.min(25, Math.floor(this.opts.waitSeconds ?? 20)));
        const res = await this.doFetch(`/api/hotkeys/events?since=${cursor}&wait=${wait}`, { headers: this.headers(), signal: ctrl.signal });
        if (!alive()) return;
        if (res.status === 403) {
          // The session is not valid any more (the host was restarted): nothing more to do on this page.
          this.setStatus(null);
          this.running = false;
          return;
        }
        if (res.status === 409) {
          cursor = null;
          await this.waitForWake();
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const got = parseEvents(await res.json());
        if (!got) throw new Error('unreadable answer');
        failures = 0;
        // A host that restarted starts its ids again from 1.
        if (got.last < cursor) cursor = got.last;
        for (const e of got.events) {
          if (e.id <= cursor) continue;
          cursor = e.id;
          try {
            this.opts.onEvent(e);
          } catch {
            /* one bad handler never stops the loop */
          }
        }
        if (got.last > cursor) cursor = got.last;
      } catch {
        if (ctrl.signal.aborted) {
          if (this.inflight === ctrl) this.inflight = null;
          continue;
        }
        failures++;
        await this.waitForWake((this.opts.retryMs ?? 2000) * Math.min(failures, 5));
      } finally {
        if (this.inflight === ctrl) this.inflight = null;
      }
    }
  }
}
