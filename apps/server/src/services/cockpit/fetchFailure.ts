import { execFile } from 'node:child_process';
import type { FetchFailure, FetchFailureReason } from '@relay/shared';
import { childEnv } from '../gitExec';

/**
 * `git fetch origin` for "Run this branch", reporting failure instead of hiding it: the user must learn that GitLab
 * could not be reached (VPN off, offline, credentials) rather than get a cryptic checkout error later.
 */

/** A dead VPN usually hangs on connect: give up well before the workspace git timeout. */
const FETCH_TIMEOUT_MS = 25_000;

const NETWORK = [
  /could not resolve host/i,
  /failed to connect/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /connection refused/i,
  /connection reset/i,
  /no route to host/i,
  /could not read from remote repository/i,
  /ssl_connect|ssl_error|gnutls/i,
  /proxy/i,
];
const AUTH = [
  /authentication failed/i,
  /permission denied/i,
  /could not read username/i,
  /could not read password/i,
  /http basic: access denied/i,
  /\b40[13]\b/,
  /terminal prompts disabled/i,
];

export function classifyFetchError(stderr: string, timedOut: boolean): FetchFailureReason {
  if (AUTH.some((r) => r.test(stderr))) return 'auth';
  if (timedOut || NETWORK.some((r) => r.test(stderr))) return 'network';
  return 'unknown';
}

/** Null when the fetch worked. */
export function fetchOriginReport(
  cwd: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<FetchFailure | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'color.ui=false', 'fetch', 'origin'],
      {
        cwd,
        // Never block on a credential prompt: there is no terminal to answer it.
        env: { ...childEnv(cwd), GIT_TERMINAL_PROMPT: '0' },
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, _out, stderr) => {
        if (!err) return resolve(null);
        const timedOut = (err as Error & { killed?: boolean }).killed === true;
        const lines = (stderr || err.message)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-6)
          .join('\n')
          .slice(0, 800);
        resolve({
          reason: classifyFetchError(stderr, timedOut),
          message: timedOut
            ? `git fetch timed out after ${Math.round(timeoutMs / 1000)}s` +
              (lines ? `\n${lines}` : '')
            : lines,
        });
      },
    );
  });
}
