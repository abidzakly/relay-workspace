import { AnimatePresence, motion } from 'motion/react';
import { LAND } from '@/lib/motion/patterns';
import { emit } from '@/lib/reward/engine';
import {
  AlarmClock,
  AlertTriangle,
  Bell,
  Bot,
  CheckCheck,
  CheckCircle2,
  Clock,
  GitBranch,
  GitMerge,
  Loader2,
  type LucideIcon,
  MessageSquare,
  Package,
  Reply,
  ScanEye,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  formatAgo,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  type NotificationAction,
  type NotificationCategory,
  type NotificationItem,
  type NotificationLifecycle,
  type NotificationPriority,
} from '@relay/shared';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { MR_OPEN_MERGE_STATE } from '@/lib/mrApi';
import {
  notificationTitle,
  useDismissHandledNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotificationSummary,
  useNotifications,
  type NotificationQuery,
} from '@/lib/notificationApi';
import { useRepos } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';
import { PageTitle } from '@/components/PageTitle';

const EVENT_ICON: Record<NotificationItem['event'], LucideIcon> = {
  approved: CheckCircle2,
  comment: MessageSquare,
  reply: Reply,
  merged: GitMerge,
  pipelineFailed: XCircle,
  buildDone: Package,
  mismatch: AlertTriangle,
  slaWarn: Clock,
  slaBreach: AlarmClock,
  readyForMr: GitBranch,
  agentDone: Bot,
  reviewRequested: ScanEye,
  test: Bell,
};

type Tab = NotificationLifecycle | 'all';

const TABS: { value: Tab; label: string; empty: string }[] = [
  { value: 'needs_action', label: 'Needs action', empty: 'Nothing needs you right now.' },
  { value: 'stale', label: 'Stale', empty: 'Nothing stale.' },
  { value: 'handled_elsewhere', label: 'Handled elsewhere', empty: 'Nothing handled elsewhere.' },
  { value: 'all', label: 'All', empty: 'No notifications yet.' },
];

const PRIORITY_LABEL: Record<NotificationPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};
const PRIORITY_RANK: Record<NotificationPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  mr: 'Merge request',
  pipeline: 'Pipeline',
  sla: 'SLA',
  build: 'Build',
  agent: 'Agent',
  system: 'System',
};

function pick<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  return (raw?.split(',') ?? []).filter((v): v is T => (allowed as readonly string[]).includes(v));
}

function LifecycleBadge({ item }: { item: NotificationItem }) {
  const { live, lifecycle } = item;
  switch (lifecycle) {
    case 'needs_action':
      return <Badge variant="warning">{live.note ?? 'Needs action'}</Badge>;
    case 'stale':
      return (
        <Badge variant="secondary" title={live.note ?? undefined}>
          Stale · {formatAgo(Date.now() - item.at)}
          {live.note ? ` · ${live.note}` : ''}
        </Badge>
      );
    case 'handled_elsewhere':
      return <Badge variant="success">Handled · {live.note ?? 'done'}</Badge>;
    case 'info':
      return live.note ? <Badge variant="secondary">{live.note}</Badge> : null;
  }
}

function PriorityBadge({ priority }: { priority: NotificationPriority }) {
  if (priority === 'urgent') return <Badge variant="destructive">Urgent</Badge>;
  if (priority === 'high') return <Badge variant="warning">High</Badge>;
  return null;
}

