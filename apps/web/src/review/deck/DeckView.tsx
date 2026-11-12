import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCheck,
  Copy,
  FileCode2,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  deckCoverage,
  fileCoverage,
  aiGeneratedByLabel,
  type DeckCard,
  type DeckCardState,
  type DeckNote,
  type DeckPayload,
  type DeckRequestChangeResult,
  type DeckState,
  type DeckStatePatch,
  type DeckStatus,
  type DeckSummary,
} from '@relay/shared';
import { Badge } from '@/components/Badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiError, describeError } from '@/lib/api';
import { LAND } from '@/lib/motion/patterns';
import { emit } from '@/lib/reward/engine';
import {
  deckSourceFrom,
  saveDeckState,
  useCompleteDeck,
  useDeck,
  useDeckStatus,
  useRebuildDeck,
  useRequestChange,
} from '@/lib/deckApi';
import { mrCreatePath } from '@/lib/mrCreateApi';
import { useReducedMotion } from '@/workspace/useMedia';
import { GeneratedBy } from '@/components/GeneratedBy';
import { BossCard, QuizCardView } from './BossCard';
import { CardBack } from './CardBack';
import { CoverageRing } from './CoverageRing';
import { ExplainableDiff } from './ExplainableDiff';
import { IssueSheet } from './IssueSheet';
import { SwipeCard, type SwipeDir } from './SwipeCard';

const TIER_BADGE = {
  trivial: { variant: 'secondary', label: 'trivial' },
  normal: { variant: 'outline', label: 'normal' },
  critical: { variant: 'warning', label: 'critical' },
} as const;

/** The deck's way back. `popOnBack`: the previous history entry is `to`, so returning must not add another one. */
function DeckBackLink({ to, ...props }: React.ComponentProps<typeof Link> & { to: string }) {
  const { state } = useLocation();
  const navigate = useNavigate();
  const pop = (state as { popOnBack?: boolean } | null)?.popOnBack === true;
  return (
    <Link
      to={to}
      {...props}
      onClick={(e) => {
        if (!pop) return;
        e.preventDefault();
        void navigate(-1);
      }}
    />
  );
}

/** Debounced server save of the deck state (resume after reload / on another device). */
function useDeckSync(state: DeckState, save: (patch: DeckStatePatch) => Promise<boolean>) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // A failure is retried by the next change; progress is also in memory.
      void save({ cursor: state.cursor, cards: state.cards, notes: state.notes });
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, save]);
}

