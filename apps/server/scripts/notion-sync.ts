// Dev tool (no HTTP route / scheduler exists yet): runs ONE Notion read-sync against the
// real data source configured in Settings and prints a summary. Read-only towards Notion.
//   pnpm --filter @relay/server notion:sync [full|incremental]
import { join } from 'node:path';
import { SecretBox } from '../src/config/crypto';
import { loadEnv, resolveDataDir } from '../src/config/env';
import { ConfigStore } from '../src/config/store';
import { openDatabase, runMigrations } from '../src/db';
import { HttpClient } from '../src/services/httpClient';
import { NotionApiError, NotionService } from '../src/services/notionService';
import { listCards } from '../src/services/notionStore';
import { createLogger } from '../src/util/logger';

const mode = process.argv[2] ?? 'incremental';
if (mode !== 'full' && mode !== 'incremental') {
  console.error('usage: notion:sync [full|incremental]');
  process.exit(2);
}

const env = loadEnv();
const log = createLogger({ level: env.LOG_LEVEL, pretty: process.stdout.isTTY });
const app = openDatabase(join(resolveDataDir(env), 'app.db'));
try {
  runMigrations(app);
  const store = new ConfigStore(app, SecretBox.fromEnv(env.MASTER_KEY));
  const svc = NotionService.fromConfig(store, { http: new HttpClient({ log }), store: app, log });
  const report = await (mode === 'full' ? svc.fullSync() : svc.incrementalSync());
  console.log(JSON.stringify(report, null, 2));

  const all = listCards(app, { includeArchived: true });
  const byStatus: Record<string, number> = {};
  for (const c of all) byStatus[c.status ?? '(none)'] = (byStatus[c.status ?? '(none)'] ?? 0) + 1;
  console.log(
    JSON.stringify(
      { cached: all.length, archived: all.filter((c) => c.archived).length, byStatus },
      null,
      2,
    ),
  );
  console.log('assigned to me (first seen):');
  for (const c of all.filter((x) => x.assignedAtFirstSeen !== null).slice(0, 10)) {
    const at = new Date(c.assignedAtFirstSeen!).toISOString();
    console.log(
      `  ${at}${c.assignedAtApprox ? ' (approx)' : ''}  [${c.status ?? '-'}] ${c.title.slice(0, 70)}`,
    );
  }
} catch (e) {
  // NotionApiError messages never include the token or response bodies.
  console.error(e instanceof NotionApiError ? e.message : `failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  app.close();
}
