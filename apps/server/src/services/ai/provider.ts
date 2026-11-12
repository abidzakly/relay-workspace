import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { AI_JSON_INSTRUCTION, type AiEngine, type AiTemplate } from '@relay/shared';
import { CURSOR_MODEL } from '../cockpit/cursorCli';
import type { CockpitHost } from '../cockpit/host';

/**
 * AI engines. One interface:
 *  - `ClaudeCliProvider`: `claude -p` on the Mac through the cockpit host (the user's subscription, no API key).
 *  - `AnthropicApiProvider`: fallback with `ANTHROPIC_API_KEY` (structured outputs, zod-validated).
 *  - `CursorCliProvider`: `cursor-agent -p` on the Mac, tried when Claude fails (e.g. a usage limit).
 * `tier`: `fast` (Haiku) for generated review and MR text, `default` (Opus) for the prompt a coding agent will act on.
 */

export const AI_MODELS = { default: 'claude-opus-5-5', fast: 'claude-haiku-5-5' } as const;
export type AiTier = keyof typeof AI_MODELS;

export interface AiCompleteRequest<S extends z.ZodType> {
  template: AiTemplate;
  prompt: string;
  schema: S;
  tier: AiTier;
  /** Overrides the built-in model for this engine. */
  model?: string | undefined;
}

export class AiError extends Error {
  constructor(
    readonly code: 'ai_unavailable' | 'ai_bad_output' | 'ai_failed' | 'ai_refused',
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiProvider {
  readonly engine: AiEngine;
  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>>;
}

function jsonObjectIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start)
    throw new AiError('ai_bad_output', 'the answer had no JSON object');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('ai_bad_output', 'the answer was not valid JSON');
  }
}

/**
 * The JSON object in a text answer (tolerates ```json fences and prose around it). Exported for tests. The whole text
 * goes first, because a string inside the object can hold a code fence of its own; a fence only decides when prose
 * around it has braces too.
 */
export function extractJson(text: string): unknown {
  try {
    return jsonObjectIn(text);
  } catch (e) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (!fenced) throw e;
    return jsonObjectIn(fenced[1]!);
  }
}

/** A headless CLI on the host: no structured outputs, so the schema goes in the prompt and the answer is validated. */
async function completeOnHost<S extends z.ZodType>(
  host: CockpitHost,
  req: AiCompleteRequest<S>,
  run: { engine: 'claude' | 'cursor'; model: string; timeoutMs: number },
): Promise<z.infer<S>> {
  const schema = JSON.stringify(z.toJSONSchema(req.schema));
  const prompt = `${req.prompt}

${AI_JSON_INSTRUCTION}
${schema}`;
  const { text } = await host.ai({
    prompt,
    ...run,
    ...(run.engine === 'claude' ? { effort: req.tier === 'fast' ? 'low' : 'medium' } : {}),
  });
  const parsed = req.schema.safeParse(extractJson(text));
  if (!parsed.success) throw new AiError('ai_bad_output', 'the answer did not match the schema');
  return parsed.data as z.infer<S>;
}

export class ClaudeCliProvider implements AiProvider {
  readonly engine = 'claude_cli' as const;
  constructor(
    private readonly host: CockpitHost,
    private readonly timeoutMs = 180_000,
  ) {}

  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    return completeOnHost(this.host, req, {
      engine: 'claude',
      model: req.model ?? AI_MODELS[req.tier],
      timeoutMs: this.timeoutMs,
    });
  }
}

export class CursorCliProvider implements AiProvider {
  readonly engine = 'cursor_cli' as const;
  constructor(
    private readonly host: CockpitHost,
    private readonly timeoutMs = 180_000,
  ) {}

  complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    return completeOnHost(this.host, req, {
      engine: 'cursor',
      model: req.model ?? CURSOR_MODEL,
      timeoutMs: this.timeoutMs,
    });
  }
}

export class AnthropicApiProvider implements AiProvider {
  readonly engine = 'anthropic_api' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete<S extends z.ZodType>(req: AiCompleteRequest<S>): Promise<z.infer<S>> {
    let res;
    try {
      res = await this.client.messages.parse({
        model: req.model ?? AI_MODELS[req.tier],
        max_tokens: 16000,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: {
          format: zodOutputFormat(req.schema as unknown as z.ZodObject),
          effort: req.tier === 'fast' ? 'low' : 'medium',
        },
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        throw new AiError('ai_unavailable', 'ANTHROPIC_API_KEY was rejected');
      }
      if (e instanceof Anthropic.RateLimitError) throw new AiError('ai_failed', 'rate limited');
      if (e instanceof Anthropic.APIError) throw new AiError('ai_failed', `API error ${e.status}`);
      throw new AiError('ai_failed', 'the Anthropic API could not be reached');
    }
    if (res.stop_reason === 'refusal') throw new AiError('ai_refused', 'the model declined');
    const parsed = req.schema.safeParse(res.parsed_output);
    if (!parsed.success) throw new AiError('ai_bad_output', 'the answer did not match the schema');
    return parsed.data as z.infer<S>;
  }
}
