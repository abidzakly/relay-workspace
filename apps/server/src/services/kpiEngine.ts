import {
  formatDuration,
  pointHours,
  pointEffort,
  statusGroupTest,
  type KpiCompletion,
  type KpiEffort,
  type StatusGroups,
  type GlobalConfig,
  type KpiCardMr,
  type KpiCardRow,
  type KpiHistoryItem,
  type KpiLateCard,
  type KpiScorecard,
  type KpiSlaByType,
  type MrState,
  type ReviewLatency,
} from '@relay/shared';
import { deriveReviewLatency, monthOf, type LatencyInput } from './mrTiming';
import {
  computeBugRatio,
  evaluateSla,
  parseNotionDate,
  researchQuotaStatus,
  resolveAssignedAt,
  ruleDaysFor,
  sameCardType,
} from './slaEngine';

/**
 * KPI rules on top of the SLA engine. Pure: `now` and `asOf` are parameters. Local-time months throughout,
 * so `monthBounds` and `monthOf` agree across DST changes.
 */

type SlaConfig = GlobalConfig['sla'];

export interface KpiMrInput {
  repoId: string;
  iid: number;
  state: MrState;
  createdAt: number;
  webUrl: string | null;
  conflict: boolean;
  isVersionMr: boolean;
}

export interface KpiCardInput {
  id: string;
  title: string;
  url: string | null;
  status: string | null;
  type: string | null;
  estimationStart: string | null;
  assignedAtManual: number | null;
  assignedAtProperty: string | null;
  assignedAtFirstSeen: number | null;
  assignedAtApprox: boolean;
  point?: number | null;
  mrs: readonly KpiMrInput[];
}

export interface KpiRowConfig {
  sla: SlaConfig;
  readyStatus: string;
  statusGroups: StatusGroups;
}

/** First and last millisecond of a local month. */
export function monthBounds(month: string): { start: number; end: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime() - 1 };
}

/** A month in progress is read as of now, and a finished one as of its last millisecond, frozen or not. */
export function monthAsOf(month: string, now: number): number {
  return Math.min(now, monthBounds(month).end);
}

/**
 * Which linked MR stops the clock: the earliest one that exists at `asOf`, leaving out version MRs and MRs closed without
 * merging. "Resolved = MR opened", so a later replacement never moves the time, and an abandoned MR delivered nothing.
 */
export function pickStopMr(mrs: readonly KpiMrInput[], asOf: number): KpiMrInput | null {
  let best: KpiMrInput | null = null;
  for (const m of mrs) {
    if (m.isVersionMr || m.state === 'closed' || m.createdAt > asOf) continue;
    if (best === null || m.createdAt < best.createdAt) best = m;
  }
  return best;
}

export type CardMonthInput = Pick<
  KpiCardInput,
  | 'estimationStart'
  | 'assignedAtManual'
  | 'assignedAtProperty'
  | 'assignedAtFirstSeen'
  | 'assignedAtApprox'
>;

/** The month a card counts in: the later of assigned-at and estimation start. Null = no assigned-at, no month. */
export function cardMonth(
  card: CardMonthInput,
  assignedAtSource: SlaConfig['assignedAtSource'],
): string | null {
  const at = resolveAssignedAt({
    source: assignedAtSource,
    manual: card.assignedAtManual,
    property: card.assignedAtProperty,
    firstSeen: card.assignedAtFirstSeen,
    firstSeenApprox: card.assignedAtApprox,
  }).at;
  if (at === null) return null;
  return monthOf(Math.max(at, cardEstimationAt(card) ?? at));
}

function cardEstimationAt(card: Pick<KpiCardInput, 'estimationStart'>): number | null {
  return card.estimationStart === null ? null : (parseNotionDate(card.estimationStart)?.at ?? null);
}

