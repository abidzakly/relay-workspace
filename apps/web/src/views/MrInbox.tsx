import { useEffect, useMemo } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router';
import { INBOX_STATE_FILTERS, type InboxMr, type InboxStateFilter } from '@relay/shared';
import {
  ExternalLink,
  Eye,
  Hourglass,
  MessageSquare,
  ScanSearch,
  TriangleAlert,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { NoIdentityNotice } from '@/components/MonthFilter';
import { Badge, MrStateBadge, WaitingBadge } from '@/components/Badge';
import { ActionBadge, PipelineBadge, useUserLabel } from '@/components/MrBits';
import { TimeAgo } from '@/components/TimeAgo';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useMrInbox, type InboxFilters } from '@/lib/mrApi';
import { reviewLink } from '@/lib/reviewApi';
import { cn } from '@/lib/utils';
import { groupByStack, stackWaitLabel, type MrGroup } from '@/lib/mrStacks';
import { rememberStacks } from '@/lib/mrStackProgress';
import { ReadyForMrPanel } from '@/overview/ReadyForMrPanel';
import { PageTitle } from '@/components/PageTitle';

const STATE_LABEL: Record<InboxStateFilter, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  all: 'All',
};

function isState(v: string | null): v is InboxStateFilter {
  return v !== null && (INBOX_STATE_FILTERS as readonly string[]).includes(v);
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  const id = `inbox-filter-${label.toLowerCase()}`;
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full truncate pr-7 sm:w-44"
      >
        {children}
      </Select>
    </div>
  );
}

/**
 * One MR as a stacked card: where it lives + how long it is open, the title on its own full-width line (branch-like
 * titles have no spaces, so sharing a row squeezed them to a few letters per line on phones), badges, then one line
 * of who/when. Card title and GitLab host are extra detail, shown from `sm:` up.
 */
