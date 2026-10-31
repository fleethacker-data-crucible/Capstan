import { cameraAt, cameraWindow, MAX_ZOOM, updateZoom } from '../../engine/zoom';
import type { PreviewTool } from '../previewTools';

// Animation area: drag the zoom-n-pan box on the picture (see previewTools.ts).
//
// The box is drawn through the camera, so it lines up with the picture even while the preview is
// zoomed in. It never claims presses on the picture itself (that would hide the clips under it):
// it is moved by its grip and resized by its corner handle.
export const zoomTool: PreviewTool = {
  id: 'zoom',
  overlay(ctx) {
    const { editor, time, k } = ctx;
    const project = editor.project;
    const id = editor.selection.length === 1 ? editor.selection[0] : null;
    const region = id ? project.zooms.find((z) => z.id === id) : undefined;
    if (!region) return null;
    const cam = cameraAt(project, time);
    const win = cam ? cameraWindow(cam, project) : { x: 0, y: 0, width: project.width, height: project.height };
    const s = cam ? cam.scale : 1;
    const index = project.zooms.indexOf(region) + 1;
    return (
      <div
        key="zoom-selection"
        className="selection-box zoom-box"
        aria-label={`Selected zoom region ${index}`}
        style={{ left: (region.x - win.x) * s * k, top: (region.y - win.y) * s * k, width: region.width * s * k, height: region.height * s * k }}
      >
        <button
          className="zoom-grip"
          title="Drag to move the zoom region"
          aria-label={`Move zoom region ${index}`}
          onPointerDown={(e) => {
            const p = ctx.toCanvas(e);
            const before = editor.project;
            ctx.beginDrag(e, {
              move(q) {
                editor.preview(updateZoom(before, region.id, { x: region.x + (q.x - p.x) / s, y: region.y + (q.y - p.y) / s }));
              },
              end: () => editor.commit(editor.getProject(), before),
            });
          }}
        >
          {`Zoom ${index}`}
        </button>
        <div
          className="scale-handle"
          title="Drag to resize the zoom region"
          onPointerDown={(e) => {
            const p = ctx.toCanvas(e);
            const before = editor.project;
            const aspect = region.height / region.width;
            ctx.beginDrag(e, {
              move(q) {
                // Keep the shape of the canvas: the box can only grow or shrink.
                const wanted = region.width + (q.x - p.x) / s;
                const width = Math.max(project.width / MAX_ZOOM, Math.min(wanted, project.width - region.x, (project.height - region.y) / aspect));
                editor.preview(updateZoom(before, region.id, { width, height: width * aspect }));
              },
              end: () => editor.commit(editor.getProject(), before),
            });
          }}
        />
      </div>
    );
  },
};
