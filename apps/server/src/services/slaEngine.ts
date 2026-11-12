import type {
  AssignedAtResolution,
  BugRatio,
  GlobalConfig,
  ResearchQuota,
  SlaEvaluation,
  SlaState,
  SlaUntrackedReason,
} from '@relay/shared';

/**
 * SLA engine. Pure: no DB, no HTTP, and `now` is always a parameter.
 *
 * Days, weekends, date-only Notion values and months all follow the server's local time zone, which on this
 * local-first app is the user's. Results therefore depend on the process's `TZ`. Public holidays are not known.
 */

type SlaConfig = GlobalConfig['sla'];
export type SlaUnit = SlaConfig['unit'];

const OVER_70 = 0.7;
const OVER_90 = 0.9;
/** The research reminder goes out on day 20. */
const RESEARCH_REMINDER_DAY = 20;
/** Absorbs float noise such as 3 / 0.3 = 10.000000000000002, which must not ask for an extra card. */
const RECOVERY_EPSILON = 1e-9;

const typeKey = (s: string): string => s.trim().toLowerCase();

const isWeekend = (d: Date): boolean => d.getDay() === 0 || d.getDay() === 6;

export function sameCardType(a: string | null, b: string): boolean {
  return a !== null && typeKey(a) === typeKey(b);
}

/** Days allowed for a type, or null when it has no rule. Matches like the card cache: ignoring case and spaces. */
export function ruleDaysFor(type: string, rules: SlaConfig['rules']): number | null {
  const key = typeKey(type);
  for (const [name, days] of Object.entries(rules)) {
    if (typeKey(name) === key && days > 0) return days;
  }
  return null;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A Notion date value. `YYYY-MM-DD` is the start of that local day, whereas `Date.parse` would read it as UTC midnight.
 * Anything unreadable, including an impossible date like 2026-02-31, is null.
 */
export function parseNotionDate(raw: string): { at: number; dateOnly: boolean } | null {
  const s = raw.trim();
  const m = DATE_ONLY_RE.exec(s);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(year, month - 1, day);
    const real = d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
    return real ? { at: d.getTime(), dateOnly: true } : null;
  }
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : { at, dateOnly: false };
}

/**
 * `start` plus `days`, keeping the wall-clock time across a DST change.
 *
 * With working days a start on a weekend counts from Monday 00:00, so Friday 10:00 + 1 is Monday 10:00 and
 * Saturday 10:00 + 1 is Tuesday 00:00: each working day is always a full 24 counted hours.
 */
export function addSlaDays(start: number, days: number, unit: SlaUnit): number {
  const d = new Date(start);
  if (unit === 'calendar') {
    d.setDate(d.getDate() + days);
    return d.getTime();
  }
  while (isWeekend(d)) {
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) left--;
  }
  return d.getTime();
}

/** Counted time between two instants: all of it for calendar days, weekdays only for working days. */
function countedMs(from: number, to: number, unit: SlaUnit): number {
  if (to <= from) return 0;
  if (unit === 'calendar') return to - from;
  let total = 0;
  let at = from;
  while (at < to) {
    const d = new Date(at);
    const end = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), to);
    if (!isWeekend(d)) total += end - at;
    at = end;
  }
  return total;
}

export function resolveAssignedAt(input: {
  source: SlaConfig['assignedAtSource'];
  /** The per-card override. Wins over the configured source. */
  manual: number | null;
  /** Raw value of the Notion "Assigned at" date property. Used when `source` is `property`. */
  property: string | null;
  firstSeen: number | null;
  /** `Card.assignedAtApprox`: `firstSeen` is really the card's `created_time`. */
  firstSeenApprox: boolean;
}): AssignedAtResolution {
  if (input.manual !== null) return { at: input.manual, source: 'manual', approx: false };

  let wantedPropertyMissing = false;
  if (input.source === 'property') {
    const parsed = input.property === null ? null : parseNotionDate(input.property);
    // A date with no time only says which day it happened.
    if (parsed) return { at: parsed.at, source: 'property', approx: parsed.dateOnly };
    wantedPropertyMissing = true;
  }

  if (input.firstSeen === null) return { at: null, source: null, approx: false };
  return {
    at: input.firstSeen,
    source: 'firstSeen',
    approx: input.firstSeenApprox || wantedPropertyMissing,
  };
}

