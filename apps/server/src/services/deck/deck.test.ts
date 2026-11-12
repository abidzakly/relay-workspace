import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { deckCoverage, type DeckNote, type DiffFile } from '@relay/shared';
import { memDb, silentLog } from '../../testing/memDb';
import { AiService } from '../ai/aiService';
import type { AiCompleteRequest, AiProvider } from '../ai/provider';
import { heuristicTier, splitHunks, tierHunks } from './hunks';
import { buildCards, reanchorNotes, ReviewDeckService } from './reviewDeck';

const file = (path: string, diff: string): DiffFile => ({
  path,
  oldPath: null,
  kind: 'modified',
  diff,
  binary: false,
  tooLarge: false,
  collapsed: false,
  additions: 1,
  deletions: 1,
});

const LOGIC = file(
  'lib/login.dart',
  '@@ -1,3 +1,3 @@\n void a() {\n-  if (x) return;\n+  if (x == null) return;\n }\n@@ -10,2 +10,3 @@\n b();\n+c();\n d();\n',
);
const IMPORTS = file(
  'lib/main.dart',
  "@@ -1,2 +1,3 @@\n import 'a.dart';\n+import 'b.dart';\n x\n",
);
const GEN = file('lib/model.g.dart', '@@ -1 +1 @@\n-a\n+b\n');

describe('hunks', () => {
  it('splits per hunk with ids and counts', () => {
    const h = splitHunks([LOGIC, IMPORTS]);
    expect(h.map((x) => x.id)).toEqual(['0:0', '0:1', '1:0']);
    expect(h[0]).toMatchObject({ adds: 1, dels: 1, file: 'lib/login.dart' });
  });
  it('heuristics: generated, imports, whitespace → trivial; logic → open', () => {
    expect(heuristicTier({ file: GEN.path, text: '@@\n-a\n+b' })?.tier).toBe('trivial');
    expect(heuristicTier({ file: 'a.dart', text: "@@\n+import 'b.dart';" })?.tier).toBe('trivial');
    expect(heuristicTier({ file: 'a.dart', text: '@@\n-a(b,c)\n+a(b, c)' })?.tier).toBe('trivial');
    expect(heuristicTier({ file: 'a.dart', text: '@@\n-if (x)\n+if (x == null)' })).toBeNull();
  });
});

describe('cards', () => {
  it('bulk first, hunks, boss last; coverage counts bulk hunks', () => {
    const hunks = tierHunks(splitHunks([LOGIC, IMPORTS, GEN]), null);
    const cards = buildCards(hunks);
    expect(cards.map((c) => c.kind)).toEqual(['bulk', 'hunk', 'hunk', 'boss']);
    const bulk = cards[0]!;
    expect(bulk.kind === 'bulk' && bulk.hunkIds).toEqual(['1:0', '2:0']);
    const at = 1;
    expect(deckCoverage(cards, { cards: {} })).toBe(0);
    expect(
      deckCoverage(cards, { cards: { bulk: { verdict: 'understood', score: null, at } } }),
    ).toBeCloseTo(0.5);
  });
});

describe('reanchorNotes', () => {
  const note: DeckNote = {
    id: 'n1',
    file: 'lib/login.dart',
    hunkId: '0:0',
    lines: [2],
    text: 'cek null',
    status: 'saved',
    anchorText: '  if (x == null) return;',
    createdAt: 1,
  };
  it('moves a note to the new line when the anchor text is found', () => {
    const moved = file(
      'lib/login.dart',
      '@@ -5,3 +5,3 @@\n void a() {\n-  if (y) return;\n+  if (x == null) return;\n }\n',
    );
    const [n] = reanchorNotes([note], tierHunks(splitHunks([moved]), null));
    expect(n).toMatchObject({ lines: [6], status: 'saved' });
  });
  it('marks a note stale when the anchor is gone', () => {
    const [n] = reanchorNotes([note], tierHunks(splitHunks([IMPORTS]), null));
    expect(n!.status).toBe('stale');
  });
});

class Fake implements AiProvider {
  readonly engine = 'claude_cli' as const;
  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    const answers: Record<string, unknown> = {
      triage: { hunks: [{ id: '0:0', tier: 'critical', reason: 'null check', group: 'logic' }] },
      'quiz-cards': {
        cards: [
          {
            hunkId: '0:0',
            file: 'lib/login.dart',
            kind: 'predict',
            question: 'x null?',
            choices: ['return', 'crash'],
            answer: 'return',
            explanation: 'guard',
          },
        ],
      },
    };
    return Promise.resolve(req.schema.parse(answers[req.template]));
  }
}

