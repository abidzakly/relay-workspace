import { join, resolve } from 'node:path';
import { parseBuildPassEnv, resolveDataDir } from './config/env';
import { createHostAgent } from './hostAgent/server';
import { McpFigmaBridge } from './services/figma/bridgeClient';
import { defaultClonesRoot } from './services/gitExec';
import { moveLegacyDirs } from './config/legacyDirs';
import { createLogger } from './util/logger';
import { expandHome } from './util/platform';

/**
 * Host agent entry: `pnpm agent` on the Mac, while the dashboard runs in Docker. Reads the repo's `.env`:
 *   HOST_AGENT_TOKEN      required, the same value the dashboard has
 *   HOST_AGENT_PORT       default 3002, bound to 127.0.0.1 only (Docker Desktop forwards host.docker.internal to it)
 *   HOST_AGENT_GIT_PROXY  optional HTTP proxy git uses for the repo host (e.g. one that reaches a private network); unset = direct
 *   CLONES_DIR            default ~/.relay/clones, must match the dashboard's mount
 *   HOST_AGENT_WORKSPACE_ROOTS  cockpit workspaces must live under these (comma list), default ~/Work
 *   FIGMA_BRIDGE_CMD      default `npx -y @gethopp/figma-mcp-bridge`; started here so the Figma plugin on the Mac connects
 */

const log = createLogger({ level: process.env.LOG_LEVEL ?? 'info', pretty: true });
moveLegacyDirs(log);

const token = process.env.HOST_AGENT_TOKEN?.trim() ?? '';
if (token.length < 24) {
  log.fatal('HOST_AGENT_TOKEN is missing or shorter than 24 characters (set it in .env)');
  process.exit(1);
}
const port = Number(process.env.HOST_AGENT_PORT ?? 3002);
const proxyRaw = process.env.HOST_AGENT_GIT_PROXY?.trim() ?? '';
const gitProxy = proxyRaw === '' || proxyRaw === 'off' ? null : proxyRaw;
const clonesDir = process.env.CLONES_DIR?.trim();
const clonesRoot = clonesDir ? resolve(expandHome(clonesDir)) : defaultClonesRoot();
const passEnv = parseBuildPassEnv(process.env.BUILD_PASS_ENV);
if (passEnv === null) {
  log.fatal('BUILD_PASS_ENV is malformed');
  process.exit(1);
}

const scrcpyDir = join(resolveDataDir({ DATA_DIR: process.env.DATA_DIR }), 'scrcpy');
// The Figma bridge runs on the Mac next to the Figma desktop app, so the plugin can reach it on 127.0.0.1:1994.
// The dashboard in Docker reaches it through the agent's /v1/figma routes.
const figmaBridge = new McpFigmaBridge({ command: process.env.FIGMA_BRIDGE_CMD, log });
const app = await createHostAgent({
  token,
  log,
  clonesRoot,
  gitProxy,
  passEnv,
  scrcpyDir,
  figma: figmaBridge,
});
await app.listen({ host: '127.0.0.1', port });
// A failure here does not stop the agent: the Test Bench just reports the bridge as down.
figmaBridge.files().catch((err: unknown) => {
  log.warn({ err: err instanceof Error ? err.message : String(err) }, 'figma bridge did not start');
});
log.info(
  {
    port,
    clonesRoot,
    gitProxy,
    workspaceRoots: process.env.HOST_AGENT_WORKSPACE_ROOTS ?? '~/Work',
  },
  'host agent listening',
);

const stop = () => {
  void Promise.all([app.close(), figmaBridge.close()]).then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
