import type { DropdownOption } from '@/components/Dropdown';
import { usePickMe } from '@/lib/gitlabPickerApi';
import { useNotionDataSources, useOAuthStatus } from '@/lib/oauthApi';
import { useMyUsernames, useRepos, useSettings } from '@/lib/settingsApi';

/** The version branch prefixes the repo wizard offers. */
const BRANCH_PREFIXES = ['release/v', 'release/', 'v'];
const NOTION_VERSION_DEFAULT = '2025-09-03';

/** The host of an http(s) or scp-style (git@host:path) git address, or null. */
export function gitHost(url: string | undefined | null): string | null {
  if (!url) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Adds a choice once, keeping the first hint it came with. */
function collect() {
  const out: DropdownOption<string>[] = [];
  const add = (value: string | null | undefined, hint?: string) => {
    const v = value?.trim();
    if (!v || out.some((o) => o.value === v)) return;
    out.push(hint ? { value: v, label: v, hint } : { value: v, label: v });
  };
  return { out, add };
}

/**
 * Values Relay already knows that fit each release-script field: Settings, the saved repos, the GitLab and Notion
 * sign-ins. Keys with no list (the secrets) are absent.
 */
export function useScriptFieldOptions(): Partial<Record<string, DropdownOption<string>[]>> {
  const settings = useSettings().data;
  const repos = useRepos().data ?? [];
  const oauth = useOAuthStatus().data;
  const usernames = useMyUsernames().data ?? [];
  const gitlabSignedIn = !!oauth?.gitlab.connected;
  const firstRepo = repos[0]?.id;
  const me = usePickMe(
    gitlabSignedIn ? {} : { repoId: firstRepo },
    gitlabSignedIn || !!firstRepo,
  ).data;
  const notionReady = !!settings?.notion.tokenSet || !!oauth?.notion.connected;
  const sources = useNotionDataSources(notionReady).data ?? [];

  const hosts = collect();
  if (settings?.gitlab.host) hosts.add(settings.gitlab.host, 'Settings > GitLab');
  for (const r of repos) {
    const h = gitHost(r.cloneUrl);
    if (h) hosts.add(`https://${h}`, r.name);
  }

  const hostnames = collect();
  hostnames.add(gitHost(settings?.gitlab.host), 'Settings > GitLab');
  for (const r of repos) hostnames.add(gitHost(r.cloneUrl), r.name);

  const people = collect();
  people.add(oauth?.gitlab.account, 'Your GitLab sign-in');
  people.add(settings?.gitlab.myUsername, 'Settings > GitLab');
  for (const u of usernames) people.add(u, 'You');
  for (const r of repos) {
    people.add(r.assignee, `${r.name} assignee`);
    for (const u of r.reviewers) people.add(u, `${r.name} reviewer`);
  }

  const prefixes = collect();
  for (const p of BRANCH_PREFIXES) prefixes.add(p, 'Common');
  for (const r of repos) prefixes.add(r.versionBranchPrefix, r.name);

  const names = collect();
  names.add(me?.name, 'Your GitLab profile');
  for (const r of repos) names.add(r.commitIdentity?.name, r.name);

  const emails = collect();
  emails.add(me?.email, 'Your GitLab profile');
  for (const r of repos) emails.add(r.commitIdentity?.email, r.name);

  const statuses = collect();
  for (const s of settings?.notion.statuses ?? []) statuses.add(s);

  const versions = collect();
  versions.add(settings?.notion.version, 'Settings > Notion');
  versions.add(NOTION_VERSION_DEFAULT, 'Built-in');

  return {
    GITLAB_HOST: hosts.out,
    VU_ASSIGNEE: people.out,
    MRC_REVIEWER: people.out,
    VU_BRANCH_PREFIX: prefixes.out,
    VU_COMMIT_NAME: names.out,
    VU_COMMIT_EMAIL: emails.out,
    REAUTHOR_WORK_HOSTS: hostnames.out,
    NOTION_DATA_SOURCE_ID: sources.map((s) => ({
      value: s.id,
      label: `${s.emoji ? `${s.emoji} ` : ''}${s.title || 'Untitled'}`,
      hint: s.id.slice(0, 8),
    })),
    NOTION_READY_STATUS: statuses.out,
    NOTION_VERSION: versions.out,
  };
}