export function evaluateSla(
  card: {
    type: string | null;
    assignedAt: number | null;
    /** Raw Notion value (`Card.estimationStart`). */
    estimationStart: string | null;
    /** The linked MR's `created_at`. */
    mrCreatedAt: number | null;
  },
  config: Pick<SlaConfig, 'rules' | 'unit'>,
  now: number,
): SlaEvaluation {
  const estimation = card.estimationStart === null ? null : parseNotionDate(card.estimationStart);
  const estimationInvalid = card.estimationStart !== null && estimation === null;

  const untracked = (
    untrackedReason: SlaUntrackedReason,
    ruleDays: number | null = null,
  ): SlaEvaluation => ({
    state: 'untracked',
    untrackedReason,
    ruleDays,
    startClock: null,
    deadline: null,
    stoppedAt: null,
    elapsedFraction: null,
    remainingMs: null,
    estimationInvalid,
  });

  if (card.type === null || card.type.trim() === '') return untracked('no_type');
  const ruleDays = ruleDaysFor(card.type, config.rules);
  if (ruleDays === null) return untracked('no_rule');
  if (card.assignedAt === null) return untracked('no_assigned_at', ruleDays);

  const startClock = Math.max(card.assignedAt, estimation?.at ?? card.assignedAt);
  const deadline = addSlaDays(startClock, ruleDays, config.unit);
  const stoppedAt = card.mrCreatedAt;
  const at = stoppedAt ?? now;
  // Bounded before counting: an old card's `at` can be far past the deadline.
  const elapsedFraction =
    countedMs(startClock, Math.min(at, deadline), config.unit) /
    countedMs(startClock, deadline, config.unit);

  let state: SlaState;
  // An MR beats everything else: the work is delivered even if its estimation has not begun.
  if (stoppedAt !== null) state = stoppedAt <= deadline ? 'met' : 'breached';
  else if (now < startClock) state = 'not_started';
  else if (now > deadline) state = 'breached';
  else if (elapsedFraction > OVER_90) state = 'over_90';
  else if (elapsedFraction > OVER_70) state = 'over_70';
  else state = 'on_track';

  return {
    state,
    untrackedReason: null,
    ruleDays,
    startClock,
    deadline,
    stoppedAt,
    elapsedFraction,
    remainingMs: deadline - at,
    estimationInvalid,
  };
}

/**
 * `sla.bugRatioDenominator`: `all` counts every card given, and `completed` counts only completed ones on both sides
 * of the fraction, so the ratio stays a share of the same set. Which cards belong to the month is the caller's choice.
 */
export function computeBugRatio(
  cards: readonly { type: string | null; completed: boolean }[],
  config: Pick<SlaConfig, 'bugType' | 'bugRatioMax' | 'bugRatioDenominator'>,
): BugRatio {
  const counted =
    config.bugRatioDenominator === 'completed' ? cards.filter((c) => c.completed) : cards;
  const total = counted.length;
  const bugs = counted.filter((c) => sameCardType(c.type, config.bugType)).length;
  const max = config.bugRatioMax;
  const ratio = total === 0 ? 0 : bugs / total;
  const overLimit = ratio > max;

  let nonBugCardsToRecover: number | null = 0;
  if (overLimit) {
    // bugs / (total + n) <= max
    nonBugCardsToRecover = max === 0 ? null : Math.ceil(bugs / max - total - RECOVERY_EPSILON);
  }
  return { bugs, total, ratio, max, overLimit, nonBugCardsToRecover };
}

/** `month` is `YYYY-MM`. */
export function researchQuotaStatus(input: {
  count: number;
  required: number;
  month: string;
  now: number;
}): ResearchQuota {
  const { count, required, month } = input;
  const today = new Date(input.now);
  const currentMonth = `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const met = count >= required;
  return {
    count,
    required,
    remaining: Math.max(required - count, 0),
    state: met ? 'met' : month < currentMonth ? 'missed' : 'pending',
    reminderDue: !met && month === currentMonth && today.getDate() >= RESEARCH_REMINDER_DAY,
  };
}
