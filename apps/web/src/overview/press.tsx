import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ArrowRight,
  GitPullRequestCreate,
  Minus,
  RefreshCw,
  Scissors,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { KpiHistoryItem, KpiReport } from '@relay/shared';
import { TimeAgo } from '@/components/TimeAgo';
import type { ProgressModel } from '@/core3d/progressMapping';
import type { GaugeModel } from '@/kpi/model';
import { describeError } from '@/lib/api';
import { useGamification } from '@/lib/gamificationApi';
import { mrCreatePath, useReadyForMr, useRefreshReady } from '@/lib/mrCreateApi';
import { cn } from '@/lib/utils';
import type { ActionCenter } from './model';
import { kpiItems, progressionSummary, releaseSummary } from './model';
import { ToneDot } from './Panel';
import { groupReady } from './ReadyForMrPanel';
import { calmTone, type Tone } from './tone';
import { useKpiPresets } from '@/lib/features';

/*
 * The press: Overview written as a printed edition. Classic lays it out as a newspaper front page, the Living Workspace
 * as a magazine cover over the crystal. Both read the same numbers (useOverviewData), only the paper differs. Every
 * sentence here is built from server data; nothing is invented, and an unknown stays "—", never 0.
 */

/** Dates in the UI language: `en` prints the day before the month, as `en-GB` does. */
const dateLocale = (lang: string) => (lang === 'id' ? 'id-ID' : 'en-GB');

/** Today's edition: its number is the day of the year. `dateLine` is always "Weekday, day month year". */
export function edition(now = new Date(), lang = 'en') {
  const start = new Date(now.getFullYear(), 0, 0);
  const no = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
  const loc = dateLocale(lang);
  const weekday = now.toLocaleDateString(loc, { weekday: 'long' });
  const date = now.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  const month = now.toLocaleDateString(loc, { month: 'short' }).replace(/\.$/, '');
  return {
    no,
    dateLine: `${weekday}, ${date}`,
    short: `${month} ${now.getFullYear()}`,
    printed: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };
}

/** A headline in three parts, the middle one set as the serif accent. */
export interface Headline {
  kicker: string;
  before: string;
  accent: string;
  after: string;
  deck: string;
  /** The most urgent thing, when something is critical: a "Breaking" strap. */
  breaking: string | null;
}

/** The lead story, written from the release and what needs you, in the UI language. */
export function headline(
  model: ProgressModel | null,
  center: ActionCenter,
  offDuty: boolean,
  t: TFunction,
  lang = 'en',
): Headline {
  const urgent = center.categories.find((c) => calmTone(c.tone, offDuty) === 'bad' && c.count > 0);
  // English titles are plural nouns ("Failed pipelines"); one of them reads singular. Indonesian has no plural -s.
  const breaking = urgent
    ? `${urgent.count} ${urgent.count === 1 && lang === 'en' ? urgent.title.replace(/s$/, '') : urgent.title}`
    : null;
  const first = center.categories[0]?.title;
  const needs =
    center.total === 0
      ? t('overview.headline.needsNothing')
      : t('overview.headline.needs', {
          count: center.total,
          first: first
            ? lang === 'en'
              ? first.toLowerCase()
              : first
            : t('overview.headline.theList'),
        });
  if (!model) {
    return {
      kicker: t('overview.release'),
      before: t('overview.headline.warmingBefore'),
      accent: t('overview.headline.warmingAccent'),
      after: t('overview.headline.warmingAfter'),
      deck: needs,
      breaking,
    };
  }
  const s = releaseSummary(model);
  const flow = s.facts.find((f) => f.key === 'cards')?.value ?? 0;
  const issues = s.facts.find((f) => f.key === 'issues')?.value ?? 0;
  const counts = `${t('overview.headline.counts', { count: flow })}${issues > 0 ? t('overview.headline.countsIssues', { count: issues }) : ''}.`;
  const kicker = `${t('overview.headline.kicker', { scope: s.scopeLabel })}${s.partial ? t('overview.headline.partial') : ''}`;
  if (s.percent === null) {
    return {
      kicker,
      before: t('overview.headline.noFlowBefore'),
      accent: t('overview.headline.noFlowAccent'),
      after: t('overview.headline.noFlowAfter'),
      deck: needs,
      breaking,
    };
  }
  if (s.percent >= 100) {
    return {
      kicker,
      before: t('overview.headline.readyBefore'),
      accent: t('overview.headline.readyAccent'),
      after: t('overview.headline.readyAfter'),
      deck: `${counts} ${needs}`,
      breaking,
    };
  }
  return {
    kicker,
    before: t('overview.headline.percentBefore', { percent: s.percent }),
    accent: t('overview.headline.percentAccent'),
    after: t('overview.headline.percentAfter'),
    deck: `${counts} ${needs}`,
    breaking,
  };
}

