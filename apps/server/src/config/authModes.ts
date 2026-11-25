import type { AuthMode } from '@relay/shared';
import { loadServiceAccountKey, resolveKeyPath } from '../services/drive';
import type { OAuthHub } from '../services/oauth/oauthHub';
import type { Logger } from '../util/logger';
import type { ConfigStore } from './store';

/**
 * GitLab and Google are reached one way at a time: the Connect sign-in, or Advanced mode (tokens, an own OAuth
 * client, a service account). A config from before the switch has no mode yet; this picks the one that keeps today's
 * setup working and saves it, once at start. Notion resolves its own on read (`ConfigStore.globalFull`).
 */
export function resolveAuthModes(d: {
  store: ConfigStore;
  oauth: Pick<OAuthHub, 'isConnected'>;
  /** The Calendar sign-in through an own OAuth client is stored. */
  calendarOwnSignedIn: () => boolean;
  baseDir: string;
  log: Logger;
}): void {
  const stored = d.store.getGlobalStored();
  let gitlab: AuthMode | undefined = stored.gitlab.authMode;
  let google: AuthMode | undefined = stored.google.authMode;
  if (gitlab && google) return;

  if (!gitlab) {
    const manual =
      !!d.store.getPastedReviewerToken() || d.store.listRepos().some((r) => r.gitlab.tokenSet);
    gitlab = d.oauth.isConnected('gitlab') ? 'connect' : manual ? 'token' : 'connect';
  }
  if (!google) {
    const keyLoads = loadServiceAccountKey(
      resolveKeyPath(stored.drive.serviceAccountKeyPath, d.baseDir),
    ).ok;
    google =
      d.calendarOwnSignedIn() || (keyLoads && !d.oauth.isConnected('google')) ? 'token' : 'connect';
  }

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
