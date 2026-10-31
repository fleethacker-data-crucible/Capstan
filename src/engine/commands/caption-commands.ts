// Caption, marker (chapter) and in/out range commands.
import { addCaptionAt, mergeWithNext, nudgeCaptions, removeCaption, retimeCaption, splitCaption, updateCaptionText } from '../captionops';
import { formatSrt, formatVtt, parseSubtitles } from '../captions';
import { MAX_MARKER_NAME, addMarker, chapterList, formatChaptersText, formatChaptersVtt, moveMarker, removeMarker, renameMarker, setMarkerChapter } from '../markers';
import { type Project, MAX_CAPTION_CHARS, projectDuration } from '../project';
import { setCaptions } from '../ops';
import { setRange, setRangeIn, setRangeOut } from '../range';
import { type CommandDef, bool, changed, fail, num, oneOf, ref, seconds, str } from './define';

const fileSafe = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'project';

function needCaption(p: Project, id: string) {
  return p.captions.find((c) => c.id === id) ?? fail(`No caption with id "${id}"`);
}
function needMarker(p: Project, id: string) {
  return p.markers.find((m) => m.id === id) ?? fail(`No marker with id "${id}"`);
}

function exportCaptions(p: Project, kind: 'srt' | 'vtt') {
  if (!p.captions.length) return fail('There are no captions to export');
  const text = kind === 'srt' ? formatSrt(p.captions) : formatVtt(p.captions);
  return { project: p, result: { fileName: `${fileSafe(p.name)}.${kind}`, count: p.captions.length, text } };
}

