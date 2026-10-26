// Fleet shell preferences (docs/UNIFIED-UI.md sections 3.1 and 5) and dialog behaviour (section 6).
import { useEffect, type RefObject } from 'react';

export type ThemeChoice = 'system' | 'dark' | 'light';
const THEME_KEY = 'capstan-theme';
const SIDEBAR_KEY = 'capstan-sidebar';

// Storage can be unavailable (private windows, blocked site data); the app must work without it.
function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* not persisted; the choice still applies for this session */
  }
}

export function readTheme(): ThemeChoice {
  const v = load(THEME_KEY);
  return v === 'dark' || v === 'light' ? v : 'system';
}

/** Follows Windows by default; `dark` or `light` sets <html data-theme> and is remembered. */
export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  save(THEME_KEY, choice === 'system' ? null : choice);
}

export const nextTheme = (t: ThemeChoice): ThemeChoice => (t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system');
export const themeName = (t: ThemeChoice) => (t === 'system' ? 'Follow Windows' : t === 'dark' ? 'Night watch' : 'Chart room');

export function readSidebarCollapsed(): boolean {
  // The editor needs the width, so the sidebar starts as icons only until someone expands it.
  return load(SIDEBAR_KEY) !== 'expanded';
}
export function saveSidebarCollapsed(collapsed: boolean) {
  save(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour: focus moves into the dialog, Tab stays inside it, and Esc closes it when
 * `onEscape` is given (pass undefined while closing isn't allowed, e.g. during a recording).
 * Focus returns to where it was when the dialog closes.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onEscape: (() => void) | undefined) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, [ref]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      } else if (e.key === 'Tab') {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const firstItem = items[0];
        const lastItem = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstItem) {
          e.preventDefault();
          lastItem.focus();
        } else if (!e.shiftKey && document.activeElement === lastItem) {
          e.preventDefault();
          firstItem.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ref, onEscape]);
}
