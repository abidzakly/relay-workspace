import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  PublicUrlCheck,
  WebhookHealth,
  WebhookRegisterAllResult,
  WebhookRegisterResult,
} from '@relay/shared';
import { get, post } from './api';
import { useFallbackPollMs } from './sseState';

export const webhookKeys = {
  health: ['webhook-health'] as const,
};

/** Webhook health panel data: last delivery per repo. Local DB only; `webhook.received` events refresh it. */
export function useWebhookHealth() {
  const pollMs = useFallbackPollMs();
  return useQuery({
    queryKey: webhookKeys.health,
    queryFn: ({ signal }) => get<WebhookHealth>('/api/webhooks/health', { signal }),
    refetchInterval: pollMs,
  });
}

/** One outbound request from the server. A mutation on purpose: it runs on click and never on a timer or a refetch. */
export function useCheckPublicUrl() {
  return useMutation({
    mutationFn: () => post<PublicUrlCheck>('/api/webhooks/check-public-url'),
  });
}

/** Writes to GitLab unless dry-run is on, audited. `repoId` null = every repo. */
export function useRegisterWebhooks() {
  return useMutation({
    mutationFn: async (repoId: string | null): Promise<WebhookRegisterResult[]> => {
      if (repoId === null) {
        return (await post<WebhookRegisterAllResult>('/api/webhooks/register-all')).results;
      }
      // force: GitLab never returns a hook's token, so a hook whose URL and events look right may
      // still hold a stale secret (deliveries then get 401). A per-repo Register always re-sends it.
      const path = `/api/repos/${encodeURIComponent(repoId)}/webhook/register`;
      return [(await post<{ result: WebhookRegisterResult }>(path, { force: true })).result];
    },
  });
}
