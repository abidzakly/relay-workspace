import { eq, like } from 'drizzle-orm';
import { z } from 'zod';
import {
  normalizeName,
  ReleaseFallbackSchema,
  statusGroupTest,
  type GlobalConfig,
  type PendingCard,
  type PendingMr,
  type PendingRelease,
  type ReleaseFallback,
} from '@relay/shared';
import type { AppDb } from '../db';
import { links, mrs, settings } from '../db/schema';
import { GitlabApiError, type GitlabService } from './gitlabService';
import { listCards } from './notionStore';
import {
  boundaryOf,
  detectRelease,
  knownVersions,
  headCommitVersion,
  parsePubspecVersion,
  releaseOfMr,
  sameVersion,
  type DetectorRepo,
  type ReleaseEvidence,
  type ReleaseState,
} from './releaseDetector';
import { isVersionMr } from './versionMr';

/**
 * Pending-release detection, the part with I/O.
 *  - `runReleaseCheck` runs once per repo inside every GitLab sync (startup catch-up, the 10-minute full sync, and
 *    the webhook refresh, so every `merge_request`/`push` event on the base branch re-evaluates). GET only.
 *  - Its evidence is stored as one small `settings` row per repo, so it survives a restart and every reader
 *    (`/api/state`, Sync Health, the notifier) sees it without talking to GitLab.
 *  - Shapes are GitLab's documented ones, UNVERIFIED live.
 */

const KEY_PREFIX = 'release.check.';
const PUBSPEC_PATH = 'pubspec.yaml';

const EvidenceSchema: z.ZodType<ReleaseEvidence> = z.object({
  checkedAt: z.number(),
  lastOkAt: z.number().nullable(),
  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
  warnings: z.array(z.string()),
  list: z
    .object({
      complete: z.boolean(),
      newestUpdatedAt: z.number().nullable(),
      coveredSince: z.number().nullable(),
    })
    .nullable(),
  head: z
    .object({
      sha: z.string(),
      title: z.string(),
      version: z.string().nullable(),
      at: z.number(),
    })
    .nullable(),
  fallback: ReleaseFallbackSchema.nullable(),
});

function readEvidence(app: AppDb, repoId: string): ReleaseEvidence | null {
  const row = app.db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, KEY_PREFIX + repoId))
    .get();
  return row ? parseEvidence(row.value) : null;
}

