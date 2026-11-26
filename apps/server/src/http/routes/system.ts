import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { POSIX_FEATURES, type OsKind, type SystemInfo } from '@relay/shared';
import { IS_WINDOWS } from '../../util/platform';
import type { LoadedPresets } from '../../config/presets';

const POSIX_REASON = 'Does not run on Windows: it needs macOS/Linux shell scripts.';

function osKind(): OsKind {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  if (IS_WINDOWS) return 'windows';
  return 'other';
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/** `GET /api/system`: where the server runs and which features cannot run there. Nothing secret. */
export function registerSystemRoutes(app: FastifyInstance, presets: LoadedPresets): void {
  const info: SystemInfo = {
    os: osKind(),
    wsl: isWsl(),
    unsupported: IS_WINDOWS ? POSIX_FEATURES.map((id) => ({ id, reason: POSIX_REASON })) : [],
    edition: presets.edition,
    repoDefaults: presets.repo,
  };
  app.get('/api/system', async () => info);
}
