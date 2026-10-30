// Browser-side helpers for visual-effects.e2e.mjs: render a synthetic layer through drawWithEffects
// (WebGL2 or CPU, on a normal or an off-screen canvas), run the pure reference over the same pixels,
// and export one tiny frame. Built with: bun build tests/e2e/fx-harness.ts --outdir tests/e2e/.build --target browser
import { type ClipEffects, drawWithEffects, parseEffects } from '../../src/engine/fx';
import { effectsBackend, setGlEnabled } from '../../src/engine/fx-gl';
import { chromaParams, colourParams, processImageData } from '../../src/engine/fx-math';
import { defaultExportOptions, exportMp4 } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia, trimEnd } from '../../src/engine/ops';
import { createProject } from '../../src/engine/project';
import { updateClipEffects } from '../../src/engine/fx-ops';


/** A source picture: green backdrop, a blue box, a red bar, and a smooth gradient strip. */
function sourceCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#00ff00';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#0000ff';
  g.fillRect(w * 0.35, h * 0.25, w * 0.3, h * 0.4);
  g.fillStyle = '#ff0000';
  g.fillRect(0, 0, w, h * 0.1);
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#203060');
  grad.addColorStop(0.5, '#c08040');
  grad.addColorStop(1, '#60d0a0');
  g.fillStyle = grad;
  g.fillRect(0, h * 0.8, w, h * 0.2);
  return c;
}

export interface RenderOptions {
  effects: unknown;
  /** Clip box. */
  w: number;
  h: number;
  /** Canvas size, background (#rrggbb), and where the clip is centred. */
  width: number;
  height: number;
  background: string;
  cpu?: boolean;
  offscreen?: boolean;
}

function render(o: RenderOptions): { data: number[]; backend: string } {
  setGlEnabled(!o.cpu);
  const src = sourceCanvas(Math.round(o.w), Math.round(o.h));
  const surface: HTMLCanvasElement | OffscreenCanvas = o.offscreen ? new OffscreenCanvas(o.width, o.height) : Object.assign(document.createElement('canvas'), { width: o.width, height: o.height });
  const ctx = surface.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, o.width, o.height);
  ctx.save();
  ctx.translate(o.width / 2, o.height / 2);
  drawWithEffects(ctx, parseEffects(o.effects), o.w, o.h, (t) => t.drawImage(src, -o.w / 2, -o.h / 2, o.w, o.h));
  ctx.restore();
  const img = ctx.getImageData(0, 0, o.width, o.height);
  const backend = effectsBackend();
  setGlEnabled(true);
  return { data: Array.from(img.data), backend };
}

/** The pure reference over the same source pixels: what the shader should produce. */
function reference(w: number, h: number, effects: unknown): number[] {
  const src = sourceCanvas(w, h);
  const img = src.getContext('2d')!.getImageData(0, 0, w, h);
  const fx: ClipEffects = parseEffects(effects) ?? {};
  processImageData(img.data, colourParams(fx.colour), chromaParams(fx.chroma));
  return Array.from(img.data);
}

async function exportFrame(effects: unknown): Promise<{ base64: string; frames: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#00ff00';
  g.fillRect(0, 0, 320, 180);
  g.fillStyle = '#0000ff';
  g.fillRect(112, 45, 96, 72);
  const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  const file = new File([blob], 'key.png', { type: 'image/png' });
  const media = await probeMedia(file);
  let p = createProject('fx', 320, 180, 10);
  p = { ...p, background: '#ff0000' };
  p = addMedia(p, media);
  const placed = addClip(p, media.id, 0);
  p = trimEnd(placed.project, placed.clipId!, 0.5);
  p = updateClipEffects(p, [placed.clipId!], () => parseEffects(effects));
  const options = { ...defaultExportOptions(p), videoBitrate: 800_000, includeAudio: false };
  const result = await exportMp4(p, async () => file, options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), frames: result.frames };
}

(window as unknown as { fxh: unknown }).fxh = {
  render,
  reference,
  exportFrame,
  backend: () => effectsBackend(),
};
