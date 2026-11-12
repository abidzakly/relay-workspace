import type { BadgeId, GamificationReport } from '@relay/shared';

/**
 * What changed between two gamification reports. `gamification.changed` carries no payload, so comparing reports is the
 * only way to see it. Every number here comes from the server: nothing is awarded on the client.
 */
export interface XpBaseline {
  xp: number;
  level: number;
  badges: Partial<Record<BadgeId, number>>;
}

export interface XpDelta {
  xp: number;
  /** The new level, when it went up. */
  level: number | null;
  /** Badges whose count went up, with the new count. */
  badges: { id: BadgeId; count: number }[];
}

const STORAGE_KEY = 'core-reward-baseline';

let memory: XpBaseline | null = null;

export function baselineOf(report: GamificationReport): XpBaseline {
  return {
    xp: report.xp,
    level: report.level.level,
    badges: Object.fromEntries(report.badges.map((b) => [b.id, b.count])),
  };
}

/** Read fresh every time: if another tab already took this change, this tab has nothing to reward. */
export function readBaseline(): XpBaseline | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as XpBaseline;
  } catch {
    /* fall back to this page's own memory */
  }
  return memory;
}

export function writeBaseline(baseline: XpBaseline): void {
  memory = baseline;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
  } catch {
    /* the in-memory copy still holds */
  }
}

/** Null when nothing was gained. XP going down is a server correction, never a reward: the caller just rebaselines. */
export function diffReports(prev: XpBaseline, report: GamificationReport): XpDelta | null {
  const xp = report.xp - prev.xp;
  if (xp < 0) return null;
  const level = report.level.level > prev.level ? report.level.level : null;
  const badges = report.badges
    .filter((b) => b.count > (prev.badges[b.id] ?? 0))
    .map((b) => ({ id: b.id, count: b.count }));
  return xp > 0 || level !== null || badges.length > 0 ? { xp, level, badges } : null;
}
