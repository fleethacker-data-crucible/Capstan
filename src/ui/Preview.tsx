import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Player } from '../engine/player';
import type { DragSession, ToolContext } from './previewTools';
import { PREVIEW_TOOLS } from './tools';
import type { Editor } from './useEditor';

interface Props {
  editor: Editor;
  time: number;
  onPlayer(player: Player | null): void;
}

export function Preview({ editor, time, onPlayer }: Props) {
  const { project, sources, sourcesVersion } = editor;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const drag = useRef<DragSession | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const player = new Player(canvasRef.current!, editor.project, sources);
    playerRef.current = player;
    onPlayer(player);
    return () => {
      player.destroy();
      playerRef.current = null;
      onPlayer(null);
    };
    // The player lives for the whole session; project updates arrive through setProject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    playerRef.current?.setProject(project);
  }, [project, sourcesVersion]);

  // Fit the canvas inside the stage at the project's aspect ratio.
  useLayoutEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const pad = 24;
      const w = Math.max(10, stage.clientWidth - pad * 2);
      const h = Math.max(10, stage.clientHeight - pad * 2);
      const k = Math.min(w / project.width, h / project.height);
      setBox({ width: Math.floor(project.width * k), height: Math.floor(project.height * k) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  const k = box.width / project.width || 1;

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const beginDrag = (e: ReactPointerEvent, session: DragSession) => {
    e.stopPropagation();
    frameRef.current?.setPointerCapture(e.pointerId);
    drag.current = session;
  };

  const ctx: ToolContext = { editor, time, k, toCanvas, beginDrag };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const p = toCanvas(e);
    for (const tool of PREVIEW_TOOLS) {
      const claimed = tool.pointerDown?.(ctx, p);
      if (!claimed) continue;
      if (claimed !== 'handled') beginDrag(e, claimed);
      return;
    }
    editor.setSelection([]);
  };

  const onPointerMove = (e: ReactPointerEvent) => drag.current?.move(toCanvas(e));

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    d?.end();
  };

  const empty = project.clips.length === 0;

  return (
    <div className="stage" ref={stageRef}>
      <div
        ref={frameRef}
        className="canvas-frame"
        style={{ width: box.width, height: box.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="preview-canvas" aria-label="Video preview" />
        {PREVIEW_TOOLS.map((tool) => tool.overlay?.(ctx))}
        {empty && (
          <div className="stage-empty">
            <p>Record your screen or import media, then drag it onto the timeline.</p>
          </div>
        )}
      </div>
    </div>
  );
}
