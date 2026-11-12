import { useUiStore } from '@/store/ui';

export type HapticLevel = 'tick' | 'pop' | 'burst' | 'event';

const PATTERN: Record<HapticLevel, number | number[]> = {
  tick: 8,
  pop: 16,
  burst: [20, 40, 30],
  event: [30, 60, 30, 60, 50],
};

/** Best effort: `navigator.vibrate` does not exist on iOS Safari, so this does nothing there, silently. */
export function vibrate(level: HapticLevel): void {
  if (!useUiStore.getState().hapticsOn) return;
  if (typeof navigator.vibrate !== 'function') return;
  // Chrome logs an error for a vibration before the first tap, even inside try/catch, so don't ask yet.
  if (navigator.userActivation?.hasBeenActive === false) return;
  try {
    navigator.vibrate(PATTERN[level]);
  } catch {
    /* no haptics, then */
  }
}
