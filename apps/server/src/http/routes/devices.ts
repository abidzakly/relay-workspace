import type { FastifyInstance } from 'fastify';
import { DeviceControlBatchSchema, DeviceSerialSchema } from '@relay/shared';
import { z } from 'zod';
import type { DeviceHost } from '../../services/device/deviceHost';
import { HttpError, parseWith, wrapAction } from '../errors';

/**
 * Test Bench device routes. Private dashboard listener only, behind the same security hook as the
 * cockpit (it can drive a phone). The mirror is a plain streaming GET, the input a batched POST: no new protocol,
 * port or network path.
 */
const Params = z.object({ serial: DeviceSerialSchema });
const MAX_MIRRORS = 4;

export function registerDeviceRoutes(app: FastifyInstance, devices: DeviceHost): void {
  let open = 0;

  app.get('/api/devices', async () => wrapAction(() => devices.list()));

  app.get('/api/devices/:serial/mirror', async (req, reply) => {
    const { serial } = parseWith(Params, req.params);
    if (open >= MAX_MIRRORS) throw new HttpError(429, 'too_many_mirrors');
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    const it = devices.mirror(serial, abort.signal)[Symbol.asyncIterator]();
    // The first chunk decides between a JSON refusal and the stream.
    const first = await wrapAction(() => it.next());
    open++;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });
    try {
      if (!first.done) reply.raw.write(first.value);
      for (;;) {
        const next = await it.next();
        if (next.done || abort.signal.aborted) break;
        if (!reply.raw.write(next.value)) await new Promise((r) => reply.raw.once('drain', r));
      }
    } catch {
      /* the phone or the agent went away: the viewer sees the stream end and offers a restart */
    } finally {
      open--;
      abort.abort();
      await it.return?.();
      reply.raw.end();
    }
  });

  app.post('/api/devices/:serial/control', async (req) => {
    const { serial } = parseWith(Params, req.params);
    const { events } = parseWith(DeviceControlBatchSchema, req.body);
    await wrapAction(() => devices.control(serial, events));
    return { ok: true };
  });

  app.get('/api/devices/:serial/screenshot', async (req, reply) => {
    const { serial } = parseWith(Params, req.params);
    const png = await wrapAction(() => devices.screenshot(serial));
    return reply.type('image/png').header('cache-control', 'no-store').send(png);
  });
}
