import { useCallback, useSyncExternalStore } from 'react';

/** Safari < 16.4 only has the prefixed API. */
type LegacyDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type LegacyElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = () => document as LegacyDocument;
const current = () => doc().fullscreenElement ?? doc().webkitFullscreenElement ?? null;

function subscribe(onChange: () => void) {
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  return () => {
    document.removeEventListener('fullscreenchange', onChange);
    document.removeEventListener('webkitfullscreenchange', onChange);
  };
}

/**
 * The Fullscreen API as state. It follows the browser, so leaving with Esc (which the browser handles itself, before
 * any page key handler) or the browser's own UI keeps the button right. The whole document goes fullscreen, so pages,
 * dialogs and the command palette keep working inside it. `supported` is false on iPhone, where there is no API.
 */
export function useFullscreen() {
  const active = useSyncExternalStore(subscribe, () => current() !== null);
  const supported =
    typeof document !== 'undefined' &&
    Boolean(doc().fullscreenEnabled ?? doc().webkitFullscreenEnabled);

  const toggle = useCallback(() => {
    if (current()) {
      void (doc().exitFullscreen?.() ?? doc().webkitExitFullscreen?.());
      return;
    }
    const el = document.documentElement as LegacyElement;
    const ask = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    // A refusal (no user gesture, a permissions policy) leaves the page as it was; nothing to report.
    void Promise.resolve(ask?.()).catch(() => undefined);
  }, []);

  return { active, supported, toggle };
}
