/**
 * Recognises "this model cannot be used" from each engine, so a refused model falls back to the default instead of
 * failing the run. Messages measured on the CLIs:
 *  - Claude CLI, unknown id: "There's an issue with the selected model (x). It may not exist or you may not have access
 *    to it." (`api_error_type: not_found_error`).
 *  - Claude CLI, model outside the plan (Fable 5.2 on Pro): "Fable 5.2 requires usage credits. Switch to another model…".
 *  - Cursor CLI, stderr: "Cannot use this model: x. Available models: …".
 *  - Anthropic API: 404 `not_found_error` (mapped to "model not found" in the provider).
 */

const PATTERNS = [
  /issue with the selected model/i,
  /may not have access to it/i,
  /requires usage credits/i,
  /switch to another model/i,
  /cannot use this model/i,
  /unrecognized_model/i,
  /not_found_error/i,
  /model not found/i,
];

export function isModelUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return PATTERNS.some((p) => p.test(msg));
}

/** A short, user-facing reason: the first sentence of the engine's message, without the long model list. */
export function modelUnavailableReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/requires usage credits/i.test(msg)) return 'not included in your plan (needs usage credits)';
  if (/cannot use this model/i.test(msg)) return 'not available to your Cursor account';
  return 'not available to your account, or the id does not exist';
}
