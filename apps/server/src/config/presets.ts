import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalConfigStoredSchema, PresetsFileSchema, type RepoPresets } from '@relay/shared';
import type { Logger } from '../util/logger';

export interface LoadedPresets {
  /** The edition folder the presets came from, or null when there are none. */
  edition: string | null;
  /** Partial global settings: the defaults until the first Settings save. */
  global: Record<string, unknown>;
  /** Pre-fills the "Add repository" form. */
  repo: RepoPresets;
}

export const NO_PRESETS: LoadedPresets = { edition: null, global: {}, repo: {} };

/**
 * Reads `editions/<name>/presets.json` under the repo root: the first edition (by name) that has one. A file that does
 * not parse, or whose `global` part does not make valid settings, is logged and ignored, so a bad preset never stops
 * the server.
 */
export function loadPresets(repoRoot: string, log: Logger): LoadedPresets {
  const dir = join(repoRoot, 'editions');
  if (!existsSync(dir)) return NO_PRESETS;
  const editions = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'presets.json')))
    .map((d) => d.name)
    .sort();
  const edition = editions[0];
  if (!edition) return NO_PRESETS;
  const file = join(dir, edition, 'presets.json');
  try {
    const parsed = PresetsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    // Proves the global part makes valid settings before anything relies on it.
    GlobalConfigStoredSchema.parse(parsed.global);
    log.info({ edition }, 'edition presets loaded');
    return { edition, global: parsed.global, repo: parsed.repo };
  } catch (err) {
    log.warn(
      { file, err: err instanceof Error ? err.message : String(err) },
      'edition presets ignored: the file is not valid',
    );
    return NO_PRESETS;
  }
}
