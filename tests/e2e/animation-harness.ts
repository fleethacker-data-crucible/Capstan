// Browser-side harness for the animation e2e: exports a tiny timeline (320x180, 10 fps, 3 s) of
// the card image with a fade-in and a zoom-n-pan region, so the encoded frames can be checked with
// ffmpeg. Preview and export share drawFrame; this proves the export path really shows them.
import { setClipTransition } from '../../src/engine/animate';
import { defaultExportOptions, exportMp4 } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia, trimEnd } from '../../src/engine/ops';
import { createProject } from '../../src/engine/project';
import { addZoom } from '../../src/engine/zoom';

declare global {
  interface Window {
    runAnimationExport: () => Promise<{ base64: string; info: unknown }>;
  }
}

window.runAnimationExport = async () => {
  const res = await fetch('/fixtures/card.png');
  const file = new File([await res.blob()], 'card.png', { type: 'image/png' });
  const media = await probeMedia(file);
  const blobs = new Map<string, Blob>([[media.id, file]]);
  let p = addMedia(createProject('anim-harness', 320, 180, 10), media);
  const placed = addClip(p, media.id, 0);
  p = trimEnd(placed.project, placed.clipId!, 3);
  // Fade in over the first second; zoom 2x onto the centre from 1.5 s to the end of the clip.
  p = setClipTransition(p, placed.clipId!, 'in', { type: 'fade', duration: 1 });
  p = addZoom(p, 1.5, { duration: 1.5, easeIn: 0.2, easeOut: 0 }).project;
  const options = { ...defaultExportOptions(p), videoBitrate: 800_000, includeAudio: false };
  const result = await exportMp4(p, async (id) => blobs.get(id) ?? null, options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), info: { frames: result.frames, seconds: result.seconds, bytes: bytes.length } };
};
document.title = 'animation-harness-ready';
