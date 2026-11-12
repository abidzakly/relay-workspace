import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SSE_EVENTS_PATH,
  SSE_FRAME_HELLO,
  SSE_FRAME_PING,
  SSE_FRAME_RESYNC,
  SSE_HEARTBEAT_MS,
  type SseHello,
  type SseResync,
} from '@relay/shared';
import type { BusEnvelope, EventBus } from '../sync/eventBus';
import type { Logger } from '../util/logger';
import { HttpError, parseWith } from './errors';

export interface EventStreamDeps {
  bus: EventBus;
  log: Logger;
  now?: () => number;
  /** Heartbeat period; default `SSE_HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Open streams allowed at once (browser tabs); the next one gets 429. Default 20. */
  maxClients?: number;
  /** A client whose unsent backlog exceeds this many bytes is dropped (it reconnects and resumes). */
  maxBufferedBytes?: number;
}

const Query = z.object({ lastEventId: z.string().max(100).optional() });
const LAST_EVENT_ID_MAX = 100;

/** Events that never go to the browser: `job.log` has its own per-job stream. */
const NOT_FORWARDED = new Set(['job.log', 'ping']);

/** One SSE frame. JSON never contains a raw newline, so `data:` can't be split or injected into. */
export function frame(parts: {
  id?: string | null;
  event?: string;
  data: unknown;
  retry?: number;
}): string {
  let out = '';
  if (parts.retry !== undefined) out += `retry: ${parts.retry}\n`;
  if (parts.id) out += `id: ${parts.id}\n`;
  if (parts.event) out += `event: ${parts.event}\n`;
  return `${out}data: ${JSON.stringify(parts.data)}\n\n`;
}

/**
 * `GET /api/events` on the PRIVATE listener.
 *
 *  - Forwards every `EventBus` event (except `job.log`) as the default `message` event with
 *    `id: <bootId>.<seq>`. Control frames (`hello`, `ping`, `resync`) are named and carry no id.
 *  - Heartbeat: a `ping` frame every `heartbeatMs`, so proxies and the browser's watchdog see traffic.
 *  - Resume: `Last-Event-ID` (header, or `?lastEventId=` for manual reconnects). Buffered events are
 *    replayed when the buffer still covers the gap; otherwise a `resync` frame tells the client to
 *    refetch everything.
 *  - Per-connection cleanup (idempotent): bus unsubscribe, heartbeat timer, registry entry and the
 *    stream itself are released on client close, stream error, slow-client drop and server shutdown.
 *  - Reads only; no secrets (events carry ids/counts). Host allowlist applies like any other route.
 */
export function registerEventStream(app: FastifyInstance, deps: EventStreamDeps): void {
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const maxClients = deps.maxClients ?? 20;
  const maxBuffered = deps.maxBufferedBytes ?? 512 * 1024;
  const open = new Set<() => void>(); // each entry closes one connection

  app.get(SSE_EVENTS_PATH, async (req, reply) => {
    if (open.size >= maxClients) throw new HttpError(429, 'too_many_streams');
    const query = parseWith(Query, req.query);
    const header = req.headers['last-event-id'];
    const lastEventId = (typeof header === 'string' ? header : query.lastEventId)?.slice(
      0,
      LAST_EVENT_ID_MAX,
    );

    const stream = new PassThrough();
    let closed = false;
    // Released by `close`; filled in below (the callbacks need `close` before these exist).
    const res: { unsubscribe?: () => void; timer?: NodeJS.Timeout } = {};

    const close = (why: string): void => {
      if (closed) return;
      closed = true;
      if (res.timer) clearInterval(res.timer);
      res.unsubscribe?.();
      open.delete(close0);
      if (!stream.destroyed) stream.destroy();
      deps.log.debug({ why, clients: open.size }, 'sse client closed');
    };
    const close0 = (): void => close('server');

    const write = (chunk: string): void => {
      if (closed) return;
      if (stream.writableLength > maxBuffered) return close('slow_client');
      stream.write(chunk);
    };

    // Subscribe + replay in ONE synchronous block: nothing can be emitted between the two.
    const replay = deps.bus.replaySince(lastEventId);
    const forward = (env: BusEnvelope): void => {
      if (NOT_FORWARDED.has(env.event.type)) return;
      write(frame({ id: env.id, data: env.event }));
    };
    res.unsubscribe = deps.bus.onEnvelope(forward);
    open.add(close0);

    const replayable = replay.events.filter((e) => !NOT_FORWARDED.has(e.event.type));
    const hello: SseHello = {
      bootId: deps.bus.bootId,
      at: now(),
      heartbeatMs,
      resumed: replay.kind === 'resumed',
      replayed: replayable.length,
    };
    write(frame({ retry: 3000, event: SSE_FRAME_HELLO, data: hello }));
    if (replay.kind === 'gap' || replay.kind === 'restart') {
      const resync: SseResync = { reason: replay.kind, at: now() };
      write(frame({ event: SSE_FRAME_RESYNC, data: resync }));
    }
    for (const env of replayable) forward(env);

    res.timer = setInterval(() => {
      write(frame({ event: SSE_FRAME_PING, data: { type: 'ping', at: now() } }));
    }, heartbeatMs);
    res.timer.unref();

    // `res` 'close' = the connection went away (IncomingMessage 'close' fires early on modern Node).
    reply.raw.on('close', () => close('client'));
    stream.on('close', () => close('stream'));
    stream.on('error', () => close('error'));

    deps.log.debug(
      { clients: open.size, resume: replay.kind, replayed: replayable.length },
      'sse client connected',
    );

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });

  // Active streams would keep `app.close()` waiting forever: end them first.
  app.addHook('preClose', async () => {
    for (const closeOne of [...open]) closeOne();
  });
}
