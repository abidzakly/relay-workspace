import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  GitFork,
  KeyRound,
  Laptop,
  Loader2,
  Plug,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DirtyTreePanel } from '@/cockpit/DirtyTreePanel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RunBranchIssue, RunBranchIssueKind } from '@/lib/runBranchApi';
import './runBranch.css';

const ICON: Record<RunBranchIssueKind, LucideIcon> = {
  network: WifiOff,
  auth: KeyRound,
  fetch: TriangleAlert,
  missing: GitBranch,
  agent: Plug,
  busy: Bot,
  held: GitFork,
  dirty: FolderGit2,
  workspace: FolderGit2,
  stale: WifiOff,
  git: TriangleAlert,
};

/** The route a run takes, left to right. The failure marks where it broke. */
const ROUTE: { id: 'relay' | 'mac' | 'vpn' | 'origin'; label: string; icon: LucideIcon }[] = [
  { id: 'relay', label: 'Relay', icon: Radio },
  { id: 'mac', label: 'This Mac', icon: Laptop },
  { id: 'vpn', label: 'VPN', icon: ShieldCheck },
  { id: 'origin', label: 'origin', icon: Server },
];
const BREAK_AT: Record<RunBranchIssue['broken'], number> = {
  agent: 1,
  workspace: 1,
  network: 2,
  origin: 3,
};

function Route({ broken }: { broken: RunBranchIssue['broken'] }) {
  const at = BREAK_AT[broken];
  return (
    <ol className="rb-route" aria-label="Where the run stopped">
      {ROUTE.map((n, i) => {
        const state = i < at ? 'ok' : i === at ? 'fail' : 'idle';
        const Icon = n.icon;
        return (
          <li key={n.id} className="rb-route-step" data-state={state}>
            {i > 0 && (
              <span
                className="rb-route-link"
                data-state={i <= at ? (i === at ? 'cut' : 'ok') : 'idle'}
              />
            )}
            <span className="rb-route-node">
              <Icon aria-hidden className="size-3.5" />
            </span>
            <span className="rb-route-label">{n.label}</span>
            <span className="sr-only">
              {state === 'ok' ? 'reached' : state === 'fail' ? 'failed here' : 'not reached'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rb-copy"
      onClick={(e) => {
        // Inside a <summary>: copy without toggling the disclosure.
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
      aria-label={label}
    >
      {done ? (
        <Check aria-hidden className="size-3.5" />
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Retries by itself when the network comes back (or the window regains focus, e.g. after turning the VPN on). */
function useAutoRetry(enabled: boolean, busy: boolean, retry: () => void) {
  const last = useRef(0);
  const latest = useRef({ busy, retry });
  latest.current = { busy, retry };
  useEffect(() => {
    if (!enabled) return;
    const fire = () => {
      const now = Date.now();
      if (latest.current.busy || now - last.current < 4000) return;
      last.current = now;
      latest.current.retry();
    };
    const onVisible = () => document.visibilityState === 'visible' && fire();
    window.addEventListener('online', fire);
    window.addEventListener('focus', fire);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', fire);
      window.removeEventListener('focus', fire);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);
}

/**
 * Why "Run this branch" stopped, and how to get going again: the route from Relay to origin with the broken hop lit,
 * the cause in plain words, what to try, git's own output, and Retry.
 */
export function RunBranchAlert({
  repo,
  branch,
  issue,
  workspaceId,
  busy,
  onRetry,
  onUseLocal,
  onClose,
}: {
  repo: string;
  branch: string;
  issue: RunBranchIssue;
  workspaceId: string | null;
  busy: boolean;
  onRetry: () => void;
  /** Stale local copy: continue with it. */
  onUseLocal: (() => void) | null;
  onClose: () => void;
}) {
  const Icon = ICON[issue.kind];
  const watching =
    issue.kind === 'network' || (issue.kind === 'stale' && issue.broken === 'network');
  useAutoRetry(watching, busy, onRetry);

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="rb-dialog max-w-xl gap-0 p-0 sm:p-0" data-tone={issue.tone}>
        <div className="rb-hero">
          <div className="rb-hero-glow" aria-hidden />
          <div className="rb-hero-grid" aria-hidden />
          <div className="relative flex items-start gap-4">
            <span className="rb-beacon" aria-hidden>
              <span className="rb-beacon-ring" />
              <span className="rb-beacon-ring rb-beacon-ring-2" />
              <span className="rb-beacon-core">
                {busy ? (
                  <Loader2 className="size-6 motion-safe:animate-spin" />
                ) : (
                  <Icon className="size-6" />
                )}
              </span>
            </span>
            <div className="grid min-w-0 gap-2 pt-0.5">
              <p className="type-micro rb-eyebrow">
                Run this branch <ChevronRight aria-hidden className="inline size-3" /> {repo}
              </p>
              <DialogTitle className="text-xl sm:text-2xl">{issue.title}</DialogTitle>
              <span className="rb-chip" title={branch}>
                <GitBranch aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{branch}</span>
              </span>
            </div>
          </div>
          <Route broken={issue.broken} />
        </div>

        <div className="grid gap-4 p-5 sm:px-8 sm:py-6">
          <DialogDescription className="text-sm leading-relaxed text-foreground/85">
            {issue.body}
          </DialogDescription>

          {watching && (
            <p className="rb-watch" role="status">
              <span className="rb-watch-dot" aria-hidden />
              {busy
                ? 'Trying origin again…'
                : 'Watching for the connection — retries by itself when you’re back.'}
            </p>
          )}

          {issue.steps.length > 0 && (
            <ol className="rb-steps">
              {issue.steps.map((s, i) => (
                <li key={s} style={{ ['--i' as string]: i }}>
                  <span className="rb-step-n" aria-hidden>
                    {i + 1}
                  </span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}

          {issue.kind === 'agent' && (
            <div className="rb-cmd">
              <code>pnpm agent</code>
              <CopyButton text="pnpm agent" label="Copy the command" />
            </div>
          )}

          {issue.kind === 'dirty' && workspaceId && (
            <DirtyTreePanel
              key={workspaceId}
              purpose="checkout"
              target={branch}
              workspaceId={workspaceId}
              disabled={busy}
              onCleared={onRetry}
            />
          )}

          {issue.raw && (
            <details className="rb-raw">
              <summary>
                <span>What git said</span>
                <CopyButton text={issue.raw} label="Copy git output" />
              </summary>
              <pre>{issue.raw}</pre>
            </details>
          )}
        </div>

        <DialogFooter className="rb-footer">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {onUseLocal ? 'Not now' : 'Close'}
          </Button>
          {issue.kind === 'busy' && (
            <Button variant="outline" asChild>
              <Link to="/cockpit" onClick={onClose}>
                <Bot className="size-4" /> Open Cockpit
              </Link>
            </Button>
          )}
          {(issue.kind === 'workspace' || issue.kind === 'held') && (
            <Button variant="outline" asChild>
              <Link to="/settings#workspaces" onClick={onClose}>
                <FolderGit2 className="size-4" /> Workspaces
              </Link>
            </Button>
          )}
          {onUseLocal && (
            <Button variant="outline" onClick={onUseLocal} disabled={busy}>
              <Laptop className="size-4" /> Use local copy
            </Button>
          )}
          {issue.kind !== 'dirty' && (
            <Button onClick={onRetry} disabled={busy} autoFocus>
              {busy ? (
                <Loader2 className="size-4 motion-safe:animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Retry
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
