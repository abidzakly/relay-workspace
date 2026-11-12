import type { Logger } from '../util/logger';
import type { ConfigStore } from '../config/store';
import { GitlabClient } from './gitlab';
import type { HttpClient } from './httpClient';

export interface TokenIdentityDeps {
  config: ConfigStore;
  http: HttpClient;
  log: Pick<Logger, 'debug' | 'warn'>;
}

/**
 * Learns which GitLab user each repo's token posts as (`GET /user`), so a comment the dashboard (or the agent
 * through it) wrote with a project access token counts as mine. Read-only: one probe per token, at boot and
 * when a token changes. A failure leaves the last known user in place.
 */
export class TokenIdentity {
  constructor(private readonly d: TokenIdentityDeps) {}

  /** Resolves the repos that have no known token user yet. Never throws. */
  async start(): Promise<void> {
    const known = this.d.config.tokenUsers();
    for (const repo of this.d.config.listRepos()) {
      if (!repo.gitlab.tokenSet || known.has(repo.id)) continue;
      await this.resolve(repo.id);
    }
  }

  /** Probes one repo's token and stores its username. Never throws. */
  async resolve(repoId: string): Promise<string | null> {
    try {
      const host = this.d.config.getGlobalStored().gitlab.host;
      const repo = this.d.config.getRepo(repoId);
      if (!host || !repo?.gitlab.token) return null;
      const res = await new GitlabClient(host, repo.gitlab.token, this.d.http).get('/user');
      const json = res.json as { username?: unknown } | undefined;
      const username =
        res.status === 200 && typeof json?.username === 'string' ? json.username : null;
      if (username === null) {
        this.d.log.debug({ repoId, status: res.status }, 'token user not resolved');
        return null;
      }
      this.d.config.setTokenUser(repoId, username);
      return username;
    } catch (e) {
      this.d.log.warn({ repoId, err: e }, 'token user probe failed');
      return null;
    }
  }
}
