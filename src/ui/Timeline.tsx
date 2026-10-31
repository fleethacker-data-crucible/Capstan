import { type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { bundleIds, closeGaps, expandSelection, magnetize, moveClips, removeGapAt, setTrackMagnetic, trackGaps, trimBundle } from '../engine/editops';
import { moveMarker } from '../engine/markers';
import { addClip, addTrack, moveClip, removeTrack, snapTime, updateTrack } from '../engine/ops';
import type { Player } from '../engine/player';
import { MIN_RANGE_SECONDS, makeRange, setRange } from '../engine/range';
import { type Clip, type Project, clipEnd, findMedia, projectDuration } from '../engine/project';
import { timecode } from './format';
import { ClipDecor } from './ClipDecor';
import { editNotes } from './decor/EditBadges';
import { EditIcon } from './editIcons';
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
  | { kind: 'move'; clipId: string; ids: string[]; before: Project; grab: number; startX: number; moved: boolean }
  | { kind: 'trim-start' | 'trim-end'; clipId: string; before: Project }
  | { kind: 'lane'; mode: 'move' | 'start' | 'end'; lane: OverlayLane; itemId: string; before: Project; grab: number; start: number; duration: number }
  | { kind: 'marker'; id: string; before: Project; grab: number }
  | { kind: 'range'; anchor: number; before: Project }
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

  // One clip is the tab stop (the first selected one, else the first in time), so Tab enters and leaves the
  // timeline in one step and the arrow keys move around inside it.
  const clipsByTime = [...project.clips].sort((a, b) => a.start - b.start);
  const tabStop = project.clips.find((c) => selection.includes(c.id))?.id ?? clipsByTime[0]?.id;
  const focusClip = (id: string) => scrollRef.current?.querySelector<HTMLElement>(`[data-clip-id="${id}"]`)?.focus();
  const goTo = (target: Clip | undefined) => {
    if (!target) return;
    setSelection(expandSelection(editor.project, [target.id]));
    focusClip(target.id);
  };

  /**
   * Keyboard for a clip. Enter or Space selects it (Shift or Ctrl adds to the selection); the arrow keys move to
   * the neighbouring clip, Up and Down to the lane above or below; Alt with an arrow moves the clip itself by one
   * frame (Shift: one second) or to the next lane. Everything else (S, Delete, Ctrl+C and so on) reaches the
   * editor shortcuts.
   */
  const onClipKeyDown = (e: ReactKeyboardEvent, clip: Clip) => {
    if (e.target !== e.currentTarget) return;
    const used = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const mine = clipsByTime.filter((c) => c.trackId === clip.trackId);
    const at = mine.findIndex((c) => c.id === clip.id);
    const laneIndex = lanes.findIndex((l) => l.id === clip.trackId);
    if (e.key === 'Enter' || e.key === ' ') {
      used();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const group = expandSelection(editor.project, [clip.id]);
        setSelection(selection.includes(clip.id) ? selection.filter((s) => !group.includes(s)) : [...new Set([...selection, ...group])]);
      } else setSelection(expandSelection(editor.project, [clip.id]));
      return;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      used();
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / project.fps);
      const next = moveClip(editor.project, clip.id, Math.max(0, clip.start + delta));
      if (next === editor.project) editor.setStatus('The clip cannot move that way: another clip is in the way.');
      else {
        editor.commit(magnetize(next));
        editor.setStatus(`${findMedia(project, clip.mediaId)?.name ?? 'Clip'} now starts at ${timecode(Math.max(0, clip.start + delta), project.fps)}.`);
      }
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      used();
      const lane = lanes[laneIndex + (e.key === 'ArrowUp' ? -1 : 1)];
      if (!lane) return;
      const next = moveClip(editor.project, clip.id, clip.start, lane.id);
      if (next === editor.project) editor.setStatus(`The clip cannot move to ${lane.name}: there is no room there.`);
      else {
        editor.commit(next);
        editor.setStatus(`Moved to ${lane.name}.`);
      }
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      used();
      goTo(mine[at + (e.key === 'ArrowLeft' ? -1 : 1)]);
    } else if (e.key === 'Home' || e.key === 'End') {
      used();
      goTo(e.key === 'Home' ? mine[0] : mine[mine.length - 1]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      used();
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const centre = clip.start + clip.duration / 2;
      for (let i = laneIndex + dir; i >= 0 && i < lanes.length; i += dir) {
        const there = clipsByTime.filter((c) => c.trackId === lanes[i].id);
        if (!there.length) continue;
        goTo(there.reduce((best, c) => (Math.abs(c.start + c.duration / 2 - centre) < Math.abs(best.start + best.duration / 2 - centre) ? c : best)));
        return;
      }
    }
  };

  const onClipPointerDown = (e: ReactPointerEvent, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const local = e.clientX - rect.left;
    // Clicking a grouped clip selects its whole group. Dragging any selected clip moves the selection.
    let picked = selection;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const group = expandSelection(editor.project, [clip.id]);
      picked = selection.includes(clip.id) ? selection.filter((s) => !group.includes(s)) : [...new Set([...selection, ...group])];
      setSelection(picked);
    } else if (!selection.includes(clip.id)) {
      picked = expandSelection(editor.project, [clip.id]);
      setSelection(picked);
    }
    const moveIds = picked.includes(clip.id) ? picked.filter((id) => editor.project.clips.some((c) => c.id === id)) : [clip.id];
    const before = editor.project;
    if (local <= EDGE) drag.current = { kind: 'trim-start', clipId: clip.id, before };
    else if (rect.width - local <= EDGE) drag.current = { kind: 'trim-end', clipId: clip.id, before };
    else drag.current = { kind: 'move', clipId: clip.id, ids: moveIds, before, grab: toTime(e.clientX) - clip.start, startX: e.clientX, moved: false };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'scrub') {
      player?.seek(toTime(e.clientX));
      return;
    }
    if (d.kind === 'marker') {
      editor.preview(moveMarker(d.before, d.id, snap(toTime(e.clientX) - d.grab, new Set())));
      return;
    }
    if (d.kind === 'range') {
      // The in and out marks follow the pointer, snapped like clip edges.
      const at = snap(toTime(e.clientX), new Set());
      if (Math.abs(at - d.anchor) * zoom >= 3) editor.preview(setRange(d.before, makeRange(d.anchor, at)));
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
    const bundle = d.kind === 'move' ? bundleIds(d.before, d.ids) : bundleIds(d.before, [d.clipId]);
    const ignore = new Set(bundle.length ? bundle : [d.clipId]);
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
      const target = trackAt(e.clientY) ?? clip.trackId;
      if (bundle.length > 1) {
        // Several clips (a selection, a group, or a video with its audio) move as one block.
        const order = d.before.tracks.map((t) => t.id);
        editor.preview(moveClips(d.before, d.ids, start - clip.start, order.indexOf(target) - order.indexOf(clip.trackId)));
      } else editor.preview(moveClip(d.before, d.clipId, start, target));
    } else if (d.kind === 'trim-start') {
      editor.preview(trimBundle(d.before, d.clipId, 'start', snap(toTime(e.clientX), ignore)));
    } else {
      editor.preview(trimBundle(d.before, d.clipId, 'end', snap(toTime(e.clientX), ignore)));
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // Magnetic tracks close their gaps when the edit is let go.
    if (d && d.kind !== 'scrub') editor.commit(d.kind === 'lane' ? editor.getProject() : magnetize(editor.getProject()), d.before);
  };

  /** Dragging in the thin strip under the ruler labels marks the part of the timeline to export. */
  const onRangePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'range', anchor: snap(toTime(e.clientX), new Set()), before: editor.project };
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
      editor.commit(magnetize(r.project));
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
            {project.markers.map((m, i) => {
              const selected = selection.includes(m.id);
              const gap = ((project.markers[i + 1]?.time ?? Infinity) - m.time) * zoom;
              return (
                <div
                  key={m.id}
                  className={`marker-flag${m.chapter ? ' chapter' : ''}${selected ? ' selected' : ''}`}
                  style={{ left: m.time * zoom }}
                  role="button"
                  aria-pressed={selected}
                  aria-label={`${m.chapter ? 'Chapter' : 'Marker'} ${m.name || 'Marker'} at ${timecode(m.time)}`}
                  title={`${m.name || 'Marker'} · ${timecode(m.time)}${m.chapter ? ' · chapter' : ''}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    setSelection([m.id]);
                    player?.seek(m.time);
                    drag.current = { kind: 'marker', id: m.id, before: editor.project, grab: toTime(e.clientX) - m.time };
                  }}
                >
                  <span className="marker-label" style={{ maxWidth: Math.max(0, Math.min(140, gap - 14)) }}>{m.name}</span>
                </div>
              );
            })}
            {project.range && (
              <div className="range-bar" aria-hidden style={{ left: project.range.start * zoom, width: Math.max(2, (project.range.end - project.range.start) * zoom) }} />
            )}
            {project.range &&
              (['start', 'end'] as const).map((edge) => {
                const range = project.range!;
                const value = range[edge];
                const min = edge === 'start' ? 0 : range.start + MIN_RANGE_SECONDS;
                const max = edge === 'start' ? range.end - MIN_RANGE_SECONDS : Math.max(duration, range.end);
                const name = edge === 'start' ? 'Export in point' : 'Export out point';
                return (
                  <div
                    key={edge}
                    className={`range-handle ${edge}`}
                    role="slider"
                    tabIndex={0}
                    aria-label={name}
                    aria-orientation="horizontal"
                    aria-valuemin={Math.round(min * 1000) / 1000}
                    aria-valuemax={Math.round(max * 1000) / 1000}
                    aria-valuenow={Math.round(value * 1000) / 1000}
                    aria-valuetext={timecode(value, project.fps)}
                    title={`${name}: arrow keys move it by a frame (Shift: a second), Home and End jump to its limits`}
                    style={{ left: value * zoom }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      drag.current = { kind: 'range', anchor: edge === 'start' ? range.end : range.start, before: editor.project };
                    }}
                    onKeyDown={(e) => {
                      const step = e.key === 'PageUp' || e.key === 'PageDown' ? 5 : e.shiftKey ? 1 : 1 / project.fps;
                      let next = value;
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'PageDown') next = value - step;
                      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp') next = value + step;
                      else if (e.key === 'Home') next = min;
                      else if (e.key === 'End') next = max;
                      else return;
                      e.preventDefault();
                      e.stopPropagation();
                      next = Math.min(max, Math.max(min, next));
                      if (next === value) return;
                      editor.commit(setRange(editor.project, edge === 'start' ? { start: next, end: range.end } : { start: range.start, end: next }));
                      editor.setStatus(`${name} ${timecode(next, project.fps)}.`);
                    }}
                  />
                );
              })}
            <div
              className="range-strip"
              onPointerDown={onRangePointerDown}
              onDoubleClick={() => editor.commit(setRange(editor.project, undefined))}
              title="Drag to mark the part to export (double-click to clear)"
              aria-label="In and out marks: drag to mark the part to export, double-click to clear"
              role="presentation"
            />
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
                    const kind = clip.audioOnly ? 'audio' : (media?.kind ?? 'video');
                    return (
                      <div
                        key={clip.id}
                        className={`clip kind-${kind}${clip.audioOnly ? ' audio-only' : ''}${clip.freeze ? ' freeze' : ''}${selected ? ' selected' : ''}${track.hidden ? ' dim' : ''}`}
                        style={{ left: clip.start * zoom, width: Math.max(2, clip.duration * zoom) }}
                        onPointerDown={(e) => onClipPointerDown(e, clip)}
                        onKeyDown={(e) => onClipKeyDown(e, clip)}
                        tabIndex={clip.id === tabStop ? 0 : -1}
                        data-clip-id={clip.id}
                        title={`${media?.name ?? 'Missing media'} · ${timecode(clip.duration)}`}
                        role="button"
                        aria-pressed={selected}
                        aria-label={`${media?.name ?? 'Clip'} at ${timecode(clip.start)}, ${timecode(clip.duration)} long${editNotes(clip)}`}
                      >
                        {media?.thumb && media.kind !== 'audio' && !clip.audioOnly && clip.duration * zoom > 60 && (
                          <img className="clip-thumb" src={media.thumb} alt="" draggable={false} />
                        )}
                        {kind === 'audio' && <div className="clip-wave" aria-hidden />}
                        <ClipDecor editor={editor} clip={clip} media={media} zoom={zoom} />
                        <span className="clip-name">{media?.name ?? 'Missing media'}</span>
                        <span className="clip-handle start" aria-hidden />
                        <span className="clip-handle end" aria-hidden />
                      </div>
                    );
                  })}
                {trackGaps(project, track.id).map((g) => {
                  const width = (g.end - g.start) * zoom;
                  if (width < 28 || track.locked) return null;
                  return (
                    <button
                      key={`gap-${g.start}`}
                      className="lane-gap"
                      style={{ left: g.start * zoom + width / 2 - 12 }}
                      title={`Close this ${timecode(g.end - g.start)} gap`}
                      aria-label={`Close gap of ${timecode(g.end - g.start)} at ${timecode(g.start)}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const next = removeGapAt(editor.getProject(), track.id, g.start);
                        if (next === editor.getProject()) editor.setStatus('Could not close the gap: a linked clip on another track is in the way');
                        else editor.commit(next);
                      }}
                    >
                      <EditIcon name="closeGaps" size={14} />
                    </button>
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

          {project.range && (
            <div
              className="range-shade"
              style={{ left: HEADER_WIDTH + project.range.start * zoom, width: Math.max(2, (project.range.end - project.range.start) * zoom) }}
              role="img"
              aria-label={`Export range from ${timecode(project.range.start)} to ${timecode(project.range.end)}`}
            >
              <span className="range-label">{`${timecode(project.range.start)} to ${timecode(project.range.end)}`}</span>
            </div>
          )}
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
  const hasGaps = trackGaps(editor.project, track.id).length > 0;
  return (
    <>
      <div className="track-header" style={{ height: LANE_HEIGHT }}>
        <div className="track-title">
          <input
            className="track-name"
            value={track.name}
            aria-label="Track name"
            onChange={(e) => set({ name: e.target.value.slice(0, 60) })}
          />
          <button
            className={`icon-button small track-tool${track.magnetic ? ' on' : ''}`}
            title={track.magnetic ? 'Magnetic: clips close up on this track. Click to turn off' : 'Make this track magnetic: clips close up, no gaps'}
            aria-label="Magnetic track"
            aria-pressed={!!track.magnetic}
            disabled={track.locked}
            onClick={() => editor.commit(setTrackMagnetic(editor.getProject(), track.id, !track.magnetic))}
          >
            <Icon name="magnet" />
          </button>
          <button
            className="icon-button small track-tool"
            title="Close all gaps on this track"
            aria-label="Close gaps"
            disabled={track.locked || !hasGaps}
            onClick={() => editor.commit(closeGaps(editor.getProject(), track.id))}
          >
            <EditIcon name="closeGaps" />
          </button>
        </div>
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
