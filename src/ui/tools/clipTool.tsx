import { clipRect } from '../../engine/compositor';
import { keyedProps, updateClipPropsAt } from '../../engine/animate';
import { activeClipsAt, findMedia } from '../../engine/project';
import type { PreviewTool } from '../previewTools';

export const clipTool: PreviewTool = {
  id: 'clip',
  pointerDown(ctx, p) {
    const { editor, time, k } = ctx;
    const project = editor.project;
    const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
    const hit = activeClipsAt(project, time)
      .filter((c) => !hidden.has(c.trackId) && findMedia(project, c.mediaId)?.kind !== 'audio')
      .reverse()
      .find((c) => {
        const r = clipRect(project, c, time);
        return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
      });
    if (!hit) return null;
    editor.setSelection([hit.id]);
    if (project.tracks.find((t) => t.id === hit.trackId)?.locked) return 'handled';
    const before = project;
    const start = { x: p.x, y: p.y };
    return {
      move(q) {
        const clip = before.clips.find((c) => c.id === hit.id)!;
        const shown = keyedProps(clip, time);
        let x = shown.x + (q.x - start.x);
        let y = shown.y + (q.y - start.y);
        // Snap the centre to the canvas centre lines.
        const snap = 10 / k;
        if (Math.abs(x - project.width / 2) < snap) x = project.width / 2;
        if (Math.abs(y - project.height / 2) < snap) y = project.height / 2;
        editor.preview(updateClipPropsAt(before, hit.id, { x: Math.round(x), y: Math.round(y) }, time));
      },
      end: () => editor.commit(editor.getProject(), before),
    };
  },
  overlay(ctx) {
    const { editor, time, k } = ctx;
    const project = editor.project;
    const id = editor.selection.length === 1 ? editor.selection[0] : null;
    const selected = id ? project.clips.find((c) => c.id === id) : undefined;
    if (!selected || time < selected.start || time >= selected.start + selected.duration || findMedia(project, selected.mediaId)?.kind === 'audio') return null;
    const rect = clipRect(project, selected, time);
    const props = keyedProps(selected, time);
    return (
      <div
        key="clip-selection"
        className="selection-box"
        style={{ left: rect.x * k, top: rect.y * k, width: rect.width * k, height: rect.height * k, transform: props.rotation ? `rotate(${props.rotation}deg)` : undefined }}
      >
        <div
          className="scale-handle"
          title="Drag to resize"
          onPointerDown={(e) => {
            const p = ctx.toCanvas(e);
            const before = editor.project;
            const startScale = props.scale;
            const startDist = Math.hypot(p.x - props.x, p.y - props.y);
            ctx.beginDrag(e, {
              move(q) {
                const dist = Math.hypot(q.x - props.x, q.y - props.y);
                const scale = Math.max(0.02, (startScale * dist) / Math.max(1, startDist));
                editor.preview(updateClipPropsAt(before, selected.id, { scale: Math.round(scale * 1000) / 1000 }, time));
              },
              end: () => editor.commit(editor.getProject(), before),
            });
          }}
        />
      </div>
    );
  },
};
