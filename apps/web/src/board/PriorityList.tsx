import { Rocket } from 'lucide-react';
import { BULK_START_MAX } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { EffortChip } from '@/components/EffortChip';
import { describeError } from '@/lib/api';
import { useKpiFocus } from '@/lib/kpiApi';
import { useNow } from '@/lib/useNow';
import { slaTimeLabel } from '@/kpi/model';
import { SlaBadge } from '@/kpi/SlaBits';

/**
 * The Board's "Work on next": the same ranking as Today's focus (this month's running SLA timers, least time left
 * first), capped at what one bulk start can take. "Start all with agents" hands the startable ones to the bulk start.
 */
export function PriorityList({
  canStart,
  onPick,
  onStartAll,
}: {
  /** The card is on the board and has a Branch formula, so an agent can start it. */
  canStart: (cardId: string) => boolean;
  onPick: (cardId: string) => void;
  onStartAll: (cardIds: string[]) => void;
}) {
  const focus = useKpiFocus(BULK_START_MAX);
  const now = useNow();
  const rows = focus.data?.rows ?? [];
  const total = focus.data?.total ?? 0;
  const startable = rows.filter((r) => canStart(r.cardId)).map((r) => r.cardId);
  const skipped = rows.length - startable.length;

  return (
    <section
      aria-label="Work on next"
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">
            Work on next
            {rows.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {total > rows.length ? `${rows.length} of ${total}` : rows.length}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            This month&apos;s running SLA timers, least time left first
          </p>
        </div>
        <Button
          size="sm"
          disabled={startable.length === 0}
          title={
            skipped > 0
              ? `${startable.length} of ${rows.length} can start (no Branch formula or not on the board for the rest)`
              : 'Start each prioritized card with its own agent'
          }
          onClick={() => onStartAll(startable)}
        >
          <Rocket />
          Start all with agents ({startable.length})
        </Button>
      </header>

      {focus.isPending && <p className="text-xs text-muted-foreground">Loading…</p>}
      {focus.isError && (
        <p className="text-xs text-muted-foreground">
          Priority list is unavailable: {describeError(focus.error)}
        </p>
      )}
      {focus.isSuccess && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing this month needs a push right now.</p>
      )}
      {rows.length > 0 && (
        <ol className="flex flex-col divide-y">
          {rows.map((row, i) => (
            <li key={row.cardId} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
              <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">
                {i + 1}.
              </span>
              <button
                type="button"
                onClick={() => onPick(row.cardId)}
                className="min-w-0 flex-1 text-left font-medium break-words underline-offset-4 hover:underline"
                title="Show this card on the board"
              >
                {row.title}
              </button>
              <span className="flex flex-wrap items-center gap-1 text-xs">
                <SlaBadge sla={row.sla} />
                <span className="text-muted-foreground">{slaTimeLabel(row.sla, now)}</span>
                <EffortChip point={row.point} />
                {!canStart(row.cardId) && (
                  <span className="text-muted-foreground">· cannot start</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
