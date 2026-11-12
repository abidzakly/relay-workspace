import type { SyncSourceStatus } from '@relay/shared';
import type { ObjectId } from './registry';

/** What leaks from each tab into the world. Pure: the hook gathers the data, this decides what it means. */
export type Tone = 'idle' | 'ok' | 'warn' | 'bad';

export interface Signal {
  /** A number worth a badge; null = no badge. */
  badge: number | null;
  tone: Tone;
  /** One short sentence: the tooltip, and the menu's text for a screen reader. */
  summary: string;
}

export interface SignalInput {
  loading: boolean;
  /** Mine, open, sorted most urgent first. */
  mrTitles: string[];
  mrsWaiting: number;
  /** Open MRs whose review is requested of me (MR Inbox's `review_requested`), most urgent first. */
  reviewTitles: string[];
  /** Same MRs as `reviewTitles`, as `repo#iid` keys (null until the inbox has loaded): what the world compares. */
  reviewKeys: string[] | null;
  /** Off-duty day (sick, leave): the world shows work without asking for it. */
  offDuty: boolean;
  pipelinesFailed: number;
  mismatches: number;
  slaRisks: number;
  awaitingRelease: number;
  /** Mine, this month, per Board column (Board order). */
  columns: BoardColumn[];
  completion: { rate: number | null; target: number } | null;
  slaHitRate: number | null;
  /** This month's bug ratio against its limit; null before anything is counted. */
  bugs: { ratio: number; max: number; total: number } | null;
  research: { count: number; required: number } | null;
  progress: number | null;
  sources: SyncSourceStatus[];
  syncRunning: boolean;
  buildRunning: boolean;
  buildsQueued: number;
  sprint: { name: string; done: number; load: number } | null;
  undoable: number;
}

/** Everything the scene draws, beyond the per-object signals. */
/** One Board column on the sticky-note wall: its count, and the first few cards (newest first) as notes. */
export interface BoardColumn {
  name: string;
  count: number;
  notes: { id: string; title: string }[];
}

/** How many notes a column shows; past that, the last note reads "+N". */
export const NOTES_PER_COLUMN = 5;

