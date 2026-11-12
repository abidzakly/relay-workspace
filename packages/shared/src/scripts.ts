import { z } from 'zod';
import { EpochMsSchema } from './common';

/**
 * Release scripts (`tools/bin`: vu, mrc, vcheck, nts, reauthor, flutter-run-menu). Their settings live in the
 * dashboard: most come from what Settings already knows (GitLab host and username, the repo's branch prefix,
 * reviewers and commit identity, the Notion token and data source); the rest are asked once, when a feature first
 * needs them, and kept. The dashboard writes them to `~/.config/relay/scripts.env` (mode 600) so the
 * scripts read the same values when you run them from a terminal, and passes them as env when it runs them.
 */

export const SCRIPT_TOOLS = [
  { id: 'vu', summary: 'Bumps the Flutter version, opens the version MR, merges, tags, builds' },
  { id: 'mrc', summary: 'Opens a merge request with glab' },
  { id: 'vcheck', summary: 'Checks the Notion cards of the MRs in a release' },
  { id: 'nts', summary: 'Moves a Notion card to a status' },
  { id: 'reauthor', summary: 'Rewrites commit authors to the right identity' },
  { id: 'flutter-run-menu', summary: 'Builds or runs a Flutter flavor' },
] as const;
export type ScriptTool = (typeof SCRIPT_TOOLS)[number]['id'];

/** What a field is needed for: `release` blocks a release through the scripts; `notion` only the Notion step. */
export const SCRIPT_NEEDS = ['release', 'notion', 'optional'] as const;
export type ScriptNeed = (typeof SCRIPT_NEEDS)[number];

/** Where a value comes from when you did not type one. */
export const SCRIPT_SOURCES = [
  'gitlab.host',
  'gitlab.myUsername',
  'gitlab.hostname',
  'repo.token',
  'repo.versionBranchPrefix',
  'repo.reviewer',
  'repo.commitName',
  'repo.commitEmail',
  'reviewer.token',
  'notion.token',
  'notion.dataSourceId',
  'notion.readyStatus',
  'notion.version',
] as const;
export type ScriptSource = (typeof SCRIPT_SOURCES)[number];

export interface ScriptField {
  /** The environment variable the scripts read. */
  key: string;
  label: string;
  hint: string;
  secret: boolean;
  need: ScriptNeed;
  usedBy: readonly ScriptTool[];
  /** Filled from Settings when not typed. Repo sources apply when a repo runs the script. */
  from: readonly ScriptSource[];
  /** Shown in the input when empty. */
  placeholder?: string;
}

