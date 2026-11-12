import { Bot, Loader2, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import type { AiEngineStatus, ConnectionTestResult } from '@relay/shared';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeError } from '@/lib/api';
import { useAiStatus, useTestAi } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';

/** One dialog for the whole app (mounted in `Layout`); the sidebar, the HUD, Settings and the palette open it. */
const LAST_KEY = 'ai-check:last';

function loadLast(): ConnectionTestResult | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as ConnectionTestResult) : null;
  } catch {
    return null;
  }
}

/** `last` is the previous test result: reopening the dialog shows it; only "Check again" runs a new test. */
export const useAiCheckStore = create<{
  open: boolean;
  setOpen: (v: boolean) => void;
  last: ConnectionTestResult | null;
  setLast: (r: ConnectionTestResult) => void;
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  last: loadLast(),
  setLast: (last) => {
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(last));
    } catch {
      /* storage unavailable: keep it in memory only */
    }
    set({ last });
  },
}));

const ENGINE: Record<AiEngineStatus['engine'], { label: string; tone: string; hint: string }> = {
  claude_cli: { label: 'Claude', tone: 'text-success', hint: 'Claude CLI answers AI actions.' },
  anthropic_api: {
    label: 'Claude API',
    tone: 'text-success',
    hint: 'The Anthropic API answers AI actions.',
  },
  cursor_cli: {
    label: 'Cursor',
    tone: 'text-warning',
    hint: 'Claude is not available: Cursor answers AI actions.',
  },
  none: { label: 'AI off', tone: 'text-destructive', hint: 'No AI engine is available.' },
};

/** Opens the AI connection check. Icon always; the engine name too unless `compact`. Never colour only. */
export function AiStatusButton({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const status = useAiStatus();
  const setOpen = useAiCheckStore((s) => s.setOpen);
  const view = status.data
    ? ENGINE[status.data.engine]
    : { label: 'AI…', tone: 'text-muted-foreground', hint: 'Checking the AI engine.' };
  return (
    <Button
      variant="ghost"
      size={compact ? 'icon' : 'sm'}
      className={cn(
        !compact && 'h-auto justify-start gap-1.5 px-1 py-1 text-xs',
        view.tone,
        className,
      )}
      title={`${view.hint} Click to test the connection.`}
      aria-label={`AI engine: ${view.label}. Check connection`}
      onClick={() => setOpen(true)}
    >
      <Bot aria-hidden="true" className={compact ? undefined : 'size-3.5'} />
      {compact ? null : <span>{view.label}</span>}
    </Button>
  );
}

/** Shows the previous result; only "Check again" runs a new test. */
export function AiCheckDialog() {
  const open = useAiCheckStore((s) => s.open);
  const setOpen = useAiCheckStore((s) => s.setOpen);
  const last = useAiCheckStore((s) => s.last);
  const setLast = useAiCheckStore((s) => s.setLast);
  const test = useTestAi();
  const run = () => test.mutate(undefined, { onSuccess: setLast });
  const result = test.data ?? last;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AI connection</DialogTitle>
          <DialogDescription>
            Sends one short message to each engine. Claude is tried first; Cursor answers when it
            fails.
          </DialogDescription>
        </DialogHeader>
        {test.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Testing Claude and Cursor…
          </p>
        ) : null}
        {test.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {describeError(test.error)}
          </p>
        ) : null}
        {result ? (
          <ConnectionChecklist result={result} />
        ) : test.isPending ? null : (
          <p className="text-sm text-muted-foreground">Not checked yet.</p>
        )}
        <Button variant="outline" onClick={run} disabled={test.isPending}>
          <RefreshCw aria-hidden="true" />
          {result ? 'Check again' : 'Check now'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
