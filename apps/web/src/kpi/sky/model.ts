import type { KpiReport } from '@relay/shared';
import {
  bugGauge,
  completionGauge,
  hitRateGauge,
  researchGauge,
  type GaugeModel,
  type GaugeTone,
} from '../model';

/** Pure model behind the KPI sky: the same numbers as the scorecard, shaped for the three themes. */

export type BodyKey = 'completion' | 'bug' | 'sla' | 'research';
export type SkyTheme = 'pool' | 'stars' | 'tide';

export const SKY_THEMES: readonly { id: SkyTheme; label: string; hint: string }[] = [
  { id: 'pool', label: 'Dream pool', hint: 'The month as a glass orb filling with work' },
  { id: 'stars', label: 'Constellations', hint: 'One constellation per KPI, lit as it is reached' },
  {
    id: 'tide',
    label: 'Tide',
    hint: 'Constellations rise out of the water as they reach the line',
  },
];

export interface SkyBody {
  key: BodyKey;
  gauge: GaugeModel;
  tone: GaugeTone;
  /** The raw value, 0..1, or null when there is nothing to measure. */
  fraction: number | null;
  /** The line it is judged against, 0..1, or null when it has none (the hit-rate). */
  target: number | null;
  /** Lower is better (the bug ratio). */
  inverse: boolean;
  /**
   * How far towards its line, 0..1: actual ÷ target, or target ÷ actual when lower is better (the weighted sheet's
   * rule). With no line, the value itself. 1 = on the line or past it.
   */
  rise: number;
  /** Reached its line. null = no line, or nothing to measure. */
  met: boolean | null;
  /** Salience: 0 is the most urgent. */
  rank: number;
}

export interface SkyLate {
  id: string;
  title: string;
  url: string | null;
  lateBy: string;
  lateByMs: number;
}

export interface KpiSkyModel {
  month: string;
  current: boolean;
  bodies: SkyBody[];
  /** Every body by key, for the themes that draw a fixed element per KPI. */
  byKey: Partial<Record<BodyKey, SkyBody>>;
  /** Where we are in the month, 0..1. A finished month is 1. */
  monthProgress: number;
  /** The pool's level and the moon's fullness: task completion. */
  level: { fraction: number | null; target: number | null; label: string; valueText: string };
  bugs: { count: number; total: number; overLimit: boolean; ratio: number; max: number };
  research: { count: number; required: number };
  sla: { met: number; breached: number; inFlight: number; hitRate: number | null };
  late: SkyLate[];
  verdict: { headline: string; sub: string; tone: GaugeTone; withLine: number; onLine: number };
}

const TONE_RANK: Record<GaugeTone, number> = { critical: 0, warning: 1, neutral: 2, good: 3 };
const clamp = (n: number) => Math.min(1, Math.max(0, n));

function monthProgressOf(month: string, current: boolean, now: number): number {
  if (!current) return 1;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1;
  const start = new Date(y, m, 1).getTime();
  const end = new Date(y, m + 1, 1).getTime();
  return clamp((now - start) / (end - start));
}

function riseOf(fraction: number | null, target: number | null, inverse: boolean): number {
  if (fraction === null) return 0;
  if (target === null) return clamp(fraction);
  if (inverse) return fraction <= target ? 1 : fraction === 0 ? 1 : clamp(target / fraction);
  return target === 0 ? 1 : clamp(fraction / target);
}

export function skyModel(
  report: KpiReport,
  presets: { bugRatio: boolean; researchQuota: boolean },
  options: { now?: number } = {},
): KpiSkyModel {
  const s = report.scorecard;
  const now = options.now ?? Date.now();
  const raw: [BodyKey, GaugeModel, boolean][] = [
    ['completion', completionGauge(s.completion), false],
    ['bug', bugGauge(s.bugRatio), true],
    ['sla', hitRateGauge(s.sla.overall), false],
    ['research', researchGauge(s.research), false],
  ];
  const enabled = raw.filter(
    ([key]) => (key !== 'bug' || presets.bugRatio) && (key !== 'research' || presets.researchQuota),
  );
  const bodies: SkyBody[] = enabled.map(([key, gauge, inverse]) => {
    const fraction = gauge.fraction === null ? null : clamp(gauge.fraction);
    // The research quota's line is the quota itself: its fraction is already count ÷ required.
    const target = key === 'research' ? 1 : gauge.threshold ? gauge.threshold.fraction : null;
    const rise = riseOf(fraction, target, inverse);
    const met = fraction === null || target === null ? null : rise >= 1 - 1e-9;
    return {
      key,
      gauge,
      tone: gauge.status.tone,
      fraction,
      target,
      inverse,
      rise,
      met,
      rank: 0,
    };
  });
  const ordered = [...bodies].sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || bodies.indexOf(a) - bodies.indexOf(b),
  );
  ordered.forEach((b, i) => (b.rank = i));

  const byKey: KpiSkyModel['byKey'] = {};
  for (const b of bodies) byKey[b.key] = b;

  const withLine = bodies.filter((b) => b.met !== null);
  const onLine = withLine.filter((b) => b.met).length;
  const worst = ordered[0];
  let verdict: KpiSkyModel['verdict'];
  if (!worst) {
    verdict = { headline: 'Nothing to measure', sub: '', tone: 'neutral', withLine: 0, onLine: 0 };
  } else if (worst.tone === 'critical' || worst.tone === 'warning') {
    verdict = {
      headline: `${worst.gauge.label}: ${worst.gauge.status.label}`,
      sub: worst.gauge.detail,
      tone: worst.tone,
      withLine: withLine.length,
      onLine,
    };
  } else if (withLine.length > 0 && onLine === withLine.length) {
    verdict = {
      headline: 'Every line is met',
      sub: report.current ? 'Keep the month steady.' : 'A clean month.',
      tone: 'good',
      withLine: withLine.length,
      onLine,
    };
  } else {
    verdict = {
      headline: `${onLine} of ${withLine.length} on target`,
      sub: worst.gauge.detail,
      tone: worst.tone,
      withLine: withLine.length,
      onLine,
    };
  }

  const completion = byKey.completion;
  const level = {
    fraction: completion?.fraction ?? null,
    target: completion?.target ?? null,
    label: 'Task completion',
    valueText: completion?.gauge.valueText ?? '—',
  };

  return {
    month: report.month,
    current: report.current,
    bodies,
    byKey,
    monthProgress: monthProgressOf(report.month, report.current, now),
    level,
    bugs: {
      count: s.bugRatio.bugs,
      total: s.bugRatio.total,
      overLimit: s.bugRatio.overLimit,
      ratio: s.bugRatio.ratio,
      max: s.bugRatio.max,
    },
    research: { count: s.research.count, required: s.research.required },
    sla: {
      met: s.sla.overall.met,
      breached: s.sla.overall.breached,
      inFlight: s.sla.overall.inFlight,
      hitRate: s.sla.overall.hitRate,
    },
    late: s.lateCards.map((c) => ({
      id: c.cardId,
      title: c.title,
      url: c.url,
      lateBy: c.lateByLabel,
      lateByMs: c.lateByMs,
    })),
    verdict,
  };
}

/** The section each body opens on the KPI page. */
export const BODY_SECTION: Record<BodyKey, string> = {
  completion: 'kpi-scorecard',
  bug: 'kpi-scorecard',
  sla: 'kpi-sla-type',
  research: 'kpi-scorecard',
};
