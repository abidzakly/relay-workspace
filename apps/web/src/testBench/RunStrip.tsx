import {
  Flame,
  GitBranch,
  Loader2,
  Play,
  RotateCcw,
  Square,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { FlutterRunMode } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { DirtyTreePanel } from '@/cockpit/DirtyTreePanel';
import { ApiError, describeError } from '@/lib/api';
import { useWorkspaces, useWsCheckout, useWsStatuses } from '@/lib/cockpitApi';
import {
  pickedFlavor,
  readRunPrefs,
  saveRunPrefs,
  sendInput,
  useKillSession,
  useRunTargets,
  useSessions,
  useStartSession,
} from '@/lib/sessionApi';

/**
 * Run the branch on the chosen phone: the cockpit's `flutter run` session in the repo's
 * workspace, with the entrypoint that workspace actually has. Logs open in a drawer on this page.
 */
export function RunStrip({
  repo,
  branch,
  serial,
  ios = false,
  onOpenLog,
}: {
  repo: string;
  branch: string;
  serial: string | null;
  /** The picked device is iOS: `flutter run` keeps `-t` and drops `--flavor`. */
  ios?: boolean;
  onOpenLog: () => void;
}) {
  const workspaces = useWorkspaces();
  // The repo's workspaces, worktrees included. Run in the one that already has the branch (git keeps a branch in one
  // worktree only), else in the repo workspace.
  const candidates = (workspaces.data ?? []).filter((w) => w.repoId === repo);
  const statuses = useWsStatuses(candidates.map((w) => w.id));
  const onBranch = candidates.findIndex((_w, i) => statuses[i]?.data?.branch === branch);
  const wsIndex =
    onBranch >= 0
      ? onBranch
      : Math.max(
          0,
          candidates.findIndex((w) => w.kind === 'repo'),
        );
  const ws = candidates[wsIndex] ?? null;
  const status = statuses[wsIndex] ?? { data: undefined };
  const sessions = useSessions();
  const targets = useRunTargets(ws?.id ?? null);
  const start = useStartSession();
  const kill = useKillSession();
  const checkout = useWsCheckout();
  const [flavor, setFlavor] = useState('');
  const [mode, setMode] = useState<FlutterRunMode>('debug');
  useEffect(() => {
    if (!ws) return;
    const prefs = readRunPrefs(ws.id);
    setFlavor(prefs.flavor);
    setMode(prefs.mode);
  }, [ws]);
  const run = (sessions.data ?? []).find(
    (s) => s.workspaceId === ws?.id && s.kind === 'flutter' && s.state !== 'exited',
  );
  const wrongBranch =
    status.data?.branch && status.data.branch !== branch ? status.data.branch : null;
  const treeDirty = checkout.error instanceof ApiError && checkout.error.code === 'ws_dirty';
  const doCheckout = () => ws && checkout.mutate({ workspaceId: ws.id, branch });
  const flavors = targets.data?.flavors ?? [];
  const chosen = pickedFlavor(flavors, flavor);
  const canRun = !!targets.data && (flavors.length > 0 ? chosen !== '' : targets.data.plainMain);

  if (workspaces.isPending) return null;
  if (!ws) {
    return (
      <p className="text-xs text-muted-foreground">
        No cockpit workspace holds this repo, so the app cannot be started from here.{' '}
        <Link to="/cockpit" className="underline">
          Add one
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {wrongBranch && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">
                {ws.name} has <span className="font-mono">{wrongBranch}</span> checked out, not this
                branch. Check it out before running.
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={checkout.isPending || !!run}
              title={run ? 'Stop the running app first' : `Check out ${branch} in ${ws.name}`}
              onClick={doCheckout}
            >
              {checkout.isPending ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <GitBranch className="size-4" />
              )}
              Check out now
            </Button>
          </div>
          {treeDirty ? (
            <DirtyTreePanel
              key={ws.id}
              purpose="checkout"
              target={branch}
              workspaceId={ws.id}
              disabled={checkout.isPending}
              onCleared={() => {
                checkout.reset();
                doCheckout();
              }}
            />
          ) : (
            checkout.error && (
              <p className="text-xs text-destructive">{describeError(checkout.error)}</p>
            )
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {run ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void sendInput(run.id, 'r')}>
              <Flame className="size-4" /> Hot reload
            </Button>
            <Button size="sm" variant="outline" onClick={() => void sendInput(run.id, 'R')}>
              <RotateCcw className="size-4" /> Restart
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => kill.mutate(run.id)}
              disabled={kill.isPending}
            >
              <Square className="size-4" /> Stop
            </Button>
          </>
        ) : (
          <>
            {flavors.length > 1 && (
              <Select
                aria-label="Flavor"
                className="h-8 w-40"
                value={chosen}
                onChange={(e) => {
                  setFlavor(e.target.value);
                  saveRunPrefs(ws.id, e.target.value, mode);
                }}
              >
                <option value="">Flavor…</option>
                {flavors.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            )}
            <Select
              aria-label="Mode"
              className="h-8 w-28"
              value={mode}
              onChange={(e) => {
                const next = e.target.value as FlutterRunMode;
                setMode(next);
                saveRunPrefs(ws.id, flavor, next);
              }}
            >
              <option value="debug">Debug</option>
              <option value="profile">Profile</option>
              <option value="release">Release</option>
            </Select>
            <Button
              size="sm"
              disabled={!serial || start.isPending || !canRun}
              onClick={() =>
                serial &&
                start.mutate({
                  workspaceId: ws.id,
                  kind: 'flutter',
                  deviceId: serial,
                  mode,
                  ios,
                  ...(chosen ? { flavor: chosen } : {}),
                })
              }
            >
              {start.isPending ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Run on this device
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenLog}>
          <TerminalSquare className="size-4" /> Logs
        </Button>
      </div>
      {(start.error || kill.error || targets.error) && (
        <p className="text-xs text-destructive">
          {describeError(start.error ?? kill.error ?? targets.error)}
        </p>
      )}
    </div>
  );
}
