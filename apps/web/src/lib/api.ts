import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '@relay/shared';

/** Error body shape of the server's uniform handler: `{ error, message?, issues? }` (see http/errors.ts). */
export interface ApiIssue {
  /** Dotted path, e.g. `gitlab.projectId` (server joins the Zod path). */
  path?: string;
  message?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];
  /** Machine-readable extras from the server (e.g. `{ gate }` on a refused merge). Unvalidated. */
  readonly details: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    issues: ApiIssue[] = [],
    details: unknown = undefined,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toApiError(status: number, body: unknown): ApiError {
  if (isRecord(body)) {
    const code = typeof body.error === 'string' ? body.error : `http_${status}`;
    const message = typeof body.message === 'string' ? body.message : code;
    const issues = Array.isArray(body.issues) ? (body.issues as ApiIssue[]) : [];
    return new ApiError(status, code, message, issues, body.details);
  }
  return new ApiError(status, `http_${status}`, `Request failed (${status})`);
}

/**
 * Thin fetch wrapper for the dashboard API (same origin; Vite proxies /api in dev).
 * State-changing requests always carry the CSRF header. Secrets are never logged here.
 */
export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  init: { signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (STATE_CHANGING.has(method)) headers[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the dashboard server (is `pnpm dev` running?)');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (!res.ok) throw toApiError(res.status, parsed);
  return parsed as T;
}

/** POST that answers with a file: same CSRF header and errors as `api()`. */
export async function postForBlob(path: string): Promise<{ blob: Blob; fileName: string | null }> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the dashboard server (is `pnpm dev` running?)');
  }
  if (!res.ok) {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    throw toApiError(res.status, parsed);
  }
  const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  return { blob: await res.blob(), fileName: match?.[1] ?? null };
}

export const get = <T>(path: string, init?: { signal?: AbortSignal }) =>
  api<T>('GET', path, undefined, init);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

/** Human-readable message for an error from `api()`, including Zod issue paths when present. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.issues.length > 0) {
      return e.issues
        .map((i) => {
          const p = i.path ?? '';
          return p ? `${p}: ${i.message ?? 'invalid'}` : (i.message ?? 'invalid');
        })
        .join('; ');
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Unknown error';
}
