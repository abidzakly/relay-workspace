import { z } from 'zod';
import { EpochMsSchema } from './common';
import { ApprovalModeSchema, type ApprovalMode } from './config';
import { MrStateSchema, type MrState } from './mr';

/**
 * Merge gate:
 *   allowed  <=>  state is open  AND  approved_by ∩ repo.reviewers ≠ ∅  AND  !draft  AND  !has_conflicts
 * No unresolved-thread check (decision 3). Usernames compare case-insensitively.
 *
 * ONE pure rule for both sides: the drawer evaluates it over the data it just read (cosmetic: it only
 * decides whether the button is enabled), and `POST /api/mrs/:repo/:iid/merge` evaluates it over a LIVE
 * re-fetch of the MR + approvals at click time (authoritative). Anything the rule cannot establish
 * (approvals not readable, conflict state unknown) FAILS CLOSED with its own reason code.
 */

export const MERGE_BLOCK_REASONS = [
  /** MR is merged / closed / locked (locked = GitLab is already merging it). */
  'not_open',
  'draft',
  'has_conflicts',
  /** GitLab did not say whether there are conflicts (still checking): never assumed "no conflicts". */
  'conflicts_unknown',
  /** The repo has no reviewers configured (config schema requires one; guarded anyway). */
  'no_reviewers',
  /** Approvals were read, but none of the configured reviewers is among the approvers. */
  'not_approved',
  /** `approvals_api` mode, and the Approvals API answered 403/404 (tier/permissions): switch approvalMode. */
  'approvals_unavailable',
  /** Approvals could not be read right now (network, 5xx, odd shape, notes missing in note_keyword mode). */
  'approvals_error',
  /**
   * Stacked MR: an ancestor MR is still open, or an ancestor branch has no MR yet.
   * ABSOLUTE: no override, no force, approvals do not matter. Merge one at a time, parent first.
   */
  'stack_parent_open',
  /** The stack could not be established (commit list / open MRs unreadable): FAIL CLOSED. */
  'stack_unknown',
  /** Squash is on for this MR (or the project forces it): commits are merged as they are. */
  'squash_enabled',
] as const;
export const MergeBlockReasonSchema = z.enum(MERGE_BLOCK_REASONS);
export type MergeBlockReason = z.infer<typeof MergeBlockReasonSchema>;

export const MERGE_APPROVALS_STATUSES = ['ok', 'unavailable', 'error'] as const;
export type MergeApprovalsStatus = (typeof MERGE_APPROVALS_STATUSES)[number];

export const MergeGateSchema = z.object({
  allowed: z.boolean(),
  /** Empty iff `allowed`. Codes are stable (machine-readable); messages are for people. */
  reasons: z.array(z.object({ code: MergeBlockReasonSchema, message: z.string() })),
  /** `live` = read from GitLab just now; `cache` = the local cache (drawer fallback only, never the server gate). */
  source: z.enum(['live', 'cache']),
  checkedAt: EpochMsSchema,
  state: MrStateSchema,
  draft: z.boolean(),
  /** null = unknown. */
  hasConflicts: z.boolean().nullable(),
  approvalMode: ApprovalModeSchema,
  approvalsStatus: z.enum(MERGE_APPROVALS_STATUSES),
  /** Every approver found (any user). */
  approvedBy: z.array(z.string()),
  reviewers: z.array(z.string()),
  /** approved_by ∩ reviewers (as configured). */
  approvingReviewers: z.array(z.string()),
  /**
   * GitLab's own `detailed_merge_status` / `merge_status`. INFORMATIONAL ONLY (not part of the gate):
   * GitLab may still refuse a merge for its own project rules (pipeline must succeed, …).
   */
  gitlabMergeStatus: z.string().nullable(),
  /** Open ancestors that block this merge (empty when none / unknown). */
  stackParents: z
    .array(z.object({ iid: z.number().int().positive().nullable(), branch: z.string() }))
    .default([]),
  /**
   * Commits in `target...source` (shown for information, never a gate). null = unknown.
   */
  commitCount: z.number().int().nonnegative().nullable().default(null),
  /** Non-blocking notes for people (e.g. "this MR has 3 commits"). */
  warnings: z.array(z.string()).default([]),
});
export type MergeGate = z.infer<typeof MergeGateSchema>;

export interface MergeGateInput {
  source: 'live' | 'cache';
  checkedAt: number;
  state: MrState;
  draft: boolean;
  hasConflicts: boolean | null;
  approvalMode: ApprovalMode;
  approvals: { status: MergeApprovalsStatus; approvedBy: readonly string[]; message?: string };
  reviewers: readonly string[];
  gitlabMergeStatus: string | null;
  /**
   * Stack state. REQUIRED: a caller that cannot tell must pass `{ status: 'error' }` (fails closed).
   * `openParents` = open ancestor MRs and ancestor branches without MR.
   */
  stack: {
    status: 'ok' | 'error';
    openParents: readonly { iid: number | null; branch: string }[];
    commitCount: number | null;
    message?: string;
  };
  /** `mr` = the MR's own `squash` flag; `project` = project `squash_option` (null = unknown). */
  squash: { mr: boolean | null; project: string | null };
}

const MODE_LABEL: Record<ApprovalMode, string> = {
  approvals_api: 'GitLab approvals',
  award_emoji: '👍 award',
  note_keyword: '"approved"/"lgtm" comment',
};

