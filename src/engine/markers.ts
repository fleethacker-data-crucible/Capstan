// Timeline markers, exported as chapters. Owned by the editing area.

export interface Marker {
  id: string;
  /** Seconds on the timeline. */
  time: number;
  name: string;
  /** Written to the exported file as a chapter. */
  chapter: boolean;
}

export function parseMarkers(_input: unknown): Marker[] {
  return [];
}
