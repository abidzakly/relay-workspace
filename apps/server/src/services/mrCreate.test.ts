import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { MR_CHAT_MAX_HISTORY, MrChatRequestSchema } from '@relay/shared';
import { AuditWriter } from '../audit/auditLog';
import { cards } from '../db/schema';
import { memDb, silentLog } from '../testing/memDb';
import { AiService } from './ai/aiService';
import type { AiCompleteRequest, AiProvider } from './ai/provider';
import { renderTemplate } from './ai/templates';
import type { MrFields } from './gitlabMr';
import { GitlabReleaseApi } from './gitlabRelease';
import { GitlabService } from './gitlabService';
import { MrCreateService, renderChatHistory, renderSummary, type MrCreateDeps } from './mrCreate';

const CARD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CREATED_MR = {
  iid: 12,
  gitlabId: 99,
  title: 'feat/weather',
  state: 'opened',
  draft: false,
  hasConflicts: null,
  mergeStatus: null,
  sourceBranch: 'feat/weather',
  targetBranch: 'main',
  author: 'me',
  assignees: ['me'],
  reviewers: [],
  webUrl: 'https://gitlab.example/mr/12',
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
  descriptionNotionId: null,
} as unknown as MrFields;

const summary = { summary: 'Menghapus weather setting.', bullets: ['Hapus field'], risks: [] };
const request = {
  repo: 'vessel-monitoring',
  branch: 'Feedback/CRD-1/Weather',
  summary,
  history: [],
  question: ' Apa risikonya? ',
};

describe('renderChatHistory', () => {
  it('labels each speaker in order', () => {
    expect(
      renderChatHistory([
        { role: 'user', text: 'Kenapa?' },
        { role: 'assistant', text: 'Karena X.' },
      ]),
    ).toBe('User: Kenapa?\n\nAsisten: Karena X.');
  });
  it('says so when there is no history', () => {
    expect(renderChatHistory([])).toBe('(belum ada)');
  });
  it('keeps the newest part when too long', () => {
    const out = renderChatHistory([
      { role: 'user', text: 'lama'.repeat(5_000) },
      { role: 'assistant', text: 'x'.repeat(20_000) },
      { role: 'user', text: 'x'.repeat(20_000) },
      { role: 'assistant', text: 'terbaru' },
    ]);
    expect(out).toHaveLength(30_000);
    expect(out.endsWith('terbaru')).toBe(true);
    expect(out).not.toContain('lama');
  });
});

describe('renderSummary', () => {
  it('lists bullets and leaves out empty sections', () => {
    expect(renderSummary(summary)).toBe('Menghapus weather setting.\nPoin:\n- Hapus field');
  });
  it('includes risks', () => {
    expect(renderSummary({ summary: 'S', bullets: [], risks: ['R'] })).toBe('S\nRisiko:\n- R');
  });
});

describe('MrChatRequestSchema', () => {
  it('trims the question', () => {
    expect(MrChatRequestSchema.parse(request).question).toBe('Apa risikonya?');
  });
  it('refuses an empty question, unknown fields and too much history', () => {
    expect(MrChatRequestSchema.safeParse({ ...request, question: '   ' }).success).toBe(false);
    expect(MrChatRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
    const history = Array.from({ length: MR_CHAT_MAX_HISTORY + 1 }, () => ({
      role: 'user',
      text: 'q',
    }));
    expect(MrChatRequestSchema.safeParse({ ...request, history }).success).toBe(false);
  });
});

class RecordingProvider implements AiProvider {
  readonly engine = 'claude_cli' as const;
  prompts: string[] = [];
  constructor(private readonly answer: unknown) {}
  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    this.prompts.push(req.prompt);
    return Promise.resolve(req.schema.parse(this.answer));
  }
}