export const SCRIPT_FIELDS: readonly ScriptField[] = [
  {
    key: 'GITLAB_HOST',
    label: 'GitLab host',
    hint: 'Where glab opens and merges the version MR.',
    secret: false,
    need: 'release',
    usedBy: ['vu', 'mrc', 'vcheck'],
    from: ['gitlab.host'],
    placeholder: 'https://gitlab.example.com',
  },
  {
    key: 'GITLAB_TOKEN',
    label: 'GitLab token for the scripts',
    hint: 'Scope api. From the dashboard each repo uses its own token; this one is for running the scripts in a terminal.',
    secret: true,
    need: 'release',
    usedBy: ['vu', 'mrc', 'vcheck'],
    from: ['repo.token', 'reviewer.token'],
    placeholder: 'glpat-…',
  },
  {
    key: 'VU_ASSIGNEE',
    label: 'Assign version MRs to',
    hint: 'Your GitLab username. vu also finds an unfinished version MR by it.',
    secret: false,
    need: 'release',
    usedBy: ['vu', 'mrc'],
    from: ['gitlab.myUsername'],
    placeholder: 'jane.doe',
  },
  {
    key: 'VU_BRANCH_PREFIX',
    label: 'Version branch prefix',
    hint: 'Version MRs come from <prefix><version>. Each repo can set its own under Repos.',
    secret: false,
    need: 'release',
    usedBy: ['vu', 'vcheck'],
    from: ['repo.versionBranchPrefix'],
    placeholder: 'release/v',
  },
  {
    key: 'MRC_REVIEWER',
    label: 'Reviewer of version MRs',
    hint: 'Empty: no reviewer. Each repo uses its first configured reviewer.',
    secret: false,
    need: 'optional',
    usedBy: ['mrc'],
    from: ['repo.reviewer'],
    placeholder: 'reviewer.username',
  },
  {
    key: 'VU_COMMIT_NAME',
    label: 'Commit author name',
    hint: 'The name on the version commit. A repo’s own commit identity wins.',
    secret: false,
    need: 'release',
    usedBy: ['vu'],
    from: ['repo.commitName'],
    placeholder: 'Jane Doe',
  },
  {
    key: 'VU_COMMIT_EMAIL',
    label: 'Commit author email',
    hint: 'The email on the version commit.',
    secret: false,
    need: 'release',
    usedBy: ['vu'],
    from: ['repo.commitEmail'],
    placeholder: 'jane@example.com',
  },
  {
    key: 'REAUTHOR_WORK_HOSTS',
    label: 'Work git hosts',
    hint: 'Comma list. reauthor picks your "self" identity for repos on these hosts.',
    secret: false,
    need: 'optional',
    usedBy: ['reauthor', 'vu'],
    from: ['gitlab.hostname'],
    placeholder: 'gitlab.example.com',
  },
  {
    key: 'NOTION_TOKEN',
    label: 'Notion token',
    hint: 'After a release, vcheck and nts move the released cards. Skipped when empty.',
    secret: true,
    need: 'notion',
    usedBy: ['vcheck', 'nts'],
    from: ['notion.token'],
    placeholder: 'ntn_…',
  },
  {
    key: 'NOTION_DATA_SOURCE_ID',
    label: 'Notion data source',
    hint: 'The cards database the scripts update.',
    secret: false,
    need: 'notion',
    usedBy: ['vcheck', 'nts'],
    from: ['notion.dataSourceId'],
  },
  {
    key: 'NOTION_READY_STATUS',
    label: 'Status after release',
    hint: 'The status released cards move to.',
    secret: false,
    need: 'notion',
    usedBy: ['vcheck', 'nts'],
    from: ['notion.readyStatus'],
    placeholder: 'Ready to Test',
  },
  {
    key: 'NOTION_VERSION',
    label: 'Notion API version',
    hint: 'Leave as is unless Notion asks for another.',
    secret: false,
    need: 'optional',
    usedBy: ['nts'],
    from: ['notion.version'],
  },
];

export const SCRIPT_KEYS = SCRIPT_FIELDS.map((f) => f.key);
export const SCRIPT_KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** One field as the browser sees it: never a secret's value. */
export const ScriptFieldStateSchema = z.object({
  key: z.string(),
  /** A value typed in the dashboard. */
  saved: z.boolean(),
  /** Shown value: the typed or derived value, `null` for secrets and empty fields. */
  value: z.string().nullable(),
  /** Settings place the value comes from when nothing is typed; null = nowhere. */
  derivedFrom: z.string().nullable(),
  /** There is a value one way or another. */
  filled: z.boolean(),
});
export type ScriptFieldState = z.infer<typeof ScriptFieldStateSchema>;

export const ScriptsStatusSchema = z.object({
  fields: z.array(ScriptFieldStateSchema),
  /** The env file the scripts read; null when it cannot be written here (see `fileError`). */
  envFile: z.string().nullable(),
  writtenAt: EpochMsSchema.nullable(),
  fileError: z.string().nullable(),
  /** Which `vu` the dashboard runs: your own (`~/bin`, `VU_BIN_DIR`) or the bundled `tools/bin`. */
  vu: z.object({ path: z.string().nullable(), bundled: z.boolean() }),
  /** Command-line tools the scripts call that are missing on this machine. */
  missingTools: z.array(z.string()),
});
export type ScriptsStatus = z.infer<typeof ScriptsStatusSchema>;

/** Save: a string sets, `null` clears (falls back to Settings), absent keeps. */
export const ScriptsSaveRequestSchema = z.object({
  values: z.record(z.string().regex(SCRIPT_KEY_RE), z.union([z.string().max(4096), z.null()])),
});
export type ScriptsSaveRequest = z.infer<typeof ScriptsSaveRequestSchema>;

/** A 409 `script_config_missing` carries these: what to ask before running. */
export const ScriptsMissingSchema = z.object({
  repoId: z.string(),
  /** Blocking: without them the script would stop and wait for input nobody can type. */
  required: z.array(z.string()),
  /** Notion step: the run can go ahead without it (the Notion update is skipped). */
  optional: z.array(z.string()),
});
export type ScriptsMissing = z.infer<typeof ScriptsMissingSchema>;
