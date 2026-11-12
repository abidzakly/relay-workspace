/**
 * Where each Settings section lives. The page shows one group at a time; the hash picks it (`#connections`) or
 * points at a section inside one (`#notion`). Keywords are the field labels inside a card, so search finds a field.
 */
export const SETTINGS_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'repositories', label: 'Repos' },
  { id: 'planning', label: 'Planning' },
  { id: 'data', label: 'Data' },
  { id: 'browser', label: 'This browser' },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

export interface SettingsSection {
  id: string;
  group: SettingsGroupId;
  title: string;
  keywords: string[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'features',
    group: 'general',
    title: 'Features',
    keywords: [
      'switch off',
      'hide',
      'enable',
      'disable',
      'menu',
      'reviews',
      'kpi',
      'freelance',
      'board',
      'cockpit',
      'release',
      'builds',
      'sprints',
      'postrack',
    ],
  },
  {
    id: 'safety',
    group: 'general',
    title: 'Safety & engine',
    keywords: ['dry-run', 'dry run', 'release engine', 'safety'],
  },
  {
    id: 'notifications',
    group: 'general',
    title: 'Notifications',
    keywords: ['web push', 'browser', 'ignore my own actions', 'events', 'alerts'],
  },
  {
    id: 'gitlab',
    group: 'connections',
    title: 'GitLab & public URL',
    keywords: ['host', 'username', 'public url', 'webhook address', 'token'],
  },
  {
    id: 'reviewer',
    group: 'connections',
    title: 'Reviewer access',
    keywords: [
      'reviews',
      'personal access token',
      'mentions',
      'reviewer',
      'webhook',
      'group webhook',
      'poll',
      'secret',
    ],
  },
  {
    id: 'notion',
    group: 'connections',
    title: 'Notion mapping',
    keywords: [
      'token',
      'data source',
      'version',
      'ready status',
      'properties',
      'my names',
      'aliases',
      'statuses',
      'assignee',
      'test connection',
    ],
  },
  {
    id: 'drive',
    group: 'connections',
    title: 'Google Drive',
    keywords: [
      'service account',
      'key',
      'anyone with the link',
      'folder',
      'shared drive',
      'upload',
    ],
  },
  {
    id: 'postrack',
    group: 'connections',
    title: 'Postrack',
    keywords: ['postrack', 'api', 'mcp', 'endpoint', 'mock', 'environment', 'oauth', 'api key'],
  },
  {
    id: 'ai',
    group: 'connections',
    title: 'AI engines',
    keywords: ['claude', 'cursor', 'coding agent', 'model', 'check connection', 'fallback'],
  },
  {
    id: 'ai-prompts',
    group: 'connections',
    title: 'AI prompts',
    keywords: ['prompt', 'template', 'explain', 'grade', 'summary', 'triage', 'quiz', 'ai'],
  },
  {
    id: 'repos',
    group: 'repositories',
    title: 'Repositories',
    keywords: [
      'gitlab project',
      'on the board',
      'token',
      'reviewers',
      'webhook',
      'drive folder',
      'test connection',
    ],
  },
  {
    id: 'workspaces',
    group: 'repositories',
    title: 'Workspaces',
    keywords: [
      'cockpit',
      'folder on this computer',
      'folder',
      'base branch',
      'mark',
      'agent',
      'terminal',
    ],
  },
  {
    id: 'scripts',
    group: 'repositories',
    title: 'Release scripts',
    keywords: [
      'vu',
      'mrc',
      'vcheck',
      'nts',
      'reauthor',
      'glab',
      'terminal',
      'commit author',
      'branch prefix',
      'env file',
    ],
  },
  {
    id: 'webhooks',
    group: 'repositories',
    title: 'Webhook health',
    keywords: ['delivery', 'last delivery', 'polling'],
  },
  {
    id: 'planning',
    group: 'planning',
    title: 'Planning',
    keywords: ['sprint', 'capacity', 'kpi', 'presets', 'points', 'research', 'bug ratio'],
  },
  {
    id: 'storage',
    group: 'data',
    title: 'Storage',
    keywords: ['cleanup', 'disk', 'scan', 'daily', 'leftovers', 'cache', 'checkpoints'],
  },
  {
    id: 'backup',
    group: 'data',
    title: 'Backup & export',
    keywords: ['export config', 'import config', 'passphrase', 'secrets', 'database backup'],
  },
  {
    id: 'appearance',
    group: 'browser',
    title: 'Appearance & 3D core',
    keywords: [
      'landing page',
      'theme',
      'core view',
      'progress scope',
      'ascii',
      'frame rate',
      'fps',
      'sound',
      'haptics',
    ],
  },
  {
    id: 'visuals',
    group: 'browser',
    title: 'Page visuals',
    keywords: [
      'pictures',
      'gestures',
      'visuals on other pages',
      'board',
      'release',
      'builds',
      'sync health',
    ],
  },
];

const BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]));

export function isGroupId(id: string): id is SettingsGroupId {
  return SETTINGS_GROUPS.some((g) => g.id === id);
}

/** The group a hash points at: a group itself, or the group holding that section. */
export function groupOfHash(hash: string): SettingsGroupId | null {
  const id = hash.replace(/^#/, '');
  if (isGroupId(id)) return id;
  return BY_ID.get(id)?.group ?? null;
}

export function sectionOfHash(hash: string): SettingsSection | null {
  return BY_ID.get(hash.replace(/^#/, '')) ?? null;
}

/** Every word of the query must appear in the title, the group name or a keyword. */
export function matchesQuery(section: SettingsSection, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const group = SETTINGS_GROUPS.find((g) => g.id === section.group)?.label ?? '';
  const hay = [section.title, group, ...section.keywords].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}
