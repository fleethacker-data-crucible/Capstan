// Per-clip audio settings beyond volume: fades, levelling, noise reduction, ducking.
// Owned by the audio area; the player and the export mixer both read these.

export interface ClipAudio {
  /** Seconds of fade-in at the start of the clip and fade-out at its end. */
  fadeIn?: number;
  fadeOut?: number;
}

export function parseClipAudio(_input: unknown): ClipAudio | undefined {
  return undefined;
}
