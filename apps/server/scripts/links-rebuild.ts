// Dev tool (no route / scheduler yet): re-runs the card <-> MR matcher over the local cache
// (after notion:sync and a GitLab sync) and prints the outcome table. Writes ONLY the local `links` table.
//   pnpm --filter @relay/server links:rebuild
import { join } from 'node:path';
import { SecretBox } from '../src/config/crypto';
import { loadEnv, resolveDataDir } from '../src/config/env';
import { ConfigStore } from '../src/config/store';
import { openDatabase, runMigrations } from '../src/db';
import { loadMrStates, relinkAll } from '../src/services/linkStore';

const env = loadEnv();
const app = openDatabase(join(resolveDataDir(env), 'app.db'));
try {
  runMigrations(app);
  const store = new ConfigStore(app, SecretBox.fromEnv(env.MASTER_KEY));
  const repos = store.listReposFull();
  const { result, persisted } = relinkAll(app, repos);
  const states = loadMrStates(app, repos);

  const tally: Record<string, number> = {};
  for (const m of result.mrs) tally[m.outcome] = (tally[m.outcome] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        persisted,
        mrs: result.mrs.length,
        versionMrsExcluded: result.excluded.length,
        byOutcome: tally,
        cardsWithoutMr: result.cardsWithoutMr.length,
        duplicateCards: result.duplicates.length,
      },
      null,
      2,
    ),
  );
  for (const m of result.mrs.filter((x) => x.outcome !== 'strong')) {
    const extra = [
      m.mismatchReason,
      m.suggestion,
      m.descriptionUnresolved ? 'description-id-not-a-known-card' : undefined,
      m.live ? undefined : 'closed',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `  ${m.repoId}!${m.mrIid}  ${m.outcome.padEnd(16)} [${states.get(`${m.repoId}#${m.mrIid}`) ?? '?'}] cards=${m.cardIds.length}${extra ? `  (${extra})` : ''}`,
    );
  }
} catch (e) {
  console.error(`failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  app.close();
}
