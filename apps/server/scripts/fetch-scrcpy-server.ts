/**
 * Downloads the scrcpy server the device mirror pushes to the phone, into `<data dir>/scrcpy/`. Pinned to the version
 * `@yume-chan/adb-scrcpy` speaks (AdbScrcpyOptions3_3_3) and checked against the SHA-256 published on the GitHub
 * release. Run once on the Mac that the phone is plugged into: `pnpm --filter @relay/server device:setup`.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from '../src/config/env';
import { SCRCPY_SERVER_SHA256, SCRCPY_SERVER_VERSION } from '../src/services/device/scrcpyVersion';

const url = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
const dir = join(resolveDataDir({ DATA_DIR: process.env.DATA_DIR }), 'scrcpy');
const dest = join(dir, `scrcpy-server-v${SCRCPY_SERVER_VERSION}`);

const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status} for ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const got = createHash('sha256').update(buf).digest('hex');
if (got !== SCRCPY_SERVER_SHA256) {
  console.error(
    `Checksum mismatch: expected ${SCRCPY_SERVER_SHA256}, got ${got}. Nothing was saved.`,
  );
  process.exit(1);
}
await mkdir(dir, { recursive: true });
await writeFile(`${dest}.part`, buf);
await rename(`${dest}.part`, dest);
console.log(`scrcpy server v${SCRCPY_SERVER_VERSION} saved to ${dest}`);
