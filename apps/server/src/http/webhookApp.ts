import { createHash, timingSafeEqual } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { REPO_ID_RE } from '@relay/shared';
import type { Logger } from '../util/logger';
import type { WebhookIntake } from '../services/webhookProcessor';
import { installErrorHandling } from './errors';

/** Constant-time string equality: hash both sides so length differences don't leak either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** What the webhook listener needs from the config store. */
export interface WebhookSecretSource {
  getWebhookSecret(repoId: string): string | undefined;
}

export interface WebhookAppOptions {
  secrets: WebhookSecretSource;
  log: Logger;
  /** Max body bytes (GitLab push payloads can be large; default 1 MiB). */
  bodyLimit?: number;
  /** Max requests per `rateLimitWindowMs` per client IP. */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  /**
   * Honour X-Forwarded-For. Default false: behind the local ngrok agent every request has
   * the agent's address, so the rate limit is effectively global.
   */
  trustProxy?: boolean;
  /**
   * Dedupe + async processing. Without it the listener only authenticates and answers
   * 200.
   */
  intake?: WebhookIntake;
  /**
   * Reviews hook (`POST /webhook/~reviews`): one hook a reviewer adds to a GitLab group or project that is not a
   * configured repo. It only wakes the Reviews desk: nothing is cached from it.
   */
  reviews?: {
    secret: () => string | undefined;
    onDelivery: (headers: Record<string, string | string[] | undefined>, payload: unknown) => void;
  };
}

export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
const DUMMY_SECRET = 'x'.repeat(43);

/**
 * PUBLIC listener (:3001, behind ngrok). The ONLY routes are `POST /webhook/:repoId` and `POST /webhook/~reviews`; every other
 * path/method is a 404 from the not-found handler.
 * Order: constant-time token check (before the body is parsed) -> dedupe by X-Gitlab-Event-UUID and
 * store the delivery -> 200 immediately -> processing runs afterwards (`intake.enqueue`).
 *
 * Unknown repo ids and wrong tokens get the same 401, after the same constant-time comparison,
 * so the endpoint cannot be used to discover which repos exist.
 */
export async function buildWebhookApp(opts: WebhookAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: opts.log as FastifyBaseLogger,
    bodyLimit: opts.bodyLimit ?? WEBHOOK_BODY_LIMIT,
    trustProxy: opts.trustProxy ?? false,
    requestTimeout: 15_000,
    maxParamLength: 64,
    disableRequestLogging: true,
  });
  installErrorHandling(app);

  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax ?? 300,
    timeWindow: opts.rateLimitWindowMs ?? 60_000,
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 'rate_limited',
      error: 'Too Many Requests',
      message: 'rate limited',
    }),
  });

  // Only JSON bodies (GitLab sends application/json); Fastify would otherwise also accept text/plain.
  app.removeContentTypeParser('text/plain');

  // Static route: matched before the `:repoId` route, and `~` can never be a repo id.
  app.route({
    method: 'POST',
    url: '/webhook/~reviews',
    preParsing: (req, reply, _payload, done) => {
      const header = req.headers['x-gitlab-token'];
      const given = typeof header === 'string' ? header : '';
      const expected = opts.reviews?.secret();
      const ok =
        safeEqual(given, expected ?? DUMMY_SECRET) && expected !== undefined && given !== '';
      if (!ok) {
        req.log.warn('reviews webhook rejected');
        void reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      done(null, _payload);
    },
    handler: async (req, reply) => {
      const payload: unknown = req.body;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return reply.code(400).send({ error: 'bad_payload' });
      }
      void reply.code(200).send({ ok: true });
      const headers = req.headers;
      setImmediate(() => {
        try {
          opts.reviews?.onDelivery(headers, payload);
        } catch {
          /* never fails a delivery */
        }
      });
      return reply;
    },
  });

  app.route<{ Params: { repoId: string } }>({
    method: 'POST',
    // The id pattern is part of the route: anything that is not a valid repo id is a plain 404.
    url: '/webhook/:repoId(^[a-z0-9][a-z0-9-]{0,62}$)',
    // Authenticate BEFORE the body is read/parsed. (preParsing runs after the rate-limit onRequest hook.)
    preParsing: (req, reply, _payload, done) => {
      const header = req.headers['x-gitlab-token'];
      const given = typeof header === 'string' ? header : '';
      const repoId = req.params.repoId;
      const expected = REPO_ID_RE.test(repoId) ? opts.secrets.getWebhookSecret(repoId) : undefined;
      const ok =
        safeEqual(given, expected ?? DUMMY_SECRET) && expected !== undefined && given !== '';
      if (!ok) {
        req.log.warn({ repoId }, 'webhook rejected');
        void reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      done(null, _payload);
    },
    handler: async (req, reply) => {
      const intake = opts.intake;
      if (!intake) return reply.code(200).send({ ok: true });
      const payload: unknown = req.body;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return reply.code(400).send({ error: 'bad_payload' });
      }
      const input = { repoId: req.params.repoId, headers: req.headers, payload };
      // Synchronous and local (one SQLite insert): a duplicate stops here. A DB failure throws -> 500,
      // GitLab retries with the same UUID.
      const accepted = intake.accept(input);
      void reply.code(200).send(accepted.duplicate ? { ok: true, duplicate: true } : { ok: true });
      // The response is already handed to the socket; the slow part starts on a later tick (setImmediate).
      intake.enqueue(input, accepted);
      return reply;
    },
  });

  return app;
}
