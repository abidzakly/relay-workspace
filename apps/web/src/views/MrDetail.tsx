import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Check,
  ExternalLink,
  Minus,
  Pencil,
  Plus,
  ScanSearch,
  TriangleAlert,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { MrDetail as MrDetailData } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, MrStateBadge, WaitingBadge } from '@/components/Badge';
import { Markdown } from '@/components/Markdown';
import { MergePanel } from '@/components/MergePanel';
import { MrStatePanel } from '@/components/MrStatePanel';
import { StackBlocks } from '@/components/StackBlocks';
import {
  ActionBadge,
  PipelineBadge,
  SourceNote,
  useUserLabel,
  WRAP_BADGE,
} from '@/components/MrBits';
import { TimeAgo } from '@/components/TimeAgo';
import { describeError } from '@/lib/api';
import { useMrDetail } from '@/lib/mrApi';
import { NewComment, Thread, type ThreadContext } from '@/components/mr/Thread';
import { reviewLink } from '@/lib/reviewApi';
import { safeHref } from '@/lib/utils';
import { SPRING } from '@/lib/motion/presets';
import { useReducedMotion } from '@/workspace/useMedia';

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {title}
        {note}
      </h3>
      {children}
    </section>
  );
}

const FILE_ICON = { added: Plus, modified: Pencil, renamed: ArrowRight, deleted: Minus } as const;

