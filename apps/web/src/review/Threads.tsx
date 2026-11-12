import { useState } from 'react';
import type { ReviewDiscussion, ReviewPosition } from '@relay/shared';
import { Check, CornerDownRight, RotateCcw } from 'lucide-react';
import { ThreadAgentActions } from '@/components/ThreadAgentActions';
import { Composer } from '@/components/composer/Composer';
import { Markdown } from '@/components/Markdown';
import { useUserLabel } from '@/components/MrBits';
import { TimeAgo } from '@/components/TimeAgo';
import { describeError } from '@/lib/api';
import { useReviewComment, useReviewReply, useReviewResolve } from '@/lib/reviewApi';
import { cn } from '@/lib/utils';

function initials(name: string | null): string {
  if (!name) return '·';
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || name[0]!.toUpperCase();
}

/** A soft hue per author, so a long thread reads as a conversation at a glance. */
function hue(name: string | null): number {
  let h = 0;
  for (const c of name ?? '') h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function Avatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden
      className="grid size-6 shrink-0 place-items-center rounded-full text-micro font-semibold text-primary-foreground"
      style={{ background: `oklch(0.74 0.09 ${hue(name)})` }}
    >
      {initials(name)}
    </span>
  );
}

function DryRunNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Dry-run: simulated and logged in the audit log, nothing was sent to GitLab.
    </p>
  );
}

export function ThreadCard({
  repo,
  iid,
  d,
  interactive,
}: {
  repo: string;
  iid: number;
  d: ReviewDiscussion;
  /** false = read-only (branch compare has no MR to write to). */
  interactive: boolean;
}) {
  const userLabel = useUserLabel();
  const reply = useReviewReply(repo, iid);
  const resolve = useReviewResolve(repo, iid);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(!d.resolved);
  const pending = d.id.startsWith('pending-');
  const busy = reply.isPending || resolve.isPending || pending;
  const first = d.notes[0];

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="rv-thread rv-thread-resolved flex w-full items-center gap-2 text-left text-xs text-muted-foreground"
      >
        <Check className="size-3.5 text-success" aria-hidden />
        <span className="truncate">
          Resolved · {userLabel(first?.author ?? 'unknown')}: {first?.body.slice(0, 80)}
        </span>
        <span className="ml-auto shrink-0">
          {d.notes.length} comment{d.notes.length === 1 ? '' : 's'}
        </span>
      </button>
    );
  }

  return (
    <article
      className={cn('rv-thread', d.resolved && 'rv-thread-resolved', pending && 'opacity-70')}
      aria-label={`Comment thread${d.resolved ? ', resolved' : ''}`}
    >
      <ol className="grid gap-3">
        {d.notes.map((n, i) => (
          <li key={n.id} className={cn('flex min-w-0 gap-2.5', i > 0 && 'pl-1')}>
            <Avatar name={n.author} />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="truncate font-semibold">
                  {n.author ? userLabel(n.author) : n.id < 0 ? 'me' : 'unknown'}
                </span>
                <TimeAgo at={n.createdAt} className="text-muted-foreground" />
              </div>
              <Markdown source={n.body} repo={repo} className="text-sm" />
            </div>
          </li>
        ))}
      </ol>
      {interactive && (
        <div className="mt-3 grid gap-2">
          {replying ? (
            <Composer
              repo={repo}
              iid={iid}
              placeholder="Reply…"
              submitLabel="Reply"
              autoFocus
              pending={reply.isPending}
              error={reply.error}
              onCancel={() => setReplying(false)}
              onSubmit={(body, done) =>
                reply.mutate(
                  { discussionId: d.id, body },
                  {
                    onSuccess: () => {
                      done();
                      setReplying(false);
                    },
                  },
                )
              }
            />
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className="rv-pill"
                disabled={busy}
                onClick={() => setReplying(true)}
              >
                <CornerDownRight className="size-3.5" aria-hidden /> Reply
              </button>
              {d.resolvable && (
                <button
                  type="button"
                  className="rv-pill"
                  disabled={busy}
                  onClick={() =>
                    resolve.mutate(
                      { discussionId: d.id, resolved: !d.resolved },
                      { onSuccess: (r) => !r.dryRun && r.resolved && setExpanded(false) },
                    )
                  }
                >
                  {d.resolved ? (
                    <>
                      <RotateCcw className="size-3.5" aria-hidden /> Unresolve
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5" aria-hidden /> Resolve
                    </>
                  )}
                </button>
              )}
              {d.resolved && (
                <button type="button" className="rv-pill" onClick={() => setExpanded(false)}>
                  Collapse
                </button>
              )}
            </div>
          )}
          {/* Agents work in a configured repo's workspace: a Reviews project (`~<id>`) has none. */}
          {!pending && !repo.startsWith('~') && (
            <ThreadAgentActions repo={repo} iid={iid} discussionId={d.id} />
          )}
          <DryRunNote
            show={
              (reply.isSuccess && reply.data.dryRun) || (resolve.isSuccess && resolve.data.dryRun)
            }
          />
          {resolve.error && (
            <p className="text-xs text-destructive">{describeError(resolve.error)}</p>
          )}
        </div>
      )}
    </article>
  );
}

export function NewComment({
  repo,
  iid,
  position,
  headSha,
  onClose,
}: {
  repo: string;
  iid: number;
  position: ReviewPosition;
  /** The head commit of the diff on screen: the server refuses if the MR has moved on. */
  headSha: string | null;
  onClose: () => void;
}) {
  const comment = useReviewComment(repo, iid);
  const [dry, setDry] = useState(false);
  if (dry)
    return (
      <div className="rv-thread grid gap-2">
        <DryRunNote show />
        <div>
          <button type="button" className="rv-pill" onClick={onClose}>
            OK
          </button>
        </div>
      </div>
    );
  return (
    <div className="rv-thread">
      <Composer
        repo={repo}
        iid={iid}
        placeholder={`Comment on line ${position.newLine ?? position.oldLine}…`}
        submitLabel="Comment"
        autoFocus
        pending={comment.isPending}
        error={comment.error}
        onCancel={onClose}
        onSubmit={(body, done) =>
          comment.mutate(
            { position, body, ...(headSha ? { headSha } : {}) },
            {
              onSuccess: (r) => {
                done();
                if (r.dryRun) setDry(true);
                else onClose();
              },
            },
          )
        }
      />
    </div>
  );
}
