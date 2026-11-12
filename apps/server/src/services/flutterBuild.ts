import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  FLAVOR_RE,
  isSafeVersion,
  type BuildArtifact,
  type BuildMode,
  type FlavorDetection,
} from '@relay/shared';
import { ActionError } from './actionError';
import type { AllowedCommand } from './gitExec';
import { readPubspecVersion } from './versionCalc';

/**
 * What to build and what to call it: flavor detection like `vu`, the rename and label map of
 * `flutter_launcher.sh`. Nothing here runs a command. The queue does, through `GitExec`.
 */

export class BuildError extends ActionError {
  constructor(code: string, message: string, details?: unknown, status = 409) {
    super(status, code, message, details);
    this.name = 'BuildError';
  }
}

const PRODUCTION_FLAVOR = 'production';
const AUTO_FLAVOR = 'auto';
const ENTRYPOINT_RE = /^main_(.+)\.dart$/;

// ───────────────────────────── Flavor ─────────────────────────────

/** A request that is wrong whatever the clone holds. */
export function assertRequestedFlavor(buildMode: BuildMode, requested: string | null): void {
  if (requested === null) return;
  if (!FLAVOR_RE.test(requested) || requested === AUTO_FLAVOR) {
    throw new BuildError('invalid_flavor', 'Invalid flavor', undefined, 422);
  }
  if (buildMode === 'prod' && requested !== PRODUCTION_FLAVOR) {
    throw new BuildError('invalid_flavor', 'A prod build always uses production', undefined, 422);
  }
  if (buildMode === 'staging' && requested === PRODUCTION_FLAVOR) {
    throw new BuildError('invalid_flavor', 'A staging build cannot use production', undefined, 422);
  }
}

/** The flavors with a `lib/main_<flavor>.dart` file in this clone. A clone with no `lib` has none. */
export async function listEntrypoints(clonePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(clonePath, 'lib'), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ENTRYPOINT_RE.exec(entry.name)?.[1] ?? '')
    .filter((flavor) => FLAVOR_RE.test(flavor))
    .sort();
}

/**
 * Prod is always production, whichever files exist (as in `vu`). Staging: the user's pick, then a flavor set in Settings,
 * then `vu`'s rule: only staging or only development decides, and both or neither leaves `flavor` null for the UI.
 * A picked flavor must exist. Falling back to another one would build something the user did not ask for.
 */
export function decideFlavor(input: {
  buildMode: BuildMode;
  requested: string | null;
  configured: string;
  entrypoints: readonly string[];
}): FlavorDetection {
  const { buildMode, requested, entrypoints } = input;
  const candidates = entrypoints.filter((flavor) => flavor !== PRODUCTION_FLAVOR);
  const must = (flavor: string, reason: FlavorDetection['reason']): FlavorDetection => {
    if (!entrypoints.includes(flavor)) {
      throw new BuildError(
        'entrypoint_missing',
        `lib/main_${flavor}.dart does not exist in the clone`,
        { flavor, candidates },
      );
    }
    return { flavor, reason, candidates };
  };

  assertRequestedFlavor(buildMode, requested);
  if (buildMode === 'prod') return must(PRODUCTION_FLAVOR, 'production');
  if (requested !== null) return must(requested, 'requested');
  if (input.configured !== AUTO_FLAVOR) {
    assertRequestedFlavor(buildMode, input.configured);
    return must(input.configured, 'configured');
  }

  const staging = entrypoints.includes('staging');
  const development = entrypoints.includes('development');
  if (staging && !development) return { flavor: 'staging', reason: 'only_staging', candidates };
  if (development && !staging) {
    return { flavor: 'development', reason: 'only_development', candidates };
  }
  return { flavor: null, reason: staging ? 'both' : 'neither', candidates };
}

export function flavorChoiceRequired(detection: FlavorDetection): BuildError {
  return new BuildError(
    'flavor_choice_required',
    'Choose a flavor: this repo has both or neither of lib/main_staging.dart and lib/main_development.dart',
    detection,
  );
}

// ───────────────────────────── Naming ─────────────────────────────

/** `get_flavor_label` of `flutter_launcher.sh`, which also maps preproduction. Another flavor is its own label. */
export function flavorLabel(flavor: string): string {
  switch (flavor) {
    case 'development':
    case 'staging':
      return 'Staging';
    case 'preprod':
    case 'preproduction':
      return 'Preprod';
    case 'production':
      return 'Production';
    case 'playground':
      return 'Playground';
    default:
      return flavor;
  }
}

