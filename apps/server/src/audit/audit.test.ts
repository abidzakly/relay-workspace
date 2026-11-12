import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditEntrySchema } from '@relay/shared';
import { makeCtx, type TestCtx } from '../testing/ctx';
import { newUndoToken } from './auditLog';
import { REDACTED, redactSecrets } from './redact';

let ctx: TestCtx;
beforeEach(() => void (ctx = makeCtx()));
afterEach(() => ctx.cleanup());

describe('redactSecrets', () => {
  it('redacts secret-looking keys at any depth, keeps flags and plain data', () => {
    const out = redactSecrets({
      name: 'x',
      tokenSet: true,
      gitlab: { token: 'glpat-1', webhookSecret: 'w', projectId: 1 },
      list: [{ Authorization: 'Bearer z' }, { password: 'p' }],
      notion: { apiKey: 'k', private_key: 'pk' },
    });
    expect(out).toEqual({
      name: 'x',
      tokenSet: true,
      gitlab: { token: REDACTED, webhookSecret: REDACTED, projectId: 1 },
      list: [{ Authorization: REDACTED }, { password: REDACTED }],
      notion: { apiKey: REDACTED, private_key: REDACTED },
    });
  });
  it('handles null/undefined/cycles/non-JSON without throwing', () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    expect(redactSecrets(a)).toEqual({ n: 1, self: '[Circular]' });
    expect(redactSecrets(undefined)).toBeNull();
    expect(redactSecrets(() => 1)).toBeNull();
    expect(redactSecrets(NaN)).toBeNull();
  });
});

describe('AuditWriter', () => {
  it('writes a row matching the shared AuditEntry schema', () => {
    const e = ctx.audit.write({
      actor: 'user',
      action: 'card.status',
      targetType: 'card',
      targetId: 'c1',
      before: { status: 'Complete' },
      after: { status: 'Ready to Test' },
      undoToken: newUndoToken(),
      batchId: 'b1',
    });
    expect(AuditEntrySchema.parse(e)).toEqual(e);
    expect(e.undoToken).toMatch(/^[0-9a-f]{32}$/);
    expect(e.before).toEqual({ status: 'Complete' });
    expect(e.dryRun).toBe(false);
    expect(ctx.audit.get(e.id)).toEqual(e);
    expect(ctx.audit.get(9999)).toBeUndefined();
  });
  it('redacts secrets in before/after and never stores an undo token for dry-run rows', () => {
    const e = ctx.audit.write({
      actor: 'system',
      action: 'x',
      targetType: 't',
      targetId: '1',
      before: { token: 'glpat-SECRET' },
      after: null,
      dryRun: true,
      undoToken: 'should-be-dropped',
    });
    expect(JSON.stringify(e)).not.toContain('glpat-SECRET');
    expect(e.undoToken).toBeNull();
    expect(e.dryRun).toBe(true);
  });
  it('undo tokens are unique random hex', () => {
    expect(new Set(Array.from({ length: 20 }, newUndoToken)).size).toBe(20);
  });
});
