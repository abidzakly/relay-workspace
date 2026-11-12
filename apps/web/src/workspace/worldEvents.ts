import type { AppEvent } from '@relay/shared';
import type { EnvId } from './envFor';

/**
 * Engineering events the world tells as a story. Every one comes from authoritative state:
 *  - `review.requested` / `review.cleared`: a review request of mine appeared in / left the MR Inbox (cache diff).
 *  - `review.started`: I opened a review session in the Code Reviewer (its own record of what I opened).
 *  - `mr.comment` / `mr.approval` / `mr.merged`: the server's `mr.activity` event (GitLab webhook or our own merge).
 * Nothing is inferred from clicks on the world or guessed from UI state.
 */
export type WorldEventKind =
  | 'review.requested'
  | 'review.cleared'
  | 'review.started'
  | 'mr.comment'
  | 'mr.approval'
  | 'mr.merged';

export function eventForActivity(e: AppEvent): WorldEventKind | null {
  if (e.type !== 'mr.activity') return null;
  switch (e.activity) {
    case 'comment':
      return 'mr.comment';
    case 'approval':
      return 'mr.approval';
    case 'merge':
      return 'mr.merged';
    default:
      return null;
  }
}

/**
 * What changed between two readings of the review queue. `prev` null = the first reading (page load): nothing is
 * "new" then, or every reload would ring. An arrival outranks a departure when both happen in one refresh.
 */
export function reviewQueueEvent(
  prev: readonly string[] | null,
  next: readonly string[],
): WorldEventKind | null {
  if (prev === null) return null;
  const before = new Set(prev);
  if (next.some((k) => !before.has(k))) return 'review.requested';
  const after = new Set(next);
  if (prev.some((k) => !after.has(k))) return 'review.cleared';
  return null;
}

/** The colour each event glows in: the meaning stays the same in every world. */
export const EVENT_COLOR: Record<WorldEventKind, string> = {
  'review.requested': '#f2a531',
  'review.cleared': '#34c77b',
  'review.started': '#ffd27a',
  'mr.comment': '#5aa9f0',
  'mr.approval': '#34c77b',
  'mr.merged': '#a98bf5',
};

/**
 * How loud the world tells it (0 = not at all). Off-duty worlds (sick, leave) stay quiet: the gateway never asks for
 * attention on a resting day; a finished piece of work may still glow softly.
 */
export function eventStrength(kind: WorldEventKind, env: EnvId): number {
  if (env === 'sick' || env === 'leave') return kind === 'mr.merged' ? 0.35 : 0;
  return kind === 'review.cleared' ? 0.6 : 1;
}

/** Seconds a gateway pulse lasts: short and non-blocking. */
export const PULSE_S = 1.6;

/**
 * A review session opened since `since` (newest first list of opened sessions): the world tells it as "review
 * started" when it comes back into view. Pure.
 */
export function reviewStartedSince(
  opened: readonly { kind: 'mr' | 'compare'; at: number }[],
  since: number,
): boolean {
  return opened.some((r) => r.kind === 'mr' && r.at > since);
}

/**
 * How each environment tells each event: the meaning stays, the storytelling changes. Every gateway pulses
 * for every event it is allowed to tell (`eventStrength`); these beats are the extra, environment-specific touches.
 */
export type StoryBeat =
  | 'mailbox-flag'
  | 'gateway-light'
  | 'gateway-display'
  | 'gateway-glow'
  | 'bell'
  | 'hologram'
  | 'reactor-pulse'
  | 'campus-wave'
  | 'board-update'
  | 'shuttle-depart'
  | 'signal-pulse'
  | 'lighthouse-pulse'
  | 'sail-out'
  | 'soft-light';

export const EVENT_STORY: Record<EnvId, Partial<Record<WorldEventKind, StoryBeat>>> = {
  home: {
    'review.requested': 'mailbox-flag',
    'review.started': 'gateway-light',
    'mr.comment': 'gateway-display',
    'mr.approval': 'gateway-glow',
    'mr.merged': 'bell',
  },
  office: {
    'review.requested': 'hologram',
    'review.started': 'gateway-light',
    'mr.comment': 'hologram',
    'mr.approval': 'reactor-pulse',
    'mr.merged': 'campus-wave',
  },
  trip: {
    'review.requested': 'board-update',
    'review.started': 'gateway-light',
    'mr.comment': 'gateway-display',
    'mr.approval': 'board-update',
    'mr.merged': 'shuttle-depart',
  },
  sick: {
    'review.requested': 'mailbox-flag',
    'review.started': 'soft-light',
    'mr.comment': 'soft-light',
    'mr.approval': 'soft-light',
    'mr.merged': 'soft-light',
  },
  leave: {
    'review.requested': 'signal-pulse',
    'review.started': 'gateway-light',
    'mr.comment': 'signal-pulse',
    'mr.approval': 'lighthouse-pulse',
    'mr.merged': 'sail-out',
  },
};

export const storyBeat = (env: EnvId, kind: WorldEventKind): StoryBeat | null =>
  EVENT_STORY[env][kind] ?? null;
