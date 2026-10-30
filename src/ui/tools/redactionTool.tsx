import { updateRedaction } from '../../engine/ops';
import { activeRedactionsAt } from '../../engine/project';
import type { PreviewTool } from '../previewTools';

export const redactionTool: PreviewTool = {
  id: 'redaction',
  pointerDown(ctx, p) {
    const { editor, time } = ctx;
    const project = editor.project;
    // Blur regions sit above every track, so they are hit first (the most recently added on top).
    const region = activeRedactionsAt(project, time)
      .reverse()
      .find((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
    if (!region) return null;
    editor.setSelection([region.id]);
    const before = project;
    return {
      move(q) {
        editor.preview(updateRedaction(before, region.id, { x: region.x + Math.round(q.x - p.x), y: region.y + Math.round(q.y - p.y) }));
      },
      end: () => editor.commit(editor.getProject(), before),
    };
  },
  overlay(ctx) {
    const { editor, time, k } = ctx;
    const id = editor.selection.length === 1 ? editor.selection[0] : null;
    const region = id ? activeRedactionsAt(editor.project, time).find((r) => r.id === id) : undefined;
    if (!region) return null;
    return (
      <div key="region-selection" className="selection-box region-box" aria-label="Selected blur region" style={{ left: region.x * k, top: region.y * k, width: region.width * k, height: region.height * k }}>
        <div
          className="scale-handle"
          title="Drag to resize the blur region"
          onPointerDown={(e) => {
            const p = ctx.toCanvas(e);
            const before = editor.project;
            ctx.beginDrag(e, {
              move(q) {
                editor.preview(updateRedaction(before, region.id, { width: region.width + Math.round(q.x - p.x), height: region.height + Math.round(q.y - p.y) }));
              },
              end: () => editor.commit(editor.getProject(), before),
            });
          }}
        />
      </div>
    );
  },
};
