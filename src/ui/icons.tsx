// Small inline icon set (stroke icons on a 20px grid). Bundled, so no icon font or CDN.
import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  record: <circle cx="10" cy="10" r="5.5" fill="currentColor" stroke="none" />,
  import: (
    <>
      <path d="M10 3v9m0 0-3.5-3.5M10 12l3.5-3.5" />
      <path d="M3.5 13v2.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V13" />
    </>
  ),
  undo: <path d="M7 5 3.5 8.5 7 12M4 8.5h8a4 4 0 0 1 0 8H9" />,
  redo: <path d="M13 5l3.5 3.5L13 12m3-3.5H8a4 4 0 0 0 0 8h3" />,
  split: (
    <>
      <path d="M10 2.5v15" />
      <path d="M3 6.5h4.5v7H3m14-7h-4.5v7H17" />
    </>
  ),
  trash: <path d="M4 6h12M8 6V4h4v2m-6 0 .7 10h6.6L14 6" />,
  play: <path d="M6.5 4.5v11l9-5.5-9-5.5Z" fill="currentColor" />,
  pause: (
    <>
      <path d="M6.5 4.5v11M13.5 4.5v11" strokeWidth="2.6" />
    </>
  ),
  stepBack: <path d="M5 4.5v11M15 4.5l-7 5.5 7 5.5V4.5Z" />,
  stepForward: <path d="M15 4.5v11M5 4.5l7 5.5-7 5.5V4.5Z" />,
  toStart: <path d="M4.5 4.5v11M16 4.5 9 10l7 5.5M10 4.5 3 10" />,
  export: (
    <>
      <path d="M10 13V3.5m0 0L6.5 7M10 3.5 13.5 7" />
      <path d="M3.5 12v3.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V12" />
    </>
  ),
  eye: (
    <>
      <path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" />
      <circle cx="10" cy="10" r="2.3" />
    </>
  ),
  eyeOff: <path d="M3 3l14 14M8.3 5A8 8 0 0 1 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.4 3M5 6.6A13.5 13.5 0 0 0 2 10s3 5.5 8 5.5a7.6 7.6 0 0 0 3.4-.8" />,
  speaker: (
    <>
      <path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3v-5Z" />
      <path d="M13.5 7a4 4 0 0 1 0 6" />
    </>
  ),
  speakerOff: <path d="M3.5 7.5h3l4-3.5v12l-4-3.5h-3v-5ZM13.5 8l4 4m0-4-4 4" />,
  lock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 5.8-1" />
    </>
  ),
  plus: <path d="M10 4v12M4 10h12" />,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  zoomIn: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4 4M6.5 8.5h4M8.5 6.5v4" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4 4M6.5 8.5h4" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M7 4v12M13 4v12M3 8h4m6 0h4M3 12h4m6 0h4" />
    </>
  ),
  wave: <path d="M2.5 10h1.5m2-4v8m3-10v12m3-9v6m3-4v2m2-1h1.5" />,
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <circle cx="7.5" cy="8.5" r="1.4" />
      <path d="m3.5 14.5 4-4 3 3 2-2 4 4" />
    </>
  ),
  newDoc: <path d="M5 2.5h6.5L15 6v11.5H5v-15ZM11 2.5V6.5h4M10 9v6M7 12h6" />,
  open: <path d="M2.5 15.5v-11h5l1.5 2h8v9h-14.5Z" />,
  save: <path d="M4 3.5h9.5L16.5 6.5v10h-12.5V3.5ZM7 3.5v4h6v-4M7 16.5v-5h6v5" />,
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.2" />
      <path d="M13 7V4.5a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1V12a1 1 0 0 0 1 1H7" />
    </>
  ),
  magnet: <path d="M5 3.5v6.5a5 5 0 0 0 10 0V3.5h-3.5v6.5a1.5 1.5 0 0 1-3 0V3.5H5ZM5 7h3.5m3 0H15" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