/** The rule. Pure; never throws. */
export function evaluateMergeGate(i: MergeGateInput): MergeGate {
  const reasons: MergeGate['reasons'] = [];
  const add = (code: MergeBlockReason, message: string) => reasons.push({ code, message });
  const lower = (s: string) => s.toLowerCase();

  if (i.state !== 'opened') {
    add(
      'not_open',
      i.state === 'locked'
        ? 'GitLab is already merging this MR (locked).'
        : `The MR is ${i.state}, not open.`,
    );
  }
  if (i.draft) add('draft', 'The MR is a draft. Mark it ready in GitLab first.');
  if (i.hasConflicts === true) add('has_conflicts', 'The MR has merge conflicts.');
  else if (i.hasConflicts === null) {
    add(
      'conflicts_unknown',
      'GitLab has not reported whether the MR has conflicts yet (still checking). Try again shortly.',
    );
  }

  const approvingReviewers: string[] = [];
  if (i.reviewers.length === 0) {
    add('no_reviewers', 'No reviewers are configured for this repo (Settings → Repos).');
  } else if (i.approvals.status === 'unavailable') {
    add(
      'approvals_unavailable',
      `Approvals cannot be read in "${i.approvalMode}" mode (${i.approvals.message ?? 'not available'}). ` +
        'Set the repo\'s approval mode to "award_emoji" or "note_keyword" in Settings.',
    );
  } else if (i.approvals.status === 'error') {
    add(
      'approvals_error',
      `Approvals could not be read right now${i.approvals.message ? ` (${i.approvals.message})` : ''}.`,
    );
  } else {
    for (const r of i.reviewers) {
      if (i.approvals.approvedBy.some((a) => lower(a) === lower(r))) approvingReviewers.push(r);
    }
    if (approvingReviewers.length === 0) {
      add(
        'not_approved',
        `Not approved by a configured reviewer (${i.reviewers.map((r) => `@${r}`).join(', ')}) ` +
          `via ${MODE_LABEL[i.approvalMode]}.`,
      );
    }
  }

  // Stacked MR: absolute, fail closed.
  if (i.stack.status === 'error') {
    add(
      'stack_unknown',
      `Could not verify whether this MR depends on another open MR${i.stack.message ? ` (${i.stack.message})` : ''}. Merge is blocked until it can.`,
    );
  } else if (i.stack.openParents.length > 0) {
    const names = i.stack.openParents.map((p) =>
      p.iid !== null ? `!${p.iid}` : `${p.branch} (no MR yet)`,
    );
    add(
      'stack_parent_open',
      `Waiting for ${names.join(', ')} to be merged first. Stacked MRs merge one at a time, parent first.`,
    );
  }
  // No squash.
  if (i.squash.mr === true) {
    add(
      'squash_enabled',
      'Squash is enabled on this MR. Turn it off: commits are merged as they are.',
    );
  } else if (i.squash.project === 'always') {
    add(
      'squash_enabled',
      'The project forces squash ("always"). Change the project merge setting in GitLab first.',
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    source: i.source,
    checkedAt: i.checkedAt,
    state: i.state,
    draft: i.draft,
    hasConflicts: i.hasConflicts,
    approvalMode: i.approvalMode,
    approvalsStatus: i.approvals.status,
    approvedBy: [...i.approvals.approvedBy],
    reviewers: [...i.reviewers],
    approvingReviewers,
    gitlabMergeStatus: i.gitlabMergeStatus,
    stackParents: i.stack.status === 'ok' ? i.stack.openParents.map((p) => ({ ...p })) : [],
    commitCount: i.stack.commitCount,
    warnings: [],
  };
}

// ───────────────────────────── POST /api/mrs/:repo/:iid/merge ─────────────────────────────

/**
 * No options. The server ALWAYS sends `squash: false, should_remove_source_branch: true`; project defaults
 * are never relied on. Unknown keys are rejected.
 */
export const MrMergeRequestSchema = z.object({}).strict();
export type MrMergeRequest = z.infer<typeof MrMergeRequestSchema>;

export const MrMergeResultSchema = z.object({
  /** true = simulated (global dry-run): the gate was checked live, the merge itself was NOT sent. */
  dryRun: z.boolean(),
  auditId: z.number().int().positive(),
  /** The live gate the decision was made on. */
  gate: MergeGateSchema,
  /** GitLab reported the MR as merged in its answer. false in dry-run, or when GitLab is still merging. */
  merged: z.boolean(),
  /** The state GitLab reported back (null in dry-run / unreadable answer). */
  state: MrStateSchema.nullable(),
  mergeCommitSha: z.string().nullable(),
});
export type MrMergeResult = z.infer<typeof MrMergeResultSchema>;

/**
 * 409 body `details` when the server's live gate refuses (`error: "merge_blocked"`). The UI compares it with
 * what it showed: "the page said yes, GitLab now says no".
 */
export const MergeBlockedDetailsSchema = z.object({ gate: MergeGateSchema });
export type MergeBlockedDetails = z.infer<typeof MergeBlockedDetailsSchema>;

/**
 * Every error code the merge route can answer with (besides `validation` / `repo_not_found` / `mr_not_found`):
 *  - 409 merge_blocked          our gate refused (details.gate)
 *  - 409 merge_in_progress      another merge click for the same MR is still running
 *  - 409 gitlab_not_configured  no GitLab host
 *  - 409 gitlab_not_mergeable   GitLab refused for its own rules (HTTP 405/422: pipeline, approval rules, …)
 *  - 409 gitlab_conflicts       GitLab refused: conflicts (HTTP 406)
 *  - 409 gitlab_sha_changed     a commit landed after the check (HTTP 409 on `sha`)
 *  - 403 gitlab_forbidden       token cannot merge (HTTP 401/403)
 *  - 404 / 429 / 502 gitlab_*   read or write failure
 */
export const MERGE_ERROR_CODES = [
  'merge_blocked',
  'merge_in_progress',
  'gitlab_not_configured',
  'gitlab_not_mergeable',
  'gitlab_conflicts',
  'gitlab_sha_changed',
  'gitlab_forbidden',
] as const;
