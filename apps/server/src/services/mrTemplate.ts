import type { MrTemplate } from '@relay/shared';
import type { CreateMrInput } from './gitlabRelease';

/**
 * The ONE MR template, shared by "Create MR" and the release pipeline so both stay
 * the `mrc` workflow: title = branch verbatim (never `Draft:`), description = full Notion page URL (empty only for a
 * release MR, which has no card), target = base branch, assignee = me, reviewers = the repo's. `squash: false` and
 * `remove_source_branch: true` are sent by `GitlabReleaseApi.createMr` itself; no milestone, no labels.
 */
export interface MrTemplateInput {
  branch: string;
  targetBranch: string;
  /** Full Notion page URL of the card; null for a release MR. */
  notionUrl: string | null;
  assignee: string | null;
  reviewers: readonly string[];
}

export function mrTemplate(i: MrTemplateInput): MrTemplate {
  return {
    sourceBranch: i.branch,
    targetBranch: i.targetBranch,
    title: i.branch.replace(/^\s*(?:draft:|\[draft\]|wip:)\s*/i, ''),
    description: i.notionUrl ?? '',
    assignee: i.assignee,
    reviewers: [...i.reviewers],
    removeSourceBranch: true,
    squash: false,
    draft: false,
  };
}

/** Template + resolved GitLab user ids → the POST input. */
export function buildMrPayload(
  t: MrTemplate,
  ids: { assigneeId: number; reviewerIds: number[] },
): CreateMrInput {
  return {
    sourceBranch: t.sourceBranch,
    targetBranch: t.targetBranch,
    title: t.title,
    description: t.description,
    assigneeId: ids.assigneeId,
    reviewerIds: ids.reviewerIds,
  };
}
