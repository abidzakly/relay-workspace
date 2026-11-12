import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * The few places that differ between macOS/Linux and Windows. Everything that looks up a program, expands `~`, stops
 * a process tree or picks a shell goes through here, so the rest of the code never assumes `/bin/sh` or `:`.
 */

export const IS_WINDOWS = process.platform === 'win32';

/** Full path of a program on PATH (with PATHEXT on Windows), or null. Never runs a shell. */
export function which(bin: string, path = process.env.PATH ?? ''): string | null {
  const exts = IS_WINDOWS
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** `~`, `~/x` and (on Windows) `~\x` become paths under the home directory; anything else is returned as is. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || (IS_WINDOWS && p.startsWith('~\\'))) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Signal a process and everything it started. POSIX: the process group (`-pid`; the child was spawned detached).
 * Windows has no groups or signals: `taskkill /T` ends the tree. Never throws.
 */
export function signalTree(pid: number, sig: NodeJS.Signals, fallback?: () => void): void {
  if (IS_WINDOWS) {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    if (r.status !== 0) fallback?.();
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      fallback?.();
    } catch {
      // Already gone.
    }
  }
}

/** The interactive shell for a terminal session: `$SHELL`, else zsh, else bash; PowerShell on Windows. */
export function defaultShell(): { file: string; args: string[] } {
  if (IS_WINDOWS) {
    return { file: which('pwsh') ?? which('powershell') ?? 'powershell.exe', args: ['-NoLogo'] };
  }
  const env = process.env.SHELL;
  if (env && /\/(zsh|bash|fish|sh)$/.test(env)) return { file: env, args: ['-l'] };
  return { file: existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash', args: ['-l'] };
}

/** What `spawn` / `spawnSync` / `execFile` should run: the same program, or `cmd.exe` around a Windows launcher. */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Set for the `cmd.exe` form: the arguments are already quoted for it. */
  windowsVerbatimArguments?: true;
}

// cmd.exe metacharacters, escaped with `^` (the same rules as the cross-spawn package).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function cmdArg(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return doubleEscape ? a.replace(CMD_META, '^$1') : a;
}

/**
 * On Windows, programs such as `flutter.bat`, `claude.cmd` and `npx.cmd` are batch launchers, which Node refuses to
 * start without a shell. This runs them through `cmd.exe /d /s /c` with every argument quoted and escaped, so no
 * argument is ever read as a command. Everywhere else, and for real executables, the program runs as given.
 */
export function launchSpec(file: string, args: readonly string[]): LaunchSpec {
  if (!IS_WINDOWS) return { file, args: [...args] };
  const resolved = /[\\/]/.test(file) ? file : (which(file) ?? file);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args: [...args] };
  // npm's `.cmd` shims pass their arguments through a second cmd.exe, so they need the escaping twice.
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [
    resolved.replace(CMD_META, '^$1'),
    ...args.map((a) => cmdArg(a, doubleEscape)),
  ].join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}
