import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The computer's own "choose a folder" dialog, for Settings > Workspaces. Runs where the folders are: in-process when
 * the dashboard runs on the Mac, inside the host agent when the dashboard runs in Docker. macOS uses AppleScript's
 * `choose folder`, Linux `zenity`. Anything else (or no desktop session) answers `unsupported` and the form falls back
 * to typing the path. Only one dialog is open at a time; a second click waits for the same answer.
 */

export type NativeFolderPick =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason: string };

/** Long enough to browse; short enough that a forgotten dialog does not hold the request forever. */
const PICK_TIMEOUT_MS = 5 * 60_000;
const PROMPT = 'Choose the repository folder for this workspace';

// `activate` brings osascript's own dialog in front of the browser. The start folder comes in as an argument, never
// spliced into the script.
const MAC_SCRIPT = [
  'on run argv',
  'activate',
  'set startAt to POSIX file (item 1 of argv)',
  `return POSIX path of (choose folder with prompt "${PROMPT}" default location startAt)`,
  'end run',
];

let pending: Promise<NativeFolderPick> | null = null;

export function pickFolderNative(startAt: string | undefined): Promise<NativeFolderPick> {
  pending ??= run(startAt).finally(() => {
    pending = null;
  });
  return pending;
}

function run(startAt: string | undefined): Promise<NativeFolderPick> {
  const start = startAt && existsSync(startAt) ? startAt : (process.env.HOME ?? '/');
  if (process.platform === 'darwin') {
    return exec(
      'osascript',
      MAC_SCRIPT.flatMap((l) => ['-e', l]).concat(start),
      (code, stderr) => code === 1 && /-128/.test(stderr),
    );
  }
  if (process.platform === 'linux') {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return Promise.resolve({
        status: 'unsupported',
        reason: 'No desktop session on this computer.',
      });
    }
    return exec(
      'zenity',
      ['--file-selection', '--directory', `--title=${PROMPT}`, `--filename=${start}/`],
      (code) => code === 1,
    );
  }
  return Promise.resolve({
    status: 'unsupported',
    reason: 'No folder dialog on this system yet.',
  });
}

function exec(
  cmd: string,
  args: string[],
  isCancel: (code: number | null, stderr: string) => boolean,
): Promise<NativeFolderPick> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: PICK_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) {
        const path = stdout.trim().replace(/(.)\/+$/, '$1');
        resolve(path ? { status: 'picked', path } : { status: 'cancelled' });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (e.code === 'ENOENT') {
        resolve({ status: 'unsupported', reason: `${cmd} is not installed.` });
        return;
      }
      const code = typeof e.code === 'number' ? e.code : null;
      if (e.killed || isCancel(code, stderr)) {
        resolve({ status: 'cancelled' });
        return;
      }
      resolve({
        status: 'unsupported',
        reason: stderr.trim().split('\n').pop() || 'The folder dialog could not open.',
      });
    });
  });
}
