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
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { FlutterRunMode } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { BranchPrepStatus } from '@/components/runBranch/BranchPrepStatus';
import { useRunBranch } from '@/components/runBranch/useRunBranch';
import { describeError } from '@/lib/api';
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
import { useRunWorkspace } from './useRunWorkspace';

/**
 * Run the branch on the chosen phone: the cockpit's `flutter run` session in the repo's
 * workspace, with the entrypoint that workspace actually has. Logs open in a drawer on this page.
 * Every run first puts the workspace on the branch (fetched and tracked when it is not local); failures open a dialog.
 */
export function RunStrip({
  repo,
  branch,
  serial,
  ios = false,
  autoPrepare = false,
  onAutoPrepared,
  onOpenLog,
}: {
  repo: string;
  branch: string;
  serial: string | null;
  /** The picked device is iOS: `flutter run` keeps `-t` and drops `--flavor`. */
  ios?: boolean;
  /** Opened from "Run this branch": check the branch out as soon as the workspace is known. */
  autoPrepare?: boolean;
  onAutoPrepared?: () => void;
  onOpenLog: () => void;
}) {
  const { workspaces, ws, wrongBranch } = useRunWorkspace(repo, branch);
  const sessions = useSessions();
  const targets = useRunTargets(ws?.id ?? null);
  const start = useStartSession();
  const kill = useKillSession();
  const rb = useRunBranch(repo, branch);
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
  const doCheckout = () => rb.ensure();
  const flavors = targets.data?.flavors ?? [];
  const chosen = pickedFlavor(flavors, flavor);
  const canRun = !!targets.data && (flavors.length > 0 ? chosen !== '' : targets.data.plainMain);
  const runOn = (deviceId: string) =>
    rb.ensure((r) =>
      start.mutate({
        workspaceId: r.workspaceId,
        kind: 'flutter',
        deviceId,
        mode,
        ios,
        ...(chosen ? { flavor: chosen } : {}),
      }),
    );

  // "Run this branch": switch as soon as the workspace and its sessions are known, once. Not under a running app.
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoPrepare || autoDone.current || workspaces.isPending || sessions.isPending) return;
    autoDone.current = true;
    onAutoPrepared?.();
    // No workspace: the server says so, and the dialog points at Settings → Workspaces.
    if (!run) rb.ensure();
  }, [autoPrepare, workspaces.isPending, sessions.isPending, run, rb, onAutoPrepared]);

  if (workspaces.isPending) return null;
  if (!ws) {
    return (
      <p className="text-xs text-muted-foreground">
        No cockpit workspace holds this repo, so the app cannot be started from here.{' '}
        <Link to="/cockpit" className="underline">
          Add one
        </Link>
        .{rb.alert}
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {wrongBranch && !rb.preparing && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-start gap-2">
            <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">
                {ws.name} has <span className="font-mono">{wrongBranch}</span> checked out, not this
                branch. Running checks it out first.
              </span>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={rb.preparing || !!run}
              title={run ? 'Stop the running app first' : `Check out ${branch} in ${ws.name}`}
              onClick={doCheckout}
            >
              {rb.preparing ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <GitBranch className="size-4" />
              )}
              Check out now
            </Button>
          </div>
        </div>
      )}
      {rb.preparing && <BranchPrepStatus branch={branch} />}
      {rb.alert}
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
              disabled={!serial || start.isPending || rb.preparing || !canRun}
              title={wrongBranch ? `Checks out ${branch} first, then runs` : undefined}
              onClick={() => serial && runOn(serial)}
            >
              {start.isPending || rb.preparing ? (
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
