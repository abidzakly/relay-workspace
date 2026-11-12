import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CircleCheck, Download, Loader2, OctagonAlert } from 'lucide-react';
import { KpiMonthSchema, type KpiHistoryItem, type KpiReport } from '@relay/shared';
import { formatHours } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { PageTitle, SectionLabel } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { bugGauge, completionGauge, formatPercent, hitRateGauge, researchGauge } from '@/kpi/model';
import { Ruler } from '@/kpi/Ruler';
import { SlaTable } from '@/kpi/SlaTable';
import { FocusList, useFocusCount } from '@/kpi/TodaysFocus';
import { describeError } from '@/lib/api';
import { kpiExportUrl, useKpiCards, useKpiReport } from '@/lib/kpiApi';
import { useSettings } from '@/lib/settingsApi';
import { cn, safeHref } from '@/lib/utils';

const TH = 'px-2 pb-2 text-left type-micro font-semibold whitespace-nowrap text-muted-foreground';
const TH_NUM =
  'px-2 pb-2 text-right type-micro font-semibold whitespace-nowrap text-muted-foreground';
const TD = 'px-2 py-2.5';
const TD_NUM = 'px-2 py-2.5 text-right font-mono tabular-nums';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function localMonth(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const nameOf = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** A numbered section of the page, ruled off from the one above. */
function Section({
  n,
  title,
  aside,
  children,
}: {
  n: number;
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rise-in grid gap-4 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel n={n}>{title}</SectionLabel>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One figure in the month-in-numbers row: label, value in mono, a line of context. */
function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-hairline py-4 not-first:border-t sm:px-5 sm:not-first:border-t-0 sm:not-first:border-l sm:first:pl-0">
      <dt className="type-micro text-muted-foreground">{label}</dt>
      <dd className="font-mono text-2xl tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

function MonthState({ report }: { report: KpiReport }) {
  if (report.frozen) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="secondary">frozen</Badge>
        <span>
          Frozen <TimeAgo at={report.frozenAt} />. Later edits do not change this month.
        </span>
      </p>
    );
  }
  if (report.current) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="success">in progress</Badge>
        <span>
          Updated <TimeAgo at={report.scorecard.asOf} />.
        </span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Badge variant="warning">not frozen yet</Badge>
      <span>Finished, but computed from the cache until a clean sync freezes it.</span>
    </p>
  );
}

/** A thin bar for a rate inside a table cell, so a column reads at a glance. */
function RateBar({ value }: { value: number | null }) {
  if (value === null) return <>—</>;
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="relative hidden h-0.5 w-16 bg-foreground/15 sm:inline-block" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 bg-foreground"
          style={{ width: `${Math.min(100, value * 100)}%` }}
        />
      </span>
      {formatPercent(value)}
    </span>
  );
}

