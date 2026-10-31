// Device frames drawn as vector art around a clip: no bundled images. A frame hugs the picture: its
// size comes from the picture's size, and the whole device is then scaled to fit the clip's box.

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type FrameKind = 'browser' | 'laptop' | 'phone' | 'tablet' | 'monitor';
export type FrameTone = 'dark' | 'light';

export const FRAME_KINDS: ReadonlyArray<{ kind: FrameKind; label: string }> = [
  { kind: 'browser', label: 'Browser window' },
  { kind: 'laptop', label: 'Laptop' },
  { kind: 'phone', label: 'Phone' },
  { kind: 'tablet', label: 'Tablet' },
  { kind: 'monitor', label: 'Monitor' },
];

export interface FrameLayout {
  /** Whole device, in device units where the picture is `width` x `height`. */
  W: number;
  H: number;
  /** Where the picture sits, and its corner radii [top-left, top-right, bottom-right, bottom-left]. */
  sx: number;
  sy: number;
  radii: [number, number, number, number];
  /** Uniform scale that fits the device inside the clip's box. */
  scale: number;
}

export function frameLayout(kind: FrameKind, w: number, h: number): FrameLayout {
  const m = Math.min(w, h);
  let W: number, H: number, sx: number, sy: number;
  let radii: FrameLayout['radii'] = [0, 0, 0, 0];
  switch (kind) {
    case 'browser': {
      const bar = Math.max(8, h * 0.08);
      const pad = Math.max(1, h * 0.01);
      W = w + pad * 2;
      H = bar + h + pad;
      sx = pad;
      sy = bar;
      const r = Math.max(0, h * 0.022 - pad);
      radii = [0, 0, r, r];
      break;
    }
    case 'laptop': {
      const p = h * 0.035;
      const chin = p * 1.5;
      const base = h * 0.05;
      W = (w + p * 2) * 1.12;
      H = p + h + chin + base;
      sx = (W - w) / 2;
      sy = p;
      const r = p * 0.4;
      radii = [r, r, r, r];
      break;
    }
    case 'phone': {
      const b = m * 0.045;
      W = w + b * 2;
      H = h + b * 2;
      sx = b;
      sy = b;
      const r = Math.max(0, m * 0.14 - b);
      radii = [r, r, r, r];
      break;
    }
    case 'tablet': {
      const b = m * 0.05;
      W = w + b * 2;
      H = h + b * 2;
      sx = b;
      sy = b;
      const r = m * 0.012;
      radii = [r, r, r, r];
      break;
    }
    case 'monitor': {
      const p = h * 0.025;
      const chin = h * 0.07;
      const neck = h * 0.1;
      const foot = h * 0.03;
      W = w + p * 2;
      H = p + h + chin + neck + foot;
      sx = p;
      sy = p;
      const r = p * 0.5;
      radii = [r, r, r, r];
      break;
    }
  }
  const scale = Math.min(w / W, h / H);
  return { W, H, sx, sy, radii, scale };
}

