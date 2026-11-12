import type { FastifyInstance } from 'fastify';
import { AdbInputSchema, DeviceControlBatchSchema, DeviceSerialSchema } from '@relay/shared';
import { z } from 'zod';
import { DeviceError, type DeviceBridge } from '../services/device/deviceBridge';

/**
 * Host agent device routes. Bearer-checked like every agent route; the agent stays bound to
 * 127.0.0.1. The mirror is a long binary response that ends when the dashboard drops the request.
 */
const Params = z.object({ serial: DeviceSerialSchema });

export function registerDeviceAgentRoutes(app: FastifyInstance, bridge: DeviceBridge): void {
  const refuse = (e: unknown) => {
    if (e instanceof DeviceError)
      return { status: e.status, body: { error: e.code, message: e.message } };
    if (e instanceof z.ZodError)
      return { status: 400, body: { error: 'bad_request', message: 'Invalid request.' } };
    return { status: 500, body: { error: 'device_error', message: 'The device bridge failed.' } };
  };

  app.get('/v1/device/list', async () => bridge.list());

  app.get('/v1/device/:serial/mirror', async (req, reply) => {
    const { serial } = Params.parse(req.params);
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    const gen = bridge.mirror(serial, abort.signal);
    // Pull the first frame before answering, so a refusal is still a JSON error.
    let first: IteratorResult<Buffer>;
    try {
      first = await gen.next();
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
    });
    try {
      if (!first.done) reply.raw.write(first.value);
      for await (const chunk of gen) {
        if (!reply.raw.write(chunk)) await new Promise((r) => reply.raw.once('drain', r));
        if (abort.signal.aborted) break;
      }
    } catch {
      /* the phone went away; the viewer sees the stream end */
    } finally {
      abort.abort();
      reply.raw.end();
    }
  });

  app.post('/v1/device/:serial/control', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      const { events } = DeviceControlBatchSchema.parse(req.body);
      await bridge.control(serial, events);
      return { ok: true };
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });

  app.post('/v1/device/:serial/input', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      await bridge.input(serial, AdbInputSchema.parse(req.body));
      return { ok: true };
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });

  app.get('/v1/device/:serial/screenshot', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      const png = await bridge.screenshot(serial);
      return reply.type('image/png').header('cache-control', 'no-store').send(png);
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });
  app.get('/v1/device/:serial/ui-tree', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      return await bridge.uiTree(serial);
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });

  app.post('/v1/device/:serial/log-errors', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      const { since } = z.object({ since: z.number().nullable() }).parse(req.body);
      return await bridge.logErrors(serial, since);
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });

  app.post('/v1/device/:serial/restart-app', async (req, reply) => {
    try {
      const { serial } = Params.parse(req.params);
      const { pkg } = z.object({ pkg: z.string().min(2).max(200) }).parse(req.body);
      await bridge.restartApp(serial, pkg);
      return { ok: true };
    } catch (e) {
      const r = refuse(e);
      return reply.code(r.status).send(r.body);
    }
  });
}
