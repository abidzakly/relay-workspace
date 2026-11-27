import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ScriptsDirPick, ScriptsStatus } from '@relay/shared';
import { pickFolderNative } from './cockpit/folderPicker';
import { resolveVuBinDir, saveChosenScriptsDir, scriptsExecutable } from './scriptConfig';
import { IS_WINDOWS, which } from '../util/platform';

/**
 * The machine that runs the release scripts: this one, or the Mac behind the host agent when the dashboard runs in
 * Docker. Which `vu` runs and which tools are missing must be checked THERE: a container has neither `~/bin/vu` nor the
 * Mac's glab, jq or flutter, so checking in-process reported them missing although releases ran fine.
 */
export interface ScriptsHostStatus {
  vu: ScriptsStatus['vu'];
  missingTools: string[];
  hostError?: string;
}

export interface ScriptsHost {
  status(): Promise<ScriptsHostStatus>;
  /** Opens the folder dialog (or takes a typed path, where allowed) and remembers the folder holding `vu`. */
  chooseDir(path: string | undefined): Promise<ScriptsDirPick>;
}

/**
 * Tools the scripts call. Missing ones are listed in Settings, never fatal here. On Windows the scripts do not run (the
 * custom engine is bash), so only what the native engine itself starts is listed: glab and jq are not needed there.
 */
const TOOLS = IS_WINDOWS
  ? (['git', 'flutter'] as const)
  : (['glab', 'git', 'jq', 'flutter'] as const);

const PROMPT = 'Choose the folder that holds the release scripts (vu, mrc, vcheck, nts, reauthor)';

/** Checked in this process: right when this process runs on the machine that runs the scripts. */
export function localScriptsStatus(): ScriptsHostStatus {
  const vu = resolveVuBinDir();
  const vuPath = join(vu.dir, 'vu');
  return {
    vu: {
      path: scriptsExecutable(vuPath) ? vuPath : null,
      bundled: vu.bundled,
      ...(vu.chosen ? { chosen: true } : {}),
    },
    missingTools: TOOLS.filter((t) => which(t) === null),
  };
}

const expandHome = (p: string) =>
  p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;

/**
 * The folder dialog, or a typed path when `allowTyped` (only in the dashboard's own process: the host agent takes a
 * folder only from its own dialog, so the dashboard can never point it at another executable).
 */
export async function chooseScriptsDirLocal(
  typed: string | undefined,
  allowTyped: boolean,
): Promise<ScriptsDirPick> {
  let dir: string;
  if (typed !== undefined) {
    if (!allowTyped) return { status: 'invalid', reason: 'Choose the folder in the dialog.' };
    const p = expandHome(typed.trim());
    if (!isAbsolute(p)) return { status: 'invalid', reason: 'Type a full path, e.g. ~/bin.' };
    dir = resolve(p);
  } else {
    const start = resolveVuBinDir().dir;
    const r = await pickFolderNative(start, PROMPT);
    if (r.status !== 'picked') return r;
    dir = r.path;
  }
  try {
    saveChosenScriptsDir(dir);
  } catch (e) {
    return { status: 'invalid', reason: (e as Error).message };
  }
  return { status: 'picked', path: dir };
}

export class LocalScriptsHost implements ScriptsHost {
  status(): Promise<ScriptsHostStatus> {
    return Promise.resolve(localScriptsStatus());
  }
  chooseDir(path: string | undefined): Promise<ScriptsDirPick> {
    return chooseScriptsDirLocal(path, true);
  }
}
