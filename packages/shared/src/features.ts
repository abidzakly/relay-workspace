import { z } from 'zod';
import type { RepoPresets } from './presets';

/**
 * Feature switches (Settings > General > Features). Each person turns off the parts of the dashboard they do not use:
 * a freelancer without KPIs, a reviewer who never releases. Everything is on by default except Reviews, which needs a
 * personal GitLab token first. A switched-off feature leaves the nav, the command palette and the workspace menu, its
 * page shows a "turned off" note, and its background work (the Reviews poll) stops. Data is kept.
 */
export const FEATURE_IDS = [
  'board',
  'mrInbox',
  'codeReview',
  'reviews',
  'cockpit',
  'testBench',
  'release',
  'builds',
  'syncHealth',
  'kpi',
  'sprints',
  'reader',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

const OFF_BY_DEFAULT: ReadonlySet<FeatureId> = new Set(['reviews']);

export const FeaturesSchema = z.object(
  Object.fromEntries(
    FEATURE_IDS.map((id) => [id, z.boolean().default(!OFF_BY_DEFAULT.has(id))]),
  ) as Record<FeatureId, z.ZodDefault<z.ZodBoolean>>,
);
export type Features = z.infer<typeof FeaturesSchema>;

export const FEATURE_GROUPS = [
  { id: 'code', label: 'Code & review' },
  { id: 'ship', label: 'Build & ship' },
  { id: 'plan', label: 'Planning' },
] as const;
export type FeatureGroupId = (typeof FEATURE_GROUPS)[number]['id'];

export interface FeatureInfo {
  id: FeatureId;
  group: FeatureGroupId;
  label: string;
  description: string;
  /** Page paths this feature owns (prefix match on a `/` boundary). */
  routes: readonly string[];
  /**
   * Runs macOS/Linux tools (shell scripts, `.cmd` launchers, process groups). On Windows it needs WSL; run natively on
   * Windows it is switched off and says why.
   */
  needsPosix?: true;
  /** Reads Notion cards. Without a Notion connection the page says so instead of showing empty data. */
  needsNotion?: true;
}

export const FEATURES: readonly FeatureInfo[] = [
  {
    id: 'board',
    group: 'plan',
    label: 'Board',
    description: 'Your Notion cards by status, with their merge requests.',
    routes: ['/board'],
    needsNotion: true,
  },
  {
    id: 'mrInbox',
    group: 'code',
    label: 'MR Inbox',
    description: 'Merge requests of your repos, sorted by what needs you.',
    routes: ['/mrs', '/mr-create'],
  },
  {
    id: 'codeReview',
    group: 'code',
    label: 'Code Review',
    description: 'Read the diff of a merge request or two branches of your repos.',
    routes: ['/review'],
  },
  {
    id: 'reviews',
    group: 'code',
    label: 'Reviews',
    description:
      'Merge requests in any project where you are a reviewer or were mentioned. Needs a personal GitLab token.',
    routes: ['/reviews'],
  },
  {
    id: 'cockpit',
    group: 'ship',
    label: 'Cockpit',
    description: 'Coding agent sessions on your cards, in their own worktrees.',
    routes: ['/cockpit'],
    needsPosix: true,
  },
  {
    id: 'testBench',
    group: 'ship',
    label: 'Test Bench',
    description: 'Check a running app against its Figma frames.',
    routes: ['/test-bench'],
    needsPosix: true,
  },
  {
    id: 'release',
    group: 'ship',
    label: 'Release',
    description: 'Version merge requests, tags and the release train.',
    routes: ['/release'],
  },
  {
    id: 'builds',
    group: 'ship',
    label: 'Builds',
    description: 'Flutter builds, uploads and the build queue.',
    routes: ['/builds'],
    needsPosix: true,
  },
  {
    id: 'syncHealth',
    group: 'plan',
    label: 'Sync Health',
    description: 'Cards and merge requests that disagree, with one-click fixes.',
    routes: ['/sync'],
    needsNotion: true,
  },
  {
    id: 'kpi',
    group: 'plan',
    label: 'KPI',
    description: 'Points, effort and SLA presets for teams that track them.',
    routes: ['/kpi'],
    needsNotion: true,
  },
  {
    id: 'sprints',
    group: 'plan',
    label: 'Sprints',
    description: 'Sprint capacity and what fits in it.',
    routes: ['/sprints'],
    needsNotion: true,
  },
  {
    id: 'reader',
    group: 'plan',
    label: 'Reader',
    description: 'Markdown and text documents to read in a calm column, on any device.',
    routes: ['/reader'],
  },
];

const under = (path: string, route: string) => path === route || path.startsWith(`${route}/`);

/**
 * The feature that owns a page path, or null for the always-on pages (Workspace, Overview, Notifications, Settings,
 * Audit). `/review/...` sessions also serve Reviews: they count as on when either feature is on.
 */
export function featuresOfPath(path: string): FeatureId[] {
  // `/reviews` must not fall under `/review`.
  const hits = FEATURES.filter((f) => f.routes.some((r) => under(path, r))).map((f) => f.id);
  if (hits.includes('codeReview') && under(path, '/review')) {
    return path === '/review' ? ['codeReview'] : ['codeReview', 'reviews'];
  }
  return hits;
}

/** true when the page at `path` may be shown. */
export function pathEnabled(path: string, features: Features): boolean {
  const owners = featuresOfPath(path);
  return owners.length === 0 || owners.some((id) => features[id]);
}

/** What "do you release a mobile app?" switches: on for yes, off for no. Everything else is left alone. */
export const MOBILE_RELEASE_FEATURES: readonly FeatureId[] = ['release', 'builds'];

export function featuresForMobileRelease(features: Features, releasesMobileApp: boolean): Features {
  return {
    ...features,
    ...Object.fromEntries(MOBILE_RELEASE_FEATURES.map((id) => [id, releasesMobileApp])),
  };
}

/** Features that need WSL when the server runs natively on Windows. */
export const POSIX_FEATURES: readonly FeatureId[] = FEATURES.filter((f) => f.needsPosix).map(
  (f) => f.id,
);

/** Where the server runs, as the onboarding and Settings need it. */
export const OS_KINDS = ['macos', 'linux', 'windows', 'other'] as const;
export type OsKind = (typeof OS_KINDS)[number];

export interface SystemInfo {
  os: OsKind;
  /** Running inside WSL (Linux on Windows): every feature works. */
  wsl: boolean;
  /** Features that cannot run here and why (empty on macOS, Linux and WSL). */
  unsupported: { id: FeatureId; reason: string }[];
  /** The edition whose presets were loaded (`editions/<name>/presets.json`), or null. */
  edition: string | null;
  /** Defaults for the "Add repository" form, from the edition presets. */
  repoDefaults: RepoPresets;
}

export function featuresForWindowsNative(features: Features): Features {
  return { ...features, ...Object.fromEntries(POSIX_FEATURES.map((id) => [id, false])) };
}

/** true when Notion is connected: a token and a data source. */
export function notionConnected(n: {
  tokenSet: boolean;
  dataSourceId?: string | undefined;
}): boolean {
  return n.tokenSet && Boolean(n.dataSourceId);
}
