import { Link } from 'react-router';
import { FocusList, useFocusCount } from '@/kpi/TodaysFocus';
import { Panel } from './Panel';

export const FOCUS_LIMIT = 5;

/** "3 of 7", or just the count when nothing is cut. */
export function FocusCount() {
  const count = useFocusCount(FOCUS_LIMIT);
  if (!count) return null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {count.total > count.shown ? `${count.shown} of ${count.total}` : count.total}
    </span>
  );
}

/** Today's focus: the next timers to push, least time left first, metadata kept short. */
export function FocusPanel({ className }: { className?: string }) {
  return (
    <Panel
      n={5}
      title="Today's focus"
      context="Now · this month's running SLA timers, least time left first"
      actions={
        <>
          <FocusCount />
          <Link to="/kpi" className="text-xs text-primary-ink underline-offset-4 hover:underline">
            Open KPI
          </Link>
        </>
      }
      className={className}
    >
      <FocusList limit={FOCUS_LIMIT} compact />
    </Panel>
  );
}
