import {
  ArrowRight,
  Ban,
  Check,
  Circle,
  CircleDashed,
  CircleDot,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback } from 'react';
import {
  isMyUser,
  isTokenBot,
  type HeadPipeline,
  type NeedsAction,
  type Source,
} from '@relay/shared';
import { Badge } from '@/components/Badge';
import { useMyUsernames } from '@/lib/settingsApi';

const PIPELINE: Record<
  string,
  { variant: 'success' | 'warning' | 'destructive' | 'secondary'; icon: LucideIcon }
> = {
  success: { variant: 'success', icon: Check },
  failed: { variant: 'destructive', icon: X },
  canceled: { variant: 'secondary', icon: Ban },
  skipped: { variant: 'secondary', icon: Ban },
  running: { variant: 'warning', icon: CircleDot },
  pending: { variant: 'warning', icon: CircleDashed },
};

/** Pipeline status; the text is always shown, never colour alone. */
export function PipelineBadge({ pipeline }: { pipeline: HeadPipeline | null }) {
  if (!pipeline) return <Badge variant="outline">no pipeline</Badge>;
  const p = PIPELINE[pipeline.status] ?? { variant: 'secondary' as const, icon: Circle };
  return (
    <Badge variant={p.variant}>
      <p.icon aria-hidden />
      pipeline {pipeline.status}
    </Badge>
  );
}

export function ActionBadge({ action }: { action: NeedsAction }) {
  return (
    <Badge variant={action.yours ? 'warning' : action.kind === 'merged' ? 'success' : 'secondary'}>
      {action.yours && <ArrowRight aria-hidden />}
      {action.label}
    </Badge>
  );
}

/**
 * `me` for my username or one of my repo tokens' bot users, `bot` for any other access-token user
 * (`project_409_bot_d263…`: a long hash, not a person), else `@user`. The full username belongs in a `title`.
 */
export function userLabel(username: string, mine: readonly string[] = []): string {
  if (isMyUser(username, mine)) return 'me';
  return isTokenBot(username) ? 'bot' : `@${username}`;
}

/** `userLabel` bound to the usernames that are "me". */
export function useUserLabel(): (username: string) => string {
  const mine = useMyUsernames().data;
  return useCallback((username: string) => userLabel(username, mine ?? []), [mine]);
}

/** Badge classes for one that holds user text: it may wrap and never widens its container. */
export const WRAP_BADGE = 'max-w-full shrink whitespace-normal [overflow-wrap:anywhere]';

/** Where a drawer section came from: only non-live data is called out. */
export function SourceNote({ source }: { source: Source }) {
  if (source === 'live') return null;
  return (
    <span className="text-xs text-muted-foreground">
      {source === 'cache' ? '(cached, GitLab not read live)' : '(unavailable)'}
    </span>
  );
}
