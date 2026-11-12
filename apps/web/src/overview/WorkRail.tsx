import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { FocusList, useFocusCount } from '@/kpi/TodaysFocus';
import { cn } from '@/lib/utils';
import { ActionCenterList } from './ActionCenter';
import { FOCUS_LIMIT } from './FocusPanel';
import type { ActionCenter } from './model';
import { CountBadge, ToneDot } from './Panel';
import { calmTone } from './tone';

type Tab = 'needs' | 'focus';

/**
 * The Living Workspace's right rail: one Action Center with "Needs attention" and "Today's focus".
 * It opens on Needs attention whenever something needs you (or before that is known), and keeps the user's pick after.
 * A tablist with arrow keys; each tab keeps its count, so nothing important hides behind the other tab.
 */
export function WorkRail({
  center,
  errors,
  loading,
  offDuty,
  className,
}: {
  center: ActionCenter;
  errors: readonly unknown[];
  loading: boolean;
  offDuty: boolean;
  className?: string;
}) {
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (loading || center.total > 0 ? 'needs' : 'focus');
  const focusCount = useFocusCount(FOCUS_LIMIT);
  const tone = calmTone(center.tone, offDuty);
  const id = useId();
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ needs: null, focus: null });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    const next: Tab =
      e.key === 'Home' ? 'needs' : e.key === 'End' ? 'focus' : tab === 'needs' ? 'focus' : 'needs';
    setPicked(next);
    refs.current[next]?.focus();
  };

  const tabs: { value: Tab; label: string; count: number | null }[] = [
    { value: 'needs', label: 'Needs attention', count: loading ? null : center.total },
    { value: 'focus', label: "Today's focus", count: focusCount?.total ?? null },
  ];

  return (
    <section
      aria-label="Action Center"
      className={cn(
        'ov-panel flex min-h-0 min-w-0 flex-col border-t border-foreground/80 text-card-foreground',
        className,
      )}
    >
      <div className="flex items-center gap-2 pt-2">
        <h2 className="sr-only">Action Center</h2>
        <div
          role="tablist"
          aria-label="Action Center"
          className="grid w-full grid-cols-2 border-b border-hairline"
          onKeyDown={onKey}
        >
          {tabs.map((t) => {
            const on = tab === t.value;
            return (
              <button
                key={t.value}
                ref={(el) => {
                  refs.current[t.value] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-${t.value}-tab`}
                aria-selected={on}
                aria-controls={`${id}-${t.value}-panel`}
                tabIndex={on ? 0 : -1}
                onClick={() => setPicked(t.value)}
                className={cn(
                  '-mb-px flex min-h-10 min-w-0 items-center justify-center gap-2 border-b-2 px-2 type-micro outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  on
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.value === 'needs' && center.total > 0 && <ToneDot tone={tone} />}
                <span className="truncate">{t.label}</span>
                {t.count !== null && (
                  <CountBadge count={t.count} tone={t.value === 'needs' ? tone : 'info'} />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id={`${id}-${tab}-panel`}
        aria-labelledby={`${id}-${tab}-tab`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {tab === 'needs' ? (
          <ActionCenterList center={center} errors={errors} loading={loading} offDuty={offDuty} />
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Now · this month&apos;s running SLA timers, least time left first
            </p>
            <FocusList limit={FOCUS_LIMIT} compact />
          </div>
        )}
      </div>
    </section>
  );
}
