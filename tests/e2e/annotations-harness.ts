// Browser-side harness for the annotations e2e: draws annotations with the compositor onto an
// OffscreenCanvas (the surface export uses) and onto a normal canvas, and runs a tiny real export.
// Built by tests/e2e/annotations.e2e.mjs; served in place of the shared harness.js.
import { addAnnotation, updateAnnotation } from '../../src/engine/annotationOps';
import { drawFrame } from '../../src/engine/compositor';
import { defaultExportOptions, exportMp4 } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia } from '../../src/engine/ops';
import { type Project, createProject } from '../../src/engine/project';

type Px = [number, number, number];

declare global {
  interface Window {
    annRender: (time: number) => { off: Px[]; dom: Px[]; points: Array<[number, number]> };
    annExport: () => Promise<{ base64: string; width: number; height: number }>;
  }
}

/** White 320x180 with a green rectangle, a yellow highlight, a spotlight and a half-drawn arrow. */
function scene(): Project {
  let p = createProject('ann-harness', 320, 180, 10);
  p = { ...p, background: '#ffffff' };
  let r = addAnnotation(p, 'rect', 0, { x: 20, y: 20, width: 80, height: 60, style: { fill: '#00ff00', fillAlpha: 1, stroke: '', strokeWidth: 0, radius: 0 } });
  p = r.project;
  r = addAnnotation(p, 'highlight', 0, { x: 200, y: 20, width: 80, height: 40, style: { fill: '#ffe14a', fillAlpha: 0.35, radius: 0 } });
  p = r.project;
  // The spotlight lights a box on the lower half; everything else is dimmed to 35%.
  r = addAnnotation(p, 'spotlight', 2, { x: 100, y: 100, width: 120, height: 60, shape: 'rect', style: { dim: 0.65, feather: 0, radius: 0, fill: '#000000' } });
  p = r.project;
  // An arrow that takes 2 s to draw on, from (20, 170) to (300, 170).
  r = addAnnotation(p, 'arrow', 4, {
    x: 20,
    y: 168,
    width: 280,
    height: 4,
    sketch: 2,
    line: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
    style: { stroke: '#ff0000', strokeWidth: 6 },
  });
  p = updateAnnotation(r.project, r.id, { duration: 3 });
  return p;
}

const POINTS: Array<[number, number]> = [
  [60, 50], // inside the green rectangle
  [250, 40], // inside the highlight
  [10, 10], // far corner, outside everything
  [160, 130], // inside the spotlight box
  [40, 170], // near the start of the arrow
  [280, 170], // near the far end of the arrow
];

window.annRender = (time) => {
  const p = scene();
  const sample = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Px[] =>
    POINTS.map(([x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]] as Px;
    });
  const off = new OffscreenCanvas(p.width, p.height);
  const octx = off.getContext('2d')!;
  drawFrame(octx, p, time, () => null);
  const dom = document.createElement('canvas');
  dom.width = p.width;
  dom.height = p.height;
  const dctx = dom.getContext('2d')!;
  drawFrame(dctx, p, time, () => null);
  return { off: sample(octx), dom: sample(dctx), points: POINTS };
};

window.annExport = async () => {
  const res = await fetch('/fixtures/card.png');
  const blob = await res.blob();
  const file = new File([blob], 'card.png', { type: 'image/png' });
  const media = await probeMedia(file);
  let p = createProject('ann-export', 320, 180, 10);
  p = addMedia(p, media);
  p = addClip(p, media.id, 0, p.tracks[0].id).project;
  // Clip is 5 s long (image default); an opaque red rectangle on the left third for the first second.
  p = addAnnotation(p, 'rect', 0, { x: 20, y: 40, width: 80, height: 100, duration: 5, style: { fill: '#ff0000', fillAlpha: 1, stroke: '', strokeWidth: 0, radius: 0 } }).project;
  p = { ...p, clips: p.clips.map((c) => ({ ...c, duration: 1 })) };
  const options = { ...defaultExportOptions(p), videoBitrate: 1_000_000, includeAudio: false };
  const result = await exportMp4(p, async () => file, options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), width: p.width, height: p.height };
};
document.title = 'harness-ready';
