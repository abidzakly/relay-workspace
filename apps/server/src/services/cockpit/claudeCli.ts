import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchSpec } from '../../util/platform';
import { CockpitHostError, type AiRunRequest } from './host';

/**
 * `claude -p --output-format json --model <m>` with the prompt on stdin. Uses the
 * user's existing Claude subscription: no API key. Runs in an empty folder so no project CLAUDE.md steers the answer.
 * The JSON envelope's `result` is the model's final text.
 */

export const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || 'claude';
/** The model an agent session starts on, to work on tasks. The session's model picker can still change it. */
export const CLAUDE_SESSION_MODEL = 'claude-opus-5-5';
const MAX_OUTPUT = 4 * 1024 * 1024;

let cached: { available: boolean; reason: string | null } | undefined;

export function claudeAvailability(refresh = false): { available: boolean; reason: string | null } {
  if (refresh) cached = undefined;
  if (cached) return cached;
  const l = launchSpec(CLAUDE_BIN, ['--version']);
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
          reason: `${CLAUDE_BIN} --version failed (is the Claude CLI installed?)`,
        };
  return cached;
}

/** Envelope `{ result, is_error }` → text (Claude and Cursor print the same one). Exported for tests. */
export function parseClaudeEnvelope(stdout: string, name = 'claude'): string {
  let env: unknown;
  try {
    env = JSON.parse(stdout);
  } catch {
    throw new CockpitHostError('ai_bad_output', `${name} did not print JSON`);
  }
  const e = env as { result?: unknown; is_error?: unknown; subtype?: unknown };
  if (e.is_error === true) {
    // The CLI puts the cause (e.g. "You've hit your limit") in `result`; keep a short, single-line piece of it.
    const why =
      typeof e.result === 'string' ? e.result.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    throw new CockpitHostError(
      'ai_failed',
      `${name} reported an error${typeof e.subtype === 'string' ? ` (${e.subtype})` : ''}${why ? `: ${why}` : ''}`,
    );
  }
  if (typeof e.result !== 'string') throw new CockpitHostError('ai_bad_output', 'no result text');
  return e.result;
}

/**
 * A one-shot answer, not an agent session: no tools, no MCP servers, no user settings (hooks, plugins), no saved
 * session, and a one-line system prompt in place of Claude Code's own. Measured on a short prompt: about half the time
 * and a few hundred context tokens instead of about 30 000. Login (the subscription) is unaffected.
 */
const LEAN_ARGS = [
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--system-prompt',
  'You are a precise assistant for code review and merge requests. Follow the user message exactly.',
];

export function runClaudeCli(req: AiRunRequest): Promise<{ text: string }> {
  if (!/^[a-z0-9.-]{1,64}$/.test(req.model)) {
    return Promise.reject(new CockpitHostError('ai_bad_model', 'invalid model id', 422));
  }
  const effort = req.effort ? ['--effort', req.effort] : [];
  return runJsonCli(
    'claude',
    CLAUDE_BIN,
    ['-p', '--output-format', 'json', '--model', req.model, ...LEAN_ARGS, ...effort],
    req,
  );
}

let aiDir: string | undefined;
/**
 * An empty folder the CLIs run in. Not the temp dir itself: an agent CLI scans its working folder, and the temp dir
 * holds thousands of files (measured with the Cursor CLI: 32 s there, 15 s in an empty folder, same prompt).
 */
export function aiWorkDir(): string {
  if (!aiDir) {
    aiDir = join(tmpdir(), 'relay-ai');
    mkdirSync(aiDir, { recursive: true, mode: 0o700 });
  }
  return aiDir;
}

/** Runs a headless agent CLI in an empty folder with the prompt on stdin; resolves with its envelope's text. */
export function runJsonCli(
  name: string,
  bin: string,
  args: string[],
  req: Pick<AiRunRequest, 'prompt' | 'timeoutMs'>,
): Promise<{ text: string }> {
  return new Promise((resolve, reject) => {
    const l = launchSpec(bin, args);
    const child = spawn(l.file, l.args, {
      windowsVerbatimArguments: l.windowsVerbatimArguments,
      cwd: aiWorkDir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new CockpitHostError('ai_timeout', `${name} took too long`));
    }, req.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      size += d.length;
      if (size > MAX_OUTPUT) {
        child.kill('SIGTERM');
        return;
      }
      out += d;
    });
    child.stderr.resume();
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new CockpitHostError('ai_unavailable', `${name} could not start: ${e.message}`, 409));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && out.trim() === '') {
        reject(new CockpitHostError('ai_failed', `${name} exited with ${code}`));
        return;
      }
      try {
        resolve({ text: parseClaudeEnvelope(out, name) });
      } catch (e) {
        reject(e as Error);
      }
    });
    child.stdin.end(req.prompt);
  });
}
