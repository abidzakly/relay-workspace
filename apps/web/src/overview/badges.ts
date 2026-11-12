import {
  Bug,
  CalendarCheck,
  FlaskConical,
  ShieldCheck,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { BadgeId } from '@relay/shared';

export const BADGES: Record<BadgeId, { name: string; rule: string; icon: LucideIcon }> = {
  zero_mismatches: {
    name: 'Zero Mismatches',
    rule: 'A release shipped with no Sync Health mismatches',
    icon: ShieldCheck,
  },
  five_approvals_day: {
    name: '5 Approvals in a Day',
    rule: 'Five approvals received in one day',
    icon: CalendarCheck,
  },
  bug_slayer: {
    name: 'Bug Slayer',
    rule: 'A finished month under the bug ratio limit',
    icon: Bug,
  },
  researcher: { name: 'Researcher', rule: 'The monthly research quota met', icon: FlaskConical },
  first_try: { name: 'First Try', rule: 'An MR approved without comments', icon: Target },
};
