import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import {
  SIGNING_FILE_MAX_BYTES,
  type SigningStatus,
  type SigningUploadRequest,
} from '@relay/shared';
import type { AuditWriter } from '../audit/auditLog';
import type { ConfigStore } from '../config/store';
import type { Logger } from '../util/logger';
import { ActionError } from './actionError';
import type { GitExec } from './gitExec';
import type { JobStore } from './jobStore';

/**
 * Puts a repo's Android signing files into its bot clone, so a build that failed for lack of them can go on without
 * anyone touching the disk. The repo's own Gradle files and `key.properties` say which names and places are right.
 *
 * Files land only inside the clone and only where git ignores them: `git clean -fd` then leaves them alone, and no commit
 * can pick them up. File contents are never logged, audited or echoed in an error.
 */

const ANDROID_DIR = 'android';
const APP_DIR = 'android/app';
const GRADLE_FILES = ['build.gradle', 'build.gradle.kts'];
const PROPERTIES_REF_RE = /rootProject\.file\(\s*['"]([^'"]+\.properties)['"]\s*\)/g;
const SAFE_RELATIVE_RE = /^[\w.-]+(?:\/[\w.-]+)*$/;
const REQUIRED_PROPERTIES = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'] as const;

export class SigningError extends ActionError {
  constructor(code: string, message: string, status = 409) {
    super(status, code, message);
    this.name = 'SigningError';
  }
}

export interface SigningFilesDeps {
  config: ConfigStore;
  git: GitExec;
  jobs: JobStore;
  audit: AuditWriter;
  log: Logger;
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** The `key=value` and `key: value` lines of a Java properties file. */
function parseProperties(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^#!\s=:]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) values.set(match[1], match[2] ?? '');
  }
  return values;
}

/** Gradle's `file()` in the app module resolves from `android/app`. Null when the result is outside the clone. */
function keystorePathOf(storeFile: string): string | null {
  if (isAbsolute(storeFile) || storeFile.startsWith('~')) return null;
  const path = posix.normalize(`${APP_DIR}/${storeFile}`);
  // Lower case: on the Mac's disk, `.GIT` is the same folder.
  const first = path.split('/', 1)[0]?.toLowerCase();
  if (first === '..' || first === '.git') return null;
  return SAFE_RELATIVE_RE.test(path) ? path : null;
}

const OUTSIDE_CLONE =
  'storeFile in the properties file must be a path inside the project, such as ../upload.jks. Fix it and upload the file again.';

/** JKS, JCEKS, or PKCS#12 (an ASN.1 sequence). */
function looksLikeKeystore(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4).toString('hex');
  return head === 'feedfeed' || head === 'cececece' || (bytes.length > 4 && bytes[0] === 0x30);
}

function decode(contentBase64: string): Buffer {
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== contentBase64) {
    throw new SigningError('invalid_upload', 'The uploaded file could not be read', 422);
  }
  if (bytes.length > SIGNING_FILE_MAX_BYTES) {
    throw new SigningError('file_too_large', 'This is too large to be a signing file', 422);
  }
  return bytes;
}

export class SigningFiles {
  constructor(private readonly d: SigningFilesDeps) {}

  async status(repoId: string): Promise<SigningStatus> {
    this.assertRepo(repoId);
    const clone = this.d.git.clonePath(repoId);
    const unsupported = (problem: string): SigningStatus => ({
      supported: false,
      properties: null,
      keystore: null,
      problem,
    });
    if (!(await exists(join(clone, '.git')))) {
      return unsupported('This repo has no clone yet. Start a build first.');
    }

    const name = await this.propertiesName(clone);
    if (name === null) {
      return unsupported(
        'android/app/build.gradle does not read a signing properties file through rootProject.file(...). Signing is set up another way here, so it has to be fixed in the repo.',
      );
    }
    const propertiesPath = `${ANDROID_DIR}/${name}`;
    const text = await readFile(join(clone, propertiesPath), 'utf8').catch(() => null);
    const status: SigningStatus = {
      supported: true,
      properties: {
        name: fileNameOf(propertiesPath),
        path: propertiesPath,
        present: text !== null,
      },
      keystore: null,
      problem: null,
    };
    if (text === null) return status;

    const storeFile = parseProperties(text).get('storeFile');
    if (!storeFile) return { ...status, problem: `${name} does not set storeFile.` };
    const keystorePath = keystorePathOf(storeFile);
    if (keystorePath === null) return { ...status, problem: OUTSIDE_CLONE };
    return {
      ...status,
      keystore: {
        name: fileNameOf(keystorePath),
        path: keystorePath,
        present: await exists(join(clone, keystorePath)),
      },
    };
  }

