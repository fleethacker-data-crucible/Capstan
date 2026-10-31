// Browser-side harness for cursor-effects.e2e.mjs: exports a tiny timeline whose only audio is the
// click sound, so the export mix can be checked with ffmpeg. Built by the e2e itself (bun build) and
// served by intercepting /harness.js, so the shared harness.ts is untouched.
import { attachCursorData, setCursorFx } from '../../src/engine/cursorops';
import { defaultExportOptions, exportMp4 } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia } from '../../src/engine/ops';
import { createProject } from '../../src/engine/project';
import { shortCursor } from '../helpers/cursor-synth.mjs';

declare global {
  interface Window {
    runClickExport: (opts: { clickSound: boolean }) => Promise<{ base64: string; info: unknown }>;
  }
}

window.runClickExport = async ({ clickSound }) => {
  const blob = await (await fetch('/fixtures/clip.webm')).blob();
  const file = new File([blob], 'clip.webm', { type: blob.type });
  const probed = await probeMedia(file);
  // The clip has its own audio track; take it out of the mix so the clicks are the only sound.
  const media = { ...probed, hasAudio: false };
  let p = createProject('click-export', 320, 180, 30);
  p = addMedia(p, media);
  p = addClip(p, media.id, 0).project;
  p = attachCursorData(p, media.id, shortCursor());
  p = setCursorFx(p, { clickSound, clickVolume: 1, clickRings: true, highlight: true });
  const options = { ...defaultExportOptions(p), videoBitrate: 400_000, includeAudio: true };
  const result = await exportMp4(p, async (id) => (id === media.id ? file : null), options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), info: { audioCodec: result.audioCodec, frames: result.frames, seconds: result.seconds } };
};
document.title = 'harness-ready';
