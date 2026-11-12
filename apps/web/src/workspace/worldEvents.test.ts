import { describe, expect, it } from 'vitest';
import type { AppEvent } from '@relay/shared';
import { eventForActivity, eventStrength, reviewQueueEvent } from './worldEvents';

describe('world events', () => {
  it('maps the server MR activity, and nothing else', () => {
    const act = (activity: 'comment' | 'approval' | 'merge'): AppEvent => ({
      type: 'mr.activity',
      repoId: 'app-a',
      iid: 3,
      activity,
    });
    expect(eventForActivity(act('comment'))).toBe('mr.comment');
    expect(eventForActivity(act('approval'))).toBe('mr.approval');
    expect(eventForActivity(act('merge'))).toBe('mr.merged');
    expect(eventForActivity({ type: 'ping' } as AppEvent)).toBeNull();
  });
  it('tells a new review request from one that left, never on first load', () => {
    expect(reviewQueueEvent(null, ['a#1'])).toBeNull();
    expect(reviewQueueEvent(['a#1'], ['a#1'])).toBeNull();
    expect(reviewQueueEvent(['a#1'], ['a#1', 'a#2'])).toBe('review.requested');
    expect(reviewQueueEvent(['a#1', 'a#2'], ['a#2'])).toBe('review.cleared');
    expect(reviewQueueEvent(['a#1'], ['a#2'])).toBe('review.requested');
  });
  it('keeps off-duty rooms quiet', () => {
    expect(eventStrength('review.requested', 'office')).toBe(1);
    expect(eventStrength('review.requested', 'sick')).toBe(0);
    expect(eventStrength('mr.comment', 'leave')).toBe(0);
    expect(eventStrength('mr.merged', 'leave')).toBeGreaterThan(0);
  });
});
