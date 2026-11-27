import { useTranslation } from 'react-i18next';
import { Loader2, Wifi, WifiOff } from 'lucide-react';
import { useSseStore } from '@/lib/sseState';
import { cn } from '@/lib/utils';

/** After this many failed attempts in a row the label says "Offline" (the server is probably down). */
const OFFLINE_AFTER_ATTEMPTS = 3;

/**
 * State of the live stream (`GET /api/events`) for the header. Never colour only: icon + text label.
 * While it is not "Live", views fall back to 30 s polling (`useFallbackPollMs`).
 */
export function ConnectionIndicator({ className }: { className?: string }) {
  const state = useSseStore((s) => s.state);
  const attempt = useSseStore((s) => s.attempt);
  const lastEventAt = useSseStore((s) => s.lastEventAt);
  const { t } = useTranslation();

  const offline = state === 'reconnecting' && attempt >= OFFLINE_AFTER_ATTEMPTS;
  const view =
    state === 'live'
      ? {
          label: t('shell.connection.live'),
          Icon: Wifi,
          tone: 'text-success',
          hint: t('shell.connection.liveHint'),
        }
      : offline
        ? {
            label: t('shell.connection.offline'),
            Icon: WifiOff,
            tone: 'text-destructive',
            hint: t('shell.connection.offlineHint'),
          }
        : {
            label:
              state === 'connecting'
                ? t('shell.connection.connecting')
                : t('shell.connection.reconnecting'),
            Icon: Loader2,
            tone: 'text-warning',
            hint: t('shell.connection.pausedHint'),
          };
  const last = lastEventAt
    ? t('shell.connection.lastUpdate', { time: new Date(lastEventAt).toLocaleTimeString() })
    : '';

  return (
    <div
      role="status"
      aria-live="polite"
      title={`${view.hint}${last}`}
      className={cn('flex items-center gap-1.5 text-xs', view.tone, className)}
    >
      <view.Icon
        aria-hidden="true"
        className={cn('size-3.5', view.Icon === Loader2 && 'motion-safe:animate-spin')}
      />
      <span>{view.label}</span>
    </div>
  );
}
