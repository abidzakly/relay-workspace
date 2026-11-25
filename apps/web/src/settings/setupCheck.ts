import { useWorkspaces } from '@/lib/cockpitApi';
import { useBrowserPush } from '@/lib/push';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useDriveKey, useRepos, useSettings } from '@/lib/settingsApi';
import { useUiStore } from '@/store/ui';
import { SETTINGS_SECTIONS, type SettingsGroupId } from './sections';

/**
 * What is still not set up, and what does not work until it is. Built from what the server and this browser report
 * now, so it is true after a config import too: an import never brings the Drive key file, workspaces, or this
 * browser's notifications, and it brings repo tokens and the Notion token only when the file sealed them.
 */
export interface SetupItem {
  id: string;
  /** The settings section that fixes it (a `#hash` on the Settings page). */
  section: string;
  group: SettingsGroupId;
  /** `needed`: a feature does not work without it. `optional`: works, with less. */
  level: 'needed' | 'optional';
  title: string;
  /** What the user sees until it is set. */
  effect: string;
}

const groupOf = (section: string): SettingsGroupId =>
  SETTINGS_SECTIONS.find((s) => s.id === section)?.group ?? 'general';

function item(
  id: string,
  section: string,
  level: SetupItem['level'],
  title: string,
  effect: string,
): SetupItem {
  return { id, section, group: groupOf(section), level, title, effect };
}

export interface SetupCheck {
  /** Not set and not ignored. */
  items: SetupItem[];
  /** Not set, but the user chose to stop seeing them. */
  ignored: SetupItem[];
  loading: boolean;
}

/** The setup list with the user's ignores applied. Ignores live in this browser (`core-ui`). */
export function useSetupCheck(): SetupCheck {
  const all = useSetupItems();
  const ignoredIds = useUiStore((st) => st.setupIgnored);
  return {
    items: all.items.filter((i) => !ignoredIds.includes(i.id)),
    ignored: all.items.filter((i) => ignoredIds.includes(i.id)),
    loading: all.loading,
  };
}

function useSetupItems(): { items: SetupItem[]; loading: boolean } {
  const settings = useSettings();
  const repos = useRepos();
  const driveKey = useDriveKey();
  const workspaces = useWorkspaces();
  const push = useBrowserPush();
  // "Connect" sign-ins stand in for the pasted tokens and the Drive key.
  const oauth = useOAuthStatus().data;
  const gitlabIn = !!oauth?.gitlab.connected;
  const notionIn = !!oauth?.notion.connected;
  const driveIn = !!oauth?.google.features.includes('drive');

  const s = settings.data;
  const r = repos.data;
  const loading = settings.isPending || repos.isPending || settings.isFetching || repos.isFetching;
  if (!s || !r) return { items: [], loading };

  const items: SetupItem[] = [];

  if (!s.gitlab.host) {
    items.push(
      item(
        'gitlab-host',
        'gitlab',
        'needed',
        'GitLab host',
        'Nothing syncs from GitLab: no MRs, pipelines or builds.',
      ),
    );
  }
  if (!s.gitlab.myUsername) {
    items.push(
      item(
        'gitlab-me',
        'gitlab',
        'needed',
        'Your GitLab username',
        'Open MRs are not fetched, and “mine” filters and KPI stay empty.',
      ),
    );
  }
  if (r.length === 0) {
    items.push(
      item(
        'repos',
        'repos',
        'needed',
        'A repository',
        'The Board, MRs and builds have no project to read.',
      ),
    );
  }
  // One row per repo, so ignoring one repo does not hide a repo added later.
  for (const x of gitlabIn ? [] : r.filter((x) => !x.gitlab.tokenSet)) {
    items.push(
      item(
        `repo-token:${x.id}`,
        'repos',
        'needed',
        `GitLab token for ${x.name}`,
        'This repo does not sync. Tokens come with an import only when it was exported with a passphrase.',
      ),
    );
  }
  // One way in at a time: the sign-in (Connect mode) or the integration token (Advanced mode).
  const notionToken = s.notion.authMode === 'token';
  if (notionToken ? !s.notion.tokenSet : !notionIn) {
    items.push(
      item(
        'notion-token',
        'notion',
        'optional',
        notionToken ? 'Notion integration token' : 'Connect Notion',
        notionToken
          ? 'Advanced mode is on but no token is saved. The token comes with an import only when sealed.'
          : 'Only needed for the Board, Sync Health, KPI and Sprints. Connect, then run the Notion setup.',
      ),
    );
  }
  if (!s.notion.dataSourceId) {
    items.push(
      item('notion-ds', 'notion', 'optional', 'Notion data source id', 'No Notion cards are read.'),
    );
  }
  if (s.notion.assigneeAliases.length === 0) {
    items.push(
      item(
        'notion-me',
        'notion',
        'optional',
        'Your names in Notion (My names)',
        'Your Notion cards are not fetched, so KPI and your Board stay empty.',
      ),
    );
  }
  const driveFolders = r.some((x) => x.drive.folderId);
  if (driveFolders && !driveIn && driveKey.data && !driveKey.data.ok) {
    items.push(
      item(
        'drive-key',
        'drive',
        'needed',
        'Drive service-account key file',
        `${driveKey.data.message} Staging uploads fail. It is a file (${driveKey.data.keyPath}), so an import never brings it.`,
      ),
    );
  }
  if (!s.publicBaseUrl) {
    items.push(
      item(
        'public-url',
        'gitlab',
        'optional',
        'Public base URL',
        'GitLab webhooks cannot reach this dashboard; changes arrive by polling, a little later.',
      ),
    );
  }
  if (workspaces.data && workspaces.data.length === 0) {
    items.push(
      item(
        'workspaces',
        'workspaces',
        'optional',
        'A Cockpit workspace',
        'The Cockpit cannot open an agent, terminal or editor. Workspaces are per machine, never in an import.',
      ),
    );
  }
  if (push.kind === 'off') {
    items.push(
      item(
        'push',
        'notifications',
        'optional',
        'Notifications in this browser',
        'No alerts while the tab is closed. Each browser turns this on by itself.',
      ),
    );
  } else if (push.kind === 'server_off') {
    items.push(
      item(
        'push-server',
        'notifications',
        'optional',
        'Push keys on the server',
        'No browser notifications: VAPID keys are missing from .env.',
      ),
    );
  }

  return { items, loading };
}
