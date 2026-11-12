/**
 * Dashboard API contract constants shared by server and web.
 */

/**
 * Placeholder the UI shows for a saved secret and may send back unchanged.
 * Server semantics for a secret field on write:
 *   omitted / `SECRET_MASK`  -> keep the stored secret (unchanged)
 *   `null`                   -> clear it (only where the secret is optional)
 *   any other string         -> replace it
 * The API never returns a secret; it returns `*Set` booleans instead.
 */
export const SECRET_MASK = '********';

/** Every state-changing request (POST/PUT/PATCH/DELETE) must carry this header (CSRF defence). */
export const CSRF_HEADER_NAME = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'relay';
