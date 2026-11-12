import { useSyncExternalStore } from 'react';

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const q = matchMedia(query);
      q.addEventListener('change', onChange);
      return () => q.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
  );
}

export const useReducedMotion = () => useMedia('(prefers-reduced-motion: reduce)');
/** Phones and narrow windows: lighter rendering, a stepped-back camera, pages full screen. */
export const useNarrow = () => useMedia('(max-width: 767px)');
export const useCoarsePointer = () => useMedia('(pointer: coarse)');
/**
 * A phone held upright: narrower than any tablet (the smallest, iPad mini, is 744 px portrait) and taller than
 * wide. Sprint Harbor magnifies zones here because the scene's crates shrink to ~10 px.
 */
export const usePhonePortrait = () => useMedia('(max-width: 599px) and (orientation: portrait)');

export function useHidden(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
    () => document.hidden,
  );
}
