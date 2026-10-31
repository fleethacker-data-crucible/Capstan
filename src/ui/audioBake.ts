// Editor side of "bake": run noise removal or levelling over a clip's sound, add the result to the bin as a WAV
// and switch the clip to it. Two undo steps: the swap, then the import (the media stays in the bin when undone).
import { applyProcessedAudio } from '../engine/audioops';
import { type BakeKind, type BakeParams, bakeBlob } from '../engine/bake';
import { findMedia } from '../engine/project';
import type { Editor } from './useEditor';

const LABEL: Record<BakeKind, string> = { noise: 'denoised', level: 'levelled' };

/** Returns a message for the user. Throws nothing: failures come back as text. */
export async function bakeClipAudio(editor: Editor, clipId: string, kind: BakeKind, params: BakeParams): Promise<string> {
  const start = editor.getProject();
  const clip = start.clips.find((c) => c.id === clipId);
  const media = clip && findMedia(start, clip.mediaId);
  if (!clip || !media || media.kind === 'image') return 'Select a clip with audio first.';
  try {
    const blob = await editor.sources.blob(media.id);
    if (!blob) return 'The media is not loaded yet.';
    editor.setStatus(kind === 'noise' ? 'Removing noise…' : 'Levelling…');
    const baked = await bakeBlob(blob, kind, params);
    const base = media.name.replace(/\.[^.]+$/, '');
    const file = new File([baked.wav as BlobPart], `${base} (${LABEL[kind]}).wav`, { type: 'audio/wav' });
    const [added] = await editor.importFiles([file]);
    if (!added) return 'Could not add the processed audio to the bin.';
    const now = editor.getProject();
    if (!now.clips.some((c) => c.id === clipId)) return 'The clip was removed while the audio was processed; the result is in the bin.';
    const result = applyProcessedAudio(now, clipId, added);
    editor.commit(result.project);
    if (result.audioClipId) editor.setSelection([result.audioClipId]);
    const note = media.kind === 'video' ? ' The picture keeps its clip; the processed sound is on a linked audio clip.' : '';
    editor.setStatus(baked.summary);
    return `${baked.summary}.${note}`;
  } catch (e) {
    editor.setStatus(`Audio processing failed: ${(e as Error).message}`);
    return `Audio processing failed: ${(e as Error).message}`;
  }
}
