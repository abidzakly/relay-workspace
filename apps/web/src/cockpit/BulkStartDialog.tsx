import { Check, GitFork, Loader2, Rocket, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BULK_START_MAX, type StateCard, type Workspace } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { RepoMark } from '@/components/RepoMark';
import { ApiError, describeError } from '@/lib/api';
import { useApplyWrite, usePreviewWrite } from '@/lib/cardApi';
import { useWorkspaces } from '@/lib/cockpitApi';
import { emit } from '@/lib/reward/engine';
import { useSettings } from '@/lib/settingsApi';
import { useBases, useCardStart } from '@/lib/workflowApi';
import { figmaLinkProblem } from './CardBrief';
import { ExistingBranchPrompt, type ExistingBranchChoice } from './ExistingBranchPrompt';

/**
 * Bulk "Start with agent": several cards, each with its own agent. The first card of a workspace starts in it as usual;
 * the next ones (or any card whose workspace is busy or has changes) get a git worktree of their own, so the agents
 * never share a working tree. Each card goes In Progress first, like a single start. One row = one card.
 */

type Agent = 'claude' | 'cursor';

type Answer = ExistingBranchChoice | 'skip';

interface Row {
  card: StateCard;
  workspaceId: string;
  agent: Agent;
  /** '' = not loaded yet: the workspace's base branch once its options arrive. */
  base: string;
  /** Figma node links for this card's agent, on top of the ones in the card. */
  figmaUrl: string;
}

type Outcome =
  | { state: 'waiting' }
  | { state: 'running' }
  /** The card's branch already exists: the run waits for the user's choice on this row. */
  | { state: 'asking' }
  | { state: 'skipped' }
  | { state: 'started'; workspaceId: string; worktree: boolean; sessionId: string | null }
  | { state: 'failed'; message: string };

const AGENTS: { value: Agent; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'cursor', label: 'Cursor' },
];

export function BulkStartDialog({
  cards,
  onClose,
}: {
  /** null = closed. */
  cards: StateCard[] | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={cards !== null} onOpenChange={(o) => !o && onClose()}>
      {cards && <Body key={cards.map((c) => c.id).join()} cards={cards} onClose={onClose} />}
    </Dialog>
  );
}

