import type { Card, Link, Mr, PendingRelease, ReleaseUnknownReason } from '@relay/shared';
import { columnFor, mrKey, nid, norm, type ColumnName } from '@/board/model';
import type { CoreScope } from '@/store/ui';

/**
 * Cards -> what the core shows. Pure and free of three.js and React, so Overview's number and both 3D modes
 * read the same data.
 *
 * Counted: Next Up, In Progress, Complete, Ready to Test. `progress = sum(stage) / (4 * N)`.
 * Not counted: Backlog (dust), Issues (cracks), On Feedback and any status outside the flow, none of which has a stage.
 *
 * Current cycle. Cards at stages 1 to 3 are always in it: that work has not reached QA. A Ready to Test card is in it if
 * it still belongs to this cycle in ANY repo it touches: an open MR, an MR the detector lists as pending, or a flip made
 * at or after that repo's boundary. The release flow flips cards AFTER the version MR merges, so without that last test
 * stage 4 could never be seen in this scope.
 *
 * Each repo keeps its own boundary; they are never merged into one date. A repo with `status: 'unknown'` says nothing, so
 * a Ready to Test card resting on one is `undetermined`: left out of the sum and reported, not counted as zero.
 */

export const STAGES = [1, 2, 3, 4] as const;
export type Stage = (typeof STAGES)[number];
export const MAX_STAGE: Stage = 4;

const STAGE_BY_COLUMN: Partial<Record<ColumnName, Stage>> = {
  'Next Up': 1,
  'In Progress': 2,
  Complete: 3,
  'Ready to Test': 4,
};

/** The stage at which each part of Mode A lights. */
export const LIGHTS_AT = { outer: 1, middle: 2, inner: 3, core: 4 } as const satisfies Record<
  string,
  Stage
>;

export interface ProgressSegment {
  cardId: string;
  title: string;
  stage: Stage;
}

export interface ProgressCardRef {
  cardId: string;
  title: string;
}

export interface UnknownRepo {
  repoId: string;
  reason: ReleaseUnknownReason | null;
}

/**
 * Why there is no percentage. Never replaced by 0, which would read as "no progress".
 *  `no_cards`         no cards at all
 *  `only_excluded`    cards exist, but none has a stage (all Backlog, Issues, On Feedback...)
 *  `boundary_unknown` current cycle only: no repo can say where the cycle starts
 */
export type ProgressGap = 'no_cards' | 'only_excluded' | 'boundary_unknown';

export interface ProgressModel {
  scope: CoreScope;
  /** One per counted card, ordered by id so a slice keeps its place between snapshots. */
  segments: ProgressSegment[];
  /** 0 to 100, unrounded. Null exactly when `gap` is set. */
  percent: number | null;
  gap: ProgressGap | null;
  /** Share of counted cards at stage 4, 0 to 1. Drives the core's fill. */
  coreFill: number;
  dust: ProgressCardRef[];
  /** For the cracks of part 7.5. */
  cracks: ProgressCardRef[];
  /** Cards with a status outside the flow (On Feedback, others, none). */
  uncounted: number;
  /** Current cycle only: Ready to Test cards that rest on a repo in `unknownRepos`. */
  undetermined: ProgressCardRef[];
  /** Current cycle only: at least one of these makes `percent` partial. */
  unknownRepos: UnknownRepo[];
}

export interface ProgressInput {
  cards: readonly Card[];
  mrs: readonly Pick<Mr, 'repoId' | 'iid' | 'state'>[];
  links: readonly Pick<Link, 'cardId' | 'repoId' | 'mrIid'>[];
  releases: readonly PendingRelease[];
  /** The configured Ready to Test spelling (`notion.readyStatus`). */
  readyStatus: string | undefined;
  /** The workspace's spellings of Complete (`notion.statusGroups.complete`). */
  completeStatuses: readonly string[] | undefined;
}

type Standing = 'in' | 'out' | 'undetermined';

interface CycleContext {
  mrsByCard: Map<string, Pick<Mr, 'repoId' | 'iid' | 'state'>[]>;
  releases: Map<string, PendingRelease>;
  pending: Set<string>;
  newestBoundary: number | null;
  anyOk: boolean;
}

