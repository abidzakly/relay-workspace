import { defaultEnvFilePath, writeEnvFileLocal } from '../services/scriptConfig';
import { spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from '../util/logger';
import { appendGitConfig, GitExec, GitExecError, redactSecrets } from '../services/gitExec';
import { LocalPtyBackend, type PtyProcess } from '../services/ptyBackend';
import { LocalCockpitHost, type LocalCockpitHostOptions } from '../services/cockpit/localHost';
import { registerCockpitAgentRoutes } from './cockpitRoutes';
import { registerDeviceAgentRoutes } from './deviceRoutes';
import { registerFigmaAgentRoutes } from './figmaRoutes';
import type { FigmaBridge } from '../services/figma/bridgeClient';
import { DeviceBridge } from '../services/device/deviceBridge';
import {
  AGENT_HEARTBEAT_MS,
  AGENT_PROTOCOL,
  checkClientEnv,
  ExecRequestSchema,
  isVuArgs,
  PtyKillSchema,
  PtyStartRequestSchema,
  type AgentHealth,
  type ExecEvent,
  type PtyEvent,
} from './protocol';
import { IS_WINDOWS, launchSpec, which } from '../util/platform';

/**
 * The Mac side of the Docker setup. Runs the same `GitExec` (allowlisted git/flutter/fvm, cwd locked to a bot clone)
 * and the same `LocalPtyBackend` (only `~/bin/vu`) the dashboard runs when it is not in Docker. Nothing else is
 * reachable outside the routes registered here: git/flutter/fvm, `vu`, the cockpit (whose `shell` session kind is a
 * login shell in a workspace) and the Test Bench device bridge (adb + scrcpy for a plugged-in phone).
 *
 * When the repo host is only reachable through a proxy (`HOST_AGENT_GIT_PROXY`, say for a private network), git reaches
 * the repo host through it (per host: pub.dev, Maven and the rest still go direct), and `vu`'s glab gets it through a
 * shim on PATH.
 */

export interface HostAgentOptions {
  token: string;
  log: Logger;
  clonesRoot: string;
  /** e.g. `http://127.0.0.1:3128`. */
  gitProxy: string | null;
  /** Names a build may receive (`BUILD_PASS_ENV` of the agent's `.env`). */
  passEnv: readonly string[];
  /** Default `~/bin`. */
  binDir?: string;
  /** Cockpit options (workspace roots, …). */
  cockpit?: Omit<LocalCockpitHostOptions, 'log'>;
  /** Where the pinned scrcpy server lives (`<data dir>/scrcpy`); the Test Bench mirror pushes it to the phone. */
  scrcpyDir?: string;
  /** The Figma MCP bridge on the Mac (the plugin in the Figma desktop app connects to it). */
  figma: FigmaBridge;
}

interface PtyRun {
  proc: PtyProcess;
  secrets: string[];
}

export async function createHostAgent(o: HostAgentOptions): Promise<FastifyInstance> {
  const git = new GitExec({ clonesRoot: o.clonesRoot, log: o.log });
  const glabShim = o.gitProxy ? makeGlabShim(o.gitProxy, o.log) : null;
  const pty = new LocalPtyBackend({
    log: o.log,
    ...(o.binDir ? { binDir: o.binDir } : {}),
    ...(glabShim ? { pathPrefix: [glabShim] } : {}),
  });
  const runs = new Map<string, PtyRun>();
  const expected = Buffer.from(`Bearer ${o.token}`);
  let flutterVersion: string | null | undefined;

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /** The proxy pair git needs for the repo host, after whatever the caller sent. */
  const withProxy = (env: Record<string, string>, remoteBase: string | null) =>
    o.gitProxy && remoteBase ? appendGitConfig(env, `http.${remoteBase}.proxy`, o.gitProxy) : env;

  /** The release scripts' env file on the Mac (the dashboard in Docker cannot reach ~/.config). */
  app.put('/v1/scripts/env', async (req, reply) => {
    const body = req.body as { content?: unknown } | null;
    const content = typeof body?.content === 'string' ? body.content : null;
    if (content === null || content.length > 64 * 1024 || content.includes('\u0000')) {
      return reply.code(422).send({ error: 'invalid request' });
    }
    const path = defaultEnvFilePath();
    try {
      writeEnvFileLocal(path, content);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
    return { path };
  });

  app.get('/v1/health', async (): Promise<AgentHealth> => {
    flutterVersion ??= readFlutterVersion();
    return {
      protocol: AGENT_PROTOCOL,
      pty: pty.availability(),
      flutter: flutterVersion,
      clonesRoot: o.clonesRoot,
      gitProxy: o.gitProxy,
    };
  });

  app.post('/v1/exec', async (req, reply) => {
    const parsed = ExecRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid request' });
    const r = parsed.data;
    const refused = checkClientEnv(r.env, { pty: false, passEnv: o.passEnv });
    if (refused) return reply.code(422).send({ error: refused });

    const out = ndjson<ExecEvent>(req, reply);
    const env = withProxy(r.env, r.remoteBase);
    try {
      const result =
        r.mode === 'run'
          ? await git.run(r.repoId, r.command, r.args, {
              timeoutMs: r.timeoutMs,
              secrets: r.secrets,
              env,
              signal: out.signal,
              ...(r.allowFailure ? { allowFailure: true } : {}),
            })
          : await git.stream(r.repoId, r.command, r.args, {
              timeoutMs: r.timeoutMs,
              secrets: r.secrets,
              env,
              signal: out.signal,
              onLine: (line, stream) => out.send({ t: 'line', line, stream }),
            });
      out.send({ t: 'result', result });
    } catch (e) {
      const err = e as Error;
      out.send({
        t: 'error',
        code: e instanceof GitExecError ? e.code : 'spawn_failed',
        message: redactSecrets(err.message, r.secrets),
        ...(e instanceof GitExecError && e.result ? { result: e.result } : {}),
      });
    }
    out.end();
  });

  app.post('/v1/pty', async (req, reply) => {
    const parsed = PtyStartRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid request' });
    const r = parsed.data;
    if (!isVuArgs(r.args))
      return reply.code(422).send({ error: 'these vu arguments are not allowed' });
    const refused = checkClientEnv(r.env, { pty: true, passEnv: [] });
    if (refused) return reply.code(422).send({ error: refused });
    const { available, reason } = pty.availability();
    if (!available) return reply.code(409).send({ error: reason });

    let proc: PtyProcess;
    try {
      proc = await pty.spawnVu({
        repoId: r.repoId,
        cwd: git.clonePath(r.repoId),
        args: r.args,
        env: withProxy(r.env, r.remoteBase),
        secrets: r.secrets,
      });
    } catch (e) {
      return reply.code(500).send({ error: redactSecrets((e as Error).message, r.secrets) });
    }

    const id = randomUUID();
    runs.set(id, { proc, secrets: r.secrets });
    const out = ndjson<PtyEvent>(req, reply);
    o.log.info({ id, pid: proc.pid, repoId: r.repoId, args: r.args }, 'vu started');
    out.send({ t: 'started', id, pid: proc.pid });
    proc.onData((data) => out.send({ t: 'data', data }));
    await new Promise<void>((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        runs.delete(id);
        o.log.info({ id, exitCode, signal }, 'vu exited');
        out.send({ t: 'exit', exitCode, ...(signal ? { signal } : {}) });
        resolve();
      });
      // The dashboard went away (restart, crash): vu dies with it, as it would on a single machine.
      out.signal.addEventListener('abort', () => {
        if (runs.has(id)) proc.killGroup('SIGTERM');
      });
    });
    out.end();
  });

  app.post<{ Params: { id: string }; Body: { data?: unknown } }>(
    '/v1/pty/:id/input',
    async (req, reply) => {
      const run = runs.get(req.params.id);
      if (!run) return reply.code(404).send({ error: 'no such run' });
      // The one input the PTY engine ever sends: Enter at vu's review prompt.
      if (req.body?.data !== '\r') return reply.code(422).send({ error: 'only Enter may be sent' });
      run.proc.write('\r');
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/pty/:id/kill', async (req, reply) => {
    const run = runs.get(req.params.id);
    if (!run) return reply.code(404).send({ error: 'no such run' });
    const parsed = PtyKillSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid signal' });
    run.proc.killGroup(parsed.data.signal);
    return { ok: true };
  });

  // Mobile Dev Cockpit (AI, workspaces, sessions): behind the same bearer token.
  const cockpit = new LocalCockpitHost({ log: o.log, ...(o.cockpit ?? {}) });
  registerCockpitAgentRoutes(app, cockpit);

  // Test Bench device bridge (the phone is plugged into this Mac).
  const devices = new DeviceBridge({
    log: o.log,
    scrcpyDir: o.scrcpyDir ?? join(process.cwd(), 'data', 'scrcpy'),
  });
  registerDeviceAgentRoutes(app, devices);
  registerFigmaAgentRoutes(app, o.figma);

  app.addHook('onClose', async () => {
    await devices.close();
    for (const run of runs.values()) run.proc.killGroup('SIGTERM');
    cockpit.close?.();
    // A new shim dir is made on every start: the old one must not pile up in the temp dir.
    if (glabShim) rmSync(glabShim, { recursive: true, force: true });
  });

  return app;
}

