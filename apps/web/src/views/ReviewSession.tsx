import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Layers,
  MoveRight,
} from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import type { DeckSource } from '@relay/shared';
import { deckPath } from '@/lib/deckApi';
import { useNarrow } from '@/workspace/useMedia';
import { MrStateBadge } from '@/components/Badge';
import { PipelineBadge, useUserLabel } from '@/components/MrBits';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { describeError } from '@/lib/api';
import { reviewOrigin, reviewPath, useCompareReview, useMrReview } from '@/lib/reviewApi';
import { safeHref } from '@/lib/utils';
import { ApproveControl } from '@/review/ApproveControl';
import { rememberReview } from '@/review/recent';
import { ReviewWorkspace } from '@/review/ReviewWorkspace';
import { DeskBar } from '@/reviews/DeskBar';
import '@/review/review.css';
import { PageTitle } from '@/components/PageTitle';

function BackLink() {
  const { state, search } = useLocation();
  const origin = reviewOrigin(state, search);
  return (
    <Link
      to={origin?.from ?? '/review'}
      className="rv-icon-btn shrink-0"
      aria-label={origin ? `Back to ${origin.label}` : 'Back to Code Review'}
      title={origin ? `Back to ${origin.label}` : 'Back to Code Review'}
    >
      <ArrowLeft className="size-4" aria-hidden />
    </Link>
  );
}

function Branches({ from, to }: { from: string; to: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-2xs">
      <span className="rv-branch truncate" title={from}>
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{from}</span>
      </span>
      <MoveRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="rv-branch truncate" title={to}>
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{to}</span>
      </span>
    </span>
  );
}

function GitlabLink({ href }: { href: string | null | undefined }) {
  const safe = safeHref(href);
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="rv-icon-btn"
      aria-label="Open in GitLab"
      title="Open in GitLab"
    >
      <ExternalLink className="size-4" aria-hidden />
    </a>
  );
}

/** "Immersive" = the Review Deck for the same diff. */
function ImmersiveLink({ source }: { source: DeckSource }) {
  const { pathname } = useLocation();
  return (
    <Link
      to={deckPath(source)}
      state={{
        from: `${pathname}?classic=1${
          source.kind === 'compare'
            ? `&from=${encodeURIComponent(source.from)}&to=${encodeURIComponent(source.to)}`
            : ''
        }`,
      }}
      className="rv-icon-btn"
      aria-label="Immersive review (deck)"
      title="Immersive review (deck)"
    >
      <Layers className="size-4" aria-hidden />
    </Link>
  );
}

/**
 * On phones the deck is the default view; `?classic=1` keeps the full diff (the deck's back link sets it).
 */
function useDeckByDefault(source: DeckSource | null): string | null {
  const narrow = useNarrow();
  const [params] = useSearchParams();
  // The deck works on configured repos only: a Reviews project (`~<id>`) stays in the full diff.
  if (
    !source ||
    !narrow ||
    params.has('classic') ||
    ('repoId' in source && source.repoId.startsWith('~'))
  )
    return null;
  return deckPath(source);
}