/** Null when the card has no assigned-at at all, so it counts in no month. */
export function buildCardRow(
  card: KpiCardInput,
  config: KpiRowConfig,
  asOf: number,
): KpiCardRow | null {
  const assignedAt = resolveAssignedAt({
    source: config.sla.assignedAtSource,
    manual: card.assignedAtManual,
    property: card.assignedAtProperty,
    firstSeen: card.assignedAtFirstSeen,
    firstSeenApprox: card.assignedAtApprox,
  });
  if (assignedAt.at === null) return null;

  const stop = pickStopMr(card.mrs, asOf);
  const sla = evaluateSla(
    {
      type: card.type,
      assignedAt: assignedAt.at,
      estimationStart: card.estimationStart,
      mrCreatedAt: stop?.createdAt ?? null,
    },
    config.sla,
    asOf,
  );
  const groups = statusGroupTest(config.statusGroups);
  const isReady =
    card.status !== null &&
    card.status.trim().toLowerCase() === config.readyStatus.trim().toLowerCase();
  const reachedReady = isReady || groups.isDone(card.status);

  let mr: KpiCardMr | null = null;
  if (stop) {
    mr = {
      repoId: stop.repoId,
      iid: stop.iid,
      state: stop.state,
      createdAt: stop.createdAt,
      webUrl: stop.webUrl,
      conflict: stop.conflict,
    };
  }
  return {
    cardId: card.id,
    title: card.title,
    url: card.url,
    status: card.status,
    type: card.type,
    month: monthOf(Math.max(assignedAt.at, cardEstimationAt(card) ?? assignedAt.at)),
    completed: groups.isComplete(card.status) || reachedReady,
    assignedAt,
    sla,
    mr,
    ignoredClosedMrs: card.mrs.filter((m) => m.state === 'closed' && !m.isVersionMr).length,
    actionable: !reachedReady && groups.isActionable(card.status),
    reachedReady,
    committed: !groups.isUncommitted(card.status),
    point: card.point ?? null,
  };
}

const hitRateOf = (rows: readonly KpiCardRow[]) => {
  const met = rows.filter((r) => r.sla.state === 'met').length;
  const breached = rows.filter((r) => r.sla.state === 'breached').length;
  const inFlight = rows.filter((r) =>
    ['not_started', 'on_track', 'over_70', 'over_90'].includes(r.sla.state),
  ).length;
  const durations: number[] = [];
  for (const r of rows) {
    if (r.sla.stoppedAt !== null && r.sla.startClock !== null) {
      // An MR opened before the clock started took no time on this card.
      durations.push(Math.max(0, r.sla.stoppedAt - r.sla.startClock));
    }
  }
  const mean = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  return {
    met,
    breached,
    inFlight,
    hitRate: met + breached === 0 ? null : met / (met + breached),
    avgResolutionMs: mean,
    avgResolutionLabel: mean === null ? null : formatDuration(mean),
  };
};

/** Task completion rate (cards that reached Ready to Test or later / committed cards of the month). */
export function completionOf(rows: readonly KpiCardRow[], target: number): KpiCompletion {
  const committed = rows.filter((r) => r.committed);
  const completed = committed.filter((r) => r.reachedReady).length;
  const total = committed.length;
  const rate = total === 0 ? null : completed / total;
  const needed = total === 0 ? 0 : Math.max(0, Math.ceil(target * total - completed - 1e-9));
  return { completed, total, rate, target, met: rate !== null && rate >= target, needed };
}

export function effortOf(rows: readonly KpiCardRow[]): KpiEffort {
  const out: KpiEffort = { totalHours: 0, doneHours: 0, research: 0, unestimated: 0 };
  for (const r of rows) {
    if (!r.committed) continue;
    const e = pointEffort(r.point);
    if (!e) out.unestimated += 1;
    else if (e.kind === 'research') out.research += 1;
    else {
      out.totalHours += e.hours;
      if (r.reachedReady) out.doneHours += pointHours(r.point);
    }
  }
  return out;
}

/** `rows` must all belong to `month` and be evaluated at `asOf`. */
export function buildScorecard(input: {
  month: string;
  asOf: number;
  now: number;
  rows: readonly KpiCardRow[];
  sla: SlaConfig;
  reviewLatency: ReviewLatency;
}): KpiScorecard {
  const { month, asOf, now, rows, sla } = input;

  const byTypeMap = new Map<string, KpiCardRow[]>();
  for (const r of rows) {
    if (r.sla.state === 'untracked' || r.type === null) continue;
    const list = byTypeMap.get(r.type);
    if (list) list.push(r);
    else byTypeMap.set(r.type, [r]);
  }
  const byType: KpiSlaByType[] = [...byTypeMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, list]) => ({
      type,
      ruleDays: ruleDaysFor(type, sla.rules),
      ...hitRateOf(list),
    }));

  const lateCards: KpiLateCard[] = [];
  for (const r of rows) {
    if (r.sla.state !== 'breached' || r.sla.deadline === null) continue;
    const lateByMs = Math.max(0, Math.round(-(r.sla.remainingMs ?? 0)));
    lateCards.push({
      cardId: r.cardId,
      title: r.title,
      url: r.url,
      type: r.type,
      deadline: r.sla.deadline,
      stoppedAt: r.sla.stoppedAt,
      lateByMs,
      lateByLabel: formatDuration(lateByMs),
    });
  }
  lateCards.sort((a, b) => b.lateByMs - a.lateByMs);

  return {
    month,
    asOf,
    counts: {
      cards: rows.length,
      untracked: rows.filter((r) => r.sla.state === 'untracked').length,
      approxAssignedAt: rows.filter((r) => r.assignedAt.approx).length,
    },
    bugRatio: computeBugRatio(
      rows.map((r) => ({ type: r.type, completed: r.completed })),
      sla,
    ),
    research: researchQuotaStatus({
      count: rows.filter((r) => sameCardType(r.type, sla.researchType)).length,
      required: sla.researchMinPerMonth,
      month,
      now,
    }),
    sla: {
      overall: hitRateOf(rows.filter((r) => r.sla.state !== 'untracked')),
      byType,
    },
    lateCards,
    reviewLatency: input.reviewLatency,
    completion: completionOf(rows, sla.completionTarget),
    effort: effortOf(rows),
  };
}

