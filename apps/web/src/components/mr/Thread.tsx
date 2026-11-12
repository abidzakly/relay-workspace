import { Check, ChevronDown, CornerDownRight, MessageSquare, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import type { Discussion, DiscussionNote, MrRef } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import { Composer, type Person } from '@/components/composer/Composer';
import { Markdown } from '@/components/Markdown';
import { Avatar } from '@/components/mr/Avatar';
import { useUserLabel } from '@/components/MrBits';
import { ThreadAgentActions } from '@/components/ThreadAgentActions';
import { TimeAgo } from '@/components/TimeAgo';
import { describeError } from '@/lib/api';
import { SPRING } from '@/lib/motion/presets';
import { useNote, useReply, useResolve, useUndo } from '@/lib/mrApi';
import { cn } from '@/lib/utils';
import { ThreadCode } from '@/review/ThreadCode';
import { useReducedMotion } from '@/workspace/useMedia';

export interface ThreadContext {
  repo: string;
  iid: number;
  /** The MR author's username (their notes get an "Author" tag). */
  mrAuthor: string | null;
  people: readonly Person[];
  refs: Readonly<Record<string, MrRef>> | undefined;
}

/** "Sam Reviewer @sam.reviewer", or "me" for mine; the name only when GitLab gave one. */
function Who({ n }: { n: DiscussionNote }) {
  const userLabel = useUserLabel();
  if (!n.author) {
    return <span className="font-semibold">{n.id < 0 ? 'me' : 'unknown'}</span>;
  }
  const label = userLabel(n.author);
  const named = n.authorName && label !== 'me' && label !== 'bot';
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-semibold" title={n.authorName ?? n.author}>
        {named ? n.authorName : label}
      </span>
      {(named || label === 'bot') && (
        <span className="hidden truncate text-muted-foreground sm:inline" title={`@${n.author}`}>
          @{n.author}
        </span>
      )}
    </span>
  );
}

function Note({ n, ctx, first }: { n: DiscussionNote; ctx: ThreadContext; first?: boolean }) {
  const pending = n.id < 0;
  return (
    <li
      className={cn(
        'flex min-w-0 gap-3 px-3 py-3 sm:px-4',
        !first && 'border-t border-hairline',
        pending && 'opacity-60',
      )}
    >
      <Avatar name={n.authorName ?? n.author} src={n.avatar} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <Who n={n} />
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">
            {pending ? 'sending…' : <TimeAgo at={n.createdAt} />}
          </span>
          <span className="ml-auto flex items-center gap-1">
            {n.unread && <Badge variant="warning">new</Badge>}
            {n.author && n.author === ctx.mrAuthor && <Badge variant="outline">Author</Badge>}
          </span>
        </div>
        <Markdown source={n.body} repo={ctx.repo} {...(ctx.refs ? { refs: ctx.refs } : {})} />
        {n.edited && <span className="text-xs text-muted-foreground">Edited</span>}
      </div>
    </li>
  );
}

/** Reply box + resolve toggle, GitLab's thread footer. Optimistic (`lib/mrApi.ts`); errors roll back and show here. */
function ThreadFooter({ d, ctx }: { d: Discussion; ctx: ThreadContext }) {
  const reply = useReply(ctx.repo, ctx.iid);
  const resolve = useResolve(ctx.repo, ctx.iid);
  const undo = useUndo(ctx.repo, ctx.iid);
  const [open, setOpen] = useState(false);
  const busy = reply.isPending || resolve.isPending || undo.isPending;
  const undoable = resolve.data?.undoable && !undo.isSuccess ? resolve.data : null;
  const simulated =
    (reply.data?.dryRun && reply.isSuccess) ||
    (resolve.data?.dryRun && resolve.isSuccess) ||
    (undo.data?.dryRun && undo.isSuccess);
  const pendingThread = d.id.startsWith('pending-');

  return (
    <div className="grid gap-2 border-t border-hairline bg-muted/40 px-3 py-2.5 sm:px-4">
      {open ? (
        <Composer
          repo={ctx.repo}
          iid={ctx.iid}
          people={ctx.people}
          placeholder="Reply… (markdown, @ to mention, ! for an MR)"
          submitLabel="Reply"
          pending={reply.isPending}
          error={reply.error}
          autoFocus
          onCancel={() => setOpen(false)}
          onSubmit={(body, done) =>
            reply.mutate(
              { discussionId: d.id, body },
              {
                onSuccess: () => {
                  done();
                  setOpen(false);
                },
              },
            )
          }
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pendingThread}
            onClick={() => setOpen(true)}
            className="h-9 min-w-0 flex-1 basis-48 rounded-control border border-input bg-card/60 px-3 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
          >
            Reply…
          </button>
          {d.resolvable && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                undo.reset();
                resolve.mutate({ discussionId: d.id, resolved: !d.resolved });
              }}
            >
              {d.resolved ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
              {d.resolved ? 'Unresolve thread' : 'Resolve thread'}
            </Button>
          )}
          {undoable && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => undo.mutate(undoable.auditId)}
            >
              Undo
            </Button>
          )}
        </div>
      )}
      {simulated && (
        <p className="text-xs text-muted-foreground">
          Dry-run: simulated and logged in the audit log, nothing was sent to GitLab.
        </p>
      )}
      {[resolve.error, undo.error].map(
        (e, i) =>
          e && (
            <Alert key={i} variant="destructive">
              <AlertTitle>{i === 0 ? 'Resolve failed' : 'Undo failed'}</AlertTitle>
              <AlertDescription>{describeError(e)}</AlertDescription>
            </Alert>
          ),
      )}
      {!pendingThread && <ThreadAgentActions repo={ctx.repo} iid={ctx.iid} discussionId={d.id} />}
    </div>
  );
}

