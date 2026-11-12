import { request, type Dispatcher } from 'undici';
import type { Logger } from '../util/logger';

/** Max response body we are willing to buffer (schemas / MR lists are small). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Longest we honour a Retry-After header. */
const MAX_RETRY_AFTER_MS = 10_000;

export type NetworkErrorKind = 'timeout' | 'network' | 'too_large' | 'invalid_url';

/**
 * Transport-level failure (no HTTP response). The message only carries the kind and the host:
 * never headers, URL query, body or the underlying error text (which can echo request details).
 */
export class HttpNetworkError extends Error {
  constructor(
    readonly kind: NetworkErrorKind,
    readonly host: string,
  ) {
    super(`${kind} calling ${host}`);
    this.name = 'HttpNetworkError';
  }
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Object -> JSON body. String or Buffer -> sent as-is (set `content-type` yourself). */
  body?: unknown;
  /** Per-request override of the default timeout. */
  timeoutMs?: number;
  /** Per-request override of the retry count (writes pass 0: a replayed POST could duplicate). */
  maxRetries?: number;
  /** Keep the raw body in `bytes` (`text` stays empty, `json` undefined): for file downloads. */
  binary?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed JSON, or `undefined` when the body is empty / not JSON. */
  json: unknown;
  /** How many attempts were made (1 = no retry). */
  attempts: number;
  /** The raw body, only for a `binary` request. */
  bytes?: Buffer;
}

export interface HttpClientOptions {
  log: Logger;
  /** Tests inject an undici `MockAgent`. */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  /** Retries after the first attempt, on 429 / 5xx / transport errors. */
  maxRetries?: number;
  backoffBaseMs?: number;
  /** Tests: no real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests: deterministic jitter in [0,1). */
  random?: () => number;
}

/** Strips userinfo, query and fragment: safe to log. */
export function safeUrl(raw: string): { host: string; path: string } {
  try {
    const u = new URL(raw);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: 'invalid', path: '' };
  }
}

export function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The one outbound HTTP path for GitLab / Notion / Drive: timeout per attempt, retry with
 * exponential backoff on 429/5xx/transport errors (honouring Retry-After), redirects NOT followed
 * (an Authorization header must never be replayed to another host), bounded body, and logs that carry
 * method + host + path + status only (never headers, query or bodies).
 */
export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: HttpClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffBaseMs = opts.backoffBaseMs ?? 300;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const { host, path } = safeUrl(req.url);
    const method = req.method ?? 'GET';
    if (host === 'invalid' || !/^https?:\/\//i.test(req.url)) {
      throw new HttpNetworkError('invalid_url', host);
    }
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | Buffer | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) body = req.body;
      else {
        body = JSON.stringify(req.body);
        headers['content-type'] ??= 'application/json';
      }
    }
    const log = this.opts.log;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let res: HttpResponse | undefined;
      let netErr: HttpNetworkError | undefined;
      try {
        res = await this.once(req, method, headers, body, attempt);
      } catch (e) {
        netErr = e instanceof HttpNetworkError ? e : new HttpNetworkError('network', host);
      }

      const retryable = netErr
        ? netErr.kind === 'timeout' || netErr.kind === 'network'
        : res !== undefined && (res.status === 429 || res.status >= 500);
      const ms = Date.now() - started;
      log.debug(
        { method, host, path, status: res?.status, error: netErr?.kind, attempt, ms },
        'outbound http',
      );

      if (!retryable || attempt > (req.maxRetries ?? this.maxRetries)) {
        if (netErr) throw netErr;
        return res!;
      }
      const retryAfter = res ? parseRetryAfterMs(res.headers['retry-after']) : undefined;
      const backoff = this.backoffBaseMs * 2 ** (attempt - 1) * (1 + this.random() * 0.25);
      const wait = Math.max(retryAfter ?? 0, backoff);
      log.warn(
        { method, host, path, status: res?.status, attempt, waitMs: Math.round(wait) },
        'outbound http retry',
      );
      await this.sleep(wait);
    }
  }

  private async once(
    req: HttpRequest,
    method: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    attempt: number,
  ): Promise<HttpResponse> {
    const { host } = safeUrl(req.url);
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    let res: Dispatcher.ResponseData;
    try {
      res = await request(req.url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        // Covers connect + headers + body for this attempt.
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.opts.dispatcher ? { dispatcher: this.opts.dispatcher } : {}),
      });
    } catch (e) {
      throw new HttpNetworkError(isAbort(e) ? 'timeout' : 'network', host);
    }

    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += b.length;
        if (size > MAX_BODY_BYTES) {
          res.body.destroy();
          throw new HttpNetworkError('too_large', host);
        }
        chunks.push(b);
      }
      if (req.binary) {
        return {
          status: res.statusCode,
          headers: res.headers,
          text: '',
          json: undefined,
          attempts: attempt,
          bytes: Buffer.concat(chunks),
        };
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      return { status: res.statusCode, headers: res.headers, text, json, attempts: attempt };
    } catch (e) {
      if (e instanceof HttpNetworkError) throw e;
      throw new HttpNetworkError(isAbort(e) ? 'timeout' : 'network', host);
    }
  }
}

function isAbort(e: unknown): boolean {
  const err = e as { name?: string; code?: string } | null;
  return (
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError' ||
    err?.code === 'UND_ERR_ABORTED' ||
    err?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
    err?.code === 'UND_ERR_BODY_TIMEOUT' ||
    err?.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}