/** `my_cool_app` -> `My Cool App`, as the script: only the first letter of each word changes. */
export function prettifyAppName(pubspecName: string): string {
  return pubspecName
    .replaceAll('_', ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The script's `grep ^name:`, without quotes. It also drops a trailing comment, which the script would keep. */
export function readPubspecName(pubspecText: string): string | null {
  const raw = /^name:[ \t]*(.*)$/m.exec(pubspecText)?.[1] ?? '';
  const value = raw
    .replace(/\s+#.*$/, '')
    .replace(/["'\r]/g, '')
    .trim();
  return value === '' ? null : value;
}

/** `<AppName> <FlavorLabel> v<version>.<ext>`. The name is free text from Settings or a pubspec, so it cannot hold a path. */
export function artifactFileName(
  appName: string,
  flavor: string,
  version: string,
  ext: 'apk' | 'aab',
): string {
  // eslint-disable-next-line no-control-regex
  const safeName = appName.replace(/[/\\]/g, '-').replace(/[\u0000-\u001f\u007f]/g, '');
  return `${safeName} ${flavorLabel(flavor)} v${version}.${ext}`;
}

/** The name and version a build labels its files with, read before the build so a bad one costs no build time. */
export async function readBuildIdentity(
  clonePath: string,
  configuredAppName: string | null,
): Promise<{ appName: string; version: string }> {
  const path = join(clonePath, 'pubspec.yaml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new BuildError('pubspec_missing', 'Cannot read pubspec.yaml in the clone');
  }
  const version = readPubspecVersion(text);
  if (version === null || !isSafeVersion(version)) {
    throw new BuildError('pubspec_version_invalid', 'pubspec.yaml has no usable version');
  }
  const pubspecName = readPubspecName(text);
  const appName = configuredAppName ?? (pubspecName ? prettifyAppName(pubspecName) : '');
  if (appName === '') {
    throw new BuildError(
      'app_name_missing',
      'pubspec.yaml has no name. Set the app name in Settings.',
    );
  }
  return { appName, version };
}

// ───────────────────────────── Commands ─────────────────────────────

export interface BuildCommand {
  kind: BuildArtifact['kind'];
  /** Without the `fvm` prefix. */
  flutterArgs: string[];
  /** Relative to the clone. */
  sourcePath: string;
}

/** Staging builds an APK, prod an APK and then an AAB. */
export function buildCommands(buildMode: BuildMode, flavor: string): BuildCommand[] {
  const flags = ['-t', `lib/main_${flavor}.dart`, '--flavor', flavor, '--release'];
  const apk: BuildCommand = {
    kind: 'apk',
    flutterArgs: ['build', 'apk', ...flags],
    sourcePath: `build/app/outputs/flutter-apk/app-${flavor}-release.apk`,
  };
  const aab: BuildCommand = {
    kind: 'aab',
    flutterArgs: ['build', 'appbundle', ...flags],
    sourcePath: `build/app/outputs/bundle/${flavor}Release/app-${flavor}-release.aab`,
  };
  return buildMode === 'prod' ? [apk, aab] : [apk];
}

export function flutterInvocation(
  useFvm: boolean,
  flutterArgs: readonly string[],
): { command: AllowedCommand; args: string[] } {
  return useFvm
    ? { command: 'fvm', args: ['flutter', ...flutterArgs] }
    : { command: 'flutter', args: [...flutterArgs] };
}

// ───────────────────────────── After a build ─────────────────────────────

/**
 * Duplicates the output under its new name next to the original, as the script does, then copies it to
 * `data/apks/<repo>/`. The copy lands under a temporary name first, so a download never sees half a file. Rebuilding a
 * version replaces its file. An output that is missing fails the build: the script only warned, but later steps need it.
 */
export async function collectArtifact(input: {
  clonePath: string;
  apksDir: string;
  repoId: string;
  command: BuildCommand;
  fileName: string;
}): Promise<BuildArtifact> {
  const source = join(input.clonePath, input.command.sourcePath);
  const info = await lstat(source).catch(() => null);
  if (!info?.isFile()) {
    throw new BuildError(
      'artifact_missing',
      `The build succeeded, but ${input.command.sourcePath} is not there. Do the flavor and Flutter's output name match?`,
    );
  }
  await copyFile(source, join(dirname(source), input.fileName));

  const destDir = join(input.apksDir, input.repoId);
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, input.fileName);
  const temp = join(destDir, `.${randomUUID()}.partial`);
  try {
    await copyFile(source, temp);
    await rename(temp, dest);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
  return {
    kind: input.command.kind,
    fileName: input.fileName,
    path: dest,
    sizeBytes: (await stat(dest)).size,
  };
}