export const captionCommands: CommandDef[] = [
  {
    name: 'caption set',
    summary: 'Replace all captions with the cues in SRT or WebVTT text.',
    inputs: [str('text', 'The text of an .srt or .vtt file.')],
    result: 'Object with how many captions were read and how many they replaced.',
    destructive: true,
    needs: 'project',
    run: (p, a) => {
      const parsed = parseSubtitles(a.text);
      if (!parsed.length) return fail('No captions Capstan can read (SRT or WebVTT) in that text');
      const next = setCaptions(p, parsed);
      return { project: next, result: { captions: next.captions.length, replaced: p.captions.length } };
    },
  },
  {
    name: 'caption clear',
    summary: 'Remove every caption.',
    inputs: [],
    result: 'Object with how many captions were removed.',
    destructive: true,
    needs: 'project',
    run: (p) => ({ project: setCaptions(p, []), result: { removed: p.captions.length } }),
  },
  {
    name: 'caption add',
    summary: 'Add a caption at a time (after a caption already showing there, and ending before the next one).',
    inputs: [
      seconds('time', 'Timeline position in seconds.'),
      str('text', `Caption text (up to ${MAX_CAPTION_CHARS} characters; default "New caption").`, { optional: true }),
      num('seconds', 'Length in seconds (default 2).', { optional: true, min: 0.05, max: 600 }),
    ],
    result: 'Object with the new caption id.',
    needs: 'project',
    run: (p, a) => {
      const r = addCaptionAt(p, a.time, a.text, a.seconds);
      return { project: r.project, result: { caption: r.id } };
    },
  },
  {
    name: 'caption update',
    summary: 'Change a caption’s text or timing.',
    inputs: [
      ref('caption', 'Caption id.'),
      str('text', 'New text.', { optional: true }),
      seconds('start', 'New start in seconds.', { optional: true }),
      seconds('end', 'New end in seconds (kept at least 0.05 s after the start).', { optional: true }),
    ],
    result: 'Object with the caption as it is now.',
    needs: 'project',
    atLeastOne: ['text', 'start', 'end'],
    run: (p, a) => {
      needCaption(p, a.caption);
      let next = p;
      if (a.text !== undefined) next = updateCaptionText(next, a.caption, a.text);
      if (a.start !== undefined || a.end !== undefined) next = retimeCaption(next, a.caption, { start: a.start, end: a.end });
      return { project: next, result: { caption: next.captions.find((c) => c.id === a.caption) } };
    },
  },
  {
    name: 'caption remove',
    summary: 'Remove a caption.',
    inputs: [ref('caption', 'Caption id.')],
    result: 'Object with the caption id.',
    needs: 'project',
    run: (p, a) => {
      needCaption(p, a.caption);
      return { project: removeCaption(p, a.caption), result: { caption: a.caption } };
    },
  },
  {
    name: 'caption split',
    summary: 'Cut the caption showing at a time in two, splitting the text in proportion.',
    inputs: [seconds('time', 'Timeline position in seconds, inside a caption.'), ref('caption', 'Only this caption.', { optional: true })],
    result: 'Object with the ids of the two new captions.',
    needs: 'project',
    run: (p, a) => {
      if (a.caption) needCaption(p, a.caption);
      const r = splitCaption(p, a.time, a.caption);
      if (!r.ids.length) return fail('That time is not inside a caption (it must be away from the caption’s edges)');
      return { project: r.project, result: { captions: r.ids } };
    },
  },
  {
    name: 'caption merge',
    summary: 'Join a caption with the one after it: text on separate lines, time from the first start to the last end.',
    inputs: [ref('caption', 'Caption id (it is merged with the next one).')],
    result: 'Object with the merged caption id.',
    needs: 'project',
    run: (p, a) => {
      needCaption(p, a.caption);
      const r = mergeWithNext(p, a.caption);
      if (!r.id) return fail('That is the last caption; there is nothing after it to merge');
      return { project: r.project, result: { caption: r.id } };
    },
  },
  {
    name: 'caption shift',
    summary: 'Move captions earlier or later by some seconds (never before 0).',
    inputs: [num('delta', 'Seconds; negative moves earlier.', { min: -86400, max: 86400 }), ref('captions', 'Only these captions (default: all).', { optional: true, many: true })],
    result: 'Object with how many captions were shifted.',
    needs: 'project',
    run: (p, a) => {
      for (const id of a.captions ?? []) needCaption(p, id);
      const next = changed(p, nudgeCaptions(p, a.delta, a.captions), 'Nothing moved (there are no captions, or they are already at 0 s)');
      return { project: next, result: { shifted: a.captions ? a.captions.length : p.captions.length } };
    },
  },
  {
    name: 'caption export-srt',
    summary: 'Return the captions as SubRip (.srt) text.',
    inputs: [],
    result: 'Object with fileName, count and text.',
    needs: 'project',
    run: (p) => exportCaptions(p, 'srt'),
  },
  {
    name: 'caption export-vtt',
    summary: 'Return the captions as WebVTT (.vtt) text.',
    inputs: [],
    result: 'Object with fileName, count and text.',
    needs: 'project',
    run: (p) => exportCaptions(p, 'vtt'),
  },
  // ---- markers and chapters ----
  {
    name: 'marker add',
    summary: 'Add a marker on the timeline; a chapter marker is written to the exported video.',
    inputs: [
      seconds('time', 'Timeline position in seconds.'),
      str('name', `Marker name (up to ${MAX_MARKER_NAME} characters; default "Marker N").`, { optional: true }),
      bool('chapter', 'Make it a chapter (default false).', { optional: true }),
    ],
    result: 'Object with the new marker id.',
    needs: 'project',
    run: (p, a) => {
      const r = addMarker(p, a.time, a.name, !!a.chapter);
      if (!r.id) return fail('Too many markers in this project');
      return { project: r.project, result: { marker: r.id } };
    },
  },
  {
    name: 'marker rename',
    summary: 'Rename a marker.',
    inputs: [ref('marker', 'Marker id.'), str('name', 'New name.')],
    result: 'Object with the marker as it is now.',
    needs: 'project',
    run: (p, a) => {
      needMarker(p, a.marker);
      const next = renameMarker(p, a.marker, a.name);
      return { project: next, result: { marker: next.markers.find((m) => m.id === a.marker) } };
    },
  },
  {
    name: 'marker move',
    summary: 'Move a marker to a time.',
    inputs: [ref('marker', 'Marker id.'), seconds('time', 'New timeline position in seconds.')],
    result: 'Object with the marker as it is now.',
    needs: 'project',
    run: (p, a) => {
      needMarker(p, a.marker);
      const next = moveMarker(p, a.marker, a.time);
      return { project: next, result: { marker: next.markers.find((m) => m.id === a.marker) } };
    },
  },
  {
    name: 'marker remove',
    summary: 'Remove a marker.',
    inputs: [ref('marker', 'Marker id.')],
    result: 'Object with the marker id.',
    needs: 'project',
    run: (p, a) => {
      needMarker(p, a.marker);
      return { project: removeMarker(p, a.marker), result: { marker: a.marker } };
    },
  },
  {
    name: 'marker chapter',
    summary: 'Make a marker a chapter, or an ordinary marker again.',
    inputs: [ref('marker', 'Marker id.'), bool('chapter', 'true: a chapter; false: an ordinary marker.')],
    result: 'Object with the marker as it is now.',
    needs: 'project',
    run: (p, a) => {
      needMarker(p, a.marker);
      const next = setMarkerChapter(p, a.marker, a.chapter);
      return { project: next, result: { marker: next.markers.find((m) => m.id === a.marker) } };
    },
  },
  {
    name: 'marker export-chapters',
    summary: 'Return the chapter markers as a YouTube-style list or a WebVTT chapters track.',
    inputs: [oneOf('format', ['text', 'vtt'], 'text: "0:00 Title" lines; vtt: a chapters track.')],
    result: 'Object with fileName, count and text.',
    needs: 'project',
    run: (p, a) => {
      const duration = projectDuration(p);
      const chapters = chapterList(p.markers, duration);
      if (!chapters.length) return fail('No markers are marked as chapters inside the timeline');
      const text = a.format === 'vtt' ? formatChaptersVtt(chapters, duration) : formatChaptersText(chapters);
      return { project: p, result: { fileName: `${fileSafe(p.name)} chapters.${a.format === 'vtt' ? 'vtt' : 'txt'}`, count: chapters.length, text } };
    },
  },
  // ---- export range ----
  {
    name: 'range set',
    summary: 'Set the in and out marks: the part of the timeline an "In to out" export covers.',
    inputs: [seconds('start', 'In mark in seconds.'), seconds('end', 'Out mark in seconds.')],
    result: 'Object with the range now set.',
    needs: 'project',
    run: (p, a) => {
      const next = setRange(p, { start: a.start, end: a.end });
      return { project: next, result: { range: next.range ?? null } };
    },
  },
  {
    name: 'range clear',
    summary: 'Clear the in and out marks.',
    inputs: [],
    result: 'Object with changed: true when there was a range.',
    needs: 'project',
    run: (p) => {
      const next = setRange(p, undefined);
      return { project: next, result: { changed: next !== p } };
    },
  },
  {
    name: 'range mark-in',
    summary: 'Mark the start of the part to export (the out mark moves to the end if it would fall before it).',
    inputs: [seconds('time', 'Timeline position in seconds.')],
    result: 'Object with the range now set.',
    needs: 'project',
    run: (p, a) => {
      const next = setRangeIn(p, a.time, projectDuration(p));
      if (!next.range) fail('The in mark must be before the end of the timeline');
      return { project: next, result: { range: next.range ?? null } };
    },
  },
  {
    name: 'range mark-out',
    summary: 'Mark the end of the part to export (the in mark moves to 0 if it would fall after it).',
    inputs: [seconds('time', 'Timeline position in seconds.')],
    result: 'Object with the range now set.',
    needs: 'project',
    run: (p, a) => {
      const next = setRangeOut(p, a.time);
      if (!next.range) fail('The out mark must be after the start of the timeline');
      return { project: next, result: { range: next.range ?? null } };
    },
  },
];
