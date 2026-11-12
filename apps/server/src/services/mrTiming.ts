import {
  formatDuration,
  type MrState,
  type MrTiming,
  type ReviewLatency,
  type TimingLevel,
  type WaitingOn,
} from '@relay/shared';

/**
 * MR timing derivations: open-for + escalation, merged-after, last activity,
 * "waiting on" badge, review-latency stat. PURE and COSMETIC: no DB, no I/O, never used by the merge gate.
 */

export interface TimingMr {
  repoId: string;
  iid: number;
  state: MrState;
  draft: boolean;
  author: string | null;
  createdAt: number;
  mergedAt: number | null;
  updatedAt: number | null;
  approvedBy: readonly string[];
}

export interface TimingNote {
  author: string | null;
  system: boolean;
  body: string;
  createdAt: number;
  resolvable: boolean;
  resolved: boolean;
}

export interface TimingOptions {
  now: number;
  /** Configured reviewers of the MR's repo (merge gate). */
  reviewers: readonly string[];
  /** `gitlab.myUsername`; replies by the MR author count as "you" as well. */
  me: string | undefined;
  /** Other usernames that are "me": the repo tokens' bot users (a reply posted through the dashboard). */
  alsoMe?: readonly string[];
  thresholds: { amberAfterHours: number; redAfterHours: number };
}

const HOUR = 3_600_000;
const lower = (s: string) => s.toLowerCase();

/**
 * GitLab's system note for new commits starts with "added N commit(s)". Force pushes use other wording on some
 * versions. UNVERIFIED against the real instance; when nothing matches the MR creation time is used.
 */
const PUSH_NOTE_RE = /^\s*(?:added \d+ commits?\b|force[- ]pushed\b)/i;

export function isPushNote(n: Pick<TimingNote, 'system' | 'body'>): boolean {
  return n.system && PUSH_NOTE_RE.test(n.body);
}

function level(ms: number, draft: boolean, t: TimingOptions['thresholds']): TimingLevel {
  if (draft) return 'ok'; // a draft is work in progress: it shows the time but never escalates
  if (ms > t.redAfterHours * HOUR) return 'red';
  if (ms > t.amberAfterHours * HOUR) return 'amber';
  return 'ok';
}

export function deriveMrTiming(
  mr: TimingMr,
  notes: readonly TimingNote[],
  opts: TimingOptions,
): MrTiming {
  const reviewers = new Set(opts.reviewers.map(lower));
  const author = mr.author ? lower(mr.author) : null;
  const youSet = new Set<string>();
  if (opts.me) youSet.add(lower(opts.me));
  for (const u of opts.alsoMe ?? []) youSet.add(lower(u));
  if (author) youSet.add(author);

  const human = notes.filter((n) => !n.system).sort((a, b) => a.createdAt - b.createdAt);
  const isReviewerNote = (n: TimingNote) =>
    n.author !== null && reviewers.has(lower(n.author)) && lower(n.author) !== author;
  const isYourNote = (n: TimingNote) => n.author !== null && youSet.has(lower(n.author));

  const lastHuman = human[human.length - 1];
  const lastComment = lastHuman ? { at: lastHuman.createdAt, by: lastHuman.author } : null;

  const pushes = notes.filter(isPushNote).map((n) => n.createdAt);
  const lastPushAt = Math.max(mr.createdAt, ...pushes);

  const reviewerNotes = human.filter(isReviewerNote);
  const firstReviewerResponseAt = reviewerNotes[0]?.createdAt ?? null;

  const live = mr.state === 'opened' || mr.state === 'locked';
  const phase: MrTiming['phase'] = live ? 'open' : mr.state === 'merged' ? 'merged' : 'closed';

  const openMs = Math.max(0, opts.now - mr.createdAt);
  const openFor = live
    ? { ms: openMs, label: formatDuration(openMs), level: level(openMs, mr.draft, opts.thresholds) }
    : null;

  let finishedAfter: MrTiming['finishedAfter'] = null;
  if (mr.state === 'merged' && mr.mergedAt !== null) {
    const ms = Math.max(0, mr.mergedAt - mr.createdAt);
    finishedAfter = { kind: 'merged', ms, label: formatDuration(ms), approx: false };
  } else if (mr.state === 'closed' && mr.updatedAt !== null) {
    // The close time is not cached; `updatedAt` is the closest proxy (later activity can push it out).
    const ms = Math.max(0, mr.updatedAt - mr.createdAt);
    finishedAfter = { kind: 'closed', ms, label: formatDuration(ms), approx: true };
  }

  let waiting: { kind: WaitingOn; since: number | null };
  if (!live) {
    waiting = { kind: 'none', since: null };
  } else if (mr.draft) {
    waiting = { kind: 'draft', since: null };
  } else if (mr.approvedBy.some((u) => reviewers.has(lower(u)))) {
    waiting = { kind: 'approved', since: null };
  } else {
    // Your last move = your newest push or reply. A reviewer comment newer than that is waiting for you,
    // unless its thread is resolved (resolved = addressed).
    const yourLast = Math.max(lastPushAt, ...human.filter(isYourNote).map((n) => n.createdAt));
    const pending = reviewerNotes.filter(
      (n) => n.createdAt > yourLast && !(n.resolvable && n.resolved),
    );
    waiting = pending[0]
      ? { kind: 'you', since: pending[0].createdAt }
      : { kind: 'reviewer', since: yourLast };
  }

  return {
    repoId: mr.repoId,
    iid: mr.iid,
    phase,
    openFor,
    finishedAfter,
    lastComment,
    lastPushAt,
    firstReviewerResponseAt,
    waitingOn: waiting,
  };
}

export interface LatencyInput {
  state: MrState;
  draft: boolean;
  isVersionMr: boolean;
  createdAt: number;
  firstReviewerResponseAt: number | null;
}

/** `YYYY-MM` of an instant, in the server's local time zone. */
export const monthOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Review latency = MR open → first reviewer response. Version MRs are excluded. An MR without a
 * reviewer note is not in the mean (an approval alone has no cached timestamp); open/merged non-draft ones are
 * counted in `withoutResponse` so the stat never hides them.
 */
export function deriveReviewLatency(mrs: readonly LatencyInput[]): ReviewLatency {
  const samples: { ms: number; createdAt: number }[] = [];
  let withoutResponse = 0;
  for (const m of mrs) {
    if (m.isVersionMr) continue;
    if (m.firstReviewerResponseAt !== null) {
      samples.push({
        ms: Math.max(0, m.firstReviewerResponseAt - m.createdAt),
        createdAt: m.createdAt,
      });
    } else if (!m.draft && m.state !== 'closed') {
      withoutResponse++;
    }
  }
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const mid = sorted.length >> 1;
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2
    : null;

  const buckets = new Map<string, { n: number; sum: number }>();
  for (const s of samples) {
    const k = monthOf(s.createdAt);
    const b = buckets.get(k) ?? { n: 0, sum: 0 };
    b.n++;
    b.sum += s.ms;
    buckets.set(k, b);
  }
  return {
    sampled: samples.length,
    withoutResponse,
    meanMs: mean === null ? null : Math.round(mean),
    medianMs: median === null ? null : Math.round(median),
    meanLabel: mean === null ? null : formatDuration(mean),
    medianLabel: median === null ? null : formatDuration(median),
    byMonth: [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => ({ month, sampled: b.n, meanMs: Math.round(b.sum / b.n) })),
  };
}