function Body({ cards, onClose }: { cards: StateCard[]; onClose: () => void }) {
  const workspaces = (useWorkspaces().data ?? []).filter((w) => w.kind === 'repo');
  const preferred: Agent = useSettings().data?.agentPreference === 'cursor' ? 'cursor' : 'claude';
  const [rows, setRows] = useState<Row[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [running, setRunning] = useState(false);
  const preview = usePreviewWrite();
  const apply = useApplyWrite();
  const start = useCardStart();
  /** Resolves the pending "branch already exists" question, per card. */
  const answers = useRef<Record<string, (a: Answer) => void>>({});

  const ask = (cardId: string) =>
    new Promise<Answer>((resolve) => {
      answers.current[cardId] = resolve;
      setOutcomes((o) => ({ ...o, [cardId]: { state: 'asking' } }));
    });

  const answer = (cardId: string, a: Answer) => {
    const resolve = answers.current[cardId];
    delete answers.current[cardId];
    resolve?.(a);
  };

  // Rows are set once the workspaces are known: each card opens in the workspace of its repo.
  useEffect(() => {
    if (rows.length > 0 || workspaces.length === 0) return;
    setRows(
      cards.slice(0, BULK_START_MAX).map((card) => ({
        card,
        workspaceId:
          workspaces.find((w) => w.repoId && card.domainRepoIds.includes(w.repoId))?.id ??
          workspaces[0]!.id,
        agent: preferred,
        base: '',
        figmaUrl: '',
      })),
    );
  }, [cards, workspaces, preferred, rows.length]);

  const setRow = (cardId: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.card.id === cardId ? { ...r, ...patch } : r)));

  const allAgents = (agent: Agent) => setRows((rs) => rs.map((r) => ({ ...r, agent })));

  const finished = Object.values(outcomes).some(
    (o) => o.state === 'started' || o.state === 'failed' || o.state === 'skipped',
  );
  const ready =
    rows.length > 0 && rows.every((r) => r.base !== '' && !figmaLinkProblem(r.figmaUrl));

  const go = async () => {
    setRunning(true);
    setOutcomes(Object.fromEntries(rows.map((r) => [r.card.id, { state: 'waiting' } as Outcome])));
    // One at a time: each start sees the sessions the previous ones opened, so it knows to take a worktree.
    for (const r of rows) {
      setOutcomes((o) => ({ ...o, [r.card.id]: { state: 'running' } }));
      try {
        if (!/in progress/i.test(r.card.status ?? '')) {
          const request = { kind: 'status' as const, cardId: r.card.id, to: 'In Progress' };
          const p = await preview.mutateAsync(request);
          await apply.mutateAsync({ request, confirmToken: p.confirmToken });
        }
        const startRow = (existing?: ExistingBranchChoice) =>
          start.mutateAsync({
            cardId: r.card.id,
            workspaceId: r.workspaceId,
            base: r.base,
            agent: r.agent,
            worktree: 'auto',
            ...(existing ? { existing } : {}),
            ...(r.figmaUrl.trim() ? { figmaUrl: r.figmaUrl.trim() } : {}),
          });
        let res: Awaited<ReturnType<typeof startRow>>;
        try {
          res = await startRow();
        } catch (e) {
          if (!(e instanceof ApiError && e.code === 'branch_exists')) throw e;
          // The status write already ran: only the start is retried, with the user's choice.
          const a = await ask(r.card.id);
          if (a === 'skip') {
            setOutcomes((o) => ({ ...o, [r.card.id]: { state: 'skipped' } }));
            continue;
          }
          setOutcomes((o) => ({ ...o, [r.card.id]: { state: 'running' } }));
          res = await startRow(a);
        }
        setOutcomes((o) => ({
          ...o,
          [r.card.id]: {
            state: 'started',
            workspaceId: res.workspaceId,
            worktree: res.worktree,
            sessionId: res.sessionId,
          },
        }));
      } catch (e) {
        setOutcomes((o) => ({ ...o, [r.card.id]: { state: 'failed', message: describeError(e) } }));
      }
    }
    setRunning(false);
    emit({ level: 'tick', key: 'cockpit:bulk-start', repeatable: true });
  };

  return (
    <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          Start {rows.length || cards.length} with <span className="type-accent">agents</span>
        </DialogTitle>
        <DialogDescription>
          Each card moves to In Progress and gets its own agent. The first card of a workspace
          starts there; the others get a git worktree of their own next to it, so no two agents
          share files.
          {cards.length > BULK_START_MAX && ` Only the first ${BULK_START_MAX} cards are started.`}
        </DialogDescription>
      </DialogHeader>

      {workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No workspaces yet. Add one in{' '}
          <Link to="/settings#workspaces" className="underline underline-offset-4">
            Settings → Workspaces
          </Link>{' '}
          first.
        </p>
      ) : (
        <>
          {!finished && !running && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="type-micro text-muted-foreground">All agents</span>
              {AGENTS.map((a) => (
                <Button
                  key={a.value}
                  size="sm"
                  variant="outline"
                  onClick={() => allAgents(a.value)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
          <ul className="divide-y divide-border border-y">
            {rows.map((r) => (
              <BulkRow
                key={r.card.id}
                row={r}
                workspaces={workspaces}
                outcome={outcomes[r.card.id]}
                locked={running || finished}
                onChange={(patch) => setRow(r.card.id, patch)}
                onAnswer={(a) => answer(r.card.id, a)}
              />
            ))}
          </ul>
        </>
      )}

      <DialogFooter>
        {finished && !running ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="outline" disabled={running} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!ready || running} onClick={() => void go()}>
              {running ? <Loader2 className="motion-safe:animate-spin" /> : <Rocket />}
              {running ? 'Starting…' : `Start ${rows.length}`}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function BulkRow({
  row,
  workspaces,
  outcome,
  locked,
  onChange,
  onAnswer,
}: {
  row: Row;
  workspaces: Workspace[];
  outcome: Outcome | undefined;
  locked: boolean;
  onChange: (patch: Partial<Row>) => void;
  onAnswer: (a: Answer) => void;
}) {
  const bases = useBases(row.workspaceId);
  const ws = workspaces.find((w) => w.id === row.workspaceId);
  const figmaProblem = figmaLinkProblem(row.figmaUrl);
  // The workspace's own base branch is the default, as in the single start.
  useEffect(() => {
    if (row.base === '' && bases.data?.[0]) onChange({ base: bases.data[0].name });
  }, [bases.data, row.base, onChange]);

  return (
    <li className="grid gap-2 py-3">
      <div className="flex items-start gap-2">
        {ws && <RepoMark color={ws.color} className="mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{row.card.title}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{row.card.branchName}</p>
        </div>
        <OutcomeMark outcome={outcome} />
      </div>
      {outcome?.state === 'asking' ? (
        <ExistingBranchPrompt
          branch={row.card.branchName ?? ''}
          base={row.base}
          disabled={false}
          onChoose={onAnswer}
          onCancel={() => onAnswer('skip')}
          cancelLabel="Skip card"
        />
      ) : outcome?.state === 'skipped' ? (
        <p className="text-sm text-muted-foreground">Skipped: the branch was left as it is.</p>
      ) : outcome?.state === 'failed' ? (
        <p role="alert" className="text-sm text-destructive">
          {outcome.message}
        </p>
      ) : outcome?.state === 'started' ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {outcome.worktree ? (
            <>
              <GitFork className="size-4" aria-hidden /> In its own worktree.
            </>
          ) : (
            'In the workspace.'
          )}
          <Link
            to={`/cockpit?ws=${encodeURIComponent(outcome.workspaceId)}${outcome.sessionId ? `&session=${encodeURIComponent(outcome.sessionId)}` : ''}`}
            className="underline underline-offset-4"
          >
            Open →
          </Link>
        </p>
      ) : (
        <div className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <Select
              aria-label={`Workspace for ${row.card.title}`}
              value={row.workspaceId}
              disabled={locked}
              onChange={(e) => onChange({ workspaceId: e.target.value, base: '' })}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Agent for ${row.card.title}`}
              value={row.agent}
              disabled={locked}
              onChange={(e) => onChange({ agent: e.target.value as Agent })}
            >
              {AGENTS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={`Base branch for ${row.card.title}`}
              value={row.base}
              disabled={locked || !bases.data}
              onChange={(e) => onChange({ base: e.target.value })}
            >
              {!bases.data && <option value="">Loading…</option>}
              {(bases.data ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {b.label}
                </option>
              ))}
            </Select>
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Figma link (optional)
            <Input
              value={row.figmaUrl}
              maxLength={4_000}
              disabled={locked}
              onChange={(e) => onChange({ figmaUrl: e.target.value })}
              placeholder="https://www.figma.com/design/…?node-id=12-34"
              aria-invalid={!!figmaProblem}
              className="text-sm text-foreground"
            />
            {figmaProblem && <span className="text-destructive">{figmaProblem}</span>}
          </label>
        </div>
      )}
    </li>
  );
}

function OutcomeMark({ outcome }: { outcome: Outcome | undefined }) {
  if (!outcome) return null;
  switch (outcome.state) {
    case 'waiting':
      return <span className="text-xs text-muted-foreground">waiting</span>;
    case 'running':
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> starting
        </span>
      );
    case 'asking':
      return <span className="text-xs text-destructive">needs your answer</span>;
    case 'skipped':
      return <span className="text-xs text-muted-foreground">skipped</span>;
    case 'started':
      return (
        <span className="flex items-center gap-1 text-xs text-success">
          <Check className="size-3.5" aria-hidden /> started
        </span>
      );
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-xs text-destructive">
          <X className="size-3.5" aria-hidden /> failed
        </span>
      );
  }
}
