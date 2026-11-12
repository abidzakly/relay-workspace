import { isSafeBranchPrefix, isSafeReleaseRef } from '@relay/shared';
import { ActionError } from './actionError';
import { isVersionBranch } from './versionMr';

/**
 * Port of `vu`'s version logic: reading pubspec's `version:`, the bump, the manual override and the commit
 * version. Pure: the clock is a parameter and nothing here touches git or the disk. `vu`'s line order is kept on
 * purpose: the computed bump can fail (unsupported format/build) even when an override would replace its result.
 */

export type ReleaseMode = 'staging' | 'prod';

export class VersionCalcError extends ActionError {
  constructor(code: string, message: string) {
    super(422, code, message);
    this.name = 'VersionCalcError';
  }
}

export interface ParsedVersion {
  /** The whole version, quotes already removed. */
  raw: string;
  /** Everything before the first `+`. */
  baseVersion: string;
  /** `X.Y.Z`, as written. */
  releaseVersion: string;
  major: string;
  minor: string;
  patch: string;
  /** Digits as written; `0` when there is no alpha or a bare `-alpha`. */
  alpha: string;
  /** Everything after the first `+`; empty when absent. */
  build: string;
}

export interface VersionPlan {
  mode: ReleaseMode;
  current: string;
  /** What the bump computes, before any override. */
  proposed: string;
  /** The final version: what pubspec.yaml gets. */
  newVersion: string;
  /** Used for the commit message and tag. Staging drops `+build`, prod keeps it. */
  commitVersion: string;
  overridden: boolean;
}

export interface VersionPreview extends VersionPlan {
  branch: string;
  commitMessage: string;
  tag: string;
}

