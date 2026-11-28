import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IS_WINDOWS, which } from '../../util/platform';
import { CockpitHostError } from './host';

/**
 * The browser of an AI web test: Playwright MCP (`@playwright/mcp`, pinned in this package) on the Chrome already on
 * the Mac, headless, with a profile kept in memory (`--isolated`). Nothing is downloaded at run time.
 *
 * - It runs with its working directory in the run's own temp folder (`--ignore-roots`), so screenshots, named or not,
 *   land there and never in the repo. Relay reads the newest one as the evidence of a mark or a finding.
 * - `--init-page` installs a guard: a top-level navigation to another origin than the dev server's is aborted, and a
 *   redirect that still gets out is sent back. Requests the page makes itself (its API on another host, fonts) go
 *   through, or the app could not be tested. Playwright's own `--allowed-origins` would block those too, and it is
 *   documented as no security boundary.
 */

export const PLAYWRIGHT_MCP_NAME = 'playwright';

/** Tools of the browser the tester never gets: page scripts, the file system, installing a browser. */
export const WEB_TEST_DENIED_TOOLS = [
  'browser_evaluate',
  'browser_run_code',
  'browser_file_upload',
  'browser_install',
  'browser_pdf_save',
].map((t) => `mcp__${PLAYWRIGHT_MCP_NAME}__${t}`);

const RUN_ID_RE = /^[0-9a-f-]{36}$/;

/** The run's temp folder: screenshots and the navigation guard. Removed with the session. */
export function webRunDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new CockpitHostError('validation', 'invalid run id', 422);
  return join(tmpdir(), `cockpit-bench-web-${runId}`);
}

const CHROME_PATHS = IS_WINDOWS
  ? [
      join(
        process.env.PROGRAMFILES ?? 'C:\\Program Files',
        'Google\\Chrome\\Application\\chrome.exe',
      ),
      join(
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        'Google\\Chrome\\Application\\chrome.exe',
      ),
      join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]
  : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

function playwrightCache(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright');
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : join(homedir(), '.cache', 'ms-playwright');
}

/** `chrome` when Google Chrome is installed, else Playwright's own Chromium if it was installed once. */
export function pickBrowser(): 'chrome' | 'chromium' {
  if (CHROME_PATHS.some((p) => p && existsSync(p))) return 'chrome';
  if (!IS_WINDOWS && (which('google-chrome') || which('google-chrome-stable'))) return 'chrome';
  try {
    if (readdirSync(playwrightCache()).some((d) => d.startsWith('chromium'))) return 'chromium';
  } catch {
    /* no cache */
  }
  throw new CockpitHostError(
    'browser_missing',
    'Testing a web app needs Google Chrome on this Mac (or run `npx playwright install chromium` once).',
    409,
  );
}

/** The init-page script: the navigation guard, for `origin` only. */
function guardScript(origin: string): string {
  return `// Written by Relay for one AI web test. Keeps the browser on ${origin}.
const ALLOWED = ${JSON.stringify(origin)};
const okUrl = (u) => {
  try {
    const url = new URL(u);
    return url.origin === ALLOWED || url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:';
  } catch {
    return false;
  }
};
export default async ({ page }) => {
  const ctx = page.context();
  if (!ctx.__relayGuard) {
    ctx.__relayGuard = true;
    await ctx.route('**/*', (route) => {
      const req = route.request();
      let top = false;
      try {
        top = req.isNavigationRequest() && req.frame().parentFrame() === null;
      } catch {
        top = false;
      }
      if (top && !okUrl(req.url())) return route.abort('blockedbyclient');
      return route.fallback();
    });
  }
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && !okUrl(frame.url())) void page.goto(ALLOWED).catch(() => {});
  });
};
`;
}

/** Makes the run's folder (0700) with its guard; returns the MCP server entry for the test's config. */
export function playwrightServer(
  runId: string,
  url: string,
  tsxServer: (script: string) => { command: string; args: string[] },
  serverRoot: string,
): { command: string; args: string[]; env: Record<string, string> } {
  const origin = new URL(url).origin;
  const browser = pickBrowser();
  const dir = webRunDir(runId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const guard = join(dir, 'relay-guard.ts');
  writeFileSync(guard, guardScript(origin), { mode: 0o600 });
  const req = createRequire(join(serverRoot, 'package.json'));
  const pkgFile = req.resolve('@playwright/mcp/package.json');
  const bin = (
    JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin: string | Record<string, string> }
  ).bin;
  const cli = join(
    dirname(pkgFile),
    typeof bin === 'string' ? bin : (bin['playwright-mcp'] ?? 'cli.js'),
  );
  const base = tsxServer(join(serverRoot, 'src', 'agentTools', 'playwrightMcp.ts'));
  return {
    command: base.command,
    args: [
      ...base.args,
      '--browser',
      browser,
      '--headless',
      '--isolated',
      '--ignore-roots',
      '--output-dir',
      dir,
      '--init-page',
      guard,
      '--viewport-size',
      '1280x800',
      '--console-level',
      'error',
    ],
    env: { RELAY_PW_DIR: dir, RELAY_PW_CLI: cli },
  };
}

/** PNG only: evidence is served as `NNN.png`. The prompt asks for the default format. */
const SHOT_RE = /\.png$/i;

/** The newest screenshot the browser saved after `since` (epoch ms); null when there is none. */
export async function latestWebShot(runId: string, since: number): Promise<Buffer | null> {
  const dir = webRunDir(runId);
  let best: { path: string; at: number } | null = null;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!SHOT_RE.test(name)) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs <= since || s.size > 20 * 1024 * 1024) continue;
    if (!best || s.mtimeMs > best.at) best = { path: join(dir, name), at: s.mtimeMs };
  }
  return best ? readFile(best.path) : null;
}
