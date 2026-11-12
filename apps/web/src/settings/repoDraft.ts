import {
  APPROVAL_MODES,
  SECRET_MASK,
  type ApprovalMode,
  type RepoConfigPublic,
  type RepoPresets,
} from '@relay/shared';
import { opt, splitList } from './drafts';

export type RepoDraft = {
  id: string;
  name: string;
  /** Cards of this repo show on the Board. */
  enabled: boolean;
  projectId: string;
  token: string;
  baseBranch: string;
  reviewers: string;
  /** '' = not chosen yet, NONE_DOMAIN = the repo has no Product Domain, else the Notion Product Domain. */
  productDomain: string;
  approvalMode: ApprovalMode;
  requireVersionMrApproval: boolean;
  versionBranchPrefix: string;
  assignee: string;
  tagFormat: string;
  localPath: string;
  cloneUrl: string;
  partialClone: boolean;
  identityName: string;
  identityEmail: string;
  useFvm: boolean;
  stagingFlavor: string;
  appName: string;
  cleanAfterUpload: boolean;
  driveFolderId: string;
  qaName: string;
  qaWhatsapp: string;
  qaTemplate: string;
};

/** Select value for "this repo has no Product Domain". */
export const NONE_DOMAIN = '__none__';

export const DEFAULT_QA_TEMPLATE =
  'Hi {qa}, {repo} {version} is ready.\nDrive: {drive}\nChanges:\n{changes}';

/** Reviewers start EMPTY on purpose: they define the merge gate. */
export function emptyRepoDraft(defaults: RepoPresets = {}): RepoDraft {
  return {
    id: '',
    name: '',
    enabled: true,
    projectId: '',
    token: '',
    baseBranch: defaults.baseBranch ?? 'main',
    reviewers: (defaults.reviewers ?? []).join(', '),
    productDomain: '',
    approvalMode: 'approvals_api',
    requireVersionMrApproval: false,
    versionBranchPrefix: defaults.versionBranchPrefix ?? 'release/v',
    assignee: '',
    tagFormat: 'v{commitVersion}',
    localPath: '',
    cloneUrl: '',
    partialClone: true,
    identityName: '',
    identityEmail: '',
    useFvm: false,
    stagingFlavor: 'auto',
    appName: '',
    cleanAfterUpload: false,
    driveFolderId: '',
    qaName: '',
    qaWhatsapp: '',
    qaTemplate: DEFAULT_QA_TEMPLATE,
  };
}

export function repoToDraft(r: RepoConfigPublic): RepoDraft {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    projectId: String(r.gitlab.projectId),
    token: r.gitlab.tokenSet ? SECRET_MASK : '',
    baseBranch: r.baseBranch,
    reviewers: r.reviewers.join(', '),
    productDomain: r.productDomains[0] ?? '',
    approvalMode: r.approvalMode,
    requireVersionMrApproval: r.requireVersionMrApproval,
    versionBranchPrefix: r.versionBranchPrefix,
    assignee: r.assignee ?? '',
    tagFormat: r.tagFormat,
    localPath: r.localPath ?? '',
    cloneUrl: r.cloneUrl,
    partialClone: r.partialClone,
    identityName: r.commitIdentity?.name ?? '',
    identityEmail: r.commitIdentity?.email ?? '',
    useFvm: r.flutter.useFvm,
    stagingFlavor: r.flutter.stagingFlavor,
    appName: r.flutter.appName ?? '',
    cleanAfterUpload: r.flutter.cleanAfterUpload,
    driveFolderId: r.drive.folderId ?? '',
    qaName: r.qa.name ?? '',
    qaWhatsapp: r.qa.whatsapp ?? '',
    qaTemplate: r.qa.template,
  };
}

export { APPROVAL_MODES };

/**
 * Whole-repo body for POST/PUT (PUT is a full replace of non-secret fields). The webhook secret is
 * server-generated and never sent. `gitlab.token`: mask = unchanged, string = replace.
 */
export function repoDraftToBody(d: RepoDraft) {
  const projectId = d.projectId.trim() === '' ? undefined : Number(d.projectId.trim());
  const hasIdentity = d.identityName.trim() !== '' || d.identityEmail.trim() !== '';
  return {
    id: d.id.trim(),
    name: d.name.trim(),
    enabled: d.enabled,
    gitlab: { projectId, token: d.token },
    baseBranch: d.baseBranch.trim(),
    reviewers: splitList(d.reviewers),
    productDomains:
      d.productDomain === NONE_DOMAIN || d.productDomain.trim() === ''
        ? []
        : [d.productDomain.trim()],
    approvalMode: d.approvalMode,
    requireVersionMrApproval: d.requireVersionMrApproval,
    versionBranchPrefix: d.versionBranchPrefix.trim(),
    assignee: opt(d.assignee),
    tagFormat: d.tagFormat.trim(),
    localPath: opt(d.localPath),
    cloneUrl: d.cloneUrl.trim(),
    partialClone: d.partialClone,
    commitIdentity: hasIdentity
      ? { name: d.identityName.trim(), email: d.identityEmail.trim() }
      : undefined,
    flutter: {
      useFvm: d.useFvm,
      stagingFlavor: d.stagingFlavor.trim(),
      appName: opt(d.appName) ?? null,
      cleanAfterUpload: d.cleanAfterUpload,
    },
    drive: { folderId: opt(d.driveFolderId) },
    qa: {
      name: opt(d.qaName),
      whatsapp: opt(d.qaWhatsapp),
      template: d.qaTemplate,
    },
  };
}
