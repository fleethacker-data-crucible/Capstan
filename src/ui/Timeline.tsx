import { type DragEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { addClip, addTrack, moveClip, removeTrack, snapTime, trimEnd, trimStart, updateTrack } from '../engine/ops';
import type { Player } from '../engine/player';
import { type Clip, type Project, clipEnd, findMedia, projectDuration } from '../engine/project';
import { timecode } from './format';
import { ClipDecor } from './ClipDecor';
import { Icon } from './icons';
import { type OverlayLane, OVERLAY_LANES } from './lanes';
import type { Editor } from './useEditor';

export const MEDIA_DRAG_TYPE = 'application/x-capstan-media';
const HEADER_WIDTH = 176;
const RULER_HEIGHT = 28;
const LANE_HEIGHT = 58;
const EDGE = 7;
const SNAP_PX = 8;
const OVERLAY_HEIGHT = 32;

type Drag =
  | { kind: 'move'; clipId: string; before: Project; grab: number; startX: number; moved: boolean }
  | { kind: 'trim-start' | 'trim-end'; clipId: string; before: Project }
  | { kind: 'lane'; mode: 'move' | 'start' | 'end'; lane: OverlayLane; itemId: string; before: Project; grab: number; start: number; duration: number }
  | { kind: 'scrub' };

interface Props {
  editor: Editor;
  player: Player | null;
  time: number;
  playing: boolean;
  zoom: number;
  setZoom(z: number): void;
  snapping: boolean;
}

function tickStep(zoom: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * zoom >= 72) ?? 600;
}

