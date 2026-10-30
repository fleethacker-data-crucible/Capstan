import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clipRect } from '../engine/compositor';
import { updateClipProps, updateRedaction } from '../engine/ops';
import { Player } from '../engine/player';
import { type Project, type Redaction, activeClipsAt, activeRedactionsAt, findMedia } from '../engine/project';
import type { Editor } from './useEditor';

interface Props {
  editor: Editor;
  time: number;
  onPlayer(player: Player | null): void;
}

type Drag =
  | { kind: 'move' | 'scale'; clipId: string; before: Project; x: number; y: number; startScale: number; startDist: number }
  | { kind: 'region-move' | 'region-size'; region: Redaction; before: Project; x: number; y: number };

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

  const selectedRegion = selectedId ? activeRedactionsAt(project, time).find((r) => r.id === selectedId) : undefined;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const p = toCanvas(e);
    // Blur regions sit above every track, so they are hit first (the most recently added on top).
    const region = activeRedactionsAt(project, time)
      .reverse()
      .find((r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
    if (region) {
      editor.setSelection([region.id]);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { kind: 'region-move', region, before: project, x: p.x, y: p.y };
      return;
    }
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

  const onRegionHandleDown = (e: ReactPointerEvent) => {
    if (!selectedRegion) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    drag.current = { kind: 'region-size', region: selectedRegion, before: project, x: p.x, y: p.y };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    if (d.kind === 'region-move' || d.kind === 'region-size') {
      const dx = Math.round(p.x - d.x);
      const dy = Math.round(p.y - d.y);
      const r = d.region;
      const patch = d.kind === 'region-move' ? { x: r.x + dx, y: r.y + dy } : { width: r.width + dx, height: r.height + dy };
      editor.preview(updateRedaction(d.before, r.id, patch));
      return;
    }
    const cd = d as Extract<Drag, { clipId: string }>;
    const clip = cd.before.clips.find((c) => c.id === cd.clipId)!;
    if (cd.kind === 'move') {
      let x = clip.props.x + (p.x - cd.x);
      let y = clip.props.y + (p.y - cd.y);
      // Snap the centre to the canvas centre lines.
      const snap = 10 / k;
      if (Math.abs(x - project.width / 2) < snap) x = project.width / 2;
      if (Math.abs(y - project.height / 2) < snap) y = project.height / 2;
      editor.preview(updateClipProps(cd.before, cd.clipId, { x: Math.round(x), y: Math.round(y) }));
    } else {
      const dist = Math.hypot(p.x - clip.props.x, p.y - clip.props.y);
      const scale = Math.max(0.02, (cd.startScale * dist) / Math.max(1, cd.startDist));
      editor.preview(updateClipProps(cd.before, cd.clipId, { scale: Math.round(scale * 1000) / 1000 }));
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
        {selectedRegion && (
          <div
            className="selection-box region-box"
            aria-label="Selected blur region"
            style={{ left: selectedRegion.x * k, top: selectedRegion.y * k, width: selectedRegion.width * k, height: selectedRegion.height * k }}
          >
            <div className="scale-handle" onPointerDown={onRegionHandleDown} title="Drag to resize the blur region" />
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
