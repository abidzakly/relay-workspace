import { WEBHOOK_KINDS, type WebhookKind } from '@relay/shared';

/**
 * Normalizes GitLab webhook payloads into small, typed events. Pure: no DB, no I/O.
 * Shapes follow GitLab's documented webhook payloads and are UNVERIFIED against the live instance
 * (no sample payloads were attached): every field except the identifying ones is optional, and an
 * event that cannot be recognised is reported as `{ ok:false }` (stored as `ignored`), never thrown.
 */

const HEADER_KIND: Record<string, WebhookKind> = {
  'merge request hook': 'merge_request',
  'note hook': 'note',
  'pipeline hook': 'pipeline',
  'push hook': 'push',
};

export interface MergeRequestEvent {
  kind: 'merge_request';
  projectId: number | undefined;
  iid: number;
  /** `open | close | reopen | update | approved | unapproved | approval | unapproval | merge` (documented). */
  action: string | undefined;
  actor: string | undefined;
  state: 'opened' | 'closed' | 'locked' | 'merged' | undefined;
  title: string | undefined;
  draft: boolean | undefined;
  sourceBranch: string | undefined;
  targetBranch: string | undefined;
  /** `undefined` = the payload did not say. */
  hasConflicts: boolean | undefined;
  /** `undefined` = no description in the payload (leave the cached key alone). */
  description: string | undefined;
  updatedAt: number | undefined;
  mergedAt: number | undefined;
  /** Set when an `update` carried new commits (approvals may have been reset). */
  newCommits: boolean;
}

export interface NoteEvent {
  kind: 'note';
  projectId: number | undefined;
  noteId: number;
  noteableType: string | undefined;
  /** Only for notes on a merge request. */
  mrIid: number | undefined;
  author: string | undefined;
  body: string;
  system: boolean;
  discussionId: string | undefined;
  createdAt: number | undefined;
  updatedAt: number | undefined;
  action: string | undefined;
}

export interface PipelineEvent {
  kind: 'pipeline';
  projectId: number | undefined;
  pipelineId: number;
  status: string;
  ref: string | undefined;
  tag: boolean;
  /** The MR the pipeline belongs to, when the payload says so. */
  mrIid: number | undefined;
  webUrl: string | null;
}

export interface PushEvent {
  kind: 'push';
  projectId: number | undefined;
  /** Branch name (`refs/heads/` stripped); undefined for tags or anything else. */
  branch: string | undefined;
  actor: string | undefined;
  /** `after` is all zeros: the branch was deleted. */
  deleted: boolean;
  lastCommitAt: number | undefined;
  /** `after` (the new head), when it is a SHA. */
  sha?: string | undefined;
}

export type NormalizedEvent = MergeRequestEvent | NoteEvent | PipelineEvent | PushEvent;

export type NormalizeResult =
  { ok: true; event: NormalizedEvent } | { ok: false; reason: string; kind: WebhookKind | null };

