import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GitlabPickerBodySchema,
  type Branch,
  type GitlabFlutterHints,
  type GitlabMe,
  type GitlabMember,
  type GitlabPickerBody,
  type GitlabProjectOption,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { HttpClient, HttpResponse } from '../../services/httpClient';
import type { OAuthHub } from '../../services/oauth/oauthHub';
import { HttpError, parseWith } from '../errors';

export interface GitlabPickerDeps {
  store: ConfigStore;
  oauth?: OAuthHub;
  http: HttpClient;
  /** The webhook listener's port, to tell which tunnel points at it. */
  webhookPort?: number | undefined;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** One flavor name from `lib/main_<flavor>.dart`. */
const FLAVOR_FILE = /^main_([a-z0-9_]+)\.dart$/i;
/** `name: my_app` on its own line in pubspec.yaml. */
const PUBSPEC_NAME = /^name:\s*["']?([A-Za-z0-9_]+)["']?\s*$/m;
/** ngrok's local agent API: it only ever listens on this machine. */
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';

const HostBody = z.object({ host: z.url({ protocol: /^https?$/ }).max(300) });

export interface HostCheck {
  ok: boolean;
  /** Normalised host to save (no trailing slash, no path). */
  host: string;
  version: string | null;
  message: string;
}

export interface TunnelOption {
  publicUrl: string;
  /** Where the tunnel forwards to, e.g. `http://localhost:3001`. */
  addr: string;
  /** Forwards to Relay's webhook port. */
  webhook: boolean;
}

/**
 * Reads GitLab for the Add repository wizard, so a person picks instead of typing ids (all POST, CSRF applies, no
 * write to GitLab or to Relay):
 *  POST /api/gitlab/pick/me         the user behind the token (username, name, commit email)
 *  POST /api/gitlab/pick/projects   projects the token is a member of (a project access token sees its own project)
 *  POST /api/gitlab/pick/branches   { projectId, search? } branches, default first
 *  POST /api/gitlab/pick/members    { projectId, search? } members with Developer access or more
 *  POST /api/gitlab/pick/flutter    { projectId } flavors from lib/main_*.dart and the pubspec name
 *  POST /api/gitlab/pick/host       { host } is this a GitLab (its /api/v4/version answers), no token sent
 *  GET  /api/gitlab/pick/tunnels    public https URLs of a local ngrok agent (its API on 127.0.0.1:4040)
 *
 * The host is always the one in Settings: nothing in a request chooses where a token is sent. A pasted `token` is
 * used for this one read only; it is never stored or logged here.
 */
export function registerGitlabPickerRoutes(app: FastifyInstance, deps: GitlabPickerDeps): void {
  const tokenFor = async (b: GitlabPickerBody): Promise<string | undefined> => {
    if (b.token) return b.token;
    if (b.repoId) {
      const own = deps.store.getRepo(b.repoId)?.gitlab.token;
      if (own) return own;
    }
    const mode = deps.store.getGlobalStored().gitlab.authMode;
    if (mode !== 'token' && deps.oauth?.isConnected('gitlab')) {
      const t = await deps.oauth.accessToken('gitlab').catch(() => undefined);
      if (t) return t;
    }
    return deps.store.getReviewerToken();
  };

  const call = async (b: GitlabPickerBody, path: string): Promise<HttpResponse> => {
    const host = deps.store.getGlobalStored().gitlab.host?.replace(/\/+$/, '');
    if (!host) throw new HttpError(422, 'gitlab_host_missing', 'Set the GitLab host first.');
    const token = await tokenFor(b);
    if (!token) {
      throw new HttpError(
        422,
        'gitlab_not_connected',
        'Connect GitLab first, or paste a project access token.',
      );
    }
    let res: HttpResponse;
    try {
      res = await deps.http.send({
        url: `${host}/api/v4${path}`,
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      throw new HttpError(502, 'gitlab_unreachable', 'GitLab did not answer. Check the host.');
    }
    if (res.status === 401) {
      if (!b.token && !b.repoId && deps.store.getGlobalStored().gitlab.authMode !== 'token') {
        void deps.oauth?.invalidate('gitlab');
      }
      throw new HttpError(
        502,
        'gitlab_denied',
        b.token ? 'GitLab refused this token.' : 'GitLab refused the sign-in. Connect again.',
      );
    }
    return res;
  };

  const ok = (res: HttpResponse): unknown => {
    if (res.status === 404)
      throw new HttpError(404, 'gitlab_not_found', 'GitLab has no such project.');
    if (res.status !== 200) {
      throw new HttpError(502, 'gitlab_failed', `GitLab answered HTTP ${res.status}.`);
    }
    return res.json;
  };

  const needProject = (b: GitlabPickerBody): number => {
    if (!b.projectId) throw new HttpError(400, 'project_missing', 'Pick a project first.');
    return b.projectId;
  };

  app.post('/api/gitlab/pick/me', async (req): Promise<GitlabMe> => {
    const b = parseWith(GitlabPickerBodySchema, req.body ?? {});
    const u = rec(ok(await call(b, '/user')));
    const username = str(u.username);
    if (!username) throw new HttpError(502, 'gitlab_failed', 'GitLab returned no user.');
    return {
      username,
      name: str(u.name) ?? null,
      email: str(u.commit_email) ?? str(u.public_email) ?? str(u.email) ?? null,
    };
  });

  app.post('/api/gitlab/pick/projects', async (req): Promise<GitlabProjectOption[]> => {
    const b = parseWith(GitlabPickerBodySchema, req.body ?? {});
    const q = new URLSearchParams({
      membership: 'true',
      simple: 'true',
      per_page: '50',
      order_by: 'last_activity_at',
      ...(b.search ? { search: b.search } : {}),
    });
    const list = ok(await call(b, `/projects?${q.toString()}`));
    return (Array.isArray(list) ? list : []).flatMap((r): GitlabProjectOption[] => {
      const o = rec(r);
      const id = typeof o.id === 'number' ? o.id : undefined;
      const full = str(o.path_with_namespace);
      const url = str(o.http_url_to_repo);
      if (id === undefined || !full || !url) return [];
      return [
        {
          id,
          pathWithNamespace: full,
          name: str(o.name) ?? full,
          httpUrlToRepo: url,
          defaultBranch: str(o.default_branch) ?? null,
          path: str(o.path) ?? full.slice(full.lastIndexOf('/') + 1),
          sshUrlToRepo: str(o.ssh_url_to_repo) ?? null,
          webUrl: str(o.web_url) ?? null,
        },
      ];
    });
  });

  app.post(
    '/api/gitlab/pick/branches',
    async (req): Promise<{ branches: Branch[]; truncated: boolean }> => {
      const b = parseWith(GitlabPickerBodySchema, req.body ?? {});
      const pid = needProject(b);
      const q = new URLSearchParams({ per_page: '100', ...(b.search ? { search: b.search } : {}) });
      const res = await call(b, `/projects/${pid}/repository/branches?${q.toString()}`);
      const list = ok(res);
      const branches = (Array.isArray(list) ? list : []).flatMap((r): Branch[] => {
        const o = rec(r);
        const name = str(o.name);
        if (!name) return [];
        const at = Date.parse(str(rec(o.commit).committed_date) ?? '');
        return [
          {
            name,
            default: o.default === true,
            protected: o.protected === true,
            merged: o.merged === true,
            committedAt: Number.isFinite(at) ? at : null,
          },
        ];
      });
      branches.sort(
        (x, y) =>
          Number(y.default) - Number(x.default) ||
          Number(y.protected) - Number(x.protected) ||
          (y.committedAt ?? 0) - (x.committedAt ?? 0),
      );
      const total = Number(res.headers['x-total'] ?? branches.length);
      return { branches, truncated: Number.isFinite(total) && total > branches.length };
    },
  );

  app.post('/api/gitlab/pick/members', async (req): Promise<GitlabMember[]> => {
    const b = parseWith(GitlabPickerBodySchema, req.body ?? {});
    const pid = needProject(b);
    const q = new URLSearchParams({ per_page: '100', ...(b.search ? { query: b.search } : {}) });
    const list = ok(await call(b, `/projects/${pid}/members/all?${q.toString()}`));
    const seen = new Set<string>();
    return (Array.isArray(list) ? list : [])
      .flatMap((r): GitlabMember[] => {
        const o = rec(r);
        const username = str(o.username);
        const level = typeof o.access_level === 'number' ? o.access_level : 0;
        // Bots (project tokens) and blocked users cannot review; guests and reporters cannot approve.
        if (!username || level < 30 || o.state !== 'active' || /^project_\d+_bot/.test(username)) {
          return [];
        }
        if (seen.has(username)) return [];
        seen.add(username);
        return [
          {
            username,
            name: str(o.name) ?? username,
            avatarUrl: str(o.avatar_url) ?? null,
            accessLevel: level,
          },
        ];
      })
      .sort((x, y) => y.accessLevel - x.accessLevel || x.name.localeCompare(y.name));
  });

  app.post('/api/gitlab/pick/flutter', async (req): Promise<GitlabFlutterHints> => {
    const b = parseWith(GitlabPickerBodySchema, req.body ?? {});
    const pid = needProject(b);
    const ref = b.search ? `&ref=${encodeURIComponent(b.search)}` : '';
    // Best effort: an empty project or a missing file is "nothing found", not an error.
    const tree = await call(b, `/projects/${pid}/repository/tree?path=lib&per_page=100${ref}`);
    const flavors =
      tree.status === 200 && Array.isArray(tree.json)
        ? (tree.json as unknown[]).flatMap((r) => {
            const m = FLAVOR_FILE.exec(str(rec(r).name) ?? '');
            return m?.[1] ? [m[1]] : [];
          })
        : [];
    const pub = await call(
      b,
      `/projects/${pid}/repository/files/pubspec.yaml/raw?ref=${encodeURIComponent(b.search || 'HEAD')}`,
    );
    const isFlutter = pub.status === 200;
    const appName = isFlutter ? (PUBSPEC_NAME.exec(pub.text)?.[1] ?? null) : null;
    return { flavors: [...new Set(flavors)].sort(), appName, isFlutter };
  });

  app.post('/api/gitlab/pick/host', async (req): Promise<HostCheck> => {
    const { host: raw } = parseWith(HostBody, req.body);
    const u = new URL(raw);
    const host = `${u.protocol}//${u.host}`;
    try {
      // Unauthenticated: GitLab answers 401 to a stranger, which still proves it is a GitLab.
      const res = await deps.http.send({
        url: `${host}/api/v4/version`,
        timeoutMs: 8_000,
        maxRetries: 0,
      });
      const version = str(rec(res.json).version) ?? null;
      if (res.status === 200 || res.status === 401 || res.status === 403) {
        return { ok: true, host, version, message: 'GitLab answers here.' };
      }
      return {
        ok: false,
        host,
        version: null,
        message: `No GitLab API here (HTTP ${res.status}).`,
      };
    } catch {
      return { ok: false, host, version: null, message: 'Nothing answered at this address.' };
    }
  });

  app.get('/api/gitlab/pick/tunnels', async (): Promise<TunnelOption[]> => {
    const port = deps.webhookPort ?? (Number(process.env.WEBHOOK_PORT) || 3001);
    try {
      const res = await deps.http.send({ url: NGROK_API, timeoutMs: 2_000, maxRetries: 0 });
      const list = Array.isArray(rec(res.json).tunnels) ? (rec(res.json).tunnels as unknown[]) : [];
      return list
        .flatMap((t): TunnelOption[] => {
          const o = rec(t);
          const publicUrl = str(o.public_url);
          const addr = str(rec(o.config).addr) ?? '';
          if (!publicUrl?.startsWith('https://')) return [];
          const webhook = new RegExp(`:${port}/?$`).test(addr);
          return [{ publicUrl, addr, webhook }];
        })
        .sort((a, b) => Number(b.webhook) - Number(a.webhook));
    } catch {
      // No ngrok agent running here: nothing to offer.
      return [];
    }
  });
}