export function roundedRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, radii: number | [number, number, number, number]): void {
  const lim = Math.max(0, Math.min(w, h) / 2);
  const [tl, tr, br, bl] = (typeof radii === 'number' ? [radii, radii, radii, radii] : radii).map((r) => Math.min(Math.max(0, r), lim));
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** The path the picture is clipped to, in device units. */
export function screenPath(ctx: Ctx2D, l: FrameLayout, w: number, h: number): void {
  roundedRectPath(ctx, l.sx, l.sy, w, h, l.radii);
}

const TONES = {
  dark: { body: '#15181d', edge: '#2d323b', bar: '#222730', pill: '#363c47', metal: '#9ea4ad', metalDark: '#6f757e' },
  light: { body: '#e6e9ee', edge: '#bfc5ce', bar: '#f4f5f7', pill: '#ffffff', metal: '#d3d7de', metalDark: '#a9afb9' },
};

/** Draws the part of the device that sits behind the picture. Coordinates are device units. */
export function paintFrameBack(ctx: Ctx2D, kind: FrameKind, tone: FrameTone, l: FrameLayout, w: number, h: number): void {
  const t = TONES[tone];
  const m = Math.min(w, h);
  ctx.save();
  ctx.lineWidth = Math.max(1, m * 0.004);
  switch (kind) {
    case 'browser': {
      const bar = l.sy;
      roundedRectPath(ctx, 0, 0, l.W, l.H, h * 0.022);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.fillStyle = t.bar;
      roundedRectPath(ctx, 0, 0, l.W, bar, [h * 0.022, h * 0.022, 0, 0]);
      ctx.fill();
      const dot = bar * 0.14;
      ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
        ctx.beginPath();
        ctx.arc(bar * 0.6 + i * bar * 0.42, bar / 2, dot, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.fill();
      });
      const px = bar * 2.3;
      const pw = Math.max(0, l.W - px - bar * 0.6);
      ctx.fillStyle = t.pill;
      roundedRectPath(ctx, px, bar * 0.22, pw, bar * 0.56, bar * 0.28);
      ctx.fill();
      ctx.strokeStyle = t.edge;
      roundedRectPath(ctx, 0, 0, l.W, l.H, h * 0.022);
      ctx.stroke();
      break;
    }
    case 'laptop': {
      const p = l.sy;
      const baseH = h * 0.05;
      const lidH = l.H - baseH;
      const lidX = l.sx - p;
      const lidWidth = w + p * 2;
      roundedRectPath(ctx, lidX, 0, lidWidth, lidH, [p * 0.9, p * 0.9, p * 0.3, p * 0.3]);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.strokeStyle = t.edge;
      ctx.stroke();
      // Camera dot in the top bezel.
      ctx.beginPath();
      ctx.arc(l.W / 2, p / 2, Math.max(0.5, p * 0.12), 0, Math.PI * 2);
      ctx.fillStyle = t.edge;
      ctx.fill();
      // Base.
      roundedRectPath(ctx, 0, lidH, l.W, baseH, [0, 0, baseH * 0.6, baseH * 0.6]);
      ctx.fillStyle = t.metal;
      ctx.fill();
      ctx.strokeStyle = t.metalDark;
      ctx.stroke();
      roundedRectPath(ctx, l.W / 2 - lidWidth * 0.08, lidH, lidWidth * 0.16, baseH * 0.4, [0, 0, baseH * 0.3, baseH * 0.3]);
      ctx.fillStyle = t.metalDark;
      ctx.fill();
      break;
    }
    case 'phone': {
      roundedRectPath(ctx, 0, 0, l.W, l.H, m * 0.14);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.strokeStyle = t.edge;
      ctx.lineWidth = Math.max(1, m * 0.008);
      ctx.stroke();
      break;
    }
    case 'tablet': {
      roundedRectPath(ctx, 0, 0, l.W, l.H, m * 0.06);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.strokeStyle = t.edge;
      ctx.lineWidth = Math.max(1, m * 0.006);
      ctx.stroke();
      break;
    }
    case 'monitor': {
      const p = l.sy;
      const chin = h * 0.07;
      const neckH = h * 0.1;
      const footH = h * 0.03;
      const panelH = p + h + chin;
      // Stand first, so the panel overlaps its top.
      ctx.fillStyle = t.metal;
      ctx.beginPath();
      ctx.moveTo(l.W / 2 - l.W * 0.04, panelH - 1);
      ctx.lineTo(l.W / 2 + l.W * 0.04, panelH - 1);
      ctx.lineTo(l.W / 2 + l.W * 0.06, panelH + neckH);
      ctx.lineTo(l.W / 2 - l.W * 0.06, panelH + neckH);
      ctx.closePath();
      ctx.fill();
      roundedRectPath(ctx, l.W / 2 - l.W * 0.16, panelH + neckH, l.W * 0.32, footH, footH * 0.5);
      ctx.fillStyle = t.metalDark;
      ctx.fill();
      roundedRectPath(ctx, 0, 0, l.W, panelH, p * 0.9);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.strokeStyle = t.edge;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(l.W / 2, p + h + chin / 2, Math.max(0.5, chin * 0.08), 0, Math.PI * 2);
      ctx.fillStyle = t.edge;
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/** Draws what sits over the picture: a phone's camera pill, a screen's thin edge. */
export function paintFrameFront(ctx: Ctx2D, kind: FrameKind, tone: FrameTone, l: FrameLayout, w: number, h: number): void {
  const t = TONES[tone];
  const m = Math.min(w, h);
  ctx.save();
  if (kind === 'phone') {
    const long = m * 0.26;
    const thick = m * 0.045;
    ctx.fillStyle = tone === 'dark' ? '#000' : '#14171c';
    if (h >= w) roundedRectPath(ctx, l.sx + (w - long) / 2, l.sy + m * 0.03, long, thick, thick / 2);
    else roundedRectPath(ctx, l.sx + m * 0.03, l.sy + (h - long) / 2, thick, long, thick / 2);
    ctx.fill();
  } else if (kind === 'tablet') {
    const b = l.sx;
    ctx.beginPath();
    if (h >= w) ctx.arc(l.W / 2, b / 2, Math.max(0.5, b * 0.12), 0, Math.PI * 2);
    else ctx.arc(b / 2, l.H / 2, Math.max(0.5, b * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = t.edge;
    ctx.fill();
  }
  if (kind === 'laptop' || kind === 'monitor' || kind === 'browser') {
    ctx.strokeStyle = t.edge;
    ctx.lineWidth = Math.max(0.5, m * 0.002);
    screenPath(ctx, l, w, h);
    ctx.stroke();
  }
  ctx.restore();
}
