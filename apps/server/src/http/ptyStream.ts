import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PTY_FRAME_END,
  PTY_FRAME_OUTPUT,
  PTY_FRAME_TRUNCATED,
  SSE_FRAME_PING,
  SSE_HEARTBEAT_MS,
} from '@relay/shared';
import { ActionError } from '../services/actionError';
import { PTY_STEP } from '../services/jobStore';
import type { ReleaseEngine } from '../services/releaseEngine';
import type { Logger } from '../util/logger';
import { HttpError, parseWith, wrapAction } from './errors';
import { frame } from './sse';

const JobParamsSchema = z.object({ jobId: z.string().min(1).max(64) });
const MAX_STREAMS = 10;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * `GET /api/release/:jobId/stream`: the terminal output of one PTY job. It is separate from `/api/events`, which never
 * carries job logs. `Last-Event-ID` resumes a live run from the buffer. A run that is over answers with its stored
 * transcript (the newest 64 KB) and `end`. Reads only; the text was redacted before it got here.
 */
export function registerPtyStream(
  app: FastifyInstance,
  deps: { engine: ReleaseEngine; log: Logger },
): void {
  const { engine } = deps;
  const open = new Set<() => void>();

  app.get('/api/release/:jobId/stream', async (req, reply) => {
    const { jobId } = parseWith(JobParamsSchema, req.params);
    if (open.size >= MAX_STREAMS) throw new HttpError(429, 'too_many_streams');
    const job = await wrapAction(async () => {
      const found = engine.jobs.get(jobId);
      if (!found) throw new ActionError(404, 'job_not_found', 'Unknown job');
      if (found.engine !== 'pty') {
        throw new ActionError(409, 'job_not_pty', 'Only a PTY job has a terminal stream');
      }
      return found;
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
    const end = (): void => {
      write(frame({ event: PTY_FRAME_END, data: {} }));
      if (res.timer) clearInterval(res.timer);
      if (!closed) stream.end();
    };

    open.add(close);
    reply.raw.on('close', close);
    stream.on('error', close);
    stream.on('close', close);

    const live = engine.pty.attach(jobId, afterSeq, (e) => {
      if (e.kind === 'output') {
        write(frame({ id: String(e.seq), event: PTY_FRAME_OUTPUT, data: { data: e.data } }));
      } else {
        end();
      }
    });
    if (live) {
      res.detach = live.detach;
      if (live.dropped) write(frame({ event: PTY_FRAME_TRUNCATED, data: {} }));
      for (const c of live.backlog) {
        write(frame({ id: String(c.seq), event: PTY_FRAME_OUTPUT, data: { data: c.data } }));
      }
      res.timer = setInterval(() => {
        write(frame({ event: SSE_FRAME_PING, data: { type: 'ping', at: Date.now() } }));
      }, SSE_HEARTBEAT_MS);
      res.timer.unref();
    } else {
      // A reconnect already has the output; a first look gets the transcript.
      const log = engine.jobs.steps(job.id).find((s) => s.name === PTY_STEP)?.log ?? '';
      if (!resumed && log !== '') {
        write(frame({ event: PTY_FRAME_OUTPUT, data: { data: log } }));
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
