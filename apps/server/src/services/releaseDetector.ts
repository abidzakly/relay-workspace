import type { ReleaseBoundary, ReleaseFallback, ReleaseUnknownReason } from '@relay/shared';
import { isVersionBranch, isVersionMr } from './versionMr';

/**
 * Pending-release detection, the PURE part. The inputs are the cached MRs of one repo and the evidence
 * stored by the last live check (`releaseCheck.ts`). Relying on MR state rather than commit text makes merge,
 * squash and fast-forward repos behave alike; only the head check reads a commit title.
 *
 * The cache alone proves "bumped" (a version MR merged at/after the MR exists), but never "not bumped": a newer
 * version MR could simply be missing. So `bumped: false` needs a recent, complete read of the merged-MR list.
 * Otherwise the answer is `null`.
 */

/** Poller full sync = 10 min. Three missed rounds and "not bumped" is no longer claimed. */
export const RELEASE_STALE_MS = 30 * 60 * 1000;

export interface ReleaseEvidence {
  /** Last check attempt. */
  checkedAt: number;
  /** Last check that gave a trustworthy answer. */
  lastOkAt: number | null;
  error: { kind: string; message: string } | null;
  warnings: string[];
  /** Last walk of the merged-MR list; kept when a later check fails. */
  list: {
    /** The walk reached the boundary, the previous walk's top, or the end of the list. */
    complete: boolean;
    /** Newest `updated_at` seen (GitLab's clock): the next walk can stop there. */
    newestUpdatedAt: number | null;
    /** Every merged MR updated at/after this instant was read. 0 = the whole history. */
    coveredSince: number | null;
  } | null;
  /** Last head check. `version` is set when the head commit is a version update. */
  head: { sha: string; title: string; version: string | null; at: number } | null;
  fallback: ReleaseFallback | null;
}

export interface DetectorMr {
  iid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  state: string;
  mergedAt: number | null;
  webUrl?: string | null;
}

export interface DetectorRepo {
  id: string;
  baseBranch: string;
  versionBranchPrefix: string;
}

interface KnownVersion {
  iid: number;
  sourceBranch: string;
  webUrl: string | null;
  version: string;
  mergedAt: number;
}

export interface ReleaseState {
  status: 'ok' | 'unknown';
  reason: ReleaseUnknownReason | null;
  /** Merged version MRs on the base branch, oldest first. */
  versions: KnownVersion[];
  /** The head commit was a version update at this moment: nothing merged before it is pending. */
  head: { version: string; at: number } | null;
  /** Fallback: the latest tag matches pubspec, so nothing merged before the tag is pending. */
  tag: { version: string; at: number } | null;
  coveredSince: number | null;
}

/** The version in a head commit title, or null. Merge commit, squash title (= the branch) or `vu`'s `v<version>`. */
export function headCommitVersion(title: string, versionBranchPrefix: string): string | null {
  const t = title.trim();
  if (isVersionBranch(t, 'v')) return t.slice(1);
  for (const token of t.split(/[\s'"`]+/)) {
    if (isVersionBranch(token, versionBranchPrefix)) return token.slice(versionBranchPrefix.length);
  }
  return null;
}

/** `version:` of a pubspec.yaml, read by line (the file is not otherwise parsed). */
export function parsePubspecVersion(text: string): string | null {
  const m = /^version:[ \t]*['"]?([^\s'"#]+)/m.exec(text);
  return m?.[1] ?? null;
}

/** Same version, ignoring a leading `v` and the `+build` part (branches and tags may omit it). */
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/^v/i, '').split('+')[0];
  return norm(a) === norm(b);
}

/** Merged version MRs on the base branch, oldest first. */
export function knownVersions(repo: DetectorRepo, mrs: readonly DetectorMr[]): KnownVersion[] {
  const out: KnownVersion[] = [];
  for (const m of mrs) {
    if (m.state !== 'merged' || m.mergedAt === null || m.targetBranch !== repo.baseBranch) continue;
    if (!isVersionMr(m, repo.versionBranchPrefix)) continue;
    out.push({
      iid: m.iid,
      sourceBranch: m.sourceBranch,
      webUrl: m.webUrl ?? null,
      version: m.sourceBranch.slice(repo.versionBranchPrefix.length),
      mergedAt: m.mergedAt,
    });
  }
  return out.sort((a, b) => a.mergedAt - b.mergedAt || a.iid - b.iid);
}

/** `mrs` = this repo's cached MRs. */
export function detectRelease(
  repo: DetectorRepo,
  mrs: readonly DetectorMr[],
  ev: ReleaseEvidence | null,
  now: number,
): ReleaseState {
  const versions = knownVersions(repo, mrs);
  const head = ev?.head?.version ? { version: ev.head.version, at: ev.head.at } : null;
  const fb = ev?.fallback ?? null;
  const tag =
    versions.length === 0 && fb?.kind === 'tag_match' && fb.latestTag && fb.tagAt !== null
      ? { version: fb.latestTag.replace(/^v/i, ''), at: fb.tagAt }
      : null;

  let reason: ReleaseUnknownReason | null = null;
  if (ev?.lastOkAt == null) {
    reason = ev?.list?.complete === false ? 'list_incomplete' : 'never_checked';
  } else if (now - ev.lastOkAt > RELEASE_STALE_MS) {
    reason = 'stale';
  } else if (head?.at !== ev.checkedAt) {
    // The head check of this very run is proof enough; anything else rests on the list.
    if (!ev.list?.complete) reason = 'list_incomplete';
    else if (versions.length === 0 && !tag && fb?.kind !== 'no_tags') reason = 'no_boundary';
  }
  return {
    status: reason === null ? 'ok' : 'unknown',
    reason,
    versions,
    head,
    tag,
    coveredSince: ev?.list?.coveredSince ?? null,
  };
}

/**
 * The release of one merged MR on the base branch. The ONE rule behind `pendingMrs` and `ReleaseFact.bumped`.
 * `version` is null when the MR is older than the history read: an unread, older version MR may be its release.
 */
export function releaseOfMr(
  state: ReleaseState,
  mergedAt: number,
): { bumped: boolean | null; version: string | null } {
  const v = state.versions.find((x) => x.mergedAt >= mergedAt);
  if (v) {
    const exact = state.coveredSince !== null && mergedAt >= state.coveredSince;
    return { bumped: true, version: exact ? v.version : null };
  }
  if (state.head && mergedAt <= state.head.at) return { bumped: true, version: state.head.version };
  if (state.tag && mergedAt <= state.tag.at) return { bumped: true, version: state.tag.version };
  return { bumped: state.status === 'ok' ? false : null, version: null };
}

/** The boundary to show; null when none is known. */
export function boundaryOf(state: ReleaseState): ReleaseBoundary | null {
  const newest = state.versions.at(-1);
  const { head, tag } = state;
  if (
    head &&
    (!newest || (head.at > newest.mergedAt && !sameVersion(newest.version, head.version)))
  ) {
    return {
      source: 'head_commit',
      version: head.version,
      at: head.at,
      iid: null,
      sourceBranch: null,
      webUrl: null,
    };
  }
  if (newest) {
    return {
      source: 'version_mr',
      version: newest.version,
      at: newest.mergedAt,
      iid: newest.iid,
      sourceBranch: newest.sourceBranch,
      webUrl: newest.webUrl,
    };
  }
  return tag
    ? {
        source: 'tag',
        version: tag.version,
        at: tag.at,
        iid: null,
        sourceBranch: null,
        webUrl: null,
      }
    : null;
}
