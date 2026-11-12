import {
  evaluateMergeGate,
  type MergeGateInput,
  type ApprovalMode,
  type MergeApprovalsStatus,
  type MrState,
} from '@relay/shared';
import type {
  DiffFile,
  Discussion,
  GlobalConfig,
  MrDetail,
  MrFile,
  Note,
  ReviewDiscussion,
  Source,
  ThreadCodeLine,
} from '@relay/shared';
import type { AppDb } from '../db';
import { mrs, notesCache } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { GitlabApiError, type ApprovalsOutcome } from './gitlabService';
import { approvedAtFromNotes, type MrFields } from './gitlabMr';
import { inboxItem, type InboxRepo } from './mrInbox';
import { threadCode } from './threadCode';
import { readLiveStack, type BranchHeadsReader, type StackReader } from './mrStack';

/** The GET-only slice of `GitlabService` the drawer needs (tests / tools can pass another reader). */
export interface MrLiveReader {
  getMrDetailWithDescription(
    iid: number,
  ): Promise<{ fields: MrFields; description: string | null }>;
  getNotes(iid: number): Promise<{ notes: Note[]; skipped: number }>;
  getApprovals(iid: number, notes?: readonly Note[]): Promise<ApprovalsOutcome>;
  getMrFiles(iid: number): Promise<{ files: MrFile[]; truncated: boolean; skipped: number }>;
  /** Same `/diffs` read as `getMrFiles`, text kept: when present it replaces `getMrFiles` (feeds thread code). */
  getMrDiffs?(iid: number): Promise<{ files: DiffFile[]; truncated: boolean }>;
  /** Discussions with their diff `position` (the code a reviewer selected). */
  getReviewDiscussions?(iid: number): Promise<ReviewDiscussion[]>;
  /** Stack check: without these the drawer's gate reports `stack_unknown` (fails closed). */
  getMrCommitShas?: StackReader['getMrCommitShas'];
  listOpenMrsInto?: StackReader['listOpenMrsInto'];
  getProjectSquashOption?(): Promise<string | null>;
}

export interface MrDetailInput {
  app: AppDb;
  repos: readonly InboxRepo[];
  global: Pick<GlobalConfig, 'gitlab' | 'mrTiming'>;
  repoId: string;
  iid: number;
  /** The repo's `approvalMode` (shown when the live approvals read did not run; feeds the merge gate). */
  approvalMode: ApprovalMode;
  /** `null` = GitLab is not usable (no host configured): every section falls back to the cache. */
  live: MrLiveReader | null;
  liveError: string | null;
  now: number;
  /** Pushed heads without MR (stack parents "belum ada MR"). */
  branchHeads?: BranchHeadsReader;
}

/** Only our own error type has a message that is known to be secret-free. */
const safe = (e: unknown): string => (e instanceof GitlabApiError ? e.message : 'unexpected error');

/** A plain cause for the Changed files section, with what to do about it. */
export function filesReason(e: unknown): string {
  if (!(e instanceof GitlabApiError)) return 'GitLab could not be read (unexpected error).';
  if (e.kind === 'forbidden' || e.status === 403) {
    return 'GitLab refused (403). Your token needs read_api, and your project role must be Reporter or higher to read code.';
  }
  if (e.kind === 'auth')
    return 'GitLab rejected the token (401). Check the token in Settings → Repos.';
  if (e.kind === 'network') {
    if (e.networkKind === 'too_large') return 'The diff response was too large to read.';
    if (e.networkKind === 'timeout') return 'GitLab took too long to answer. Try again.';
    return 'GitLab could not be reached.';
  }
  if (e.kind === 'rate_limited') return 'GitLab is rate limiting requests. Try again shortly.';
  return `GitLab could not list the files: ${e.message}`;
}

/**
 * A GitLab avatar as a same-origin path (the page's CSP only allows `img-src 'self'`). Only avatars on the GitLab
 * host itself are proxied; anything else (Gravatar) returns null and the client draws initials.
 */
