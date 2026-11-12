import { z } from 'zod';
import {
  MrStateSchema,
  USERNAME_RE,
  type HeadPipeline,
  type MrFile,
  type MrState,
  type Note,
} from '@relay/shared';
import { extractNotionPageId } from './notionUrl';

/**
 * Pure mapping from GitLab REST v4 JSON to the shared `Mr` / `Note` shapes.
 * The raw shapes follow GitLab's documented API and are UNVERIFIED against the live instance
 * (no sample JSON was attached): every field that GitLab versions differ on is optional here.
 */

const RawUser = z.looseObject({ username: z.string() });
const RawPipeline = z.looseObject({
  id: z.number().int(),
  status: z.string(),
  web_url: z.string().nullish(),
});

export const RawMrSchema = z.looseObject({
  id: z.number().int().positive().nullish(),
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  has_conflicts: z.boolean().nullish(),
  merge_status: z.string().nullish(),
  detailed_merge_status: z.string().nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
  author: RawUser.nullish(),
  assignees: z.array(RawUser.nullish()).nullish(),
  reviewers: z.array(RawUser.nullish()).nullish(),
  web_url: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  head_pipeline: RawPipeline.nullish(),
  pipeline: RawPipeline.nullish(),
  sha: z.string().nullish(),
  squash: z.boolean().nullish(),
});

const RawApprovalsSchema = z.looseObject({
  approved_by: z.array(z.looseObject({ user: RawUser.nullish() })),
});

const RawAwardSchema = z.looseObject({ name: z.string(), user: RawUser.nullish() });

