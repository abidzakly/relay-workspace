import { describe, expect, it, vi } from 'vitest';
import { CockpitSessionService } from './sessionService';

function make(pref: 'claude' | 'cursor') {
  const started: string[] = [];
  const opts: Record<string, unknown>[] = [];
  const live: unknown[] = [];
  const host = {
    sessions: async () => (started.length ? live : []),
    sessionStart: async (_ref: unknown, o: { kind: string }) => {
      started.push(o.kind);
      opts.push(o);
      const s = { id: 's1', kind: o.kind, workspaceId: 'w', state: 'running', waiting: false };
      live.push(s);
      return s;
    },
    wsCheckpoint: async () => ({ n: 1 }),
    sessionInput: vi.fn(async () => undefined),
  };
  const svc = new CockpitSessionService({
    host: host as never,
    workspaces: { ref: () => ({}) } as never,
    log: { warn: () => undefined, debug: () => undefined } as never,
    preferredAgent: () => pref,
    cursorBootMs: 0,
    pollMs: 3_600_000,
  });
  return { svc, started, opts };
}

describe('sendToAgent', () => {
  it.each(['claude', 'cursor'] as const)('starts a %s session when none runs', async (pref) => {
    const { svc, started } = make(pref);
    await svc.sendToAgent('w', 'fix it');
    expect(started).toEqual([pref]);
  });
});

describe('startPreferred models', () => {
  it('plans on Opus and switches to Sonnet (medium) on approval by default', async () => {
    const { svc, opts } = make('claude');
    await svc.startPreferred('w');
    expect(opts[0]).toMatchObject({
      kind: 'claude',
      model: 'claude-opus-5-5',
      execModel: 'claude-sonnet-5-5',
      execEffort: 'medium',
      execSwitch: 'ask',
    });
  });

  it('keeps a model the user picked: no switch, and Cursor never switches', async () => {
    const a = make('claude');
    await a.svc.startPreferred('w', { model: 'claude-haiku-5-5' });
    expect(a.opts[0]).toMatchObject({ model: 'claude-haiku-5-5' });
    expect(a.opts[0]).not.toHaveProperty('execModel', expect.anything());
    const b = make('claude');
    await b.svc.startPreferred('w', { kind: 'cursor' });
    expect(b.opts[0]).toMatchObject({ kind: 'cursor', model: 'composer-2.5-fast' });
    expect(b.opts[0]!.execModel).toBeUndefined();
  });
});
