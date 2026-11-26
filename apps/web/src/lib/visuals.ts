import { useUiStore, type LogView, type LogViewPage, type VisualPage } from '@/store/ui';

/** Release and Builds keep their visuals when the "other pages" switch is off: their start gestures live there. */
const OWN_SWITCH_ONLY: ReadonlySet<VisualPage> = new Set(['builds', 'release']);

/** Whether this page shows its visual (Settings, Page visuals). New pages default to on. */
export function useVisual(page: VisualPage): boolean {
  return useUiStore(
    (s) => (s.visuals?.[page] ?? true) && (OWN_SWITCH_ONLY.has(page) || s.otherVisuals !== false),
  );
}

const LOG_VIEW_OPTIONS = [
  { value: 'visual', label: 'Visual' },
  { value: 'raw', label: 'Logs' },
] as const;

/**
 * Release and Builds: whether a job shows its live picture or its plain log, and the switch's options. With the page's
 * visual off in Settings, only the log is offered.
 */
export function useLogView(page: LogViewPage) {
  const showVisual = useVisual(page);
  const chosen = useUiStore((s) => s.logView?.[page] ?? 'visual');
  const setLogView = useUiStore((s) => s.setLogView);
  const view: LogView = showVisual ? chosen : 'raw';
  return {
    view,
    canSwitch: showVisual,
    options: LOG_VIEW_OPTIONS,
    setView: (v: LogView) => setLogView(page, v),
  };
}
