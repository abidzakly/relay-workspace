import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  RepoConfigStoredSchema,
  SECRET_MASK,
  SecretSchema,
  type RepoConfigStored,
} from '@relay/shared';
import type { AuditWriter } from '../../audit/auditLog';
import { RepoExistsError, RepoNotFoundError, type ConfigStore } from '../../config/store';
import { stripUrlCredentials } from '../../services/configBackup';
import type { TokenIdentity } from '../../services/tokenIdentity';
import { HttpError, parseWith } from '../errors';

export interface RepoRouteDeps {
  store: ConfigStore;
  audit: AuditWriter;
  /** Re-learns which GitLab user a repo's token posts as. */
  tokenIdentity?: Pick<TokenIdentity, 'resolve'>;
}

const IdParams = z.object({ id: z.string().min(1).max(64) });
const EnabledBody = z.object({ enabled: z.boolean() }).strict();

/** `gitlab.token`: a new secret (string), the UI's mask (= unchanged) or omitted (= unchanged). */
const TokenField = z.union([z.literal(SECRET_MASK), SecretSchema]).optional();

function split(body: unknown): { stored: RepoConfigStored; token: string | undefined } {
  // Secrets are read from the raw body first; the stored schema then strips them (and any
  // client-supplied `webhookSecret`, which is server-generated only).
  const rawToken = (body as { gitlab?: { token?: unknown } } | null)?.gitlab?.token;
  const token = parseWith(TokenField, rawToken);
  const stored = parseWith(RepoConfigStoredSchema, body);
  // The clone URL is public config: the API returns it and the audit log records it, so it cannot carry a credential.
  if (stripUrlCredentials(stored.cloneUrl) !== stored.cloneUrl) {
    throw new HttpError(
      400,
      'clone_url_has_credentials',
      'Remove the credentials from the clone URL, and use SSH or a git credential helper.',
    );
  }
  return { stored, token };
}

export function registerRepoRoutes(
  app: FastifyInstance,
  { store, audit, tokenIdentity }: RepoRouteDeps,
): void {
  app.get('/api/repos', async () => ({ repos: store.listRepos() }));

  // Every GitLab username that is "me": `gitlab.myUsername` plus the bot users behind the repo tokens.
  app.get('/api/me', async () => ({ usernames: store.myUsernames() }));

  app.get('/api/repos/:id', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    const repo = store.getRepoPublic(id);
    if (!repo) throw new HttpError(404, 'repo_not_found');
    return { repo };
  });

  app.post('/api/repos', async (req, reply) => {
    const { stored, token } = split(req.body);
    if (token === undefined || token === SECRET_MASK) {
      throw new HttpError(400, 'validation', 'gitlab.token is required');
    }
    try {
      const repo = store.createRepo(stored, token);
      audit.write({
        actor: 'user',
        action: 'repo.create',
        targetType: 'repo',
        targetId: repo.id,
        before: null,
        after: repo,
      });
      void tokenIdentity?.resolve(repo.id);
      return reply.code(201).send({ repo });
    } catch (e) {
      if (e instanceof RepoExistsError) throw new HttpError(409, 'repo_exists');
      throw e;
    }
  });

  app.put('/api/repos/:id', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    const { stored, token } = split(req.body);
    if (stored.id !== id) throw new HttpError(400, 'validation', 'repo id is immutable');
    const before = store.getRepoPublic(id);
    if (!before) throw new HttpError(404, 'repo_not_found');
    try {
      const repo = store.updateRepo(id, stored, token);
      if (token !== undefined && token !== SECRET_MASK) {
        // The old token's user no longer posts for this repo.
        store.setTokenUser(id, null);
        void tokenIdentity?.resolve(id);
      }
      audit.write({
        actor: 'user',
        action: 'repo.update',
        targetType: 'repo',
        targetId: id,
        before,
        after: { ...repo, tokenChanged: token !== undefined && token !== SECRET_MASK },
      });
      return { repo };
    } catch (e) {
      if (e instanceof RepoNotFoundError) throw new HttpError(404, 'repo_not_found');
      throw e;
    }
  });

  // Board scope only: the repo's sync, webhooks and releases are untouched.
  app.patch('/api/repos/:id/enabled', async (req) => {
    const { id } = parseWith(IdParams, req.params);
    const { enabled } = parseWith(EnabledBody, req.body);
    const before = store.getRepoPublic(id);
    if (!before) throw new HttpError(404, 'repo_not_found');
    const { gitlab, ...rest } = before;
    const repo = store.updateRepo(
      id,
      RepoConfigStoredSchema.parse({ ...rest, gitlab: { projectId: gitlab.projectId }, enabled }),
      undefined,
    );
    audit.write({
      actor: 'user',
      action: 'repo.update',
      targetType: 'repo',
      targetId: id,
      before: { enabled: before.enabled },
      after: { enabled: repo.enabled },
    });
    return { repo };
  });

  app.delete('/api/repos/:id', async (req, reply) => {
    const { id } = parseWith(IdParams, req.params);
    const before = store.deleteRepo(id);
    if (!before) throw new HttpError(404, 'repo_not_found');
    audit.write({
      actor: 'user',
      action: 'repo.delete',
      targetType: 'repo',
      targetId: id,
      before,
      after: null,
    });
    return reply.code(204).send();
  });
}
