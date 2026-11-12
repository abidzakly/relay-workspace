import { z } from 'zod';
import {
  DIFF_TEXT_MAX,
  USERNAME_RE,
  type Branch,
  type CommitSummary,
  type DiffFile,
  type DiffRefs,
  type ReviewDiscussion,
  type ReviewPosition,
} from '@relay/shared';

/**
 * Pure mapping for the Code Reviewer: GitLab REST v4 JSON → shared review shapes.
 * Shapes follow GitLab's documented API (`/merge_requests/:iid/diffs`, `/repository/compare`, `/repository/branches`,
 * `/merge_requests/:iid/discussions` with `position`). UNVERIFIED against the live instance.
 */

const PATH_MAX = 500;
const NOTE_BODY_MAX = 20_000;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

const toMs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const username = (u: { username?: string | null } | null | undefined): string | null =>
  u?.username && USERNAME_RE.test(u.username) ? u.username : null;

const RawDiffSchema = z.looseObject({
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  diff: z.string().nullish(),
  new_file: z.boolean().nullish(),
  renamed_file: z.boolean().nullish(),
  deleted_file: z.boolean().nullish(),
  too_large: z.boolean().nullish(),
  collapsed: z.boolean().nullish(),
});

const BINARY_RE = /^Binary files .* differ$/m;

/** +/− line counts of a unified diff (hunk headers and `\ No newline` markers excluded). */
export function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/** Diff items (MR `/diffs`, legacy `/changes`, or compare `diffs`) with their text kept. `undefined` = not an array. */
export function mapDiffFilesFull(raw: unknown): { files: DiffFile[]; skipped: number } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: DiffFile[] = [];
  let skipped = 0;
  for (const item of raw) {
    const p = RawDiffSchema.safeParse(item);
    const path = p.success ? (p.data.new_path ?? p.data.old_path ?? null) : null;
    if (!p.success || !path) {
      skipped++;
      continue;
    }
    const d = p.data;
    const kind: DiffFile['kind'] = d.new_file
      ? 'added'
      : d.deleted_file
        ? 'deleted'
        : d.renamed_file
          ? 'renamed'
          : 'modified';
    const text = d.diff ?? '';
    const binary = BINARY_RE.test(text.slice(0, 2000));
    const tooLarge = (d.too_large ?? false) || text.length > DIFF_TEXT_MAX;
    const collapsed = !tooLarge && (d.collapsed ?? false) && text.length === 0;
    const keep = !binary && !tooLarge && !collapsed;
    const counts = keep ? countChanges(text) : { additions: 0, deletions: 0 };
    const old = d.old_path && d.old_path !== path ? d.old_path.slice(0, PATH_MAX) : null;
    files.push({
      path: path.slice(0, PATH_MAX),
      oldPath: old,
      kind,
      diff: keep ? text : null,
      binary,
      tooLarge,
      collapsed,
      ...counts,
    });
  }
  return { files, skipped };
}

const RawDiffRefsSchema = z.looseObject({
  diff_refs: z
    .looseObject({
      base_sha: z.string().nullish(),
      start_sha: z.string().nullish(),
      head_sha: z.string().nullish(),
    })
    .nullish(),
});

/** `diff_refs` of an MR payload (needed to post a comment on a line); null when absent or malformed. */
export function mrDiffRefs(raw: unknown): DiffRefs | null {
  const p = RawDiffRefsSchema.safeParse(raw);
  const r = p.success ? p.data.diff_refs : null;
  if (!r?.base_sha || !r.start_sha || !r.head_sha) return null;
  if (![r.base_sha, r.start_sha, r.head_sha].every((s) => SHA_RE.test(s))) return null;
  return { baseSha: r.base_sha, startSha: r.start_sha, headSha: r.head_sha };
}

const RawPositionSchema = z.looseObject({
  position_type: z.string().nullish(),
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  old_line: z.number().int().nullish(),
  new_line: z.number().int().nullish(),
  head_sha: z.string().nullish(),
  line_range: z
    .looseObject({
      start: z
        .looseObject({ old_line: z.number().int().nullish(), new_line: z.number().int().nullish() })
        .nullish(),
    })
    .nullish(),
});

const RawReviewNoteSchema = z.looseObject({
  id: z.number().int().positive(),
  body: z.string().nullish(),
  author: z.looseObject({ username: z.string().nullish() }).nullish(),
  created_at: z.string(),
  system: z.boolean().nullish(),
  resolvable: z.boolean().nullish(),
  resolved: z.boolean().nullish(),
  position: RawPositionSchema.nullish(),
});
const RawReviewDiscussionSchema = z.looseObject({ id: z.string(), notes: z.array(z.unknown()) });

