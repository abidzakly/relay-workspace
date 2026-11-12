import {
  Bot,
  FolderTree,
  GitFork,
  Layers,
  Loader2,
  Play,
  Plus,
  Rocket,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { SessionKind, Workspace } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { useRemoveWorkspace, useWorkspaces } from '@/lib/cockpitApi';
import { useSessions, useStartSession, type SessionView } from '@/lib/sessionApi';
import { cn } from '@/lib/utils';
import { AgentView } from '@/cockpit/AgentView';
import { ConversationView } from '@/cockpit/ConversationView';
import { FilesView } from '@/cockpit/FilesView';
import { ReviewView } from '@/cockpit/ReviewView';
import { RunView } from '@/cockpit/RunView';
import { AttentionPanel } from '@/cockpit/AttentionPanel';
import { Helper, useFinishedSessionReward } from '@/cockpit/Helper';
import { StartCardDialog } from '@/cockpit/StartCardDialog';
import {
  DEFAULT_SESSION_POSTRACK,
  SessionPostrackOptions,
  sessionPostrackRequest,
  type SessionPostrack,
} from '@/postrack/SessionPostrackOptions';
import { WS_RING } from '@/cockpit/wsColors';
import { RepoMark } from '@/components/RepoMark';
import { PageTitle } from '@/components/PageTitle';

/**
 * Mobile Dev Cockpit. Desktop: left rail (workspaces + sessions), tabbed main area.
 * Mobile: workspace chips in the header and a bottom tab bar Agent · Review · Run · Terminal · Files.
 * Sessions live on this computer: closing the page (or locking the phone) leaves them running.
 */

const TABS = [
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'review', label: 'Review', icon: Layers },
  { id: 'run', label: 'Run', icon: Play },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'files', label: 'Files', icon: FolderTree },
] as const;
type TabId = (typeof TABS)[number]['id'];

const KIND_LABEL: Record<SessionKind, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  shell: 'Shell',
  flutter: 'Run',
};

function NewSession({
  open,
  onClose,
  workspaces,
  initialWs,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  workspaces: Workspace[];
  initialWs: string | null;
  onStarted: (id: string, ws: string, kind: SessionKind) => void;
}) {
  const start = useStartSession();
  const [postrack, setPostrack] = useState<SessionPostrack>(DEFAULT_SESSION_POSTRACK);
  const [ws, setWs] = useState(initialWs ?? workspaces[0]?.id ?? '');
  useEffect(() => setWs(initialWs ?? workspaces[0]?.id ?? ''), [initialWs, workspaces]);
  const kinds: { kind: SessionKind; label: string; hint: string; icon: typeof Bot }[] = [
    { kind: 'claude', label: 'Claude', hint: 'plan first', icon: Bot },
    { kind: 'cursor', label: 'Cursor', hint: 'terminal, plan mode', icon: Bot },
    { kind: 'shell', label: 'Shell', hint: 'zsh -l', icon: SquareTerminal },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-auto bottom-0 max-w-none translate-y-0 rounded-t-sheet rounded-b-none sm:bottom-auto sm:top-1/2 sm:max-w-md sm:-translate-y-1/2 sm:rounded-sheet">
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWs(w.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm',
                ws === w.id && cn('ring-2', WS_RING[w.color]),
              )}
            >
              <RepoMark color={w.color} />
              {w.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {kinds.map((k) => (
            <Button
              key={k.kind}
              variant="outline"
              className="h-auto min-h-20 min-w-0 flex-col gap-1 rounded-surface px-2 py-3 text-center whitespace-normal"
              disabled={!ws || start.isPending}
              onClick={() =>
                start.mutate(
                  {
                    workspaceId: ws,
                    kind: k.kind,
                    ...(k.kind === 'claude' ? { postrack: sessionPostrackRequest(postrack) } : {}),
                  },
                  {
                    onSuccess: (s) => {
                      onStarted(s.id, ws, k.kind);
                      onClose();
                    },
                  },
                )
              }
            >
              <k.icon className="size-5" />
              <span className="text-sm">{k.label}</span>
              <span className="max-w-full font-mono text-micro text-balance break-words text-muted-foreground">
                {k.hint}
              </span>
            </Button>
          ))}
        </div>
        <SessionPostrackOptions
          value={postrack}
          onChange={setPostrack}
          disabled={start.isPending}
        />
        {start.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
        {start.error && <p className="text-sm text-destructive">{describeError(start.error)}</p>}
      </DialogContent>
    </Dialog>
  );
}

const NO_SESSIONS: SessionView[] = [];

function SessionTabs({
  sessions,
  active,
  onPick,
}: {
  sessions: SessionView[];
  active: string | null;
  onPick: (id: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div
      className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]"
      role="tablist"
      aria-label="Sessions"
    >
      {sessions.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === active}
          onClick={() => onPick(s.id)}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs whitespace-nowrap',
            s.id === active
              ? 'border-primary bg-primary/10 text-primary-ink'
              : 'text-muted-foreground',
          )}
        >
          <span>
            {KIND_LABEL[s.kind]} {i + 1}
          </span>
          <Helper session={s} />
        </button>
      ))}
    </div>
  );
}

