import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/Badge';
import { Markdown } from '@/components/Markdown';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiError, describeError } from '@/lib/api';
import { useMrDetail } from '@/lib/mrApi';
import { reviewLink, useMrReview } from '@/lib/reviewApi';
import { DiffFileView, type CommentSlots } from '@/review/DiffFile';
import { parseDiff, type Hunk } from '@/review/parseDiff';
import '@/review/review.css';

/** Read-only: comments belong to the full review. */
const NO_COMMENTS: CommentSlots = {
  canComment: false,
  renderThreads: () => null,
  renderComposer: () => null,
};

/** The diff scrolls in its own box, so file headers stick to its top instead of below the app bar. */
const DIFF_BOX_STYLE = { '--rv-top': '0px' } as CSSProperties;

const isNotSynced = (e: unknown) => e instanceof ApiError && e.code === 'mr_not_found';

function pipelineVariant(status: string) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'destructive';
  return 'secondary';
}

function toggled(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(path)) next.add(path);
  return next;
}

function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 motion-safe:animate-spin" /> {label}
    </p>
  );
}

function ReadFailed({ title, error }: { title: string; error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="break-words">{describeError(error)}</AlertDescription>
    </Alert>
  );
}

/** The version MR as it stands while the release waits at AWAIT_REVIEW: details, then its diff. */
export default function VersionMrPreview({ repo, iid }: { repo: string; iid: number }) {
  const location = useLocation();
  const detail = useMrDetail(repo, iid);
  const review = useMrReview(repo, iid);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const onToggle = useCallback((path: string) => setCollapsed((s) => toggled(s, path)), []);
  const onViewed = useCallback((path: string) => setViewed((s) => toggled(s, path)), []);

  const d = detail.data;
  const r = review.data;
  const parsed = useMemo(
    () =>
      (r?.files ?? []).map((file) => ({
        file,
        hunks: file.diff ? parseDiff(file.diff) : ([] as Hunk[]),
      })),
    [r?.files],
  );

  const mr = d?.mr ?? r?.mr;
  const pipeline = d?.pipeline.value ?? mr?.headPipeline ?? null;
  const fetching = detail.isFetching || review.isFetching;
  const notSynced = isNotSynced(detail.error) || isNotSynced(review.error);
  const additions = parsed.reduce((n, p) => n + p.file.additions, 0);
  const deletions = parsed.reduce((n, p) => n + p.file.deletions, 0);
  const from = `${location.pathname}${location.search}`;

  return (
    <section
      aria-label={`Version MR !${iid} preview`}
      className="rv-root grid min-w-0 gap-3 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <p className="text-sm font-medium break-words">{mr?.title ?? `MR !${iid}`}</p>
          {mr && (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {mr.sourceBranch} → {mr.targetBranch}
              {mr.author ? ` · ${mr.author}` : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link {...reviewLink(repo, iid, from, 'Release')} className="text-xs underline">
            Open full review
          </Link>
          <Button
            size="sm"
            variant="outline"
            disabled={fetching}
            onClick={() => {
              void detail.refetch();
              void review.refetch();
            }}
          >
            <RefreshCw className={fetching ? 'size-4 motion-safe:animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      </div>

      {notSynced && (
        <Alert variant="warning">
          <AlertTitle>Not synced yet</AlertTitle>
          <AlertDescription>
            The dashboard has not cached this MR. It appears after the next sync; use Refresh to
            check, or open it in GitLab with the link above.
          </AlertDescription>
        </Alert>
      )}

      {mr && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {mr.draft && <Badge variant="warning">draft</Badge>}
          {mr.hasConflicts && <Badge variant="destructive">conflicts</Badge>}
          {pipeline && (
            <Badge variant={pipelineVariant(pipeline.status)}>pipeline {pipeline.status}</Badge>
          )}
          {d && (
            <span className="text-muted-foreground">
              {d.approvals.approvedBy.length > 0
                ? `Approved by ${d.approvals.approvedBy.join(', ')}`
                : 'No approvals yet'}
            </span>
          )}
        </div>
      )}

      {detail.isPending && <Loading label="Loading MR details…" />}
      {detail.isError && !notSynced && (
        <ReadFailed title="Could not load the MR details" error={detail.error} />
      )}
      {d && (
        <>
          {!d.approvals.gate.allowed && (
            <div className="text-xs text-muted-foreground">
              <p>Merge gate would refuse this MR:</p>
              <ul className="list-disc pl-4">
                {d.approvals.gate.reasons.map((reason) => (
                  <li key={reason.code}>{reason.message}</li>
                ))}
              </ul>
              <p>Merge now enforces this only when the repo requires version MR approval.</p>
            </div>
          )}
          {d.liveErrors.map((message) => (
            <Alert key={message} variant="warning">
              <AlertDescription className="break-words">{message}</AlertDescription>
            </Alert>
          ))}
          {d.description.markdown ? (
            <div className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2">
              <Markdown source={d.description.markdown} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {d.description.source === 'live'
                ? 'This MR has no description.'
                : 'The description could not be read from GitLab.'}
            </p>
          )}
        </>
      )}

      {review.isPending && <Loading label="Loading the diff…" />}
      {review.isError && !notSynced && (
        <ReadFailed title="Could not load the diff" error={review.error} />
      )}
      {r && (
        <>
          {r.errors.map((message) => (
            <Alert key={message} variant="warning">
              <AlertDescription className="break-words">{message}</AlertDescription>
            </Alert>
          ))}
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>
              {parsed.length} {parsed.length === 1 ? 'file' : 'files'} · +{additions} −{deletions}
            </span>
            {r.diffRefs && <span className="font-mono">{r.diffRefs.headSha.slice(0, 8)}</span>}
            <span>
              read <TimeAgo at={r.generatedAt} />
            </span>
          </p>
          {parsed.length > 0 ? (
            <div className="grid max-h-[70vh] min-w-0 gap-3 overflow-auto" style={DIFF_BOX_STYLE}>
              {parsed.map(({ file, hunks }) => (
                <DiffFileView
                  key={file.path}
                  anchorId={`release-mr-file-${encodeURIComponent(file.path)}`}
                  file={file}
                  hunks={hunks}
                  mode="inline"
                  wrap
                  collapsed={collapsed.has(file.path)}
                  viewed={viewed.has(file.path)}
                  onToggle={onToggle}
                  onViewed={onViewed}
                  threads={undefined}
                  slots={NO_COMMENTS}
                />
              ))}
            </div>
          ) : (
            r.errors.length === 0 && (
              <p className="text-xs text-muted-foreground">This MR has no changes to show.</p>
            )
          )}
          {r.truncated && (
            <p className="text-xs text-muted-foreground">
              More files changed than can be shown here. Open the rest in GitLab.
            </p>
          )}
        </>
      )}
    </section>
  );
}
