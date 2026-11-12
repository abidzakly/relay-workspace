import { Loader2, Rocket, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Workspace } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError, describeError } from '@/lib/api';
import { useApplyWrite, usePreviewWrite } from '@/lib/cardApi';
import { useSettings } from '@/lib/settingsApi';
import { useStateSnapshot } from '@/lib/stateApi';
import { cn } from '@/lib/utils';
import { GeneratedBy } from '@/components/GeneratedBy';
import { useBases, useBaseSuggest, useCardStart } from '@/lib/workflowApi';
import {
  briefAttachments,
  CardBrief,
  EMPTY_BRIEF,
  figmaLinkProblem,
  type Brief,
} from './CardBrief';
import { DirtyTreePanel } from './DirtyTreePanel';
import { ExistingBranchPrompt } from './ExistingBranchPrompt';

/**
 * Card start from the app: pick a card (or arrive with one from the Board) → ALWAYS choose
 * the base branch (the base, a branch with an open MR, or ask AI) → status In Progress (the usual preview + token write)
 * → `git checkout -b <Branch formula> <base>` → an agent session that follows the repo's `ruleset/` and stops at the push.
 */
export function StartCardDialog({
  ws,
  workspaces,
  cardId: givenCardId,
  open,
  onClose,
  onStarted,
}: {
  ws: Workspace;
  workspaces: Workspace[];
  /** Chosen on the Board: the card list is skipped. */
  cardId: string | null;
  open: boolean;
  onClose: () => void;
  onStarted: (sessionId: string | null, workspaceId: string) => void;
}) {
  const state = useStateSnapshot();
  const preview = usePreviewWrite();
  const apply = useApplyWrite();
  const start = useCardStart();
  const suggest = useBaseSuggest();
  const [filter, setFilter] = useState('');
  const [pickedCardId, setPickedCardId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState(ws.id);
  const [base, setBase] = useState('');
  const preferred = useSettings().data?.agentPreference ?? 'claude';
  const [picked, setAgent] = useState<'claude' | 'cursor' | '' | null>(null);
  const agent = picked ?? preferred;
  const allCards = state.data?.cards;
  const cardId = givenCardId ?? pickedCardId;
  const card = allCards?.find((c) => c.id === cardId) ?? null;
  const resuming = /in progress/i.test(card?.status ?? '');
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [encoding, setEncoding] = useState(false);
  const [encodeError, setEncodeError] = useState<string | null>(null);
  // Instructions and files belong to one card.
  useEffect(() => {
    setBrief(EMPTY_BRIEF);
    setEncodeError(null);
  }, [cardId, open]);

  // A card from the Board opens in the workspace of its repo.
  useEffect(() => {
    if (!open) return;
    const fit = givenCardId
      ? workspaces.find((w) => w.repoId && card?.domainRepoIds.includes(w.repoId))
      : null;
    setWorkspaceId(fit?.id ?? ws.id);
    // Only on arrival: a state refresh must not undo a workspace the user picked.
  }, [open, givenCardId, card?.id, workspaces, ws.id]);

  const bases = useBases(open ? workspaceId : null);
  // The answer belongs to one card in one workspace: it must not carry over.
  useEffect(() => {
    setBase('');
    suggest.reset();
    start.reset();
  }, [workspaceId, cardId, open]);

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? ws;
  const cards = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (allCards ?? [])
      .filter(
        (c) =>
          c.mine &&
          c.branchName &&
          (!workspace.repoId ||
            c.domainRepoIds.length === 0 ||
            c.domainRepoIds.includes(workspace.repoId)),
      )
      .filter((c) => !/complete|done|ready to test|archived/i.test(c.status ?? ''))
      .filter(
        (c) =>
          !f || c.title.toLowerCase().includes(f) || (c.branchName ?? '').toLowerCase().includes(f),
      )
      .slice(0, 40);
  }, [allCards, filter, workspace.repoId]);
  const busy = encoding || preview.isPending || apply.isPending || start.isPending;

  /** The brief as the API takes it; files are read only now, right before the start. */
  const withBrief = async () => {
    if (!agent) return {};
    setEncoding(true);
    setEncodeError(null);
    try {
      const attachments = await briefAttachments(brief.files);
      return {
        ...(brief.extraPrompt.trim() ? { extraPrompt: brief.extraPrompt.trim() } : {}),
        ...(brief.figmaUrl.trim() ? { figmaUrl: brief.figmaUrl.trim() } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    } catch (e) {
      setEncodeError(`Could not read a file: ${(e as Error).message}`);
      return null;
    } finally {
      setEncoding(false);
    }
  };

  const branchExists = start.error instanceof ApiError && start.error.code === 'branch_exists';
  const treeDirty = start.error instanceof ApiError && start.error.code === 'ws_dirty';

  /** After the tree was stashed or discarded: the status write (if any) already ran, so only the start is retried. */
  const startAfterClean = async () => {
    if (!card || !base) return;
    const extra = await withBrief();
    if (!extra) return;
    start.mutate(
      { cardId: card.id, workspaceId, base, agent: agent || null, ...extra },
      {
        onSuccess: (r) => {
          onStarted(r.sessionId, workspaceId);
          onClose();
        },
      },
    );
  };

  /** The branch already exists and the user chose what to do with it: only the start is retried. */
  const startWithExisting = async (existing: 'replace' | 'reuse') => {
    if (!card || !base) return;
    const extra = await withBrief();
    if (!extra) return;
    start.mutate(
      { cardId: card.id, workspaceId, base, agent: agent || null, existing, ...extra },
      {
        onSuccess: (r) => {
          onStarted(r.sessionId, workspaceId);
          onClose();
        },
      },
    );
  };

  const go = async () => {
    if (!card || !base) return;
    // Files are read before the status write: a bad file must not leave the card In Progress with no agent.
    const extra = await withBrief();
    if (!extra) return;
    const begin = () =>
      start.mutate(
        { cardId: card.id, workspaceId, base, agent: agent || null, ...extra },
        {
          onSuccess: (r) => {
            onStarted(r.sessionId, workspaceId);
            onClose();
          },
        },
      );
    if (/in progress/i.test(card.status ?? '')) return begin();
    preview.mutate(
      { kind: 'status', cardId: card.id, to: 'In Progress' },
      {
        onSuccess: (p) =>
          apply.mutate(
            {
              request: { kind: 'status', cardId: card.id, to: 'In Progress' },
              confirmToken: p.confirmToken,
            },
            { onSuccess: begin },
          ),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="top-auto bottom-0 max-h-[90dvh] max-w-none translate-y-0 overflow-y-auto rounded-t-sheet rounded-b-none sm:bottom-auto sm:top-1/2 sm:max-w-lg sm:-translate-y-1/2 sm:rounded-sheet">
        <DialogHeader>
          <DialogTitle>{resuming ? 'Continue card' : 'Start card'}</DialogTitle>
          <DialogDescription>
            {resuming
              ? "The card is already In Progress, so its status stays. Creates the branch from the Branch formula, then opens an agent in plan mode. After you approve its plan, it follows the repo's ruleset and pushes without creating an MR."
              : "Sets the status to In Progress, creates the branch from the Branch formula, then opens an agent in plan mode. After you approve its plan, it follows the repo's ruleset and pushes without creating an MR."}
          </DialogDescription>
        </DialogHeader>
        {givenCardId ? (
          <div className="rounded-xl border px-3 py-2">
            {card ? (
              <>
                <span className="block text-sm font-medium [overflow-wrap:anywhere]">
                  {card.title}
                </span>
                <span className="block font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                  {card.branchName ?? 'No Branch formula'} · {card.status ?? '—'}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {state.isPending ? 'Loading the card…' : 'This card is not in the cache.'}
              </span>
            )}
          </div>
        ) : (
          <>
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search cards…"
            />
            <ul className="grid max-h-48 gap-1 overflow-y-auto">
              {cards.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setPickedCardId(c.id)}
                    className={cn(
                      'w-full rounded-xl border px-3 py-2 text-left',
                      c.id === pickedCardId ? 'border-primary bg-primary/10' : 'hover:bg-accent/50',
                    )}
                  >
                    <span className="block truncate text-sm">{c.title}</span>
                    <span className="block truncate font-mono text-2xs text-muted-foreground">
                      {c.branchName} · {c.status ?? '—'}
                    </span>
                  </button>
                </li>
              ))}
              {state.data && cards.length === 0 && (
                <p className="text-sm text-muted-foreground">No matching cards.</p>
              )}
            </ul>
          </>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Workspace
            <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Agent
            <Select value={agent} onChange={(e) => setAgent(e.target.value as typeof agent)}>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
              <option value="">No agent</option>
            </Select>
          </label>
        </div>
        <fieldset className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <legend className="text-sm font-medium">Start from which branch?</legend>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto h-7 text-xs"
              disabled={!card || suggest.isPending}
              onClick={() =>
                card &&
                suggest.mutate(
                  { cardId: card.id, workspaceId },
                  { onSuccess: (r) => setBase(r.base) },
                )
              }
            >
              {suggest.isPending ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
              ) : (
                <Sparkles className="size-3.5" aria-hidden />
              )}
              Analyze with AI
            </Button>
          </div>
          <div className="grid max-h-44 gap-1 overflow-y-auto">
            {(bases.data ?? []).map((b) => (
              <label
                key={b.name}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm',
                  base === b.name ? 'border-primary bg-primary/10' : 'hover:bg-accent/50',
                )}
              >
                <input
                  type="radio"
                  name="card-base"
                  checked={base === b.name}
                  onChange={() => setBase(b.name)}
                />
                <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
                  {b.label}
                </span>
                {suggest.data?.base === b.name && (
                  <span className="ml-auto shrink-0 text-2xs font-medium text-primary-ink">
                    AI pick
                  </span>
                )}
              </label>
            ))}
            {bases.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
          </div>
          {suggest.data && <p className="text-xs text-muted-foreground">{suggest.data.reason}</p>}
          {suggest.data?.generatedBy && <GeneratedBy by={suggest.data.generatedBy} />}
          {(bases.error || suggest.error) && (
            <p className="text-xs text-destructive">
              {describeError(bases.error ?? suggest.error)}
            </p>
          )}
        </fieldset>
        {agent && (
          <CardBrief cardId={card?.id ?? null} value={brief} onChange={setBrief} disabled={busy} />
        )}
        <Button
          disabled={
            !card?.branchName || !base || busy || (!!agent && !!figmaLinkProblem(brief.figmaUrl))
          }
          onClick={() => void go()}
        >
          {busy ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Rocket className="size-4" />
          )}
          Start
        </Button>
        {(preview.error || apply.error || (start.error && !treeDirty && !branchExists)) && (
          <p className="text-sm text-destructive">
            {describeError(preview.error ?? apply.error ?? start.error)}
          </p>
        )}
        {encodeError && <p className="text-sm text-destructive">{encodeError}</p>}
        {treeDirty && (
          <DirtyTreePanel
            workspaceId={workspaceId}
            disabled={busy}
            onCleared={() => void startAfterClean()}
          />
        )}
        {branchExists && card?.branchName && base && (
          <ExistingBranchPrompt
            branch={card.branchName}
            base={base}
            disabled={busy}
            onChoose={(existing) => void startWithExisting(existing)}
            onCancel={() => start.reset()}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
