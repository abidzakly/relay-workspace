import { useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import {
  ArrowRight,
  Check,
  ExternalLink,
  GitBranch,
  GitCompare,
  MoveRight,
  Radar,
  RefreshCw,
  Webhook,
} from 'lucide-react';
import {
  REVIEW_LANES,
  reviewSourceText,
  type ReviewDesk as Desk,
  type ReviewDeskItem,
  type ReviewLane,
} from '@relay/shared';
import { PageTitle, SectionLabel } from '@/components/PageTitle';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { reviewLink, withBack } from '@/lib/reviewApi';
import { useMarkReviewed, useRefreshDesk, useReviewDesk, useTodoDone } from '@/lib/reviewsApi';
import { useSettings } from '@/lib/settingsApi';
import { cn, safeHref } from '@/lib/utils';
import {
  LANE_INFO,
  SnoozeSelect,
  SourceMark,
  reasonLabel,
  sourceFixLink,
} from '@/reviews/DeskBits';

/**
 * Reviews: every open merge request where I am a reviewer or was mentioned, in any project the personal token can
 * read. Lanes say what the ball is waiting for. Each row says whether it arrives live (webhook) or by the poll, and why.
 */

const HOUR = 3_600_000;
const COLLAPSED: ReadonlySet<ReviewLane> = new Set(['approved', 'snoozed']);

function waitTone(ms: number, t: { amberAfterHours: number; redAfterHours: number }) {
  if (ms > t.redAfterHours * HOUR) return 'text-destructive';
  if (ms > t.amberAfterHours * HOUR) return 'text-warning';
  return 'text-muted-foreground';
}

function compareTo(item: ReviewDeskItem, back: string): string | null {
  if (!item.lastReviewedSha || !item.headSha) return null;
  const qs = new URLSearchParams({ from: item.lastReviewedSha, to: item.headSha });
  return withBack(`/review/${encodeURIComponent(item.repoId)}/compare?${qs.toString()}`, back);
}

function Row({
  item,
  highlight,
  thresholds,
}: {
  item: ReviewDeskItem;
  highlight: boolean;
  thresholds: { amberAfterHours: number; redAfterHours: number };
}) {
  const { pathname, search } = useLocation();
  const back = `${pathname}${search}`;
  const open = reviewLink(item.repoId, item.iid, back, 'Reviews');
  const since = item.lane === 'changed' ? compareTo(item, back) : null;
  const mark = useMarkReviewed();
  const done = useTodoDone();
  const latest = item.todos.at(-1) ?? null;
  const waited = Date.now() - item.askedAt;
  const reviewedThis =
    !!item.lastReviewedSha &&
    !!item.headSha &&
    item.headSha.toLowerCase().startsWith(item.lastReviewedSha.toLowerCase().slice(0, 7));
  const gitlab = safeHref(item.webUrl);

  return (
    <li
      id={`review-${item.key}`}
      className={cn(
        'grid gap-3 border-t border-hairline py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-6',
        highlight && 'rise-in',
      )}
      aria-current={highlight ? 'true' : undefined}
    >
      <div className="grid min-w-0 gap-1.5">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate font-mono text-2xs text-foreground">
            {item.projectPath} !{item.iid}
          </span>
          {item.author && <span>by @{item.author}</span>}
          <span className={waitTone(waited, thresholds)}>
            asked <TimeAgo at={item.askedAt} />
          </span>
        </p>
        <Link
          {...open}
          className={cn(
            'min-w-0 text-base leading-snug font-semibold tracking-tight break-words hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            highlight && 'underline underline-offset-4',
          )}
        >
          {item.title}
        </Link>
        <p className="flex min-w-0 items-center gap-1 font-mono text-2xs text-muted-foreground">
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{item.sourceBranch}</span>
          <MoveRight className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{item.targetBranch}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.reasons.map((r) => (
            <Badge key={r} variant="outline">
              {reasonLabel(r)}
            </Badge>
          ))}
          {item.draft && <Badge variant="secondary">Draft</Badge>}
          {item.hasConflicts && <Badge variant="destructive">Conflicts</Badge>}
          {item.approvedByMe && (
            <Badge variant="success">
              <Check aria-hidden /> You approved
            </Badge>
          )}
          {item.approvalsLeft !== null && item.approvalsLeft > 0 && (
            <Badge variant="outline">{item.approvalsLeft} approval(s) left</Badge>
          )}
          {item.lastReviewedSha && (
            <Badge variant="outline" title={`Marked reviewed at ${item.lastReviewedSha}`}>
              Looked at {item.lastReviewedSha.slice(0, 7)}
            </Badge>
          )}
          {item.snoozedUntil && (
            <Badge variant="outline">
              Snoozed until{' '}
              {new Date(item.snoozedUntil).toLocaleString(undefined, {
                weekday: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Badge>
          )}
        </div>
        {latest?.body && (
          <blockquote className="border-l-2 border-hairline pl-3 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">@{latest.author ?? 'someone'}</span>{' '}
            {latest.body}
          </blockquote>
        )}
        <SourceMark item={item} detailed />
      </div>

      <div className="flex flex-wrap items-center gap-2 md:max-w-80 md:justify-end">
        {since ? (
          <Button asChild size="sm">
            <Link to={since} className="arrow-link">
              <GitCompare aria-hidden /> What changed
            </Link>
          </Button>
        ) : null}
        <Button asChild size="sm" variant={since ? 'outline' : 'default'}>
          <Link {...open} className="arrow-link">
            Review <ArrowRight aria-hidden />
          </Link>
        </Button>
        {item.headSha && !reviewedThis && (
          <Button
            size="sm"
            variant="outline"
            disabled={mark.isPending}
            onClick={() => mark.mutate({ key: item.key, sha: item.headSha })}
            title="Remember this version as reviewed. New commits move it to 'Changed since you looked'."
          >
            Mark reviewed
          </Button>
        )}
        <SnoozeSelect item={item} />
        {item.todos.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={done.isPending}
            title="Mark this MR's GitLab to-dos as done (a GitLab write: dry-run applies)."
            onClick={() => {
              for (const t of item.todos) done.mutate(t.id);
            }}
          >
            To-do done
          </Button>
        )}
        {gitlab && (
          <a
            href={gitlab}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in GitLab"
            title="Open in GitLab"
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ExternalLink className="size-4" aria-hidden />
          </a>
        )}
        {done.isSuccess && done.data.dryRun && (
          <p className="w-full text-xs text-muted-foreground md:text-right">
            Dry-run: recorded in Audit, GitLab not told.
          </p>
        )}
      </div>
    </li>
  );
}

/** Why some rows are polled, per project, with where to fix it. The poll's own state underneath. */
function PollBanner({ desk }: { desk: Desk }) {
  const polled = desk.items.filter((i) => i.source.via === 'poll');
  const projects = useMemo(() => {
    const m = new Map<number, ReviewDeskItem>();
    for (const i of polled) if (!m.has(i.projectId)) m.set(i.projectId, i);
    return [...m.values()];
  }, [polled]);
  if (polled.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTitle className="flex items-center gap-2">
        <Radar className="size-4" aria-hidden />
        {polled.length} of {desk.items.length} come from polling, not a webhook
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <p>
          {desk.polling.active ? (
            <>
              No webhook reaches these projects, so the dashboard checks GitLab once a minute
              {desk.polling.lastPollAt ? (
                <>
                  {' '}
                  (last check <TimeAgo at={desk.polling.lastPollAt} />)
                </>
              ) : null}
              . A mention can take up to a minute to show.
            </>
          ) : (
            <>
              Polling is off, so these only update when you press Refresh. Turn it on in{' '}
              <Link to="/settings#reviewer" className="underline underline-offset-2">
                Reviewer access
              </Link>
              .
            </>
          )}
        </p>
        <ul className="grid gap-1.5">
          {projects.map((i) => {
            const fix = sourceFixLink(i.source);
            return (
              <li key={i.projectId} className="text-xs">
                {reviewSourceText(i.source, i.projectPath)}{' '}
                <Link to={fix.to} className="underline underline-offset-2">
                  {fix.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function NoToken() {
  return (
    <div className="grid max-w-2xl gap-4 border-t border-hairline pt-6">
      <SectionLabel n={1}>Set up</SectionLabel>
      <p className="text-sm">
        Reviews reads merge requests from any GitLab project where you are a reviewer or were
        mentioned. It needs a personal access token: <code>read_api</code> to read, or{' '}
        <code>api</code> to also comment and approve from here.
      </p>
      <div>
        <Button asChild>
          <Link to="/settings#reviewer" className="arrow-link">
            Add your token <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function ReviewDesk() {
  const q = useReviewDesk();
  const refresh = useRefreshDesk();
  const settings = useSettings().data;
  const thresholds = settings?.mrTiming ?? { amberAfterHours: 48, redAfterHours: 96 };
  const [params] = useSearchParams();
  const focus = params.get('open');
  const desk = q.data;

  // A notification click lands here with `?open=<key>`: bring that row into view.
  useEffect(() => {
    if (!focus || !desk) return;
    document
      .getElementById(`review-${focus}`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, desk]);

  const byLane = useMemo(() => {
    const m = new Map<ReviewLane, ReviewDeskItem[]>();
    for (const i of desk?.items ?? []) m.set(i.lane, [...(m.get(i.lane) ?? []), i]);
    return m;
  }, [desk]);

  const waiting = (byLane.get('needs_you')?.length ?? 0) + (byLane.get('changed')?.length ?? 0);
  const live = desk?.items.filter((i) => i.source.via === 'webhook').length ?? 0;
  const polled = desk ? desk.items.length - live : 0;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <PageTitle
          accent={desk?.tokenSet && waiting === 0 && desk.items.length > 0 ? 'clear' : undefined}
        >
          {desk?.tokenSet && waiting === 0 && desk.items.length > 0 ? 'All' : 'Reviews'}
        </PageTitle>
        {desk?.tokenSet && (
          <div className="flex items-center gap-3">
            <p className="text-right text-xs text-muted-foreground">
              {desk.username && <span className="text-foreground">@{desk.username}</span>}
              {desk.fetchedAt ? (
                <>
                  {' '}
                  · read <TimeAgo at={desk.fetchedAt} />
                </>
              ) : null}
              <br />
              <span className="inline-flex items-center gap-1">
                <Webhook className="size-3" aria-hidden /> {live} live
              </span>
              {' · '}
              <span className={cn('inline-flex items-center gap-1', polled > 0 && 'text-warning')}>
                <Radar className="size-3" aria-hidden /> {polled} polled
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={refresh.isPending || desk.refreshing}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                aria-hidden
                className={cn(
                  (refresh.isPending || desk.refreshing) &&
                    'animate-spin motion-reduce:animate-none',
                )}
              />
              Refresh
            </Button>
          </div>
        )}
      </div>

      {q.isPending && <p className="text-sm text-muted-foreground">Reading your reviews…</p>}
      {q.error && (
        <Alert variant="destructive">
          <AlertTitle>Reviews could not be loaded</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      )}
      {refresh.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeError(refresh.error)}</AlertDescription>
        </Alert>
      )}

      {desk && !desk.tokenSet && <NoToken />}

      {desk?.tokenSet && (
        <>
          {desk.errors.length > 0 && (
            <Alert>
              <AlertTitle>Part of the desk could not be read</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {desk.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <PollBanner desk={desk} />

          {desk.items.length === 0 && desk.fetchedAt !== null && (
            <p className="border-t border-hairline pt-6 text-sm text-muted-foreground">
              No open merge request asks for you. New requests and mentions show up here
              {polled > 0 || desk.polling.active
                ? ' within a minute'
                : ' as soon as a webhook arrives'}
              .
            </p>
          )}

          {REVIEW_LANES.map((lane, idx) => {
            const items = byLane.get(lane) ?? [];
            if (items.length === 0) return null;
            const info = LANE_INFO[lane];
            const list = (
              <ul className="border-b border-hairline">
                {items.map((i) => (
                  <Row key={i.key} item={i} highlight={focus === i.key} thresholds={thresholds} />
                ))}
              </ul>
            );
            return (
              <section key={lane} aria-labelledby={`lane-${lane}`} className="grid gap-2">
                {COLLAPSED.has(lane) && !items.some((i) => i.key === focus) ? (
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-baseline gap-3 rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      <SectionLabel n={idx + 1}>
                        <span id={`lane-${lane}`}>
                          {info.label} · {items.length}
                        </span>
                      </SectionLabel>
                      <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
                    </summary>
                    <p className="mt-1 mb-2 text-xs text-muted-foreground">{info.hint}</p>
                    {list}
                  </details>
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <SectionLabel n={idx + 1}>
                        <span id={`lane-${lane}`}>
                          {info.label} · {items.length}
                        </span>
                      </SectionLabel>
                      <p className="text-xs text-muted-foreground">{info.hint}</p>
                    </div>
                    {list}
                  </>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
