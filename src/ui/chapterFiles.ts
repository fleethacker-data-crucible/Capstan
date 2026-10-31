// Sidecar chapter files for an exported video: a YouTube-style "0:00 Title" list and a WebVTT chapters
// track. (The MP4 itself carries the chapters too: see Mp4Muxer.setChapters.)
import { chapterList, formatChaptersText, formatChaptersVtt } from '../engine/markers';
import { type Project, projectDuration } from '../engine/project';
import { download, safeFileName } from './format';

export interface ChapterFile {
  name: string;
  blob: Blob;
}

/** The sidecar files for the project's chapter markers; empty when none are marked as chapters. */
export function chapterFiles(project: Project): ChapterFile[] {
  const duration = projectDuration(project);
  const chapters = chapterList(project.markers, duration);
  if (!chapters.length) return [];
  const base = safeFileName(project.name);
  return [
    { name: `${base} chapters.txt`, blob: new Blob([formatChaptersText(chapters)], { type: 'text/plain' }) },
    { name: `${base} chapters.vtt`, blob: new Blob([formatChaptersVtt(chapters, duration)], { type: 'text/vtt' }) },
  ];
}

/** Downloads them; returns how many files were saved. */
export function saveChapterFiles(project: Project): number {
  const files = chapterFiles(project);
  for (const f of files) download(f.blob, f.name);
  return files.length;
}