const WITH_ALPHA_NUMBER_RE = /^([0-9]+\.[0-9]+\.[0-9]+)-alpha[-.]?([0-9]+)$/;
const BARE_ALPHA_RE = /^([0-9]+\.[0-9]+\.[0-9]+)-alpha$/;
const RELEASE_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** `vu`'s validate_version. */
const OVERRIDE_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** `sed -E 's/^[[:space:]]*version:[[:space:]]*([^[:space:]#]+).*\/\1/p'`, applied one line at a time. */
const PUBSPEC_VERSION_LINE_RE = /^[ \t\r\f\v]*version:[ \t\r\f\v]*([^ \t\r\f\v#]+)/;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `vu` strips each quote kind from each end independently, so mismatched quotes also go. */
function stripQuotes(s: string): string {
  let out = s;
  for (const quote of ['"', "'"]) {
    if (out.endsWith(quote)) out = out.slice(0, -1);
    if (out.startsWith(quote)) out = out.slice(1);
  }
  return out;
}

/** The first `version:` line of a pubspec (indented lines count, as in `vu`), unquoted. Null when there is none. */
export function readPubspecVersion(pubspecText: string): string | null {
  for (const line of pubspecText.split('\n')) {
    const value = PUBSPEC_VERSION_LINE_RE.exec(line)?.[1];
    if (value) return stripQuotes(value);
  }
  return null;
}

/** Accepts `X.Y.Z`, `-alpha`, `-alpha-N`, `-alpha.N`, `-alphaN`, each with optional `+build`, and optional quotes. */
export function parseVersion(version: string): ParsedVersion {
  const raw = stripQuotes(version);
  const plus = raw.indexOf('+');
  const baseVersion = plus === -1 ? raw : raw.slice(0, plus);
  const build = plus === -1 ? '' : raw.slice(plus + 1);

  let releaseVersion = baseVersion;
  let alpha = '0';
  const numbered = WITH_ALPHA_NUMBER_RE.exec(baseVersion);
  const bare = BARE_ALPHA_RE.exec(baseVersion);
  if (numbered) {
    releaseVersion = numbered[1] ?? '';
    alpha = numbered[2] ?? '0';
  } else if (bare) {
    releaseVersion = bare[1] ?? '';
  } else if (!RELEASE_RE.test(baseVersion)) {
    throw new VersionCalcError('unsupported_version_format', `Unsupported version format: ${raw}`);
  }

  const [major = '', minor = '', patch = ''] = releaseVersion.split('.');
  return { raw, baseVersion, releaseVersion, major, minor, patch, alpha, build };
}

/**
 * +1 on digits, in decimal. BigInt, so long numeric builds keep every digit. `vu`'s bash arithmetic reads a leading
 * zero as octal (`010` -> 9, `09` -> crash), which cannot be intended; refused rather than guessed.
 */
function increment(digits: string, label: string): string {
  if (/^0[0-9]/.test(digits)) {
    throw new VersionCalcError(
      'ambiguous_leading_zero',
      `${label} "${digits}" has a leading zero, so the next value is ambiguous. Enter the version manually.`,
    );
  }
  return (BigInt(digits) + 1n).toString();
}

function nextProdBuild(build: string, now: Date): string {
  if (build === '') return '1';
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  if (/^[0-9]{12}$/.test(build)) return `${date}${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  if (/^[0-9]{8}$/.test(build)) return date;
  if (/^[0-9]+$/.test(build)) return increment(build, 'Build number');
  throw new VersionCalcError(
    'unsupported_build_format',
    `Unsupported build number format: +${build}`,
  );
}

function bump(mode: ReleaseMode, v: ParsedVersion, now: Date): string {
  if (mode === 'staging') {
    return withBuild(`${v.releaseVersion}-alpha-${increment(v.alpha, 'Alpha number')}`, v.build);
  }
  const patch = increment(v.patch, 'Patch number');
  return `${v.major}.${v.minor}.${patch}+${nextProdBuild(v.build, now)}`;
}

function withBuild(version: string, build: string): string {
  return build === '' ? version : `${version}+${build}`;
}

/** Staging + bare number = the alpha number (`1` -> `X.Y.Z-alpha-1[+build]`). Anything else is taken verbatim. */
function resolveOverride(mode: ReleaseMode, input: string, v: ParsedVersion): string {
  if (mode === 'staging' && /^[0-9]+$/.test(input)) {
    return withBuild(`${v.releaseVersion}-alpha-${input}`, v.build);
  }
  return input;
}

export function isValidVersionOverride(version: string): boolean {
  return OVERRIDE_RE.test(version);
}

/**
 * `vu`'s pubspec rewrite: first line matching `^(\\s*version:\\s*)["']?<old>["']?(\\s*(?:#.*)?)$`, multiline. Quotes around the
 * old value are dropped and everything else is kept. Unlike `vu`, whose Python text mode rewrites CRLF files to LF,
 * line endings are left alone. Callers still verify the result with `readPubspecVersion`.
 */
export function bumpPubspecText(text: string, oldVersion: string, newVersion: string): string {
  const old = oldVersion.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  const re = new RegExp(`^(\\s*version:\\s*)["']?${old}["']?(\\s*(?:#.*)?)$`, 'm');
  if (!re.test(text)) {
    throw new VersionCalcError(
      'pubspec_replace_failed',
      `Could not replace version '${oldVersion}' in pubspec.yaml`,
    );
  }
  return text.replace(re, (_m, head: string, tail: string) => `${head}${newVersion}${tail}`);
}

/** Staging commits and tags omit `+build`; prod uses the full version (`v2.1.2+52`). */
export function commitVersionOf(mode: ReleaseMode, version: string): string {
  if (mode === 'prod') return version;
  const plus = version.indexOf('+');
  return plus === -1 ? version : version.slice(0, plus);
}

export interface VersionCalcInput {
  mode: ReleaseMode;
  current: string;
  /** Replaces the computed version. Empty = none, as in `vu`. */
  override?: string | null;
  now?: Date;
}

export function computeVersion(input: VersionCalcInput): VersionPlan {
  const { mode, override } = input;
  const parsed = parseVersion(input.current);
  const proposed = bump(mode, parsed, input.now ?? new Date());

  let newVersion = proposed;
  const overridden = override !== undefined && override !== null && override !== '';
  if (overridden) {
    newVersion = resolveOverride(mode, override, parsed);
    if (!isValidVersionOverride(newVersion)) {
      throw new VersionCalcError('invalid_version_override', `Invalid version: ${newVersion}`);
    }
  }
  if (newVersion === parsed.raw) {
    throw new VersionCalcError(
      'version_unchanged',
      `New version is identical to the current version (${parsed.raw}); nothing to update.`,
    );
  }
  return {
    mode,
    current: parsed.raw,
    proposed,
    newVersion,
    commitVersion: commitVersionOf(mode, newVersion),
    overridden,
  };
}

/** `<prefix><version>`. A computed staging version keeps whatever build pubspec had, so it is checked here too. */
export function versionBranchName(versionBranchPrefix: string, version: string): string {
  const branch = `${versionBranchPrefix}${version}`;
  if (
    !isSafeBranchPrefix(versionBranchPrefix) ||
    !isVersionBranch(branch, versionBranchPrefix) ||
    !isSafeReleaseRef(branch)
  ) {
    throw new VersionCalcError(
      'unsafe_version_ref',
      `Version "${version}" cannot be used in a branch name.`,
    );
  }
  return branch;
}

export function versionTagName(tagFormat: string, commitVersion: string): string {
  const tag = tagFormat.replace('{commitVersion}', () => commitVersion);
  if (!isSafeReleaseRef(tag)) {
    throw new VersionCalcError(
      'unsafe_version_ref',
      `Version "${commitVersion}" cannot be used in a tag name.`,
    );
  }
  return tag;
}

export interface VersionPreviewInput {
  mode: ReleaseMode;
  pubspecText: string;
  versionBranchPrefix: string;
  tagFormat?: string;
  override?: string | null;
  now?: Date;
}

/** The entry point for releases: everything derived from the final version, with all names validated. */
export function previewVersion(input: VersionPreviewInput): VersionPreview {
  const current = readPubspecVersion(input.pubspecText);
  if (!current) {
    throw new VersionCalcError(
      'pubspec_version_missing',
      "Could not find a 'version:' entry in pubspec.yaml.",
    );
  }
  const plan = computeVersion({
    mode: input.mode,
    current,
    override: input.override,
    now: input.now,
  });
  return {
    ...plan,
    branch: versionBranchName(input.versionBranchPrefix, plan.newVersion),
    commitMessage: `v${plan.commitVersion}`,
    tag: versionTagName(input.tagFormat ?? 'v{commitVersion}', plan.commitVersion),
  };
}

/**
 * `vu`'s resume rule: mode and version are read back from an open MR's branch name. Any `-alpha` means staging, and
 * only then is `+build` dropped. A staging override without `-alpha` therefore resumes as prod, as it does in `vu`.
 */
export function versionFromBranch(
  branch: string,
  versionBranchPrefix: string,
): { mode: ReleaseMode; newVersion: string; commitVersion: string } | null {
  if (!isVersionBranch(branch, versionBranchPrefix) || !isSafeReleaseRef(branch)) return null;
  const newVersion = branch.slice(versionBranchPrefix.length);
  const mode: ReleaseMode = newVersion.includes('-alpha') ? 'staging' : 'prod';
  return { mode, newVersion, commitVersion: commitVersionOf(mode, newVersion) };
}
