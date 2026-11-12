import {
  Activity,
  Gem,
  Send,
  GitCompare,
  Hammer,
  Inbox,
  Kanban,
  LayoutDashboard,
  type LucideIcon,
  ScrollText,
  Settings as SettingsIcon,
  Target,
} from 'lucide-react';

/**
 * The Living Workspace's interactive objects: one per tab, plus the Code Review gateway, a destination of its own that
 * never replaces one of the original eleven. Pure data, free of three.js, so the DOM menu, the router glue and the
 * scene all read the same list. Each world places and draws them its own way (`environments/<env>/`). The ids are
 * historical names, stable for the URL-free parts of the app (hover state, tests).
 */
export type ObjectId =
  | 'monitor'
  | 'review'
  | 'notes'
  | 'kpi'
  | 'router'
  | 'train'
  | 'printer'
  | 'ship'
  | 'toolbox'
  | 'cabinet'
  | 'plant';

/** The original eleven dashboard tabs. Never extended: new places are destinations. */
export type DashboardTab =
  | 'mrInbox'
  | 'board'
  | 'kpi'
  | 'overview'
  | 'syncHealth'
  | 'releaseTrain'
  | 'sprintHarbor'
  | 'builds'
  | 'settings'
  | 'audit';

/** Where an object leads: a tab, or a specialised destination beside them. */
export type WorkspaceDestination = DashboardTab | 'codeReview';

export interface WorkspaceObject {
  id: ObjectId;
  /** What it opens, independent of how any environment draws it. */
  destination: WorkspaceDestination;
  /** `tab` = one of the original eleven; `destination` = a place beside them (Code Review). */
  kind: 'tab' | 'destination';
  /** The tab it opens. */
  label: string;
  route: string;
  icon: LucideIcon;
}

export const OBJECTS: readonly WorkspaceObject[] = [
  {
    id: 'monitor',
    destination: 'mrInbox',
    kind: 'tab',
    label: 'MR Inbox',
    route: '/mrs',
    icon: Inbox,
  },
  {
    id: 'review',
    destination: 'codeReview',
    kind: 'destination',
    label: 'Code Review',
    route: '/review',
    icon: GitCompare,
  },
  {
    id: 'notes',
    destination: 'board',
    kind: 'tab',
    label: 'Board',
    route: '/board',
    icon: Kanban,
  },
  {
    id: 'kpi',
    destination: 'kpi',
    kind: 'tab',
    label: 'KPI',
    route: '/kpi',
    icon: Target,
  },
  {
    id: 'plant',
    destination: 'overview',
    kind: 'tab',
    label: 'Overview',
    route: '/overview',
    icon: LayoutDashboard,
  },
  {
    id: 'router',
    destination: 'syncHealth',
    kind: 'tab',
    label: 'Sync Health',
    route: '/sync',
    icon: Activity,
  },
  {
    id: 'train',
    destination: 'releaseTrain',
    kind: 'tab',
    label: 'Release',
    route: '/release',
    icon: Send,
  },
  {
    id: 'printer',
    destination: 'builds',
    kind: 'tab',
    label: 'Builds',
    route: '/builds',
    icon: Hammer,
  },
  {
    id: 'ship',
    destination: 'sprintHarbor',
    kind: 'tab',
    label: 'Sprint Atelier',
    route: '/sprints',
    icon: Gem,
  },
  {
    id: 'toolbox',
    destination: 'settings',
    kind: 'tab',
    label: 'Settings',
    route: '/settings',
    icon: SettingsIcon,
  },
  {
    id: 'cabinet',
    destination: 'audit',
    kind: 'tab',
    label: 'Audit',
    route: '/audit',
    icon: ScrollText,
  },
];

export const objectById = (id: ObjectId): WorkspaceObject =>
  OBJECTS.find((o) => o.id === id) as WorkspaceObject;

/**
 * Gateways: places in a world that lead to a destination without being one of its objects ("the telescope
 * itself does not need to be a separate dashboard tab. It is a navigation gateway"). The observatory opens Overview,
 * the same route as the Overview object, by the cinematic way. Not in the menu: the Overview item already leads there.
 */
export type GatewayId = 'observatory' | 'bench';
export type PickId = ObjectId | GatewayId;

export interface WorldGateway {
  id: GatewayId;
  label: string;
  route: string;
  /** The object whose signal its tooltip shows. Null: the tooltip only names it. */
  signalOf: ObjectId | null;
  /** Route state that tells the camera which way to go. */
  state?: { via: 'observatory' };
}

export const GATEWAYS: readonly WorldGateway[] = [
  {
    id: 'observatory',
    label: 'Overview',
    route: '/overview',
    signalOf: 'plant',
    state: { via: 'observatory' },
  },
  // The helpers' workbench: the Cockpit has no tab, so it is a place in the world (and a dock entry).
  { id: 'bench', label: 'Cockpit', route: '/cockpit', signalOf: null },
];

export const isGateway = (id: PickId): id is GatewayId => GATEWAYS.some((g) => g.id === id);

/** What the tooltip and the click need, for an object or a gateway (the thing's name is per world: `objects/names.ts`). */
export function pickInfo(id: PickId): {
  label: string;
  route: string;
  signalOf: ObjectId | null;
  state?: WorldGateway['state'];
} {
  if (isGateway(id)) {
    const g = GATEWAYS.find((x) => x.id === id)!;
    return {
      label: g.label,
      route: g.route,
      signalOf: g.signalOf,
      ...(g.state ? { state: g.state } : {}),
    };
  }
  const o = objectById(id);
  return { label: o.label, route: o.route, signalOf: o.id };
}

/** The camera's way into Overview, from route state (`navigate(route, { state })`). */
export const viaOf = (state: unknown): 'observatory' | null =>
  typeof state === 'object' && state !== null && (state as { via?: unknown }).via === 'observatory'
    ? 'observatory'
    : null;

/**
 * The object a URL belongs to; null = the world itself (`/`). A sub-route (the MR drawer at `/mrs/:repo/:iid`, a review
 * session at `/review/:repo/mr/:iid`) stays on its tab's object. A path no object owns still opens as a page over the world.
 */
export function objectForPath(pathname: string): ObjectId | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return null;
  for (const o of OBJECTS) {
    if (path === o.route || path.startsWith(`${o.route}/`)) return o.id;
  }
  return null;
}

/** True when the URL shows a page over the world (any path but `/`). */
export const isPagePath = (pathname: string): boolean =>
  (pathname.replace(/\/+$/, '') || '/') !== '/';
