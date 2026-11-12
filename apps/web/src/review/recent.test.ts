import { describe, expect, it } from 'vitest';
import { mergeRecent, RECENT_MAX, type RecentReview } from './recent';

const entry = (path: string, at: number): RecentReview => ({
  path,
  kind: 'mr',
  title: path,
  context: 'repo · !1',
  at,
});

describe('recent reviews', () => {
  it('puts the newest first and keeps one entry per session', () => {
    const list = [entry('/review/a/mr/1', 1), entry('/review/a/mr/2', 2)];
    const next = mergeRecent(list, entry('/review/a/mr/2', 3));
    expect(next.map((r) => r.path)).toEqual(['/review/a/mr/2', '/review/a/mr/1']);
    expect(next[0]?.at).toBe(3);
  });
  it('keeps at most RECENT_MAX sessions', () => {
    let list: RecentReview[] = [];
    for (let i = 0; i < RECENT_MAX + 3; i++)
      list = mergeRecent(list, entry(`/review/a/mr/${i}`, i));
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0]?.path).toBe(`/review/a/mr/${RECENT_MAX + 2}`);
  });
});
