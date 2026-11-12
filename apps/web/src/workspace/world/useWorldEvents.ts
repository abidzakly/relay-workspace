import { useEffect, useRef } from 'react';
import { getEventStream } from '@/lib/sse';
import { recentReviews } from '@/review/recent';
import type { EnvId } from '../envFor';
import {
  eventForActivity,
  eventStrength,
  reviewQueueEvent,
  reviewStartedSince,
  storyBeat,
  type StoryBeat,
  type WorldEventKind,
} from '../worldEvents';

/**
 * The engineering events the world tells, from authoritative state only: the review queue's arrivals and
 * departures (`reviewKeys`, compared reading to reading) and the server's `mr.activity` (comments, approvals, merges).
 * `onEvent` gets the kind and how loud this environment tells it; silent events (strength 0, e.g. on a sick day) are
 * never delivered. Nothing fires under `animate === false` (reduced motion, a page over the world).
 */
export function useWorldEvents({
  env,
  animate,
  reviewKeys,
  onEvent,
}: {
  env: EnvId;
  animate: boolean;
  reviewKeys: string[] | null;
  onEvent: (kind: WorldEventKind, strength: number) => void;
}): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const live = useRef({ env, animate });
  live.current = { env, animate };

  const fire = (kind: WorldEventKind) => {
    const { env: e, animate: a } = live.current;
    if (!a) return;
    const strength = eventStrength(kind, e);
    if (strength > 0) handler.current(kind, strength);
  };

  // A review request arriving in / leaving the inbox. The first reading only sets the baseline.
  const prev = useRef<string[] | null>(null);
  const sig = reviewKeys?.join('|') ?? null;
  useEffect(() => {
    if (reviewKeys === null) return;
    const kind = reviewQueueEvent(prev.current, reviewKeys);
    prev.current = reviewKeys;
    if (kind) fire(kind);
    // `sig` is the identity that matters; the array itself is read, not watched.
  }, [sig]);

  // Comments, approvals and merges, as the server reports them.
  useEffect(() => {
    if (!animate) return;
    return getEventStream().subscribe((e) => {
      const kind = eventForActivity(e);
      if (kind) fire(kind);
    });
  }, [animate]);

  // Back in view after a review session was opened: the review started. Each listener keeps its own "last looked".
  const reviewsSeenAt = useRef(Date.now());
  useEffect(() => {
    if (!animate) return;
    const now = Date.now();
    const opened = (() => {
      try {
        return recentReviews();
      } catch {
        return [];
      }
    })();
    const started = reviewStartedSince(opened, reviewsSeenAt.current);
    reviewsSeenAt.current = now;
    if (started) fire('review.started');
  }, [animate]);
}

/**
 * One environment-specific story beat: `onBeat(strength)` runs when an event this environment tells as
 * `beat` happens. Built on `useWorldEvents`, so the same rules hold: real events only, quiet off duty, never under
 * reduced motion, never blocking.
 */
export function useStoryBeat({
  env,
  animate,
  reviewKeys,
  beat,
  onBeat,
}: {
  env: EnvId;
  animate: boolean;
  reviewKeys: string[] | null;
  beat: StoryBeat | readonly StoryBeat[];
  onBeat: (strength: number, kind: WorldEventKind) => void;
}): void {
  const beats = typeof beat === 'string' ? [beat] : beat;
  useWorldEvents({
    env,
    animate,
    reviewKeys,
    onEvent: (kind, strength) => {
      const b = storyBeat(env, kind);
      if (b && beats.includes(b)) onBeat(strength, kind);
    },
  });
}
