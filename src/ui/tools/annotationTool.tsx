// Annotations on the picture: click one to select it, drag to move it, and use the handles on the
// selection to resize, rotate, aim a callout's tail or move the end points of an arrow or line.
// Text is edited in the inspector.
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { moveAnnotation, updateAnnotation } from '../../engine/annotationOps';
import {
  type Annotation,
  MIN_ANNOTATION_PX,
  activeAnnotationsAt,
  fromLocal,
  hitTestAnnotation,
  isLineKind,
  lineCanvas,
  lineEndsPatch,
  resolveAnnotation,
  toLocal,
} from '../../engine/annotations';
import type { Project } from '../../engine/project';
import type { PreviewTool, ToolContext } from '../previewTools';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Array<{ id: Handle; sx: -1 | 0 | 1; sy: -1 | 0 | 1; cursor: string }> = [
  { id: 'nw', sx: -1, sy: -1, cursor: 'nwse-resize' },
  { id: 'n', sx: 0, sy: -1, cursor: 'ns-resize' },
  { id: 'ne', sx: 1, sy: -1, cursor: 'nesw-resize' },
  { id: 'e', sx: 1, sy: 0, cursor: 'ew-resize' },
  { id: 'se', sx: 1, sy: 1, cursor: 'nwse-resize' },
  { id: 's', sx: 0, sy: 1, cursor: 'ns-resize' },
  { id: 'sw', sx: -1, sy: 1, cursor: 'nesw-resize' },
  { id: 'w', sx: -1, sy: 0, cursor: 'ew-resize' },
];

