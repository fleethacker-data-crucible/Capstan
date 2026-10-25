import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clipRect } from '../engine/compositor';
import { updateClipProps } from '../engine/ops';
import { Player } from '../engine/player';
import { type Project, activeClipsAt, findMedia } from '../engine/project';
import type { Editor } from './useEditor';

interface Props {
  editor: Editor;
  time: number;
  onPlayer(player: Player | null): void;
}

type Drag = { kind: 'move' | 'scale'; clipId: string; before: Project; x: number; y: number; startScale: number; startDist: number };

export function Preview({ editor, time, onPlayer }: Props) {
  const { project, sources, sourcesVersion } = editor;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const drag = useRef<Drag | null>(null);
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
  const selectedId = editor.selection.length === 1 ? editor.selection[0] : null;
  const selected = selectedId ? project.clips.find((c) => c.id === selectedId) : undefined;
  const selectedVisible =
    selected && time >= selected.start && time < selected.start + selected.duration && findMedia(project, selected.mediaId)?.kind !== 'audio';

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const p = toCanvas(e);
    // Topmost visible clip under the pointer.
    const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
    const hit = activeClipsAt(project, time)
      .filter((c) => !hidden.has(c.trackId) && findMedia(project, c.mediaId)?.kind !== 'audio')
      .reverse()
      .find((c) => {
        const r = clipRect(project, c);
        return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
      });
    if (!hit) {
      editor.setSelection([]);
      return;
    }
    editor.setSelection([hit.id]);
    if (project.tracks.find((t) => t.id === hit.trackId)?.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'move', clipId: hit.id, before: project, x: p.x, y: p.y, startScale: hit.props.scale, startDist: 0 };
  };

  const onHandleDown = (e: ReactPointerEvent) => {
    if (!selected) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    const dist = Math.hypot(p.x - selected.props.x, p.y - selected.props.y);
    drag.current = { kind: 'scale', clipId: selected.id, before: project, x: p.x, y: p.y, startScale: selected.props.scale, startDist: dist };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    const clip = d.before.clips.find((c) => c.id === d.clipId)!;
    if (d.kind === 'move') {
      let x = clip.props.x + (p.x - d.x);
      let y = clip.props.y + (p.y - d.y);
      // Snap the centre to the canvas centre lines.
      const snap = 10 / k;
      if (Math.abs(x - project.width / 2) < snap) x = project.width / 2;
      if (Math.abs(y - project.height / 2) < snap) y = project.height / 2;
      editor.preview(updateClipProps(d.before, d.clipId, { x: Math.round(x), y: Math.round(y) }));
    } else {
      const dist = Math.hypot(p.x - clip.props.x, p.y - clip.props.y);
      const scale = Math.max(0.02, (d.startScale * dist) / Math.max(1, d.startDist));
      editor.preview(updateClipProps(d.before, d.clipId, { scale: Math.round(scale * 1000) / 1000 }));
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) editor.commit(editor.project, d.before);
  };

  const rect = selected && selectedVisible ? clipRect(project, selected) : null;
  const empty = project.clips.length === 0;

  return (
    <div className="stage" ref={stageRef}>
      <div
        className="canvas-frame"
        style={{ width: box.width, height: box.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasRef} className="preview-canvas" aria-label="Video preview" />
        {rect && selected && (
          <div
            className="selection-box"
            style={{
              left: rect.x * k,
              top: rect.y * k,
              width: rect.width * k,
              height: rect.height * k,
              transform: selected.props.rotation ? `rotate(${selected.props.rotation}deg)` : undefined,
            }}
          >
            <div className="scale-handle" onPointerDown={onHandleDown} title="Drag to resize" />
          </div>
        )}
        {empty && (
          <div className="stage-empty">
            <p>Record your screen or import media, then drag it onto the timeline.</p>
          </div>
        )}
      </div>
    </div>
  );
}