function Loading({ label }: { label: string }) {
  return (
    <div className="rv-root mx-auto grid w-full max-w-[1800px] gap-4" aria-busy="true">
      <div className="rv-toolbar">
        <div className="flex items-center gap-2">
          <BackLink />
          <div className="grid gap-1.5">
            <span className="rv-skeleton h-3 w-40" />
            <span className="rv-skeleton h-4 w-72" />
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rv-file">
          <div className="rv-file-header">
            <span className="rv-skeleton h-3.5 w-64" />
          </div>
          <div className="grid gap-2 p-4">
            {[70, 45, 85, 60].map((w, j) => (
              <span key={j} className="rv-skeleton h-3" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Failed({ title, error }: { title: string; error: unknown }) {
  return (
    <div className="rv-root mx-auto grid max-w-3xl gap-4">
      <div className="flex items-end gap-2">
        <BackLink />
        <PageTitle>Code Review</PageTitle>
      </div>
      <Alert variant="destructive">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{describeError(error)}</AlertDescription>
      </Alert>
    </div>
  );
}

/** `/review/:repo/mr/:iid`: one MR, with its line comments. */
export function MrReviewSession() {
  const userLabel = useUserLabel();
  const { repo = '', iid = '' } = useParams();
  const n = /^\d+$/.test(iid) ? Number(iid) : 0;
  const valid = Number.isSafeInteger(n) && n > 0;
  const q = useMrReview(repo, valid ? n : 0);
  const loaded = q.data?.mr;
  const deckSource: DeckSource | null = valid ? { kind: 'mr', repoId: repo, iid: n } : null;
  const toDeck = useDeckByDefault(deckSource);
  useEffect(() => {
    if (!loaded) return;
    rememberReview({
      path: reviewPath(loaded.repoId, loaded.iid),
      kind: 'mr',
      title: loaded.title,
      context: `${loaded.repoName} · !${loaded.iid}`,
      at: Date.now(),
    });
  }, [loaded]);
  if (toDeck)
    return <Navigate to={toDeck} replace state={{ from: `/review/${repo}/mr/${n}?classic=1` }} />;
  // A malformed link never loads: say so instead of waiting forever.
  if (!valid)
    return (
      <Failed
        title="This review link is not valid"
        error={new Error(`"${iid}" is not a merge request number.`)}
      />
    );
  if (q.isPending) return <Loading label="Reading the diff from GitLab…" />;
  if (q.error) return <Failed title="Could not open this review" error={q.error} />;
  const d = q.data;
  const mr = d.mr;
  return (
    <ReviewWorkspace
      back={<BackLink />}
      storageKey={`${mr.repoId}!${mr.iid}@${d.diffRefs?.headSha ?? 'unknown'}`}
      title={
        <div className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              {mr.repoName} · !{mr.iid}
            </span>
            <span className="hidden min-w-0 sm:flex">
              <Branches from={mr.sourceBranch} to={mr.targetBranch} />
            </span>
          </span>
          <h1
            className="truncate text-sm leading-snug font-semibold tracking-tight sm:text-base"
            title={mr.title}
          >
            {mr.title}
          </h1>
        </div>
      }
      actions={
        <>
          <ApproveControl
            repo={mr.repoId}
            iid={mr.iid}
            title={mr.title}
            approval={d.approval}
            summary={{
              files: d.files.length,
              additions: d.files.reduce((n, f) => n + f.additions, 0),
              deletions: d.files.reduce((n, f) => n + f.deletions, 0),
              openThreads: d.discussions.filter((t) => t.resolvable && !t.resolved).length,
            }}
          />
          {!mr.repoId.startsWith('~') && (
            <ImmersiveLink source={{ kind: 'mr', repoId: mr.repoId, iid: mr.iid }} />
          )}
          <GitlabLink href={mr.webUrl} />
        </>
      }
      intro={
        <>
          {mr.repoId.startsWith('~') && (
            <DeskBar repo={mr.repoId} iid={mr.iid} headSha={d.diffRefs?.headSha ?? null} />
          )}
          <div className="rv-card flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <MrStateBadge state={mr.derivedState} />
            <PipelineBadge pipeline={mr.headPipeline} />
            {mr.author && <span>by {userLabel(mr.author)}</span>}
            <span>
              opened <TimeAgo at={mr.createdAt} />
            </span>
            {mr.updatedAt && (
              <span>
                updated <TimeAgo at={mr.updatedAt} />
              </span>
            )}
            {mr.reviewers.length > 0 && (
              <span className="min-w-0 truncate">
                reviewers:{' '}
                {mr.reviewers
                  .map((r) => `${userLabel(r.username)}${r.approved ? ' (approved)' : ''}`)
                  .join(', ')}
              </span>
            )}
            <span className="sm:hidden">
              <Branches from={mr.sourceBranch} to={mr.targetBranch} />
            </span>
          </div>
          {d.errors.length > 0 && (
            <Alert>
              <AlertTitle>Part of this review could not be read</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {d.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {d.files.length === 0 && d.errors.length === 0 && (
            <p className="rv-card text-center text-sm text-muted-foreground">
              This MR has no changes.
            </p>
          )}
        </>
      }
      files={d.files}
      truncated={d.truncated}
      discussions={d.discussions}
      mr={{
        repo: mr.repoId,
        iid: mr.iid,
        canComment: d.diffRefs !== null,
        headSha: d.diffRefs?.headSha ?? null,
      }}
    />
  );
}

/** `/review/:repo/compare?from=&to=`: two branches, read-only. */
export function CompareReviewSession() {
  const { repo = '' } = useParams();
  const [params] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const q = useCompareReview(repo, from, to);
  const toDeck = useDeckByDefault(
    from && to && from !== to ? { kind: 'compare', repoId: repo, from, to } : null,
  );
  const compared = q.data;
  useEffect(() => {
    if (!compared) return;
    const qs = new URLSearchParams({ from: compared.from, to: compared.to });
    rememberReview({
      path: `/review/${encodeURIComponent(compared.repoId)}/compare?${qs.toString()}`,
      kind: 'compare',
      title: `${compared.from} → ${compared.to}`,
      context: `${compared.repoName} · compare`,
      at: Date.now(),
    });
  }, [compared]);
  if (toDeck) {
    const back = `/review/${encodeURIComponent(repo)}/compare?classic=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    return <Navigate to={toDeck} replace state={{ from: back }} />;
  }
  if (!from || !to || from === to)
    return (
      <Failed
        title="Pick two different branches"
        error={new Error('A comparison needs a base and a different target branch.')}
      />
    );
  if (q.isPending) return <Loading label="Comparing the branches on GitLab…" />;
  if (q.error) return <Failed title="Could not compare these branches" error={q.error} />;
  const d = q.data;
  return (
    <ReviewWorkspace
      back={<BackLink />}
      storageKey={`${d.repoId}:${d.from}...${d.to}@${d.commits[0]?.id ?? 'none'}`}
      title={
        <div className="grid min-w-0 gap-0.5">
          <span className="text-xs text-muted-foreground">{d.repoName} · compare</span>
          <h1 className="min-w-0 text-sm font-semibold sm:text-base">
            <Branches from={d.from} to={d.to} />
          </h1>
        </div>
      }
      actions={
        <>
          {!d.repoId.startsWith('~') && (
            <ImmersiveLink source={{ kind: 'compare', repoId: d.repoId, from: d.from, to: d.to }} />
          )}
          <GitlabLink href={d.webUrl} />
        </>
      }
      intro={
        d.commitCount === 0 && d.files.length === 0 ? (
          <p className="rv-card text-center text-sm text-muted-foreground">
            <strong className="font-mono">{d.to}</strong> has nothing that{' '}
            <strong className="font-mono">{d.from}</strong> does not already have.
          </p>
        ) : (
          <details className="rv-card">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <GitCommitHorizontal className="size-4 text-muted-foreground" aria-hidden />
              {d.commitCount} commit{d.commitCount === 1 ? '' : 's'}
              <span className="text-xs font-normal text-muted-foreground">
                in {d.to} that are not in {d.from}
              </span>
            </summary>
            <ol className="mt-3 grid gap-1.5">
              {d.commits.map((c) => (
                <li key={c.id} className="flex min-w-0 items-baseline gap-3 text-sm">
                  <code className="shrink-0 font-mono text-xs text-muted-foreground">
                    {c.shortId}
                  </code>
                  <span className="min-w-0 flex-1 truncate" title={c.title}>
                    {c.title}
                  </span>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {c.author}
                    {c.createdAt ? ' · ' : ''}
                    {c.createdAt && <TimeAgo at={c.createdAt} />}
                  </span>
                </li>
              ))}
              {d.commitCount > d.commits.length && (
                <li className="text-xs text-muted-foreground">
                  … and {d.commitCount - d.commits.length} older
                </li>
              )}
            </ol>
          </details>
        )
      }
      files={d.files}
      truncated={d.truncated}
      discussions={[]}
      mr={null}
    />
  );
}
