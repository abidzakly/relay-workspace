import { spawnSync } from 'node:child_process';
import { launchSpec } from '../../util/platform';
import { runJsonCli } from './claudeCli';
import type { AiRunRequest } from './host';

/**
 * `cursor-agent -p` as the AI fallback when Claude fails (e.g. a usage limit). Ask mode is read-only: the prompt holds
 * untrusted diffs, and without it print mode has access to write and shell tools. `--trust` skips the workspace prompt,
 * which nobody can answer headless. The model is fixed here and for Cursor sessions.
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

export function runCursorCli(
  req: Pick<AiRunRequest, 'prompt' | 'timeoutMs'>,
): Promise<{ text: string }> {
  return runJsonCli(
    'cursor',
    CURSOR_BIN,
    ['-p', '--output-format', 'json', '--mode', 'ask', '--trust', '--model', CURSOR_MODEL],
    req,
  );
}
