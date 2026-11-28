import { Bot, FolderTree, Layers, Loader2, Play, Plus, SquareTerminal } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { isConversationKind, type SessionKind, type Workspace } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { useRemoveWorkspace, useWorkspaces } from '@/lib/cockpitApi';
import { useSessions, useStartSession, type SessionView } from '@/lib/sessionApi';
import { isBenchPath, readBenchReturns, rememberBenchReturn } from '@/lib/benchReturn';
import { cn } from '@/lib/utils';
import { AgentView } from '@/cockpit/AgentView';
import { ConversationView } from '@/cockpit/ConversationView';
import { FilesView } from '@/cockpit/FilesView';
import { ReviewView } from '@/cockpit/ReviewView';
import { RunView } from '@/cockpit/RunView';
import { AttentionPanel } from '@/cockpit/AttentionPanel';
import { StartQueue } from '@/cockpit/StartQueue';
import { Helper, useFinishedSessionReward } from '@/cockpit/Helper';
import { SessionDock } from '@/cockpit/SessionDock';
import { StartCardDialog } from '@/cockpit/StartCardDialog';
import { WorkspaceMenu } from '@/cockpit/WorkspaceMenu';
import { useFitHeight } from '@/cockpit/useFitHeight';
import { WS_RING } from '@/cockpit/wsColors';
import { RepoMark } from '@/components/RepoMark';
import { PageTitle } from '@/components/PageTitle';
import '@/cockpit/cockpit.css';

/**
 * Mobile Dev Cockpit as one focus sheet and a helper dock. The sheet's header holds the workspace switch, the open
 * session and the Agent · Review · Run · Terminal · Files switch; the dock under it holds every session, so moving
 * between agents is one tap on desk and phone alike. Sessions live on this computer: closing the page (or locking
 * the phone) leaves them running.
 */

const TABS = [
  { id: 'agent', icon: Bot },
  { id: 'review', icon: Layers },
  { id: 'run', icon: Play },
  { id: 'terminal', icon: SquareTerminal },
  { id: 'files', icon: FolderTree },
] as const;
type TabId = (typeof TABS)[number]['id'];

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
  const [ws, setWs] = useState(initialWs ?? workspaces[0]?.id ?? '');
  useEffect(() => setWs(initialWs ?? workspaces[0]?.id ?? ''), [initialWs, workspaces]);
  const kinds: { kind: SessionKind; label: string; hint: string; icon: typeof Bot }[] = [
    { kind: 'claude', label: 'Claude', hint: 'plan first', icon: Bot },
    { kind: 'cursor', label: 'Cursor', hint: 'plan first, chat', icon: Bot },
    { kind: 'shell', label: 'Shell', hint: 'zsh -l', icon: SquareTerminal },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="top-auto bottom-0 w-full sm:w-[calc(100%-1.5rem)] max-w-none translate-y-0 rounded-t-sheet rounded-b-none sm:bottom-auto sm:top-1/2 sm:max-w-md sm:-translate-y-1/2 sm:rounded-sheet">
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
                'flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm',
                ws === w.id && cn('ring-2', WS_RING[w.color]),
              )}
            >
              <RepoMark color={w.color} />
              <span className="min-w-0 truncate">{w.name}</span>
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
                  { workspaceId: ws, kind: k.kind },
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
        {start.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
        {start.error && <p className="text-sm text-destructive">{describeError(start.error)}</p>}
      </DialogContent>
    </Dialog>
  );
}

const NO_SESSIONS: SessionView[] = [];

