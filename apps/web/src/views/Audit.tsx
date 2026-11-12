import { useMemo, useState } from 'react';
import { ArrowRight, Loader2, Undo2 } from 'lucide-react';
import { AUDIT_ACTORS, type AuditActor, type AuditListEntry } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ApiError, describeError } from '@/lib/api';
import { useAuditLog, useUndoAudit, type AuditFilters } from '@/lib/auditApi';
import { PageTitle } from '@/components/PageTitle';

const BULK_ACTION = 'card.bulkReady';

/** One line for a before/after value; the full JSON is behind "details". */
function summarize(v: AuditListEntry['before']): string {
  if (v === null) return '—';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `${v.length} items`;
  if ('status' in v) return v.status === null ? 'no status' : String(v.status);
  if (Array.isArray(v.cards)) return `${v.cards.length} card(s)`;
  const json = JSON.stringify(v);
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

function UndoControl({ id, label }: { id: number; label: string }) {
  const undo = useUndoAudit();
  const blocked = undo.data?.batch?.blocked ?? [];
  return (
    <div className="flex flex-col items-end gap-2">
      <Button size="sm" variant="outline" disabled={undo.isPending} onClick={() => undo.mutate(id)}>
        {undo.isPending ? (
          <Loader2 className="size-4 motion-safe:animate-spin" />
        ) : (
          <Undo2 className="size-4" />
        )}
        {label}
      </Button>
      {undo.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            Not undone{undo.error instanceof ApiError ? ` (${undo.error.code})` : ''}
          </AlertTitle>
          <AlertDescription>{describeError(undo.error)}</AlertDescription>
        </Alert>
      )}
      {undo.isSuccess && (
        <Alert variant={undo.data.dryRun || blocked.length > 0 ? 'warning' : 'success'}>
          <AlertTitle>
            {undo.data.dryRun
              ? 'Undo simulated (dry-run)'
              : undo.data.batch
                ? `Restored ${undo.data.batch.restored.length} card(s)`
                : 'Undone'}
          </AlertTitle>
          {blocked.length > 0 && (
            <AlertDescription>
              {blocked.map((b) => `${b.title}: ${b.message}`).join(' ')}
            </AlertDescription>
          )}
        </Alert>
      )}
    </div>
  );
}

function Row({ e }: { e: AuditListEntry }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-2">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{e.action}</span>
          <span className="min-w-0 [overflow-wrap:anywhere] text-muted-foreground">
            {e.targetLabel ?? `${e.targetType} ${e.targetId}`}
          </span>
          {e.dryRun && <Badge variant="warning">dry-run</Badge>}
          {e.undoneAt !== null && (
            <Badge variant="secondary">
              undone <TimeAgo at={e.undoneAt} />
            </Badge>
          )}
          {e.undoOf !== null && <Badge variant="outline">reverts #{e.undoOf}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 [overflow-wrap:anywhere]">{summarize(e.before)}</span>
          <ArrowRight className="size-3" aria-label="became" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{summarize(e.after)}</span>
          <span>·</span>
          <TimeAgo at={e.at} />
          <span>· {e.actor}</span>
          <span>· #{e.id}</span>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">details</summary>
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-2">
            {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
          </pre>
        </details>
      </div>
      {e.undoable && e.action !== BULK_ACTION && <UndoControl id={e.id} label="Undo" />}
    </li>
  );
}

interface Group {
  key: string;
  batchId: string | null;
  rows: AuditListEntry[];
}

/** Rows of a batch sit together at the position of the batch's newest row; everything else stays in order. */
function groupRows(entries: AuditListEntry[]): Group[] {
  const groups: Group[] = [];
  const byBatch = new Map<string, Group>();
  for (const e of entries) {
    const existing = e.batchId ? byBatch.get(e.batchId) : undefined;
    if (existing) {
      existing.rows.push(e);
      continue;
    }
    const g: Group = { key: e.batchId ?? `row-${e.id}`, batchId: e.batchId, rows: [e] };
    groups.push(g);
    if (e.batchId) byBatch.set(e.batchId, g);
  }
  return groups;
}

function BatchGroup({ group }: { group: Group }) {
  const header = group.rows.find((r) => r.action === BULK_ACTION);
  const items = group.rows.filter((r) => r.targetType === 'card');
  const undone = items.filter((r) => r.undoneAt !== null).length;
  const latest = group.rows[group.rows.length - 1] ?? group.rows[0];
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Batch · {header ? 'Bulk Ready to Test' : latest?.action}
            <Badge variant="secondary">
              {items.length} card{items.length === 1 ? '' : 's'}
            </Badge>
            {undone > 0 && <Badge variant="outline">{undone} restored</Badge>}
            {header?.dryRun && <Badge variant="warning">dry-run</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            <TimeAgo at={latest?.at} /> · {group.batchId}
          </p>
        </div>
        {header?.undoable && (
          <UndoControl id={header.id} label={undone > 0 ? 'Undo bulk (remaining)' : 'Undo bulk'} />
        )}
      </div>
      <ul className="mt-2 divide-y border-t">
        {group.rows.map((r) => (
          <Row key={r.id} e={r} />
        ))}
      </ul>
    </li>
  );
}

const NO_FILTERS: AuditFilters = { action: '', actor: '', targetType: '', onlyUndoable: false };

export function Audit() {
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const log = useAuditLog(filters);
  const pages = log.data?.pages;
  const groups = useMemo(() => groupRows((pages ?? []).flatMap((p) => p.entries)), [pages]);
  const facets = pages?.[0]?.facets;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <PageTitle>Audit</PageTitle>
        <p className="text-sm text-muted-foreground">
          Every write, with before/after and Undo where it is reversible.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label="Action"
          className="w-auto"
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
        >
          <option value="">All actions</option>
          {facets?.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Target type"
          className="w-auto"
          value={filters.targetType}
          onChange={(e) => setFilters({ ...filters, targetType: e.target.value })}
        >
          <option value="">All targets</option>
          {facets?.targetTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Actor"
          className="w-auto"
          value={filters.actor}
          onChange={(e) => setFilters({ ...filters, actor: e.target.value as AuditActor | '' })}
        >
          <option value="">All actors</option>
          {AUDIT_ACTORS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.onlyUndoable}
            onChange={(e) => setFilters({ ...filters, onlyUndoable: e.target.checked })}
          />
          Only undoable
        </label>
      </div>

      {log.isError && (
        <Alert variant="destructive">
          <AlertTitle>Cannot load the audit log</AlertTitle>
          <AlertDescription>{describeError(log.error)}</AlertDescription>
        </Alert>
      )}
      {log.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {log.isSuccess && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">No entries match.</p>
      )}

      <ul className="grid gap-3">
        {groups.map((g) =>
          g.batchId ? (
            <BatchGroup key={g.key} group={g} />
          ) : (
            <li key={g.key} className="rounded-lg border px-3">
              <ul>{g.rows[0] && <Row e={g.rows[0]} />}</ul>
            </li>
          ),
        )}
      </ul>

      {log.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {log.isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      )}
    </div>
  );
}
