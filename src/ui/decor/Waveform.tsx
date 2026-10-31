import { type PointerEvent as ReactPointerEvent, type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addVolumePoint, moveVolumePoint, removeVolumePoint } from '../../engine/audioops';
import { fadeGain, volumeAt } from '../../engine/gain';
import { type Peaks, getPeaks, peakWindow } from '../../engine/peaks';
import { sourceTimeAt } from '../../engine/project';
import type { ClipDecorProps } from '../ClipDecor';

// Audio area: the waveform of the clip audio, scaled to the clip's source window and speed, and the volume line
// (volume points and fades) drawn over it. The points of a selected clip can be dragged; Alt-click the line to add
// a point and double-click a point to remove it. The Inspector lists the same points for keyboard use.

const MAX_CANVAS_WIDTH = 4096;
const WAVE_HEIGHT = 48;
const POINT_INSET = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Volume 0..2 maps to the clip's height with 1 (unchanged) in the middle. */
const yOf = (v: number, h: number) => (1 - clamp(v, 0, 2) / 2) * h;

export function Waveform({ editor, clip, media, zoom }: ClipDecorProps): ReactElement | null {
  const hasAudio = !!media && media.kind !== 'image' && media.hasAudio;
  const mediaId = media?.id;
  const mediaDuration = media?.duration ?? 0;
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [height, setHeight] = useState(50);
  const selected = editor.selection.includes(clip.id);
  const sourcesVersion = editor.sourcesVersion;

  useEffect(() => {
    if (!hasAudio || !mediaId) return;
    let live = true;
    void getPeaks(mediaId, mediaDuration, () => editor.sources.blob(mediaId)).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [hasAudio, mediaId, mediaDuration, editor.sources, sourcesVersion]);

  const silent = !!clip.freeze || !!clip.audio?.silent;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !peaks) return;
    const w = clamp(Math.round(clip.duration * zoom), 1, MAX_CANVAS_WIDTH);
    el.width = w;
    el.height = WAVE_HEIGHT;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, WAVE_HEIGHT);
    ctx.fillStyle = getComputedStyle(el).color;
    const mid = WAVE_HEIGHT / 2;
    if (silent) {
      ctx.fillRect(0, mid, w, 1);
      return;
    }
    for (let x = 0; x < w; x++) {
      const a = sourceTimeAt(clip, clip.start + (x / w) * clip.duration);
      const b = sourceTimeAt(clip, clip.start + ((x + 1) / w) * clip.duration);
      const [lo, hi] = peakWindow(peaks, Math.min(a, b), Math.max(a, b));
      const top = mid - Math.min(1, hi) * mid;
      const bottom = mid - Math.max(-1, lo) * mid;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks, zoom, silent, clip.start, clip.in, clip.duration, clip.speed, clip.freeze]);

  useLayoutEffect(() => {
    const h = svg.current?.clientHeight;
    if (h && h !== height) setHeight(h);
  });

  if (!hasAudio) return null;

  const keys = clip.keys?.volume ?? [];
  const shaped = keys.length > 0 || !!clip.audio?.fadeIn || !!clip.audio?.fadeOut || clip.props.volume !== 1;
  const width = Math.max(1, clip.duration * zoom);
  const showLine = (selected || shaped) && width > 24 && !silent;

  // The volume line: the Volume slider or points, with the fades applied.
  const steps = clamp(Math.round(width / 4), 2, 240);
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * clip.duration;
    const g = volumeAt(clip, t) * fadeGain(clip.audio, clip.duration, t);
    d += `${i === 0 ? 'M' : 'L'}${((i / steps) * width).toFixed(1)} ${yOf(g, height).toFixed(1)} `;
  }

  const pointer = (e: { clientX: number; clientY: number }) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return { t: 0, v: 1 };
    const v = (1 - (e.clientY - rect.top) / Math.max(1, rect.height)) * 2;
    return { t: clamp((e.clientX - rect.left) / zoom, 0, clip.duration), v: Math.abs(v - 1) < 0.04 ? 1 : Math.round(clamp(v, 0, 2) * 100) / 100 };
  };

  const startDrag = (e: ReactPointerEvent<SVGCircleElement>, t0: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const before = editor.getProject();
    let at = t0;
    const move = (ev: PointerEvent) => {
      const p = pointer(ev);
      editor.preview(moveVolumePoint(editor.getProject(), clip.id, at, p.t, p.v));
      at = p.t;
    };
    const done = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', done);
      target.removeEventListener('pointercancel', done);
      editor.commit(editor.getProject(), before);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', done);
    target.addEventListener('pointercancel', done);
  };

  return (
    <>
      <canvas ref={canvas} className={`clip-waveform${media?.kind === 'video' ? ' over-video' : ''}`} aria-hidden />
      {showLine && (
        <svg ref={svg} className="clip-volume" width={width} height="100%" aria-label={`Volume line for ${media?.name ?? 'clip'}`}>
          {selected && <line className="unity" x1={0} x2={width} y1={yOf(1, height)} y2={yOf(1, height)} />}
          <path className="line" d={d} />
          {selected && (
            <path
              className="hit"
              d={d}
              onPointerDown={(e) => {
                // Alt-click adds a point; a plain press falls through so the clip can still be dragged.
                if (!e.altKey || e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();
                const p = pointer(e);
                const project = editor.getProject();
                editor.commit(addVolumePoint(project, clip.id, p.t, volumeAt(clip, p.t)), project);
              }}
            />
          )}
          {selected &&
            keys.map((k, i) => (
              <circle
                key={i}
                className="point"
                cx={clamp(k.t * zoom, POINT_INSET, Math.max(POINT_INSET, width - POINT_INSET))}
                cy={yOf(k.v, height)}
                r={5}
                role="img"
                aria-label={`Volume point ${Math.round(k.v * 100)} percent at ${k.t.toFixed(2)} seconds`}
                onPointerDown={(e) => startDrag(e, k.t)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const project = editor.getProject();
                  editor.commit(removeVolumePoint(project, clip.id, k.t), project);
                }}
              />
            ))}
        </svg>
      )}
    </>
  );
}
