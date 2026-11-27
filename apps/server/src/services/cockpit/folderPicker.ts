import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * The computer's own "choose a folder" dialog, for Settings > Workspaces. Runs where the folders are: in-process when
 * the dashboard runs on the Mac, inside the host agent when the dashboard runs in Docker. macOS uses AppleScript's
 * `choose folder`, Linux `zenity`, Windows PowerShell's `FolderBrowserDialog`. Anything else (or no desktop session) answers `unsupported` and the form falls back
 * to typing the path. Only one dialog is open at a time; a second click waits for the same answer.
 */

export type NativeFolderPick =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason: string };

/** Long enough to browse; short enough that a forgotten dialog does not hold the request forever. */
const PICK_TIMEOUT_MS = 5 * 60_000;
const PROMPT = 'Choose the repository folder for this workspace';

// `activate` brings osascript's own dialog in front of the browser. The start folder and the prompt come in as
// arguments, never spliced into the script.
const MAC_SCRIPT = [
  'on run argv',
  'activate',
  'set startAt to POSIX file (item 1 of argv)',
  'return POSIX path of (choose folder with prompt (item 2 of argv) default location startAt)',
  'end run',
];

// The start folder and the prompt come in through environment variables, never spliced into the script. A topmost
// owner form brings the dialog in front of the browser. Cancel exits 1.
const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:RELAY_PICK_PROMPT',
  '$d.SelectedPath = $env:RELAY_PICK_START',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
  "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }",
].join('; ');

let pending: Promise<NativeFolderPick> | null = null;

/** `prompt` is a fixed string from the caller (default: the workspace one), never user input. */
export function pickFolderNative(
  startAt: string | undefined,
  prompt: string = PROMPT,
): Promise<NativeFolderPick> {
  pending ??= run(startAt, prompt).finally(() => {
    pending = null;
  });
  return pending;
}

function run(startAt: string | undefined, prompt: string): Promise<NativeFolderPick> {
  const start = startAt && existsSync(startAt) ? startAt : homedir();
  if (process.platform === 'darwin') {
    return exec(
      'osascript',
      MAC_SCRIPT.flatMap((l) => ['-e', l]).concat(start, prompt),
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
      ['--file-selection', '--directory', `--title=${prompt}`, `--filename=${start}/`],
      (code) => code === 1,
    );
  }
  if (process.platform === 'win32') {
    return exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT],
      (code) => code === 1,
      { RELAY_PICK_START: start, RELAY_PICK_PROMPT: prompt },
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
  env?: Record<string, string>,
): Promise<NativeFolderPick> {
  return new Promise((resolve) => {
    const opts = {
      timeout: PICK_TIMEOUT_MS,
      encoding: 'utf8' as const,
      windowsHide: true,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    };
    execFile(cmd, args, opts, (err, stdout, stderr) => {
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
