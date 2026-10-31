// Which way an export gets a clip's pictures: decoded in order with WebCodecs ('fast') or by
// seeking a <video> element to every frame ('seek'). Pure, so the choice can be tested and the
// reason shown in the export status when a slow export needs explaining.

export type DecodePath = 'fast' | 'seek';

export interface PathChoice {
  path: DecodePath;
  /** One plain sentence, fit to show in the export status. */
  reason: string;
}

export type CodecFamily = 'h264' | 'vp8' | 'vp9' | 'av1' | 'hevc' | 'other';

/** The codec family of a WebCodecs codec string. */
export function codecFamily(codec: string | null | undefined): CodecFamily {
  const c = (codec ?? '').toLowerCase();
  if (c.startsWith('avc1.') || c.startsWith('avc3.')) return 'h264';
  if (c === 'vp8') return 'vp8';
  if (c.startsWith('vp09.') || c === 'vp9') return 'vp9';
  if (c.startsWith('av01.')) return 'av1';
  if (c.startsWith('hvc1.') || c.startsWith('hev1.')) return 'hevc';
  return 'other';
}

const LABEL: Record<CodecFamily, string> = { h264: 'H.264', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', hevc: 'HEVC', other: 'this codec' };

/** Which codecs the demuxers read in which container. */
const READ: Record<'mp4' | 'webm', CodecFamily[]> = {
  mp4: ['h264', 'vp9', 'av1', 'hevc'],
  webm: ['vp8', 'vp9', 'av1'],
};

/**
 * @param container   what the file is: 'mp4' (plain or fragmented), 'webm', or anything else / null if unknown
 * @param codec       the WebCodecs codec string the demuxer built, or null if it could not tell
 * @param supported   the result of VideoDecoder.isConfigSupported for that codec: true, false, or
 *                    null when the browser could not be asked (no WebCodecs, or the call threw)
 * @param problem     why the demuxer gave up on the file (truncated, corrupt, ...), if it did
 */
export function choosePath(container: string | null | undefined, codec: string | null | undefined, supported: boolean | null | undefined, problem?: string): PathChoice {
  const seek = (reason: string): PathChoice => ({ path: 'seek', reason });
  if (problem) return seek(problem);
  const box = container === 'mp4' || container === 'webm' ? container : null;
  if (!box) return seek('the file is not an MP4 or WebM that the fast path reads');
  const name = box === 'mp4' ? 'MP4' : 'WebM';
  const family = codecFamily(codec);
  if (family === 'other') return seek(`${codec ? `the codec ${codec}` : 'the video codec'} in this ${name} is not one the fast path reads`);
  if (!READ[box].includes(family)) return seek(`${LABEL[family]} in ${name} is not read by the fast path`);
  if (supported === null || supported === undefined) return seek(`could not ask this browser whether it decodes ${LABEL[family]}`);
  if (!supported) {
    return seek(family === 'hevc' ? 'HEVC is only decoded where the browser reports support, and it does not here' : `this browser cannot decode ${LABEL[family]} (${codec}) with WebCodecs`);
  }
  return { path: 'fast', reason: `${LABEL[family]} in ${name}, decoded in order with WebCodecs` };
}

/** How one video file in a project is being decoded, and why. */
export interface DecodeDecision {
  /** The media item's name. */
  media: string;
  path: DecodePath;
  reason: string;
}

/**
 * One short line for the export status: "fast decode" when every video is decoded in order, or
 * which files are being seeked and why, so a slow export can be explained. Empty when the
 * project has no video.
 */
export function describeDecisions(decisions: readonly DecodeDecision[]): string {
  if (!decisions.length) return '';
  const seeks = decisions.filter((d) => d.path === 'seek');
  if (!seeks.length) return 'fast decode';
  return `seeking ${seeks.map((d) => `${d.media} (${d.reason})`).join('; ')}`;
}
