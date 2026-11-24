import { useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import type { KpiCardRow } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { useNow } from '@/lib/useNow';
import { AssignedAtDialog, type AssignedAtTarget } from './AssignedAtDialog';
import { groupSlaRows, slaTimeLabel } from './model';
import { AssignedAtFlags, SlaBadge } from './SlaBits';
import { safeHref } from '@/lib/utils';
import type { SlaFilter } from './viz/store';

const stamp = (at: number | null): string => (at === null ? '—' : new Date(at).toLocaleString());

const TH = 'px-2 pb-2 text-left type-micro font-semibold whitespace-nowrap text-muted-foreground';
const TD = 'px-2 py-2 align-top';

function Row({
  row,
  now,
  showMonth,
  canEdit,
  onEdit,
}: {
  row: KpiCardRow;
  now: number | null;
  showMonth: boolean;
  canEdit: boolean;
  onEdit: (t: AssignedAtTarget) => void;
}) {
  return (
    <tr className="border-t border-hairline">
      <td className={`${TD} min-w-48`}>
        {row.url ? (
          <a
            href={safeHref(row.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium break-words hover:underline"
          >
            {row.title}
          </a>
        ) : (
          <span className="font-medium break-words">{row.title}</span>
        )}
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span>{row.status ?? 'no status'}</span>
          {showMonth && <Badge variant="outline">{row.month}</Badge>}
          {row.sla.estimationInvalid && (
            <Badge
              variant="warning"
              title="The estimation start could not be read, so it was ignored"
            >
              bad estimation
            </Badge>
          )}
        </div>
      </td>
      <td className={TD}>{row.type ?? '—'}</td>
      <td className={TD}>
        <SlaBadge sla={row.sla} />
        <div className="mt-1 text-xs text-muted-foreground">{slaTimeLabel(row.sla, now)}</div>
      </td>
      <td className={`${TD} text-xs whitespace-nowrap`}>{stamp(row.sla.deadline)}</td>
      <td className={`${TD} text-xs`}>
        <div className="whitespace-nowrap">{stamp(row.assignedAt.at)}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <AssignedAtFlags assignedAt={row.assignedAt} />
        </div>
      </td>
      <td className={`${TD} text-xs`}>
        {row.mr ? (
          row.mr.webUrl ? (
            <a
              href={safeHref(row.mr.webUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary-ink hover:underline"
            >
              !{row.mr.iid}
            </a>
          ) : (
            <span>!{row.mr.iid}</span>
          )
        ) : (
          <span className="text-muted-foreground">no MR</span>
        )}
        <div className="mt-1 flex flex-wrap gap-1">
          {row.mr?.conflict && (
            <Badge
              variant="warning"
              title="This link is flagged as a duplicate or mismatch, so the clock stop may be wrong"
            >
              link conflict
            </Badge>
          )}
          {row.ignoredClosedMrs > 0 && (
            <Badge
              variant="outline"
              title="Linked MRs closed without merging do not stop the clock"
            >
              {row.ignoredClosedMrs} closed, ignored
            </Badge>
          )}
        </div>
      </td>
      <td className={TD}>
        {canEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`Set assigned-at for “${row.title}”`}
            title="Set assigned-at"
            onClick={() =>
              onEdit({ cardId: row.cardId, title: row.title, assignedAt: row.assignedAt })
            }
          >
            <CalendarClock aria-hidden />
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * The SLA table, grouped the way the scorecard counts cards, so in-flight cards never look like part of the hit-rate.
 * `live` = the month in progress, so running timers follow the clock. A frozen month cannot change, so it has no edit.
 */
export function SlaTable({
  rows,
  month,
  live,
  frozen,
  filter = null,
  onClearFilter,
}: {
  rows: readonly KpiCardRow[];
  month: string;
  live: boolean;
  frozen: boolean;
  /** A chart's click: only these cards. */
  filter?: SlaFilter | null;
  onClearFilter?: () => void;
}) {
  const clock = useNow();
  const now = live ? clock : null;
  const [editing, setEditing] = useState<AssignedAtTarget | null>(null);
  const shown = filter
    ? rows.filter(
        (r) =>
          (!filter.cardId || r.cardId === filter.cardId) &&
          (!filter.type || r.type === filter.type) &&
          (!filter.states || (r.month === month && filter.states.includes(r.sla.state))),
      )
    : rows;
  const groups = groupSlaRows(shown, month);
  const chip = filter && (
    <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Showing</span>
      <span className="inline-flex items-center gap-1 rounded-full bg-terracotta/20 py-0.5 pr-1 pl-3 font-medium">
        {filter.label} ({shown.length})
        <button
          type="button"
          aria-label="Show every card"
          onClick={onClearFilter}
          className="tactile rounded-full p-0.5 hover:bg-foreground/10"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </span>
    </p>
  );

  if (groups.length === 0) {
    return (
      <>
        {chip}
        <p className="text-sm text-muted-foreground">
          {filter ? 'No cards match.' : 'No cards in this month.'}
        </p>
      </>
    );
  }
  return (
    <>
      {chip}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">SLA state of each card in {month}</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Card
              </th>
              <th scope="col" className={TH}>
                Type
              </th>
              <th scope="col" className={TH}>
                SLA
              </th>
              <th scope="col" className={TH}>
                Deadline
              </th>
              <th scope="col" className={TH}>
                Assigned at
              </th>
              <th scope="col" className={TH}>
                MR
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.key}>
              <tr className="border-t border-foreground/40">
                <th colSpan={7} scope="rowgroup" className="px-2 pt-4 pb-1.5 text-left text-xs">
                  <span className="font-semibold">
                    {g.title} ({g.rows.length})
                  </span>
                  <span className="ml-2 font-normal text-muted-foreground">{g.hint}</span>
                </th>
              </tr>
              {g.rows.map((row) => (
                <Row
                  key={row.cardId}
                  row={row}
                  now={now}
                  showMonth={g.key === 'otherMonths'}
                  canEdit={!frozen}
                  onEdit={setEditing}
                />
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {editing && <AssignedAtDialog target={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