describe('ReviewDeckService', () => {
  it('opens with AI triage + quiz, resumes, refuses early completion, completes once', async () => {
    const store = memDb();
    let awarded = 0;
    const svc = new ReviewDeckService({
      store,
      log: silentLog,
      ai: new AiService({ store, log: silentLog, host: null, providers: [new Fake()] }),
      readDiff: async () => ({
        title: 't',
        subtitle: 's',
        files: [LOGIC, IMPORTS],
        truncated: false,
        card: null,
        agentTarget: null,
      }),
      award: () => (awarded += 8),
    });
    const source = { kind: 'mr' as const, repoId: 'app', iid: 1 };
    const d = await svc.open(source);
    expect(d.ai).toMatchObject({ triage: 'ai', quiz: 'ai' });
    expect(d.cards.map((c) => c.kind)).toEqual(['bulk', 'hunk', 'quiz', 'hunk', 'boss']);
    expect(() => svc.complete(d.deckId)).toThrow('Every hunk');
    const at = 1;
    const v = { verdict: 'understood' as const, score: null, at };
    svc.saveState(d.deckId, { cursor: 4, cards: { bulk: v, 'h:0:0': v, 'h:0:1': v } });
    const again = await svc.open(source);
    expect(again.state.cursor).toBe(4);
    expect(svc.complete(d.deckId).xpAwarded).toBe(8);
    expect(svc.complete(d.deckId).xpAwarded).toBe(0);
  });

  it('force-push drops old progress and notes; manual rebuild resets too', async () => {
    const store = memDb();
    let files = [LOGIC, IMPORTS];
    let head = 'old';
    const svc = new ReviewDeckService({
      store,
      log: silentLog,
      ai: new AiService({ store, log: silentLog, host: null, providers: [new Fake()] }),
      readDiff: async () => ({
        title: 't',
        subtitle: 's',
        files,
        truncated: false,
        headSha: head,
        card: null,
        agentTarget: null,
      }),
      // `old` was replaced by `new`: each side has commits the other lacks.
      readCommits: async (_repo, from, to) => ({
        commits: [{ id: `${from}>${to}`, message: 'wip' }],
        truncated: false,
      }),
    });
    const source = { kind: 'mr' as const, repoId: 'app', iid: 1 };
    const d = await svc.open(source);
    const v = { verdict: 'understood' as const, score: null, at: 1 };
    svc.saveState(d.deckId, { cursor: 2, cards: { bulk: v, 'h:0:0': v } });
    head = 'new';
    files = [LOGIC, GEN];
    const again = await svc.open(source);
    expect(again.rebuilt).toBe('rewritten');
    expect(again.state.cards).toEqual({});

    const manual = await svc.open(source, { rebuild: true });
    expect(manual.rebuilt).toBe('manual');
    expect(manual.state.cursor).toBe(0);
  });

  it('local deck: next step, and its review counts for the Create MR gate', async () => {
    const store = memDb();
    const reviewed: string[] = [];
    let iid: number | null = null;
    const svc = new ReviewDeckService({
      store,
      log: silentLog,
      ai: new AiService({ store, log: silentLog, host: null, providers: [new Fake()] }),
      readDiff: async () => ({
        title: 't',
        subtitle: 's',
        files: [LOGIC],
        truncated: false,
        card: null,
        agentTarget: null,
      }),
      localBranch: async () => ({ repoId: 'app', branch: 'feat/x', head: 'abc' }),
      repoOfWorkspace: () => 'app',
      openMrOf: () => iid,
      onLocalReviewed: (ws, base) => reviewed.push(`${ws}:${base}`),
    });
    const source = { kind: 'local' as const, workspaceId: 'w1', mode: 'turn' as const, base: '3' };
    const d = await svc.open(source);
    expect((await svc.status(d.deckId)).next).toEqual({
      kind: 'create_mr',
      repoId: 'app',
      branch: 'feat/x',
    });
    iid = 7;
    expect((await svc.status(d.deckId)).next).toEqual({ kind: 'open_mr', repoId: 'app', iid: 7 });

    const gate = { files: [LOGIC], headSha: 'abc' };
    const compare = { kind: 'compare' as const, repoId: 'app', from: 'main', to: 'feat/x' };
    expect(await svc.branchReview(compare, gate)).toEqual({ reviewed: false, stale: false });

    const v = { verdict: 'understood' as const, score: null, at: 1 };
    svc.saveState(d.deckId, {
      cursor: d.cards.length,
      cards: Object.fromEntries(d.cards.map((c) => [c.id, v])),
    });
    svc.complete(d.deckId);
    await new Promise((r) => setTimeout(r, 10));
    expect(reviewed).toEqual(['w1:3']);
    expect(await svc.branchReview(compare, gate)).toEqual({ reviewed: true, stale: false });
    expect((await svc.branchReview(compare, { ...gate, headSha: 'def' })).reviewed).toBe(false);
  });
});
