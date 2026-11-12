import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCtx, type TestCtx } from '../testing/ctx';
import { UnconfirmedWriteError, guardedWrite, type GuardedWriteOp } from './dryRun';

let ctx: TestCtx;
beforeEach(() => void (ctx = makeCtx()));
afterEach(() => ctx.cleanup());

const deps = () => ({ dryRun: ctx.store, audit: ctx.audit, log: ctx.log });
const setDry = (on: boolean) =>
  ctx.store.saveGlobal({ ...ctx.store.getGlobalStored(), dryRun: on }, undefined);
const op = (
  run: () => Promise<string>,
  over: Partial<GuardedWriteOp<string>> = {},
): GuardedWriteOp<string> => ({
  actor: 'user',
  action: 'card.status',
  targetType: 'card',
  targetId: 'c1',
  confirmed: true,
  before: { status: 'A' },
  after: { status: 'B' },
  run,
  ...over,
});

describe('guardedWrite', () => {
  it('dry-run ON: does not call out, writes a dryRun audit row without undo token, logs it', async () => {
    setDry(true);
    const run = vi.fn(async () => 'real');
    const r = await guardedWrite(deps(), op(run, { reversible: true, simulated: 'fake' }));
    expect(run).not.toHaveBeenCalled();
    expect(r.dryRun).toBe(true);
    expect(r.result).toBe('fake');
    expect(r.audit).toMatchObject({
      dryRun: true,
      undoToken: null,
      action: 'card.status',
      before: { status: 'A' },
    });
    expect(ctx.logLines.join('')).toContain('dry-run: write simulated');
  });

  it('dry-run OFF: calls out once, audits with before/after and an undo token when reversible', async () => {
    const run = vi.fn(async () => 'real');
    const r = await guardedWrite(deps(), op(run, { reversible: true }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ dryRun: false, result: 'real' });
    expect(r.audit.dryRun).toBe(false);
    expect(r.audit.undoToken).toMatch(/^[0-9a-f]{32}$/);
    expect(r.audit.after).toEqual({ status: 'B' });
  });

  it('irreversible writes get no undo token', async () => {
    const r = await guardedWrite(
      deps(),
      op(async () => 'x'),
    );
    expect(r.audit.undoToken).toBeNull();
  });

  it('the toggle applies to the very next write (no caching)', async () => {
    const run = vi.fn(async () => 'x');
    setDry(true);
    await guardedWrite(deps(), op(run));
    setDry(false);
    await guardedWrite(deps(), op(run));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failing call-out is not audited as done and the error propagates', async () => {
    await expect(
      guardedWrite(
        deps(),
        op(async () => Promise.reject(new Error('502'))),
      ),
    ).rejects.toThrow('502');
    expect(ctx.audit.get(1)).toBeUndefined();
  });

  it('refuses unconfirmed writes (never automatic), in both modes', async () => {
    const run = vi.fn(async () => 'x');
    for (const on of [false, true]) {
      setDry(on);
      await expect(
        guardedWrite(deps(), { ...op(run), confirmed: false as unknown as true }),
      ).rejects.toThrow(UnconfirmedWriteError);
    }
    expect(run).not.toHaveBeenCalled();
    expect(ctx.audit.get(1)).toBeUndefined();
  });
});