export function avatarPath(raw: string | null | undefined, gitlabHost: string): string | null {
  if (!raw || !gitlabHost) return null;
  let host: URL;
  let url: URL;
  try {
    host = new URL(gitlabHost);
    url = new URL(raw, host);
  } catch {
    return null;
  }
  if (url.origin !== host.origin || !url.pathname.startsWith('/uploads/')) return null;
  return `/api/gitlab/avatar?path=${encodeURIComponent(url.pathname)}`;
}

/** `!123` mentions of other MRs (not inside words, links like `a/b!1`, or HTML entities like `&#33;`). */
const MR_REF_RE = /(?<![\w/&#!])!(\d{1,7})\b/g;

/** Same-repo `!NNN` refs in `texts`, looked up in the MR cache (unknown MRs are left out: no live read per ref). */
function collectRefs(
  app: AppDb,
  repoId: string,
  texts: readonly (string | null)[],
): MrDetail['refs'] {
  const iids = new Set<number>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(MR_REF_RE)) {
      iids.add(Number(m[1]));
      if (iids.size >= 100) break;
    }
  }
  if (iids.size === 0) return {};
  const out: NonNullable<MrDetail['refs']> = {};
  const rows = app.db
    .select({ iid: mrs.iid, title: mrs.title, state: mrs.state })
    .from(mrs)
    .where(and(eq(mrs.repoId, repoId), inArray(mrs.iid, [...iids])))
    .all();
  for (const r of rows) out[String(r.iid)] = { iid: r.iid, title: r.title, state: r.state };
  return out;
}

/** Everyone on this MR, author first, then reviewers, then commenters (no duplicates). */
function people(mr: MrDetail['mr'], threads: readonly Discussion[]): MrDetail['people'] {
  const out = new Map<string, string | null>();
  const add = (u: string | null | undefined, name: string | null = null) => {
    if (!u) return;
    if (!out.has(u) || (name && !out.get(u))) out.set(u, name);
  };
  add(mr.author);
  for (const r of mr.reviewers) add(r.username);
  for (const t of threads) for (const n of t.notes) add(n.author, n.authorName ?? null);
  return [...out].slice(0, 200).map(([username, name]) => ({ username, name }));
}

function toThreads(
  notes: readonly Note[],
  unread: ReadonlySet<number>,
  gitlabHost: string,
): {
  threads: Discussion[];
  systemNotes: number;
} {
  const byDisc = new Map<string, Discussion>();
  let systemNotes = 0;
  for (const n of [...notes].sort((a, b) => a.createdAt - b.createdAt || a.noteId - b.noteId)) {
    if (n.system) {
      systemNotes++;
      continue;
    }
    let d = byDisc.get(n.discussionId);
    if (!d) {
      d = {
        id: n.discussionId,
        resolvable: n.resolvable,
        resolved: n.resolved,
        notes: [],
        ...(n.individual !== undefined ? { individual: n.individual } : {}),
      };
      byDisc.set(n.discussionId, d);
    }
    d.resolvable = d.resolvable || n.resolvable;
    d.resolved = n.resolved || d.resolved;
    d.notes.push({
      id: n.noteId,
      author: n.author,
      body: n.body,
      createdAt: n.createdAt,
      unread: unread.has(n.noteId),
      ...(n.authorName !== undefined ? { authorName: n.authorName } : {}),
      ...(n.authorAvatar !== undefined ? { avatar: avatarPath(n.authorAvatar, gitlabHost) } : {}),
      ...(n.edited ? { edited: true } : {}),
    });
  }
  return { threads: [...byDisc.values()], systemNotes };
}

/** Changed files, plus their diff text when the reader can return it (one `/diffs` read either way). */
async function readFiles(
  live: MrLiveReader,
  iid: number,
): Promise<{ files: MrFile[]; truncated: boolean; diffs: DiffFile[] | null }> {
  if (!live.getMrDiffs) {
    const r = await live.getMrFiles(iid);
    return { files: r.files, truncated: r.truncated, diffs: null };
  }
  const r = await live.getMrDiffs(iid);
  return {
    files: r.files.map((f) => ({ path: f.path, oldPath: f.oldPath, kind: f.kind })),
    truncated: r.truncated,
    diffs: r.files,
  };
}