function mapPosition(
  raw: z.infer<typeof RawPositionSchema> | null | undefined,
): ReviewPosition | null {
  if (!raw || (raw.position_type && raw.position_type !== 'text')) return null;
  const path = raw.new_path ?? raw.old_path;
  if (!path) return null;
  const newLine = raw.new_line && raw.new_line > 0 ? raw.new_line : null;
  const oldLine = raw.old_line && raw.old_line > 0 ? raw.old_line : null;
  if (newLine === null && oldLine === null) return null;
  const start = raw.line_range?.start;
  const startNew = start?.new_line && start.new_line > 0 ? start.new_line : null;
  const startOld = start?.old_line && start.old_line > 0 ? start.old_line : null;
  return {
    path: path.slice(0, PATH_MAX),
    oldPath: (raw.old_path ?? path).slice(0, PATH_MAX),
    newLine,
    oldLine,
    ...(raw.head_sha && SHA_RE.test(raw.head_sha) ? { headSha: raw.head_sha } : {}),
    ...(startNew !== null || startOld !== null
      ? { rangeStart: { newLine: startNew, oldLine: startOld } }
      : {}),
  };
}

/** One GitLab discussion → a review thread; null for system-only / malformed ones. */
export function mapReviewDiscussion(raw: unknown): ReviewDiscussion | null {
  const disc = RawReviewDiscussionSchema.safeParse(raw);
  if (!disc.success) return null;
  const notes: ReviewDiscussion['notes'] = [];
  let position: ReviewPosition | null = null;
  let resolvable = false;
  let allResolved = true;
  for (const n of disc.data.notes) {
    const p = RawReviewNoteSchema.safeParse(n);
    if (!p.success || p.data.system) continue;
    const createdAt = toMs(p.data.created_at);
    if (createdAt === null) continue;
    if (p.data.resolvable) {
      resolvable = true;
      if (!p.data.resolved) allResolved = false;
    }
    position ??= mapPosition(p.data.position);
    notes.push({
      id: p.data.id,
      author: username(p.data.author),
      body: (p.data.body ?? '').slice(0, NOTE_BODY_MAX),
      createdAt,
      unread: false,
    });
  }
  if (notes.length === 0) return null;
  return { id: disc.data.id, resolvable, resolved: resolvable && allResolved, notes, position };
}

/** `GET …/discussions` items → review threads, oldest first. */
export function mapReviewDiscussions(raw: unknown): ReviewDiscussion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReviewDiscussion[] = [];
  for (const d of raw) {
    const m = mapReviewDiscussion(d);
    if (m) out.push(m);
  }
  out.sort((a, b) => (a.notes[0]?.createdAt ?? 0) - (b.notes[0]?.createdAt ?? 0));
  return out;
}

const RawBranchSchema = z.looseObject({
  name: z.string(),
  default: z.boolean().nullish(),
  protected: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  commit: z
    .looseObject({ committed_date: z.string().nullish(), id: z.string().nullish() })
    .nullish(),
});

export function mapBranches(raw: unknown): Branch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Branch[] = [];
  for (const item of raw) {
    const p = RawBranchSchema.safeParse(item);
    if (!p.success) continue;
    out.push({
      name: p.data.name.slice(0, 255),
      default: p.data.default ?? false,
      protected: p.data.protected ?? false,
      merged: p.data.merged ?? false,
      committedAt: toMs(p.data.commit?.committed_date),
      sha:
        p.data.commit?.id && /^[0-9a-f]{40}$/i.test(p.data.commit.id)
          ? p.data.commit.id.toLowerCase()
          : null,
    });
  }
  return out;
}

const RawCommitSchema = z.looseObject({
  id: z.string(),
  short_id: z.string().nullish(),
  title: z.string().nullish(),
  message: z.string().nullish(),
  author_name: z.string().nullish(),
  created_at: z.string().nullish(),
});

export const COMMITS_SHOWN = 50;

const RawCompareSchema = z.looseObject({
  commits: z.array(z.unknown()).nullish(),
  diffs: z.array(z.unknown()).nullish(),
  web_url: z.string().nullish(),
});

/** `GET …/repository/compare`. `undefined` = wrong shape. Commits come oldest first from GitLab; returned newest first. */
export function mapCompare(raw: unknown):
  | {
      commits: CommitSummary[];
      commitCount: number;
      files: DiffFile[];
      webUrl: string | null;
    }
  | undefined {
  const p = RawCompareSchema.safeParse(raw);
  if (!p.success) return undefined;
  const all: CommitSummary[] = [];
  for (const c of p.data.commits ?? []) {
    const r = RawCommitSchema.safeParse(c);
    if (!r.success) continue;
    all.push({
      id: r.data.id,
      shortId: r.data.short_id ?? r.data.id.slice(0, 8),
      title: (r.data.title ?? '').slice(0, 300),
      ...(r.data.message ? { message: r.data.message.slice(0, 8_000) } : {}),
      author: r.data.author_name ? r.data.author_name.slice(0, 100) : null,
      createdAt: toMs(r.data.created_at),
    });
  }
  const files = mapDiffFilesFull(p.data.diffs ?? [])?.files ?? [];
  const webUrl = p.data.web_url && /^https?:\/\//.test(p.data.web_url) ? p.data.web_url : null;
  return {
    commits: all.reverse().slice(0, COMMITS_SHOWN),
    commitCount: all.length,
    files,
    webUrl,
  };
}
