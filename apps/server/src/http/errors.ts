import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { ActionError } from '../services/actionError';

/** An error whose message is safe to show to the client. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Machine-readable, secret-free extra data for the client (e.g. the merge gate's reasons). */
    readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

/** Domain errors (`ActionError`) become uniform `{ error, message, details }` bodies; messages are secret-free by construction. */
export async function wrapAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ActionError) throw new HttpError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

/** Zod-validates `data`; ZodError becomes a 400 via the error handler. */
export function parseWith<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export interface ErrorBody {
  error: string;
  message?: string;
  details?: unknown;
  issues?: { path: string; message: string }[];
}

/**
 * Uniform JSON errors. Never echoes request bodies or internal messages for 5xx
 * (Zod issues carry only path + message, not the offending value).
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
    void reply.code(404).send({ error: 'not_found' } satisfies ErrorBody);
  });

  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: 'validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
      return reply.code(400).send(body);
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({
        error: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      } satisfies ErrorBody);
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastify's own client errors (413 body too large, 415 media type, 400 bad JSON…)
      return reply
        .code(status)
        .send({ error: (err as FastifyError).code ?? 'bad_request' } satisfies ErrorBody);
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal' } satisfies ErrorBody);
  });
}