export function Cockpit() {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const fit = useFitHeight<HTMLDivElement>();
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
  const sessions = sessionsQ.data ?? NO_SESSIONS;
  useFinishedSessionReward(sessionsQ.data ?? NO_SESSIONS);

  const sessionParam = params.get('session');
  const returnTo = useSessionReturnTo(sessionParam, params.get('returnTo'));
  const fromSession = sessions.find((s) => s.id === sessionParam);
  // The session decides its workspace: a stale `ws` in a link must not hide the session it names.
  const wsId = fromSession?.workspaceId ?? params.get('ws') ?? workspaces[0]?.id ?? null;
  const ws = workspaces.find((w) => w.id === wsId) ?? null;
  const tab =
    (params.get('tab') as TabId | null) ??
    (fromSession?.kind === 'shell' || fromSession?.kind === 'web' ? 'terminal' : 'agent');
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
            ? // A web dev server is a terminal too: its log, with input.
              s.kind === 'shell' || s.kind === 'web'
            : false,
      ),
    [inWs, tab],
  );
  const active =
    tabSessions.find((s) => s.id === sessionParam) ??
    tabSessions.find((s) => s.state !== 'exited') ??
    tabSessions.at(-1) ??
    null;
  // Every session in the dock, newest work first: agents started from the Board sit side by side, wherever their
  // worktree is. Ended sessions that cannot resume go last.
  const allSessions = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          Number(a.state === 'exited' && !a.restorable) -
            Number(b.state === 'exited' && !b.restorable) || b.startedAt - a.startedAt,
      ),
    [sessions],
  );
  // A worktree made for a card reads as that card.
  const cardTitleIn = (id: string) =>
    sessions.filter((s) => s.workspaceId === id && s.cardId).at(-1)?.title ?? null;
  const pickSession = (s: SessionView) =>
    set({
      ws: s.workspaceId,
      session: s.id,
      tab:
        s.kind === 'shell' || s.kind === 'web'
          ? 'terminal'
          : s.kind === 'flutter'
            ? 'run'
            : 'agent',
    });
  const liveIn = (id: string) => sessions.some((x) => x.workspaceId === id && x.state !== 'exited');
  const waitingCount = (id: string) =>
    sessions.filter((s) => s.workspaceId === id && s.waiting).length;
  const removeWorktree = (w: Workspace) => {
    if (!window.confirm(t('cockpit.workspace.removeConfirm', { name: w.name }))) return;
    if (w.id === wsId) set({ ws: w.parentId, session: null });
    removeWs.mutate(w.id);
  };

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
        <AlertTitle>{t('cockpit.load.failed')}</AlertTitle>
        <AlertDescription>{describeError(wsQ.error)}</AlertDescription>
      </Alert>
    );
  }
  if (workspaces.length === 0) {
    return (
      <div className="mx-auto grid max-w-md gap-3 p-6 text-center">
        <PageTitle>{t('cockpit.title')}</PageTitle>
        <p className="text-sm text-muted-foreground">{t('cockpit.load.noWorkspace')}</p>
        <Button asChild>
          <Link to="/settings#workspaces">{t('cockpit.workspace.add')}</Link>
        </Button>
      </div>
    );
  }

  const sessionTab = tab === 'agent' || tab === 'terminal';
  const body =
    !ws && !sessionTab ? null : ws && tab === 'review' ? (
      <div className="grid gap-5">
        <AttentionPanel />
        <ReviewView ws={ws} />
      </div>
    ) : ws && tab === 'run' ? (
      <RunView ws={ws} sessions={sessions} />
    ) : ws && tab === 'files' ? (
      <FilesView ws={ws} initialPath={params.get('file')} />
    ) : active ? (
      isConversationKind(active.kind) ? (
        <ConversationView key={active.id} s={active} returnTo={returnTo(active.id)} />
      ) : (
        <AgentView key={active.id} s={active} returnTo={returnTo(active.id)} />
      )
    ) : (
      <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted-foreground">
        <div className="grid justify-items-center gap-3">
          <p>{tab === 'agent' ? t('cockpit.sheet.noAgent') : t('cockpit.sheet.noTerminal')}</p>
          <Button onClick={() => setPicker(true)}>
            <Plus className="size-4" aria-hidden />{' '}
            {tab === 'agent' ? t('cockpit.sheet.startAgent') : t('cockpit.sheet.openTerminal')}
          </Button>
        </div>
      </div>
    );

  return (
    // Fills the room it is given; the CSS height is the first frame's guess (see useFitHeight).
    <div
      ref={fit.ref}
      style={fit.height ? { height: fit.height } : undefined}
      className="mx-auto flex h-[calc(100dvh-9rem)] w-full max-w-6xl min-w-0 flex-col gap-3 md:h-[calc(100dvh-7.5rem)]"
    >
      <StartQueue />
      <section className="ck-sheet flex min-h-0 flex-1 flex-col overflow-hidden rounded-sheet">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-hairline px-3 py-2.5 md:px-5">
          <h1 className="sr-only">{t('cockpit.title')}</h1>
          <WorkspaceMenu
            workspaces={workspaces}
            current={ws}
            waitingIn={waitingCount}
            liveIn={liveIn}
            cardTitleIn={cardTitleIn}
            onPick={(id) => set({ ws: id, session: null })}
            onRemove={removeWorktree}
            removing={removeWs.isPending}
          />
          {sessionTab && active && (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 truncate text-sm font-semibold tracking-tight md:text-base">
                {active.title}
              </span>
              <Helper session={active} />
            </span>
          )}
          <nav
            aria-label={t('cockpit.tabs.label')}
            className="-mx-1 flex max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-surface bg-muted p-0.5 [scrollbar-width:none] max-md:order-last max-md:w-full sm:ml-auto"
          >
            {TABS.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => set({ tab: x.id })}
                aria-current={tab === x.id ? 'page' : undefined}
                className={cn(
                  'flex h-8 flex-1 shrink-0 items-center justify-center gap-1.5 rounded-control px-2.5 text-xs sm:px-3 whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:flex-none',
                  tab === x.id
                    ? 'bg-card font-semibold text-foreground shadow-rest'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <x.icon className="size-3.5 max-sm:hidden" aria-hidden />{' '}
                {t(`cockpit.tabs.${x.id}`)}
              </button>
            ))}
          </nav>
        </header>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={`${tab}:${sessionTab ? (active?.id ?? '') : (wsId ?? '')}`}
            initial={reduced ? false : { opacity: 0.35, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'flex min-h-0 flex-1 flex-col gap-2 px-3 py-3 md:px-6 md:py-4',
              !(sessionTab && active) && 'overflow-y-auto',
            )}
          >
            {body}
          </motion.div>
        </AnimatePresence>
      </section>
      <SessionDock
        sessions={allSessions}
        workspaces={workspaces}
        active={active?.id ?? sessionParam}
        onPick={pickSession}
        onNew={() => setPicker(true)}
        onStartCard={() => setStartCard(true)}
      />

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
 * "Back to test device" for a session sent from the Test Bench: taken from `?returnTo=` and remembered per session in
 * this browser, so it survives a reload or opening the cockpit from the notification. Only in-app bench paths.
 */
function useSessionReturnTo(
  sessionId: string | null,
  fromUrl: string | null,
): (id: string) => string | null {
  const [map, setMap] = useState<Record<string, string>>(readBenchReturns);
  useEffect(() => {
    if (!sessionId || !isBenchPath(fromUrl) || map[sessionId] === fromUrl) return;
    setMap(rememberBenchReturn(sessionId, fromUrl, map));
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