function Body({ d }: { d: MrDetailData }) {
  const { mr } = d;
  const repo = mr.repoId;
  const iid = mr.iid;
  const cardHref = safeHref(mr.card?.url);
  const ctx = useMemo<ThreadContext>(() => {
    // Avatars come with notes; people who only review (no comment yet) get initials.
    const avatars = new Map<string, string>();
    for (const t of d.discussions.threads)
      for (const n of t.notes) if (n.author && n.avatar) avatars.set(n.author, n.avatar);
    return {
      repo,
      iid,
      mrAuthor: mr.author,
      refs: d.refs,
      people: (d.people ?? []).map((p) => ({ ...p, avatar: avatars.get(p.username) ?? null })),
    };
  }, [repo, iid, mr.author, d.refs, d.people, d.discussions.threads]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {d.liveErrors.length > 0 && (
        <Alert>
          <AlertTitle>Some data is not live</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {d.liveErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Section title="Linked card">
        {mr.card ? (
          <div className="grid min-w-0 gap-2 text-sm">
            <span className="font-medium [overflow-wrap:anywhere]">{mr.card.title}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {mr.card.status && (
                <Badge variant="secondary" className={WRAP_BADGE}>
                  Notion: {mr.card.status}
                </Badge>
              )}
              <MrStateBadge state={mr.derivedState} />
              <Badge variant={mr.card.conflict ? 'destructive' : 'outline'}>
                {mr.card.conflict && <TriangleAlert aria-hidden />}
                {mr.card.conflict ? 'link conflict' : `linked by ${mr.card.matchBy}`}
              </Badge>
            </div>
            {cardHref && (
              <a
                className="text-xs text-primary-ink underline"
                href={cardHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in Notion
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {mr.isVersionMr
              ? 'Version-update MR: it has no card by design.'
              : 'No card is linked to this MR (orphan).'}
          </p>
        )}
      </Section>

      <Section title="Pipeline" note={<SourceNote source={d.pipeline.source} />}>
        <div className="flex flex-wrap items-center gap-2">
          <PipelineBadge pipeline={d.pipeline.value} />
          {safeHref(d.pipeline.value?.webUrl) && (
            <a
              className="text-xs text-primary-ink underline"
              href={safeHref(d.pipeline.value?.webUrl)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open pipeline
            </a>
          )}
          {mr.hasConflicts && <Badge variant="destructive">merge conflicts</Badge>}
          {mr.draft && <Badge variant="secondary">draft</Badge>}
        </div>
      </Section>

      <Section title="Approvals" note={<SourceNote source={d.approvals.source} />}>
        {mr.reviewers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reviewers are configured for this repo (Settings).
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {mr.reviewers.map((r) => (
              <li key={r.username} className="max-w-full">
                <Badge
                  variant={r.approved ? 'success' : r.commented ? 'warning' : 'secondary'}
                  className={WRAP_BADGE}
                >
                  @{r.username} · {r.approved && <Check aria-hidden />}
                  {r.approved ? 'approved' : r.commented ? 'commented' : 'no response'}
                  {r.approved && r.approvedAt != null && (
                    <>
                      {' · '}
                      <TimeAgo at={r.approvedAt} />
                    </>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Mode: {d.approvals.mode}. Merge gate: approved by a configured reviewer, not a draft, no
          conflicts (unresolved threads do not block).
        </p>
      </Section>

      <StackBlocks d={d} />
      <MergePanel d={d} />
      <MrStatePanel d={d} />

      <Section title="Description" note={<SourceNote source={d.description.source} />}>
        {d.description.markdown ? (
          <Markdown
            source={d.description.markdown}
            repo={repo}
            {...(d.refs ? { refs: d.refs } : {})}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {d.description.source === 'live'
              ? 'No description.'
              : 'Not available without a live GitLab read.'}
          </p>
        )}
      </Section>

      <Section
        title={`Changed files${d.files.source === 'live' ? ` (${d.files.files.length}${d.files.truncated ? '+' : ''})` : ''}`}
        note={<SourceNote source={d.files.source} />}
      >
        {d.files.files.length > 0 ? (
          <ul className="grid max-h-72 min-w-0 gap-1.5 overflow-y-auto rounded-lg border p-2 text-xs">
            {d.files.files.map((f) => {
              const cut = f.path.lastIndexOf('/');
              const name = f.path.slice(cut + 1);
              const dir = cut > 0 ? f.path.slice(0, cut) : '';
              const FileIcon = FILE_ICON[f.kind];
              return (
                <li key={f.path} className="flex min-w-0 gap-2" title={f.path}>
                  <FileIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <span className="sr-only">{f.kind}: </span>
                  <span className="grid min-w-0">
                    <span className="font-mono font-medium [overflow-wrap:anywhere]">{name}</span>
                    {(dir || f.oldPath) && (
                      <span className="font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                        {f.oldPath ? `from ${f.oldPath}` : dir}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
            {d.files.truncated && (
              <li className="text-muted-foreground">… more files not listed</li>
            )}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {d.files.source === 'live'
              ? 'No changed files.'
              : (d.files.reason ?? 'Not available without a live GitLab read.')}
          </p>
        )}
      </Section>

      <Section
        title={`Discussions (${d.discussions.threads.length})`}
        note={<SourceNote source={d.discussions.source} />}
      >
        {d.discussions.threads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="grid gap-3">
            {d.discussions.threads.map((t) => (
              <Thread key={t.id} d={t} ctx={ctx} />
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {d.discussions.systemNotes} system note{d.discussions.systemNotes === 1 ? '' : 's'}{' '}
          hidden. Comments, replies, images and resolves are logged in the audit log; a resolve can
          be undone.
        </p>
        <NewComment ctx={ctx} />
      </Section>
    </div>
  );
}

/** MR Detail drawer (read part). A nested route of the MR Inbox, so deep links and Back work. */
export function MrDetail() {
  const userLabel = useUserLabel();
  const { repo = '', iid = '' } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();
  const n = Number(iid);
  const q = useMrDetail(repo, Number.isInteger(n) && n > 0 ? n : 0);
  // Closing first slides the drawer out, then leaves the route: unmounting the route at once would cut the exit.
  const [open, setOpen] = useState(true);
  const reduced = useReducedMotion();
  const close = () => navigate({ pathname: '/mrs', search });
  const webHref = safeHref(q.data?.mr.webUrl);
  const slide = reduced ? { opacity: 0 } : { opacity: 0, x: 48 };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence onExitComplete={close}>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay forceMount asChild>
              <motion.div
                className="fixed inset-0 z-50 bg-scrim/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={reduced ? { duration: 0.15 } : SPRING.settle}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              forceMount
              asChild
              aria-describedby={undefined}
              data-reward-through
              // A reward's Continue button is outside this drawer, but pressing it must not close the drawer.
              onInteractOutside={(e) => {
                const target = e.detail.originalEvent.target;
                if (target instanceof Element && target.closest('[data-reward-layer]')) {
                  e.preventDefault();
                }
              }}
            >
              <motion.div
                className="fixed inset-0 z-50 flex w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-background shadow-float outline-none will-change-transform sm:left-auto sm:max-w-2xl sm:border-l"
                initial={slide}
                animate={{ opacity: 1, x: 0 }}
                exit={slide}
                transition={reduced ? { duration: 0.15 } : SPRING.settle}
              >
                {/* Sticky on phones too: close and GitLab stay one tap away while reading a long thread. */}
                <header className="sticky top-0 z-10 glass grid min-w-0 gap-2 border-0 border-b px-4 pt-3 pb-3 shadow-none sm:px-5">
                  <div className="flex min-w-0 items-start gap-1">
                    <div className="grid min-w-0 flex-1 gap-0.5 pt-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {q.data?.mr.repoName ?? repo} · !{iid}
                      </span>
                      <DialogPrimitive.Title
                        className="line-clamp-3 text-base leading-snug font-semibold [overflow-wrap:anywhere] sm:text-lg"
                        title={q.data?.mr.title}
                      >
                        {q.data?.mr.title ?? `${repo} !${iid}`}
                      </DialogPrimitive.Title>
                    </div>
                    <Link
                      {...reviewLink(repo, n, `/mrs/${repo}/${iid}${search}`, 'MR detail')}
                      aria-label="Review in Code Reviewer"
                      title="Review in Code Reviewer"
                      className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-rest transition-[background-color,transform] duration-150 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.97]"
                    >
                      <ScanSearch className="size-4" aria-hidden />
                      <span className="hidden sm:inline">Review</span>
                    </Link>
                    {webHref && (
                      <a
                        href={webHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open in GitLab"
                        title="Open in GitLab"
                        className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <ExternalLink className="size-5" aria-hidden />
                      </a>
                    )}
                    <DialogPrimitive.Close
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label="Close"
                    >
                      <X className="size-5" />
                    </DialogPrimitive.Close>
                  </div>
                  {q.data && (
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <ActionBadge action={q.data.mr.action} />
                      <MrStateBadge state={q.data.mr.derivedState} />
                      <WaitingBadge kind={q.data.mr.timing.waitingOn.kind} />
                      {q.data.mr.timing.openFor && (
                        <span>open {q.data.mr.timing.openFor.label}</span>
                      )}
                      {q.data.mr.author && (
                        <span className="max-w-40 truncate" title={`Author: @${q.data.mr.author}`}>
                          by {userLabel(q.data.mr.author)}
                        </span>
                      )}
                    </div>
                  )}
                </header>

                <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
                  {q.isPending && (
                    <p className="text-sm text-muted-foreground">
                      Loading (reads GitLab live, may take a moment)…
                    </p>
                  )}
                  {q.error && (
                    <Alert variant="destructive">
                      <AlertTitle>Could not load this MR</AlertTitle>
                      <AlertDescription>{describeError(q.error)}</AlertDescription>
                    </Alert>
                  )}
                  {q.data && <Body d={q.data} />}
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
