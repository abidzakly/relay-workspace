import { z } from 'zod';
import { EpochMsSchema } from './common';

/**
 * "Connect" buttons: a browser sign-in at Google, GitLab or Notion. The OAuth clients are registered once by whoever
 * runs Relay and set in `.env` (see docs/CONNECT.md); the user only signs in with their own account.
 */
export const OAUTH_PROVIDERS = ['google', 'gitlab', 'notion'] as const;
export const OAuthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

/** What a Google sign-in is asked for. Each card asks only for its own; Google adds it to the earlier grant. */
export const GOOGLE_FEATURES = ['calendar', 'drive'] as const;
export const GoogleFeatureSchema = z.enum(GOOGLE_FEATURES);
export type GoogleFeature = z.infer<typeof GoogleFeatureSchema>;

export const OAuthConnectionSchema = z.object({
  provider: OAuthProviderSchema,
  /** A client is set in `.env` (and, for GitLab, the host is known): the Connect button can work. */
  available: z.boolean(),
  /** Why the button cannot work yet, worded for a person. Null when `available`. */
  unavailableReason: z.string().nullable(),
  connected: z.boolean(),
  /** The signed-in account (e-mail, username or workspace), when known. */
  account: z.string().nullable(),
  /** Google: which features the grant covers. Empty for the others. */
  features: z.array(GoogleFeatureSchema),
  connectedAt: EpochMsSchema.nullable(),
  /** The last sign-in or refresh error, worded for a person. */
  lastError: z.string().nullable(),
  /** The redirect address to register with the provider (shown in the setup guide). */
  redirectUri: z.string(),
});
export type OAuthConnection = z.infer<typeof OAuthConnectionSchema>;

export const OAuthStatusSchema = z.object({
  google: OAuthConnectionSchema,
  gitlab: OAuthConnectionSchema,
  notion: OAuthConnectionSchema,
});
export type OAuthStatus = z.infer<typeof OAuthStatusSchema>;

export const OAuthConnectBodySchema = z
  .object({ feature: GoogleFeatureSchema.optional() })
  .strict()
  .prefault({});
export type OAuthConnectBody = z.infer<typeof OAuthConnectBodySchema>;

/** A Notion data source the signed-in user shared with Relay (for the picker). */
export const NotionDataSourceOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  /** The database's own emoji, when it has one. */
  emoji: z.string().nullable().optional(),
  /** How many columns it has. */
  columns: z.number().int().nonnegative().optional(),
  /** ISO time of the last schema or title change. */
  editedAt: z.string().nullable().optional(),
  /** Has a status (or select) column and a people column, like a task board. */
  boardLike: z.boolean().optional(),
});
export type NotionDataSourceOption = z.infer<typeof NotionDataSourceOptionSchema>;

/** A GitLab project the signed-in user is a member of (for the Add repository picker). */
export const GitlabProjectOptionSchema = z.object({
  id: z.number().int(),
  pathWithNamespace: z.string(),
  name: z.string(),
  httpUrlToRepo: z.string(),
  defaultBranch: z.string().nullable(),
  /** The project's own path (last part of `pathWithNamespace`), for a repo id. Absent in older payloads. */
  path: z.string().optional(),
  sshUrlToRepo: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
});
export type GitlabProjectOption = z.infer<typeof GitlabProjectOptionSchema>;

/**
 * Body of the GitLab picker reads (Add repository wizard). Which token reads GitLab: `token` (a project access token
 * pasted in the wizard, never stored by the read), else the saved repo's own token (`repoId`), else the GitLab
 * sign-in or the personal token, by mode.
 */
export const GitlabPickerBodySchema = z.object({
  token: z.string().min(1).max(4096).optional(),
  repoId: z.string().min(1).max(64).optional(),
  projectId: z.number().int().positive().optional(),
  search: z.string().max(100).optional(),
});
export type GitlabPickerBody = z.infer<typeof GitlabPickerBodySchema>;

/** The GitLab user behind the token: fills the commit identity, the username and the default assignee. */
export const GitlabMeSchema = z.object({
  username: z.string(),
  name: z.string().nullable(),
  /** The address commits should carry: GitLab's commit email, else the public email, else the account email. */
  email: z.string().nullable(),
});
export type GitlabMe = z.infer<typeof GitlabMeSchema>;

/** A member of a GitLab project (reviewers, assignee). */
export const GitlabMemberSchema = z.object({
  username: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  /** GitLab access level: 30 Developer, 40 Maintainer, 50 Owner. */
  accessLevel: z.number().int(),
});
export type GitlabMember = z.infer<typeof GitlabMemberSchema>;

/** What Relay can read from a project's tree for its Flutter build settings. */
export const GitlabFlutterHintsSchema = z.object({
  /** Flavors from `lib/main_<flavor>.dart`. */
  flavors: z.array(z.string()),
  /** `name:` in pubspec.yaml, when there is one. */
  appName: z.string().nullable(),
  isFlutter: z.boolean(),
});
export type GitlabFlutterHints = z.infer<typeof GitlabFlutterHintsSchema>;

/** One column of a Notion data source, for the setup wizard. */
export const NotionSchemaPropSchema = z.object({
  name: z.string(),
  /** Notion's type name (`people`, `rich_text`, `select`, `status`, `relation`, `formula`, …). */
  type: z.string(),
  /** Option names of a status / select / multi_select column (status: in board order). */
  options: z.array(z.string()),
});
export type NotionSchemaProp = z.infer<typeof NotionSchemaPropSchema>;

/** A data source's columns plus a few cards, for the wizard's mapping and preview steps. */
export const NotionSchemaViewSchema = z.object({
  dataSourceId: z.string(),
  title: z.string(),
  props: z.array(NotionSchemaPropSchema),
  /** Up to 5 recent cards: column name -> text as Notion shows it. */
  samples: z.array(z.record(z.string(), z.string())),
});
export type NotionSchemaView = z.infer<typeof NotionSchemaViewSchema>;

/** The Notion user behind the sign-in (null with an internal integration token, which has no owner user). */
export const NotionMeSchema = z
  .object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() })
  .nullable();
export type NotionMe = z.infer<typeof NotionMeSchema>;

/** A person found in a board's people column, for the setup wizard's "which one is you". */
export const NotionPersonSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable().optional(),
});
export type NotionPerson = z.infer<typeof NotionPersonSchema>;
