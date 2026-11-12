import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/Badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { describeError } from '@/lib/api';
import { useKpiFocus } from '@/lib/kpiApi';
import { useNow } from '@/lib/useNow';
import { slaTimeLabel } from './model';
import { AssignedAtFlags, SlaBadge } from './SlaBits';
import { safeHref } from '@/lib/utils';
import { EffortChip, EffortFit } from '@/components/EffortChip';

/**
 * The focus rows themselves. `compact` (Overview) keeps the SLA state and time left and drops the effort and
 * assigned-at chips, which live on the KPI page.
 */
export function FocusList({ limit = 5, compact = false }: { limit?: number; compact?: boolean }) {
  const focus = useKpiFocus(limit);
  const now = useNow();
  const rows = focus.data?.rows ?? [];
  return (
    <>
      {focus.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {focus.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load today&apos;s focus</AlertTitle>
          <AlertDescription>{describeError(focus.error)}</AlertDescription>
        </Alert>
      )}
      {focus.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing this month needs a push right now.</p>
      )}
      {rows.length > 0 && (
        <ol className="flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.cardId} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <div className="flex items-start gap-1 text-sm">
                <span className="min-w-0 flex-1 font-medium break-words">{row.title}</span>
                {row.url && (
                  <a
                    href={safeHref(row.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open “${row.title}” in Notion`}
                    className="-m-1.5 shrink-0 p-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <SlaBadge sla={row.sla} />
                <span className="text-muted-foreground">{slaTimeLabel(row.sla, now)}</span>
                {row.type && <Badge variant="outline">{row.type}</Badge>}
                {!compact && (
                  <>
                    <EffortChip point={row.point} />
                    <EffortFit point={row.point} deadline={row.sla.deadline} now={now} />
                    <AssignedAtFlags assignedAt={row.assignedAt} />
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** "3 of 7" once the list is cut; just the count otherwise. Null while loading. */
export function useFocusCount(limit = 5): { shown: number; total: number } | null {
  const focus = useKpiFocus(limit);
  if (!focus.data) return null;
  return { shown: focus.data.rows.length, total: focus.data.total };
}

/**
 * Today's focus: this month's actionable running timers, least time left first. Only cards that can still
 * move this month's KPIs. Self-contained, so Overview can drop it in.
 */
export function TodaysFocus({ limit = 5, className }: { limit?: number; className?: string }) {
  const count = useFocusCount(limit);
  return (
    <Card {...(className ? { className } : {})}>
      <CardHeader>
        <CardTitle>
          Today&apos;s focus
          {count && count.total > count.shown && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {count.shown} of {count.total}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <FocusList limit={limit} />
      </CardContent>
    </Card>
  );
}