/**
 * One discussion, the way GitLab draws it: a card whose head says who started the thread (and on which code), the
 * first comment, the replies (collapsible), and a footer with Reply and Resolve thread. A lone comment is just the
 * note with a Reply. A resolved thread starts folded.
 */
export function Thread({ d, ctx }: { d: Discussion; ctx: ThreadContext }) {
  const reduced = useReducedMotion();
  const [first, ...replies] = d.notes;
  const [openResolved, setOpenResolved] = useState(false);
  const [showReplies, setShowReplies] = useState(true);
  const lone = d.individual && !d.code && replies.length === 0 && !d.resolvable;
  const folded = d.resolved && !openResolved;
  const last = d.notes[d.notes.length - 1];
  const userLabel = useUserLabel();
  if (!first) return null;
  const starter = first.authorName ?? (first.author ? userLabel(first.author) : 'me');

  const fold = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, height: 0 },
    animate: reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' },
    exit: reduced ? { opacity: 0 } : { opacity: 0, height: 0 },
    transition: SPRING.settle,
  };

  return (
    <article
      className={cn(
        'min-w-0 overflow-hidden rounded-surface border bg-card shadow-rest',
        d.resolvable && !d.resolved ? 'border-foreground/25' : 'border-hairline',
      )}
    >
      {!lone && (
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline bg-muted/40 px-3 py-2 text-sm sm:px-4">
          {d.resolved ? (
            <Check aria-hidden className="size-4 shrink-0 text-success" />
          ) : (
            <MessageSquare aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">
            <span className="font-semibold">{starter}</span>{' '}
            <span className="text-muted-foreground">
              {d.resolved ? 'thread resolved' : 'started a thread'}
              {d.code ? ' on the code' : ''} · <TimeAgo at={first.createdAt} />
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            {d.resolvable && !d.resolved && <Badge variant="warning">unresolved</Badge>}
            {d.resolved && (
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() => setOpenResolved((o) => !o)}
                className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {folded
                  ? `Show ${d.notes.length} comment${d.notes.length === 1 ? '' : 's'}`
                  : 'Hide'}
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'size-3.5 transition-transform duration-200',
                    !folded && 'rotate-180',
                  )}
                />
              </button>
            )}
          </span>
        </header>
      )}

      <AnimatePresence initial={false}>
        {!folded && (
          <motion.div key="body" {...fold} className="min-w-0 overflow-hidden">
            {d.code && (
              <div className="border-b border-hairline">
                <ThreadCode code={d.code} />
              </div>
            )}
            <ul className="min-w-0">
              <Note n={first} ctx={ctx} first />
            </ul>
            {replies.length > 0 && (
              <div className="border-t border-hairline bg-muted/25">
                <button
                  type="button"
                  aria-expanded={showReplies}
                  onClick={() => setShowReplies((s) => !s)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:px-4"
                >
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'size-3.5 transition-transform duration-200',
                      !showReplies && '-rotate-90',
                    )}
                  />
                  {showReplies ? (
                    'Collapse replies'
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <CornerDownRight aria-hidden className="size-3.5" />
                      {replies.length} repl{replies.length === 1 ? 'y' : 'ies'}
                      {last && last !== first && (
                        <>
                          {' · last '}
                          <TimeAgo at={last.createdAt} />
                        </>
                      )}
                    </span>
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {showReplies && (
                    <motion.ul key="replies" {...fold} className="min-w-0 overflow-hidden">
                      {replies.map((n, i) => (
                        <Note key={n.id} n={n} ctx={ctx} first={i === 0} />
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            )}
            <ThreadFooter d={d} ctx={ctx} />
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

/** "Add a comment" under the discussions: a new top-level note on the MR. */
export function NewComment({ ctx }: { ctx: ThreadContext }) {
  const note = useNote(ctx.repo, ctx.iid);
  const simulated = note.data?.dryRun && note.isSuccess;
  return (
    <div className="grid gap-2">
      <Composer
        repo={ctx.repo}
        iid={ctx.iid}
        people={ctx.people}
        placeholder="Write a comment… (markdown, @ to mention, ! for an MR)"
        submitLabel="Comment"
        pending={note.isPending}
        error={note.error}
        onSubmit={(body, done) => note.mutate({ body }, { onSuccess: done })}
      />
      {simulated && (
        <p className="text-xs text-muted-foreground">
          Dry-run: simulated and logged in the audit log, nothing was sent to GitLab.
        </p>
      )}
    </div>
  );
}
