// Visual effects on a clip: colour, chroma key, shadow, border, rounded corners, device frame, blend mode.
// The compositor stays Canvas 2D and calls drawWithEffects around every clip. Colour and chroma key run
// in a WebGL2 pass (fx-gl.ts) with a CPU fallback (fx-math.ts); the rest is plain Canvas 2D.
import { FRAME_KINDS, type FrameKind, type FrameTone, frameLayout, paintFrameBack, paintFrameFront, roundedRectPath, screenPath } from './fx-frames';
import { glAvailable, runGlPass } from './fx-gl';
import { type ChromaFx, type ColourFx, chromaParams, colourParams, hexToRgb, processImageData } from './fx-math';

export type { ChromaFx, ColourFx } from './fx-math';
export { FRAME_KINDS, type FrameKind, type FrameTone } from './fx-frames';

export interface ShadowFx {
  on: boolean;
  /** Blur radius in canvas pixels. */
  blur: number;
  /** Offset in canvas pixels (the light stays put when the clip rotates). */
  dx: number;
  dy: number;
  colour: string;
  /** 0..100 */
  opacity: number;
}

export interface BorderFx {
  on: boolean;
  /** Canvas pixels, drawn inside the clip's edge. */
  width: number;
  colour: string;
}

export interface FrameFx {
  on: boolean;
  kind: FrameKind;
  tone: FrameTone;
}

/** How the clip mixes with what is beneath it. Everything but 'add' is the canvas operation of the same name. */
export const BLEND_MODES = [
  { id: 'normal', label: 'Normal', op: 'source-over' },
  { id: 'multiply', label: 'Multiply', op: 'multiply' },
  { id: 'screen', label: 'Screen', op: 'screen' },
  { id: 'overlay', label: 'Overlay', op: 'overlay' },
  { id: 'darken', label: 'Darken', op: 'darken' },
  { id: 'lighten', label: 'Lighten', op: 'lighten' },
  { id: 'color-dodge', label: 'Colour dodge', op: 'color-dodge' },
  { id: 'color-burn', label: 'Colour burn', op: 'color-burn' },
  { id: 'hard-light', label: 'Hard light', op: 'hard-light' },
  { id: 'soft-light', label: 'Soft light', op: 'soft-light' },
  { id: 'difference', label: 'Difference', op: 'difference' },
  { id: 'exclusion', label: 'Exclusion', op: 'exclusion' },
  { id: 'add', label: 'Add', op: 'lighter' },
] as const;
export type BlendMode = (typeof BLEND_MODES)[number]['id'];

export type MaskShape = 'circle' | 'ellipse';

export interface ClipEffects {
  colour?: ColourFx;
  chroma?: ChromaFx;
  shadow?: ShadowFx;
  border?: BorderFx;
  /** Corner radius in canvas pixels. 0 or absent = square corners. */
  radius?: number;
  /** Clip the picture to an ellipse (the box) or a circle (the shorter side). Wins over the radius. */
  mask?: MaskShape;
  blend?: BlendMode;
  frame?: FrameFx;
}

export const DEFAULT_COLOUR: ColourFx = { on: true, brightness: 0, contrast: 0, saturation: 0, hue: 0, tint: '#d9a441', tintAmount: 0 };
export const DEFAULT_CHROMA: ChromaFx = { on: true, key: '#00ff00', tolerance: 40, softness: 12, spill: 60 };
export const DEFAULT_SHADOW: ShadowFx = { on: true, blur: 40, dx: 0, dy: 16, colour: '#000000', opacity: 50 };
export const DEFAULT_BORDER: BorderFx = { on: true, width: 6, colour: '#ffffff' };
export const DEFAULT_FRAME: FrameFx = { on: true, kind: 'laptop', tone: 'dark' };

const FRAME_IDS = FRAME_KINDS.map((f) => f.kind) as string[];
const BLEND_IDS = BLEND_MODES.map((b) => b.id) as string[];

// ---------- parsing ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const hex = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);

function parseColour(v: unknown): ColourFx | undefined {
  if (!isObj(v)) return undefined;
  const d = DEFAULT_COLOUR;
  return {
    on: v.on !== false,
    brightness: clampNum(v.brightness, -100, 100, d.brightness),
    contrast: clampNum(v.contrast, -100, 100, d.contrast),
    saturation: clampNum(v.saturation, -100, 100, d.saturation),
    hue: clampNum(v.hue, -180, 180, d.hue),
    tint: hex(v.tint, d.tint),
    tintAmount: clampNum(v.tintAmount, 0, 100, d.tintAmount),
  };
}

