import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { pathEnabled } from '@relay/shared';
import { NAV } from '@/components/nav';
import { featuresNow } from './features';
import { usePaletteStore } from '@/store/palette';
import { nextTheme, useUiStore } from '@/store/ui';
import { post } from './api';
import { queryClient } from './queryClient';

const CHORD_TIMEOUT_MS = 1500;

export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
export const PALETTE_KEY_LABEL = IS_MAC ? '⌘K' : 'Ctrl+K';

/** Ctrl+K everywhere, and Cmd+K as well on macOS. */
export function isPaletteKey(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== 'k' || e.shiftKey || e.altKey) return false;
  return e.ctrlKey !== e.metaKey && (e.ctrlKey || IS_MAC);
}

const TYPING_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm';

function isTyping(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest(TYPING_SELECTOR) !== null;
}

/**
 * Asks the server to sync, and re-reads what is on screen. The sync's own changes arrive over SSE. A refused or failed
 * request still re-reads the cache. The server's guard absorbs repeats; this writes nothing to GitLab or Notion.
 */
export function refreshData(): void {
  void post('/api/sync/refresh')
    .catch(() => undefined)
    .finally(() => void queryClient.invalidateQueries());
}

/**
 * The app-wide keys. None fires while typing in a field or in the xterm panel, or while any dialog is open, so a key
 * can never act behind a confirm dialog. None writes to GitLab or Notion, and dry-run has no key on purpose.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let chordTimer: ReturnType<typeof setTimeout> | null = null;
    const endChord = () => {
      if (chordTimer) clearTimeout(chordTimer);
      chordTimer = null;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const chord = chordTimer !== null;
      endChord();
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;

      const ui = usePaletteStore.getState();
      if (isPaletteKey(e)) {
        e.preventDefault();
        ui.setPaletteOpen(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (chord) {
        const target = NAV.find((item) => item.chord === e.key);
        // A switched-off feature has no shortcut either.
        if (target && !pathEnabled(target.to, featuresNow())) return;
        if (target) {
          e.preventDefault();
          void navigate(target.to);
        }
        return;
      }
      switch (e.key) {
        case 'g':
          chordTimer = setTimeout(endChord, CHORD_TIMEOUT_MS);
          break;
        case '?':
          e.preventDefault();
          ui.setHelpOpen(true);
          break;
        case 'r':
          refreshData();
          break;
        case 't': {
          const { theme, setTheme } = useUiStore.getState();
          setTheme(nextTheme(theme));
          break;
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      endChord();
    };
  }, [navigate]);
}
