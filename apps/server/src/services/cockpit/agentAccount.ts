import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { parseCursorModelList, type AgentAccounts, type CursorModelEntry } from '@relay/shared';
import { killChild, launchSpec } from '../../util/platform';
import { aiWorkDir, CLAUDE_BIN } from './claudeCli';
import { CURSOR_BIN } from './cursorCli';

/**
 * What the local agent logins allow, read from the CLIs themselves: `cursor-agent --list-models` lists the models the
 * logged-in Cursor account may use, `cursor-agent about` and `claude auth status` name the subscription. Emails in that
 * output are dropped here and never leave this file. Cached, since each call starts a CLI.
 */

export interface HostAgentModels {
  /** null when the Cursor CLI is missing, logged out, or did not answer. */
  cursor: CursorModelEntry[] | null;
  accounts: AgentAccounts;
}

const CACHE_MS = 10 * 60_000;
let cached: { at: number; value: HostAgentModels } | undefined;
let inflight: Promise<HostAgentModels> | undefined;

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcessByStdio<null, Readable, null>;
    try {
      const l = launchSpec(bin, args);
      child = spawn(l.file, l.args, {
        windowsVerbatimArguments: l.windowsVerbatimArguments,
        cwd: aiWorkDir(),
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      killChild(child);
      resolve(null);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (out.length < 512 * 1024) out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

/** `Subscription Tier   Team` → `Team`. Exported for tests. */
export function parseCursorAbout(text: string): { tier: string | null } {
  const m = /^\s*Subscription Tier\s+(.+?)\s*$/im.exec(text);
  return { tier: m?.[1] ?? null };
}

/** The tier and login kind from `claude auth status` (JSON); everything else, the email included, is dropped. */
export function parseClaudeAuthStatus(
  text: string,
): { tier: string | null; authMethod: string | null } | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j.loggedIn !== true) return null;
    const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { tier: s(j.subscriptionType) ?? s(j.planTier), authMethod: s(j.authMethod) };
  } catch {
    return null;
  }
}

async function read(): Promise<HostAgentModels> {
  const [list, about, auth] = await Promise.all([
    run(CURSOR_BIN, ['--list-models']),
    run(CURSOR_BIN, ['about']),
    run(CLAUDE_BIN, ['auth', 'status']),
  ]);
  const models = list ? parseCursorModelList(list) : [];
  return {
    cursor: models.length > 0 ? models : null,
    accounts: {
      claude: auth ? parseClaudeAuthStatus(auth) : null,
      cursor: about ? parseCursorAbout(about) : null,
    },
  };
}

export function hostAgentModels(refresh = false): Promise<HostAgentModels> {
  if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  inflight ??= read()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}
