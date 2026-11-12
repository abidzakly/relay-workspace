import { z } from 'zod';

/**
 * Validators for strings that end up as argv entries / paths / URLs.
 * Rule: "branch/version strings validated by regex before use".
 * These are deliberately stricter than git itself.
 */

/** Repo id: used in URLs (`/webhook/:repoId`) and in the clone path. Never allow `/` or `..`. */
export const REPO_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const RepoIdSchema = z.string().regex(REPO_ID_RE, 'repo id must be lowercase a-z, 0-9, "-"');

/**
 * A GitLab project that is NOT a configured repo, reached with the personal reviewer token (Reviews): `~<projectId>`.
 * `~` is outside `REPO_ID_RE`, so it can never collide with a configured repo id, and it is URL-safe.
 */
export const EXT_REPO_RE = /^~([1-9][0-9]{0,11})$/;
export const ExtRepoIdSchema = z.string().regex(EXT_REPO_RE, 'invalid external project id');
/** A configured repo id or an external project id: what the review routes and MR writes accept. */
export const ReviewRepoIdSchema = z.union([RepoIdSchema, ExtRepoIdSchema]);
export const extRepoId = (projectId: number): string => `~${projectId}`;
/** The GitLab project id behind `~<id>`, or null for a configured repo id. */
export function extProjectId(repoId: string): number | null {
  const m = EXT_REPO_RE.exec(repoId);
  return m ? Number(m[1]) : null;
}

/** GitLab usernames: letters, digits, `_`, `-`, `.`. */
export const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
export const UsernameSchema = z.string().regex(USERNAME_RE, 'invalid username');

/**
 * Safe git ref name (branch). Subset of what git allows:
 * no leading "-" (option injection), no whitespace, no shell/glob characters,
 * no "..", no "//", no segment starting with "." or ending with ".lock".
 */
const REF_CHARS_RE = /^[A-Za-z0-9][A-Za-z0-9._/{}-]*$/;

function refShapeOk(s: string, allowTrailingSlash: boolean): boolean {
  if (s.length === 0 || s.length > 200) return false;
  if (!REF_CHARS_RE.test(s)) return false;
  if (s.includes('..') || s.includes('//')) return false;
  if (s.endsWith('.')) return false;
  if (!allowTrailingSlash && s.endsWith('/')) return false;
  const segments = s.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? '';
    const isTrailingEmpty = allowTrailingSlash && i === segments.length - 1 && seg === '';
    if (isTrailingEmpty) continue;
    if (seg === '' || seg.startsWith('.') || seg.endsWith('.lock')) return false;
  }
  return true;
}

export function isSafeBranchName(s: string): boolean {
  return refShapeOk(s, false);
}

/** A branch *prefix* such as `release/v` or `release/` (trailing "/" allowed). */
export function isSafeBranchPrefix(s: string): boolean {
  return refShapeOk(s, true);
}

/**
 * For names that may contain `+` (prod version branches and tags). Same rules as `isSafeBranchName` with `+` also
 * allowed, except first (the check sees `-`, which is refused there): `+ref` means a forced push.
 */
export function isSafeReleaseRef(s: string): boolean {
  return isSafeBranchName(s.replaceAll('+', '-'));
}

export const BranchNameSchema = z.string().refine(isSafeBranchName, 'unsafe branch name');
export const ReleaseRefSchema = z.string().refine(isSafeReleaseRef, 'unsafe branch name');
export const BranchPrefixSchema = z.string().refine(isSafeBranchPrefix, 'unsafe branch prefix');

/**
 * Version as `vu` accepts it (its validate_version): X.Y.Z[-prerelease][+build], any prerelease including a
 * bare `-alpha`, and `-` in a build. Lengths are bounded because the value ends up in git argv.
 */
export const VERSION_RE =
  /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,60})?(?:\+[0-9A-Za-z.-]{1,60})?$/;
export function isSafeVersion(s: string): boolean {
  return VERSION_RE.test(s);
}
export const VersionSchema = z.string().refine(isSafeVersion, 'invalid version');

/** Flutter flavor: becomes `lib/main_<flavor>.dart` and a `--flavor` argv entry. */
export const FLAVOR_RE = /^[a-z][a-z0-9_]{0,30}$/;
export const FlavorSchema = z.string().regex(FLAVOR_RE, 'invalid flavor');

/** Notion page / data source id: 32 hex chars, or dashed UUID. */
export const NOTION_ID_RE =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/;
export const NotionIdSchema = z.string().regex(NOTION_ID_RE, 'invalid Notion id');

/** Epoch milliseconds (UTC). All machine timestamps in the DB and API use this. */
export const EpochMsSchema = z.number().int().nonnegative();

/** Any JSON value (for audit before/after, job state bags). */
export const JsonSchema = z.json();
export type Json = z.infer<typeof JsonSchema>;
