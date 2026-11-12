import { Printer, Download } from 'lucide-react';
import type { BuildView, JobStatus } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { Button } from '@/components/ui/button';
import { ShareControls } from './ShareControls';
import { SigningUpload } from './SigningUpload';

const STATUS: Record<
  JobStatus,
  { label: string; variant: 'default' | 'secondary' | 'success' | 'destructive' | 'outline' }
> = {
  queued: { label: 'queued', variant: 'secondary' },
  running: { label: 'running', variant: 'default' },
  paused: { label: 'paused', variant: 'secondary' },
  succeeded: { label: 'succeeded', variant: 'success' },
  failed: { label: 'failed', variant: 'destructive' },
  cancelled: { label: 'cancelled', variant: 'outline' },
};

function previewMrsOf(state: Record<string, unknown>): { iid: number }[] {
  const raw = state.integration;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: unknown) =>
    typeof m === 'object' && m !== null && 'iid' in m && typeof m.iid === 'number'
      ? [{ iid: m.iid }]
      : [],
  );
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function BuildRow({
  view,
  repoName,
  selected,
  cancelPending,
  dryRun,
  onShowLog,
  onCancel,
  onRetryFlavor,
  newestOfRepo,
}: {
  view: BuildView;
  repoName: string;
  selected: boolean;
  cancelPending: boolean;
  /** The dry-run setting now. It decides what an upload or share would do, whatever the build was. */
  dryRun: boolean;
  onShowLog: () => void;
  onCancel: () => void;
  /** Only when this job failed because its flavor must be chosen, which a repo with no clone finds out only here. */
  onRetryFlavor: (() => void) | null;
  /** Only the repo's latest job offers fixes for its failure: older ones in the history are over. */
  newestOfRepo: boolean;
}) {
  const { job, artifacts, cancelling, queuePosition } = view;
  const status = STATUS[job.status];
  const active = job.status === 'queued' || job.status === 'running';
  const ended = job.finishedAt ?? job.updatedAt;
  const preview = previewMrsOf(job.state);

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {active && <Printer aria-hidden className="size-4 text-primary-ink" />}
        <Badge variant={status.variant}>{cancelling ? 'cancelling' : status.label}</Badge>
        <span className="font-medium">{repoName}</span>
        <Badge variant="outline">{job.mode}</Badge>
        {job.flavor && <span className="font-mono text-xs">{job.flavor}</span>}
        {job.version && <span className="font-mono text-xs">v{job.version}</span>}
        {job.dryRun && <Badge variant="warning">dry run</Badge>}
        {job.parentJobId && <Badge variant="secondary">from a release</Badge>}
        {preview.length > 0 && <Badge variant="warning">QA preview</Badge>}
        <span className="text-xs text-muted-foreground">
          {queuePosition !== null && `#${queuePosition} in line, `}
          {active ? (
            <>
              added <TimeAgo at={job.createdAt} />
            </>
          ) : (
            <>
              <TimeAgo at={ended} />
              {job.startedAt !== null && `, took ${formatDuration(ended - job.startedAt)}`}
            </>
          )}
        </span>
        <span className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant={selected ? 'secondary' : 'outline'}
            aria-pressed={selected}
            onClick={onShowLog}
          >
            Log
          </Button>
          {active && (
            <Button
              size="sm"
              variant="destructive"
              disabled={cancelling || cancelPending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        </span>
      </div>
      {preview.length > 0 && (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Local merge, not pushed: {preview.map((m) => `!${m.iid}`).join(', ')}
        </p>
      )}
      {job.error && (
        <p className="text-sm [overflow-wrap:anywhere] text-destructive">{job.error}</p>
      )}
      {onRetryFlavor && (
        <div>
          <Button size="sm" variant="outline" onClick={onRetryFlavor}>
            Choose a flavor and build again
          </Button>
        </div>
      )}
      {job.status === 'failed' && newestOfRepo && (
        <SigningUpload
          repo={job.repoId}
          error={job.error}
          next={job.parentJobId ? 'Resume the release in Release.' : 'Build again.'}
        />
      )}
      {job.status === 'succeeded' && artifacts.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {job.dryRun ? 'Dry run: nothing was built.' : 'This build recorded no files.'}
        </p>
      )}
      {artifacts.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {artifacts.map((a) => (
            <li key={a.fileName} className="flex flex-wrap items-center gap-2">
              {a.available ? (
                <a href={a.url} download className="inline-flex items-center gap-1 underline">
                  <Download className="size-3.5" aria-hidden />
                  {a.fileName}
                </a>
              ) : (
                <span className="text-muted-foreground">{a.fileName} (no longer on disk)</span>
              )}
              <span className="text-xs text-muted-foreground">{formatSize(a.sizeBytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {view.share.eligible && <ShareControls view={view} dryRun={dryRun} />}
    </li>
  );
}
