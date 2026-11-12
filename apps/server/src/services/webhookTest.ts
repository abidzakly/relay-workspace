import type { Check, GlobalConfig, RepoConfig, WebhookHookSummary } from '@relay/shared';
import { clip, makeCheck } from './checks';
import { GitlabHooksApi, summarizeHook } from './gitlabHooks';
import type { HttpClient } from './httpClient';
import { errInfo, expectedWebhookUrl, isHealthy, pickOurs, PROBLEM_TEXT } from './webhookRegistry';

export interface WebhookTestInput {
  repoId: string;
  global: Pick<GlobalConfig, 'gitlab' | 'publicBaseUrl'>;
  repo: Pick<RepoConfig, 'gitlab'>;
  http: HttpClient;
}

/** Both webhook checks as `skip` (an earlier check they depend on failed). */
export function skippedWebhookChecks(why: string): Check[] {
  const c = makeCheck('webhook');
  return [
    c.skip('webhook.hook', 'Webhook registered', why),
    c.skip('webhook.delivery', 'Test delivery', why),
  ];
}

const REGISTER_HINT =
  'Settings → Webhook health → Register on this repo: it re-sends the URL and the secret token to GitLab.';

/**
 * "Test connection" for the webhook path: is our hook on the project, and does a delivery really go
 * through? The second check asks GitLab to send a test push to the hook (GitLab's own "Test" button),
 * so it covers everything end to end: GitLab -> ngrok -> :3001 -> token check. A token mismatch (the
 * hook in GitLab holds a different secret than this dashboard) shows up here as GitLab's HTTP 401.
 *
 * Side effect: the test push is a real delivery, so the listener stores and processes it like any
 * push (the same as clicking "Test" in GitLab). Nothing in GitLab's configuration changes.
 */
export async function testWebhook(input: WebhookTestInput): Promise<Check[]> {
  const c = makeCheck('webhook');
  const hookLabel = 'Webhook registered';
  const deliveryLabel = 'Test delivery';
  const skipDelivery = (why: string) => c.skip('webhook.delivery', deliveryLabel, why);

  const host = input.global.gitlab.host;
  if (!host) {
    return [
      c.fail('webhook.hook', hookLabel, PROBLEM_TEXT.gitlab_host_missing),
      skipDelivery('Needs the GitLab host.'),
    ];
  }
  const expected = expectedWebhookUrl(input.global.publicBaseUrl, input.repoId);
  if (expected.problem) {
    return [
      c.fail('webhook.hook', hookLabel, 'No usable public URL.', PROBLEM_TEXT[expected.problem]),
      skipDelivery('Needs an https public URL.'),
    ];
  }

  const api = new GitlabHooksApi(
    host,
    input.repo.gitlab.token,
    input.repo.gitlab.projectId,
    input.http,
  );

  let hooks: WebhookHookSummary[];
  try {
    hooks = [];
    for (const raw of await api.list()) {
      const s = summarizeHook(raw, input.repoId, expected.url);
      if (s) hooks.push(s);
    }
  } catch (e) {
    const info = errInfo(e);
    return [
      c.fail('webhook.hook', hookLabel, `Could not list the project's hooks: ${info.message}.`),
      skipDelivery('Needs the hook list.'),
    ];
  }

  const ours = pickOurs(hooks);
  if (!ours) {
    return [
      c.fail(
        'webhook.hook',
        hookLabel,
        `No hook for ${expected.url} on the project.`,
        REGISTER_HINT,
      ),
      skipDelivery('Needs a registered hook.'),
    ];
  }
  const out: Check[] = [];
  if (!ours.urlMatches) {
    out.push(
      c.fail(
        'webhook.hook',
        hookLabel,
        `Hook #${ours.id} points at ${clip(ours.url)}, not ${expected.url}.`,
        REGISTER_HINT,
      ),
    );
  } else if (ours.alertStatus !== null && ours.alertStatus !== 'executable') {
    out.push(
      c.warn(
        'webhook.hook',
        hookLabel,
        `Hook #${ours.id} is ${ours.alertStatus.replace(/_/g, ' ')} in GitLab after failed deliveries.`,
        REGISTER_HINT,
      ),
    );
  } else if (!isHealthy(ours)) {
    out.push(
      c.warn(
        'webhook.hook',
        hookLabel,
        `Hook #${ours.id} exists, but its events or SSL verification differ from what the dashboard needs.`,
        REGISTER_HINT,
      ),
    );
  } else {
    out.push(c.pass('webhook.hook', hookLabel, `Hook #${ours.id} → ${expected.url}.`));
  }

  out.push(await deliveryCheck(c, api, ours));
  return out;
}

async function deliveryCheck(
  c: ReturnType<typeof makeCheck>,
  api: GitlabHooksApi,
  hook: WebhookHookSummary,
): Promise<Check> {
  const label = 'Test delivery';
  let res;
  try {
    res = await api.test(hook.id, 'push_events');
  } catch (e) {
    return c.fail('webhook.delivery', label, `GitLab could not be reached: ${errInfo(e).message}.`);
  }
  if (res.status >= 200 && res.status < 300) {
    return c.pass(
      'webhook.delivery',
      label,
      'GitLab sent a test push to the hook and the dashboard accepted it.',
    );
  }
  const msg = clip((res.json as { message?: unknown } | undefined)?.message, 300);
  const said = msg ? ` GitLab says: “${msg}”` : '';
  if (res.status === 422) {
    const http = /HTTP (\d{3})/.exec(msg)?.[1];
    if (http === '401') {
      return c.fail(
        'webhook.delivery',
        label,
        `The delivery reached the dashboard but was rejected (HTTP 401): the secret token stored on the GitLab hook differs from this dashboard's.${said}`,
        REGISTER_HINT,
      );
    }
    if (http === '404' || http === '502' || http === '503' || http === '504') {
      return c.fail(
        'webhook.delivery',
        label,
        `The delivery did not reach the webhook listener (HTTP ${http}).${said}`,
        'Check that ngrok is running, points at the webhook port (3001), and that the public URL is current.',
      );
    }
    return c.fail('webhook.delivery', label, `The test delivery failed.${said}`);
  }
  if (res.status === 429) {
    return c.warn(
      'webhook.delivery',
      label,
      'GitLab rate-limits test deliveries (about 5 per minute).',
      'Wait a minute and test again.',
    );
  }
  if (res.status === 404) {
    return c.warn(
      'webhook.delivery',
      label,
      'GitLab has no test-delivery API for this hook (needs GitLab 16.11 or newer).',
      'Use the hook’s “Test” button in GitLab → Settings → Webhooks instead.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    return c.fail(
      'webhook.delivery',
      label,
      `GitLab refused to run the test (HTTP ${res.status}).${said}`,
      'Testing hooks needs the Maintainer role and an `api`-scope token.',
    );
  }
  return c.fail('webhook.delivery', label, `GitLab answered HTTP ${res.status}.${said}`);
}
