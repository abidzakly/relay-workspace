import { spawnSync } from 'node:child_process';
import { launchSpec } from '../../util/platform';
import { runJsonCli } from './claudeCli';
import type { AiRunRequest } from './host';

/**
 * `cursor-agent -p` as the AI fallback when Claude fails (e.g. a usage limit). Ask mode is read-only: the prompt holds
 * untrusted diffs, and without it print mode has access to write and shell tools. `--trust` skips the workspace prompt,
 * which nobody can answer headless. The model comes from Settings > AI (default `CURSOR_MODEL`).
 */

export const CURSOR_BIN = process.env.CURSOR_BIN?.trim() || 'cursor-agent';
export const CURSOR_MODEL = 'composer-2.5-fast';

let cached: { available: boolean; reason: string | null } | undefined;

export function cursorAvailability(refresh = false): { available: boolean; reason: string | null } {
  if (refresh) cached = undefined;
  if (cached) return cached;
  const l = launchSpec(CURSOR_BIN, ['--version']);
  const r = spawnSync(l.file, l.args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsVerbatimArguments: l.windowsVerbatimArguments,
  });
  cached =
    r.status === 0
      ? { available: true, reason: null }
      : {
          available: false,
          reason: `${CURSOR_BIN} --version failed (is the Cursor CLI installed?)`,
        };
  return cached;
}

/**
 * Composer reaches for its tools (glob, read) even in an empty folder, and every tool call is another model round
 * trip. The prompt already holds all the data, so it is told not to.
 */
const NO_TOOLS =
  'Answer directly from this message: everything you need is in it. Do NOT call any tools (no file reads, searches or shell).\n\n';

/** The model from Settings > AI when it is a valid id, else the built-in one. */
export function cursorModel(model: string | undefined): string {
  return model && /^[a-z0-9.-]{1,64}$/i.test(model) ? model : CURSOR_MODEL;
}

export function runCursorCli(
  req: Pick<AiRunRequest, 'prompt' | 'timeoutMs'> & { model?: string | undefined },
): Promise<{ text: string }> {
  return runJsonCli(
    'cursor',
    CURSOR_BIN,
    [
      '-p',
      '--output-format',
      'json',
      '--mode',
      'ask',
      '--trust',
      '--model',
      cursorModel(req.model),
    ],
    { ...req, prompt: NO_TOOLS + req.prompt },
  );
}
