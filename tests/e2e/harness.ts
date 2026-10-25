// Browser-side export harness: builds a timeline from the fixtures without the UI and exports
// it, so the encoder + muxer can be verified with ffprobe independently of the editor.
import { exportMp4, defaultExportOptions } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia, moveClip, updateClipProps } from '../../src/engine/ops';
import { createProject } from '../../src/engine/project';

declare global {
  interface Window {
    runExport: (opts?: { audio?: boolean }) => Promise<{ base64: string; info: unknown }>;
  }
}

async function fixture(name: string): Promise<File> {
  const res = await fetch(`/fixtures/${name}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}

window.runExport = async (opts = {}) => {
  const blobs = new Map<string, Blob>();
  let p = createProject('harness', 640, 360, 30);
  const files = await Promise.all(['clip.webm', 'card.png', 'tone.wav'].map(fixture));
  const ids: string[] = [];
  for (const f of files) {
    const m = await probeMedia(f);
    blobs.set(m.id, f);
    ids.push(m.id);
    p = addMedia(p, m);
  }
  const [video, card, tone] = ids;
  const bottom = p.tracks[0].id;
  const top = p.tracks[2].id;
  let r = addClip(p, video, 0, bottom); // 0..3
  p = r.project;
  r = addClip(p, card, 3, bottom); // 3..8 (image)
  p = r.project;
  r = addClip(p, video, 1, top); // picture-in-picture 1..4
  p = updateClipProps(r.project, r.clipId!, { scale: 0.35, x: 500, y: 90, opacity: 0.9 });
  r = addClip(p, tone, 4, p.tracks[1].id);
  p = moveClip(r.project, r.clipId!, 4.5);
  const options = { ...defaultExportOptions(p), videoBitrate: 1_500_000, includeAudio: opts.audio !== false };
  const result = await exportMp4(p, async (id) => blobs.get(id) ?? null, options);
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    base64: btoa(binary),
    info: { videoCodec: result.videoCodec, audioCodec: result.audioCodec, frames: result.frames, seconds: result.seconds, bytes: bytes.length },
  };
};
document.title = 'harness-ready';