const RawNoteSchema = z.looseObject({
  id: z.number().int().positive(),
  body: z.string().nullish(),
  author: RawUser.nullish(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  system: z.boolean().nullish(),
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
  last_edited_at: z.string().nullish(),
});
const RawDiscussionSchema = z.looseObject({
  id: z.string(),
  individual_note: z.boolean().nullish(),
  notes: z.array(z.unknown()),
});
const RawPerson = z.looseObject({
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

/** Stored note bodies are clipped: they are user content and only feed previews / waiting-on logic. */
export const NOTE_BODY_MAX = 4000;

/** Award emoji that counts as an approval in `award_emoji` mode (GitLab name for 👍). */
export const APPROVAL_EMOJI = 'thumbsup';

/** `note_keyword` mode: a human note whose first line is just one of these counts as an approval. */
export const APPROVAL_KEYWORD_RE = /^(?:\/?approved?|lgtm)[\s.!:)]*$/i;

/**
 * When `user` approved: latest approval note by them (GitLab system note "approved this merge request", or an
 * approval keyword note). Null if none (e.g. award_emoji mode has no note).
 */
export function approvedAtFromNotes(
  notes: readonly Pick<Note, 'author' | 'system' | 'body' | 'createdAt'>[],
  user: string,
): number | null {
  const u = user.toLowerCase();
  let best: number | null = null;
  for (const n of notes) {
    if (n.author === null || n.author.toLowerCase() !== u) continue;
    const first = n.body.split('\n')[0]?.trim() ?? '';
    const hit = n.system
      ? /^approved this merge request/i.test(first)
      : APPROVAL_KEYWORD_RE.test(first);
    if (hit && (best === null || n.createdAt > best)) best = n.createdAt;
  }
  return best;
}

const DRAFT_TITLE_RE = /^\s*(?:\[draft\]|\(draft\)|draft:|\[wip\]|wip:)/i;

/** The title GitLab needs for a draft (`Draft: …`) or a ready MR (any draft marker removed). */
export function titleWithDraft(title: string, draft: boolean): string {
  const bare = title.replace(new RegExp(`${DRAFT_TITLE_RE.source}\\s*`, 'i'), '');
  return draft ? `Draft: ${bare}` : bare;
}

const toMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const username = (u: { username: string } | null | undefined): string | null =>
  u && USERNAME_RE.test(u.username) ? u.username : null;

const usernames = (
  list: readonly ({ username: string } | null | undefined)[] | null | undefined,
): string[] | undefined => {
  if (!list) return undefined;
  const out: string[] = [];
  for (const u of list) {
    const n = username(u);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
};

/** Everything one MR payload tells us. `undefined`/`null` below mean "this payload did not say". */
export interface MrFields {
  iid: number;
  gitlabId: number | null;
  title: string;
  state: MrState;
  draft: boolean;
  /** null = the payload carried no conflict information (the list endpoint may omit it). */
  hasConflicts: boolean | null;
  /** `detailed_merge_status` (GitLab >= 15.6) else legacy `merge_status`. */
  mergeStatus: string | null;
  sourceBranch: string;
  targetBranch: string;
  author: string | null;
  /** undefined = the payload did not carry the list. */
  assignees: string[] | undefined;
  reviewers: string[] | undefined;
  webUrl: string | null;
  createdAt: number;
  updatedAt: number | null;
  mergedAt: number | null;
  descriptionNotionId: string | null;
  /** undefined = payload did not include pipelines (list); null = it did and there is none. */
  headPipeline: HeadPipeline | null | undefined;
  /** Source HEAD (`sha`); undefined/null = not in the payload. */
  headSha?: string | null;
  /** The MR's own `squash` flag; undefined/null = not in the payload. */
  squash?: boolean | null;
}

export type Mapped<T> = { ok: true; value: T } | { ok: false; iid?: number; reason: string };

export function mapRawMr(raw: unknown): Mapped<MrFields> {
  const p = RawMrSchema.safeParse(raw);
  if (!p.success) {
    const iid =
      typeof raw === 'object' && raw !== null && typeof (raw as { iid?: unknown }).iid === 'number'
        ? (raw as { iid: number }).iid
        : undefined;
    return { ok: false, ...(iid !== undefined ? { iid } : {}), reason: 'unexpected MR shape' };
  }
  const r = p.data;
  const state = MrStateSchema.safeParse(r.state);
  if (!state.success) {
    return { ok: false, iid: r.iid, reason: `unknown MR state "${r.state.slice(0, 30)}"` };
  }
  const createdAt = toMs(r.created_at);
  if (createdAt === null) return { ok: false, iid: r.iid, reason: 'invalid created_at' };

  const mergeStatus = r.detailed_merge_status ?? r.merge_status ?? null;
  let hasConflicts: boolean | null = r.has_conflicts ?? null;
  if (r.detailed_merge_status === 'conflict') hasConflicts = true;
  else if (hasConflicts === null && r.merge_status === 'can_be_merged') hasConflicts = false;

  const pipe = r.head_pipeline !== undefined ? r.head_pipeline : r.pipeline;
  const headPipeline: HeadPipeline | null | undefined =
    pipe === undefined
      ? undefined
      : pipe === null
        ? null
        : { id: pipe.id, status: pipe.status, webUrl: pipe.web_url ?? null };

  return {
    ok: true,
    value: {
      iid: r.iid,
      gitlabId: r.id ?? null,
      title: r.title,
      state: state.data,
      draft: r.draft ?? r.work_in_progress ?? DRAFT_TITLE_RE.test(r.title),
      hasConflicts,
      mergeStatus,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      author: username(r.author),
      assignees: usernames(r.assignees),
      reviewers: usernames(r.reviewers),
      webUrl: r.web_url ?? null,
      createdAt,
      updatedAt: toMs(r.updated_at),
      mergedAt: toMs(r.merged_at),
      descriptionNotionId: extractNotionPageId(r.description) ?? null,
      headPipeline,
      headSha: r.sha && GIT_SHA_RE.test(r.sha) ? r.sha : null,
      squash: r.squash ?? null,
    },
  };
}

/** `approved_by[].user.username` from `GET …/approvals`; undefined if the shape is wrong. */
export function mapApprovals(raw: unknown): string[] | undefined {
  const p = RawApprovalsSchema.safeParse(raw);
  if (!p.success) return undefined;
  const out: string[] = [];
  for (const a of p.data.approved_by) {
    const u = a.user?.username;
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** Approvers from `GET …/award_emoji` (one per user with the approval emoji); undefined if wrong shape. */
export function mapAwardApprovals(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    const p = RawAwardSchema.safeParse(item);
    if (!p.success || p.data.name !== APPROVAL_EMOJI) continue;
    const u = p.data.user?.username;
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

export interface MappedNotes {
  /** `seen` is a placeholder (false): the store decides read state. */
  notes: Note[];
  skipped: number;
}

/** Flattens `GET …/discussions` into one `Note` per note, oldest first. Bad entries are skipped, counted. */
export function mapDiscussions(
  repoId: string,
  mrIid: number,
  raw: unknown,
): MappedNotes | undefined {
  if (!Array.isArray(raw)) return undefined;
  const notes: Note[] = [];
  let skipped = 0;
  for (const d of raw) {
    const disc = RawDiscussionSchema.safeParse(d);
    if (!disc.success) {
      skipped++;
      continue;
    }
    for (const n of disc.data.notes) {
      const note = RawNoteSchema.safeParse(n);
      const createdAt = note.success ? toMs(note.data.created_at) : null;
      if (!note.success || createdAt === null) {
        skipped++;
        continue;
      }
      const v = note.data;
      const person = RawPerson.safeParse(v.author);
      notes.push({
        repoId,
        mrIid,
        noteId: v.id,
        discussionId: disc.data.id,
        author: username(v.author),
        body: (v.body ?? '').slice(0, NOTE_BODY_MAX),
        system: v.system ?? false,
        resolvable: v.resolvable ?? false,
        resolved: v.resolved ?? false,
        createdAt,
        updatedAt: toMs(v.updated_at),
        seen: false,
        authorName: person.success ? (person.data.name?.slice(0, 120) ?? null) : null,
        authorAvatar: person.success ? (person.data.avatar_url ?? null) : null,
        edited: Boolean(v.last_edited_at),
        individual: disc.data.individual_note ?? false,
      });
    }
  }
  notes.sort((a, b) => a.createdAt - b.createdAt || a.noteId - b.noteId);
  return { notes, skipped };
}

/** Latest non-system note (system notes such as "added 1 commit" are not human activity). */
export function lastHumanNote(
  notes: readonly Note[],
): { author: string | null; at: number } | null {
  let best: Note | undefined;
  for (const n of notes) {
    if (n.system) continue;
    if (!best || n.createdAt >= best.createdAt) best = n;
  }
  return best ? { author: best.author, at: best.createdAt } : null;
}

/** `note_keyword` mode: usernames with a human note that is just an approval keyword. */
export function keywordApprovals(notes: readonly Note[]): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.system || !n.author || out.includes(n.author)) continue;
    const firstLine = n.body.split('\n').find((l) => l.trim().length > 0) ?? '';
    if (APPROVAL_KEYWORD_RE.test(firstLine.trim())) out.push(n.author);
  }
  return out;
}

// ───────────────────────────── MR detail extras (read-only drawer) ─────────────────────────────

/** The description is user content shown in the drawer; clipped so one huge description cannot bloat a response. */
export const DESCRIPTION_MAX = 100_000;

/** Raw markdown description of an MR payload (clipped), or null. Documented `description` field; UNVERIFIED live. */
export function mrDescription(raw: unknown): string | null {
  const p = z.looseObject({ description: z.string().nullish() }).safeParse(raw);
  if (!p.success || !p.data.description) return null;
  return p.data.description.slice(0, DESCRIPTION_MAX);
}

const RawDiffFileSchema = z.looseObject({
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  new_file: z.boolean().nullish(),
  renamed_file: z.boolean().nullish(),
  deleted_file: z.boolean().nullish(),
});
const PATH_MAX = 500;

/**
 * Changed files from `GET …/merge_requests/:iid/diffs` (array) or legacy `…/changes` (its `changes` array).
 * Only paths and added/renamed/deleted flags are kept, never diff text. Documented shape, UNVERIFIED live.
 * `undefined` = not an array.
 */
export function mapDiffFiles(raw: unknown): { files: MrFile[]; skipped: number } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: MrFile[] = [];
  let skipped = 0;
  for (const item of raw) {
    const p = RawDiffFileSchema.safeParse(item);
    const path = p.success ? (p.data.new_path ?? p.data.old_path ?? null) : null;
    if (!p.success || !path) {
      skipped++;
      continue;
    }
    const d = p.data;
    const kind: MrFile['kind'] = d.new_file
      ? 'added'
      : d.deleted_file
        ? 'deleted'
        : d.renamed_file
          ? 'renamed'
          : 'modified';
    const old = d.old_path && d.old_path !== path ? d.old_path.slice(0, PATH_MAX) : null;
    files.push({ path: path.slice(0, PATH_MAX), oldPath: old, kind });
  }
  return { files, skipped };
}

// ───────────────────────────── repository (release detection) ─────────────────────────────

const RawCommitSchema = z.looseObject({ id: z.string(), title: z.string() });
const RawTagSchema = z.looseObject({
  name: z.string(),
  commit: z.looseObject({ committed_date: z.string().nullish() }).nullish(),
});

/** One item of `GET …/repository/commits`. Documented shape, UNVERIFIED live. */
export function mapRawCommit(raw: unknown): { sha: string; title: string } | undefined {
  const p = RawCommitSchema.safeParse(raw);
  return p.success ? { sha: p.data.id, title: p.data.title } : undefined;
}

/** One item of `GET …/repository/tags`. Documented shape, UNVERIFIED live. */
export function mapRawTag(raw: unknown): { name: string; committedAt: number | null } | undefined {
  const p = RawTagSchema.safeParse(raw);
  return p.success
    ? { name: p.data.name, committedAt: toMs(p.data.commit?.committed_date) }
    : undefined;
}

// ───────────────────────────── merge (Merge button) ─────────────────────────────

/** A git object id (SHA-1 or SHA-256), lowercase hex. Anything else is treated as "not given". */
export const GIT_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const RawShaSchema = z.looseObject({
  sha: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  squash_commit_sha: z.string().nullish(),
});
const shaOrNull = (s: string | null | undefined): string | null =>
  s && GIT_SHA_RE.test(s) ? s : null;

/**
 * HEAD commit of the MR's source branch (`sha` on the single-MR payload, documented; UNVERIFIED live).
 * Sent back with the merge so GitLab refuses if a commit landed after the gate check.
 */
export function mrHeadSha(raw: unknown): string | null {
  const p = RawShaSchema.safeParse(raw);
  return p.success ? shaOrNull(p.data.sha) : null;
}

/** `merge_commit_sha` (else `squash_commit_sha`) of the merge answer; null when absent or malformed. */
export function mrMergeCommitSha(raw: unknown): string | null {
  const p = RawShaSchema.safeParse(raw);
  if (!p.success) return null;
  return shaOrNull(p.data.merge_commit_sha) ?? shaOrNull(p.data.squash_commit_sha);
}