/** Facts for the `events` row, readable even when the payload cannot be normalized. */
export interface EventMeta {
  kind: WebhookKind | null;
  action: string | null;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/**
 * GitLab timestamps come as `2013-12-03 17:23:34 UTC`, `2013-12-03 17:23:34 +0200` or ISO-8601.
 * Returns epoch ms or undefined.
 */
export function parseGitlabTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(
    s,
  );
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : t;
  }
  let zone = m[4] ?? 'Z';
  if (zone === 'UTC') zone = 'Z';
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}${zone}`);
  return Number.isNaN(t) ? undefined : t;
}

/** Which of our four kinds a delivery is: the payload's `object_kind` wins, the header is the fallback. */
export function webhookKind(eventHeader: string | undefined, payload: unknown): WebhookKind | null {
  const ok = str(rec(payload).object_kind);
  if (ok && (WEBHOOK_KINDS as readonly string[]).includes(ok)) return ok as WebhookKind;
  const h = eventHeader ? HEADER_KIND[eventHeader.trim().toLowerCase()] : undefined;
  return h ?? null;
}

export function eventMeta(eventHeader: string | undefined, payload: unknown): EventMeta {
  const p = rec(payload);
  const action = str(rec(p.object_attributes).action) ?? null;
  return { kind: webhookKind(eventHeader, payload), action };
}

const ZERO_SHA = /^0+$/;

export function normalizeWebhook(
  eventHeader: string | undefined,
  payload: unknown,
): NormalizeResult {
  const kind = webhookKind(eventHeader, payload);
  if (!kind) return { ok: false, reason: 'unsubscribed event kind', kind: null };
  const p = rec(payload);
  const projectId = int(rec(p.project).id) ?? int(p.project_id);
  const attrs = rec(p.object_attributes);
  const user = str(rec(p.user).username) ?? str(p.user_username);

  switch (kind) {
    case 'merge_request': {
      const iid = int(attrs.iid);
      if (iid === undefined || iid <= 0)
        return { ok: false, reason: 'merge request iid missing', kind };
      const stateRaw = str(attrs.state);
      const state =
        stateRaw === 'opened' ||
        stateRaw === 'closed' ||
        stateRaw === 'locked' ||
        stateRaw === 'merged'
          ? stateRaw
          : undefined;
      const detailed = str(attrs.detailed_merge_status);
      const mergeStatus = str(attrs.merge_status);
      let hasConflicts: boolean | undefined;
      if (detailed === 'conflict') hasConflicts = true;
      else if (detailed === undefined && mergeStatus === 'cannot_be_merged') hasConflicts = true;
      else if (mergeStatus === 'can_be_merged') hasConflicts = false;
      const action = str(attrs.action);
      const oldrev = str(attrs.oldrev);
      return {
        ok: true,
        event: {
          kind,
          projectId,
          iid,
          action,
          actor: user,
          state,
          title: str(attrs.title),
          draft: bool(attrs.draft) ?? bool(attrs.work_in_progress),
          sourceBranch: str(attrs.source_branch),
          targetBranch: str(attrs.target_branch),
          hasConflicts,
          description: typeof attrs.description === 'string' ? attrs.description : undefined,
          updatedAt: parseGitlabTime(attrs.updated_at),
          mergedAt: parseGitlabTime(attrs.merged_at),
          newCommits: action === 'update' && oldrev !== undefined && oldrev !== '',
        },
      };
    }
    case 'note': {
      const noteId = int(attrs.id);
      if (noteId === undefined || noteId <= 0)
        return { ok: false, reason: 'note id missing', kind };
      const noteableType = str(attrs.noteable_type);
      const mrIid = noteableType === 'MergeRequest' ? int(rec(p.merge_request).iid) : undefined;
      return {
        ok: true,
        event: {
          kind,
          projectId,
          noteId,
          noteableType,
          mrIid,
          author: user,
          body: typeof attrs.note === 'string' ? attrs.note : '',
          system: bool(attrs.system) ?? false,
          discussionId: str(attrs.discussion_id),
          createdAt: parseGitlabTime(attrs.created_at),
          updatedAt: parseGitlabTime(attrs.updated_at),
          action: str(attrs.action),
        },
      };
    }
    case 'pipeline': {
      const pipelineId = int(attrs.id);
      const status = str(attrs.status);
      if (pipelineId === undefined || !status) {
        return { ok: false, reason: 'pipeline id/status missing', kind };
      }
      const projectWeb = str(rec(p.project).web_url);
      const given = str(attrs.url);
      const candidate =
        given ?? (projectWeb ? `${projectWeb}/-/pipelines/${pipelineId}` : undefined);
      return {
        ok: true,
        event: {
          kind,
          projectId,
          pipelineId,
          status,
          ref: str(attrs.ref),
          tag: bool(attrs.tag) ?? false,
          mrIid: int(rec(p.merge_request).iid),
          webUrl: candidate && /^https?:\/\//i.test(candidate) ? candidate : null,
        },
      };
    }
    case 'push': {
      const ref = str(p.ref);
      const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
      const after = str(p.after);
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const last = rec(commits[commits.length - 1]);
      return {
        ok: true,
        event: {
          kind,
          projectId,
          branch: branch && branch.length > 0 ? branch : undefined,
          actor: str(p.user_username) ?? user,
          deleted: after !== undefined && ZERO_SHA.test(after),
          lastCommitAt: parseGitlabTime(last.timestamp),
          sha: after && /^[0-9a-f]{40}$/i.test(after) ? after.toLowerCase() : undefined,
        },
      };
    }
  }
}
