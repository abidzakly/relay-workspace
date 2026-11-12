import { readFileSync, existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepoConfigStoredSchema, SECRET_MASK } from '@relay/shared';
import { schema } from '../db';
import { NOTION_TOKEN, TOKEN, makeCtx, repoBody, type TestCtx } from '../testing/ctx';
import { eq } from 'drizzle-orm';
import { RepoExistsError, RepoNotFoundError, interpretSecretInput } from './store';

let ctx: TestCtx;
beforeEach(() => void (ctx = makeCtx()));
afterEach(() => ctx.cleanup());

const stored = (over: Record<string, unknown> = {}) => RepoConfigStoredSchema.parse(repoBody(over));

function diskBytes(c: TestCtx): string {
  c.app.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  let all = readFileSync(c.file).toString('latin1');
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(c.file + ext)) all += readFileSync(c.file + ext).toString('latin1');
  }
  return all;
}

describe('interpretSecretInput', () => {
  it('maps omitted/mask -> keep, null -> clear, string -> set', () => {
    expect(interpretSecretInput(undefined)).toEqual({ kind: 'keep' });
    expect(interpretSecretInput(SECRET_MASK)).toEqual({ kind: 'keep' });
    expect(interpretSecretInput(null)).toEqual({ kind: 'clear' });
    expect(interpretSecretInput('abc')).toEqual({ kind: 'set', value: 'abc' });
  });
});

describe('secrets are encrypted at rest', () => {
  it('no plaintext token / webhook secret / notion token appears in the DB file (control: name does)', () => {
    ctx.store.saveGlobal(ctx.store.getGlobalStored(), NOTION_TOKEN);
    ctx.store.createRepo(stored(), TOKEN);
    const webhookSecret = ctx.store.getWebhookSecret('app-a');
    expect(webhookSecret).toBeTruthy();

    const bytes = diskBytes(ctx);
    expect(bytes).toContain('App A'); // proves the scan can see plaintext columns
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain('PLAINTEXT-TOKEN');
    expect(bytes).not.toContain(NOTION_TOKEN);
    expect(bytes).not.toContain(webhookSecret as string);
  });

  it('stored JSON columns hold no secret keys; secrets_enc and the notion row are v1 payloads', () => {
    ctx.store.saveGlobal(ctx.store.getGlobalStored(), NOTION_TOKEN);
    ctx.store.createRepo(stored(), TOKEN);
    const row = ctx.app.db.select().from(schema.repos).get()!;
    expect(JSON.stringify(row.config)).not.toMatch(/token|webhookSecret/i);
    expect(row.secretsEnc).toMatch(/^v1:/);
    const s = ctx.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, 'secret.notion.token'))
      .get()!;
    expect(s.encrypted).toBe(true);
    expect(s.value).toMatch(/^v1:/);
    const g = ctx.app.db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, 'global'))
      .get()!;
    expect(g.value).not.toContain(NOTION_TOKEN);
  });

  it('a secrets blob copied to another repo row cannot be decrypted (AAD binding)', () => {
    ctx.store.createRepo(stored(), TOKEN);
    ctx.store.createRepo(stored({ id: 'app-b', name: 'B' }), 'glpat-other');
    const a = ctx.app.db.select().from(schema.repos).where(eq(schema.repos.id, 'app-a')).get()!;
    ctx.app.db
      .update(schema.repos)
      .set({ secretsEnc: a.secretsEnc })
      .where(eq(schema.repos.id, 'app-b'))
      .run();
    expect(() => ctx.store.getRepo('app-b')).toThrow('decryption failed');
  });
});

