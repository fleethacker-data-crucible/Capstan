// A sample project for the command tests, built by running commands (so building it is also a test),
// and one valid set of arguments for every command that runs over plain data.
import { serializeSidecar } from '../../../src/engine/cursor';
import { type Project, createProject } from '../../../src/engine/project';
import { type ResultEnvelope, runCommand } from '../../../src/engine/commands/registry';

export interface Ids {
  t0: string;
  t1: string;
  t2: string;
  /** Video clip on track 0, 0 to 20 s (the media has sound). */
  c1: string;
  /** Video clip on track 1, 2 to 22 s, with a key, a transition, a behavior and effects. */
  c2: string;
  /** Audio clip on track 2, 0 to 30 s, with a volume point. */
  c3: string;
  /** Image clip on track 0, 25 to 30 s (a gap sits before it). */
  c4: string;
  /** A fourth track holding c5, c5a and c6. */
  t3: string;
  /** Video clip on track 3, 40 to 60 s, grouped with c6 and linked to the audio clip c5a. */
  c5: string;
  c5a: string;
  c6: string;
  mVid: string;
  mAud: string;
  mImg: string;
  ann: string;
  red: string;
  zoom: string;
  cap1: string;
  cap2: string;
  mk: string;
}

export function ok(env: ResultEnvelope): Extract<ResultEnvelope, { ok: true }> {
  if (!env.ok) throw new Error(`${env.command} failed (${env.errorType}): ${env.error}`);
  return env;
}

/** The synthetic cursor file for the sample video: a short walk with two clicks. */
export function sampleSidecar(): string {
  const samples = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.25, x: 0.2 + i * 0.01, y: 0.3 + (i % 5) * 0.02 }));
  return serializeSidecar({
    samples,
    clicks: [
      { t: 2, button: 'left', down: true },
      { t: 2.1, button: 'left', down: false },
      { t: 6, button: 'left', down: true },
      { t: 6.1, button: 'left', down: false },
    ],
    keys: [{ t: 3, key: 'A', down: true }],
  });
}

export function sample(): { p: Project; ids: Ids } {
  let p = createProject('Sample project');
  const run = (name: string, args: Record<string, unknown>): Record<string, any> => {
    const env = ok(runCommand(p, name, args, { confirm: true }));
    p = env.project as Project;
    return env.result as Record<string, any>;
  };
  const [t0, t1, t2] = p.tracks.map((t) => t.id);
  run('media add', { id: 'm_vid', name: 'screen.webm', kind: 'video', duration: 20, width: 1280, height: 720, hasAudio: true, mime: 'video/webm', bytes: 1000 });
  run('media add', { id: 'm_aud', name: 'music.wav', kind: 'audio', duration: 30, width: 0, height: 0 });
  run('media add', { id: 'm_img', name: 'logo.png', kind: 'image', duration: 0, width: 800, height: 600 });
  const c1 = run('clip add', { media: 'm_vid', start: 0, track: t0 }).clip;
  const c2 = run('clip add', { media: 'm_vid', start: 2, track: t1 }).clip;
  const c3 = run('clip add', { media: 'm_aud', start: 0, track: t2 }).clip;
  const c4 = run('clip add', { media: 'm_img', start: 25, track: t0 }).clip;
  const t3 = run('track add', { name: 'Group' }).track;
  const c5 = run('clip add', { media: 'm_vid', start: 40, track: t3 }).clip;
  const c5a = run('clip detach-audio', { clip: c5 }).audioClip;
  const c6 = run('clip add', { media: 'm_img', start: 62, track: t3 }).clip;
  run('clip group', { clips: [c5, c6] });
  const ann = run('annotation add', { kind: 'text', start: 1, text: 'Hello' }).annotation;
  const red = run('redaction add', { start: 2 }).redaction;
  const zoom = run('zoom add', { start: 3 }).zoom;
  const cap1 = run('caption add', { time: 1, text: 'First caption', seconds: 2 }).caption;
  const cap2 = run('caption add', { time: 4, text: 'Second caption', seconds: 2 }).caption;
  const mk = run('marker add', { time: 5, name: 'Chapter one', chapter: true }).marker;
  run('annotation add', { kind: 'ellipse', start: 1.5 });
  run('range set', { start: 1, end: 9 });
  run('cursor attach', { media: 'm_vid', sidecar: sampleSidecar() });
  run('keyframe set', { clip: c2, prop: 'x', time: 3, value: 400 });
  run('keyframe set', { clip: c2, prop: 'x', time: 8, value: 900 });
  run('transition set', { clip: c2, edge: 'in', type: 'fade' });
  run('behavior set', { clip: c2, stage: 'enter', type: 'pop' });
  run('effects preset', { clips: c2, preset: 'card' });
  run('audio point-set', { clip: c3, time: 5, value: 0.5 });
  return { p, ids: { t0, t1, t2, t3, c5, c5a, c6, c1, c2, c3, c4, mVid: 'm_vid', mAud: 'm_aud', mImg: 'm_img', ann, red, zoom, cap1, cap2, mk } };
}