/**
 * Takes over the response: NDJSON, a heartbeat until `end`, and `signal` aborts when the client goes away first.
 */
function ndjson<T>(req: FastifyRequest, reply: FastifyReply) {
  const abort = new AbortController();
  let ended = false;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
  const write = (event: unknown) => {
    if (!ended && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const hb = setInterval(() => write({ t: 'hb' }), AGENT_HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(hb);
    if (!ended) abort.abort();
  });
  req.raw.on('aborted', () => abort.abort());
  return {
    signal: abort.signal,
    send: (event: T) => write(event),
    end: () => {
      ended = true;
      clearInterval(hb);
      if (!res.writableEnded) res.end();
    },
  };
}

function readFlutterVersion(): string | null {
  const l = launchSpec('flutter', ['--version']);
  const r = spawnSync(l.file, l.args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsVerbatimArguments: l.windowsVerbatimArguments,
  });
  if (r.status !== 0) return null;
  return r.stdout.split('\n')[0]?.trim() || null;
}

/** A directory holding a `glab` that reaches GitLab through the proxy, then runs the real one. Null without a glab. */
function makeGlabShim(proxy: string, log: Logger): string | null {
  const real = which('glab') ?? '';
  if (real === '') {
    log.warn('glab is not on PATH: vu will not be able to open or merge MRs');
    return null;
  }
  // The shim is a sh script: on Windows glab reaches GitLab directly (the release scripts need WSL there anyway).
  if (IS_WINDOWS) return null;
  const dir = mkdtempSync(join(tmpdir(), 'relay-agent-'));
  const shim = join(dir, 'glab');
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    shim,
    `#!/bin/sh\nexport HTTPS_PROXY=${q(proxy)} https_proxy=${q(proxy)}\nexec ${q(real)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}
