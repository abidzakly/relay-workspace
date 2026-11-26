import type { ConfigStore } from './store';
import type { Logger } from '../util/logger';

/**
 * GitLab and Google are reached one way at a time: the Connect sign-in, or Advanced mode (tokens, an own OAuth
 * client, a service account). Advanced mode is opt-in: a config with no mode yet gets Connect and saves it, once at
 * start, even when old tokens or keys are stored (they are kept, just not used). A mode already saved is left alone.
 * Notion resolves its own on read (`ConfigStore.globalFull`).
 */
export function resolveAuthModes(d: { store: ConfigStore; log: Logger }): void {
  const stored = d.store.getGlobalStored();
  if (stored.gitlab.authMode && stored.google.authMode) return;
  const gitlab = stored.gitlab.authMode ?? 'connect';
  const google = stored.google.authMode ?? 'connect';
  d.store.saveGlobal(
    {
      ...stored,
      gitlab: { ...stored.gitlab, authMode: gitlab },
      google: { ...stored.google, authMode: google },
    },
    undefined,
  );
  d.log.info({ gitlab, google }, 'auth modes resolved');
}
