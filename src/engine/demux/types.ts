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
  /** WebCodecs codec string, such as "avc1.64001f" or "vp09.00.10.08". */
  codec: string;
  /** Decoder configuration record (avcC for H.264), when the codec needs one. */
  description?: Uint8Array;
  width: number;
  height: number;
  /** In decode order. */
  samples: VideoSample[];
}