/** Review latency of the MRs opened in `month`. A response after `asOf` had not happened yet. */
export function monthReviewLatency(
  month: string,
  asOf: number,
  mrs: readonly LatencyInput[],
): ReviewLatency {
  return deriveReviewLatency(
    mrs
      .filter((m) => monthOf(m.createdAt) === month && m.createdAt <= asOf)
      .map((m) => ({
        ...m,
        firstReviewerResponseAt:
          m.firstReviewerResponseAt !== null && m.firstReviewerResponseAt <= asOf
            ? m.firstReviewerResponseAt
            : null,
      })),
  );
}

/**
 * The timer still counts and something can still be done about it (an MR would stop it). A card that is parked or
 * closed (Archived, Done, Backlog…) or already with QA is not something to act on, whatever its clock says.
 */
export function isOpenTimer(r: KpiCardRow): boolean {
  return r.sla.stoppedAt === null && !r.completed && r.actionable && r.sla.state !== 'untracked';
}

/**
 * Today's focus: only cards that still move THIS month's KPIs, i.e. the current month's actionable
 * running timers, least time left first. Older months' leftovers cannot change this month's scorecard.
 */
export function todaysFocus(rows: readonly KpiCardRow[], currentMonth: string): KpiCardRow[] {
  return rows
    .filter((r) => r.month === currentMonth && isOpenTimer(r) && r.sla.state !== 'not_started')
    .sort(
      (a, b) =>
        (a.sla.remainingMs ?? 0) - (b.sla.remainingMs ?? 0) || a.cardId.localeCompare(b.cardId),
    );
}

/** pushes at 80%, which no SLA state marks, so it is read from the fraction. */
const WARN_FRACTION = 0.8;

export interface SlaNotices {
  warn: KpiCardRow[];
  breach: KpiCardRow[];
}

/** Cards that qualify for a push right now, whether or not one went out already. */
export function slaNotices(rows: readonly KpiCardRow[]): SlaNotices {
  const open = rows.filter(isOpenTimer);
  return {
    breach: open.filter((r) => r.sla.state === 'breached'),
    warn: open.filter(
      (r) =>
        r.sla.state !== 'breached' &&
        r.sla.state !== 'not_started' &&
        (r.sla.elapsedFraction ?? 0) >= WARN_FRACTION,
    ),
  };
}

/** Identity of a notice: a moved deadline is a new one. */
export const noticeKey = (r: KpiCardRow): string => `${r.cardId}@${r.sla.deadline ?? 0}`;

/**
 * One notice stream, as the mismatch notifier works: `sent` null means "nothing recorded", which records what exists
 * without notifying. A key no longer qualifying is forgotten, so a recurrence notifies again.
 */
export function advanceNotices(
  sent: readonly string[] | null,
  current: readonly string[],
): { sent: string[]; fresh: string[] } {
  if (sent === null) return { sent: [...current], fresh: [] };
  const known = new Set(sent);
  return { sent: [...current], fresh: current.filter((k) => !known.has(k)) };
}

export function historyItem(
  month: string,
  frozenAt: number,
  scorecard: KpiScorecard,
): KpiHistoryItem {
  return {
    month,
    frozenAt,
    bugRatio: scorecard.bugRatio.ratio,
    bugOverLimit: scorecard.bugRatio.overLimit,
    researchCount: scorecard.research.count,
    researchMet: scorecard.research.state === 'met',
    hitRate: scorecard.sla.overall.hitRate,
    lateCards: scorecard.lateCards.length,
    completionRate: scorecard.completion?.rate ?? null,
  };
}