export function Cockpit() {
  const [params, setParams] = useSearchParams();
  const wsQ = useWorkspaces();
  const sessionsQ = useSessions();
  const [picker, setPicker] = useState(false);
  const [startCard, setStartCard] = useState(false);
  // The Board's "Start with agent": the card is already chosen, the base branch is still asked for.
  const startCardId = params.get('startCard');
  // Each repo workspace, followed by the worktrees made from it for bulk starts.
  const workspaces = useMemo(() => orderWorkspaces(wsQ.data ?? []), [wsQ.data]);
  const removeWs = useRemoveWorkspace();
  const sessions = sessionsQ.data ?? [];
  useFinishedSessionReward(sessionsQ.data ?? NO_SESSIONS);

  const sessionParam = params.get('session');
  const returnTo = useSessionReturnTo(sessionParam, params.get('returnTo'));
  const fromSession = sessions.find((s) => s.id === sessionParam);
  const wsId = params.get('ws') ?? fromSession?.workspaceId ?? workspaces[0]?.id ?? null;
  const ws = workspaces.find((w) => w.id === wsId) ?? null;
  const tab =
    (params.get('tab') as TabId | null) ?? (fromSession?.kind === 'shell' ? 'terminal' : 'agent');
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );

  const inWs = useMemo(() => sessions.filter((s) => s.workspaceId === wsId), [sessions, wsId]);
  const tabSessions = useMemo(
    () =>
      inWs.filter((s) =>
        tab === 'agent'
          ? s.kind === 'claude' || s.kind === 'cursor'
          : tab === 'terminal'
            ? s.kind === 'shell'
            : false,
      ),
    [inWs, tab],
  );
  const active =
    tabSessions.find((s) => s.id === sessionParam) ??
    tabSessions.find((s) => s.state !== 'exited') ??
    tabSessions.at(-1) ??
    null;
  const liveIn = (id: string) => sessions.some((x) => x.workspaceId === id && x.state !== 'exited');
  const waitingCount = (id: string) =>
    sessions.filter((s) => s.workspaceId === id && s.waiting).length;

  if (wsQ.isPending) {
    return (
      <div className="grid h-[60dvh] place-items-center">
        <Loader2 className="size-6 motion-safe:animate-spin" />
      </div>
    );
  }
  if (wsQ.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the Cockpit</AlertTitle>
        <AlertDescription>{describeError(wsQ.error)}</AlertDescription>
      </Alert>
    );
  }
  if (workspaces.length === 0) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-6 text-center">
        <PageTitle>Cockpit</PageTitle>
        <p className="text-sm text-muted-foreground">
          Add a workspace (a repo folder on this computer) first to run agents, terminals and the
          app.
        </p>
        <Button asChild>
          <Link to="/settings#workspaces">Add workspace</Link>
        </Button>
      </div>
    );
  }

  const body = !ws ? null : tab === 'review' ? (
    <div className="grid gap-5">
      <AttentionPanel />
      <ReviewView ws={ws} />
    </div>
  ) : tab === 'run' ? (
    <RunView ws={ws} sessions={sessions} />
  ) : tab === 'files' ? (
    <FilesView ws={ws} initialPath={params.get('file')} />
  ) : (
    <>
      <div className="flex items-center gap-2">
        <SessionTabs
          sessions={tabSessions}
          active={active?.id ?? null}
          onPick={(id) => set({ session: id })}
        />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 shrink-0 rounded-full"
          onClick={() => setPicker(true)}
        >
          <Plus className="size-4" /> Session
        </Button>
      </div>
      {active ? (
        active.kind === 'claude' ? (
          <ConversationView key={active.id} s={active} />
        ) : (
          <AgentView key={active.id} s={active} returnTo={returnTo(active.id)} />
        )
      ) : (
        <div className="grid flex-1 place-items-center rounded-surface border border-dashed p-8 text-center text-sm text-muted-foreground">
          <div className="grid justify-items-center gap-3">
            <p>
              {tab === 'agent' ? 'No agent session in this workspace yet.' : 'No terminal yet.'}
            </p>
            <Button onClick={() => setPicker(true)}>
              <Plus className="size-4" /> {tab === 'agent' ? 'Start an agent' : 'Open a terminal'}
            </Button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="mx-auto flex h-[calc(100dvh-4.5rem)] w-full max-w-6xl min-w-0 gap-4 md:h-[calc(100dvh-3rem)]">
      {/* Desktop rail */}
      <aside className="hidden w-60 shrink-0 flex-col gap-3 md:flex">
        <h1 className="px-1 text-2xl font-semibold tracking-tight">Cockpit</h1>
        <ul className="grid grid-cols-1 gap-1">
          {workspaces.map((w) => (
            <li
              key={w.id}
              className={cn('flex min-w-0 items-center', w.kind === 'worktree' && 'pl-5')}
            >
              <button
                type="button"
                onClick={() => set({ ws: w.id, session: null })}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm',
                  w.id === wsId ? 'bg-accent font-medium' : 'hover:bg-accent/50',
                )}
              >
                {w.kind === 'worktree' ? (
                  <GitFork className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <RepoMark color={w.color} size="md" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {w.kind === 'worktree' && <span className="sr-only">Worktree: </span>}
                  {w.name}
                </span>
                {waitingCount(w.id) > 0 && (
                  <span className="shrink-0 rounded-full bg-primary px-1.5 text-micro font-semibold text-primary-foreground">
                    {waitingCount(w.id)}
                  </span>
                )}
              </button>
              {w.kind === 'worktree' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove worktree ${w.name}`}
                  title={
                    liveIn(w.id)
                      ? 'Stop its sessions first'
                      : 'Remove this worktree folder (the branch and its commits stay)'
                  }
                  disabled={liveIn(w.id) || removeWs.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove the worktree ${w.name}? Its folder is deleted, uncommitted changes in it are lost. The branch and its commits stay.`,
                      )
                    ) {
                      if (w.id === wsId) set({ ws: w.parentId, session: null });
                      removeWs.mutate(w.id);
                    }
                  }}
                >
                  <X className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-1 gap-1">
          <p className="px-1 text-xs text-muted-foreground">Sessions</p>
          {inWs.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                set({
                  session: s.id,
                  tab: s.kind === 'shell' ? 'terminal' : s.kind === 'flutter' ? 'run' : 'agent',
                })
              }
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs',
                s.id === active?.id ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <Helper session={s} />
            </button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            onClick={() => setPicker(true)}
          >
            <Plus className="size-4" /> New session
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="justify-start"
            onClick={() => setStartCard(true)}
          >
            <Rocket className="size-4" /> Start card
          </Button>
        </div>
        <AttentionPanel compact />
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {/* Mobile header: workspace switcher chips */}
        <div className="flex gap-1.5 overflow-x-auto pt-1 [scrollbar-width:none] md:hidden">
          <button
            type="button"
            onClick={() => setStartCard(true)}
            aria-label="Start card"
            className="grid size-8 shrink-0 place-items-center rounded-full border"
          >
            <Rocket className="size-4" />
          </button>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => set({ ws: w.id, session: null })}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs',
                w.id === wsId && cn('ring-2', WS_RING[w.color]),
              )}
            >
              <RepoMark color={w.color} />
              {w.name}
              {waitingCount(w.id) > 0 && (
                <span className="rounded-full bg-primary px-1 text-micro font-semibold text-primary-foreground">
                  {waitingCount(w.id)}
                </span>
              )}
            </button>
          ))}
        </div>
        {/* Desktop tabs */}
        <nav className="hidden gap-1 border-b md:flex" aria-label="Cockpit">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => set({ tab: t.id })}
              className={cn(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
                tab === t.id
                  ? 'border-primary font-medium'
                  : 'border-transparent text-muted-foreground',
              )}
            >
              <t.icon className="size-4" /> {t.label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{body}</div>
        {/* Mobile bottom tab bar */}
        <nav
          className="glass grid shrink-0 grid-cols-5 rounded-surface p-1 md:hidden"
          aria-label="Cockpit"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => set({ tab: t.id })}
              aria-current={tab === t.id ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-xl py-1.5 text-2xs',
                tab === t.id ? 'bg-primary/10 text-primary-ink' : 'text-muted-foreground',
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </button>
          ))}
        </nav>
      </section>

      {ws && (
        <StartCardDialog
          ws={ws}
          workspaces={workspaces}
          cardId={startCardId}
          open={startCard || startCardId !== null}
          onClose={() => {
            setStartCard(false);
            if (startCardId !== null) set({ startCard: null });
          }}
          onStarted={(id, workspaceId) =>
            set({ ws: workspaceId, tab: 'agent', session: id, startCard: null })
          }
        />
      )}
      <NewSession
        open={picker}
        onClose={() => setPicker(false)}
        workspaces={workspaces}
        initialWs={wsId}
        onStarted={(id, w, kind) =>
          set({ ws: w, session: id, tab: kind === 'shell' ? 'terminal' : 'agent' })
        }
      />
    </div>
  );
}

