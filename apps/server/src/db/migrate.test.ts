import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  CardSchema,
  JobSchema,
  JobStepSchema,
  LinkSchema,
  MrSchema,
  NoteSchema,
} from '@relay/shared';
import { defaultMigrationsDir, openDatabase, runMigrations, schema, type AppDb } from './index';

const PLAN_TABLES = [
  'repos',
  'settings',
  'cards',
  'mrs',
  'mr_commits',
  'ai_cache',
  'review_decks',
  'branch_pushes',
  'workspaces',
  'links',
  'notes_cache',
  'events',
  'audit_log',
  'jobs',
  'job_steps',
  'push_subs',
  'kpi_snapshots',
  'gamification',
].sort();

const CARD = '0123456789abcdef0123456789abcdef';
const CARD2 = 'fedcba9876543210fedcba9876543210';
const NOW = 1_762_000_000_000;

let dir: string;
let app: AppDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'core-db-'));
  app = openDatabase(join(dir, 'nested', 'app.db'));
  runMigrations(app);
});
afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const tableNames = (): string[] =>
  (
    app.sqlite
      .prepare(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '\\_\\_drizzle%' escape '\\'",
      )
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();

const run = (sql: string, ...params: unknown[]) => app.sqlite.prepare(sql).run(...params);

function seedRepo(id = 'app-a') {
  run(`insert into repos (id, name, config) values (?, ?, ?)`, id, 'App A', JSON.stringify({ id }));
}
function seedCard(id = CARD) {
  run(
    `insert into cards (id, title, last_edited_at, synced_at) values (?, 't', ?, ?)`,
    id,
    NOW,
    NOW,
  );
}
function seedMr(repoId = 'app-a', iid = 1) {
  run(
    `insert into mrs (repo_id, iid, title, state, source_branch, target_branch, created_at, synced_at)
     values (?, ?, 't', 'opened', 's', 'main', ?, ?)`,
    repoId,
    iid,
    NOW,
    NOW,
  );
}

describe('open + migrate (smoke)', () => {
  it('creates the db file (and parent dir) owner-only, WAL, foreign keys on', () => {
    expect(app.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(app.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(app.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    const mode = statSync(join(dir, 'nested', 'app.db')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates exactly the 13 PLAN §4 tables', () => {
    expect(tableNames()).toEqual(PLAN_TABLES);
  });

  it('is idempotent (second run is a no-op, nothing lost)', () => {
    seedRepo();
    runMigrations(app);
    runMigrations(app);
    const row = app.sqlite.prepare('select count(*) c from repos').get() as { c: number };
    expect(row.c).toBe(1);
    const applied = app.sqlite.prepare('select count(*) c from __drizzle_migrations').get() as {
      c: number;
    };
    expect(applied.c).toBe(1);
  });

  it('works on :memory: and a reopened file keeps data', () => {
    const mem = openDatabase(':memory:');
    runMigrations(mem);
    expect(
      mem.sqlite.prepare("select count(*) c from sqlite_master where name='repos'").get(),
    ).toEqual({
      c: 1,
    });
    mem.close();

    seedRepo();
    app.close();
    app = openDatabase(join(dir, 'nested', 'app.db'));
    runMigrations(app);
    expect(app.sqlite.prepare('select id from repos').all()).toEqual([{ id: 'app-a' }]);
  });

  it('round-trips JSON columns through drizzle', () => {
    app.db
      .insert(schema.jobs)
      .values({
        id: 'j1',
        repoId: seedRepoReturn(),
        kind: 'release',
        mode: 'staging',
        state: { step: { sha: 'abc', n: [1, 2] } },
      })
      .run();
    const [row] = app.db.select().from(schema.jobs).all();
    expect(row?.state).toEqual({ step: { sha: 'abc', n: [1, 2] } });
    expect(row?.status).toBe('queued');
    expect(row?.engine).toBe('node');
    expect(typeof row?.createdAt).toBe('number');
    expect(Math.abs((row?.createdAt ?? 0) - Date.now())).toBeLessThan(5000);
  });
});

function seedRepoReturn(): string {
  seedRepo();
  return 'app-a';
}

describe('defaultMigrationsDir', () => {
  it('finds migrations from src/db and from a nested dir', () => {
    const fromSrc = defaultMigrationsDir();
    expect(fromSrc.endsWith(join('src', 'db', 'migrations'))).toBe(true);
    const nested = join(dir, 'x');
    mkdirSync(nested);
    expect(() => defaultMigrationsDir(nested)).toThrow(/could not locate/);
  });
});

describe('schema ↔ migrations ↔ shared drift guards', () => {
  const allTables: SQLiteTable[] = Object.values(schema as Record<string, unknown>).filter((v) =>
    is(v, SQLiteTable),
  ) as SQLiteTable[];

  it('every drizzle table exists in the DB with exactly the declared columns', () => {
    expect(allTables.map((t) => getTableName(t)).sort()).toEqual(PLAN_TABLES);
    for (const t of allTables) {
      const declared = Object.values(getTableColumns(t))
        .map((c) => c.name)
        .sort();
      const actual = (
        app.sqlite.prepare(`pragma table_info(${getTableName(t)})`).all() as { name: string }[]
      )
        .map((c) => c.name)
        .sort();
      expect(actual, `columns of ${getTableName(t)} (did you run pnpm db:generate?)`).toEqual(
        declared,
      );
    }
  });

  it('every declared index exists in the DB', () => {
    for (const t of allTables) {
      const cfg = getTableConfig(t);
      const actual = new Set(
        (app.sqlite.prepare(`pragma index_list(${cfg.name})`).all() as { name: string }[]).map(
          (i) => i.name,
        ),
      );
      for (const idx of cfg.indexes)
        expect(actual.has(idx.config.name), idx.config.name).toBe(true);
    }
  });

  const pairs: [string, unknown, { shape: Record<string, unknown> }][] = [
    ['cards ↔ Card', schema.cards, CardSchema],
    ['mrs ↔ Mr', schema.mrs, MrSchema],
    ['notes_cache ↔ Note', schema.notesCache, NoteSchema],
    ['links ↔ Link', schema.links, LinkSchema],
    ['audit_log ↔ AuditEntry', schema.auditLog, AuditEntrySchema],
    ['jobs ↔ Job', schema.jobs, JobSchema],
    ['job_steps ↔ JobStep', schema.jobSteps, JobStepSchema],
  ];
  it.each(pairs)('%s have the same fields', (_name, table, zodSchema) => {
    const tableKeys = Object.keys(getTableColumns(table as SQLiteTable)).sort();
    expect(Object.keys(zodSchema.shape).sort()).toEqual(tableKeys);
  });
});

describe('integrity rules', () => {
  it('foreign keys are enforced', () => {
    expect(() => seedMr('ghost-repo', 1)).toThrow(/FOREIGN KEY/);
  });

  it('deleting a repo cascades to its MRs, notes, links, events, jobs and steps', () => {
    seedRepo();
    seedCard();
    seedMr('app-a', 1);
    run(
      `insert into notes_cache (repo_id, mr_iid, note_id, discussion_id, created_at) values ('app-a',1,10,'d',?)`,
      NOW,
    );
    run(
      `insert into links (card_id, repo_id, mr_iid, match_by) values (?, 'app-a', 1, 'both')`,
      CARD,
    );
    run(
      `insert into events (event_uuid, repo_id, event_type, received_at) values ('u1','app-a','Push Hook',?)`,
      NOW,
    );
    run(`insert into jobs (id, repo_id, kind, mode) values ('j','app-a','release','staging')`);
    run(`insert into job_steps (job_id, seq, name) values ('j',0,'PREFLIGHT')`);

    run(`delete from repos where id='app-a'`);
    for (const t of ['mrs', 'notes_cache', 'links', 'events', 'jobs', 'job_steps']) {
      const r = app.sqlite.prepare(`select count(*) c from ${t}`).get() as { c: number };
      expect(r.c, t).toBe(0);
    }
    // cards are independent of repos
    expect(app.sqlite.prepare('select count(*) c from cards').get()).toEqual({ c: 1 });
  });

  it('links: a link needs an existing card and MR, is unique per pair, but a card may have 2 MRs (duplicates are representable)', () => {
    seedRepo();
    seedCard();
    seedCard(CARD2);
    seedMr('app-a', 1);
    seedMr('app-a', 2);
    const ins = (card: string, iid: number) =>
      run(
        `insert into links (card_id, repo_id, mr_iid, match_by, conflict) values (?, 'app-a', ?, 'title', 1)`,
        card,
        iid,
      );
    expect(() => ins('missing-card', 1)).toThrow(/FOREIGN KEY/);
    expect(() => ins(CARD, 99)).toThrow(/FOREIGN KEY/);
    ins(CARD, 1);
    expect(() => ins(CARD, 1)).toThrow(/UNIQUE/);
    ins(CARD, 2); // duplicate MR for one card
    ins(CARD2, 1); // mismatch: one MR → two cards
    expect(app.sqlite.prepare('select count(*) c from links').get()).toEqual({ c: 3 });
  });

  it('deleting a card removes its links only', () => {
    seedRepo();
    seedCard();
    seedMr();
    run(
      `insert into links (card_id, repo_id, mr_iid, match_by) values (?, 'app-a', 1, 'manual')`,
      CARD,
    );
    run(`delete from cards where id=?`, CARD);
    expect(app.sqlite.prepare('select count(*) c from links').get()).toEqual({ c: 0 });
    expect(app.sqlite.prepare('select count(*) c from mrs').get()).toEqual({ c: 1 });
  });

  it('webhook delivery dedupe: same X-Gitlab-Event-UUID cannot be stored twice', () => {
    seedRepo();
    const ins = () =>
      run(
        `insert into events (event_uuid, repo_id, event_type, received_at) values ('uuid-1','app-a','Push Hook',?)`,
        NOW,
      );
    ins();
    expect(ins).toThrow(/UNIQUE/);
    // …and the intended idempotent pattern works:
    const r = run(
      `insert into events (event_uuid, repo_id, event_type, received_at) values ('uuid-1','app-a','Push Hook',?) on conflict(event_uuid) do nothing`,
      NOW,
    );
    expect(r.changes).toBe(0);
  });

  it('CHECK constraints reject unknown enum values', () => {
    seedRepo();
    expect(() =>
      run(
        `insert into mrs (repo_id, iid, title, state, source_branch, target_branch, created_at, synced_at)
         values ('app-a', 1, 't', 'open', 's', 'main', 1, 1)`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(`insert into jobs (id, repo_id, kind, mode) values ('j','app-a','deploy','staging')`),
    ).toThrow(/CHECK/);
    expect(() =>
      run(`insert into jobs (id, repo_id, kind, mode) values ('j','app-a','release','yolo')`),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        `insert into jobs (id, repo_id, kind, mode, status) values ('j','app-a','release','staging','zombie')`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        `insert into audit_log (actor, action, target_type, target_id) values ('root','x','card','1')`,
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      run(
        `insert into events (event_uuid, repo_id, event_type, received_at, status) values ('u','app-a','h',1,'??')`,
      ),
    ).toThrow(/CHECK/);
  });

  it('jobs: step names are open text, steps are unique per (job, seq), parent job set-null on delete', () => {
    seedRepo();
    run(`insert into jobs (id, repo_id, kind, mode) values ('parent','app-a','release','staging')`);
    run(
      `insert into jobs (id, repo_id, kind, mode, parent_job_id, current_step) values ('child','app-a','build','staging','parent','SOME_FUTURE_STEP')`,
    );
    run(`insert into job_steps (job_id, seq, name) values ('parent',0,'PREFLIGHT')`);
    expect(() =>
      run(`insert into job_steps (job_id, seq, name) values ('parent',0,'SYNC_BASE')`),
    ).toThrow(/UNIQUE/);
    run(`delete from jobs where id='parent'`);
    expect(app.sqlite.prepare(`select parent_job_id p from jobs where id='child'`).get()).toEqual({
      p: null,
    });
  });

  it('audit_log: survives deletion of what it describes, undo tokens are unique, NULLs allowed', () => {
    const ins = (token: string | null) =>
      run(
        `insert into audit_log (actor, action, target_type, target_id, undo_token, before, after)
         values ('user','card.status','card','c1',?,?,?)`,
        token,
        JSON.stringify({ status: 'Complete' }),
        JSON.stringify({ status: 'Ready to Test' }),
      );
    ins('t1');
    expect(() => ins('t1')).toThrow(/UNIQUE/);
    ins(null);
    ins(null);
    expect(app.sqlite.prepare('select count(*) c from audit_log').get()).toEqual({ c: 3 });
  });

  it('gamification ledger is idempotent per dedupe_key', () => {
    const award = () =>
      run(
        `insert into gamification (kind, dedupe_key, amount) values ('xp','xp:card_ready:c1:r1',10) on conflict(dedupe_key) do nothing`,
      );
    expect(award().changes).toBe(1);
    expect(award().changes).toBe(0);
    expect(app.sqlite.prepare(`select sum(amount) s from gamification`).get()).toEqual({ s: 10 });
  });

  it('push_subs endpoint is unique; kpi_snapshots keyed by month', () => {
    const sub = () =>
      run(`insert into push_subs (endpoint, p256dh, auth) values ('https://push/e','k','a')`);
    sub();
    expect(sub).toThrow(/UNIQUE/);
    run(`insert into kpi_snapshots (month, data) values ('2026-10','{}')`);
    expect(() => run(`insert into kpi_snapshots (month, data) values ('2026-10','{}')`)).toThrow(
      /UNIQUE|PRIMARY/,
    );
  });

  it('settings stores plain and encrypted rows', () => {
    run(`insert into settings (key, value) values ('global','{}')`);
    run(`insert into settings (key, value, encrypted) values ('secret.notion.token','v1:abc',1)`);
    const rows = app.sqlite.prepare('select key, encrypted from settings order by key').all();
    expect(rows).toEqual([
      { key: 'global', encrypted: 0 },
      { key: 'secret.notion.token', encrypted: 1 },
    ]);
  });
});
