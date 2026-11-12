import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, EyeOff, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import {
  MR_DERIVED_STATES,
  SEVERITIES,
  type DismissedVerdict,
  type HealthRangeQuery,
  type HealthReport,
  type MrDerivedState,
  type Severity,
  type SyncSourceStatus,
  type Verdict,
} from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FixButtons } from '@/components/FixButtons';
import { Badge, MrStateBadge, SeverityBadge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { TimeAgo } from '@/components/TimeAgo';
import { describeError } from '@/lib/api';
import { cardKey, mineSets, verdictIsMine } from '@/lib/cardScope';
import { emit } from '@/lib/reward/engine';
import { useSettings } from '@/lib/settingsApi';
import { useFalsePositive, useHealthReport, useStateSnapshot } from '@/lib/stateApi';
import { cn } from '@/lib/utils';
import { PageTitle } from '@/components/PageTitle';
import { ThreadBridge } from '@/health/ThreadBridge';
import { useVisual } from '@/lib/visuals';

const RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, action: 3, critical: 4 };
const worst = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b);

const CELL_TONE: Record<Severity, string> = {
  ok: 'bg-success/15 text-success',
  info: 'bg-secondary text-secondary-foreground',
  warn: 'bg-warning/20 text-warning',
  action: 'bg-warning/15 text-warning ring-1 ring-warning',
  critical: 'bg-destructive/15 text-destructive',
};

interface Cell {
  cards: Set<string>;
  severity: Severity;
  unruled: number;
}
const NO_CARD = '(MR without a card)';
const NO_STATUS = '(no status)';

/** Matrix of Notion status × MR state, counting distinct cards, coloured by the worst verdict in the cell. */
function buildMatrix(report: HealthReport, statuses: readonly string[]) {
  const cells = new Map<string, Cell>();
  const rowSet = new Set<string>(statuses);
  const key = (row: string, col: MrDerivedState) => `${row}\u0000${col}`;
  const touch = (row: string, col: MrDerivedState): Cell => {
    rowSet.add(row);
    let c = cells.get(key(row, col));
    if (!c) {
      c = { cards: new Set(), severity: 'ok', unruled: 0 };
      cells.set(key(row, col), c);
    }
    return c;
  };
  let seq = 0;
  for (const v of report.verdicts) {
    const row = v.cardId ? (v.notionStatus ?? NO_STATUS) : NO_CARD;
    const c = touch(row, v.mrState);
    c.cards.add(v.cardId ?? `mr:${v.repoId}#${v.mrIid}:${seq++}`);
    c.severity = worst(c.severity, v.severity);
  }
  for (const u of report.unruled) {
    const c = touch(u.status ?? NO_STATUS, u.mrState);
    c.cards.add(u.cardId);
    c.unruled++;
  }
  const rows = [...rowSet].filter(
    (r) => statuses.includes(r) || [...cells.keys()].some((k) => k.startsWith(`${r}\u0000`)),
  );
  return { rows, cells, key };
}