/**
 * "Back to testing" for a session started from the Test Bench: taken from `?returnTo=` and remembered per session in
 * this browser, so it survives a reload or opening the cockpit from the notification. Only in-app bench paths.
 */
const RETURN_KEY = 'cockpit:return-to';
const isBenchPath = (p: string | null): p is string =>
  !!p && /^\/test-bench\/[a-z0-9-]+\?branch=/.test(p);

function useSessionReturnTo(
  sessionId: string | null,
  fromUrl: string | null,
): (id: string) => string | null {
  const [map, setMap] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(RETURN_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (!sessionId || !isBenchPath(fromUrl) || map[sessionId] === fromUrl) return;
    const next = { ...map, [sessionId]: fromUrl };
    // Keep the newest 20.
    const trimmed = Object.fromEntries(Object.entries(next).slice(-20));
    setMap(trimmed);
    try {
      localStorage.setItem(RETURN_KEY, JSON.stringify(trimmed));
    } catch {
      /* private mode: the URL still carries it */
    }
  }, [sessionId, fromUrl, map]);
  return (id: string) =>
    isBenchPath(map[id] ?? null)
      ? map[id]!
      : id === sessionId && isBenchPath(fromUrl)
        ? fromUrl
        : null;
}

/** Repo workspaces in name order, each followed by its worktrees. A worktree whose parent is gone comes last. */
function orderWorkspaces(list: readonly Workspace[]): Workspace[] {
  const repos = list.filter((w) => w.kind !== 'worktree');
  const out: Workspace[] = [];
  for (const r of repos) {
    out.push(r, ...list.filter((w) => w.kind === 'worktree' && w.parentId === r.id));
  }
  return [...out, ...list.filter((w) => !out.includes(w))];
}
