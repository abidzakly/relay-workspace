import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SSE_FRAME_PING, SSE_HEARTBEAT_MS } from '@relay/shared';
import type { CockpitHost } from '../services/cockpit/host';
import { HttpError, parseWith } from './errors';
import { frame } from './sse';

const Params = z.object({ id: z.string().regex(/^[0-9a-f-]{36}$/) });
const Query = z.object({ since: z.coerce.number().int().nonnegative().default(0) });
const MAX_STREAMS = 16;
const MAX_BUFFERED = 4 * 1024 * 1024;

/**
 * `GET /api/cockpit/sessions/:id/stream?since=`: SSE proxy of a host session's attach.
 * Frames: `out` {data, offset}, `reset` {offset}, `state` {session}, `exit` {exitCode}, `ping`. The client keeps the
 * last offset and reconnects with `since` after a phone lock: the ring buffer replays what it missed.
 */
export function registerCockpitStream(app: FastifyInstance, deps: { host: CockpitHost }): void {
  const open = new Set<() => void>();
  app.get('/api/cockpit/sessions/:id/stream', async (req, reply) => {
    const { id } = parseWith(Params, req.params);
    const { since } = parseWith(Query, req.query);
    if (open.size >= MAX_STREAMS) throw new HttpError(429, 'too_many_streams');
    if (!(await deps.host.sessions()).some((s) => s.id === id)) {
      throw new HttpError(404, 'session_not_found', 'Unknown session.');
    }
    const stream = new PassThrough();
    const abort = new AbortController();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      abort.abort();
      open.delete(close);
      if (!stream.destroyed) stream.end();
    };
    const write = (chunk: string) => {
      if (closed) return;
      if (stream.writableLength > MAX_BUFFERED) return close();
      stream.write(chunk);
    };
    const hb = setInterval(
      () => write(frame({ event: SSE_FRAME_PING, data: { type: 'ping', at: Date.now() } })),
      SSE_HEARTBEAT_MS,
    );
    hb.unref();
    open.add(close);
    reply.raw.on('close', close);
    stream.on('error', close);

    void deps.host
      .sessionAttach(
        id,
        since,
        (e) => {
          if (e.t === 'data')
            write(frame({ event: 'out', data: { data: e.data, offset: e.offset } }));
          else if (e.t === 'reset') write(frame({ event: 'reset', data: { offset: e.offset } }));
          else if (e.t === 'state') write(frame({ event: 'state', data: { session: e.session } }));
          else write(frame({ event: 'exit', data: { exitCode: e.exitCode } }));
        },
        abort.signal,
      )
      .catch(() => undefined)
      .finally(close);

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
}