function Matrix({ report, statuses }: { report: HealthReport; statuses: readonly string[] }) {
  const { rows, cells, key } = useMemo(() => buildMatrix(report, statuses), [report, statuses]);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[40rem] border-collapse text-sm">
        <caption className="sr-only">Cards by Notion status and MR state</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
            <th scope="col" className="p-2 text-left font-medium">
              Notion status ↓ / MR state →
            </th>
            {MR_DERIVED_STATES.map((s) => (
              <th key={s} scope="col" className="p-2 text-center font-medium">
                {s === 'none' ? 'no MR' : s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row} className="border-b last:border-0">
              <th scope="row" className="p-2 text-left font-medium whitespace-nowrap">
                {row}
              </th>
              {MR_DERIVED_STATES.map((col) => {
                const c = cells.get(key(row, col));
                return (
                  <td key={col} className="p-1 text-center">
                    {c ? (
                      <span
                        className={cn(
                          'inline-flex min-w-9 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-semibold',
                          CELL_TONE[c.severity],
                        )}
                        title={`${c.cards.size} card(s), worst: ${c.severity}${c.unruled ? `, ${c.unruled} without a rule` : ''}`}
                      >
                        {c.cards.size}
                        {c.unruled > 0 && <span aria-label="has cards without a rule">?</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" aria-hidden>
                        ·
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t p-2 text-xs text-muted-foreground">
        Distinct cards per cell, coloured by the worst finding (icon-free: see the list below for
        text). “?” = some cards have no rule for this pair.
      </p>
    </div>
  );
}

/** The server words a side as `merged ✓`. The word stays, and the mark is drawn as an icon. */
function SideLabel({ text }: { text: string }) {
  if (!text.endsWith(' ✓')) return text;
  return (
    <>
      {text.slice(0, -2)} <Check aria-hidden className="inline size-3" />
    </>
  );
}

const refOf = (v: Verdict) => ({
  ruleId: v.ruleId,
  cardId: v.cardId,
  repoId: v.repoId,
  mrIid: v.mrIid,
});

function VerdictRow({ v }: { v: Verdict }) {
  const mrLink = v.repoId && v.mrIid ? `/mrs/${v.repoId}/${v.mrIid}` : null;
  const falsePositive = useFalsePositive();
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={v.severity} />
        <span className="font-medium">{v.message}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
          Notion: <SideLabel text={v.sides.notion} /> │ GitLab: <SideLabel text={v.sides.gitlab} />
        </span>
        <MrStateBadge state={v.mrState} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {v.cardTitle && <span>card: {v.cardTitle}</span>}
        {v.mrTitle &&
          (mrLink ? (
            <Link to={mrLink} className="text-primary-ink underline">
              !{v.mrIid} {v.mrTitle}
            </Link>
          ) : (
            <span>MR: {v.mrTitle}</span>
          ))}
        <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{v.ruleId}</span>
      </div>
      {v.detail && <p className="text-xs text-muted-foreground">{v.detail}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <FixButtons v={v} />
        {v.severity !== 'ok' && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={falsePositive.isPending}
            title="Hide this finding while the same rule fires on this card / MR. Nothing is written to Notion or GitLab."
            onClick={() => falsePositive.mutate({ ref: refOf(v), dismiss: true })}
          >
            <EyeOff aria-hidden />
            False positive
          </Button>
        )}
      </div>
      {falsePositive.error && (
        <p className="text-xs text-destructive">{describeError(falsePositive.error)}</p>
      )}
    </li>
  );
}

function DismissedList({ items }: { items: DismissedVerdict[] }) {
  const falsePositive = useFalsePositive();
  return (
    <ul className="grid gap-1 text-sm">
      {items.map((v) => (
        <li
          key={`${v.ruleId}:${v.cardId ?? ''}:${v.repoId ?? ''}#${v.mrIid ?? ''}`}
          className="flex flex-wrap items-center gap-2 rounded-md border p-2"
        >
          <SeverityBadge severity={v.severity} />
          <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
            {v.cardTitle ?? (v.mrIid ? `!${v.mrIid} ${v.mrTitle ?? ''}` : v.message)}
          </span>
          <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {v.message} · marked <TimeAgo at={v.dismissedAt} />
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={falsePositive.isPending}
            onClick={() => falsePositive.mutate({ ref: refOf(v), dismiss: false })}
          >
            <RotateCcw aria-hidden />
            Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}

type Period = 'year' | '90d' | 'all' | 'custom';
const PERIODS: readonly (readonly [Period, string])[] = [
  ['year', 'This year'],
  ['90d', 'Last 90 days'],
  ['all', 'All time'],
  ['custom', 'Custom'],
];

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Period → query. `null` = the custom dates are not usable yet. */
function rangeOf(
  period: Period,
  custom: { from: string; to: string },
  now = new Date(),
): HealthRangeQuery | null {
  if (period === 'year') return { from: `${now.getFullYear()}-01-01` };
  if (period === '90d')
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)) };
  if (period === 'all') return {};
  const from = isYmd(custom.from) ? custom.from : undefined;
  const to = isYmd(custom.to) ? custom.to : undefined;
  if (from && to && from > to) return null;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function PeriodPicker({
  period,
  setPeriod,
  custom,
  setCustom,
  invalid,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  custom: { from: string; to: string };
  setCustom: (f: (c: { from: string; to: string }) => { from: string; to: string }) => void;
  invalid: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Period">
        {PERIODS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
            className={cn(
              'tactile rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.04em] uppercase transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
              period === value
                ? 'border-foreground bg-foreground text-background'
                : 'border-input hover:border-foreground hover:bg-foreground hover:text-background',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="flex w-full flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            From
            <DatePicker
              size="sm"
              aria-label="From"
              value={custom.from}
              onChange={(v) => setCustom((c) => ({ ...c, from: v }))}
              className="w-40"
            />
          </label>
          <label className="flex items-center gap-2">
            To
            <DatePicker
              size="sm"
              aria-label="To"
              value={custom.to}
              onChange={(v) => setCustom((c) => ({ ...c, to: v }))}
              className="w-40"
            />
          </label>
          {invalid && (
            <span className="text-xs text-warning">
              Pick a start date on or before the end date.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const SOURCE_VARIANT = {
  ok: 'success',
  partial: 'warning',
  error: 'destructive',
  never: 'secondary',
  skipped: 'secondary',
} as const;

function Sources({ sources }: { sources: SyncSourceStatus[] }) {
  if (sources.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No sync has run since the server started.</p>
    );
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {sources.map((s) => (
        <li key={s.source} className="rounded-lg border bg-card p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.source}</span>
            <Badge variant={SOURCE_VARIANT[s.state]}>{s.state}</Badge>
            {s.consecutiveFailures > 0 && (
              <Badge variant="destructive">{s.consecutiveFailures} failures in a row</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            last success <TimeAgo at={s.lastSuccessAt} /> · last attempt{' '}
            <TimeAgo at={s.lastAttemptAt} />
          </p>
          {s.error && (
            <p className="mt-1 text-xs text-destructive">
              {s.error.kind}: {s.error.message}
            </p>
          )}
          {s.warnings.map((w) => (
            <p key={w} className="mt-1 text-xs text-warning">
              {w}
            </p>
          ))}
          {s.rateLimit?.remaining != null && (
            <p className="mt-1 text-xs text-muted-foreground">
              rate limit: {s.rateLimit.remaining}
              {s.rateLimit.limit != null ? ` / ${s.rateLimit.limit}` : ''} left
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Sync Health: matrix + findings list. Card status fixes are confirmed in a dialog. */
export function SyncHealth() {
  // Default: this calendar year (Jan 1 → today). Cards count by their Notion creation date.
  const [period, setPeriod] = useState<Period>('year');
  const [custom, setCustom] = useState(() => ({
    from: `${new Date().getFullYear()}-01-01`,
    to: ymd(new Date()),
  }));
  const picked = rangeOf(period, custom);
  const [lastValid, setLastValid] = useState<HealthRangeQuery>(() => rangeOf('year', custom)!);
  if (picked && JSON.stringify(picked) !== JSON.stringify(lastValid)) setLastValid(picked);
  const healthQ = useHealthReport(lastValid);
  const stateQ = useStateSnapshot();
  const settingsQ = useSettings();
  const showVisual = useVisual('sync');
  const [only, setOnly] = useState<Severity | 'issues'>('issues');
  const full = healthQ.data;
  // Mine: findings on my cards, and card-less findings on my MRs. Counts follow the filtered list.
  const report = useMemo(() => {
    if (!full) return undefined;
    const sets = mineSets(stateQ.data);
    if (!sets.active) return full;
    const verdicts = full.verdicts.filter((v) => verdictIsMine(v, sets));
    const dismissed = full.dismissed.filter((v) => verdictIsMine(v, sets));
    const unruled = full.unruled.filter((u) => sets.cards.has(cardKey(u.cardId)));
    const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<
      Severity,
      number
    >;
    for (const v of verdicts) bySeverity[v.severity]++;
    return {
      ...full,
      verdicts,
      dismissed,
      unruled,
      counts: { ...full.counts, total: verdicts.length, bySeverity, cards: sets.cards.size },
    };
  }, [full, stateQ.data]);
  const statuses = settingsQ.data?.notion.statuses ?? [];

  // One tick on reaching zero mismatches. Later refreshes of a report that is still clean stay silent.
  const lastIssues = useRef<number | null>(null);
  const issues = report
    ? report.verdicts.filter((v) => v.severity !== 'ok').length + report.unruled.length
    : null;
  useEffect(() => {
    if (issues === null) return;
    if (issues === 0 && lastIssues.current !== 0) {
      emit({ level: 'tick', key: 'sync:clear', repeatable: true });
    }
    lastIssues.current = issues;
  }, [issues]);

  const list = useMemo(() => {
    const vs = report?.verdicts ?? [];
    return only === 'issues'
      ? vs.filter((v) => v.severity !== 'ok')
      : vs.filter((v) => v.severity === only);
  }, [report, only]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div>
        <PageTitle>Sync Health</PageTitle>
        <p className="text-sm text-muted-foreground">
          Notion status and GitLab MR state side by side. A Fix opens a confirm dialog; nothing is
          written until you confirm, and every change is audited and undoable.
        </p>
      </div>

      <PeriodPicker
        period={period}
        setPeriod={setPeriod}
        custom={custom}
        setCustom={setCustom}
        invalid={picked === null}
      />

      {healthQ.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the health report</AlertTitle>
          <AlertDescription>{describeError(healthQ.error)}</AlertDescription>
        </Alert>
      )}
      {healthQ.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}

      {report && (
        <>
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Filter findings"
          >
            {SEVERITIES.slice()
              .reverse()
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={only === s}
                  onClick={() => setOnly(only === s ? 'issues' : s)}
                  className={cn(
                    'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    only === s && 'ring-2 ring-ring',
                  )}
                >
                  <SeverityBadge severity={s} title={`${s}: ${report.counts.bySeverity[s] ?? 0}`} />
                  <span className="sr-only">{report.counts.bySeverity[s] ?? 0}</span>
                  <span aria-hidden className="ml-1 text-xs text-muted-foreground">
                    {report.counts.bySeverity[s] ?? 0}
                  </span>
                </button>
              ))}
            <span className="ml-auto text-xs text-muted-foreground">
              {report.range.from || report.range.to
                ? `${report.range.from ?? '…'} – ${report.range.to ?? 'today'} · `
                : 'all time · '}
              {report.counts.cards} cards · generated <TimeAgo at={report.generatedAt} />
            </span>
          </div>

          {showVisual && (
            <ThreadBridge report={report} sources={stateQ.data?.health.sync.sources ?? []} />
          )}

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">Matrix</h2>
            <Matrix report={report} statuses={statuses} />
          </section>

          <section className="grid gap-2">
            <h2 className="text-lg font-semibold">
              {only === 'issues' ? 'Findings that need attention' : `Findings: ${only}`} (
              {list.length})
            </h2>
            {list.length === 0 ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {report.counts.cards === 0
                  ? 'No cards in the cache yet (waiting for the first sync).'
                  : 'Nothing to show here.'}
              </p>
            ) : (
              <ul className="grid gap-2">
                {list.map((v, i) => (
                  <VerdictRow
                    key={`${v.ruleId}:${v.cardId ?? ''}:${v.repoId ?? ''}#${v.mrIid ?? ''}:${i}`}
                    v={v}
                  />
                ))}
              </ul>
            )}
          </section>

          {report.dismissed.length > 0 && (
            <section className="grid gap-2">
              <h2 className="text-lg font-semibold">
                Marked as false positive ({report.dismissed.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Hidden from the findings, counts, badges and notifications. Restore one to see it
                again.
              </p>
              <DismissedList items={report.dismissed} />
            </section>
          )}

          {report.unruled.length > 0 && (
            <section className="grid gap-2">
              <h2 className="text-lg font-semibold">No rule for these ({report.unruled.length})</h2>
              <p className="text-xs text-muted-foreground">
                Shown instead of silently looking healthy: the rule table has no row for the pair.
              </p>
              <ul className="grid gap-1 text-sm">
                {report.unruled.map((u) => (
                  <li
                    key={u.cardId}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2"
                  >
                    <Badge variant="secondary">{u.reason.replace(/_/g, ' ')}</Badge>
                    <span className="font-medium">{u.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {u.status ?? 'no status'} · {u.mrState === 'none' ? 'no MR' : u.mrState}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Sync sources</h2>
        {stateQ.data ? (
          <Sources sources={stateQ.data.health.sync.sources} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </section>
    </div>
  );
}
