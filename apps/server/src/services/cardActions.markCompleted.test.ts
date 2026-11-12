import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardActions, type CardNotionPort } from './cardActions';
import { cards } from '../db/schema';
import { makeCtx, type TestCtx } from '../testing/ctx';
import { NotionApiError } from './notionService';
import { getCard } from './notionStore';

const CARD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const prop = {
  id: 'st',
  name: 'Status',
  type: 'status' as const,
  options: [
    { id: 'ip', name: 'In Progress' },
    { id: 'c', name: 'Complete' },
    { id: 'cd', name: 'Completed' },
  ],
};

function live(name: string | null) {
  return { id: CARD, name, optionId: name ? 'opt' : null, lastEditedAt: 2, archived: false };
}

function notionPort(status: string | null): CardNotionPort {
  return {
    readPageStatus: vi.fn(async () => live(status)),
    resolveStatusOption: vi.fn(async (name: string) => {
      const option = prop.options.find((o) => o.name === name);
      if (!option) return { ok: false as const, reason: 'option_missing' as const };
      return { ok: true as const, prop, option };
    }),
    statusProperty: vi.fn() as unknown as CardNotionPort['statusProperty'],
    setPageStatus: vi.fn(async () => live('Completed')),
  };
}

function seed(ctx: TestCtx, status: string, statuses: string[]) {
  const base = ctx.store.getGlobalStored();
  ctx.store.saveGlobal({ ...base, notion: { ...base.notion, statuses } }, undefined);
  ctx.app.db
    .insert(cards)
    .values({
      id: CARD,
      title: 'Weather',
      status,
      url: 'https://www.notion.so/weather',
      branchName: 'feat/weather',
      lastEditedAt: 1,
      syncedAt: 1,
    })
    .run();
}

const WITH_COMPLETED = ['Backlog', 'In Progress', 'Complete', 'Completed', 'Ready to Test'];

describe('CardActions.markCompleted', () => {
  let ctx: TestCtx;
  afterEach(() => {
    ctx?.cleanup();
    vi.restoreAllMocks();
  });

  const actions = (port: CardNotionPort) =>
    new CardActions({
      config: ctx.store,
      audit: ctx.audit,
      store: ctx.app,
      notion: port,
      log: ctx.log,
    });

  it('writes Completed when the live status is something else', async () => {
    ctx = makeCtx();
    seed(ctx, 'In Progress', WITH_COMPLETED);
    const port = notionPort('In Progress');
    const out = await actions(port).markCompleted(CARD);
    expect(out).toEqual({ outcome: 'updated', status: 'Completed', error: null });
    expect(port.setPageStatus).toHaveBeenCalledWith(CARD, prop, 'cd');
    expect(getCard(ctx.app, CARD)?.status).toBe('Completed');
  });

  it('leaves a card that is already Completed', async () => {
    ctx = makeCtx();
    seed(ctx, 'In Progress', WITH_COMPLETED);
    const port = notionPort('Completed');
    const out = await actions(port).markCompleted(CARD);
    expect(out).toEqual({ outcome: 'already_completed', status: 'Completed', error: null });
    expect(port.setPageStatus).not.toHaveBeenCalled();
  });

  it('rewrites Complete to Completed when both options exist', async () => {
    ctx = makeCtx();
    seed(ctx, 'Complete', WITH_COMPLETED);
    const port = notionPort('Complete');
    const out = await actions(port).markCompleted(CARD);
    expect(out.outcome).toBe('updated');
    expect(port.setPageStatus).toHaveBeenCalledWith(CARD, prop, 'cd');
  });

  it('uses Complete when the workspace has no Completed option', async () => {
    ctx = makeCtx();
    seed(ctx, 'In Progress', ['In Progress', 'Complete', 'Ready to Test']);
    const port = notionPort('In Progress');
    vi.mocked(port.setPageStatus).mockResolvedValue(live('Complete'));
    const out = await actions(port).markCompleted(CARD);
    expect(out).toEqual({ outcome: 'updated', status: 'Complete', error: null });
    expect(port.setPageStatus).toHaveBeenCalledWith(CARD, prop, 'c');
  });

  it('reports a Notion failure and does not throw', async () => {
    ctx = makeCtx();
    seed(ctx, 'In Progress', WITH_COMPLETED);
    const port = notionPort('In Progress');
    vi.mocked(port.setPageStatus).mockRejectedValue(
      new NotionApiError('network', undefined, '/pages/x', 'down'),
    );
    const out = await actions(port).markCompleted(CARD);
    expect(out.outcome).toBe('failed');
    expect(out.error).toContain('network');
    expect(getCard(ctx.app, CARD)?.status).toBe('In Progress');
  });
});