function ByTypeTable({ report }: { report: KpiReport }) {
  const { byType } = report.scorecard.sla;
  if (byType.length === 0) {
    return <p className="text-sm text-muted-foreground">No cards with a timer in this month.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">SLA hit-rate per card type in {report.month}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Type
            </th>
            <th scope="col" className={TH_NUM}>
              Rule
            </th>
            <th scope="col" className={TH_NUM}>
              Hit-rate
            </th>
            <th scope="col" className={TH_NUM}>
              Met
            </th>
            <th scope="col" className={TH_NUM}>
              Breached
            </th>
            <th scope="col" className={TH_NUM} title="Not in the hit-rate">
              In flight (not counted)
            </th>
            <th scope="col" className={TH_NUM}>
              Avg resolution
            </th>
          </tr>
        </thead>
        <tbody>
          {byType.map((t) => (
            <tr key={t.type} className="border-t border-hairline">
              <th scope="row" className={`${TD} text-left font-medium`}>
                {t.type}
              </th>
              <td className={TD_NUM}>{t.ruleDays === null ? '—' : `${t.ruleDays}d`}</td>
              <td className={TD_NUM}>
                <RateBar value={t.hitRate} />
              </td>
              <td className={TD_NUM}>{t.met}</td>
              <td className={cn(TD_NUM, t.breached > 0 && 'text-destructive')}>{t.breached}</td>
              <td className={`${TD_NUM} text-muted-foreground`}>{t.inFlight}</td>
              <td className={TD_NUM}>{t.avgResolutionLabel ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LateCards({ report }: { report: KpiReport }) {
  const late = report.scorecard.lateCards;
  if (late.length === 0) return <p className="text-sm text-muted-foreground">No late cards.</p>;
  return (
    <ol className="flex flex-col text-sm">
      {late.map((c, i) => (
        <li
          key={c.cardId}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hairline py-2.5 first:border-t-0 first:pt-0"
        >
          <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">
            {String(i + 1).padStart(2, '0')}
          </span>
          {c.url ? (
            <a
              href={safeHref(c.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 font-medium break-words hover:underline"
            >
              {c.title}
            </a>
          ) : (
            <span className="min-w-0 flex-1 font-medium break-words">{c.title}</span>
          )}
          {c.type && <Badge variant="outline">{c.type}</Badge>}
          <span className="font-mono text-xs text-destructive">+{c.lateByLabel}</span>
          <span className="text-xs text-muted-foreground">
            {c.stoppedAt === null ? 'no MR' : 'MR opened late'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The ledger: every frozen month as a column, oldest on the left. The bar is the late cards; the diamond over it is
 * the research quota, filled when met and hollow when missed. Click a month to open it.
 */
function Ledger({
  items,
  selected,
  onPick,
}: {
  items: readonly KpiHistoryItem[];
  selected: string;
  onPick: (month: string) => void;
}) {
  const months = [...items].reverse();
  const most = Math.max(1, ...months.map((h) => h.lateCards));
  return (
    <div className="grid gap-2">
      <div
        className="flex h-28 items-end gap-1 border-b border-hairline"
        role="group"
        aria-label="Months"
      >
        {months.map((h) => {
          const on = h.month === selected;
          return (
            <button
              key={h.month}
              type="button"
              onClick={() => onPick(h.month)}
              aria-current={on}
              aria-label={`${h.month}: ${h.lateCards} late card${h.lateCards === 1 ? '' : 's'}, research ${h.researchMet ? 'met' : 'missed'}, hit-rate ${h.hitRate === null ? 'none' : formatPercent(h.hitRate)}`}
              title={`${h.month} · ${h.lateCards} late · research ${h.researchMet ? 'met' : 'missed'}`}
              className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn(
                  'size-2 rotate-45 border',
                  h.researchMet
                    ? 'border-foreground bg-foreground'
                    : 'border-destructive bg-transparent',
                )}
              />
              <span
                aria-hidden
                className={cn(
                  'w-full max-w-5 transition-[background-color,height] duration-300',
                  on ? 'bg-terracotta' : 'bg-foreground/80 group-hover:bg-foreground',
                )}
                style={{ height: `${Math.max(2, (h.lateCards / most) * 80)}%` }}
              />
            </button>
          );
        })}
      </div>
      <div className="flex gap-1" aria-hidden>
        {months.map((h, i) => (
          <span
            key={h.month}
            className="min-w-0 flex-1 text-center font-mono text-2xs text-muted-foreground"
          >
            {i % 3 === 0 || h.month === selected ? h.month.slice(2).replace('-', '·') : ''}
          </span>
        ))}
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Bar: late cards</span>
        <span>
          <span className="mr-1 inline-block size-2 rotate-45 bg-foreground" />
          research met
        </span>
        <span>
          <span className="mr-1 inline-block size-2 rotate-45 border border-destructive" />
          research missed
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-1.5 bg-terracotta" />
          the month shown
        </span>
      </p>
    </div>
  );
}

function History({
  items,
  selected,
  onPick,
}: {
  items: readonly KpiHistoryItem[];
  selected: string;
  onPick: (month: string) => void;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No month has been frozen yet.</p>;
  }
  return (
    <div className="grid gap-6">
      <Ledger items={items} selected={selected} onPick={onPick} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Frozen months, newest first</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Month
              </th>
              <th scope="col" className={TH_NUM}>
                Completion
              </th>
              <th scope="col" className={TH}>
                Bug ratio
              </th>
              <th scope="col" className={TH}>
                Research
              </th>
              <th scope="col" className={TH_NUM}>
                Hit-rate
              </th>
              <th scope="col" className={TH_NUM}>
                Late cards
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((h) => (
              <tr
                key={h.month}
                className={cn(
                  'border-t border-hairline',
                  h.month === selected && 'bg-foreground/[0.04]',
                )}
              >
                <th scope="row" className={`${TD} text-left font-medium`}>
                  <button
                    type="button"
                    className="font-mono underline-offset-4 hover:underline aria-[current=true]:underline"
                    aria-current={h.month === selected}
                    onClick={() => onPick(h.month)}
                  >
                    {h.month}
                  </button>
                </th>
                <td className={TD_NUM}>
                  {h.completionRate === null ? '—' : formatPercent(h.completionRate)}
                </td>
                <td className={TD}>
                  <span className="inline-flex flex-wrap items-center gap-1 font-mono tabular-nums">
                    {formatPercent(h.bugRatio)}
                    {h.bugOverLimit && (
                      <Badge variant="destructive">
                        <OctagonAlert aria-hidden />
                        over the limit
                      </Badge>
                    )}
                  </span>
                </td>
                <td className={TD}>
                  <span className="inline-flex flex-wrap items-center gap-1 font-mono tabular-nums">
                    {h.researchCount}
                    <Badge variant={h.researchMet ? 'success' : 'destructive'}>
                      {h.researchMet ? <CircleCheck aria-hidden /> : <OctagonAlert aria-hidden />}
                      {h.researchMet ? 'met' : 'missed'}
                    </Badge>
                  </span>
                </td>
                <td className={TD_NUM}>{h.hitRate === null ? '—' : formatPercent(h.hitRate)}</td>
                <td className={TD_NUM}>{h.lateCards}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** KPI: monthly scorecard, SLA table, bug ratio, research quota, history. */
export function Kpi() {
  const [params, setParams] = useSearchParams();
  const parsed = KpiMonthSchema.safeParse(params.get('month'));
  const month = parsed.success ? parsed.data : undefined;
  const reportQ = useKpiReport(month);
  const cardsQ = useKpiCards(month);
  const [thisMonth] = useState(() => localMonth(Date.now()));
  const focusCount = useFocusCount(5);
  // KPI presets (Settings > Planning): a switched-off preset leaves the page; its numbers are kept.
  const presets = useSettings().data?.kpi ?? {
    pointsAsHours: true,
    researchQuota: true,
    bugRatio: true,
  };

  const report = reportQ.data;
  const cards = cardsQ.data;
  const pick = (m: string) => setParams(m ? { month: m } : {});
  const shownMonth = month ?? report?.month ?? thisMonth;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <PageTitle accent={nameOf(shownMonth)}>KPI</PageTitle>
          {report && <MonthState report={report} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker
            kind="month"
            aria-label="Month"
            className="w-44"
            max={thisMonth}
            value={month ?? report?.month ?? ''}
            onChange={(v) => {
              if (v) pick(v);
            }}
          />
          {month && (
            <Button variant="ghost" onClick={() => pick('')}>
              This month
            </Button>
          )}
          {report && (
            <>
              <Button variant="outline" asChild>
                <a href={kpiExportUrl(report.month, 'md')} download>
                  <Download aria-hidden />
                  Markdown
                </a>
              </Button>
              <Button variant="outline" asChild>
                <a href={kpiExportUrl(report.month, 'csv')} download>
                  <Download aria-hidden />
                  CSV
                </a>
              </Button>
            </>
          )}
        </div>
      </div>

      {report && !report.meConfigured && (
        <Alert variant="warning">
          <AlertTitle>The dashboard does not know which cards are yours</AlertTitle>
          <AlertDescription>
            Set your GitLab username or Notion assignee aliases in{' '}
            <Link className="underline" to="/settings#gitlab">
              Settings
            </Link>
            . Until then only cards with a manual assigned-at count.
          </AlertDescription>
        </Alert>
      )}

      {reportQ.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Loading…
        </p>
      )}
      {reportQ.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the scorecard</AlertTitle>
          <AlertDescription>{describeError(reportQ.error)}</AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          <Section
            n={1}
            title="Scorecard"
            aside={<span className="font-mono text-xs text-muted-foreground">{report.month}</span>}
          >
            <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4 xl:gap-0">
              {[
                completionGauge(report.scorecard.completion),
                presets.bugRatio ? bugGauge(report.scorecard.bugRatio) : null,
                hitRateGauge(report.scorecard.sla.overall),
                presets.researchQuota ? researchGauge(report.scorecard.research) : null,
              ]
                .filter((g) => g !== null)
                .map((g) => (
                  <Ruler
                    key={g.label}
                    gauge={g}
                    className="border-hairline xl:border-l xl:px-6 xl:first:border-l-0 xl:first:pl-0 xl:last:pr-0"
                  />
                ))}
            </div>
          </Section>

          <Section n={2} title="The month in numbers">
            <dl className="grid sm:grid-cols-3 lg:grid-cols-5">
              {presets.pointsAsHours && (
                <Figure
                  label="Effort (Point)"
                  value={
                    report.scorecard.effort
                      ? `${formatHours(report.scorecard.effort.doneHours)} / ${formatHours(report.scorecard.effort.totalHours)}`
                      : '—'
                  }
                  hint={
                    report.scorecard.effort
                      ? `done / committed hours · ${report.scorecard.effort.research} research, ${report.scorecard.effort.unestimated} without a Point`
                      : 'Not recorded for this month'
                  }
                />
              )}
              <Figure
                label="Cards"
                value={String(report.scorecard.counts.cards)}
                hint={`${report.scorecard.counts.untracked} without a timer, ${report.scorecard.counts.approxAssignedAt} approx`}
              />
              <Figure
                label="In flight (not counted)"
                value={String(report.scorecard.sla.overall.inFlight)}
                hint="Outside the hit-rate"
              />
              <Figure
                label="Avg resolution"
                value={report.scorecard.sla.overall.avgResolutionLabel ?? '—'}
                hint="Start clock to MR opened"
              />
              <Figure
                label="Review latency"
                value={report.scorecard.reviewLatency.meanLabel ?? '—'}
                hint={`median ${report.scorecard.reviewLatency.medianLabel ?? '—'}, ${report.scorecard.reviewLatency.sampled} sampled, ${report.scorecard.reviewLatency.withoutResponse} without a response`}
              />
            </dl>
          </Section>

          {report.current && (
            <Section
              n={3}
              title={
                <>
                  Today&apos;s <span className="type-accent text-base normal-case">focus</span>
                </>
              }
              aside={
                focusCount && focusCount.total > focusCount.shown ? (
                  <span className="text-xs text-muted-foreground">
                    {focusCount.shown} of {focusCount.total}
                  </span>
                ) : undefined
              }
            >
              <FocusList limit={5} />
            </Section>
          )}

          <Section n={report.current ? 4 : 3} title="SLA by type">
            <ByTypeTable report={report} />
          </Section>

          <Section n={report.current ? 5 : 4} title="SLA table">
            {cardsQ.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not load the SLA table</AlertTitle>
                <AlertDescription>{describeError(cardsQ.error)}</AlertDescription>
              </Alert>
            )}
            {cards && (
              <SlaTable
                rows={cards.rows}
                month={cards.month}
                live={cards.current && !cards.frozen}
                frozen={cards.frozen}
              />
            )}
          </Section>

          <Section
            n={report.current ? 6 : 5}
            title="Late cards"
            aside={
              <span className="font-mono text-xs text-muted-foreground">
                {report.scorecard.lateCards.length}
              </span>
            }
          >
            <LateCards report={report} />
          </Section>

          <Section n={report.current ? 7 : 6} title="History">
            <History items={report.history} selected={report.month} onPick={pick} />
          </Section>
        </>
      )}
    </div>
  );
}