/** Bulk ack card body: every trivial file, one swipe covers them all. */
function BulkBody({ card }: { card: Extract<DeckCard, { kind: 'bulk' }> }) {
  return (
    <div className="grid gap-3 p-4">
      <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Layers className="size-4" /> Bulk ack · {card.hunkIds.length} hunk
      </p>
      <p className="text-lg font-semibold">Light changes (import, format, generated)</p>
      <ul className="grid gap-1 text-sm">
        {card.files.map((f) => (
          <li key={f.path} className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">{f.group}</Badge>
            <span className="truncate font-mono text-xs" title={f.path}>
              {f.path}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {f.hunkIds.length}×
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Swipe right once: every file still counts as covered.
      </p>
    </div>
  );
}

/** The prompt a send produced: what the agent received, or what to copy when it could not be sent. */
function PromptDialog({
  prompt,
  workspaceId,
  onClose,
}: {
  prompt: DeckRequestChangeResult | null;
  workspaceId: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prompt?.sent ? 'Sent to the agent' : 'Prompt for the agent'}</DialogTitle>
        </DialogHeader>
        {prompt?.reason && <p className="text-xs text-muted-foreground">{prompt.reason}</p>}
        <pre className="max-h-[50dvh] overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
          {prompt?.prompt}
        </pre>
        {prompt && <GeneratedBy by={prompt.generatedBy} />}
        {prompt?.sent && prompt.sessionId && workspaceId && (
          <Button asChild variant="outline">
            <Link
              to={`/cockpit?ws=${encodeURIComponent(workspaceId)}&session=${prompt.sessionId}&tab=agent`}
            >
              Open in Cockpit
            </Link>
          </Button>
        )}
        {!prompt?.sent && (
          <Button onClick={() => void navigator.clipboard?.writeText(prompt?.prompt ?? '')}>
            Copy prompt
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

const isOpenNote = (n: DeckNote) => n.status === 'saved' || n.status === 'stale';

function SummaryScreen({
  summary,
  notes,
  backTo,
  canSend,
  pendingIds,
  error,
  onSend,
  status,
  cockpitPath,
  onReviewNew,
  reloading,
}: {
  summary: DeckSummary;
  notes: DeckNote[];
  backTo: string;
  canSend: boolean;
  /** The notes of the send in progress, null when idle. */
  pendingIds: readonly string[] | null;
  error: string | null;
  onSend: (noteIds: string[]) => void;
  status: DeckStatus | undefined;
  /** Where the agent's work can be followed; null when no workspace is linked. */
  cockpitPath: string | null;
  onReviewNew: () => void;
  reloading: boolean;
}) {
  const open = notes.filter(isOpenNote);
  const waiting = notes.filter((n) => n.status === 'sent').length;
  const needsReview = status?.review === 'new_commits';
  const pendingWork = [
    open.length > 0 && `${open.length} open note${open.length === 1 ? '' : 's'}`,
    waiting > 0 && `${waiting} fix${waiting === 1 ? '' : 'es'} not pushed yet`,
    needsReview && 'new commits not reviewed',
  ].filter(Boolean);
  const next = status?.next ?? null;
  const icon = canSend ? <Bot className="size-3.5" /> : <Copy className="size-3.5" />;
  const spinner = <Loader2 className="size-3.5 motion-safe:animate-spin" />;
  return (
    <div className="relative mx-auto grid w-full max-w-lg gap-4 p-4">
      <div className="grid justify-items-center gap-2 pt-6 text-center">
        <h2 className="text-2xl font-semibold">Deck finished</h2>
        {summary.xpAwarded > 0 && <Badge variant="success">+{summary.xpAwarded} XP</Badge>}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ['Understood', summary.understood],
          ['Explained', summary.explained],
          ['Issue', summary.issues],
        ].map(([l, n]) => (
          <div key={l} className="rounded-surface border bg-card p-3">
            <p className="text-2xl font-semibold tabular-nums">{n}</p>
            <p className="text-xs text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Notes</p>
            {open.length > 1 && (
              <Button
                size="sm"
                disabled={pendingIds !== null}
                onClick={() => onSend(open.map((n) => n.id))}
              >
                {pendingIds !== null && pendingIds.length > 1 ? spinner : icon}
                {canSend ? 'Fix all with agent' : 'Create prompt for all'} ({open.length})
              </Button>
            )}
          </div>
          {notes.map((n) => (
            <div key={n.id} className="rounded-control border p-3 text-sm">
              <p className="truncate font-mono text-xs text-muted-foreground">
                {n.file}
                {n.lines.length > 0 && `:${n.lines[0]}`}
              </p>
              <p className="whitespace-pre-wrap">{n.text}</p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Badge variant={n.status === 'stale' ? 'warning' : 'outline'}>{n.status}</Badge>
                {isOpenNote(n) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pendingIds !== null}
                    onClick={() => onSend([n.id])}
                  >
                    {pendingIds?.length === 1 && pendingIds[0] === n.id ? spinner : icon}
                    {canSend ? 'Fix with agent' : 'Create prompt'}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
      {waiting > 0 && (
        <p className="text-sm text-muted-foreground">
          Waiting for the fix to be pushed.{' '}
          {cockpitPath && (
            <Link to={cockpitPath} className="text-primary-ink underline-offset-4 hover:underline">
              Open in Cockpit
            </Link>
          )}
        </p>
      )}
      {needsReview && (
        <Alert>
          <AlertTitle>
            {status.newCommits === null
              ? 'The branch changed since this review'
              : `${status.newCommits} new commit${status.newCommits === 1 ? '' : 's'} need review`}
          </AlertTitle>
          <AlertDescription className="grid justify-items-start gap-2">
            <p>Only the code that changed becomes new cards.</p>
            <Button size="sm" disabled={reloading} onClick={onReviewNew}>
              {reloading && <Loader2 className="size-4 motion-safe:animate-spin" />}
              Review new changes
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {next && (
        <div className="grid gap-1">
          <Button asChild variant={pendingWork.length > 0 ? 'outline' : 'default'}>
            {next.kind === 'create_mr' ? (
              <Link to={mrCreatePath(next.repoId, next.branch)}>Continue to Create MR</Link>
            ) : (
              <Link to={`/mrs/${next.repoId}/${next.iid}`}>Open MR</Link>
            )}
          </Button>
          {pendingWork.length > 0 && (
            <p className="text-center text-xs text-muted-foreground">{pendingWork.join(' · ')}</p>
          )}
        </div>
      )}
      <Button asChild variant={next ? 'ghost' : 'default'}>
        <DeckBackLink to={backTo}>Back</DeckBackLink>
      </Button>
    </div>
  );
}

/** Finished cards land on a pile behind the current one. It looks the same whatever the verdicts were. */
function DeskPile({ done }: { done: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-0">
      {Array.from({ length: Math.min(done, 3) }, (_, i) => (
        <motion.span
          key={i}
          variants={LAND}
          initial="hidden"
          animate="shown"
          className="absolute inset-x-0 top-3 bottom-0 rounded-sheet border bg-muted shadow-rest"
          style={{ x: i % 2 === 0 ? 3 : -3, rotate: i % 2 === 0 ? 0.6 + i * 0.3 : -0.8 }}
        />
      ))}
    </div>
  );
}

function Deck({
  d,
  backTo,
  onReload,
  reloading,
  onRebuild,
  rebuilding,
  rebuildError,
}: {
  d: DeckPayload;
  backTo: string;
  onReload: () => void;
  reloading: boolean;
  onRebuild: () => void;
  rebuilding: boolean;
  rebuildError: string | null;
}) {
  const reduced = useReducedMotion();
  const [outdated, setOutdated] = useState(false);
  const [state, setState] = useState<DeckState>(d.state);
  const [flipped, setFlipped] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [fullFile, setFullFile] = useState<string | null>(null);
  const [pending, setPending] = useState<SwipeDir | null>(null);
  const [prompt, setPrompt] = useState<DeckRequestChangeResult | null>(null);
  const complete = useCompleteDeck(d.deckId);
  const requestChange = useRequestChange(d.deckId);
  const [sentIds, setSentIds] = useState<ReadonlySet<string>>(new Set());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const finishedNotes = complete.data?.notes;
  const deckStatus = useDeckStatus(
    d.deckId,
    complete.data !== undefined,
    sentIds.size > 0 || finishedNotes?.some((n) => n.status === 'sent') === true,
  );
  const liveStatus = deckStatus.data;
  // A push of nothing but fixes keeps the review: pick up the new diff instead of waiting for a save to be refused.
  useEffect(() => {
    if (liveStatus?.review === 'fix_only' && liveStatus.diffSha !== d.diffSha) onReload();
  }, [liveStatus?.review, liveStatus?.diffSha, d.diffSha]);
  const save = useCallback(
    async (patch: DeckStatePatch) => {
      try {
        await saveDeckState(d.deckId, d.diffSha, patch);
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'deck_diff_changed') setOutdated(true);
        return false;
      }
    },
    [d.deckId, d.diffSha],
  );
  useDeckSync(state, save);

  const aiReady = d.ai.engine !== 'none';
  const cards = d.cards;
  const cursor = Math.min(state.cursor, cards.length);
  const card = cards[cursor] as DeckCard | undefined;
  const coverage = useMemo(() => deckCoverage(cards, state), [cards, state]);
  const perFile = useMemo(() => fileCoverage(cards, state), [cards, state]);

  const mark = useCallback(
    (id: string, s: Omit<DeckCardState, 'at'>, advance = true) => {
      // The same touch for every verdict: the deck never nudges "understood" over "issue", and speed earns nothing.
      emit({ level: 'tick', key: 'deck:verdict', repeatable: true });
      setState((prev) => ({
        ...prev,
        cards: { ...prev.cards, [id]: { ...s, at: Date.now() } },
        cursor: advance ? Math.min(cards.length, prev.cursor + 1) : prev.cursor,
      }));
      setFlipped(false);
      setPending(null);
    },
    [cards.length],
  );

  // End of the deck: complete (server checks 100% coverage, awards XP once).
  useEffect(() => {
    if (
      cursor >= cards.length &&
      coverage === 1 &&
      !complete.isPending &&
      !complete.data &&
      !complete.isError
    ) {
      // Save first so the server sees the last verdicts.
      void save({ cursor, cards: state.cards, notes: state.notes }).then((saved) => {
        if (saved) complete.mutate();
      });
    }
  }, [cursor, cards.length, coverage]);

  // Only a first completion is a win: reopening a finished deck also lands here, and the server says it was already done.
  useEffect(() => {
    if (!complete.data || d.state.completedAt) return;
    const xp = complete.data.xpAwarded;
    emit({
      level: 'event',
      key: `deck:${d.deckId}:${d.diffSha}`,
      persist: true,
      title: 'Deck cleared',
      ...(xp > 0 ? { detail: `+${xp} XP` } : {}),
    });
  }, [complete.data, d.state.completedAt, d.deckId, d.diffSha]);

  const onSwipe = (dir: SwipeDir) => {
    if (!card) return;
    if (card.kind === 'bulk') {
      if (dir === 'right') mark(card.id, { verdict: 'understood', score: null });
      return;
    }
    if (card.kind !== 'hunk') return;
    if (dir === 'right')
      mark(card.id, { verdict: flipped ? 'explained' : 'understood', score: null });
    else if (dir === 'left') {
      setFlipped(true);
      setPending(null);
    } else {
      setIssueOpen(true);
      setPending(null);
    }
  };

  // ← ↑ → keys (desktop) = the same actions as the buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (issueOpen || fullFile || (e.target as HTMLElement | null)?.closest('input,textarea'))
        return;
      const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up' }[e.key] as
        SwipeDir | undefined;
      if (dir && (card?.kind === 'hunk' || (card?.kind === 'bulk' && dir === 'right'))) {
        e.preventDefault();
        setPending(dir);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, issueOpen, fullFile]);

  const sendNotes = (noteIds: string[]) =>
    requestChange.mutate(
      { noteIds, send: d.agentTarget !== null },
      {
        onSuccess: (r) => {
          setPrompt(r);
          if (!r.sent) return;
          setSentIds((prev) => new Set([...prev, ...noteIds]));
          setSessionId(r.sessionId);
        },
      },
    );

  const saveIssue = (note: DeckNote, send: boolean) => {
    if (!card || card.kind !== 'hunk') return;
    setIssueOpen(false);
    setState((prev) => ({ ...prev, notes: [...prev.notes, note] }));
    mark(card.id, { verdict: 'issue', score: null });
    // Rewarded and sent only once the server has the note.
    void save({ notes: [...state.notes, note] }).then((saved) => {
      if (!saved) return;
      emit({ level: 'pop', key: `deck-issue:${note.id}`, title: 'Issue noted' });
      if (send) sendNotes([note.id]);
    });
  };

  const fileOf = (path: string) => d.files.find((f) => f.path === path);

  if (outdated) {
    return (
      <Alert className="m-4">
        <AlertTitle>This diff has changed</AlertTitle>
        <AlertDescription className="grid justify-items-start gap-2">
          <p>
            This deck was rebuilt from a newer diff, so progress from this tab can no longer be
            saved. Anything not yet saved here is dropped. Reviewed code that did not change stays
            reviewed, and saved notes carry over where their lines still exist.
          </p>
          <Button size="sm" disabled={reloading} onClick={onReload}>
            {reloading && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Load the new deck
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (complete.data) {
    return (
      <>
        <SummaryScreen
          summary={complete.data}
          notes={(liveStatus?.notes ?? complete.data.notes).map((n) =>
            sentIds.has(n.id) && isOpenNote(n) ? { ...n, status: 'sent' as const } : n,
          )}
          backTo={backTo}
          canSend={d.agentTarget !== null}
          pendingIds={requestChange.isPending ? requestChange.variables.noteIds : null}
          error={requestChange.isError ? describeError(requestChange.error) : null}
          onSend={sendNotes}
          status={liveStatus}
          cockpitPath={
            d.agentTarget
              ? `/cockpit?ws=${encodeURIComponent(d.agentTarget.workspaceId)}${sessionId ? `&session=${sessionId}` : ''}&tab=agent`
              : null
          }
          onReviewNew={onReload}
          reloading={reloading}
        />
        <PromptDialog
          prompt={prompt}
          workspaceId={d.agentTarget?.workspaceId ?? null}
          onClose={() => setPrompt(null)}
        />
      </>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-2xl min-w-0 flex-col gap-3 px-3 pb-3">
      <header className="flex min-w-0 items-center gap-3 pt-2">
        <DeckBackLink to={backTo} className="rv-icon-btn shrink-0" aria-label="Back">
          <ArrowLeft className="size-4" />
        </DeckBackLink>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={d.title}>
            {d.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{d.subtitle}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {Math.min(cursor + 1, cards.length)}/{cards.length}
        </span>
        <CoverageRing
          value={coverage}
          label={`Coverage ${Math.round(coverage * 100)}%: ${perFile.map((f) => `${f.path} ${f.done}/${f.total}`).join(', ')}`}
        />
        <button
          type="button"
          className="rv-icon-btn shrink-0"
          aria-label="Rebuild deck"
          title="Rebuild the deck from the current diff (resets cards, progress and notes)"
          disabled={rebuilding}
          onClick={() => {
            if (
              window.confirm(
                'Rebuild this deck from the current diff? Cards, progress and notes of this deck are discarded.',
              )
            )
              onRebuild();
          }}
        >
          {rebuilding ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </button>
      </header>

      {d.rebuilt === 'rewritten' && (
        <p className="rounded-control bg-warning/10 px-3 py-1.5 text-xs text-warning">
          The branch history was rewritten (force-push), so this deck was rebuilt from scratch.
        </p>
      )}
      {rebuildError && <p className="text-xs text-destructive">{rebuildError}</p>}

      {d.ai.note && (
        <p className="rounded-control bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="mr-1 inline size-3" />
          {d.ai.note}
        </p>
      )}
      {(d.ai.triageBy || d.ai.quizBy) && (
        <p className="text-2xs text-muted-foreground">
          {d.ai.triageBy && `Triage by ${aiGeneratedByLabel(d.ai.triageBy)}`}
          {d.ai.triageBy && d.ai.quizBy && ' / '}
          {d.ai.quizBy && `Quiz by ${aiGeneratedByLabel(d.ai.quizBy)}`}
        </p>
      )}
      {d.truncated && (
        <p className="rounded-control bg-warning/10 px-3 py-1.5 text-xs text-warning">
          GitLab truncated the diff: some files are not in the deck.
        </p>
      )}

      {cards.length === 0 && (
        <p className="rounded-surface border border-dashed p-8 text-center text-sm text-muted-foreground">
          No changes to review.
        </p>
      )}

      {card && (
        <div className="relative flex min-h-0 flex-1 flex-col pb-3">
          <DeskPile done={cursor} />
          <SwipeCard
            key={card.id}
            onSwipe={onSwipe}
            pending={pending}
            reduced={reduced}
            disabled={card.kind === 'quiz' || card.kind === 'boss' || issueOpen}
            allow={card.kind === 'bulk' ? ['right'] : ['right', 'left', 'up']}
          >
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {card.kind === 'bulk' && <BulkBody card={card} />}
              {card.kind === 'hunk' && (
                <div className="grid gap-3 p-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={card.hunk.file}
                    >
                      {card.hunk.file}
                    </span>
                    <Badge variant={TIER_BADGE[card.hunk.tier].variant}>
                      {TIER_BADGE[card.hunk.tier].label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      hunk {card.hunk.hunkIndex + 1}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {card.hunk.group} · {card.hunk.reason}
                  </p>
                  <ExplainableDiff
                    deckId={d.deckId}
                    aiReady={aiReady}
                    file={card.hunk.file}
                    text={card.hunk.text}
                    hunkId={card.hunk.id}
                  />
                  {state.notes.some((n) => n.hunkId === card.hunk.id) && (
                    <Badge variant="warning">
                      {state.notes.filter((n) => n.hunkId === card.hunk.id).length} notes
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => setFullFile(card.hunk.file)}
                    className="justify-self-start text-xs text-primary-ink underline-offset-4 hover:underline"
                  >
                    View full file
                  </button>
                  {flipped && (
                    <CardBack
                      deckId={d.deckId}
                      hunkId={card.hunk.id}
                      aiReady={aiReady}
                      onUnderstood={() => mark(card.id, { verdict: 'explained', score: null })}
                    />
                  )}
                </div>
              )}
              {card.kind === 'quiz' && (
                <QuizCardView
                  deckId={d.deckId}
                  cardId={card.id}
                  quiz={card.quiz}
                  aiReady={aiReady}
                  onDone={(score) => mark(card.id, { verdict: 'answered', score })}
                />
              )}
              {card.kind === 'boss' && (
                <BossCard
                  deckId={d.deckId}
                  question={card.question}
                  aiReady={aiReady}
                  onDone={(score) => mark(card.id, { verdict: 'answered', score })}
                />
              )}
            </div>
          </SwipeCard>
        </div>
      )}

      {!card && cards.length > 0 && (
        <div className="grid flex-1 place-items-center">
          {complete.isPending && <Loader2 className="size-6 motion-safe:animate-spin" />}
          {complete.isError && (
            <Alert variant="destructive">
              <AlertTitle>The deck cannot be completed yet</AlertTitle>
              <AlertDescription>{describeError(complete.error)}</AlertDescription>
            </Alert>
          )}
          {coverage < 1 && (
            <div className="grid justify-items-center gap-2 text-center text-sm">
              <p>Some hunks have not been touched yet ({Math.round(coverage * 100)}%).</p>
              <Button variant="outline" onClick={() => setState((s) => ({ ...s, cursor: 0 }))}>
                Start over
              </Button>
            </div>
          )}
        </div>
      )}

      {card && (card.kind === 'hunk' || card.kind === 'bulk') && (
        <nav className="grid grid-cols-3 gap-2" aria-label="Card actions">
          <Button
            variant="outline"
            className="h-12 rounded-surface"
            disabled={card.kind !== 'hunk' || flipped}
            onClick={() => setPending('left')}
          >
            <ArrowLeft className="size-4" /> Not yet
          </Button>
          <Button
            variant="outline"
            className="h-12 rounded-surface border-warning/50 text-warning"
            disabled={card.kind !== 'hunk'}
            onClick={() => setPending('up')}
          >
            <ArrowUp className="size-4" /> Issue
          </Button>
          <Button className="h-12 rounded-surface" onClick={() => setPending('right')}>
            {card.kind === 'bulk' ? (
              <CheckCheck className="size-4" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            Understood
          </Button>
        </nav>
      )}

      {card?.kind === 'hunk' && (
        <IssueSheet
          // Prefixed: this is a sibling of the SwipeCard keyed by card.id. A shared key stops React removing old cards.
          key={`issue:${card.id}`}
          hunk={card.hunk}
          open={issueOpen}
          onClose={() => setIssueOpen(false)}
          onSave={saveIssue}
          canSend={d.agentTarget !== null}
          sending={requestChange.isPending}
        />
      )}

      <Dialog open={fullFile !== null} onOpenChange={(o) => !o && setFullFile(null)}>
        <DialogContent className="top-auto bottom-0 max-h-[90dvh] max-w-none translate-y-0 rounded-t-sheet rounded-b-none p-3 sm:bottom-auto sm:top-1/2 sm:max-w-4xl sm:-translate-y-1/2 sm:rounded-sheet">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{fullFile}</DialogTitle>
          </DialogHeader>
          {fullFile && d.agentTarget && (
            <Link
              to={`/cockpit?ws=${encodeURIComponent(d.agentTarget.workspaceId)}&tab=files&file=${encodeURIComponent(fullFile)}`}
              className="justify-self-start text-xs text-primary-ink underline-offset-4 hover:underline"
            >
              Edit file in the Cockpit →
            </Link>
          )}
          {fullFile && fileOf(fullFile)?.diff ? (
            <ExplainableDiff
              key={fullFile}
              deckId={d.deckId}
              aiReady={aiReady}
              file={fullFile}
              text={fileOf(fullFile)!.diff!}
              className="max-h-[60dvh] overflow-y-auto"
            />
          ) : (
            <p className="text-sm text-muted-foreground">The diff of this file is not available.</p>
          )}
        </DialogContent>
      </Dialog>

      <PromptDialog
        prompt={prompt}
        workspaceId={d.agentTarget?.workspaceId ?? null}
        onClose={() => setPrompt(null)}
      />
      {requestChange.isError && (
        <p className="text-xs text-destructive">{describeError(requestChange.error)}</p>
      )}
    </div>
  );
}

/** `/review/:source/:id/deck` (source = mr | compare | local). */
export function DeckView() {
  const { source: kind, id } = useParams();
  const [search] = useSearchParams();
  const { state } = useLocation();
  const source = useMemo(() => deckSourceFrom(kind, id, search), [kind, id, search]);
  const q = useDeck(source);
  const rebuild = useRebuildDeck(source);
  const backTo =
    (state as { from?: string } | null)?.from ??
    (source?.kind === 'mr'
      ? `/review/${source.repoId}/mr/${source.iid}`
      : source?.kind === 'compare'
        ? `/review/${source.repoId}/compare?from=${encodeURIComponent(source.from)}&to=${encodeURIComponent(source.to)}`
        : '/cockpit');

  if (!source) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Invalid deck address</AlertTitle>
      </Alert>
    );
  }
  if (q.isPending) {
    return (
      <div className="grid h-[60dvh] place-items-center text-sm text-muted-foreground">
        <div className="grid justify-items-center gap-2">
          <Loader2 className="size-6 motion-safe:animate-spin" />
          <p>Preparing the deck… (AI triage + quiz can take about a minute the first time)</p>
        </div>
      </div>
    );
  }
  if (q.isError) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Could not open the deck</AlertTitle>
        <AlertDescription>{describeError(q.error)}</AlertDescription>
      </Alert>
    );
  }
  // Keyed by fetch: a reloaded deck starts from the server's state, not this tab's.
  return (
    <Deck
      key={q.dataUpdatedAt}
      d={q.data}
      backTo={backTo}
      onReload={() => void q.refetch()}
      reloading={q.isFetching}
      onRebuild={() => rebuild.mutate()}
      rebuilding={rebuild.isPending}
      rebuildError={rebuild.isError ? describeError(rebuild.error) : null}
    />
  );
}
