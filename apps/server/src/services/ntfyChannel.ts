import type { ChannelResult, PushPayload } from '@relay/shared';
import type { Logger } from '../util/logger';
import type { HttpClient } from './httpClient';
import { EMPTY_RESULT, type NotificationChannel } from './notificationChannel';

/**
 * Optional free fallback for "guaranteed delivery" when the browser is fully closed.
 * OFF unless `NTFY_TOPIC` is set. Uses ntfy's documented JSON publish (`POST <server>` with
 * `{topic, title, message, tags}`): UNVERIFIED here (ntfy.sh is not reachable from the build sandbox).
 *
 * Privacy: the notification text leaves this machine for the ntfy server, and anyone who knows the topic can
 * read it. So the topic is treated like a secret (env only, sent in the body so it never shows in a URL/log),
 * and the server must be https. The dashboard is 127.0.0.1-only, so no click URL is sent.
 */

const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_SERVER = 'https://ntfy.sh';

export type NtfyConfig = { topic: string; server: string } | { problem: 'invalid' } | null;

/** Pure: env -> config. `null` = not requested (no topic); `{problem}` = requested but unusable. */
export function resolveNtfy(env: {
  NTFY_TOPIC?: string | undefined;
  NTFY_SERVER?: string | undefined;
}): NtfyConfig {
  if (!env.NTFY_TOPIC) return null;
  if (!TOPIC_RE.test(env.NTFY_TOPIC)) return { problem: 'invalid' };
  const server = (env.NTFY_SERVER ?? DEFAULT_SERVER).replace(/\/+$/, '');
  try {
    const u = new URL(server);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
      return { problem: 'invalid' };
    }
  } catch {
    return { problem: 'invalid' };
  }
  return { topic: env.NTFY_TOPIC, server };
}

const TAGS: Partial<Record<PushPayload['event'], string[]>> = {
  approved: ['white_check_mark'],
  merged: ['tada'],
  pipelineFailed: ['x'],
  mismatch: ['warning'],
};

export class NtfyChannel implements NotificationChannel {
  readonly name = 'ntfy';

  constructor(
    private readonly cfg: NtfyConfig,
    private readonly http: HttpClient,
    private readonly log: Logger,
  ) {
    if (cfg && 'problem' in cfg) {
      log.warn(
        'ntfy disabled: NTFY_TOPIC must be 1-64 chars of [A-Za-z0-9_-], NTFY_SERVER an https URL',
      );
    }
  }

  isConfigured(): boolean {
    return this.cfg !== null && 'topic' in this.cfg;
  }

  async deliver(payload: PushPayload): Promise<ChannelResult> {
    const cfg = this.cfg;
    if (!cfg || !('topic' in cfg)) return { ...EMPTY_RESULT };
    try {
      const res = await this.http.send({
        method: 'POST',
        url: cfg.server,
        body: {
          topic: cfg.topic,
          title: payload.title,
          message: payload.body || payload.title,
          tags: TAGS[payload.event] ?? [],
        },
        timeoutMs: 8_000,
        maxRetries: 1,
      });
      if (res.status >= 200 && res.status < 300) {
        return { attempted: 1, sent: 1, removed: 0, failed: 0 };
      }
      this.log.warn({ status: res.status }, 'ntfy delivery failed');
    } catch (e) {
      this.log.warn({ err: (e as Error).name }, 'ntfy delivery failed');
    }
    return { attempted: 1, sent: 0, removed: 0, failed: 1 };
  }
}