function cycleContext(input: ProgressInput): CycleContext {
  const mrs = new Map(input.mrs.map((m) => [mrKey(m.repoId, m.iid), m] as const));
  const mrsByCard = new Map<string, Pick<Mr, 'repoId' | 'iid' | 'state'>[]>();
  for (const link of input.links) {
    const mr = mrs.get(mrKey(link.repoId, link.mrIid));
    if (!mr) continue;
    const key = nid(link.cardId);
    const list = mrsByCard.get(key);
    if (list) list.push(mr);
    else mrsByCard.set(key, [mr]);
  }
  const pending = new Set<string>();
  let newestBoundary: number | null = null;
  let anyOk = false;
  for (const release of input.releases) {
    for (const mr of release.pendingMrs) pending.add(mrKey(release.repoId, mr.iid));
    if (release.status !== 'ok') continue;
    anyOk = true;
    if (release.boundary && (newestBoundary === null || release.boundary.at > newestBoundary)) {
      newestBoundary = release.boundary.at;
    }
  }
  return {
    mrsByCard,
    releases: new Map(input.releases.map((r) => [r.repoId, r] as const)),
    pending,
    newestBoundary,
    anyOk,
  };
}

/** Only called for stage 4, see the header. */
function readyCardStanding(card: Card, ctx: CycleContext): Standing {
  const mrs = ctx.mrsByCard.get(nid(card.id)) ?? [];
  if (mrs.some((m) => m.state === 'opened' || m.state === 'locked')) return 'in';

  // A repo no longer configured has no release data, so its MRs cannot place the card.
  const merged = mrs.filter((m) => m.state === 'merged' && ctx.releases.has(m.repoId));
  if (merged.length === 0) {
    // No repo to ask, so the card is held against the newest boundary of any repo.
    if (ctx.newestBoundary !== null) return card.lastEditedAt >= ctx.newestBoundary ? 'in' : 'out';
    return ctx.anyOk ? 'in' : 'undetermined';
  }

  let standing: Standing = 'out';
  for (const mr of merged) {
    const release = ctx.releases.get(mr.repoId);
    if (!release || release.status !== 'ok') {
      standing = 'undetermined';
      continue;
    }
    if (ctx.pending.has(mrKey(mr.repoId, mr.iid))) return 'in';
    if (release.boundary && card.lastEditedAt >= release.boundary.at) return 'in';
  }
  return standing;
}

export function buildProgress(input: ProgressInput, scope: CoreScope): ProgressModel {
  const cycle = scope === 'cycle';
  const ctx = cycle ? cycleContext(input) : null;
  const segments: ProgressSegment[] = [];
  const dust: ProgressCardRef[] = [];
  const cracks: ProgressCardRef[] = [];
  const undetermined: ProgressCardRef[] = [];
  let uncounted = 0;
  let cards = 0;

  for (const card of input.cards) {
    if (card.archived) continue;
    cards += 1;
    const ref = { cardId: card.id, title: card.title };
    const column = columnFor(card, input.readyStatus, input.completeStatuses);
    if (column === 'Backlog') {
      dust.push(ref);
      continue;
    }
    if (column === 'Issues') {
      cracks.push(ref);
      continue;
    }
    const stage = STAGE_BY_COLUMN[column];
    if (stage === undefined) {
      uncounted += 1;
      continue;
    }
    if (ctx && stage === MAX_STAGE) {
      const standing = readyCardStanding(card, ctx);
      if (standing === 'out') continue;
      if (standing === 'undetermined') {
        undetermined.push(ref);
        continue;
      }
    }
    segments.push({ ...ref, stage });
  }

  const byId = (a: ProgressCardRef, b: ProgressCardRef) => (a.cardId < b.cardId ? -1 : 1);
  segments.sort(byId);
  dust.sort(byId);
  cracks.sort(byId);

  const unknownRepos = cycle
    ? input.releases
        .filter((r) => r.status !== 'ok')
        .map((r) => ({ repoId: r.repoId, reason: r.reason }))
    : [];
  const n = segments.length;
  const excluded = dust.length + cracks.length + uncounted;
  let gap: ProgressGap | null = null;
  if (cards === 0) gap = 'no_cards';
  else if (n === 0 && undetermined.length === 0) {
    // With nothing excluded, every card shipped in an earlier cycle: the new cycle is still empty.
    gap = excluded > 0 ? 'only_excluded' : 'no_cards';
  } else if (n === 0 || (cycle && !ctx?.anyOk)) gap = 'boundary_unknown';

  const sum = segments.reduce((total, s) => total + s.stage, 0);
  const atCore = segments.filter((s) => s.stage >= LIGHTS_AT.core).length;
  return {
    scope,
    segments,
    percent: gap === null ? (sum / (MAX_STAGE * n)) * 100 : null,
    gap,
    coreFill: n === 0 ? 0 : atCore / n,
    dust,
    cracks,
    uncounted,
    undetermined,
    unknownRepos,
  };
}

const NEXT_UP = 'Next Up';

/** The status a promoted Backlog card moves to, in the spelling configured for this Notion database. */
export function nextUpStatus(statuses: readonly string[] | undefined): string {
  return statuses?.find((s) => norm(s) === norm(NEXT_UP)) ?? NEXT_UP;
}
