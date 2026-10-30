// The built-in cursor pictures. Each is drawn with its click point at (x, y) and `h` pixels tall.
import type { CursorShape } from './cursor';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function pill(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const OUTLINE = '#101828';

export function drawCursorShape(ctx: Ctx2D, shape: CursorShape, x: number, y: number, h: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(h, h);
  const px = 1 / h; // one pixel in unit space
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  if (shape === 'arrow') {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 0.86);
    ctx.lineTo(0.19, 0.68);
    ctx.lineTo(0.31, 0.98);
    ctx.lineTo(0.43, 0.93);
    ctx.lineTo(0.31, 0.64);
    ctx.lineTo(0.58, 0.64);
    ctx.closePath();
    ctx.lineWidth = px * 3;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = color;
    ctx.fill();
  } else if (shape === 'hand') {
    // A pointing hand: the index finger's tip is the click point.
    ctx.translate(-0.34, 0);
    const parts: Array<[number, number, number, number, number]> = [
      [0.26, 0, 0.17, 0.62, 0.085],
      [0.41, 0.36, 0.15, 0.4, 0.075],
      [0.55, 0.4, 0.15, 0.4, 0.075],
      [0.69, 0.46, 0.14, 0.36, 0.07],
      [0.12, 0.5, 0.7, 0.46, 0.13],
    ];
    ctx.lineWidth = px * 3.5;
    ctx.strokeStyle = OUTLINE;
    for (const p of parts) {
      ctx.beginPath();
      pill(ctx, ...p);
      ctx.stroke();
    }
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = color;
    for (const p of parts) {
      ctx.beginPath();
      pill(ctx, ...p);
      ctx.fill();
    }
  } else {
    // A round pointer dot for presentations.
    ctx.beginPath();
    ctx.arc(0, 0, 0.3, 0, Math.PI * 2);
    ctx.lineWidth = px * 3;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 0.08, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  }
  ctx.restore();
}
