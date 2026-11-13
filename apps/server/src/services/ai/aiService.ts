import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AI_OUTPUT_SCHEMAS,
  aiOutputProblem,
  buildTestResult,
  type Check,
  type ConnectionTestResult,
  type AiEngine,
  type AiEngineStatus,
  type AiModels,
  type AiGeneratedBy,
  type AiOutput,
  type AiPrompts,
  type AiTemplate,
} from '@relay/shared';
import type { AppDb } from '../../db';
import { aiCache } from '../../db/schema';
import type { Logger } from '../../util/logger';
import { CURSOR_MODEL } from '../cockpit/cursorCli';
import type { CockpitHost } from '../cockpit/host';
import {
  AI_MODELS,
  AiError,
  AnthropicApiProvider,
  ClaudeCliProvider,
  CursorCliProvider,
  type AiProvider,
  type AiTier,
} from './provider';
import { renderTemplate } from './templates';

/**
 * The one entry point for AI: picks the engine (Claude CLI first, API key fallback), falls
 * back to the Cursor CLI when Claude fails, renders the template, validates the output with zod + range checks, and
 * caches answers in `ai_cache`.
 */

export interface AiServiceDeps {
  store: AppDb;
  log: Logger;
  /** null = no cockpit host (CLI engine off). */
  host: CockpitHost | null;
  apiKey?: string | undefined;
  /** Per-feature agent/model choice from Settings; read on every run so edits apply at once. */
  models?: () => AiModels;
  /** Prompt overrides from Settings > AI prompts; read on every run. */
  prompts?: () => AiPrompts;
  now?: () => number;
  /** Tests inject providers. */
  providers?: AiProvider[];
}

/** How long an engine that failed is asked last. */
const ENGINE_COOLDOWN_MS = 5 * 60_000;

const DEFAULT_TIER: Record<AiTemplate, AiTier> = {
  triage: 'fast',
  'turn-summary': 'fast',
  'quiz-cards': 'fast',
  'explain-hunk': 'fast',
  'grade-teachback': 'fast',
  'request-change': 'default',
  'request-change-batch': 'default',
  'mr-summary': 'fast',
  'mr-chat': 'fast',
  'base-suggest': 'fast',
  'explain-thread': 'default',
};

export class AiService {
  private readonly cli: ClaudeCliProvider | null;
  private readonly api: AnthropicApiProvider | null;
  private readonly cursor: CursorCliProvider | null;
  private cliOk: { ok: boolean; cursorOk: boolean; reason: string | null; at: number } | null =
    null;
  /**
   * Engines that just failed (a spent usage limit, a timeout), skipped until this time while another engine can answer.
   * Without it, every AI action waited for the failing engine to give up before the next one was asked.
   */
  private readonly cooling = new Map<AiEngine, number>();

