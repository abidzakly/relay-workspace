import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { KpiCardRow } from '@relay/shared';
import { useNow } from '@/lib/useNow';
import { AssignedAtDialog } from './AssignedAtDialog';
import { slaTimeLabel } from './model';
import { AssignedAtFlags, SlaBadge } from './SlaBits';

/** The SLA line of a board card: state, time, assigned-at flags and the way to correct it. */
export function SlaSlot({ row }: { row: KpiCardRow }) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const time = slaTimeLabel(row.sla, now);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <SlaBadge sla={row.sla} />
      {time && <span className="text-muted-foreground">{time}</span>}
      <AssignedAtFlags assignedAt={row.assignedAt} />
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={`Set assigned-at for “${row.title}”`}
        title="Set assigned-at"
        className="ml-auto rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <CalendarClock className="size-3.5" aria-hidden />
      </button>
      {editing && (
        <AssignedAtDialog
          target={{ cardId: row.cardId, title: row.title, assignedAt: row.assignedAt }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
