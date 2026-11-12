import {
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Hourglass,
  Minus,
  OctagonAlert,
  Target,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  formatDuration,
  type BugRatio,
  type KpiCardRow,
  type KpiScorecard,
  type ResearchQuota,
  type SlaEvaluation,
  type SlaState,
} from '@relay/shared';

/** Pure display rules for the KPI view, the Board's SLA slot and (later) Overview. */

export type SlaVariant = 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';

/** icons. Colour is never the only signal: icon and label are always shown. */
export const SLA_META: Record<
  SlaState,
  { icon: LucideIcon; label: string; variant: SlaVariant; className?: string }
> = {
  untracked: { icon: Minus, label: 'no timer', variant: 'outline' },
  not_started: { icon: Hourglass, label: 'not started', variant: 'secondary' },
  on_track: { icon: CircleDot, label: 'on track', variant: 'success' },
  over_70: { icon: CircleAlert, label: 'over 70%', variant: 'warning' },
  // No theme token sits between warning and destructive.
  over_90: {
    icon: TriangleAlert,
    label: 'over 90%',
    variant: 'warning',
    className: 'bg-terracotta/20 text-emphasis',
  },
  breached: { icon: OctagonAlert, label: 'breached', variant: 'destructive' },
  met: { icon: CircleCheck, label: 'met', variant: 'success' },
};

const UNTRACKED_REASON: Record<NonNullable<SlaEvaluation['untrackedReason']>, string> = {
  no_type: 'the card has no type',
  no_rule: 'no SLA rule for this type',
  no_assigned_at: 'assigned-at is unknown',
};

/**
 * The time part of an SLA state. `now` measures a running timer live; null reads the stored evaluation, for a finished
 * month, whose timers are as of its last millisecond.
 */
export function slaTimeLabel(sla: SlaEvaluation, now: number | null): string {
  if (sla.state === 'untracked') {
    return sla.untrackedReason ? UNTRACKED_REASON[sla.untrackedReason] : '';
  }
  if (sla.stoppedAt !== null) {
    const margin = formatDuration(Math.abs(sla.remainingMs ?? 0));
    return sla.state === 'breached' ? `MR opened ${margin} late` : `MR opened ${margin} early`;
  }
  const liveDelta = (at: number | null) => (now !== null && at !== null ? at - now : null);
  if (sla.state === 'not_started') {
    const untilStart = liveDelta(sla.startClock);
    return untilStart !== null && untilStart > 0 ? `starts in ${formatDuration(untilStart)}` : '';
  }
  const left = liveDelta(sla.deadline) ?? sla.remainingMs;
  if (left === null) return '';
  const suffix = now === null ? ' at month end' : '';
  return left >= 0
    ? `${formatDuration(left)} left${suffix}`
    : `late by ${formatDuration(-left)}${suffix}`;
}

/** Keeps a decimal, so 30.4% does not read as "30%, over a limit of 30%". */
export const formatPercent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;

/* ───────────────────────── gauges ───────────────────────── */

export type GaugeTone = 'good' | 'warning' | 'critical' | 'neutral';

