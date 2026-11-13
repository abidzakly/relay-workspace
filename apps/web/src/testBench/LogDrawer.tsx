import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { isConversationKind } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useWorkspaces } from '@/lib/cockpitApi';
import { useSessions, type SessionView } from '@/lib/sessionApi';
import { useAiRunSession } from '@/lib/testBenchApi';
import { cn } from '@/lib/utils';
import { AgentView } from '@/cockpit/AgentView';
import { ConversationView } from '@/cockpit/ConversationView';
import { RunSession } from '@/cockpit/RunView';

export type LogTab = 'agent' | 'app';

const latest = (list: SessionView[]) =>
  list.find((s) => s.state !== 'exited') ?? list.at(-1) ?? null;

/**
 * The agent's reasoning and the app's `flutter run` log, inside the Test Bench page: you read them next to the phone
 * mirror and the AC list instead of leaving for the Cockpit. Same session views as the Cockpit tabs.
 */
export function LogDrawer({
  repo,
  runId,
  tab,
  onTab,
  onClose,
}: {
  repo: string;
  /** The latest AI run, whose session is the agent shown. */
  runId: string | null;
  tab: LogTab | null;
  onTab: (t: LogTab) => void;
  onClose: () => void;
}) {
  const workspaces = useWorkspaces();
  const ws = (workspaces.data ?? []).find((w) => w.repoId === repo) ?? null;
  const sessions = useSessions();
  const ai = useAiRunSession(tab ? runId : null);
  const inWs = (sessions.data ?? []).filter((s) => s.workspaceId === ws?.id);
  // The run's own session while it is live; afterwards (the run is gone server-side) the workspace's last agent.
  const agent =
    inWs.find((s) => s.id === ai.data?.sessionId) ??
    latest(inWs.filter((s) => s.kind === 'claude' || s.kind === 'cursor'));
  const app =
    inWs.find((s) => s.id === ai.data?.flutterSessionId) ??
    latest(inWs.filter((s) => s.kind === 'flutter'));
  const cockpit = ws
    ? `/cockpit?ws=${encodeURIComponent(ws.id)}${
        tab === 'app'
          ? `&tab=run${app ? `&session=${app.id}` : ''}`
          : `&tab=agent${agent ? `&session=${agent.id}` : ''}`
      }`
    : '/cockpit';

  return (
    <Dialog open={tab !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="top-0 right-0 left-auto flex h-dvh max-h-none w-full max-w-3xl translate-x-0 translate-y-0 flex-col gap-2 rounded-none border-y-0 border-r-0 p-3 pt-4 sm:p-4"
      >
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="sr-only">Logs</DialogTitle>
          <DialogDescription className="sr-only">
            The AI tester and the running app, without leaving the test.
          </DialogDescription>
          <div
            role="tablist"
            aria-label="Log"
            className="flex gap-1 rounded-control bg-muted p-0.5"
          >
            {(
              [
                ['agent', 'AI tester'],
                ['app', 'App log'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => onTab(id)}
                className={cn(
                  'rounded-control px-3 py-1 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  tab === id ? 'bg-background shadow-rest' : 'text-muted-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" asChild>
            <Link to={cockpit}>
              <ExternalLink className="size-3.5" /> Open in Cockpit
            </Link>
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {tab === 'agent' ? (
            agent ? (
              isConversationKind(agent.kind) ? (
                <ConversationView key={agent.id} s={agent} />
              ) : (
                <AgentView key={agent.id} s={agent} />
              )
            ) : (
              <Empty>No AI tester session yet. Start one with “Test with AI on this phone”.</Empty>
            )
          ) : app ? (
            <RunSession key={app.id} s={app} />
          ) : (
            <Empty>The app is not running. Use “Run on this phone” first.</Empty>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Empty({ children }: { children: string }) {
  return (
    <div className="grid flex-1 place-items-center rounded-surface border border-dashed p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
