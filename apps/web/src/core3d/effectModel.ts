import type { AppEvent, Card, KpiCardRow } from '@relay/shared';
import { nid } from '@/board/model';
import type { ProgressModel } from './progressMapping';

/**
 * What the core's effects show. Pure and free of three.js and React.
 *
 * One-shots come from events and pass through a capped queue. Lasting marks (cracks, SLA risk) are derived from data, so
 * they clear by themselves when a card is resolved or its timer stops.
 */

export type EffectKind = 'pulse' | 'spark' | 'click' | 'release';

/** Replays and repeats: a resume during DONE emits `release.done` again, and a merge can arrive by two routes. */
const SEEN_LIMIT = 200;
const seen = new Set<string>();

function claimOnce(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIMIT) {
    for (const oldest of seen) {
      seen.delete(oldest);
      break;
    }
  }
  return true;
}

/** The effect an event asks for. Claims the event, so call it once per event, from one consumer at a time. */
export function effectFor(event: AppEvent): EffectKind | null {
  switch (event.type) {
    case 'mr.activity':
      if (event.activity === 'comment') return 'pulse';
      if (event.activity === 'approval') return 'spark';
      return claimOnce(`merge:${event.repoId}:${event.iid}`) ? 'click' : null;
    case 'release.done':
      if (event.dryRun) return null;
      return claimOnce(`release:${event.jobId}`) ? 'release' : null;
    default:
      return null;
  }
}

const freshReleases = new Map<string, AppEvent>();

/**
 * Whether a world's celebration should react to this event: never to a dry run, and only once per job, since a resume
 * during DONE emits `release.done` again. Not a claim like `effectFor`: a world mounts many celebrating objects, and each
 * must react, so the event object that first brought a job stays valid for the other listeners it reaches.
 */
export function isFreshRelease(event: AppEvent & { type: 'release.done' }): boolean {
  if (event.dryRun) return false;
  const first = freshReleases.get(event.jobId);
  if (first) return first === event;
  freshReleases.set(event.jobId, event);
  if (freshReleases.size > SEEN_LIMIT) {
    for (const oldest of freshReleases.keys()) {
      freshReleases.delete(oldest);
      break;
    }
  }
  return true;
}

/** How many may wait, per kind. What arrives beyond this is dropped: the total of waiting effects has a hard limit. */
const WAITING_CAP: Record<EffectKind, number> = { pulse: 3, spark: 4, click: 3, release: 1 };
/** How many may run at once. */
export const RUNNING_CAP: Record<EffectKind, number> = { pulse: 1, spark: 3, click: 1, release: 1 };
const START_GAP_SECONDS = 0.15;

export class EffectQueue {
  private waiting: EffectKind[] = [];
  private cooldown = 0;

  push(kind: EffectKind): void {
    if (this.waiting.filter((k) => k === kind).length >= WAITING_CAP[kind]) return;
    // A release is rare and the point of the whole scene, so it never waits behind routine effects.
    if (kind === 'release') this.waiting.unshift(kind);
    else this.waiting.push(kind);
  }

  /** Once per frame. The next effect to start, if any; a kind at its running limit waits. */
  next(dt: number, runningCount: (kind: EffectKind) => number): EffectKind | null {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cooldown > 0) return null;
    const index = this.waiting.findIndex((kind) => runningCount(kind) < RUNNING_CAP[kind]);
    if (index < 0) return null;
    this.cooldown = START_GAP_SECONDS;
    return this.waiting.splice(index, 1)[0] ?? null;
  }

  clear(): void {
    this.waiting = [];
    this.cooldown = 0;
  }
}

export type SlaRisk = 'amber' | 'red';

/** Timers still running and close to or past their deadline, by normalised card id. A stopped timer is no longer a risk. */
export function slaRisks(rows: readonly KpiCardRow[]): Map<string, SlaRisk> {
  const risks = new Map<string, SlaRisk>();
  for (const row of rows) {
    if (row.completed || row.sla.stoppedAt !== null) continue;
    const { state } = row.sla;
    if (state === 'over_70') risks.set(nid(row.cardId), 'amber');
    else if (state === 'over_90' || state === 'breached') risks.set(nid(row.cardId), 'red');
  }
  return risks;
}

export type MarkKind = 'crack' | SlaRisk;

export interface CardMark {
  cardId: string;
  kind: MarkKind;
}

export interface CoreMarks {
  /** On a counted card's slice or plate. One per card: a crack outranks red, and red outranks amber. */
  cards: CardMark[];
  /** Issues cards with no counted parent: on the outer ring's metal, at a place derived from their own id. */
  loose: CardMark[];
}

/**
 * An Issues card has no segment, since it is not counted. Its crack goes on its parent's segment when the parent is
 * counted; otherwise it goes on the outer ring's bare metal, so it still shows, in both modes, with no segments at all.
 */
export function buildMarks(
  model: ProgressModel | null,
  cards: readonly Pick<Card, 'id' | 'parentId'>[],
  risks: ReadonlyMap<string, SlaRisk>,
): CoreMarks {
  if (!model) return { cards: [], loose: [] };
  const segmentByNid = new Map(model.segments.map((s) => [nid(s.cardId), s.cardId] as const));
  const parents = new Map(cards.map((c) => [c.id, c.parentId] as const));

  const cracked = new Set<string>();
  const loose: CardMark[] = [];
  for (const { cardId } of model.cracks) {
    const parent = parents.get(cardId);
    const onSegment = parent ? segmentByNid.get(nid(parent)) : undefined;
    if (onSegment !== undefined) cracked.add(onSegment);
    else loose.push({ cardId, kind: 'crack' });
  }

  const marks: CardMark[] = [];
  for (const { cardId } of model.segments) {
    const risk = risks.get(nid(cardId));
    if (cracked.has(cardId)) marks.push({ cardId, kind: 'crack' });
    else if (risk) marks.push({ cardId, kind: risk });
  }
  return { cards: marks, loose };
}
