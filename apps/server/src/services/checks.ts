import type { Check, CheckGroup, CheckStatus } from '@relay/shared';

/** Tiny builders so each service reads as a list of verdicts. */
export function makeCheck(group: CheckGroup) {
  const mk =
    (status: CheckStatus) =>
    (id: string, label: string, message: string, hint?: string): Check => ({
      id,
      group,
      label,
      status,
      message,
      ...(hint ? { hint } : {}),
    });
  return { pass: mk('pass'), warn: mk('warn'), fail: mk('fail'), skip: mk('skip') };
}

/** Truncates server-provided text before it is put in a message (never trust its size). */
export function clip(s: unknown, max = 200): string {
  const t = typeof s === 'string' ? s : '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
