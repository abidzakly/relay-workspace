import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BUILD_FRAME_END,
  BUILD_FRAME_LINE,
  BUILD_FRAME_TRUNCATED,
  SSE_FRAME_PING,
  SSE_HEARTBEAT_MS,
  type BuildLogTruncation,
} from '@relay/shared';
import { ActionError } from '../services/actionError';
import type { BuildQueue } from '../services/buildQueue';
import { HttpError, parseWith, wrapAction } from './errors';
import { frame } from './sse';

const JobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });
const MAX_STREAMS = 10;
/**
 * Well above a full replay: the 2 MB line buffer grows with frame overhead and JSON escapes, and all of it is written
 * before the first byte can leave. A lower limit would drop that client, whose reconnect would then do the same again.
 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/**
 * `GET /api/builds/:jobId/log`: the log of one build, kept off `/api/events`, like a PTY job's stream.
 *  - Queued or running: the buffered lines, then live. `Last-Event-ID` resumes after that line.
 *  - Over: the stored log, then `end`. Only its newest 64 KB exists; the `truncated` frame says when it was cut.
 * Reads only; the text was redacted before it got here.
 */
export function registerBuildLogStream(app: FastifyInstance, deps: { builds: BuildQueue }): void {
  const { builds } = deps;
  const open = new Set<() => void>();

  app.get('/api/builds/:jobId/log', async (req, reply) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    if (open.size >= MAX_STREAMS) throw new HttpError(429, 'too_many_streams');
    await wrapAction(async () => {
      if (!builds.job(jobId)) throw new ActionError(404, 'job_not_found', 'Unknown build');
    });

    const header = req.headers['last-event-id'];
    const parsed = typeof header === 'string' ? Number.parseInt(header, 10) : NaN;
    const resumed = Number.isSafeInteger(parsed) && parsed >= 0;
    const afterSeq = resumed ? parsed : 0;

    const stream = new PassThrough();
    const res: { detach?: () => void; timer?: NodeJS.Timeout } = {};
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (res.timer) clearInterval(res.timer);
      res.detach?.();
      open.delete(close);
      if (!stream.destroyed) stream.destroy();
    };
    const write = (chunk: string): void => {
      if (closed) return;
      // Dropped clients reconnect and resume from the buffer.
      if (stream.writableLength > MAX_BUFFERED_BYTES) return close();
      stream.write(chunk);
    };
    const writeLine = (seq: number | null, line: string): void => {
      write(
        frame({ id: seq === null ? null : String(seq), event: BUILD_FRAME_LINE, data: { line } }),
      );
    };
    const writeTruncated = (reason: BuildLogTruncation): void => {
      write(frame({ event: BUILD_FRAME_TRUNCATED, data: { reason } }));
    };
    const end = (): void => {
      write(frame({ event: BUILD_FRAME_END, data: {} }));
      if (res.timer) clearInterval(res.timer);
      if (!closed) stream.end();
    };

    open.add(close);
    reply.raw.on('close', close);
    stream.on('error', close);
    stream.on('close', close);

    const live = builds.attach(jobId, afterSeq, (e) => {
      if (e.kind === 'line') writeLine(e.seq, e.line);
      else end();
    });
    if (live) {
      res.detach = live.detach;
      if (live.dropped) writeTruncated('buffer');
      for (const l of live.backlog) writeLine(l.seq, l.line);
      res.timer = setInterval(() => {
        write(frame({ event: SSE_FRAME_PING, data: { type: 'ping', at: Date.now() } }));
      }, SSE_HEARTBEAT_MS);
      res.timer.unref();
    } else {
      const { lines, truncated } = builds.storedLog(jobId);
      if (!truncated) {
        lines.slice(afterSeq).forEach((line, i) => writeLine(afterSeq + i + 1, line));
      } else if (resumed) {
        // The client has lines up to `afterSeq`, but a cut log no longer says which of its lines those are.
        writeTruncated('gap');
      } else {
        writeTruncated('stored');
        // No ids: these are not sequence numbers. A reconnect starts over, and the client clears first.
        for (const line of lines) writeLine(null, line);
      }
      end();
    }

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });

  app.addHook('preClose', async () => {
    for (const closeOne of [...open]) closeOne();
  });
}
