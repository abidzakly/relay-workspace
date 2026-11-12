import type { FastifyInstance } from 'fastify';
import { isLoopbackHost } from '../config/env';

export class NonLoopbackBindError extends Error {
  constructor(host: string) {
    super(`refusing to bind the dashboard to "${host}": only 127.0.0.1 is allowed`);
    this.name = 'NonLoopbackBindError';
  }
}

/** Throws unless `host` is exactly 127.0.0.1. Called right before `listen`, whatever the config says. */
export function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) throw new NonLoopbackBindError(host);
}

export async function listenDashboard(
  app: FastifyInstance,
  opts: { host: string; port: number },
): Promise<string> {
  assertLoopbackHost(opts.host);
  return app.listen({ host: opts.host, port: opts.port });
}

export async function listenWebhook(
  app: FastifyInstance,
  opts: { host: string; port: number },
): Promise<string> {
  return app.listen({ host: opts.host, port: opts.port });
}
