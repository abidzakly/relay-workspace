import { randomBytes } from 'node:crypto';

/**
 * Confirmation tokens (fixes are "suggested + one-click confirmed, never automatic").
 *
 * A write is only possible with a token that the server issued for EXACTLY that change when the user opened
 * the confirm dialog (the "preview" call). A token is
 *  - bound to the change (action, card, target value…) -> it cannot be reused for another write;
 *  - single use -> a replay or a double click writes once;
 *  - short lived -> a dialog left open for an hour cannot be confirmed blindly;
 *  - in memory only -> a restart invalidates every open dialog (fail closed).
 * This is not authentication (the dashboard is local-only); it makes "no write without confirmation" a
 * property of the API, not of the UI.
 */

export const CONFIRM_TTL_MS = 5 * 60_000;
const MAX_PENDING = 200;

export type ConsumeResult =
  { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'mismatch' };

interface Pending {
  binding: string;
  expiresAt: number;
}

/** Stable serialization of a binding (key order must not matter). */
function bindingKey(binding: Record<string, string | number | boolean | null>): string {
  return JSON.stringify(Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export class Confirmations {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = CONFIRM_TTL_MS,
  ) {}

  issue(binding: Record<string, string | number | boolean | null>): {
    token: string;
    expiresAt: number;
  } {
    this.sweep();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    const token = randomBytes(24).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { binding: bindingKey(binding), expiresAt });
    return { token, expiresAt };
  }

  /** Burns the token whatever the outcome: a wrong guess or a mismatch must not leave a usable token behind. */
  consume(token: string, binding: Record<string, string | number | boolean | null>): ConsumeResult {
    const hit = this.pending.get(token);
    this.pending.delete(token);
    if (!hit) return { ok: false, reason: 'unknown' };
    if (hit.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
    if (hit.binding !== bindingKey(binding)) return { ok: false, reason: 'mismatch' };
    return { ok: true };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
  }
}
