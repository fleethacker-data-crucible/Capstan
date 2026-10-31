// What the demuxers hand to the sequential decoder: the video track's sample table, with each
// sample's place in the file, so frames can be decoded in order without seeking an element.

export interface VideoSample {
  /** Byte offset of the sample's data in the file. */
  offset: number;
  size: number;
  /** Presentation time in microseconds (after any edit-list shift). */
  pts: number;
  /** Duration in microseconds. */
  duration: number;
  key: boolean;
}

export interface VideoTrackInfo {
  container: 'mp4' | 'webm';
  /** WebCodecs codec string, such as "avc1.64001f", "vp09.00.10.08", "av01.0.04M.08" or "hvc1.1.6.L93.B0". */
  codec: string;
  /** Decoder configuration record (avcC for H.264, hvcC for HEVC, av1C for AV1), when the codec needs one. */
  description?: Uint8Array;
  width: number;
  height: number;
  /** In decode order. */
  samples: VideoSample[];
  /** True for an MP4 made of moof/mdat fragments. */
  fragmented?: boolean;
}

/**
 * What a demuxer found. `info` is null when the fast path cannot read the file; `container` and
 * `codec` still say what was seen (when it could be told), and `note` says why it was declined,
 * so the export can explain why it seeks.
 */
export interface DemuxRead {
  info: VideoTrackInfo | null;
  container: 'mp4' | 'webm' | null;
  codec: string | null;
  note: string;
}
