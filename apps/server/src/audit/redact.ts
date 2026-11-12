import type { Json } from '@relay/shared';

/** Keys whose (non-boolean) values are secrets. Booleans such as `tokenSet` are flags, kept as-is. */
const SECRET_KEY_RE =
  /token|secret|password|passphrase|authorization|cookie|private[_-]?key|api[_-]?key|master[_-]?key|p256dh|^auth$/i;

export const REDACTED = '[REDACTED]';

/**
 * Deep-copies `value` replacing secret-looking fields with `[REDACTED]` (safety net for audit
 * before/after; callers should still pass public shapes). Handles cycles and non-JSON values.
 */
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): Json {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      break;
    default:
      return null; // bigint / function / symbol
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, seen));
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) && typeof v !== 'boolean' ? REDACTED : redactSecrets(v, seen);
  }
  return out;
}
