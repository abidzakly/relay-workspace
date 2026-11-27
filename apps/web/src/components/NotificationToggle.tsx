import { useTranslation } from 'react-i18next';
import { BellOff, BellPlus, BellRing } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrowserPush } from '@/lib/push';

/**
 * Header toggle "Enable notifications". The browser's permission prompt only appears on click.
 * `compact` = icon-only for the mobile top bar. Never colour alone: the label / tooltip always say the state.
 */
export function NotificationToggle({ compact = false }: { compact?: boolean }) {
  const p = useBrowserPush();
  const { t } = useTranslation();
  const on = p.kind === 'on';
  const actionable = p.kind === 'off' || p.kind === 'on';
  // BellPlus, not Bell: on the phone header this sits beside the inbox bell and must not read as a second one.
  const Icon = on ? BellRing : p.kind === 'off' ? BellPlus : BellOff;
  const label =
    p.kind === 'on'
      ? t('shell.push.on')
      : p.kind === 'denied'
        ? t('shell.push.denied')
        : p.kind === 'off'
          ? t('shell.push.off')
          : p.kind === 'install'
            ? t('shell.push.install')
            : t('shell.push.unavailable');
  const title = p.error ? `${label}: ${p.error}` : p.hint;

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant={compact ? 'ghost' : 'outline'}
        size={compact ? 'icon' : 'sm'}
        disabled={!actionable || p.busy}
        aria-pressed={on}
        aria-label={label}
        title={title}
        onClick={p.toggle}
        className={compact ? undefined : 'w-full justify-start'}
      >
        <Icon className={on ? 'text-success' : undefined} />
        {compact ? null : <span>{p.busy ? t('shell.push.working') : label}</span>}
      </Button>
      {!compact && p.error ? (
        <p role="alert" className="text-xs text-destructive">
          {p.error}
        </p>
      ) : null}
    </div>
  );
}