export function Timeline({ editor, player, time, playing, zoom, setZoom, snapping }: Props) {
  const { project, selection, setSelection } = editor;
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string; time: number } | null>(null);
  const [viewWidth, setViewWidth] = useState(800);

  // Top track first on screen: the top lane is the top layer of the picture.
  const lanes = useMemo(() => [...project.tracks].reverse(), [project.tracks]);
  const duration = projectDuration(project);
  const contentSeconds = Math.max(duration + 30, viewWidth / zoom);
  const contentWidth = Math.ceil(contentSeconds * zoom);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth - HEADER_WIDTH));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the playhead in view during playback.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = time * zoom;
    const left = el.scrollLeft;
    const visible = el.clientWidth - HEADER_WIDTH;
    if (x < left || x > left + visible - 40) el.scrollLeft = Math.max(0, x - 80);
  }, [time, zoom, playing]);

  const toTime = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEADER_WIDTH + el.scrollLeft) / zoom);
  };

  const trackAt = (clientY: number): string | null => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const y = clientY - rect.top - RULER_HEIGHT + el.scrollTop;
    const index = Math.floor(y / LANE_HEIGHT);
    return lanes[Math.min(lanes.length - 1, Math.max(0, index))]?.id ?? null;
  };

  const snap = (t: number, ignore: Set<string>) =>
    snapping ? snapTime(editor.project, t, SNAP_PX / zoom, ignore, [time]) : t;

  const onClipPointerDown = (e: ReactPointerEvent, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - rect.left;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      setSelection(selection.includes(clip.id) ? selection.filter((s) => s !== clip.id) : [...selection, clip.id]);
    } else if (!selection.includes(clip.id)) {
      setSelection([clip.id]);
    }
    const before = editor.project;
    if (local <= EDGE) drag.current = { kind: 'trim-start', clipId: clip.id, before };
    else if (rect.width - local <= EDGE) drag.current = { kind: 'trim-end', clipId: clip.id, before };
    else drag.current = { kind: 'move', clipId: clip.id, before, grab: toTime(e.clientX) - clip.start, startX: e.clientX, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') {
      player?.seek(toTime(e.clientX));
      return;
    }
    if (d.kind === 'lane') {
      const at = toTime(e.clientX);
      const end = d.start + d.duration;
      let patch: { start?: number; duration?: number };
      if (d.mode === 'move') patch = { start: Math.max(0, snap(at - d.grab, new Set())) };
      else if (d.mode === 'start') {
        const s = Math.min(snap(at, new Set()), end - 0.05);
        patch = { start: s, duration: end - s };
      } else patch = { duration: Math.max(0.05, snap(at, new Set()) - d.start) };
      editor.preview(d.lane.update(d.before, d.itemId, patch));
      return;
    }
    const ignore = new Set([d.clipId]);
    const clip = d.before.clips.find((c) => c.id === d.clipId);
    if (!clip) return;
    if (d.kind === 'move') {
      if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
      d.moved = true;
      let start = toTime(e.clientX) - d.grab;
      const snappedStart = snap(start, ignore);
      const snappedEnd = snap(start + clip.duration, ignore);
      if (snappedStart !== start) start = snappedStart;
      else if (snappedEnd !== start + clip.duration) start = snappedEnd - clip.duration;
      editor.preview(moveClip(d.before, d.clipId, start, trackAt(e.clientY) ?? clip.trackId));
    } else if (d.kind === 'trim-start') {
      editor.preview(trimStart(d.before, d.clipId, snap(toTime(e.clientX), ignore)));
    } else {
      editor.preview(trimEnd(d.before, d.clipId, snap(toTime(e.clientX), ignore)));
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.kind !== 'scrub') editor.commit(editor.project, d.before);
  };

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!e.shiftKey) setSelection([]);
    drag.current = { kind: 'scrub' };
    player?.seek(toTime(e.clientX));
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const trackId = trackAt(e.clientY);
    if (trackId) setDropHint({ trackId, time: snap(toTime(e.clientX), new Set()) });
  };

  const onDrop = (e: DragEvent) => {
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    setDropHint(null);
    if (!mediaId) return;
    e.preventDefault();
    const trackId = trackAt(e.clientY) ?? undefined;
    const r = addClip(editor.project, mediaId, snap(toTime(e.clientX), new Set()), trackId);
    if (r.clipId) {
      editor.commit(r.project);
      setSelection([r.clipId]);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const el = scrollRef.current!;
    const at = toTime(e.clientX);
    const next = Math.min(400, Math.max(4, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    setZoom(next);
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, at * next - (e.clientX - el.getBoundingClientRect().left - HEADER_WIDTH));
    });
  };

  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= contentSeconds; t += step) ticks.push(Math.round(t * 1000) / 1000);

  return (
    <div className="timeline" aria-label="Timeline">
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDragOver={onDragOver}
        onDragLeave={() => setDropHint(null)}
        onDrop={onDrop}
      >
        <div className="timeline-grid" style={{ width: HEADER_WIDTH + contentWidth }}>
          <div className="ruler-corner">
            <button className="icon-button" title="Add track" onClick={() => editor.commit(addTrack(editor.project))}>
              <Icon name="plus" size={16} />
              <span>Track</span>
            </button>
          </div>
          <div
            className="ruler"
            style={{ width: contentWidth, height: RULER_HEIGHT }}
            onPointerDown={onBackgroundPointerDown}
          >
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: t * zoom }}>
                <span>{timecode(t)}</span>
              </div>
            ))}
          </div>

          {lanes.map((track) => (
            <TrackRow key={track.id} track={track} editor={editor} canRemove={project.tracks.length > 1}>
              <div
                className={`lane${track.locked ? ' locked' : ''}`}
                style={{ width: contentWidth, height: LANE_HEIGHT }}
                onPointerDown={onBackgroundPointerDown}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((clip) => {
                    const media = findMedia(project, clip.mediaId);
                    const selected = selection.includes(clip.id);
                    return (
                      <div
                        key={clip.id}
                        className={`clip kind-${media?.kind ?? 'video'}${selected ? ' selected' : ''}${track.hidden ? ' dim' : ''}`}
                        style={{ left: clip.start * zoom, width: Math.max(2, clip.duration * zoom) }}
                        onPointerDown={(e) => onClipPointerDown(e, clip)}
                        title={`${media?.name ?? 'Missing media'} · ${timecode(clip.duration)}`}
                        role="button"
                        aria-pressed={selected}
                        aria-label={`${media?.name ?? 'Clip'} at ${timecode(clip.start)}, ${timecode(clip.duration)} long`}
                      >
                        {media?.thumb && media.kind !== 'audio' && clip.duration * zoom > 60 && (
                          <img className="clip-thumb" src={media.thumb} alt="" draggable={false} />
                        )}
                        {media?.kind === 'audio' && <div className="clip-wave" aria-hidden />}
                        <ClipDecor editor={editor} clip={clip} media={media} zoom={zoom} />
                        <span className="clip-name">{media?.name ?? 'Missing media'}</span>
                        <span className="clip-handle start" aria-hidden />
                        <span className="clip-handle end" aria-hidden />
                      </div>
                    );
                  })}
                {dropHint?.trackId === track.id && <div className="drop-hint" style={{ left: dropHint.time * zoom }} />}
              </div>
            </TrackRow>
          ))}

          {OVERLAY_LANES.map((lane) => {
            const items = lane.items(project);
            if (!items.length) return null;
            return (
              <LaneRow key={lane.id} label={lane.label}>
                <div className="lane overlay-lane" style={{ width: contentWidth, height: OVERLAY_HEIGHT }} onPointerDown={onBackgroundPointerDown}>
                  {items.map((item) => {
                    const selected = selection.includes(item.id);
                    return (
                      <div
                        key={item.id}
                        className={`clip overlay-item kind-${lane.id}${selected ? ' selected' : ''}`}
                        style={{ left: item.start * zoom, width: Math.max(6, item.duration * zoom) }}
                        role="button"
                        aria-pressed={selected}
                        aria-label={`${lane.label}: ${item.label}, at ${timecode(item.start)}`}
                        title={`${item.label} · ${timecode(item.duration)}`}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const local = e.clientX - rect.left;
                          setSelection([item.id]);
                          const mode = local <= EDGE ? 'start' : rect.width - local <= EDGE ? 'end' : 'move';
                          drag.current = { kind: 'lane', mode, lane, itemId: item.id, before: editor.project, grab: toTime(e.clientX) - item.start, start: item.start, duration: item.duration };
                        }}
                      >
                        <span className="clip-name">{item.label}</span>
                        <span className="clip-handle start" aria-hidden />
                        <span className="clip-handle end" aria-hidden />
                      </div>
                    );
                  })}
                </div>
              </LaneRow>
            );
          })}

          <div className="playhead" style={{ left: HEADER_WIDTH + time * zoom }} aria-hidden>
            <div className="playhead-cap" />
          </div>
          {duration > 0 && <div className="end-marker" style={{ left: HEADER_WIDTH + duration * zoom }} aria-hidden />}
        </div>
      </div>
    </div>
  );
}

function LaneRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="track-header overlay-header" style={{ height: OVERLAY_HEIGHT }}>
        <span className="overlay-label">{label}</span>
      </div>
      {children}
    </>
  );
}

function TrackRow({
  track,
  editor,
  canRemove,
  children,
}: {
  track: Project['tracks'][number];
  editor: Editor;
  canRemove: boolean;
  children: React.ReactNode;
}) {
  const set = (patch: Parameters<typeof updateTrack>[2]) => editor.commit(updateTrack(editor.project, track.id, patch));
  const hasClips = editor.project.clips.some((c) => c.trackId === track.id);
  return (
    <>
      <div className="track-header" style={{ height: LANE_HEIGHT }}>
        <input
          className="track-name"
          value={track.name}
          aria-label="Track name"
          onChange={(e) => set({ name: e.target.value.slice(0, 60) })}
        />
        <div className="track-buttons">
          <button
            className={`icon-button small${track.hidden ? ' on' : ''}`}
            title={track.hidden ? 'Show track' : 'Hide track'}
            aria-pressed={track.hidden}
            onClick={() => set({ hidden: !track.hidden })}
          >
            <Icon name={track.hidden ? 'eyeOff' : 'eye'} />
          </button>
          <button
            className={`icon-button small${track.muted ? ' on' : ''}`}
            title={track.muted ? 'Unmute track' : 'Mute track'}
            aria-pressed={track.muted}
            onClick={() => set({ muted: !track.muted })}
          >
            <Icon name={track.muted ? 'speakerOff' : 'speaker'} />
          </button>
          <button
            className={`icon-button small${track.locked ? ' on' : ''}`}
            title={track.locked ? 'Unlock track' : 'Lock track'}
            aria-pressed={track.locked}
            onClick={() => set({ locked: !track.locked })}
          >
            <Icon name={track.locked ? 'lock' : 'unlock'} />
          </button>
          {canRemove && (
            <button
              className="icon-button small"
              title={hasClips ? 'Remove track and its clips' : 'Remove track'}
              onClick={() => {
                if (hasClips && !window.confirm(`Remove ${track.name} and its clips?`)) return;
                editor.commit(removeTrack(editor.project, track.id));
              }}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
      {children}
    </>
  );
}

export function clipsUnderPlayhead(project: Project, time: number): Clip[] {
  return project.clips.filter((c) => time >= c.start && time < clipEnd(c));
}