function parseChroma(v: unknown): ChromaFx | undefined {
  if (!isObj(v)) return undefined;
  const d = DEFAULT_CHROMA;
  return {
    on: v.on !== false,
    key: hex(v.key, d.key),
    tolerance: clampNum(v.tolerance, 0, 100, d.tolerance),
    softness: clampNum(v.softness, 0, 100, d.softness),
    spill: clampNum(v.spill, 0, 100, d.spill),
  };
}

function parseShadow(v: unknown): ShadowFx | undefined {
  if (!isObj(v)) return undefined;
  const d = DEFAULT_SHADOW;
  return {
    on: v.on !== false,
    blur: clampNum(v.blur, 0, 1000, d.blur),
    dx: clampNum(v.dx, -2000, 2000, d.dx),
    dy: clampNum(v.dy, -2000, 2000, d.dy),
    colour: hex(v.colour, d.colour),
    opacity: clampNum(v.opacity, 0, 100, d.opacity),
  };
}

function parseBorder(v: unknown): BorderFx | undefined {
  if (!isObj(v)) return undefined;
  const d = DEFAULT_BORDER;
  return { on: v.on !== false, width: clampNum(v.width, 0, 500, d.width), colour: hex(v.colour, d.colour) };
}

function parseFrame(v: unknown): FrameFx | undefined {
  if (!isObj(v) || typeof v.kind !== 'string' || !FRAME_IDS.includes(v.kind)) return undefined;
  return { on: v.on !== false, kind: v.kind as FrameKind, tone: v.tone === 'light' ? 'light' : 'dark' };
}

/** Validates saved effects. Unknown or malformed parts are dropped; nothing valid left means no effects. */
export function parseEffects(input: unknown): ClipEffects | undefined {
  if (!isObj(input)) return undefined;
  const out: ClipEffects = {};
  const colour = parseColour(input.colour);
  if (colour) out.colour = colour;
  const chroma = parseChroma(input.chroma);
  if (chroma) out.chroma = chroma;
  const shadow = parseShadow(input.shadow);
  if (shadow) out.shadow = shadow;
  const border = parseBorder(input.border);
  if (border) out.border = border;
  if (typeof input.radius === 'number' && Number.isFinite(input.radius) && input.radius > 0) out.radius = Math.min(2000, input.radius);
  if (input.mask === 'circle' || input.mask === 'ellipse') out.mask = input.mask;
  if (typeof input.blend === 'string' && input.blend !== 'normal' && BLEND_IDS.includes(input.blend)) out.blend = input.blend as BlendMode;
  const frame = parseFrame(input.frame);
  if (frame) out.frame = frame;
  return Object.keys(out).length ? out : undefined;
}

/** Scales pixel sizes inside the effects (radius, shadow, border) when the canvas size changes. */
export function rescaleEffects(effects: ClipEffects | undefined, k: number): ClipEffects | undefined {
  if (!effects || k === 1 || !Number.isFinite(k) || k <= 0) return effects;
  const out: ClipEffects = { ...effects };
  if (effects.radius) out.radius = effects.radius * k;
  if (effects.shadow) out.shadow = { ...effects.shadow, blur: effects.shadow.blur * k, dx: effects.shadow.dx * k, dy: effects.shadow.dy * k };
  if (effects.border) out.border = { ...effects.border, width: effects.border.width * k };
  return out;
}

/** Replaces the groups `patch` mentions and keeps the rest. */
export function mergeEffects(base: ClipEffects | undefined, patch: ClipEffects): ClipEffects {
  return { ...base, ...patch };
}

// ---------- what is switched on ----------

export interface ActiveEffects {
  colour: ReturnType<typeof colourParams>;
  chroma: ReturnType<typeof chromaParams>;
  shadow: ShadowFx | null;
  border: BorderFx | null;
  radius: number;
  mask: MaskShape | null;
  blend: (typeof BLEND_MODES)[number]['op'] | null;
  frame: FrameFx | null;
  /** Anything beyond a plain draw. */
  any: boolean;
}

export function activeEffects(e: ClipEffects | undefined): ActiveEffects {
  const frame = e?.frame?.on ? e.frame : null;
  const colour = colourParams(e?.colour);
  const chroma = chromaParams(e?.chroma);
  const shadow = e?.shadow?.on && e.shadow.opacity > 0 ? e.shadow : null;
  // A device frame shapes the picture itself, so radius, mask and border do not apply with one.
  const border = !frame && e?.border?.on && e.border.width > 0 ? e.border : null;
  const radius = !frame && e?.radius ? e.radius : 0;
  const mask = !frame && e?.mask ? e.mask : null;
  const blend = e?.blend && e.blend !== 'normal' ? (BLEND_MODES.find((b) => b.id === e.blend)?.op ?? null) : null;
  return { colour, chroma, shadow, border, radius, mask, blend, frame, any: !!(colour || chroma || shadow || border || radius || mask || blend || frame) };
}

export function hasActiveEffects(e: ClipEffects | undefined): boolean {
  return activeEffects(e).any;
}