export interface GaugeModel {
  label: string;
  /** 0..1. null = nothing to measure yet, so no bar is drawn. */
  fraction: number | null;
  valueText: string;
  status: { icon: LucideIcon; label: string; tone: GaugeTone };
  /** The line on the track. */
  threshold: { fraction: number; label: string } | null;
  detail: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Red above the limit, and exactly at it is still fine. The server decides `overLimit`. */
export function bugGauge(b: BugRatio): GaugeModel {
  const threshold = { fraction: b.max, label: `limit ${formatPercent(b.max)}` };
  const label = 'Bug ratio';
  if (b.total === 0) {
    return {
      label,
      fraction: null,
      valueText: '—',
      status: { icon: Minus, label: 'no cards', tone: 'neutral' },
      threshold,
      detail: 'No cards count towards this month yet.',
    };
  }
  const counts = `${plural(b.bugs, 'bug')} of ${plural(b.total, 'card')}.`;
  let recover = '';
  if (b.overLimit) {
    recover =
      b.nonBugCardsToRecover === null
        ? ' With a limit of 0%, more cards cannot bring it back.'
        : ` ${plural(b.nonBugCardsToRecover, 'more non-bug card')} to get back within the limit.`;
  }
  return {
    label,
    fraction: b.ratio,
    valueText: formatPercent(b.ratio),
    status: b.overLimit
      ? { icon: OctagonAlert, label: 'over the limit', tone: 'critical' }
      : { icon: CircleCheck, label: 'within the limit', tone: 'good' },
    threshold,
    detail: counts + recover,
  };
}

/** No target exists for the hit-rate in or the config, so it has no threshold and stays neutral. */
export function hitRateGauge(overall: KpiScorecard['sla']['overall']): GaugeModel {
  const inFlight = `${overall.inFlight} in flight, not counted.`;
  const label = 'SLA hit-rate';
  if (overall.hitRate === null) {
    return {
      label,
      fraction: null,
      valueText: '—',
      status: { icon: Minus, label: 'nothing finished yet', tone: 'neutral' },
      threshold: null,
      detail: `0 met, 0 breached. ${inFlight}`,
    };
  }
  return {
    label,
    fraction: overall.hitRate,
    valueText: formatPercent(overall.hitRate),
    status: {
      icon: ChartColumn,
      label: `${overall.met + overall.breached} finished`,
      tone: 'neutral',
    },
    threshold: null,
    detail: `${overall.met} met, ${overall.breached} breached. ${inFlight}`,
  };
}

export function researchGauge(r: ResearchQuota): GaugeModel {
  const status: GaugeModel['status'] =
    r.state === 'met'
      ? { icon: CircleCheck, label: 'quota met', tone: 'good' }
      : r.state === 'missed'
        ? { icon: OctagonAlert, label: 'quota missed', tone: 'critical' }
        : r.reminderDue
          ? { icon: TriangleAlert, label: 'reminder day passed', tone: 'warning' }
          : { icon: Hourglass, label: 'in progress', tone: 'neutral' };
  return {
    label: 'Research quota',
    fraction: r.required === 0 ? 1 : Math.min(1, r.count / r.required),
    valueText: `${r.count} of ${r.required}`,
    status,
    threshold: null,
    detail: r.remaining > 0 ? `${r.remaining} more needed.` : 'Nothing more needed.',
  };
}

/* ───────────────────────── SLA table ───────────────────────── */

export interface SlaRowGroup {
  key: 'counted' | 'inFlight' | 'otherMonths' | 'untracked';
  title: string;
  hint: string;
  rows: KpiCardRow[];
}

const IN_FLIGHT: ReadonlySet<SlaState> = new Set(['not_started', 'on_track', 'over_70', 'over_90']);

const byDeadline = (a: KpiCardRow, b: KpiCardRow): number =>
  (a.sla.deadline ?? Infinity) - (b.sla.deadline ?? Infinity) || a.title.localeCompare(b.title);

/**
 * Splits the table the way the scorecard counts it. A current-month response also lists open timers of other months,
 * and those count in their own month, so they get their own group rather than appearing to feed this hit-rate.
 */
export function groupSlaRows(rows: readonly KpiCardRow[], month: string): SlaRowGroup[] {
  const groups: SlaRowGroup[] = [
    {
      key: 'counted',
      title: 'Counted in the hit-rate',
      hint: 'Met or breached',
      rows: [],
    },
    {
      key: 'inFlight',
      title: 'In flight',
      hint: 'Timer still running or not started, so not in the hit-rate',
      rows: [],
    },
    {
      key: 'otherMonths',
      title: 'Open timers from other months',
      hint: 'Counted in the month shown on each row, not in this one',
      rows: [],
    },
    {
      key: 'untracked',
      title: 'No timer',
      hint: 'Not in the hit-rate',
      rows: [],
    },
  ];
  const [counted, inFlight, otherMonths, untracked] = groups as [
    SlaRowGroup,
    SlaRowGroup,
    SlaRowGroup,
    SlaRowGroup,
  ];
  for (const r of rows) {
    if (r.month !== month) otherMonths.rows.push(r);
    else if (r.sla.state === 'untracked') untracked.rows.push(r);
    else if (IN_FLIGHT.has(r.sla.state)) inFlight.rows.push(r);
    else counted.rows.push(r);
  }
  for (const g of groups) g.rows.sort(byDeadline);
  return groups.filter((g) => g.rows.length > 0);
}

/** Task completion rate: cards that reached Ready to Test (or later) over committed cards. Target ≥ 90%. */
export function completionGauge(c: KpiScorecard['completion']): GaugeModel {
  const label = 'Task completion';
  if (!c) {
    return {
      label,
      fraction: null,
      valueText: '—',
      status: { icon: Minus, label: 'not recorded', tone: 'neutral' },
      threshold: null,
      detail: 'This month was frozen before the completion rate existed.',
    };
  }
  const threshold = { fraction: c.target, label: `target ${formatPercent(c.target)}` };
  if (c.rate === null) {
    return {
      label,
      fraction: null,
      valueText: '—',
      status: { icon: Minus, label: 'no cards', tone: 'neutral' },
      threshold,
      detail: 'No committed cards this month yet.',
    };
  }
  return {
    label,
    fraction: c.rate,
    valueText: formatPercent(c.rate),
    status: c.met
      ? { icon: CircleCheck, label: 'on target', tone: 'good' }
      : {
          icon: Target,
          label: 'below target',
          tone: c.rate >= c.target - 0.15 ? 'warning' : 'critical',
        },
    threshold,
    detail:
      `${c.completed} of ${plural(c.total, 'card')} reached Ready to Test.` +
      (c.met ? '' : ` ${plural(c.needed, 'more card')} to reach the target.`),
  };
}
