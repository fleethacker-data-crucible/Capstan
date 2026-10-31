// A few extra icons for the clip-editing controls, drawn to match icons.tsx (Lucide style: 24 px grid,
// 1.75 px stroke, currentColor). Kept apart because icons.tsx is generated.
import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  crop: <><path d="M6 2v14a2 2 0 0 0 2 2h14" /><path d="M18 22V8a2 2 0 0 0-2-2H2" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  group: <><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><rect width="7" height="5" x="7" y="7" rx="1" /><rect width="7" height="5" x="10" y="12" rx="1" /></>,
  freeze: <><path d="M12 2v20" /><path d="m4.9 7 14.2 10" /><path d="M4.9 17 19.1 7" /><path d="m9 4 3 2 3-2" /><path d="m9 20 3-2 3 2" /></>,
  speed: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  closeGaps: <><path d="m7 15-5-3 5-3" /><path d="m17 9 5 3-5 3" /><path d="M12 5v14" /></>,
  detach: <><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z" /><path d="M16 9a5 5 0 0 1 0 6" /><path d="M20 6l-3 3" /></>,
};

export type EditIconName = keyof typeof paths;

export function EditIcon({ name, size = 16 }: { name: EditIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {paths[name]}
    </svg>
  );
}
