// Subtitle files in and out (SRT, and WebVTT cues), and caption line wrapping for the compositor.
import { type Caption, MAX_CAPTION_CHARS, newId } from './project';

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function seconds(stamp: string): number | null {
  const m = TIME.exec(stamp.trim());
  if (!m) return null;
  const [, h, min, s, ms] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '' };
const decodeEntities = (s: string): string => s.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, e: string) => ENTITIES[e]);

/** Parses SRT or WebVTT text. Cues without a valid time line are skipped; styling tags are dropped. */
export function parseSubtitles(text: string): Caption[] {
  const out: Caption[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(block.trimStart())) continue;
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const start = seconds(from);
    const end = seconds(to ?? '');
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(at + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')).trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_CAPTION_CHARS);
    if (body) out.push({ id: newId('cap'), start, end, text: body });
  }
  return out.sort((a, b) => a.start - b.start);
}

function stamp(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** A blank line would end the cue in either format. */
const cueText = (text: string): string => text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

export function formatSrt(captions: Caption[]): string {
  return captions.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${cueText(c.text)}\n`).join('\n');
}

/** WebVTT: a header, then cues with a dot before the milliseconds. `&`, `<` and `>` are escaped so the text survives a re-import. */
export function formatVtt(captions: Caption[]): string {
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cues = captions.map((c, i) => `${i + 1}\n${stamp(c.start).replace(',', '.')} --> ${stamp(c.end).replace(',', '.')}\n${escape(cueText(c.text))}\n`);
  return `WEBVTT\n\n${cues.join('\n')}`;
}

/**
 * Splits caption text into lines no wider than `maxWidth` (as measured), keeping the caption's own
 * line breaks. At most `maxLines` lines; the last one ends with an ellipsis if text was cut.
 */
export function wrapCaption(text: string, measure: (s: string) => number, maxWidth: number, maxLines = 3): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
  return kept;
}