function Row({ m, search, inStack }: { m: InboxMr; search: string; inStack?: boolean }) {
  const userLabel = useUserLabel();
  const t = m.timing;
  const wait = stackWaitLabel(m);
  const open = t.phase === 'open' ? t.openFor : null;
  const finished = t.phase !== 'open' ? t.finishedAfter : null;
  return (
    <li className="group relative">
      <Link
        to={{ pathname: `/mrs/${m.repoId}/${m.iid}`, search }}
        className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
      >
        <div className="flex min-w-0 items-center gap-2 pr-10 text-xs text-muted-foreground sm:pr-24">
          <span className="min-w-0 flex-1 truncate">
            {m.repoName} · !{m.iid}
          </span>
          {open && (
            <span
              className={cn(
                'shrink-0 font-medium tabular-nums',
                open.level === 'red' && 'text-destructive',
                open.level === 'amber' && 'text-warning',
              )}
            >
              open {open.label}
            </span>
          )}
          {finished && (
            <span className="shrink-0">
              {finished.kind} after {finished.approx ? '~' : ''}
              {finished.label}
            </span>
          )}
        </div>

        <span
          className="line-clamp-2 text-base leading-snug font-medium [overflow-wrap:anywhere]"
          title={m.title}
        >
          {m.title}
        </span>

        <div className="flex flex-wrap items-center gap-1.5">
          {inStack && m.stack && (
            <Badge variant={m.stack.position === 1 ? 'success' : 'outline'} title="Merge order">
              #{m.stack.position}
            </Badge>
          )}
          {wait && (
            <Badge variant="warning" title="Merge is blocked until the parent is merged">
              <Hourglass aria-hidden />
              {wait}
            </Badge>
          )}
          <ActionBadge action={m.action} />
          <MrStateBadge state={m.derivedState} />
          <PipelineBadge pipeline={m.headPipeline} />
          {m.hasConflicts && <Badge variant="destructive">conflicts</Badge>}
          {m.isVersionMr && <Badge variant="outline">version MR</Badge>}
          {m.unreadNotes > 0 && (
            <Badge variant="warning">
              <MessageSquare aria-hidden />
              {m.unreadNotes} unread
            </Badge>
          )}
          <WaitingBadge kind={t.waitingOn.kind} />
          {m.card?.conflict && (
            <Badge variant="destructive">
              <TriangleAlert aria-hidden />
              link conflict
            </Badge>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            <MessageSquare aria-hidden className="mr-1 inline size-3" />
            {t.lastComment ? (
              <>
                <TimeAgo at={t.lastComment.at} />
                {t.lastComment.by ? ` ${userLabel(t.lastComment.by)}` : ''}
              </>
            ) : (
              'no comments'
            )}
          </span>
          {m.reviewers.length > 0 && (
            <span className="min-w-0 truncate" title="Reviewers">
              <Eye aria-hidden className="mr-1 inline size-3" />
              {m.reviewers.map((r, idx) => (
                <span key={r.username}>
                  {idx > 0 && ', '}
                  {userLabel(r.username)}
                  {r.approved ? (
                    <>
                      {' (approved'}
                      {r.approvedAt != null && (
                        <>
                          {' '}
                          <TimeAgo at={r.approvedAt} />
                        </>
                      )}
                      {')'}
                    </>
                  ) : r.commented ? (
                    ' (commented)'
                  ) : (
                    ''
                  )}
                </span>
              ))}
            </span>
          )}
          {m.author && (
            <span className="max-w-40 truncate" title={`Author: @${m.author}`}>
              by {userLabel(m.author)}
            </span>
          )}
          {m.card && (
            <span className="hidden min-w-0 truncate sm:inline">
              card: {m.card.title}
              {m.card.status ? ` [${m.card.status}]` : ''}
            </span>
          )}
          {m.webUrl && (
            <span className="ml-auto hidden items-center gap-1 sm:inline-flex">
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">GitLab: </span>
              {m.webUrl.replace(/^https?:\/\//, '').split('/')[0]}
            </span>
          )}
        </div>
      </Link>
      {/* A sibling of the card link (a link inside a link is invalid): jumps straight into the review session. */}
      <Link
        {...reviewLink(m.repoId, m.iid, `/mrs${search}`, 'MR Inbox')}
        aria-label={`Review !${m.iid} in Code Reviewer`}
        title="Review in Code Reviewer"
        className="absolute top-1.5 right-1.5 inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-primary/10 hover:text-primary-ink focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:top-2.5 sm:right-2.5 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
      >
        <ScanSearch className="size-4" aria-hidden />
        <span className="hidden sm:inline">Review</span>
      </Link>
    </li>
  );
}

/**
 * One list group. A stack is drawn as a pile: dependents on top, the parent (`#1`, the only mergeable one) at the
 * bottom, joined by a connector line. Merge is one at a time, parent first.
 */
export function MrGroupView({ g, search }: { g: MrGroup; search: string }) {
  if (!g.stacked) return <Row m={g.items[0]!} search={search} />;
  return (
    <li className="rounded-surface border border-dashed p-2">
      <p className="px-1 pb-2 text-xs text-muted-foreground">
        Stack · {g.items.length} MRs · merged one at a time from the bottom (parent first), never
        squashed
      </p>
      <ol
        className="relative flex flex-col gap-2 pl-4"
        aria-label="Stacked MRs, parent at the bottom"
      >
        <span aria-hidden className="absolute top-4 bottom-4 left-1.5 w-px bg-border" />
        {g.items.map((m) => (
          <Row key={`${m.repoId}#${m.iid}`} m={m} search={search} inStack />
        ))}
      </ol>
    </li>
  );
}

/** MR Inbox: all MRs of all repos, "needs your action" first. The detail drawer is the nested route. */
export function MrInbox() {
  // Warm the drawer's chunk so the first open slides in at once instead of waiting on the network.
  useEffect(() => {
    void import('@/views/MrDetail');
  }, []);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const filters: InboxFilters = {
    repo: params.get('repo') ?? '',
    state: isState(params.get('state')) ? (params.get('state') as InboxStateFilter) : 'open',
    reviewer: params.get('reviewer') ?? '',
  };
  const q = useMrInbox(filters);
  const seenStacks = q.data?.stacks;
  useEffect(() => {
    if (seenStacks) rememberStacks(seenStacks);
  }, [seenStacks]);
  const set = (k: keyof InboxFilters, v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v && !(k === 'state' && v === 'open')) next.set(k, v);
        else next.delete(k);
        return next;
      },
      { replace: true },
    );

  // Mine = I am the author, an assignee or a reviewer, or it is linked to one of my cards.
  const items = useMemo(() => (q.data?.items ?? []).filter((m) => m.mine), [q.data]);
  const yours = useMemo(() => items.filter((m) => m.action.yours), [items]);
  const groups = useMemo(() => groupByStack(items), [items]);

  return (
    <div className="mx-auto flex max-w-5xl min-w-0 flex-col gap-4">
      <div>
        <PageTitle>MR Inbox</PageTitle>
        <p className="text-sm text-muted-foreground">
          Sorted by what needs <em>your</em> action, then oldest first. From the local cache; open
          an MR to act on it.
        </p>
      </div>

      <NoIdentityNotice />
      <ReadyForMrPanel hideWhenEmpty />
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
        <Filter label="Repo" value={filters.repo} onChange={(v) => set('repo', v)}>
          <option value="">All</option>
          {(q.data?.repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Filter>
        <Filter label="State" value={filters.state} onChange={(v) => set('state', v)}>
          {INBOX_STATE_FILTERS.map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </Filter>
        <Filter label="Reviewer" value={filters.reviewer} onChange={(v) => set('reviewer', v)}>
          <option value="">All</option>
          {(q.data?.reviewers ?? []).map((r) => (
            <option key={r} value={r}>
              @{r}
            </option>
          ))}
        </Filter>
      </div>

      {q.error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load MRs</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      )}
      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {items.length} MR{items.length === 1 ? '' : 's'} · {yours.length} need your action
          </p>
          {(filters.repo || filters.reviewer || filters.state !== 'open') && (
            <button
              type="button"
              className="shrink-0 text-sm text-primary-ink underline-offset-4 hover:underline"
              onClick={() => setParams({}, { replace: true })}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {q.data && items.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No MRs match. MRs appear after the first sync; check Sync Health if this stays empty.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {groups.map((g) => (
          <MrGroupView key={g.id} g={g} search={location.search} />
        ))}
      </ul>
      <Outlet />
    </div>
  );
}