  constructor(private readonly d: AiServiceDeps) {
    this.cli = d.host ? new ClaudeCliProvider(d.host) : null;
    this.cursor = d.host ? new CursorCliProvider(d.host) : null;
    this.api = d.apiKey ? new AnthropicApiProvider(d.apiKey) : null;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Engine in use. The CLI check is cached for a minute. */
  async status(): Promise<AiEngineStatus> {
    const [p] = await this.chain();
    if (p) return { engine: p.engine, reason: null };
    return { engine: 'none', reason: this.cliOk?.reason ?? 'no AI engine configured' };
  }

  /**
   * "Test AI connection": a real one-line round trip to each engine, so a spent usage limit shows up here and not
   * only when a deck fails. Bypasses the health caches; changes nothing and is not cached.
   */
  async test(): Promise<ConnectionTestResult> {
    const t = this.now();
    const host = this.d.host;
    const ping = z.object({ ok: z.literal(true) });
    const timed = async (
      run: () => Promise<unknown>,
    ): Promise<{ ms: number; error: string | null }> => {
      const start = Date.now();
      try {
        await run();
        return { ms: Date.now() - start, error: null };
      } catch (e) {
        return { ms: Date.now() - start, error: (e as Error).message };
      }
    };
    const check = (
      id: string,
      label: string,
      r: { ms: number; error: string | null },
      hint: string,
    ): Check =>
      r.error === null
        ? {
            id,
            group: 'ai',
            label,
            status: 'pass',
            message: `Answered in ${(r.ms / 1000).toFixed(1)} s.`,
          }
        : { id, group: 'ai', label, status: 'fail', message: r.error, hint };
    const skip = (id: string, label: string, message: string, hint?: string): Check => ({
      id,
      group: 'ai',
      label,
      status: 'skip',
      message,
      ...(hint ? { hint } : {}),
    });
    const prompt = 'Reply with the text ok, nothing else.';

    const checks: Check[] = [];
    let claudeOk = false;
    let cursorOk = false;
    if (!host) {
      checks.push(
        skip(
          'ai.host',
          'Mac host',
          'No cockpit host: the Claude and Cursor CLIs are off.',
          'Run `pnpm agent` on the Mac.',
        ),
      );
    } else {
      let health;
      try {
        health = await host.health(true);
        this.cliOk = {
          ok: health.claude.available,
          cursorOk: health.cursor?.available ?? false,
          reason: health.claude.reason,
          at: this.now(),
        };
        checks.push({
          id: 'ai.host',
          group: 'ai',
          label: 'Mac host',
          status: 'pass',
          message: 'Reachable.',
        });
      } catch (e) {
        this.cliOk = null;
        checks.push({
          id: 'ai.host',
          group: 'ai',
          label: 'Mac host',
          status: 'fail',
          message: (e as Error).message,
          hint: 'Run `pnpm agent` on the Mac.',
        });
      }
      if (health) {
        const runs = await Promise.all([
          health.claude.available
            ? timed(() =>
                host.ai({ prompt, model: AI_MODELS.fast, timeoutMs: 45_000, engine: 'claude' }),
              )
            : null,
          health.cursor?.available
            ? timed(() =>
                host.ai({ prompt, model: CURSOR_MODEL, timeoutMs: 45_000, engine: 'cursor' }),
              )
            : null,
        ]);
        if (runs[0]) {
          checks.push(
            check(
              'ai.claude',
              'Claude CLI',
              runs[0],
              'Often a spent usage limit or a logged-out CLI; run `claude` on the Mac. Cursor takes over meanwhile.',
            ),
          );
          claudeOk = runs[0].error === null;
        } else {
          checks.push(
            skip(
              'ai.claude',
              'Claude CLI',
              health.claude.reason ?? 'Not available.',
              'Install and log in to the Claude CLI on the Mac.',
            ),
          );
        }
        if (runs[1]) {
          checks.push(
            check(
              'ai.cursor',
              'Cursor CLI',
              runs[1],
              'Log in with `cursor-agent login` on the Mac.',
            ),
          );
          cursorOk = runs[1].error === null;
        } else {
          checks.push(
            skip(
              'ai.cursor',
              'Cursor CLI',
              health.cursor?.reason ?? 'The host agent is too old to report Cursor.',
              'Install the Cursor CLI, or restart `pnpm agent` after updating.',
            ),
          );
        }
      }
    }
    let apiOk = false;
    if (this.api) {
      const r = await timed(() =>
        this.api!.complete({
          template: 'triage',
          prompt: 'Reply with {"ok": true}',
          schema: ping,
          tier: 'fast',
        }),
      );
      checks.push(
        check(
          'ai.api',
          'Anthropic API key',
          r,
          'Check ANTHROPIC_API_KEY, its credit, and the rate limit.',
        ),
      );
      apiOk = r.error === null;
    } else {
      checks.push(skip('ai.api', 'Anthropic API key', 'ANTHROPIC_API_KEY is not set (optional).'));
    }

    // What the user cares about: does an AI action get an answer, and from whom.
    const primary = claudeOk || apiOk;
    checks.push(
      primary
        ? {
            id: 'ai.fallback',
            group: 'ai',
            label: 'AI actions',
            status: 'pass',
            message: cursorOk
              ? `Answered by ${claudeOk ? 'Claude' : 'the API'}; Cursor is the fallback.`
              : `Answered by ${claudeOk ? 'Claude' : 'the API'}; no fallback (Cursor is down).`,
          }
        : cursorOk
          ? {
              id: 'ai.fallback',
              group: 'ai',
              label: 'AI actions',
              status: 'warn',
              message: 'Claude is down: AI actions fall back to Cursor (composer, not Opus/Haiku).',
              hint: 'Fix Claude to get the Claude models back.',
            }
          : {
              id: 'ai.fallback',
              group: 'ai',
              label: 'AI actions',
              status: 'fail',
              message: 'No engine answers: decks fall back to heuristics, AI actions fail.',
              hint: 'Fix at least one of the engines above.',
            },
    );
    return buildTestResult(checks, t);
  }

  /** Engines to try, in order: Claude (CLI, else API key), then Cursor. */
  private async chain(): Promise<AiProvider[]> {
    if (this.d.providers) return this.d.providers;
    if (this.d.host && (!this.cliOk || this.now() - this.cliOk.at > 60_000)) {
      try {
        const h = await this.d.host.health();
        this.cliOk = {
          ok: h.claude.available,
          cursorOk: h.cursor?.available ?? false,
          reason: h.claude.reason,
          at: this.now(),
        };
      } catch (e) {
        this.cliOk = { ok: false, cursorOk: false, reason: (e as Error).message, at: this.now() };
      }
    }
    const claude = this.cli && this.cliOk?.ok ? this.cli : this.api;
    const cursor = this.cliOk?.cursorOk ? this.cursor : null;
    return [claude, cursor].filter((p) => p !== null);
  }

  /**
   * Runs a template. `vars` are fenced into the prompt. Cached unless `fresh` (e.g. "Ask again" with a new question
   * is a different prompt anyway; `fresh` is for a deliberate re-roll).
   */
  async run<T extends AiTemplate>(
    template: T,
    vars: Readonly<Record<string, string>>,
    opts: { tier?: AiTier; fresh?: boolean } = {},
  ): Promise<{ output: AiOutput<T>; cached: boolean; engine: string; generatedBy: AiGeneratedBy }> {
    const tier = opts.tier ?? DEFAULT_TIER[template];
    const models = this.d.models?.() ?? {};
    const choice = models[template] ?? models.default ?? {};
    // The chosen model applies to the chosen agent; with no agent chosen, to the Claude engines.
    const modelFor = (engine: AiEngine): string =>
      (choice.model && (choice.engine ? choice.engine === engine : engine !== 'cursor_cli')
        ? choice.model
        : undefined) ?? (engine === 'cursor_cli' ? CURSOR_MODEL : AI_MODELS[tier]);
    const by = (engine: AiEngine): AiGeneratedBy => ({ engine, model: modelFor(engine) });
    const prompt = renderTemplate(template, vars, this.d.prompts?.()[template]);
    // Automatic choice keeps the original key (Claude's model). A pinned engine keys on that engine and its model, so
    // a pinned Cursor answer is cached too and never mixed up with a Claude one.
    const keyModel = choice.engine
      ? `${choice.engine}:${modelFor(choice.engine)}`
      : modelFor('claude_cli');
    const key = createHash('sha256').update(`${template}\n${keyModel}\n${prompt}`).digest('hex');
    if (!opts.fresh) {
      const hit = this.d.store.db.select().from(aiCache).where(eq(aiCache.key, key)).get();
      if (hit) {
        const p = AI_OUTPUT_SCHEMAS[template].safeParse(hit.value);
        if (p.success) {
          return {
            output: p.data as AiOutput<T>,
            cached: true,
            engine: hit.engine,
            generatedBy: by(hit.engine as AiEngine),
          };
        }
      }
    }
    const chained = [...(await this.chain())];
    if (choice.engine)
      chained.sort((a, b) => +(b.engine === choice.engine) - +(a.engine === choice.engine));
    // A cooling engine goes last, so it is asked only when nothing else answers.
    const now = this.now();
    const cool = (p: AiProvider) => (this.cooling.get(p.engine) ?? 0) > now;
    const providers = [...chained.filter((p) => !cool(p)), ...chained.filter(cool)];
    if (providers.length === 0) {
      throw new AiError(
        'ai_unavailable',
        'No AI engine: install/login the Claude or Cursor CLI on the Mac, or set ANTHROPIC_API_KEY.',
      );
    }
    const schema = AI_OUTPUT_SCHEMAS[template];
    let failure: unknown;
    for (const provider of providers) {
      const started = this.now();
      let output: AiOutput<T>;
      try {
        output = (await provider.complete({
          template,
          prompt,
          schema,
          tier,
          model: modelFor(provider.engine),
        })) as AiOutput<T>;
        const problem = aiOutputProblem(template, output);
        if (problem) throw new AiError('ai_bad_output', problem);
      } catch (e) {
        // A refusal is the model's decision, not an outage: it is not routed around.
        if (e instanceof AiError && e.code === 'ai_refused') throw e;
        failure = e;
        // Bad output is about this answer, not the engine; anything else cools the engine for a while.
        if (!(e instanceof AiError && e.code === 'ai_bad_output')) {
          this.cooling.set(provider.engine, this.now() + ENGINE_COOLDOWN_MS);
        }
        this.d.log.warn(
          { engine: provider.engine, template, err: (e as Error).message },
          'ai engine failed',
        );
        continue;
      }
      this.d.log.info(
        { engine: provider.engine, template, promptChars: prompt.length, ms: this.now() - started },
        'ai run',
      );
      this.cooling.delete(provider.engine);
      // A Cursor fallback is not cached: the same prompt gets Opus again once Claude is back. Cursor chosen in
      // Settings is the answer the user wants, so it is.
      if (provider.engine !== 'cursor_cli' || choice.engine === 'cursor_cli')
        this.remember(key, template, provider.engine, output);
      return { output, cached: false, engine: provider.engine, generatedBy: by(provider.engine) };
    }
    throw failure;
  }

  private remember(key: string, template: AiTemplate, engine: string, value: unknown): void {
    try {
      this.d.store.db
        .insert(aiCache)
        .values({ key, template, engine, value, createdAt: this.now() })
        .onConflictDoUpdate({
          target: aiCache.key,
          set: { value, engine, createdAt: this.now() },
        })
        .run();
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'ai cache write failed');
    }
  }
}
