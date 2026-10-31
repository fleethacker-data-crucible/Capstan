// Keystroke callouts: turns key events into bubbles (Ctrl+C, a run of typed text, Enter) and draws them.
import type { CursorKey } from './cursor';

export interface KeyCallout {
  /** Time of the first key. */
  start: number;
  /** Time of the last key; the bubble stays for `hold` seconds after it. */
  end: number;
  /** The whole label, e.g. "Ctrl+C", "hello", "Enter". */
  label: string;
  /** Time each character of `label` was typed (typed runs only); combos and special keys have none. */
  charTimes?: number[];
  combo: boolean;
}

/** Typed characters closer together than this join one bubble. */
export const TYPING_GAP = 0.8;
const MAX_RUN = 28;

const MODIFIERS: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', altgraph: 'Alt', shift: 'Shift', meta: 'Win', win: 'Win', os: 'Win', cmd: 'Win', super: 'Win' };
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'];
const SPECIAL: Record<string, string> = {
  enter: 'Enter', return: 'Enter', escape: 'Esc', esc: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Del', del: 'Del', insert: 'Ins',
  home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
  left: '←', right: '→', up: '↑', down: '↓', capslock: 'Caps', printscreen: 'PrtSc', contextmenu: 'Menu', ' ': 'Space', space: 'Space',
};

/** The modifier name a key event stands for ("Control" -> "Ctrl"), or null for any other key. */
export function modifierName(key: string): string | null {
  return MODIFIERS[key.toLowerCase()] ?? null;
}

/** How a non-modifier key is shown: letters upper-case, names tidied ("ArrowLeft" -> arrow). */
export function keyLabel(key: string): string {
  const s = SPECIAL[key.toLowerCase()];
  if (s) return s;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Groups key events into bubbles. A key pressed while Ctrl, Alt or Win is held (or Shift with a
 * non-character key) is a combo ("Ctrl+Shift+Esc"); plain characters typed within 0.8 s of each
 * other form one text bubble; Enter, Esc, the arrows and the like get their own. Modifiers pressed
 * alone show nothing, and a held key's repeats count once. Events must be sorted by time.
 */
export function keyCallouts(keys: ReadonlyArray<CursorKey>): KeyCallout[] {
  const out: KeyCallout[] = [];
  const held = new Set<string>();
  const down = new Set<string>();
  let run: KeyCallout | null = null;
  for (const e of keys) {
    const mod = modifierName(e.key);
    if (!e.down) {
      if (mod) held.delete(mod);
      down.delete(e.key);
      continue;
    }
    if (mod) {
      held.add(mod);
      down.add(e.key);
      continue;
    }
    if (down.has(e.key)) continue; // auto-repeat
    down.add(e.key);
    const printable = e.key.length === 1 && e.key !== ' ';
    const mods = MOD_ORDER.filter((m) => held.has(m));
    const commandy = mods.some((m) => m !== 'Shift');
    if (commandy || (held.has('Shift') && !printable && e.key !== ' ')) {
      run = null;
      out.push({ start: e.t, end: e.t, label: [...mods, keyLabel(e.key)].join('+'), combo: true });
    } else if (printable || e.key === ' ') {
      if (run && e.t - run.end <= TYPING_GAP && run.label.length < MAX_RUN) {
        run.label += e.key;
        run.charTimes!.push(e.t);
        run.end = e.t;
      } else {
        run = { start: e.t, end: e.t, label: e.key, charTimes: [e.t], combo: false };
        out.push(run);
      }
    } else {
      run = null;
      out.push({ start: e.t, end: e.t, label: keyLabel(e.key), combo: false });
    }
  }
  return out;
}

/** The text of a bubble at `t`: a typed run shows only the characters typed so far. */
export function calloutText(c: KeyCallout, t: number): string {
  if (!c.charTimes) return c.label;
  let n = 0;
  while (n < c.charTimes.length && c.charTimes[n] <= t) n++;
  const text = c.label.slice(0, n);
  return text.trim() === '' && n > 0 ? 'Space' : text;
}

/** Fade of a bubble at `t`: quick fade in, full until 70% of `hold` after the last key, then fades out. 0 when not shown. */
export function calloutAlpha(c: KeyCallout, t: number, hold: number): number {
  if (t < c.start || t >= c.end + hold) return 0;
  const fadeIn = Math.min(1, (t - c.start) / 0.08);
  const left = c.end + hold - t;
  const fadeOut = Math.min(1, left / (hold * 0.3));
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface CalloutStyle {
  hold: number;
  size: number;
  /** Clip height in canvas pixels; all sizes scale with it. */
  unit: number;
  /** Bottom centre of the stack. */
  x: number;
  y: number;
}

const MAX_SHOWN = 3;

function roundedRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the bubbles showing at `t`, newest at the bottom, up to three. */
export function drawKeyCallouts(ctx: Ctx2D, callouts: ReadonlyArray<KeyCallout>, t: number, style: CalloutStyle): void {
  const shown: Array<{ c: KeyCallout; a: number }> = [];
  for (let i = callouts.length - 1; i >= 0 && shown.length < MAX_SHOWN; i--) {
    const c = callouts[i];
    if (c.start > t) continue;
    const a = calloutAlpha(c, t, style.hold);
    if (a > 0) shown.push({ c, a });
    else if (c.end + style.hold < t - 30) break;
  }
  if (!shown.length) return;
  const fontPx = Math.max(10, style.unit * 0.035 * style.size);
  const gap = fontPx * 0.35;
  const padX = fontPx * 0.6;
  const boxH = fontPx * 1.7;
  ctx.save();
  ctx.font = `600 ${fontPx}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  let bottom = style.y;
  for (const { c, a } of shown) {
    const text = calloutText(c, t);
    if (!text) continue;
    const parts = c.combo ? text.split('+') : [text];
    const widths = parts.map((p) => ctx.measureText(p).width + padX * 2);
    const total = widths.reduce((s, w) => s + w, 0) + gap * (parts.length - 1);
    let x = style.x - total / 2;
    const y = bottom - boxH;
    ctx.globalAlpha = a;
    parts.forEach((p, i) => {
      const w = widths[i];
      roundedRect(ctx, x, y, w, boxH, fontPx * 0.4);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, fontPx * 0.06);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p, x + w / 2, y + boxH / 2 + fontPx * 0.04);
      x += w + gap;
    });
    bottom = y - gap * 1.4;
  }
  ctx.restore();
}
