import type { GamificationReport, GamificationStreak, KpiCardRow } from '@relay/shared';
import { APPROVAL_KEYWORD_RE } from './gitlabMr';

/** Gamification rules. Pure: no DB, no clock. Days are local, like KPI months. */

export const XP = {
  cardReady: 10,
  approval: 5,
  release: 25,
  slaMet: 15,
  /** Review Deck finished at 100% coverage. No XP for speed. */
  deckCompleted: 8,
  /** Per issue noted in a finished deck, capped per deck. */
  issueFound: 3,
} as const;
export const MAX_ISSUE_XP_PER_DECK = 3;

/**
 * Daily review streak: consecutive local days with a finished deck, ending today, or yesterday when today has none
 * yet (the day is not over). `days` are `YYYY-MM-DD`.
 */
export function reviewStreak(days: ReadonlySet<string>, today: string): GamificationStreak {
  if (days.size === 0) return { current: 0, best: 0 };
  const sorted = [...days].sort();
  const toMs = (d: string) => Date.parse(`${d}T12:00:00`);
  const values: boolean[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  const end = days.has(today) ? toMs(today) : toMs(today) - DAY;
  for (let t = toMs(sorted[0]!); t <= end; t += DAY) values.push(days.has(localDay(t)));
  return streakOf(values);
}
export const APPROVALS_FOR_BADGE = 5;

/** Level 1 takes 100 XP, level 2 takes 200, and so on. */
const XP_PER_LEVEL_STEP = 100;

export function levelFor(xp: number): GamificationReport['level'] {
  let level = 1;
  let left = xp;
  while (left >= level * XP_PER_LEVEL_STEP) {
    left -= level * XP_PER_LEVEL_STEP;
    level += 1;
  }
  return { level, xpIntoLevel: left, xpForLevel: level * XP_PER_LEVEL_STEP };
}

/** `YYYY-MM-DD` in local time. */
export function localDay(t: number): string {
  const d = new Date(t);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The current run ends at the last value; a false breaks it. Input is oldest first. */
export function streakOf(values: readonly boolean[]): GamificationStreak {
  let current = 0;
  let best = 0;
  for (const ok of values) {
    current = ok ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return { current, best };
}

export interface SlaDayTally {
  met: number;
  breached: number;
}

/**
 * Per local day, how many timers were decided. A met timer counts on the day its MR opened, and a breached one on the
 * day its deadline passed, even if the MR came later. A day with no decided timer does not exist here, so it neither
 * extends nor breaks the streak.
 */
export function tallySlaDays(rows: readonly KpiCardRow[], into: Map<string, SlaDayTally>): void {
  for (const { sla } of rows) {
    const at = sla.state === 'met' ? sla.stoppedAt : sla.state === 'breached' ? sla.deadline : null;
    if (at === null) continue;
    const day = localDay(at);
    const tally = into.get(day) ?? { met: 0, breached: 0 };
    if (sla.state === 'met') tally.met += 1;
    else tally.breached += 1;
    into.set(day, tally);
  }
}

/** The rule: "bug ratio < 20% in a month". The limit is the configured one, as frozen with the month. */
export const earnsBugSlayer = (b: { total: number; ratio: number; max: number }): boolean =>
  b.total > 0 && b.ratio < b.max;

/** A quota of 0 is not an achievement. */
export const earnsResearcher = (r: { required: number; state: string }): boolean =>
  r.required > 0 && r.state === 'met';

export interface FirstTryNote {
  author: string | null;
  body: string;
}

/** Has anyone but the author commented? In `note_keyword` mode a reviewer's approval note is the approval itself. */
export function hasOutsideComment(
  notes: readonly FirstTryNote[],
  me: string,
  keywordApprovals: boolean,
): boolean {
  return notes.some((n) => {
    if (n.author?.toLowerCase() === me.toLowerCase()) return false;
    if (!keywordApprovals) return true;
    const firstLine = n.body.split('\n').find((l) => l.trim().length > 0) ?? '';
    return !APPROVAL_KEYWORD_RE.test(firstLine.trim());
  });
}