const LABELS: Record<Handle, string> = { nw: 'top left', n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left' };

function selectedAt(ctx: ToolContext): Annotation | undefined {
  const { editor, time } = ctx;
  if (editor.selection.length !== 1) return undefined;
  return activeAnnotationsAt(editor.project, time).find((a) => a.id === editor.selection[0]);
}

/** Starts a drag of a selection handle; `change` maps the pointer to the next project from the project as it was. */
function dragHandle(ctx: ToolContext, e: ReactPointerEvent, change: (before: Project, q: { x: number; y: number }) => Project): void {
  const before = ctx.editor.getProject();
  ctx.beginDrag(e, {
    move: (q) => ctx.editor.preview(change(before, q)),
    // A drag session outlives the render that started it: read the latest project, not the closure's.
    end: () => ctx.editor.commit(ctx.editor.getProject(), before),
  });
}

export const annotationTool: PreviewTool = {
  id: 'annotation',
  pointerDown(ctx, p) {
    const { editor, time, k } = ctx;
    const project = editor.project;
    // Later annotations are drawn on top, so they are hit first.
    const hit = [...activeAnnotationsAt(project, time)].reverse().find((a) => hitTestAnnotation(a, p, time, project, 6 / k));
    if (!hit) return null;
    editor.setSelection([hit.id]);
    const before = project;
    return {
      move(q) {
        editor.preview(moveAnnotation(before, hit.id, Math.round(q.x - p.x), Math.round(q.y - p.y)));
      },
      end: () => editor.commit(editor.getProject(), before),
    };
  },

  overlay(ctx): ReactNode {
    const { editor, time, k } = ctx;
    const a = selectedAt(ctx);
    if (!a) return null;
    const project = editor.project;
    const r = resolveAnnotation(a, time, project);
    const w = a.width * r.scale;
    const h = a.height * r.scale;
    const line = isLineKind(a.kind);
    const box = { left: (r.x - w / 2) * k, top: (r.y - h / 2) * k, width: w * k, height: h * k, transform: r.rotation ? `rotate(${r.rotation}deg)` : undefined };
    const label = `Selected ${a.kind}`;

    const resize = (e: ReactPointerEvent, sx: number, sy: number) => {
      const r0 = resolveAnnotation(a, time, project);
      dragHandle(ctx, e, (before, q) => {
        const cur = before.annotations.find((x) => x.id === a.id);
        if (!cur) return before;
        const l = toLocal(r0, q);
        const hw = cur.width / 2;
        const hh = cur.height / 2;
        let left = -hw;
        let right = hw;
        let top = -hh;
        let bottom = hh;
        if (sx < 0) left = Math.min(l.x, right - MIN_ANNOTATION_PX);
        if (sx > 0) right = Math.max(l.x, left + MIN_ANNOTATION_PX);
        if (sy < 0) top = Math.min(l.y, bottom - MIN_ANNOTATION_PX);
        if (sy > 0) bottom = Math.max(l.y, top + MIN_ANNOTATION_PX);
        const width = Math.round(right - left);
        const height = Math.round(bottom - top);
        const c = fromLocal(r0, { x: (left + right) / 2, y: (top + bottom) / 2 });
        const dx = c.x - r0.x;
        const dy = c.y - r0.y;
        // Keep the box where it was, then move it by how far its centre shifted (taking x / y keyframes along).
        const resized = updateAnnotation(before, a.id, { width, height, x: a.x + a.width / 2 - width / 2, y: a.y + a.height / 2 - height / 2 });
        return moveAnnotation(resized, a.id, Math.round(dx), Math.round(dy));
      });
    };

    const rotate = (e: ReactPointerEvent) => {
      dragHandle(ctx, e, (before, q) => {
        let deg = (Math.atan2(q.y - r.y, q.x - r.x) * 180) / Math.PI + 90;
        deg = Math.round(((deg % 360) + 540) % 360) - 180;
        for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 4) deg = snap;
        return updateAnnotation(before, a.id, { rotation: deg });
      });
    };

    const moveEnd = (e: ReactPointerEvent, which: 1 | 2) => {
      const r0 = resolveAnnotation(a, time, project);
      const ends = lineCanvas(a, r0);
      dragHandle(ctx, e, (before, q) => {
        const other = which === 1 ? { x: ends.x2, y: ends.y2 } : { x: ends.x1, y: ends.y1 };
        let x = q.x;
        let y = q.y;
        // Straight lines are easy to get: snap to the other end's row or column when close.
        const snap = 8 / k;
        if (Math.abs(x - other.x) < snap) x = other.x;
        if (Math.abs(y - other.y) < snap) y = other.y;
        const patch = which === 1 ? lineEndsPatch(x, y, other.x, other.y) : lineEndsPatch(other.x, other.y, x, y);
        return updateAnnotation(before, a.id, { ...patch, x: Math.round(patch.x), y: Math.round(patch.y), width: Math.round(patch.width), height: Math.round(patch.height) });
      });
    };

    const aimTail = (e: ReactPointerEvent) => {
      const r0 = resolveAnnotation(a, time, project);
      dragHandle(ctx, e, (before, q) => {
        const l = toLocal(r0, q);
        return updateAnnotation(before, a.id, { tail: { x: (l.x + a.width / 2) / a.width, y: (l.y + a.height / 2) / a.height } });
      });
    };

    const pct = (v: number) => `${v * 100}%`;
    return (
      <div key="annotation-selection" className={`selection-box annotation-box${line ? ' line-box' : ''}`} aria-label={label} data-annotation={a.id} style={box}>
        {!line &&
          HANDLES.map((hd) => (
            <div
              key={hd.id}
              className="ann-handle"
              data-h={hd.id}
              role="presentation"
              title={`Drag to resize (${LABELS[hd.id]})`}
              style={{ left: pct((hd.sx + 1) / 2), top: pct((hd.sy + 1) / 2), cursor: hd.cursor }}
              onPointerDown={(e) => resize(e, hd.sx, hd.sy)}
            />
          ))}
        {!line && (
          <div className="ann-handle ann-rotate" data-h="rotate" role="presentation" title="Drag to rotate" style={{ left: '50%', top: 0 }} onPointerDown={rotate} />
        )}
        {a.kind === 'callout' && (
          <div
            className="ann-handle ann-tail"
            data-h="tail"
            role="presentation"
            title="Drag to aim the tail"
            style={{ left: pct(a.tail.x), top: pct(a.tail.y) }}
            onPointerDown={aimTail}
          />
        )}
        {line && (
          <>
            <div className="ann-handle ann-end" data-h="p1" role="presentation" title="Drag the start point" style={{ left: pct(a.line.x1), top: pct(a.line.y1) }} onPointerDown={(e) => moveEnd(e, 1)} />
            <div className="ann-handle ann-end" data-h="p2" role="presentation" title={a.kind === 'arrow' ? 'Drag the arrow head' : 'Drag the end point'} style={{ left: pct(a.line.x2), top: pct(a.line.y2) }} onPointerDown={(e) => moveEnd(e, 2)} />
          </>
        )}
      </div>
    );
  },
};
