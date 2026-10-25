// Draws one frame of the timeline onto a 2D canvas. Used by both preview and export, so
// what you see is exactly what gets encoded.
import { type Clip, type Project, activeClipsAt, findMedia } from './project';

export type FrameSource = CanvasImageSource & { readonly width?: number; readonly height?: number };

export interface SourceSize {
  width: number;
  height: number;
}

/** Size of a clip on the canvas at scale 1: the media fitted inside the canvas, aspect kept. */
export function fittedSize(media: SourceSize, canvas: SourceSize): SourceSize {
  if (media.width <= 0 || media.height <= 0) return { width: canvas.width, height: canvas.height };
  const k = Math.min(canvas.width / media.width, canvas.height / media.height);
  return { width: media.width * k, height: media.height * k };
}

/** The clip's on-canvas rectangle before rotation, centred on props.x / props.y. */
export function clipRect(project: Project, clip: Clip): { x: number; y: number; width: number; height: number } {
  const media = findMedia(project, clip.mediaId);
  const base = fittedSize(media ?? project, project);
  const width = base.width * clip.props.scale;
  const height = base.height * clip.props.scale;
  return { x: clip.props.x - width / 2, y: clip.props.y - height / 2, width, height };
}

export type SourceLookup = (clip: Clip) => CanvasImageSource | null;

export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  project: Project,
  time: number,
  lookup: SourceLookup,
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  for (const clip of activeClipsAt(project, time)) {
    if (hidden.has(clip.trackId)) continue;
    const media = findMedia(project, clip.mediaId);
    if (!media || media.kind === 'audio') continue;
    const source = lookup(clip);
    if (!source) continue;
    const r = clipRect(project, clip);
    ctx.save();
    ctx.globalAlpha = clip.props.opacity;
    ctx.translate(clip.props.x, clip.props.y);
    if (clip.props.rotation) ctx.rotate((clip.props.rotation * Math.PI) / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, -r.width / 2, -r.height / 2, r.width, r.height);
    ctx.restore();
  }
  ctx.restore();
}
