import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useUnreadNotifications } from '@/lib/notificationApi';

const MAX_SHOWN = 99;

/**
 * Link to the notification center. The badge counts unread rows that still need you, so stale and already-handled
 * ones do not inflate it. Never colour only: the number is the signal.
 */
export function NotificationBell() {
  const data = useUnreadNotifications().data;
  const { t } = useTranslation();
  const unread = data?.needsAction ?? 0;
  const other = Math.max(0, (data?.unread ?? 0) - unread);
  const label =
    unread > 0
      ? other > 0
        ? t('shell.bell.needsActionAndOther', { count: unread, other })
        : t('shell.bell.needsAction', { count: unread })
      : other > 0
        ? t('shell.bell.otherOnly', { other })
        : t('shell.bell.plain');
  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link to="/notifications" aria-label={label} title={label}>
        <Bell aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-micro font-semibold text-destructive-foreground"
          >
            {unread > MAX_SHOWN ? `${MAX_SHOWN}+` : unread}
          </span>
        )}
      </Link>
    </Button>
  );
}
