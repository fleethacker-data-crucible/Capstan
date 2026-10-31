// Theme presets: named bundles of colours and font stacks. Today a theme sets the canvas background
// (applyThemeToProject); the annotations area reads `colors` and `fonts` for default text, shape and
// highlight styles. Fonts are system stacks only: Capstan makes no network requests, so nothing is
// downloaded and a stack must resolve on a stock Windows PC.

export type FontRole = 'heading' | 'body' | 'mono';

/** Font stack names a theme can pick from, and the CSS/canvas `font-family` each stands for. */
export const FONT_STACKS = {
  ui: '"Segoe UI", system-ui, -apple-system, Arial, sans-serif',
  display: '"Segoe UI Semibold", "Segoe UI", system-ui, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif',
  mono: 'Consolas, "Cascadia Mono", "Courier New", monospace',
} as const;

export type FontStackName = keyof typeof FONT_STACKS;

export interface Theme {
  id: string;
  name: string;
  colors: {
    /** Canvas background. */
    background: string;
    /** Panels, callout fills, lower thirds. */
    surface: string;
    text: string;
    mutedText: string;
    accent: string;
    /** Highlights and spotlights. */
    highlight: string;
  };
  fonts: Record<FontRole, FontStackName>;
}

export const THEMES: readonly Theme[] = [
  {
    id: 'night-watch',
    name: 'Night watch',
    colors: { background: '#0f1b2d', surface: '#1b2a41', text: '#f2f5fa', mutedText: '#a9b6c9', accent: '#d9a441', highlight: '#ffd166' },
    fonts: { heading: 'display', body: 'ui', mono: 'mono' },
  },
  {
    id: 'chart-room',
    name: 'Chart room',
    colors: { background: '#f4efe4', surface: '#ffffff', text: '#1d2733', mutedText: '#55606e', accent: '#a5701c', highlight: '#f2b705' },
    fonts: { heading: 'serif', body: 'ui', mono: 'mono' },
  },
  {
    id: 'clean-white',
    name: 'Clean white',
    colors: { background: '#ffffff', surface: '#eef1f5', text: '#14181f', mutedText: '#5b6573', accent: '#2563eb', highlight: '#fde047' },
    fonts: { heading: 'display', body: 'ui', mono: 'mono' },
  },
  {
    id: 'slate',
    name: 'Slate',
    colors: { background: '#20242b', surface: '#2c323b', text: '#eceff4', mutedText: '#9aa4b2', accent: '#4ade80', highlight: '#facc15' },
    fonts: { heading: 'ui', body: 'ui', mono: 'mono' },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    colors: { background: '#2b1630', surface: '#442250', text: '#fff4ec', mutedText: '#e0bfd0', accent: '#ff7a59', highlight: '#ffd29d' },
    fonts: { heading: 'rounded', body: 'rounded', mono: 'mono' },
  },
];

export const DEFAULT_THEME_ID = 'night-watch';

export function getTheme(id: string | undefined): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/** The `font-family` string for one of a theme's roles. */
export function themeFontStack(theme: Theme, role: FontRole): string {
  return FONT_STACKS[theme.fonts[role]];
}

export function fontStack(name: FontStackName): string {
  return FONT_STACKS[name];
}

/** Applies a theme to a project: today, the canvas background. Returns the same object if unchanged. */
export function applyThemeToProject<P extends { background: string }>(project: P, theme: Theme): P {
  return project.background === theme.colors.background ? project : { ...project, background: theme.colors.background };
}