  /** Takes one file, works out from its name where it belongs, and answers with the new status. */
  async upload(repoId: string, request: SigningUploadRequest): Promise<SigningStatus> {
    const before = await this.status(repoId);
    if (!before.supported || !before.properties) {
      throw new SigningError(
        'signing_not_supported',
        before.problem ?? 'Signing cannot be set here',
      );
    }
    this.assertCloneIdle(repoId);
    const bytes = decode(request.contentBase64);
    const { fileName } = request;

    let path: string;
    if (fileName === before.properties.name) {
      this.assertPropertiesContent(fileName, bytes);
      path = before.properties.path;
    } else if (before.keystore && fileName === before.keystore.name) {
      if (!looksLikeKeystore(bytes)) {
        throw new SigningError('not_a_keystore', `${fileName} is not a keystore file`, 422);
      }
      path = before.keystore.path;
    } else if (!before.keystore) {
      throw new SigningError(
        'wrong_file_name',
        `Upload ${before.properties.name} first: it says what the keystore is called. Got ${fileName}.`,
        422,
      );
    } else {
      throw new SigningError(
        'wrong_file_name',
        `This repo expects ${before.properties.name} and ${before.keystore.name}. Got ${fileName}.`,
        422,
      );
    }

    await this.place(repoId, path, bytes);
    this.d.audit.write({
      actor: 'user',
      action: 'signing.upload',
      targetType: 'repo',
      targetId: repoId,
      before: null,
      after: { fileName, path, sizeBytes: bytes.length },
    });
    this.d.log.info({ repoId, path }, 'signing file placed in the bot clone');
    return this.status(repoId);
  }

  private assertRepo(repoId: string): void {
    if (!this.d.config.getRepo(repoId)) {
      throw new ActionError(404, 'repo_not_found', 'Unknown repo');
    }
  }

  /** A failed release is not active, so the usual case (fix, then Resume) passes. A paused one never reads these files. */
  private assertCloneIdle(repoId: string): void {
    if (
      this.d.jobs.activeBuild(repoId) ||
      this.d.jobs.activeRelease(repoId)?.status === 'running'
    ) {
      throw new SigningError(
        'clone_busy',
        'A build or release is using this clone. Try again when it has stopped.',
      );
    }
  }

  private async propertiesName(clone: string): Promise<string | null> {
    for (const gradle of GRADLE_FILES) {
      const text = await readFile(join(clone, APP_DIR, gradle), 'utf8').catch(() => null);
      if (text === null) continue;
      for (const match of text.matchAll(PROPERTIES_REF_RE)) {
        const name = match[1] ?? '';
        const safe = SAFE_RELATIVE_RE.test(name) && !name.split('/').includes('..');
        if (safe && fileNameOf(name) !== 'local.properties') return name;
      }
    }
    return null;
  }

  private assertPropertiesContent(fileName: string, bytes: Buffer): void {
    const values = parseProperties(bytes.toString('utf8'));
    const missing = REQUIRED_PROPERTIES.filter((key) => !values.get(key));
    if (missing.length > 0) {
      throw new SigningError(
        'invalid_properties',
        `${fileName} does not set ${missing.join(', ')}`,
        422,
      );
    }
    if (keystorePathOf(values.get('storeFile') ?? '') === null) {
      throw new SigningError('store_file_outside_clone', OUTSIDE_CLONE, 422);
    }
  }

  /** The temporary file sits in `.git`, on the same disk, where a concurrent `git status` cannot see it. */
  private async place(repoId: string, path: string, bytes: Buffer): Promise<void> {
    const clone = await realpath(this.d.git.clonePath(repoId));
    const target = resolve(clone, path);
    await this.assertInsideClone(clone, target);

    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isFile()) {
      throw new SigningError('target_not_a_file', `${path} exists and is not a regular file`);
    }
    // Replacing a tracked file would change the repo: refused before anything is written.
    if (existing) await this.assertIgnored(repoId, path);

    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = join(clone, '.git', `.signing-${randomUUID()}.partial`);
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    if (existing) return;

    // Git can only judge a path that exists. Anything but "ignored" takes the new file away again.
    try {
      await this.assertIgnored(repoId, path);
    } catch (e) {
      await rm(target, { force: true });
      throw e;
    }
  }

  /** The nearest existing folder is what counts: a symlink on the way could lead out of the clone. */
  private async assertInsideClone(clone: string, target: string): Promise<void> {
    let dir = dirname(target);
    while (!(await exists(dir)) && dir !== dirname(dir)) dir = dirname(dir);
    const real = await realpath(dir);
    if (real !== clone && !real.startsWith(`${clone}${sep}`)) {
      throw new SigningError('target_outside_clone', 'This path leads out of the clone');
    }
  }

  private async assertIgnored(repoId: string, path: string): Promise<void> {
    const { stdout } = await this.d.git.run(repoId, 'git', [
      'status',
      '--porcelain',
      '--ignored',
      '--',
      path,
    ]);
    if (!stdout.split('\n').some((line) => line.startsWith('!! '))) {
      throw new SigningError(
        'not_ignored',
        `${path} is not in the repo's .gitignore, so it could end up in a commit. Add it to .gitignore in the repo first.`,
      );
    }
  }
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