describe('repos', () => {
  it('create -> public view is masked (flags only), full view decrypts', () => {
    const pub = ctx.store.createRepo(stored(), TOKEN);
    expect(pub.gitlab).toEqual({ projectId: 123, tokenSet: true, webhookSecretSet: true });
    expect(JSON.stringify(pub)).not.toContain(TOKEN);
    const full = ctx.store.getRepo('app-a')!;
    expect(full.gitlab.token).toBe(TOKEN);
    expect(full.gitlab.webhookSecret).toHaveLength(43);
  });

  it('duplicate id -> RepoExistsError; unknown id -> RepoNotFoundError', () => {
    ctx.store.createRepo(stored(), TOKEN);
    expect(() => ctx.store.createRepo(stored(), TOKEN)).toThrow(RepoExistsError);
    expect(() => ctx.store.updateRepo('nope', stored({ id: 'nope' }), undefined)).toThrow(
      RepoNotFoundError,
    );
  });

  it('update: omitted or mask keeps the token; a string replaces it; webhook secret is stable', () => {
    ctx.store.createRepo(stored(), TOKEN);
    const secret = ctx.store.getWebhookSecret('app-a');
    ctx.store.updateRepo('app-a', stored({ name: 'Renamed' }), undefined);
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe(TOKEN);
    ctx.store.updateRepo('app-a', stored({ name: 'R2' }), SECRET_MASK);
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe(TOKEN);
    expect(ctx.store.getRepo('app-a')!.name).toBe('R2');
    ctx.store.updateRepo('app-a', stored(), 'glpat-NEW');
    expect(ctx.store.getRepo('app-a')!.gitlab.token).toBe('glpat-NEW');
    expect(ctx.store.getWebhookSecret('app-a')).toBe(secret);
  });

  it('the repo token cannot be cleared, and the id is immutable', () => {
    ctx.store.createRepo(stored(), TOKEN);
    expect(() => ctx.store.updateRepo('app-a', stored(), null)).toThrow('cannot be cleared');
    expect(() => ctx.store.updateRepo('app-a', stored({ id: 'app-z' }), undefined)).toThrow(
      'immutable',
    );
  });

  it('each repo gets a distinct random webhook secret', () => {
    ctx.store.createRepo(stored(), TOKEN);
    ctx.store.createRepo(stored({ id: 'app-b', name: 'B' }), TOKEN);
    expect(ctx.store.getWebhookSecret('app-a')).not.toBe(ctx.store.getWebhookSecret('app-b'));
    expect(ctx.store.getWebhookSecret('missing')).toBeUndefined();
  });

  it('list is ordered by id; delete returns the public view and removes it', () => {
    ctx.store.createRepo(stored({ id: 'b-repo', name: 'B' }), TOKEN);
    ctx.store.createRepo(stored({ id: 'a-repo', name: 'A' }), TOKEN);
    expect(ctx.store.listRepos().map((r) => r.id)).toEqual(['a-repo', 'b-repo']);
    expect(ctx.store.deleteRepo('a-repo')?.id).toBe('a-repo');
    expect(ctx.store.deleteRepo('a-repo')).toBeUndefined();
    expect(ctx.store.listRepos()).toHaveLength(1);
    expect(ctx.store.getWebhookSecret('a-repo')).toBeUndefined();
  });
});

describe('global settings', () => {
  it('defaults when nothing is stored; dryRun false', () => {
    const g = ctx.store.getGlobalPublic();
    expect(g.dryRun).toBe(false);
    expect(g.notion.tokenSet).toBe(false);
    expect(ctx.store.isDryRun()).toBe(false);
  });

  it('notion token: set, mask keeps, omitted keeps, null clears; never in the public view', () => {
    const base = ctx.store.getGlobalStored();
    let pub = ctx.store.saveGlobal(base, NOTION_TOKEN);
    expect(pub.notion.tokenSet).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(NOTION_TOKEN);
    expect(ctx.store.getGlobal().notion.token).toBe(NOTION_TOKEN);
    ctx.store.saveGlobal(base, SECRET_MASK);
    expect(ctx.store.getGlobal().notion.token).toBe(NOTION_TOKEN);
    ctx.store.saveGlobal(base, undefined);
    expect(ctx.store.getGlobal().notion.token).toBe(NOTION_TOKEN);
    pub = ctx.store.saveGlobal(base, null);
    expect(pub.notion.tokenSet).toBe(false);
    expect(ctx.store.getGlobal().notion.token).toBeUndefined();
  });

  it('dryRun toggles live', () => {
    const base = ctx.store.getGlobalStored();
    ctx.store.saveGlobal({ ...base, dryRun: true }, undefined);
    expect(ctx.store.isDryRun()).toBe(true);
    ctx.store.saveGlobal({ ...base, dryRun: false }, undefined);
    expect(ctx.store.isDryRun()).toBe(false);
  });
});