function parseEvidence(value: string): ReleaseEvidence | null {
  try {
    const p = EvidenceSchema.safeParse(JSON.parse(value));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

function writeEvidence(app: AppDb, repoId: string, ev: ReleaseEvidence): void {
  const value = JSON.stringify(ev);
  app.db
    .insert(settings)
    .values({ key: KEY_PREFIX + repoId, value, encrypted: false, updatedAt: ev.checkedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, encrypted: false, updatedAt: ev.checkedAt },
    })
    .run();
}

// ───────────────────────────── fallback ─────────────────────────────

/** Answers for a repo with no version MR at all. An interface, so another source can replace pubspec + tags. */
export interface ReleaseFallbackSource {
  check(): Promise<ReleaseFallback>;
}

export class PubspecTagFallback implements ReleaseFallbackSource {
  constructor(
    private readonly gitlab: Pick<GitlabService, 'readRawFile' | 'getLatestTag'>,
    private readonly baseBranch: string,
    private readonly tagFormat = 'v{commitVersion}',
  ) {}

  async check(): Promise<ReleaseFallback> {
    const tag = await this.gitlab.getLatestTag();
    if (!tag) return { kind: 'no_tags', pubspecVersion: null, latestTag: null, tagAt: null };
    const unavailable: ReleaseFallback = {
      kind: 'unavailable',
      pubspecVersion: null,
      latestTag: tag.name,
      tagAt: tag.committedAt,
    };
    let pubspec: string;
    try {
      pubspec = await this.gitlab.readRawFile(PUBSPEC_PATH, this.baseBranch);
    } catch (e) {
      if (e instanceof GitlabApiError && e.kind === 'not_found') return unavailable;
      throw e;
    }
    const version = parsePubspecVersion(pubspec);
    if (!version) return unavailable;
    return {
      kind: sameVersion(this.tagFormat.replace('{commitVersion}', version), tag.name)
        ? 'tag_match'
        : 'tag_mismatch',
      pubspecVersion: version,
      latestTag: tag.name,
      tagAt: tag.committedAt,
    };
  }
}

// ───────────────────────────── live check ─────────────────────────────

export type ReleaseGitlab = Pick<
  GitlabService,
  'getHeadCommit' | 'listMergedMrs' | 'readRawFile' | 'getLatestTag'
>;

const describe = (e: unknown): { kind: string; message: string } =>
  e instanceof GitlabApiError
    ? { kind: e.kind, message: e.message }
    : { kind: 'unexpected', message: 'unexpected error' };

function cachedRepoMrs(app: AppDb, repoId: string) {
  return app.db
    .select({
      iid: mrs.iid,
      title: mrs.title,
      sourceBranch: mrs.sourceBranch,
      targetBranch: mrs.targetBranch,
      state: mrs.state,
      mergedAt: mrs.mergedAt,
      webUrl: mrs.webUrl,
      author: mrs.author,
    })
    .from(mrs)
    .where(eq(mrs.repoId, repoId))
    .all();
}

/**
 * Re-evaluates one repo. Never throws for a GitLab failure: it stores the failure and returns it as warnings. After
 * a failure the previous list stays usable until it goes stale, so a blip does not flip the verdicts.
 */
export async function runReleaseCheck(input: {
  app: AppDb;
  repo: DetectorRepo & { tagFormat?: string };
  gitlab: ReleaseGitlab;
  fallback?: ReleaseFallbackSource;
  now: number;
}): Promise<{ warnings: string[] }> {
  const { app, repo, gitlab, now } = input;
  const prev = readEvidence(app, repo.id);
  const ev: ReleaseEvidence = {
    checkedAt: now,
    lastOkAt: prev?.lastOkAt ?? null,
    error: null,
    warnings: [],
    list: prev?.list ?? null,
    head: prev?.head ?? null,
    fallback: prev?.fallback ?? null,
  };
  const cachedBoundary = knownVersions(repo, cachedRepoMrs(app, repo.id)).at(-1);

  try {
    // 1) Quick head check.
    const head = await gitlab.getHeadCommit(repo.baseBranch);
    const headVersion = head ? headCommitVersion(head.title, repo.versionBranchPrefix) : null;
    ev.head = head ? { ...head, version: headVersion, at: now } : null;
    if (headVersion) ev.lastOkAt = now;

    // Shortcut: head = the bump we already know about, and the list was read before. Nothing to learn.
    const known =
      headVersion !== null &&
      prev?.list?.complete === true &&
      cachedBoundary !== undefined &&
      sameVersion(cachedBoundary.version, headVersion);

    if (!known) {
      // 2) Merged MRs, newest update first (steps 1–3). A pending or newer version MR has
      // `updated_at >= merged_at > boundary.merged_at`, so reading down to the boundary's `merged_at` is complete.
      let floor = Math.max(
        cachedBoundary?.mergedAt ?? -Infinity,
        prev?.list?.complete ? (prev.list.newestUpdatedAt ?? -Infinity) : -Infinity,
      );
      const walk = await gitlab.listMergedMrs({
        targetBranch: repo.baseBranch,
        stopWhen: (page) => {
          for (const m of page) {
            if (m.mergedAt !== null && isVersionMr(m, repo.versionBranchPrefix)) {
              floor = Math.max(floor, m.mergedAt);
            }
          }
          return page.some((m) => m.updatedAt !== null && m.updatedAt <= floor);
        },
      });

      const updated = walk.mrs.flatMap((m) => (m.updatedAt !== null ? [m.updatedAt] : []));
      const oldest = updated.length > 0 ? Math.min(...updated) : null;
      const newest = updated.length > 0 ? Math.max(...updated) : null;
      const last = prev?.list;
      let coveredSince = oldest;
      if (!walk.stopped && !walk.truncated) coveredSince = 0;
      else if (
        oldest !== null &&
        last?.coveredSince != null &&
        last.newestUpdatedAt !== null &&
        oldest <= last.newestUpdatedAt
      ) {
        coveredSince = Math.min(oldest, last.coveredSince);
      }
      ev.list = {
        complete: !walk.truncated,
        newestUpdatedAt: Math.max(newest ?? -Infinity, last?.newestUpdatedAt ?? -Infinity),
        coveredSince,
      };
      if (ev.list.newestUpdatedAt === -Infinity) ev.list.newestUpdatedAt = null;
      if (walk.truncated) ev.warnings.push('merged-MR list longer than the page limit');
      if (walk.skipped.length > 0) {
        ev.warnings.push(`${walk.skipped.length} merged MR(s) could not be read`);
      }
      const undated = walk.mrs.filter((m) => m.mergedAt === null).length;
      if (undated > 0) ev.warnings.push(`${undated} merged MR(s) have no merged_at`);

      // 3) No boundary anywhere: the fallback.
      if (ev.list.complete) {
        if (knownVersions(repo, cachedRepoMrs(app, repo.id)).length > 0) {
          ev.fallback = null;
        } else if (!headVersion) {
          const source =
            input.fallback ?? new PubspecTagFallback(gitlab, repo.baseBranch, repo.tagFormat);
          ev.fallback = await source.check();
        }
        ev.lastOkAt = now;
      }
    }
  } catch (e) {
    ev.error = describe(e);
    ev.warnings.push(`release check failed: ${ev.error.kind}`);
  }
  writeEvidence(app, repo.id, ev);
  return { warnings: ev.warnings };
}

// ───────────────────────────── readers (cache only) ─────────────────────────────

/** Release state of every repo, for the Sync Health facts. Never calls GitLab. */
export function loadReleaseStates(
  app: AppDb,
  repos: readonly DetectorRepo[],
  now: number,
): Map<string, ReleaseState> {
  const stored = new Map<string, ReleaseEvidence | null>();
  for (const r of app.db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(like(settings.key, `${KEY_PREFIX}%`))
    .all()) {
    stored.set(r.key.slice(KEY_PREFIX.length), parseEvidence(r.value));
  }
  return new Map(
    repos.map((r) => [
      r.id,
      detectRelease(r, cachedRepoMrs(app, r.id), stored.get(r.id) ?? null, now),
    ]),
  );
}

/** `{ boundary, pendingMrs, pendingCards, needsVersionBump, … }` per repo. Never calls GitLab. */
export function buildPendingReleases(
  app: AppDb,
  repos: readonly DetectorRepo[],
  global: { notion: Pick<GlobalConfig['notion'], 'readyStatus' | 'statusGroups'> },
  now: number,
): PendingRelease[] {
  const cards = new Map(listCards(app).map((c) => [c.id, c] as const));
  const linkRows = app.db.select().from(links).all();
  const ready = normalizeName(global.notion.readyStatus);
  const { isComplete } = statusGroupTest(global.notion.statusGroups);

  return repos.map((repo) => {
    const rows = cachedRepoMrs(app, repo.id);
    const ev = readEvidence(app, repo.id);
    const state = detectRelease(repo, rows, ev, now);

    const pendingMrs: PendingMr[] = [];
    for (const m of rows) {
      if (m.state !== 'merged' || m.mergedAt === null || m.targetBranch !== repo.baseBranch)
        continue;
      if (isVersionMr(m, repo.versionBranchPrefix)) continue;
      if (releaseOfMr(state, m.mergedAt).bumped !== false) continue;
      pendingMrs.push({
        iid: m.iid,
        title: m.title,
        sourceBranch: m.sourceBranch,
        author: m.author,
        webUrl: m.webUrl,
        mergedAt: m.mergedAt,
      });
    }
    pendingMrs.sort((a, b) => b.mergedAt - a.mergedAt || b.iid - a.iid);

    const pendingIids = new Set(pendingMrs.map((m) => m.iid));
    const byCard = new Map<string, PendingCard>();
    for (const l of linkRows) {
      if (l.repoId !== repo.id || !pendingIids.has(l.mrIid)) continue;
      const card = cards.get(l.cardId);
      if (!card) continue; // archived or not cached
      const status = card.status ? normalizeName(card.status) : null;
      const entry = byCard.get(card.id) ?? {
        cardId: card.id,
        title: card.title,
        status: card.status,
        url: card.url,
        complete: isComplete(card.status),
        ready: status === ready,
        conflict: false,
        mrIids: [],
      };
      entry.conflict ||= l.conflict;
      entry.mrIids.push(l.mrIid);
      byCard.set(card.id, entry);
    }
    const pendingCards = [...byCard.values()].sort((a, b) => a.title.localeCompare(b.title));
    for (const c of pendingCards) c.mrIids.sort((a, b) => b - a);

    const needsVersionBump = pendingMrs.length > 0;
    return {
      repoId: repo.id,
      baseBranch: repo.baseBranch,
      status: state.status,
      reason: state.reason,
      boundary: boundaryOf(state),
      pendingMrs,
      pendingCards,
      needsVersionBump,
      showUpdateVersion: needsVersionBump && pendingCards.some((c) => c.complete),
      headIsVersionUpdate: ev?.head?.version != null && ev.head.at === ev.checkedAt,
      fallback: ev?.fallback ?? null,
      checkedAt: ev?.checkedAt ?? null,
      lastOkAt: ev?.lastOkAt ?? null,
      error: ev?.error ?? null,
      warnings: ev?.warnings ?? [],
    };
  });
}
