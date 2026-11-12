/**
 * Domain error whose message is safe to show to the client (secret-free by construction). The HTTP layer maps
 * it 1:1 to `{ error: code, message, details }`. Subclassed per area (`MrActionError`, `CardActionError`).
 */
export class ActionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Machine-readable, secret-free payload returned to the client (e.g. the refused merge gate). */
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'ActionError';
  }
}