/** One dart per KPI. `score` 1 = target met (bullseye); null = not measurable yet (the dart waits in its cup). */
export interface Dart {
  id: 'completion' | 'sla' | 'bugs' | 'research';
  label: string;
  score: number | null;
  /** Short reading for the tooltip, e.g. "43%" or "1/2". */
  reading: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * KPI as darts: each metric scored against its own target. Completion and research are progress towards a target;
 * the SLA hit-rate is its own score; the bug ratio is perfect while within its limit and falls off past it.
 */
export function dartScores(
  i: Pick<SignalInput, 'completion' | 'slaHitRate' | 'bugs' | 'research'>,
): Dart[] {
  const rate = i.completion?.rate ?? null;
  const target = i.completion?.target ?? 0;
  const bugs = i.bugs;
  return [
    {
      id: 'completion',
      label: 'Completion',
      score: rate === null ? null : target > 0 ? clamp01(rate / target) : 1,
      reading: rate === null ? '—' : pct(rate),
    },
    {
      id: 'sla',
      label: 'SLA',
      score: i.slaHitRate === null ? null : clamp01(i.slaHitRate),
      reading: i.slaHitRate === null ? '—' : pct(i.slaHitRate),
    },
    {
      id: 'bugs',
      label: 'Bugs',
      score:
        !bugs || bugs.total === 0
          ? null
          : bugs.ratio <= bugs.max
            ? 1
            : bugs.max > 0
              ? clamp01(bugs.max / bugs.ratio)
              : 0,
      reading:
        !bugs || bugs.total === 0
          ? '—'
          : bugs.ratio <= bugs.max
            ? 'within limit'
            : `${pct(bugs.ratio)} (max ${pct(bugs.max)})`,
    },
    {
      id: 'research',
      label: 'Research',
      score: !i.research
        ? null
        : i.research.required > 0
          ? clamp01(i.research.count / i.research.required)
          : 1,
      reading: !i.research ? '—' : `${i.research.count}/${i.research.required}`,
    },
  ];
}

export interface SceneData {
  signals: Record<ObjectId, Signal>;
  mrTitles: string[];
  /** Reviews requested of me (at most 3 titles), their total, and every key (to notice arrivals and departures). */
  reviews: { titles: string[]; count: number; keys: string[] | null };
  columns: BoardColumn[];
  darts: Dart[];
  progress: number | null;
  syncTone: Tone;
  syncRunning: boolean;
  wagons: number;
  buildRunning: boolean;
  sprintFill: number | null;
  undoable: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function syncTone(sources: readonly SyncSourceStatus[], mismatches: number): Tone {
  if (sources.length === 0) return 'idle';
  if (sources.some((s) => s.state === 'error')) return 'bad';
  if (mismatches > 0 || sources.some((s) => s.state === 'partial')) return 'warn';
  return 'ok';
}

export function buildSceneData(i: SignalInput): SceneData {
  const wait = i.loading ? 'Loading…' : null;
  const sync = syncTone(i.sources, i.mismatches);
  const failing = i.sources.filter((s) => s.state === 'error').map((s) => s.source);
  const onBoard = i.columns.reduce((n, c) => n + c.count, 0);
  const issues = i.columns.find((c) => c.name === 'Issues')?.count ?? 0;
  const rate = i.completion?.rate ?? null;
  const darts = dartScores(i);
  const sprintFill =
    i.sprint && i.sprint.load > 0 ? Math.min(1, i.sprint.done / i.sprint.load) : null;

  const signals: Record<ObjectId, Signal> = {
    monitor: {
      badge: i.mrsWaiting + i.pipelinesFailed || null,
      tone: i.pipelinesFailed > 0 ? 'bad' : i.mrsWaiting > 0 ? 'warn' : 'ok',
      summary:
        wait ??
        (i.mrsWaiting + i.pipelinesFailed === 0
          ? 'No MR is waiting on you.'
          : `${plural(i.mrsWaiting, 'MR')} waiting on you${i.pipelinesFailed ? `, ${plural(i.pipelinesFailed, 'failed pipeline')}` : ''}.`),
    },
    review: {
      // Off duty, the count stays readable but never turns amber: nothing is asked of a resting day.
      badge: i.reviewTitles.length || null,
      tone: i.reviewTitles.length === 0 ? 'ok' : i.offDuty ? 'idle' : 'warn',
      summary:
        wait ??
        (i.reviewTitles.length === 0
          ? 'No review is requested of you. Browse MRs or compare branches.'
          : `${plural(i.reviewTitles.length, 'review')} requested of you${i.offDuty ? ', for when you are back' : ''}.`),
    },
    notes: {
      badge: issues || null,
      tone: issues > 0 ? 'bad' : onBoard > 0 ? 'ok' : 'idle',
      summary:
        wait ?? `${plural(onBoard, 'card')} this month${issues ? `, ${issues} in Issues` : ''}.`,
    },
    kpi: {
      badge: i.slaRisks || null,
      tone:
        i.slaRisks > 0
          ? 'warn'
          : rate !== null && i.completion && rate >= i.completion.target
            ? 'ok'
            : 'idle',
      summary:
        wait ??
        `${darts.map((d) => `${d.label} ${d.reading}`).join(' · ')}${i.slaRisks ? ` · ${plural(i.slaRisks, 'SLA risk')}` : ''}.`,
    },
    plant: {
      badge: null,
      tone: i.progress === null ? 'idle' : 'ok',
      summary:
        wait ??
        (i.progress === null
          ? 'Release progress has nothing to count yet.'
          : `Release progress ${Math.round(i.progress)}%. The bonsai grows with it.`),
    },
    router: {
      badge: i.mismatches || null,
      tone: sync,
      summary:
        wait ??
        (failing.length
          ? `Sync failing: ${failing.join(', ')}.`
          : i.mismatches
            ? `${plural(i.mismatches, 'mismatch', 'mismatches')} to look at.`
            : i.syncRunning
              ? 'Syncing now.'
              : 'Sync is healthy.'),
    },
    train: {
      badge: i.awaitingRelease || null,
      tone: i.awaitingRelease > 0 ? 'warn' : 'ok',
      summary:
        wait ??
        (i.awaitingRelease
          ? `${plural(i.awaitingRelease, 'repo')} awaiting a release or build.`
          : 'Nothing is waiting to ship.'),
    },
    printer: {
      badge: i.buildsQueued || null,
      tone: i.buildRunning ? 'warn' : 'ok',
      summary:
        wait ??
        (i.buildRunning
          ? `A build is running${i.buildsQueued ? `, ${i.buildsQueued} queued` : ''}.`
          : 'No build running.'),
    },
    ship: {
      badge: null,
      tone: i.sprint ? 'ok' : 'idle',
      summary:
        wait ??
        (i.sprint
          ? `${i.sprint.name}: ${Math.round(i.sprint.done)} of ${Math.round(i.sprint.load)} h sealed.`
          : 'No active sprint.'),
    },
    toolbox: { badge: null, tone: 'idle', summary: 'Integrations, repos, appearance.' },
    cabinet: {
      badge: i.undoable || null,
      tone: 'idle',
      summary: i.undoable
        ? `${plural(i.undoable, 'write')} can still be undone.`
        : 'Every write, with undo.',
    },
  };

  return {
    signals,
    mrTitles: i.mrTitles.slice(0, 4),
    reviews: {
      titles: i.reviewTitles.slice(0, 3),
      count: i.reviewTitles.length,
      keys: i.reviewKeys,
    },
    columns: i.columns,
    darts,
    progress: i.progress,
    syncTone: sync,
    syncRunning: i.syncRunning,
    wagons: Math.min(6, i.awaitingRelease),
    buildRunning: i.buildRunning,
    sprintFill,
    undoable: i.undoable,
  };
}
