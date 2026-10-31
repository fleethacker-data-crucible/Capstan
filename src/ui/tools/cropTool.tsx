import { type CropHandle, dragCrop, setClipCrop } from '../../engine/editops';
import { clipRect } from '../../engine/compositor';
import { type Clip, type Crop, findMedia } from '../../engine/project';
import { cropMode } from '../cropMode';
import type { Point, PreviewTool, ToolContext } from '../previewTools';

// Editing area: the crop frame on the selected clip (see previewTools.ts). While crop mode is on the
// preview shows the whole frame (see useCropView), and this tool draws the crop rectangle over it
// with eight handles. Dragging inside the rectangle moves it.

const FULL: Crop = { x: 0, y: 0, width: 1, height: 1 };

const HANDLES: Array<{ id: string; hx: CropHandle['hx']; hy: CropHandle['hy']; cursor: string }> = [
  { id: 'nw', hx: -1, hy: -1, cursor: 'nwse-resize' },
  { id: 'n', hx: 0, hy: -1, cursor: 'ns-resize' },
  { id: 'ne', hx: 1, hy: -1, cursor: 'nesw-resize' },
  { id: 'e', hx: 1, hy: 0, cursor: 'ew-resize' },
  { id: 'se', hx: 1, hy: 1, cursor: 'nwse-resize' },
  { id: 's', hx: 0, hy: 1, cursor: 'ns-resize' },
  { id: 'sw', hx: -1, hy: 1, cursor: 'nesw-resize' },
  { id: 'w', hx: -1, hy: 0, cursor: 'ew-resize' },
];

/** The clip being cropped, when crop mode is on and it is the single selected clip. */
function target(ctx: ToolContext): Clip | undefined {
  const id = cropMode.activeFor(ctx.editor.selection);
  return id ? ctx.editor.project.clips.find((c) => c.id === id) : undefined;
}

/** Where the whole (uncropped) frame sits on the canvas. */
function frameRect(ctx: ToolContext, clip: Clip) {
  const { crop: _crop, ...whole } = clip;
  return clipRect(ctx.editor.project, whole as Clip, ctx.time);
}

/** Canvas-space movement turned into fractions of the frame, undoing the clip's rotation. */
function toFractions(clip: Clip, rect: { width: number; height: number }, dx: number, dy: number) {
  const a = (-(clip.props.rotation || 0) * Math.PI) / 180;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return { fx: lx / Math.max(1, rect.width), fy: ly / Math.max(1, rect.height) };
}

function cropDrag(ctx: ToolContext, clip: Clip, handle: CropHandle, from: Point) {
  const { editor } = ctx;
  const before = editor.getProject();
  const rect = frameRect(ctx, clip);
  const media = findMedia(before, clip.mediaId);
  const start = before.clips.find((c) => c.id === clip.id)?.crop ?? FULL;
  const frame = media ?? { width: 16, height: 9 };
  return {
    move(q: Point) {
      const { fx, fy } = toFractions(clip, rect, q.x - from.x, q.y - from.y);
      const aspect = cropMode.get().aspect ?? undefined;
      editor.preview(setClipCrop(before, clip.id, dragCrop(start, handle, fx, fy, frame, aspect)));
    },
    end: () => editor.commit(editor.getProject(), before),
  };
}

function inside(ctx: ToolContext, clip: Clip, p: Point): boolean {
  // Test in the clip's own (unrotated) space around its centre.
  const rect = frameRect(ctx, clip);
  const a = (-(clip.props.rotation || 0) * Math.PI) / 180;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a) + rect.width / 2;
  const ly = dx * Math.sin(a) + dy * Math.cos(a) + rect.height / 2;
  const c = clip.crop ?? FULL;
  return lx >= c.x * rect.width && lx <= (c.x + c.width) * rect.width && ly >= c.y * rect.height && ly <= (c.y + c.height) * rect.height;
}

export const cropTool: PreviewTool = {
  id: 'crop',
  pointerDown(ctx, p) {
    const clip = target(ctx);
    if (!clip) return null;
    // While cropping, presses on the picture belong to the crop frame: drag inside it to move it.
    if (inside(ctx, clip, p)) return cropDrag(ctx, clip, { hx: 0, hy: 0 }, p);
    return 'handled';
  },
  overlay(ctx) {
    const clip = target(ctx);
    if (!clip || ctx.time < clip.start || ctx.time >= clip.start + clip.duration) return null;
    const media = findMedia(ctx.editor.project, clip.mediaId);
    if (!media || media.kind === 'audio' || clip.audioOnly) return null;
    const { k } = ctx;
    const rect = frameRect(ctx, clip);
    const c = clip.crop ?? FULL;
    const pct = (v: number) => `${v * 100}%`;
    return (
      <div
        key="crop-overlay"
        className="crop-overlay"
        aria-label="Crop frame"
        style={{ left: rect.x * k, top: rect.y * k, width: rect.width * k, height: rect.height * k, transform: clip.props.rotation ? `rotate(${clip.props.rotation}deg)` : undefined }}
      >
        <div className="crop-dim" style={{ left: 0, top: 0, right: 0, height: pct(c.y) }} />
        <div className="crop-dim" style={{ left: 0, bottom: 0, right: 0, height: pct(1 - c.y - c.height) }} />
        <div className="crop-dim" style={{ left: 0, top: pct(c.y), width: pct(c.x), height: pct(c.height) }} />
        <div className="crop-dim" style={{ right: 0, top: pct(c.y), width: pct(1 - c.x - c.width), height: pct(c.height) }} />
        <div className="crop-box" style={{ left: pct(c.x), top: pct(c.y), width: pct(c.width), height: pct(c.height) }}>
          {HANDLES.map((h) => (
            <div
              key={h.id}
              className={`crop-handle crop-handle-${h.id}`}
              role="button"
              aria-label={`Crop handle ${h.id}`}
              title="Drag to crop (or use the numbers in the inspector)"
              style={{ cursor: h.cursor }}
              onPointerDown={(e) => {
                const from = ctx.toCanvas(e);
                ctx.beginDrag(e, cropDrag(ctx, clip, h, from));
              }}
            />
          ))}
        </div>
      </div>
    );
  },
};