describe('MrCreateService.chat', () => {
  afterEach(() => vi.restoreAllMocks());

  const service = (provider?: AiProvider) => {
    const store = memDb();
    vi.spyOn(GitlabService, 'forRepo').mockReturnValue({
      compare: () =>
        Promise.resolve({ files: [{ path: 'lib/weather.dart', diff: '-final bool weather;' }] }),
    } as unknown as GitlabService);
    return new MrCreateService({
      store,
      log: silentLog,
      config: { getRepo: () => ({ baseBranch: 'main' }) },
      ...(provider
        ? { ai: new AiService({ store, log: silentLog, host: null, providers: [provider] }) }
        : {}),
    } as unknown as MrCreateDeps);
  };

  it('asks with the live diff, the summary and the conversation', async () => {
    const provider = new RecordingProvider({ answer: 'Field dihapus.' });
    const out = await service(provider).chat({
      repo: 'vessel',
      branch: 'feat/x',
      summary,
      history: [{ role: 'user', text: 'Pertanyaan pertama' }],
      question: 'Apa risikonya?',
    });
    expect(out).toEqual({ answer: 'Field dihapus.' });
    const prompt = provider.prompts[0]!;
    for (const part of [
      'Apa risikonya?',
      'User: Pertanyaan pertama',
      'Menghapus weather setting.',
      '### lib/weather.dart\n-final bool weather;',
    ]) {
      expect(prompt).toContain(part);
    }
  });

  it('rejects an empty answer', async () => {
    const chat = service(new RecordingProvider({ answer: '  ' })).chat({
      repo: 'vessel',
      branch: 'feat/x',
      summary,
      history: [],
      question: 'Apa?',
    });
    await expect(chat).rejects.toMatchObject({ code: 'ai_bad_output' });
  });

  it('reports when no AI is configured', async () => {
    const chat = service().chat({
      repo: 'vessel',
      branch: 'feat/x',
      summary,
      history: [],
      question: 'Apa?',
    });
    await expect(chat).rejects.toMatchObject({ code: 'ai_unavailable' });
  });
});

describe('mr-chat template', () => {
  it('fills every placeholder and fences the question', () => {
    const p = renderTemplate('mr-chat', {
      question: 'Q1',
      history: 'H1',
      summary: 'S1',
      card: 'C1',
      diff: 'D1',
    });
    expect(p).toContain('<data>\nQ1\n</data>');
    for (const v of ['H1', 'S1', 'C1', 'D1']) expect(p).toContain(v);
    expect(p).not.toMatch(/\{\{[a-z]+\}\}/);
  });
});

describe('MrCreateService.create notion status', () => {
  afterEach(() => vi.restoreAllMocks());

  const harness = (dry: boolean) => {
    const store = memDb();
    store.db
      .insert(cards)
      .values({
        id: CARD,
        title: 'Weather',
        status: 'In Progress',
        url: 'https://www.notion.so/weather',
        branchName: 'feat/weather',
        lastEditedAt: 1,
        syncedAt: 1,
      })
      .run();
    const markCompleted = vi.fn();
    vi.spyOn(GitlabService, 'forRepo').mockReturnValue({
      compare: () => Promise.resolve({ commits: [{ id: 'abc' }], commitCount: 1, files: [] }),
      listOpenMrsInto: () => Promise.resolve({ mrs: [] }),
      syncMr: () => Promise.resolve(),
    } as unknown as GitlabService);
    vi.spyOn(GitlabReleaseApi.prototype, 'findUserId').mockResolvedValue(7);
    vi.spyOn(GitlabReleaseApi.prototype, 'createMr').mockResolvedValue(CREATED_MR);
    const svc = new MrCreateService({
      store,
      audit: new AuditWriter(store),
      log: silentLog,
      http: {},
      config: {
        getRepo: () => ({
          baseBranch: 'main',
          gitlab: { token: 't', projectId: 9 },
          reviewers: [],
        }),
        getGlobal: () => ({ gitlab: { host: 'https://gitlab.example', myUsername: 'me' } }),
        isDryRun: () => dry,
      },
      branchHeads: () => [],
      markCompleted,
    } as unknown as MrCreateDeps);
    return { svc, markCompleted };
  };

  const req = {
    repoId: 'vessel',
    branch: 'feat/weather',
    skipReviewReason: 'deck skipped',
  };

  it('sets the Notion card after the MR exists', async () => {
    const { svc, markCompleted } = harness(false);
    markCompleted.mockResolvedValue({ outcome: 'updated', status: 'Completed', error: null });
    const out = await svc.create(req);
    expect(markCompleted).toHaveBeenCalledWith(CARD);
    expect(out.iid).toBe(12);
    expect(out.notion).toEqual({ outcome: 'updated', status: 'Completed', error: null });
  });

  it('keeps the MR when Notion fails', async () => {
    const { svc, markCompleted } = harness(false);
    markCompleted.mockRejectedValue(new Error('notion down'));
    const out = await svc.create(req);
    expect(out.iid).toBe(12);
    expect(out.notion).toEqual({
      outcome: 'failed',
      status: 'In Progress',
      error: 'notion down',
    });
  });

  it('does not touch Notion in a dry run', async () => {
    const { svc, markCompleted } = harness(true);
    const out = await svc.create(req);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(out.dryRun).toBe(true);
    expect(out.notion).toBeNull();
  });
});