/**
 * MR drawer data, READ-ONLY. The base MR comes from the cache (404 if unknown); every other section
 * is read live from GitLab with GETs only and falls back to the cache when GitLab cannot be read. NOTHING is
 * written: not the cache, not read state. Raw markdown is returned as-is (the client sanitizes it).
 */
export async function buildMrDetail(i: MrDetailInput): Promise<MrDetail | null> {
  const base = inboxItem(i.app, i.repos, i.global, i.repoId, i.iid, i.now);
  if (!base) return null;
  const errors: string[] = [];
  const note = (section: string, e: unknown) => errors.push(`${section}: ${safe(e)}`);
  if (i.liveError) errors.push(i.liveError);

  const cachedNotes: Note[] = i.app.db
    .select()
    .from(notesCache)
    .where(and(eq(notesCache.repoId, i.repoId), eq(notesCache.mrIid, i.iid)))
    .all()
    .map((n) => ({ ...n, system: n.system, seen: n.seen }));
  const unread = new Set(cachedNotes.filter((n) => !n.seen).map((n) => n.noteId));

  // The live reads are independent: one failing must not blank the others.
  const live = i.live;
  const stackP: Promise<MergeGateInput['stack']> =
    live?.getMrCommitShas && live.listOpenMrsInto
      ? readLiveStack(
          {
            getMrCommitShas: live.getMrCommitShas.bind(live),
            listOpenMrsInto: live.listOpenMrsInto.bind(live),
          },
          { iid: i.iid, sourceBranch: base.sourceBranch, targetBranch: base.targetBranch },
          {
            store: i.app,
            repoId: i.repoId,
            now: i.now,
            ...(i.branchHeads ? { branchHeads: i.branchHeads } : {}),
          },
        )
      : Promise.resolve({
          status: 'error',
          openParents: [],
          commitCount: null,
          message: live ? 'stack not readable' : 'GitLab is not configured',
        });
  const squashP: Promise<string | null> = live?.getProjectSquashOption
    ? live.getProjectSquashOption().catch(() => null)
    : Promise.resolve(null);
  const [[detailR, notesR, filesR, positionsR], stack, squashProject] = await Promise.all([
    live
      ? Promise.allSettled([
          live.getMrDetailWithDescription(i.iid),
          live.getNotes(i.iid),
          readFiles(live, i.iid),
          live.getReviewDiscussions ? live.getReviewDiscussions(i.iid) : Promise.resolve(null),
        ])
      : Promise.resolve([null, null, null, null] as const),
    stackP,
    squashP,
  ]);

  let description: MrDetail['description'] = { markdown: null, source: 'unavailable' };
  let pipeline: MrDetail['pipeline'] = { value: base.headPipeline, source: 'cache' };
  let mr = base;
  // Merge-gate inputs that the drawer's MR shape does not carry (live when the detail read worked).
  let gateState: MrState = base.state;
  let gateConflicts: boolean | null = base.hasConflicts;
  let gitlabMergeStatus: string | null = null;
  let squashMr: boolean | null = null;
  if (detailR?.status === 'fulfilled') {
    const { fields, description: md } = detailR.value;
    squashMr = fields.squash ?? null;
    gateState = fields.state;
    gateConflicts = fields.hasConflicts;
    gitlabMergeStatus = fields.mergeStatus;
    description = { markdown: md, source: 'live' };
    if (fields.headPipeline !== undefined) {
      pipeline = { value: fields.headPipeline, source: 'live' };
      mr = { ...mr, headPipeline: fields.headPipeline };
    }
    if (fields.hasConflicts !== null) mr = { ...mr, hasConflicts: fields.hasConflicts };
    mr = { ...mr, draft: fields.draft };
  } else if (detailR) note('detail', detailR.reason);

  let threadsSource: Source = 'cache';
  let noteList: readonly Note[] = cachedNotes;
  if (notesR?.status === 'fulfilled') {
    threadsSource = 'live';
    noteList = notesR.value.notes;
  } else if (notesR) note('discussions', notesR.reason);
  const { threads, systemNotes } = toThreads(noteList, unread, i.global.gitlab.host ?? '');
  // The code each diff thread was left on (cosmetic: a failed read just leaves threads without it).
  if (positionsR?.status === 'fulfilled' && positionsR.value) {
    const diffFiles = filesR?.status === 'fulfilled' ? filesR.value.diffs : null;
    const posById = new Map(positionsR.value.map((d) => [d.id, d.position]));
    const hunkCache = new Map<string, ThreadCodeLine[][]>();
    for (const t of threads) {
      const pos = posById.get(t.id);
      if (pos) t.code = threadCode(pos, diffFiles, hunkCache);
    }
  }

  // `getApprovals` reports its own failures; the catch only guards a truly unexpected throw.
  const approvalsOutcome = live ? await live.getApprovals(i.iid, noteList).catch(() => null) : null;
  let approvalsSource: Source = 'cache';
  let approvedBy = base.approvedBy;
  if (approvalsOutcome?.status === 'ok') {
    approvalsSource = 'live';
    approvedBy = approvalsOutcome.approvedBy;
  } else if (approvalsOutcome) {
    errors.push(`approvals: ${approvalsOutcome.message ?? approvalsOutcome.status}`);
    if (approvalsOutcome.status === 'unavailable') approvalsSource = 'unavailable';
  }
  const repo = i.repos.find((r) => r.id === i.repoId);
  const reviewerNames = repo?.reviewers ?? [];
  const lower = (s: string) => s.toLowerCase();
  const reviewers = reviewerNames.map((u) => ({
    username: u,
    approved: approvedBy.some((a) => lower(a) === lower(u)),
    commented: noteList.some((n) => !n.system && n.author !== null && lower(n.author) === lower(u)),
    approvedAt: approvedBy.some((a) => lower(a) === lower(u))
      ? approvedAtFromNotes(noteList, u)
      : null,
  }));
  mr = { ...mr, approvedBy, reviewers };

  let files: MrDetail['files'] = {
    source: 'unavailable',
    files: [],
    truncated: false,
    reason: live ? 'not read' : (i.liveError ?? 'GitLab is not configured'),
  };
  if (filesR?.status === 'fulfilled')
    files = {
      source: 'live',
      files: filesR.value.files,
      truncated: filesR.value.truncated,
    };
  else if (filesR) {
    note('files', filesR.reason);
    files = { ...files, reason: filesReason(filesR.reason) };
  }

  // Same rule as the server's merge route (shared `evaluateMergeGate`), over this drawer's data. Cosmetic:
  // it only decides whether the button is enabled; the route re-fetches live at click time.
  let gateApprovals: { status: MergeApprovalsStatus; approvedBy: string[]; message?: string };
  if (approvalsOutcome?.status === 'ok') gateApprovals = { status: 'ok', approvedBy };
  else if (approvalsOutcome) {
    gateApprovals = {
      status: approvalsOutcome.status,
      approvedBy: [],
      ...(approvalsOutcome.message ? { message: approvalsOutcome.message } : {}),
    };
  } else {
    gateApprovals = {
      status: 'error',
      approvedBy: [],
      message: live ? 'unexpected error' : 'GitLab is not configured',
    };
  }
  const gate = evaluateMergeGate({
    source: detailR?.status === 'fulfilled' && approvalsSource === 'live' ? 'live' : 'cache',
    checkedAt: i.now,
    state: gateState,
    draft: mr.draft,
    hasConflicts: gateConflicts,
    approvalMode: i.approvalMode,
    approvals: gateApprovals,
    reviewers: reviewerNames,
    gitlabMergeStatus,
    stack,
    squash: { mr: squashMr, project: squashProject },
  });
  const gateLooksOk = gate.allowed;

  return {
    generatedAt: i.now,
    mr,
    description,
    pipeline,
    approvals: {
      mode: approvalsOutcome?.mode ?? i.approvalMode,
      source: approvalsSource,
      approvedBy,
      gateLooksOk,
      gate,
    },
    files,
    discussions: { source: threadsSource, threads, systemNotes },
    refs: collectRefs(i.app, i.repoId, [
      description.markdown,
      ...threads.flatMap((t) => t.notes.map((n) => n.body)),
    ]),
    people: people(mr, threads),
    liveErrors: errors,
  };
}
