import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CircleCheck, Download, Loader2, OctagonAlert } from 'lucide-react';
import { KpiMonthSchema, type KpiHistoryItem, type KpiReport } from '@relay/shared';
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
import { KpiSky } from '@/kpi/sky/KpiSky';
import { DeadlineRunway } from '@/kpi/viz/DeadlineRunway';
import { HistoryTrend } from '@/kpi/viz/HistoryTrend';
import { LateLollipops } from '@/kpi/viz/LateLollipops';
import { MonthFigures } from '@/kpi/viz/MonthFigures';
import { Fold } from '@/kpi/viz/parts';
import { SlaTypeBars } from '@/kpi/viz/SlaTypeBars';
import { useKpiView } from '@/kpi/viz/store';
import { useVisual } from '@/lib/visuals';
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
  id,
  n,
  title,
  aside,
  children,
}: {
  id?: string;
  n: number;
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="rise-in grid scroll-mt-20 gap-4 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel n={n}>{title}</SectionLabel>
        {aside}
      </div>
      {children}
    </section>
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
  const visual = useVisual('kpi');
  const filter = useKpiView((st) => st.filter);
  const setFilter = useKpiView((st) => st.setFilter);
  // A chart's filter belongs to the month it was clicked in.
  useEffect(() => setFilter(null), [shownMonth, setFilter]);
  // Sections are numbered in the order they show.
  let count = 0;
  const num = () => ++count;

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
          {visual && (
            <div id="kpi-scorecard" className="rise-in scroll-mt-20">
              <KpiSky report={report} presets={presets} />
            </div>
          )}

          {!visual && (
            <Section
              id="kpi-scorecard"
              n={num()}
              title="Scorecard"
              aside={
                <span className="font-mono text-xs text-muted-foreground">{report.month}</span>
              }
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
          )}

          <Section n={num()} title="The month in numbers">
            <MonthFigures report={report} pointsAsHours={presets.pointsAsHours} />
          </Section>

          {report.current && (
            <Section
              n={num()}
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

          <Section id="kpi-sla-type" n={num()} title="SLA by type">
            <SlaTypeBars report={report} />
            {report.scorecard.sla.byType.length > 0 && (
              <Fold id="sla-type" count={report.scorecard.sla.byType.length}>
                <ByTypeTable report={report} />
              </Fold>
            )}
          </Section>

          <Section id="kpi-sla-table" n={num()} title="SLA table">
            {cardsQ.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not load the SLA table</AlertTitle>
                <AlertDescription>{describeError(cardsQ.error)}</AlertDescription>
              </Alert>
            )}
            {cards && cards.current && !cards.frozen && (
              <DeadlineRunway rows={cards.rows} month={cards.month} />
            )}
            {cards && (
              <Fold id="sla-table" count={cards.rows.length}>
                <SlaTable
                  rows={cards.rows}
                  month={cards.month}
                  live={cards.current && !cards.frozen}
                  frozen={cards.frozen}
                  filter={filter}
                  onClearFilter={() => setFilter(null)}
                />
              </Fold>
            )}
          </Section>

          <Section
            id="kpi-late"
            n={num()}
            title="Late cards"
            aside={
              <span className="font-mono text-xs text-muted-foreground">
                {report.scorecard.lateCards.length}
              </span>
            }
          >
            <LateLollipops cards={report.scorecard.lateCards} />
            {report.scorecard.lateCards.length > 0 && (
              <Fold id="late" label="list" count={report.scorecard.lateCards.length}>
                <LateCards report={report} />
              </Fold>
            )}
          </Section>

          <Section id="kpi-history" n={num()} title="History">
            {report.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No month has been frozen yet.</p>
            ) : (
              <>
                <HistoryTrend items={report.history} selected={report.month} onPick={pick} />
                <Fold id="history" count={report.history.length}>
                  <History items={report.history} selected={report.month} onPick={pick} />
                </Fold>
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