function NotificationRow({ item }: { item: NotificationItem }) {
  const navigate = useNavigate();
  const markRead = useMarkNotificationRead();
  const Icon = EVENT_ICON[item.event];
  const unread = item.readAt === null;
  const muted = item.lifecycle === 'handled_elsewhere' || item.lifecycle === 'stale';

  const run = (action: NotificationAction) => {
    if (unread) markRead.mutate(item.id);
    void navigate(action.url, action.openMerge ? { state: MR_OPEN_MERGE_STATE } : {});
  };

  return (
    <motion.li
      variants={LAND}
      initial="hidden"
      animate="shown"
      className={cn(
        'flex gap-3 border-b p-3 last:border-b-0 md:p-4',
        'border-l-4 border-l-transparent',
        item.priority === 'urgent' && !muted && 'border-l-destructive',
        item.priority === 'high' && !muted && 'border-l-warning',
        unread && 'bg-accent/30',
        muted && 'opacity-75',
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <p className={cn('text-sm [overflow-wrap:anywhere]', unread && 'font-semibold')}>
            {unread && <span className="sr-only">Unread: </span>}
            {notificationTitle(item.title)}
          </p>
          {item.body && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{item.body}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TimeAgo at={item.at} className="text-xs text-muted-foreground" />
          {!muted && <PriorityBadge priority={item.priority} />}
          <Badge variant="outline">{CATEGORY_LABEL[item.category]}</Badge>
          <LifecycleBadge item={item} />
        </div>
        {(item.live.actions.length > 0 || unread) && (
          <div className="flex flex-wrap items-center gap-2">
            {item.live.actions.map((action, i) => (
              <Button
                key={action.label}
                size="sm"
                variant={i === 0 && item.live.status === 'actionable' ? 'default' : 'outline'}
                onClick={() => run(action)}
              >
                {action.label}
              </Button>
            ))}
            {unread && (
              <Button
                size="sm"
                variant="ghost"
                disabled={markRead.isPending}
                onClick={() =>
                  markRead.mutate(item.id, {
                    onSuccess: () =>
                      emit({ level: 'tick', key: 'notification:read', repeatable: true }),
                  })
                }
              >
                Mark read
              </Button>
            )}
          </div>
        )}
      </div>
    </motion.li>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'secondary' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function Notifications() {
  const [params, setParams] = useSearchParams();
  const tab = pick(params.get('tab'), [...TABS.map((t) => t.value)])[0] ?? 'needs_action';
  // Stale and handled rows are what "Clear" marks read, so those tabs hide read rows unless asked.
  const clearTab = tab === 'stale' || tab === 'handled_elsewhere';
  const unreadOnly = clearTab ? params.get('read') !== '1' : params.get('unread') === '1';
  const priority = pick(params.get('priority'), NOTIFICATION_PRIORITIES);
  const category = pick(params.get('category'), NOTIFICATION_CATEGORIES);
  const repoId = params.get('repo') ?? undefined;
  const sortByPriority = params.get('sort') === 'priority';

  /** Writes one URL param; the default value is left out so the URL stays short. */
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const query: NotificationQuery = useMemo(
    () => ({
      filter: unreadOnly ? 'unread' : 'all',
      lifecycle: tab === 'all' ? [] : [tab],
      priority,
      category,
      repoId,
    }),
    // priority / category are fresh arrays each render; their joined value is the identity.
    [unreadOnly, tab, priority.join(), category.join(), repoId],
  );
  const list = useNotifications(query);
  const summary = useNotificationSummary(repoId);
  const repos = useRepos();
  const markAll = useMarkAllNotificationsRead();
  const dismiss = useDismissHandledNotifications();
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [cleared, setCleared] = useState<number | null>(null);

  const loaded = list.data?.pages.flatMap((p) => p.items) ?? [];
  // The server pages by time; priority order is applied within what is loaded (stable: newest first inside a level).
  const items = sortByPriority
    ? [...loaded].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
    : loaded;
  const current = TABS.find((t) => t.value === tab)!;
  const counts = summary.data?.lifecycle;
  const unreadCounts = summary.data?.unreadLifecycle;
  const plus = summary.data?.capped ? '+' : '';
  const countOf = (t: Tab): string | null => {
    if (!counts || !unreadCounts) return null;
    if (t === 'all') return `${Object.values(counts).reduce((x, y) => x + y, 0)}${plus}`;
    // The clearable tabs count what they show by default: unread rows.
    const n = t === 'stale' || t === 'handled_elsewhere' ? unreadCounts[t] : counts[t];
    return `${n}${plus}`;
  };
  const cleanable = (unreadCounts?.stale ?? 0) + (unreadCounts?.handled_elsewhere ?? 0);
  const hasFacets =
    priority.length > 0 || category.length > 0 || !!repoId || (unreadOnly && !clearTab);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Notifications</PageTitle>
          <p className="text-sm text-muted-foreground">
            Sorted by what still needs you. Stale and handled-elsewhere entries are labelled, and
            actions follow the current state.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={dismiss.isPending || cleanable === 0}
            onClick={() => setConfirmDismiss(true)}
          >
            Clear stale and handled
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={markAll.isPending}
            onClick={() =>
              markAll.mutate(undefined, {
                onSuccess: () =>
                  emit({ level: 'tick', key: 'notification:read', repeatable: true }),
              })
            }
          >
            <CheckCheck />
            Mark all read
          </Button>
        </div>
      </header>

      <div role="group" aria-label="Show notifications that" className="flex flex-wrap gap-1">
        {TABS.map((t) => {
          const n = countOf(t.value);
          return (
            <Button
              key={t.value}
              size="sm"
              variant={t.value === tab ? 'secondary' : 'ghost'}
              aria-pressed={t.value === tab}
              onClick={() => setParam('tab', t.value === 'needs_action' ? null : t.value)}
            >
              {t.label}
              {n !== null && <span className="text-xs text-muted-foreground">{n}</span>}
            </Button>
          );
        })}
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-3">
        <div role="group" aria-label="Priority" className="flex flex-wrap items-center gap-1">
          <span className="w-16 text-xs text-muted-foreground">Priority</span>
          {NOTIFICATION_PRIORITIES.map((p) => (
            <Chip
              key={p}
              active={priority.includes(p)}
              onClick={() => setParam('priority', toggle(priority, p).join(','))}
            >
              {PRIORITY_LABEL[p]}
            </Chip>
          ))}
        </div>
        <div role="group" aria-label="Category" className="flex flex-wrap items-center gap-1">
          <span className="w-16 text-xs text-muted-foreground">Type</span>
          {NOTIFICATION_CATEGORIES.map((c) => (
            <Chip
              key={c}
              active={category.includes(c)}
              onClick={() => setParam('category', toggle(category, c).join(','))}
            >
              {CATEGORY_LABEL[c]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Repository"
            className="h-8 w-auto"
            value={repoId ?? ''}
            onChange={(e) => setParam('repo', e.target.value)}
          >
            <option value="">All repos</option>
            {repos.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort"
            className="h-8 w-auto"
            value={sortByPriority ? 'priority' : 'newest'}
            onChange={(e) => setParam('sort', e.target.value === 'priority' ? 'priority' : null)}
          >
            <option value="newest">Newest first</option>
            <option value="priority">Priority first</option>
          </Select>
          {clearTab ? (
            <Chip active={!unreadOnly} onClick={() => setParam('read', unreadOnly ? '1' : null)}>
              Show cleared
            </Chip>
          ) : (
            <Chip active={unreadOnly} onClick={() => setParam('unread', unreadOnly ? null : '1')}>
              Unread only
            </Chip>
          )}
          {hasFacets && (
            <Button size="sm" variant="ghost" onClick={() => setParams({}, { replace: true })}>
              Reset
            </Button>
          )}
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {cleared === null
          ? ''
          : cleared === 0
            ? 'Nothing left to clear.'
            : `Cleared ${cleared} stale or handled ${cleared === 1 ? 'notification' : 'notifications'}.`}
      </p>

      {(markAll.isError || dismiss.isError) && (
        <Alert variant="destructive">
          <AlertTitle>Could not update notifications</AlertTitle>
          <AlertDescription>{describeError(markAll.error ?? dismiss.error)}</AlertDescription>
        </Alert>
      )}

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load notifications</AlertTitle>
          <AlertDescription>{describeError(list.error)}</AlertDescription>
        </Alert>
      ) : (
        <>
          {items.length === 0 ? (
            !list.hasNextPage && (
              <p className="text-sm text-muted-foreground">
                {hasFacets ? 'Nothing matches these filters.' : current.empty}
              </p>
            )
          ) : (
            <ul className="overflow-hidden rounded-lg border bg-card">
              {/* Only a row that arrives while reading lands: the first paint and a repaint stay still. */}
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <NotificationRow key={item.id} item={item} />
                ))}
              </AnimatePresence>
            </ul>
          )}
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="outline"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage && <Loader2 className="motion-safe:animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={confirmDismiss} onOpenChange={setConfirmDismiss}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear stale and handled?</DialogTitle>
            <DialogDescription>
              Marks every unread stale or handled-elsewhere notification
              {repoId ? ` in ${repoId}` : ''} as read, so it leaves these tabs. Nothing is deleted
              and nothing on GitLab changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDismiss(false)}>
              Cancel
            </Button>
            <Button
              disabled={dismiss.isPending}
              onClick={() =>
                dismiss.mutate(repoId, {
                  onSuccess: ({ marked }) => {
                    setCleared(marked);
                    if (marked > 0)
                      emit({ level: 'tick', key: 'notification:read', repeatable: true });
                  },
                  onSettled: () => setConfirmDismiss(false),
                })
              }
            >
              Clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
