/**
 * Recently opened review sessions, so Review Home can offer "continue where you left off". A per-browser convenience
 * (like the viewed-file marks): it records only what this browser opened, never review state the server owns.
 */

export interface RecentReview {
  /** In-app path of the session (`/review/:repo/mr/:iid` or `/review/:repo/compare?from=&to=`). */
  path: string;
  kind: 'mr' | 'compare';
  title: string;
  /** "repo · !12" or "repo · compare". */
  context: string;
  at: number;
}

const KEY = 'rv:recent';
export const RECENT_MAX = 6;

function read(): RecentReview[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is RecentReview =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RecentReview).path === 'string' &&
        (r as RecentReview).path.startsWith('/review/') &&
        ((r as RecentReview).kind === 'mr' || (r as RecentReview).kind === 'compare') &&
        typeof (r as RecentReview).title === 'string' &&
        typeof (r as RecentReview).context === 'string' &&
        typeof (r as RecentReview).at === 'number',
    );
  } catch {
    return [];
  }
}

/** Newest first, one entry per session path. */
export function mergeRecent(list: readonly RecentReview[], entry: RecentReview): RecentReview[] {
  return [entry, ...list.filter((r) => r.path !== entry.path)].slice(0, RECENT_MAX);
}

export function recentReviews(): RecentReview[] {
  return read();
}

export function rememberReview(entry: RecentReview): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mergeRecent(read(), entry)));
  } catch {
    /* private mode: a convenience only */
  }
}
