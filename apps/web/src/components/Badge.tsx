import {
  Check,
  CircleCheck,
  CircleAlert,
  Hourglass,
  Lightbulb,
  MessageSquare,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { MrDerivedState, Severity, WaitingOn } from '@relay/shared';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

export { Badge };

type Variant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const SEVERITY: Record<Severity, { variant: Variant; icon: LucideIcon; label: string }> = {
  ok: { variant: 'success', icon: CircleCheck, label: 'in sync' },
  info: { variant: 'secondary', icon: Lightbulb, label: 'note' },
  warn: { variant: 'warning', icon: TriangleAlert, label: 'warning' },
  action: { variant: 'warning', icon: CircleAlert, label: 'action' },
  critical: { variant: 'destructive', icon: OctagonAlert, label: 'critical' },
};

/** Health badge. Colour is never the only signal: icon + label are always present. */
export function SeverityBadge({ severity, title }: { severity: Severity; title?: string }) {
  const s = SEVERITY[severity];
  return (
    <Badge variant={s.variant} title={title ?? s.label}>
      <s.icon aria-hidden />
      {s.label}
    </Badge>
  );
}

const MR_STATE: Record<MrDerivedState, { variant: Variant; label: string; icon?: LucideIcon }> = {
  none: { variant: 'outline', label: 'no MR' },
  draft: { variant: 'secondary', label: 'draft' },
  open: { variant: 'default', label: 'open' },
  reviewed: { variant: 'warning', label: 'reviewed' },
  approved: { variant: 'success', label: 'approved', icon: Check },
  merged: { variant: 'success', label: 'merged', icon: Check },
  closed: { variant: 'destructive', label: 'closed' },
};

export function MrStateBadge({ state }: { state: MrDerivedState }) {
  const s = MR_STATE[state];
  return (
    <Badge variant={s.variant}>
      {s.icon && <s.icon aria-hidden />}
      {s.label}
    </Badge>
  );
}

const WAITING: Record<WaitingOn, { variant: Variant; label: string; icon: LucideIcon } | null> = {
  reviewer: { variant: 'secondary', label: 'waiting for reviewer', icon: Hourglass },
  you: { variant: 'warning', label: 'waiting for you', icon: MessageSquare },
  approved: { variant: 'success', label: 'approved', icon: CircleCheck },
  draft: null,
  none: null,
};

export function WaitingBadge({ kind }: { kind: WaitingOn }) {
  const w = WAITING[kind];
  return w ? (
    <Badge variant={w.variant}>
      <w.icon aria-hidden />
      {w.label}
    </Badge>
  ) : null;
}
