import { Bot, Hand, Loader2, Square, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import {
  CURSOR_TEST_MODELS,
  type CursorTestModel,
  type TestBenchState,
  type TestRunEngine,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { useResumeAiRun, useStartAiRun, useStopAiRun } from '@/lib/testBenchApi';

const PREF_KEY = 'testbench.aiEngine';
const MODEL_LABEL: Record<CursorTestModel, string> = {
  auto: 'Auto (balanced)',
  'composer-2.5-fast': 'Composer 2.5 Fast',
};

function readPrefs(): { engine: TestRunEngine; model: CursorTestModel } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as {
      engine?: string;
      model?: string;
    };
    return {
      engine: v.engine === 'cursor' ? 'cursor' : 'claude',
      model: CURSOR_TEST_MODELS.find((m) => m === v.model) ?? 'auto',
    };
  } catch {
    return { engine: 'claude', model: 'auto' };
  }
}

/**
 * "Test with AI on this phone". The agent (Claude, or Cursor on Auto / Composer 2.5 Fast) drives
 * the phone you see in the mirror, marks each AC with evidence and logs findings; you can watch its reasoning in the
 * log drawer, help it when it asks, or stop it. The verdict at the end is the server's, from the marks.
 */
export function AiRunPanel({
  repo,
  branch,
  st,
  serial,
  onOpenLog,
}: {
  repo: string;
  branch: string;
  st: TestBenchState;
  serial: string | null;
  onOpenLog: () => void;
}) {
  const start = useStartAiRun(repo, branch);
  const resume = useResumeAiRun(repo, branch);
  const stop = useStopAiRun(repo, branch);
  const [prefs, setPrefs] = useState(readPrefs);
  const setPref = (next: { engine: TestRunEngine; model: CursorTestModel }) => {
    setPrefs(next);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice just is not remembered */
    }
  };
  const run = st.latestRun;
  const live =
    run?.mode === 'ai' && (run.status === 'active' || run.status === 'paused') ? run : null;
  const marked = st.checks.filter((c) => c.runId === live?.id && c.by === 'ai').length;
  const total = st.readiness.counts.ac + st.readiness.counts.regressions;
  const error = start.error ?? resume.error ?? stop.error;

  if (!live) {
    return (
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            aria-label="AI engine"
            className="h-8 w-28"
            value={prefs.engine}
            onChange={(e) => setPref({ ...prefs, engine: e.target.value as TestRunEngine })}
          >
            <option value="claude">Claude</option>
            <option value="cursor">Cursor</option>
          </Select>
          {prefs.engine === 'cursor' && (
            <Select
              aria-label="Cursor model"
              className="h-8 w-44"
              value={prefs.model}
              onChange={(e) => setPref({ ...prefs, model: e.target.value as CursorTestModel })}
            >
              {CURSOR_TEST_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m]}
                </option>
              ))}
            </Select>
          )}
        </div>
        <Button
          variant="secondary"
          className="h-auto min-h-9 max-w-full whitespace-normal text-center"
          disabled={!serial || start.isPending}
          title={serial ? undefined : 'Connect a phone first'}
          onClick={() =>
            serial && start.mutate({ serial, engine: prefs.engine, cursorModel: prefs.model })
          }
        >
          {start.isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Bot className="size-4" />
          )}
          Test with AI on this phone
        </Button>
        <p className="text-xs text-muted-foreground">
          The AI runs the app, checks every AC against the screen and Figma, and logs findings
          without stopping. Your ticks so far stay; it overwrites the ones it re-checks.
        </p>
        {run?.mode === 'ai' && run.status === 'aborted' && run.summary && (
          <p className="text-xs text-muted-foreground">Last AI run: {run.summary}</p>
        )}
        {run?.mode === 'ai' && run.status === 'done' && run.summary && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Last AI run report</summary>
            <p className="mt-1 whitespace-pre-wrap">{run.summary}</p>
          </details>
        )}
        {error && <p className="text-xs text-destructive">{describeError(error)}</p>}
      </div>
    );
  }

  return (
    <section aria-label="AI test run" className="grid gap-2 rounded-surface border bg-card p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Bot aria-hidden className="size-4 text-primary-ink" />
        {live.status === 'paused' ? 'AI tester is waiting for you' : 'AI is testing this phone…'}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {marked}/{total} checked
        </span>
      </p>
      {live.status === 'paused' && live.waitingFor && (
        <div className="grid gap-2 rounded-control bg-primary/10 p-2 text-sm">
          <p className="flex items-start gap-1.5">
            <Hand aria-hidden className="mt-0.5 size-4 shrink-0" />
            {live.waitingFor}
          </p>
          <Button
            size="sm"
            className="justify-self-start"
            disabled={resume.isPending}
            onClick={() => resume.mutate(live.id)}
          >
            Done, continue
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="ghost" onClick={onOpenLog}>
          <TerminalSquare className="size-4" /> Watch the agent
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={stop.isPending}
          onClick={() => stop.mutate(live.id)}
        >
          <Square className="size-4" /> Stop
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{describeError(error)}</p>}
    </section>
  );
}
