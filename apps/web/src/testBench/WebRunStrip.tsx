import {
  GitBranch,
  Loader2,
  Play,
  RotateCcw,
  Square,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { WebRunTargets } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { BranchPrepStatus } from '@/components/runBranch/BranchPrepStatus';
import { useRunBranch } from '@/components/runBranch/useRunBranch';
import { describeError } from '@/lib/api';
import { useKillSession, useSessions, useStartSession } from '@/lib/sessionApi';
import { useRunWorkspace } from './useRunWorkspace';

const SCRIPT_KEY = (ws: string) => `cockpit:web-script:${ws}`;
const readScript = (ws: string): string => {
  try {
    return localStorage.getItem(SCRIPT_KEY(ws)) ?? '';
  } catch {
    return '';
  }
};
const saveScript = (ws: string, script: string) => {
  try {
    localStorage.setItem(SCRIPT_KEY(ws), script);
  } catch {
    /* private mode: the choice still applies to this run */
  }
};

/**
 * Run the branch's web dev server: `<pm> run <script>` in the repo's workspace on the Mac, after an install when the
 * dependencies are missing or older than the lockfile. Like `RunStrip`, every run first puts the workspace on the
 * branch; the script is one of `package.json`'s.
 */
export function WebRunStrip({
  repo,
  branch,
  targets,
  autoPrepare = false,
  onAutoPrepared,
  onOpenLog,
}: {
  repo: string;
  branch: string;
  targets: WebRunTargets;
  autoPrepare?: boolean;
  onAutoPrepared?: () => void;
  onOpenLog: () => void;
}) {
  const { t } = useTranslation();
  const { workspaces, ws, wrongBranch } = useRunWorkspace(repo, branch);
  const sessions = useSessions();
  const start = useStartSession();
  const kill = useKillSession();
  const rb = useRunBranch(repo, branch);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    if (ws) setSaved(readScript(ws.id));
  }, [ws]);
  const script = targets.scripts.includes(saved) ? saved : (targets.defaultScript ?? '');
  const run = (sessions.data ?? []).find(
    (s) => s.workspaceId === ws?.id && s.kind === 'web' && s.state !== 'exited',
  );
  const runScript = () =>
    rb.ensure((r) => start.mutate({ workspaceId: r.workspaceId, kind: 'web', script }));
  const restart = () => {
    if (!run) return;
    kill.mutate(run.id, { onSuccess: runScript });
  };

  // "Run this branch": switch as soon as the workspace and its sessions are known, once. Not under a running server.
  const autoDone = useRef(false);
  useEffect(() => {
    if (!autoPrepare || autoDone.current || workspaces.isPending || sessions.isPending) return;
    autoDone.current = true;
    onAutoPrepared?.();
    if (!run) rb.ensure();
  }, [autoPrepare, workspaces.isPending, sessions.isPending, run, rb, onAutoPrepared]);

  if (workspaces.isPending) return null;
  if (!ws) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('testBench.web.noWorkspace')}{' '}
        <Link to="/cockpit" className="underline">
          {t('testBench.web.addWorkspace')}
        </Link>
        .{rb.alert}
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {wrongBranch && !rb.preparing && (
        <div className="flex flex-wrap items-start gap-2">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 wrap-anywhere">
              <Trans
                i18nKey="testBench.web.wrongBranch"
                values={{ ws: ws.name, branch: wrongBranch }}
                components={[<span key="b" className="font-mono" />]}
              />
            </span>
          </p>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={rb.preparing || !!run}
            title={
              run
                ? t('testBench.web.stopFirst')
                : t('testBench.web.checkoutTitle', { branch, ws: ws.name })
            }
            onClick={() => rb.ensure()}
          >
            <GitBranch className="size-4" />
            {t('testBench.web.checkoutNow')}
          </Button>
        </div>
      )}
      {rb.preparing && <BranchPrepStatus branch={branch} />}
      {rb.alert}
      <div className="flex flex-wrap items-center gap-1.5">
        {run ? (
          <>
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {t('testBench.web.usesPm', {
                pm: targets.pm,
                script: run.title.replace(/^Web · /, ''),
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={restart}
              disabled={kill.isPending || start.isPending}
            >
              <RotateCcw className="size-4" /> {t('testBench.web.restart')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => kill.mutate(run.id)}
              disabled={kill.isPending}
            >
              <Square className="size-4" /> {t('testBench.web.stop')}
            </Button>
          </>
        ) : targets.scripts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('testBench.web.noScripts')}</p>
        ) : (
          <>
            <Select
              aria-label={t('testBench.web.script')}
              className="h-8 w-40"
              value={script}
              onChange={(e) => {
                setSaved(e.target.value);
                saveScript(ws.id, e.target.value);
              }}
            >
              {!script && <option value="">{t('testBench.web.scriptPick')}</option>}
              {targets.scripts.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={!script || start.isPending || rb.preparing}
              title={wrongBranch ? t('testBench.web.checkoutThenRun', { branch }) : undefined}
              onClick={runScript}
            >
              {start.isPending || rb.preparing ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {t('testBench.web.run')}
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onOpenLog}>
          <TerminalSquare className="size-4" /> {t('testBench.web.logs')}
        </Button>
      </div>
      {(start.error || kill.error) && (
        <p className="text-xs text-destructive">{describeError(start.error ?? kill.error)}</p>
      )}
    </div>
  );
}
