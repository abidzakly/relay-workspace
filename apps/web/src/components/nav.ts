import {
  Activity,
  Gem,
  Send,
  Bell,
  Bot,
  GitCompare,
  Hammer,
  Home,
  Inbox,
  Kanban,
  LayoutDashboard,
  type LucideIcon,
  ScanEye,
  ScrollText,
  Settings as SettingsIcon,
  Target,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Second key of the `g <key>` shortcut. */
  chord: string;
  end?: boolean;
  /** Only meaningful with the Living Workspace landing (hidden from the classic sidebar). */
  sceneOnly?: boolean;
}

/** (MR Detail is a drawer/deep link, not a nav entry). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Workspace', icon: Home, chord: 'w', end: true, sceneOnly: true },
  { to: '/overview', label: 'Overview', icon: LayoutDashboard, chord: 'o' },
  { to: '/notifications', label: 'Notifications', icon: Bell, chord: 'n' },
  { to: '/board', label: 'Board', icon: Kanban, chord: 'b' },
  { to: '/mrs', label: 'MR Inbox', icon: Inbox, chord: 'm' },
  { to: '/review', label: 'Code Review', icon: GitCompare, chord: 'c' },
  { to: '/reviews', label: 'Reviews', icon: ScanEye, chord: 'v' },
  { to: '/cockpit', label: 'Cockpit', icon: Bot, chord: 'x' },
  { to: '/sync', label: 'Sync Health', icon: Activity, chord: 'h' },
  { to: '/release', label: 'Release', icon: Send, chord: 'r' },
  { to: '/builds', label: 'Builds', icon: Hammer, chord: 'u' },
  { to: '/kpi', label: 'KPI', icon: Target, chord: 'k' },
  { to: '/sprints', label: 'Sprint Atelier', icon: Gem, chord: 'p' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, chord: 's' },
  { to: '/audit', label: 'Audit', icon: ScrollText, chord: 'a' },
];
