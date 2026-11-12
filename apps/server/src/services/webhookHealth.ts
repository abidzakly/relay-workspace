import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type {
  PublicUrlCheck,
  WebhookEventStatus,
  WebhookHealth,
  WebhookHealthRepo,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import type { AppDb } from '../db';
import { events } from '../db/schema';
import { HttpNetworkError, type HttpClient } from './httpClient';
import { expectedWebhookUrl } from './webhookRegistry';

const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_MAX = 200;

const ZERO = { total: 0, received: 0, processed: 0, ignored: 0, failed: 0 };

const PROBE_TIMEOUT_MS = 8_000;

/**
 * "ngrok reachable?". One GET, no retry, no secret sent, to a path on the public listener that has no such
 * route: our listener answers with its own JSON 404, which tells it apart from anything else on that domain. It cannot
 * reach the webhook route, which is POST only, so no delivery is stored. `ngrok-error-code` is from ngrok's docs and
 * unverified against a live tunnel. The caller is the user's click only.
 */
export async function checkPublicUrl(
  publicBaseUrl: string | undefined,
  http: HttpClient,
  nowMs: number,
): Promise<PublicUrlCheck> {
  const { url } = expectedWebhookUrl(publicBaseUrl, 'probe');
  const base = { checkedAt: nowMs, httpStatus: null, detail: null };
  if (!url) return { ...base, state: 'not_configured', host: null };
  const host = new URL(url).host;
  try {
    const res = await http.send({
      url,
      headers: { 'ngrok-skip-browser-warning': '1' },
      timeoutMs: PROBE_TIMEOUT_MS,
      maxRetries: 0,
    });
    const code = res.headers['ngrok-error-code'];
    const ngrokCode = Array.isArray(code) ? code[0] : code;
    if (ngrokCode) {
      return { ...base, state: 'tunnel_error', host, httpStatus: res.status, detail: ngrokCode };
    }
    const ours =
      res.status === 404 &&
      typeof res.json === 'object' &&
      res.json !== null &&
      (res.json as { error?: unknown }).error === 'not_found';
    return { ...base, state: ours ? 'reachable' : 'unexpected', host, httpStatus: res.status };
  } catch (e) {
    return {
      ...base,
      state: 'unreachable',
      host,
      detail: e instanceof HttpNetworkError ? e.kind : 'network',
    };
  }
}

/**
 * Webhook health panel data ("last received per repo"). Local DB only: it never calls GitLab
 * or ngrok, so it says nothing about whether the public URL is reachable (`reachabilityChecked: false`).
 * Payloads are never read or returned; `error` is the short reason the processor stored (clipped).
 */
export function buildWebhookHealth(
  config: ConfigStore,
  cache: AppDb,
  nowMs: number,
): WebhookHealth {
  const repos = config.listRepos();
  const { problem } = expectedWebhookUrl(config.getGlobal().publicBaseUrl, 'x');

  // One grouped query for the 24 h counters of all repos.
  const since = nowMs - DAY_MS;
  const counts = cache.db
    .select({
      repoId: events.repoId,
      status: events.status,
      n: sql<number>`count(*)`,
    })
    .from(events)
    .where(gte(events.receivedAt, since))
    .groupBy(events.repoId, events.status)
    .all();
  const byRepo = new Map<string, WebhookHealthRepo['last24h']>();
  for (const c of counts) {
    const cur = byRepo.get(c.repoId) ?? { ...ZERO };
    const status = c.status as WebhookEventStatus;
    cur.total += c.n;
    if (status in cur) cur[status] += c.n;
    byRepo.set(c.repoId, cur);
  }

  const newest = (repoId: string, status?: WebhookEventStatus) =>
    cache.db
      .select({
        receivedAt: events.receivedAt,
        objectKind: events.objectKind,
        action: events.action,
        status: events.status,
        error: events.error,
      })
      .from(events)
      .where(
        status
          ? and(eq(events.repoId, repoId), eq(events.status, status))
          : eq(events.repoId, repoId),
      )
      .orderBy(desc(events.receivedAt), desc(events.id))
      .limit(1)
      .get();

  const rows: WebhookHealthRepo[] = repos.map((r) => {
    const last = newest(r.id);
    return {
      repoId: r.id,
      name: r.name,
      lastEvent: last
        ? {
            receivedAt: last.receivedAt,
            objectKind: last.objectKind ?? null,
            action: last.action ?? null,
            status: last.status as WebhookEventStatus,
            error: last.error ? last.error.slice(0, ERROR_MAX) : null,
          }
        : null,
      lastProcessedAt: newest(r.id, 'processed')?.receivedAt ?? null,
      lastFailedAt: newest(r.id, 'failed')?.receivedAt ?? null,
      last24h: byRepo.get(r.id) ?? { ...ZERO },
    };
  });

  return {
    generatedAt: nowMs,
    publicUrlProblem:
      problem === 'public_url_missing' || problem === 'public_url_not_https' ? problem : null,
    reachabilityChecked: false,
    repos: rows,
  };
}