// ---------- scratch canvases ----------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
interface Scratch {
  canvas: AnyCanvas;
  ctx: Ctx2D;
}

const MAX_SIDE = 4096;
const pool = new Map<string, Scratch>();

function scratch(slot: string, w: number, h: number, readback = false): Scratch {
  const key = `${slot}:${w}x${h}`;
  const hit = pool.get(key);
  if (hit) {
    pool.delete(key);
    pool.set(key, hit);
    return hit;
  }
  const canvas: AnyCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.imageSmoothingQuality = 'high';
  const made = { canvas, ctx };
  pool.set(key, made);
  while (pool.size > 10) pool.delete(pool.keys().next().value as string);
  return made;
}

function shapePath(ctx: Ctx2D, w: number, h: number, a: ActiveEffects): boolean {
  if (a.mask === 'circle') {
    const r = Math.min(w, h) / 2;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    return true;
  }
  if (a.mask === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    return true;
  }
  if (a.radius > 0) {
    roundedRectPath(ctx, -w / 2, -h / 2, w, h, a.radius);
    return true;
  }
  return false;
}

function rgba(colour: string, opacity: number): string {
  const [r, g, b] = hexToRgb(colour);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${opacity})`;
}

interface Processed {
  source: CanvasImageSource;
  sy: number;
}

/** Runs the colour and chroma pass over a scratch layer: WebGL2 where it works, else on the CPU. */
function colourPass(layer: Scratch, w: number, h: number, a: ActiveEffects): Processed {
  const gl = runGlPass(layer.canvas, w, h, a.colour, a.chroma);
  if (gl) return { source: gl.canvas, sy: gl.sy };
  const lc = layer.ctx;
  lc.setTransform(1, 0, 0, 1, 0, 0);
  const img = lc.getImageData(0, 0, w, h);
  processImageData(img.data, a.colour, a.chroma);
  lc.putImageData(img, 0, 0);
  return { source: layer.canvas, sy: 0 };
}

/**
 * Draws a clip layer through its effects. `drawBase` paints the layer centred on the origin,
 * `width` x `height` big, onto whatever context it is given. Without effects it simply draws.
 */
export function drawWithEffects(ctx: Ctx2D, effects: ClipEffects | undefined, width: number, height: number, drawBase: (target: Ctx2D) => void): void {
  if (!effects || !(width > 0) || !(height > 0)) {
    drawBase(ctx);
    return;
  }
  const a = activeEffects(effects);
  if (!a.any) {
    drawBase(ctx);
    return;
  }
  const applyShadow = (target: Ctx2D) => {
    if (!a.shadow) return;
    target.shadowColor = rgba(a.shadow.colour, a.shadow.opacity / 100);
    target.shadowBlur = a.shadow.blur;
    target.shadowOffsetX = a.shadow.dx;
    target.shadowOffsetY = a.shadow.dy;
  };

  // Shadow and blend alone need no off-screen work.
  if (!a.colour && !a.chroma && !a.border && !a.radius && !a.mask && !a.frame) {
    ctx.save();
    if (a.blend) ctx.globalCompositeOperation = a.blend;
    applyShadow(ctx);
    drawBase(ctx);
    ctx.restore();
    return;
  }

  const q = Math.min(1, MAX_SIDE / Math.max(width, height));
  const cw = Math.max(1, Math.ceil(width * q));
  const ch = Math.max(1, Math.ceil(height * q));
  const box = scratch('box', cw, ch);
  const b = box.ctx;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, cw, ch);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'source-over';
  b.setTransform(cw / width, 0, 0, ch / height, cw / 2, ch / 2);

  // Draws the clip into a layer `lw` x `lh` big, through the colour pass if there is one.
  const layer = (lw: number, lh: number): Processed | null => {
    if (!a.colour && !a.chroma) return null;
    const l = scratch('layer', lw, lh, !glAvailable());
    const lc = l.ctx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, lw, lh);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = 'source-over';
    lc.setTransform(lw / width, 0, 0, lh / height, lw / 2, lh / 2);
    drawBase(lc);
    lc.setTransform(1, 0, 0, 1, 0, 0);
    return colourPass(l, lw, lh, a);
  };

  if (a.frame) {
    const layout = frameLayout(a.frame.kind, width, height);
    const s = layout.scale;
    const lw = Math.max(1, Math.ceil(width * s * q));
    const lh = Math.max(1, Math.ceil(height * s * q));
    const processed = layer(lw, lh);
    b.save();
    b.scale(s, s);
    b.translate(-layout.W / 2, -layout.H / 2);
    paintFrameBack(b, a.frame.kind, a.frame.tone, layout, width, height);
    b.save();
    screenPath(b, layout, width, height);
    b.clip();
    if (processed) {
      b.drawImage(processed.source, 0, processed.sy, lw, lh, layout.sx, layout.sy, width, height);
    } else {
      // No colour pass: draw the clip straight into the screen.
      b.translate(layout.sx + width / 2, layout.sy + height / 2);
      drawBase(b);
    }
    b.restore();
    paintFrameFront(b, a.frame.kind, a.frame.tone, layout, width, height);
    b.restore();
  } else {
    const processed = layer(cw, ch);
    b.save();
    if (shapePath(b, width, height, a)) b.clip();
    if (processed) {
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.drawImage(processed.source, 0, processed.sy, cw, ch, 0, 0, cw, ch);
    } else {
      drawBase(b);
    }
    b.restore();
    if (a.border) {
      b.save();
      b.setTransform(cw / width, 0, 0, ch / height, cw / 2, ch / 2);
      if (!shapePath(b, width, height, a)) {
        b.beginPath();
        b.rect(-width / 2, -height / 2, width, height);
      }
      b.clip();
      b.lineWidth = a.border.width * 2;
      b.strokeStyle = a.border.colour;
      b.stroke();
      b.restore();
    }
  }

  ctx.save();
  if (a.blend) ctx.globalCompositeOperation = a.blend;
  applyShadow(ctx);
  ctx.drawImage(box.canvas, 0, 0, cw, ch, -width / 2, -height / 2, width, height);
  ctx.restore();
}

// ---------- presets ----------

export interface EffectPreset {
  id: string;
  label: string;
  hint: string;
  /** Effects to merge onto the clip, sized for a canvas `canvasHeight` pixels tall. */
  build(canvasHeight: number): ClipEffects;
}

const pct = (canvasHeight: number, p: number): number => Math.max(1, Math.round((canvasHeight * p) / 100));

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'green-screen', label: 'Green screen', hint: 'Removes a green backdrop', build: () => ({ chroma: { ...DEFAULT_CHROMA } }) },
  {
    id: 'card',
    label: 'Rounded card with shadow',
    hint: 'Rounded corners and a soft shadow',
    build: (h) => ({ radius: pct(h, 2.5), shadow: { ...DEFAULT_SHADOW, blur: pct(h, 3.5), dy: pct(h, 1.4), opacity: 50 } }),
  },
  {
    id: 'circle',
    label: 'Circle with border',
    hint: 'A round bubble, good for a webcam',
    build: (h) => ({ mask: 'circle', border: { ...DEFAULT_BORDER, width: pct(h, 0.7) }, shadow: { ...DEFAULT_SHADOW, blur: pct(h, 2.5), dy: pct(h, 1), opacity: 45 } }),
  },
  { id: 'laptop', label: 'Laptop frame', hint: 'The picture on a laptop screen', build: () => ({ frame: { on: true, kind: 'laptop', tone: 'dark' } }) },
  { id: 'browser', label: 'Browser window', hint: 'A browser title bar around the picture', build: (h) => ({ frame: { on: true, kind: 'browser', tone: 'dark' }, shadow: { ...DEFAULT_SHADOW, blur: pct(h, 3), dy: pct(h, 1.2), opacity: 45 } }) },
  { id: 'phone', label: 'Phone frame', hint: 'The picture on a phone screen', build: () => ({ frame: { on: true, kind: 'phone', tone: 'dark' } }) },
  { id: 'tablet', label: 'Tablet frame', hint: 'The picture on a tablet screen', build: () => ({ frame: { on: true, kind: 'tablet', tone: 'dark' } }) },
  { id: 'monitor', label: 'Monitor frame', hint: 'The picture on a desktop monitor', build: () => ({ frame: { on: true, kind: 'monitor', tone: 'dark' } }) },
  { id: 'bw', label: 'Black and white', hint: 'No colour, a little more contrast', build: () => ({ colour: { ...DEFAULT_COLOUR, saturation: -100, contrast: 10 } }) },
  { id: 'sepia', label: 'Sepia', hint: 'Warm brown tint', build: () => ({ colour: { ...DEFAULT_COLOUR, saturation: -40, tint: '#b08050', tintAmount: 55 } }) },
  { id: 'vivid', label: 'Vivid', hint: 'Richer colour and contrast', build: () => ({ colour: { ...DEFAULT_COLOUR, saturation: 35, contrast: 12 } }) },
  { id: 'faded', label: 'Faded', hint: 'Soft, low contrast', build: () => ({ colour: { ...DEFAULT_COLOUR, brightness: 8, contrast: -25, saturation: -20 } }) },
  { id: 'multiply', label: 'Multiply blend', hint: 'Darkens what is beneath', build: () => ({ blend: 'multiply' }) },
  { id: 'screen', label: 'Screen blend', hint: 'Lightens what is beneath', build: () => ({ blend: 'screen' }) },
];
