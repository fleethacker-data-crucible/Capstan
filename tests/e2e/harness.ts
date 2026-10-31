// Browser-side export harness: builds a timeline from the fixtures without the UI and exports
// it, so the encoder + muxer can be verified with ffprobe independently of the editor.
import { exportMp4, defaultExportOptions } from '../../src/engine/export';
import { probeMedia } from '../../src/engine/media';
import { addClip, addMedia, moveClip, updateClipProps } from '../../src/engine/ops';
import { createProject, type Project } from '../../src/engine/project';
import { type ExportRequest, exportWith } from '../../src/engine/export-run';
import { createFrameRenderer } from '../../src/engine/frames';
import { demuxVideo } from '../../src/engine/fastdecode';
import { fileSink, opfsFile } from '../../src/engine/sinks';
import { trimEnd } from '../../src/engine/ops';

declare global {
  interface Window {
    runExport: (opts?: { audio?: boolean }) => Promise<{ base64: string; info: unknown }>;
    runFormat: (job: { request: ExportRequest; stream?: string; marks?: { start: number; end: number } }) => Promise<{
      base64: string;
      info: Record<string, any>;
      log: { writes: number[]; closed: boolean; bytesBeforeLastFrame: number };
    }>;
    compareDecode: (name: string, times: number[]) => Promise<{ out: Array<{ t: number; same: number; neighbour: number; px?: number[][] }>; fastMs: number; slowMs: number; stats: { fast: number; seek: number } }>;
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
  const bytes = new Uint8Array(await result.blob!.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    base64: btoa(binary),
    info: { videoCodec: result.videoCodec, audioCodec: result.audioCodec, frames: result.frames, seconds: result.seconds, bytes: bytes.length },
  };
};

// ---- export formats ---------------------------------------------------------------------
interface FmtJob {
  request: ExportRequest;
  /** Stream into an OPFS file with this name and read it back. */
  stream?: string;
  marks?: { start: number; end: number };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 320x180 at 15 fps, 2 s: video 0-2 s, tone 0-2 s, the blue card on top from 1 s to 2 s. */
async function tinyProject(): Promise<{ project: Project; blobs: (id: string) => Promise<Blob | null> }> {
  const blobs = new Map<string, Blob>();
  let p = createProject('tiny', 320, 180, 15);
  const ids: string[] = [];
  for (const f of await Promise.all(['clip.webm', 'card.png', 'tone.wav'].map(fixture))) {
    const m = await probeMedia(f);
    blobs.set(m.id, f);
    ids.push(m.id);
    p = addMedia(p, m);
  }
  const [video, card, tone] = ids;
  let r = addClip(p, video, 0, p.tracks[0].id);
  p = trimEnd(r.project, r.clipId!, 2);
  r = addClip(p, tone, 0, p.tracks[1].id);
  p = r.project;
  r = addClip(p, card, 1, p.tracks[2].id);
  p = trimEnd(r.project, r.clipId!, 2);
  return { project: p, blobs: async (id) => blobs.get(id) ?? null };
}

window.runFormat = async (job: FmtJob) => {
  const { project, blobs } = await tinyProject();
  const p = job.request.range === 'marks' ? { ...project, range: job.marks } : project;
  const log = { writes: [] as number[], closed: false, bytesBeforeLastFrame: 0 };
  let request = job.request;
  if (job.stream) {
    const handle = await opfsFile(job.stream);
    request = {
      ...request,
      output: {
        openSink: async () => {
          const w = await handle.createWritable({ keepExistingData: false });
          const inner = fileSink(w);
          return {
            write: async (d, pos) => {
              log.writes.push(d.length);
              await inner.write(d, pos);
            },
            close: async () => {
              log.closed = true;
              await inner.close();
            },
            abort: () => inner.abort?.(),
          };
        },
      },
    };
  }
  let written = 0;
  const t0 = performance.now();
  const result = await exportWith(p, request, {
    blobs,
    onProgress: (pr) => {
      const m = /Frame (\d+) of (\d+)/.exec(pr.detail);
      if (m && Number(m[1]) >= Number(m[2]) - 5 && !written) written = log.writes.reduce((a, b) => a + b, 0);
    },
  });
  log.bytesBeforeLastFrame = written;
  let bytes: Uint8Array;
  if (job.stream) bytes = new Uint8Array(await (await (await opfsFile(job.stream)).getFile!()).arrayBuffer());
  else bytes = new Uint8Array(await result.blob!.arrayBuffer());
  return {
    base64: toBase64(bytes),
    info: { ...result, blob: null, ms: Math.round(performance.now() - t0), size: bytes.length },
    log,
  };
};

/** Mean absolute difference between fast-decoded and seeked frames at the given times (a restart sequence). */
window.compareDecode = async (name: string, times: number[]) => {
  const blobs = new Map<string, Blob>();
  let p = createProject('cmp', 320, 180, 30);
  const m = await probeMedia(await fixture(name));
  blobs.set(m.id, await fixture(name));
  p = addMedia(p, m);
  p = addClip(p, m.id, 0, p.tracks[0].id).project;
  const lookup = async (id: string) => blobs.get(id) ?? null;
  const fast = await createFrameRenderer(p, lookup, { width: 320, height: 180, readback: true, fast: true });
  const slow = await createFrameRenderer(p, lookup, { width: 320, height: 180, readback: true, fast: false });
  const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let d = 0;
    for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return d / ((a.length / 4) * 3);
  };
  const out: Array<{ t: number; same: number; neighbour: number; px?: number[][] }> = [];
  let fastMs = 0;
  let slowMs = 0;
  try {
    for (const t of times) {
      let s = performance.now();
      await fast.render(t);
      fastMs += performance.now() - s;
      const a = fast.pixels();
      s = performance.now();
      await slow.render(t);
      slowMs += performance.now() - s;
      const b = slow.pixels();
      await slow.render(t + 1 / 30);
      const at = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 3));
      out.push({ t, same: diff(a, b), neighbour: diff(a, slow.pixels()), px: [at(a, 60, 50), at(b, 60, 50), at(a, 200, 100), at(b, 200, 100)] });
    }
    return { out, fastMs, slowMs, stats: { ...fast.stats } };
  } finally {
    fast.close();
    slow.close();
  }
};

(window as unknown as { __demux: unknown }).__demux = { demuxVideo };
document.title = 'harness-ready';