/* ─────────────────────────────── markets ─────────────────────────────── */

const TONE_FILL: Record<Tone, string> = {
  good: 'fill-success',
  warn: 'fill-warning',
  bad: 'fill-destructive',
  info: 'fill-foreground',
  nodata: 'fill-muted-foreground',
};

type Metric = 'completion' | 'bug' | 'sla' | 'research';
const HISTORY: Record<Metric, (h: KpiHistoryItem) => number | null> = {
  completion: (h) => h.completionRate,
  bug: (h) => h.bugRatio,
  sla: (h) => h.hitRate,
  research: (h) => h.researchCount,
};
/** For the bug ratio a fall is good news. */
const LOWER_IS_BETTER: Record<Metric, boolean> = {
  completion: false,
  bug: true,
  sla: false,
  research: false,
};

function Sparkline({
  points,
  line,
  tone,
}: {
  points: (number | null)[];
  line: number | null;
  tone: Tone;
}) {
  const W = 132;
  const H = 34;
  const known = points.filter((p): p is number => p !== null);
  if (known.length < 2) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" aria-hidden>
        <line
          x1={0}
          x2={W}
          y1={H / 2}
          y2={H / 2}
          className="stroke-foreground/15"
          strokeDasharray="2 4"
        />
      </svg>
    );
  }
  const max = Math.max(...known, line ?? 0, 1e-9);
  const min = Math.min(...known, line ?? Infinity, 0);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * (W - 6) + 3;
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const d = points
    .map((p, i) => (p === null ? null : `${x(i).toFixed(1)} ${y(p).toFixed(1)}`))
    .filter(Boolean)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`)
    .join(' ');
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full overflow-visible" aria-hidden>
      {line !== null && (
        <line
          x1={0}
          x2={W}
          y1={y(line)}
          y2={y(line)}
          className="stroke-terracotta"
          strokeDasharray="3 3"
        />
      )}
      <path
        d={d}
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
      {last !== null && last !== undefined && (
        <path
          d="M0 -3.5 L3.5 0 L0 3.5 L-3.5 0 Z"
          transform={`translate(${x(points.length - 1)} ${y(last)})`}
          className={TONE_FILL[tone]}
        />
      )}
    </svg>
  );
}

/**
 * The markets: the four KPIs as a quotes table. Each row: the figure, its move since the last frozen month, the state
 * in words, and the last months as a sparkline against the line it is judged by.
 */
export function Markets({ report, className }: { report: KpiReport; className?: string }) {
  const kpiPresets = useKpiPresets();
  const { t } = useTranslation();
  const items = kpiItems(report.scorecard, kpiPresets);
  const months = [...report.history].reverse().slice(-8);
  return (
    <ul className={cn('grid', className)} aria-label={t('overview.kpi.label')}>
      {items.map((item) => {
        const metric = item.key as Metric;
        const g: GaugeModel = item.gauge;
        const now = metric === 'research' ? report.scorecard.research.count : g.fraction;
        const series = [...months.map(HISTORY[metric]), now];
        const prev = months.length > 0 ? HISTORY[metric](months[months.length - 1]!) : null;
        const delta = now !== null && prev !== null ? now - prev : null;
        const better =
          delta === null || delta === 0 ? null : LOWER_IS_BETTER[metric] ? delta < 0 : delta > 0;
        const Trend = delta === null || delta === 0 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
        const deltaText =
          delta === null
            ? t('overview.kpi.new')
            : metric === 'research'
              ? `${delta > 0 ? '+' : ''}${delta}`
              : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}`;
        return (
          <li
            key={item.key}
            className="grid grid-cols-[minmax(0,1.3fr)_auto] items-center gap-x-4 gap-y-1 border-t border-hairline py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7rem_8.5rem]"
          >
            <span className="grid min-w-0">
              <span className="type-micro">{g.label}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ToneDot tone={item.tone} className="size-1.5" />
                {g.status.label}
              </span>
            </span>
            <span className="text-right font-mono text-3xl leading-none tabular-nums sm:text-left">
              {g.valueText}
            </span>
            <span
              className={cn(
                'hidden items-center gap-1 font-mono text-xs tabular-nums sm:flex',
                better === true && 'text-success',
                better === false && 'text-destructive',
                better === null && 'text-muted-foreground',
              )}
              title={t('overview.kpi.change')}
            >
              <Trend aria-hidden className="size-3.5" />
              {deltaText}
              {metric !== 'research' && delta !== null && (
                <span className="text-2xs">{t('overview.kpi.pt')}</span>
              )}
            </span>
            <span className="col-span-2 sm:col-span-1">
              <Sparkline
                points={series}
                line={metric === 'research' ? null : (g.threshold?.fraction ?? null)}
                tone={item.tone}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ─────────────────────────────── briefs ─────────────────────────────── */

/** What needs you, as news briefs: each kind a short column under its own head, the most urgent first. */
export function Briefs({
  center,
  offDuty,
  errors,
  loading,
  limit = 3,
}: {
  center: ActionCenter;
  offDuty: boolean;
  errors: readonly unknown[];
  loading: boolean;
  limit?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5">
      {offDuty && center.total > 0 && (
        <p className="text-xs text-muted-foreground italic">{t('overview.briefs.offDuty')}</p>
      )}
      {errors.length > 0 && (
        <p className="text-xs text-destructive">
          {t('overview.briefs.partError', { errors: errors.map(describeError).join('; ') })}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">{t('overview.settingType')}</p>}
      {!loading && center.total === 0 && errors.length === 0 && (
        <p className="text-lg leading-snug">
          <Trans
            i18nKey="overview.briefs.quiet"
            components={[<span key="needs" className="type-accent" />]}
          />
        </p>
      )}
      {center.categories.map((c) => {
        const tone = calmTone(c.tone, offDuty);
        return (
          <section key={c.id} aria-label={`${c.title}, ${c.count}`} className="grid gap-1.5">
            <h4 className="flex items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-2xl leading-none tabular-nums">
                  {String(c.count).padStart(2, '0')}
                </span>
                <span className="text-base leading-tight font-semibold tracking-[-0.01em]">
                  {c.title}
                </span>
                <ToneDot tone={tone} className="size-1.5 -translate-y-0.5" />
              </span>
              <Link
                to={c.to}
                className="arrow-link inline-flex shrink-0 items-center gap-1 text-2xs font-semibold tracking-[0.04em] uppercase hover:underline"
              >
                {t('overview.briefs.all')} <ArrowRight aria-hidden className="size-3" />
              </Link>
            </h4>
            <ul className="grid">
              {c.preview.slice(0, limit).map((row) => (
                <li key={row.key} className="border-t border-hairline">
                  <Link to={row.to} className="group block py-1.5">
                    <span className="block text-sm leading-snug underline-offset-4 group-hover:underline">
                      {row.title}
                    </span>
                    {row.detail && (
                      <span className="block text-xs text-muted-foreground">{row.detail}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            {c.count > Math.min(limit, c.preview.length) && (
              <p className="font-mono text-2xs text-muted-foreground">
                {t('overview.briefs.continued', {
                  page: c.to.replace(/^\//, '').split(/[/?]/)[0] || t('overview.briefs.itsPage'),
                  count: c.count - Math.min(limit, c.preview.length),
                })}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── classifieds ─────────────────────────────── */

/** Pushed branches with no MR, as small ads you can cut out: each one's button opens the MR form. */
export function Classifieds({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const q = useReadyForMr();
  const refresh = useRefreshReady();
  const { t } = useTranslation();
  const items = useMemo(() => groupReady(q.data?.items ?? []).flat(), [q.data]);
  return (
    <div className={cn('grid gap-3', className)}>
      <div className="flex items-center justify-between">
        <p className="type-micro text-muted-foreground">{t('overview.ads.wanted')}</p>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          aria-label={t('overview.ads.recheck')}
          className="grid size-7 place-items-center rounded-full border border-hairline outline-none hover:border-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <RefreshCw className={cn('size-3.5', refresh.isPending && 'motion-safe:animate-spin')} />
        </button>
      </div>
      {q.error && <p className="text-xs text-destructive">{describeError(q.error)}</p>}
      {q.data && items.length === 0 && (
        <p className="border border-dashed border-foreground/30 p-3 text-sm text-muted-foreground">
          {t('overview.ads.none')}
        </p>
      )}
      <ul className={cn('grid gap-3', !compact && 'sm:grid-cols-2')}>
        {items.slice(0, compact ? 2 : 6).map((it) => (
          <li
            key={`${it.repoId}:${it.branch}`}
            className="relative grid gap-1.5 border border-dashed border-foreground/40 p-3"
          >
            <Scissors
              aria-hidden
              className="absolute -top-2 left-3 size-3.5 bg-background text-muted-foreground"
            />
            <p className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold tracking-[-0.01em] uppercase">
                {t('overview.ads.item')}
                {it.stack && it.stack.size > 1
                  ? t('overview.ads.ofStack', { position: it.stack.position })
                  : ''}
              </span>
              <span className="font-mono text-2xs text-muted-foreground">
                <TimeAgo at={it.pushedAt} />
              </span>
            </p>
            <p className="font-mono text-xs [overflow-wrap:anywhere]">{it.branch}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {it.repoName} · {it.card.title}
            </p>
            <Link
              to={mrCreatePath(it.repoId, it.branch)}
              className="tactile mt-1 inline-flex w-fit items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-2xs font-semibold tracking-[0.04em] text-background uppercase"
            >
              <GitPullRequestCreate aria-hidden className="size-3.5" />
              {t('overview.ads.create')}
            </Link>
          </li>
        ))}
      </ul>
      {items.some((it) => it.stack && it.stack.size > 1) && (
        <p className="text-2xs text-muted-foreground">{t('overview.ads.stacks')}</p>
      )}
    </div>
  );
}

/* ─────────────────────────────── standings ─────────────────────────────── */

/** Progression as a scoreboard: the level in big digits, the XP to go, the streaks as a standings table. */
export function Standings({ className }: { className?: string }) {
  const q = useGamification();
  const { t } = useTranslation();
  if (q.isPending) return <p className="text-sm text-muted-foreground">{t('overview.loading')}</p>;
  if (q.isError) return <p className="text-xs text-destructive">{describeError(q.error)}</p>;
  if (!q.data) return null;
  const p = progressionSummary(q.data);
  const rows: [string, { current: number; best: number }][] = [
    [t('overview.standingsTable.clean'), p.releases],
    [t('overview.standingsTable.sla'), p.slaDays],
    [t('overview.standingsTable.review'), p.reviewDays],
  ];
  return (
    <div className={cn('grid gap-4', className)}>
      <div className="flex items-end gap-4">
        <div className="grid place-items-center bg-foreground px-4 py-2 text-background">
          <span className="type-micro opacity-70">{t('overview.standingsTable.level')}</span>
          <span className="font-mono text-6xl leading-none tabular-nums">{p.level}</span>
        </div>
        <div className="grid flex-1 gap-1.5">
          <p className="flex justify-between font-mono text-xs">
            <span>{p.xp} XP</span>
            <span className="text-muted-foreground">
              {t('overview.standingsTable.toGo', { xp: p.xpToNext })}
            </span>
          </p>
          <div
            role="progressbar"
            aria-label={t('overview.standingsTable.progress', { level: p.level + 1 })}
            aria-valuemin={0}
            aria-valuemax={p.xpForLevel}
            aria-valuenow={p.xpIntoLevel}
            className="flex h-3 gap-0.5"
          >
            {Array.from({ length: 20 }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'flex-1',
                  i < Math.round(p.fraction * 20) ? 'bg-foreground' : 'bg-foreground/10',
                )}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('overview.standingsTable.streaks')}</caption>
          <thead>
            <tr className="type-micro text-muted-foreground">
              <th scope="col" className="pb-1 text-left font-semibold">
                {t('overview.standingsTable.streak')}
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                {t('overview.standingsTable.now')}
              </th>
              <th scope="col" className="pb-1 text-right font-semibold">
                {t('overview.standingsTable.best')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, s]) => (
              <tr key={label} className="border-t border-hairline">
                <th scope="row" className="py-1.5 text-left font-normal">
                  {label}
                </th>
                <td className="py-1.5 text-right font-mono tabular-nums">{s.current}</td>
                <td className="py-1.5 text-right font-mono text-muted-foreground tabular-nums">
                  {s.best}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-mono text-2xs text-muted-foreground">
        {t('overview.standingsTable.achievements', {
          earned: p.badgesEarned,
          total: p.badgesTotal,
        })}
      </p>
    </div>
  );
}

/** A section head as on a newspaper page: a thick rule, a small cap label, and an optional aside. */
export function PressHead({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-2 border-t-[3px] border-foreground pt-1.5',
        className,
      )}
    >
      <h3 className="type-micro">{children}</h3>
      {aside}
    </div>
  );
}

/** A deterministic barcode for the issue: bars from the edition number and the KPIs, purely decorative. */
export function Barcode({ seed, className }: { seed: number; className?: string }) {
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  let s = seed * 9301 + 49297;
  while (x < 120) {
    s = (s * 9301 + 49297) % 233280;
    const w = 1 + (s % 3);
    bars.push({ x, w });
    s = (s * 9301 + 49297) % 233280;
    x += w + 1 + (s % 3);
  }
  return (
    <svg viewBox="0 0 122 40" className={cn('h-10 w-32', className)} aria-hidden>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={0}
          width={b.w}
          height={i % 9 === 0 ? 40 : 34}
          className="fill-foreground"
        />
      ))}
    </svg>
  );
}