/** One valid set of arguments per command over plain data, written against the sample project. */
export function cases(i: Ids): Record<string, Record<string, unknown>> {
  return {
    'project show': {},
    'project new': { name: 'Fresh', width: 1280, height: 720, fps: 24 },
    'project from-template': { template: 'builtin-vertical-9x16' },
    'project open': { project: JSON.stringify(createProject('Opened')) },
    'project save': {},
    'project set': { name: 'Renamed', fps: 25, background: '#102030' },
    'project resize': { width: 1280, height: 720 },
    'project theme': { theme: 'night-watch' },
    'track add': { name: 'Overlay' },
    'track remove': { track: i.t2 },
    'track update': { track: i.t0, name: 'Main', muted: true, magnetic: true },
    'media add': { name: 'extra.mp4', kind: 'video', duration: 5, width: 640, height: 360 },
    'media remove': { media: i.mImg },
    'clip add': { media: i.mImg, start: 40 },
    'clip move': { clip: i.c4, start: 31 },
    'clip trim': { clip: i.c1, edge: 'end', time: 15 },
    'clip split': { time: 10, clips: i.c1 },
    'clip delete': { clips: i.c4 },
    'clip duplicate': { clips: i.c4, at: 40 },
    'clip props': { clip: i.c1, scale: 0.5, opacity: 0.8, x: 300 },
    'clip speed': { clip: i.c1, speed: 2 },
    'clip freeze': { clip: i.c1, time: 5, seconds: 1 },
    'clip extend': { clip: i.c1, seconds: 2 },
    'clip crop': { clip: i.c1, x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    'clip group': { clips: `${i.c1},${i.c2}` },
    'clip ungroup': { clips: i.c5 },
    'clip unlink': { clips: i.c5 },
    'clip detach-audio': { clip: i.c1 },
    'clip close-gaps': { track: i.t0 },
    'clip remove-gap': { track: i.t0, time: 22 },
    'annotation add': { kind: 'rect', start: 2, duration: 3, x: 100, y: 100, width: 300, height: 200, style: { stroke: '#ff0000' } },
    'annotation update': { annotation: i.ann, text: 'Changed', start: 2, duration: 5, style: '{"bold":true}' },
    'annotation remove': { annotation: i.ann },
    'annotation duplicate': { annotation: i.ann },
    'annotation move': { annotation: i.ann, dx: 20, dy: -10 },
    'annotation reorder': { annotation: i.ann, order: 'front' },
    'annotation preset': { annotation: i.ann, preset: 'title' },
    'redaction add': { start: 4, mode: 'pixelate', strength: 40 },
    'redaction update': { redaction: i.red, strength: 80, width: 300 },
    'redaction remove': { redaction: i.red },
    'zoom add': { start: 8, level: 3, focusX: 400, focusY: 300 },
    'zoom update': { zoom: i.zoom, level: 4, easeIn: 0.2, ease: 'out' },
    'zoom remove': { zoom: i.zoom },
    'zoom duplicate': { zoom: i.zoom },
    'zoom suggest': { level: 2.5 },
    'zoom accept': { regions: [{ start: 12, duration: 2, x: 100, y: 100, width: 400, height: 300 }] },
    'keyframe set': { clip: i.c1, prop: 'opacity', time: 4, value: 0.3, ease: 'linear' },
    'keyframe remove': { clip: i.c2, prop: 'x', time: 3 },
    'keyframe ease': { clip: i.c2, prop: 'x', time: 3, ease: 'bounce' },
    'keyframe clear': { clip: i.c2 },
    'transition set': { clip: i.c1, edge: 'both', type: 'slide-left', duration: 0.4 },
    'transition clear': { clip: i.c2, edge: 'in' },
    'behavior set': { clip: i.c1, stage: 'emphasis', type: 'pulse' },
    'behavior clear': { clip: i.c2, stage: 'enter' },
    'effects set': { clips: i.c1, effects: { shadow: { on: true, blur: 20 }, radius: 12 } },
    'effects preset': { clips: i.c1, preset: 'bw' },
    'effects clear': { clips: i.c2 },
    'cursor settings': { showCursor: true, shape: 'hand', size: 2, color: '#ff00ff', clickRings: true },
    'cursor reset': {},
    'cursor attach': { media: i.mAud, sidecar: sampleSidecar() },
    'cursor detach': { media: i.mVid },
    'audio fade': { clip: i.c3, fadeIn: 1, fadeOut: 2, curve: 'smooth' },
    'audio point-set': { clip: i.c3, time: 10, value: 1.5 },
    'audio point-remove': { clip: i.c3, time: 5 },
    'audio points-clear': { clip: i.c3 },
    'audio duck': { clip: i.c3, reductionDb: 18 },
    'caption set': { text: '1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:02,500 --> 00:00:04,000\nSecond cue\n' },
    'caption clear': {},
    'caption add': { time: 8, text: 'Third', seconds: 1.5 },
    'caption update': { caption: i.cap1, text: 'Edited', end: 3.5 },
    'caption remove': { caption: i.cap1 },
    'caption split': { time: 2, caption: i.cap1 },
    'caption merge': { caption: i.cap1 },
    'caption shift': { delta: 1.5 },
    'caption export-srt': {},
    'caption export-vtt': {},
    'marker add': { time: 9, name: 'Next', chapter: true },
    'marker rename': { marker: i.mk, name: 'Renamed' },
    'marker move': { marker: i.mk, time: 7 },
    'marker remove': { marker: i.mk },
    'marker chapter': { marker: i.mk, chapter: false },
    'marker export-chapters': { format: 'text' },
    'range set': { start: 2, end: 8 },
    'range clear': {},
    'range mark-in': { time: 3 },
    'range mark-out': { time: 12 },
  };
}
