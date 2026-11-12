import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type AppDb } from '../db';
import { buildPendingReleases } from './releaseCheck';

const NOW = 1_762_000_000_000;
const CARD = '0123456789abcdef0123456789abcdef';
const REPO = { id: 'app-a', baseBranch: 'develop', versionBranchPrefix: 'version/' };

let dir: string;
let app: AppDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-release-'));
  app = openDatabase(join(dir, 'app.db'));
  runMigrations(app);
});
afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One merged MR after a successful check, linked to one card with this status. */
function seedPending(status: string) {
  const run = (sql: string, ...params: unknown[]) => app.sqlite.prepare(sql).run(...params);
  run(
    `insert into repos (id, name, config) values (?, 'App A', ?)`,
    REPO.id,
    JSON.stringify({ id: REPO.id }),
  );
  run(
    `insert into settings (key, value) values (?, ?)`,
    `release.check.${REPO.id}`,
    JSON.stringify({
      checkedAt: NOW,
      lastOkAt: NOW,
      error: null,
      warnings: [],
      list: { complete: true, newestUpdatedAt: NOW, coveredSince: null },
      head: null,
      fallback: { kind: 'no_tags', pubspecVersion: null, latestTag: null, tagAt: null },
    }),
  );
  run(
    `insert into mrs (repo_id, iid, title, state, source_branch, target_branch, created_at, merged_at, synced_at)
     values (?, 1, 'A feature', 'merged', 'feature/a', ?, ?, ?, ?)`,
    REPO.id,
    REPO.baseBranch,
    NOW - 2000,
    NOW - 1000,
    NOW,
  );
  run(
    `insert into cards (id, title, status, last_edited_at, synced_at) values (?, 'A card', ?, ?, ?)`,
    CARD,
    status,
    NOW,
    NOW,
  );
  run(
    `insert into links (card_id, repo_id, mr_iid, match_by) values (?, ?, 1, 'title')`,
    CARD,
    REPO.id,
  );
}

const pending = (complete: string[]) =>
  buildPendingReleases(
    app,
    [REPO],
    {
      notion: {
        readyStatus: 'Ready to Test',
        statusGroups: { complete, done: [], inactive: [], uncommitted: [] },
      },
    },
    NOW,
  )[0]!;

describe('buildPendingReleases: Complete cards', () => {
  it('offers the update for a configured spelling of Complete', () => {
    seedPending('Completed');
    const release = pending(['Complete', 'Completed']);
    expect(release.pendingCards.map((c) => c.complete)).toEqual([true]);
    expect(release.showUpdateVersion).toBe(true);
  });

  it('holds the update back for a card that is not Complete', () => {
    seedPending('In Progress');
    const release = pending(['Complete', 'Completed']);
    expect(release.needsVersionBump).toBe(true);
    expect(release.showUpdateVersion).toBe(false);
  });

  it('follows the setting, not a built-in name', () => {
    seedPending('Complete');
    expect(pending(['Completed']).showUpdateVersion).toBe(false);
  });
});
