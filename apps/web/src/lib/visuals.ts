import { useUiStore, type VisualPage } from '@/store/ui';

/** Release and Builds keep their visuals when the "other pages" switch is off: their start gestures live there. */
const OWN_SWITCH_ONLY: ReadonlySet<VisualPage> = new Set(['builds', 'release']);

/** Whether this page shows its visual (Settings, Page visuals). New pages default to on. */
export function useVisual(page: VisualPage): boolean {
  return useUiStore(
    (s) => (s.visuals?.[page] ?? true) && (OWN_SWITCH_ONLY.has(page) || s.otherVisuals !== false),
  );
}
