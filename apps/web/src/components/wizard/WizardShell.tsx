import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PaperGrid } from '@/components/PaperGrid';
import { ThemeSync } from '@/components/ThemeSync';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ShellStep<K extends string> {
  key: K;
  rail: string;
  title: string;
  lede: string;
  /** Can the person move past this step. */
  done: boolean;
}

/**
 * The full-screen setup frame the Notion setup uses (`sb-*` styles): a rail of steps joined by a cable that fills as
 * you go, the current step's title and body, and Back / Continue. A step is reachable once every earlier one is done.
 * `onContinue` runs before moving on (to save what the step chose); return false to stay.
 */
export function WizardShell<K extends string>({
  mark,
  backTo,
  steps,
  at,
  onAt,
  onContinue,
  busy,
  finished,
  status,
  children,
}: {
  /** The two names joined on the rail head, e.g. ['GitLab', 'Relay']. */
  mark: [string, string];
  backTo: string;
  steps: ShellStep<K>[];
  at: number;
  onAt: (i: number) => void;
  onContinue?: (step: K) => Promise<boolean> | boolean;
  busy?: boolean;
  /** Shown instead of the footer on the last step (its own finish button). */
  finished?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const step = steps[at]!;
  const last = at === steps.length - 1;
  const progress = at / Math.max(1, steps.length - 1);

  useEffect(() => {
    stage.current?.focus({ preventScroll: true });
    stage.current?.scrollTo?.({ top: 0 });
  }, [at]);

  const next = async () => {
    if (onContinue && !(await onContinue(step.key))) return;
    onAt(Math.min(steps.length - 1, at + 1));
  };

  return (
    <div className="sb-shell">
      <ThemeSync />
      <PaperGrid />
      <div className="sb-layout">
        <nav className="sb-rail" aria-label="Setup steps">
          <div className="sb-rail-head">
            <Link to={backTo} className="text-sm text-muted-foreground hover:text-foreground">
              Back to Settings
            </Link>
            <p className="sb-mark">
              <span>{mark[0]}</span>
              <span className="sb-mark-wire" aria-hidden />
              <span>{mark[1]}</span>
            </p>
          </div>
          <ol className="sb-steps" style={{ '--sb-progress': progress } as React.CSSProperties}>
            <span className="sb-cable" aria-hidden>
              <span className="sb-cable-fill" />
            </span>
            {steps.map((s, i) => {
              const state = i < at ? 'done' : i === at ? 'now' : 'next';
              const reachable = i <= at || steps.slice(0, i).every((x) => x.done);
              return (
                <li key={s.key} data-state={state}>
                  <button
                    type="button"
                    className="sb-step"
                    disabled={!reachable}
                    aria-current={i === at ? 'step' : undefined}
                    onClick={() => onAt(i)}
                  >
                    <span className="sb-node" aria-hidden />
                    <span>{s.rail}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="sb-stage" ref={stage} tabIndex={-1}>
          <header className="sb-head">
            <h1 className="sb-title">{step.title}</h1>
            <p className="sb-lede">{step.lede}</p>
          </header>
          <section className="sb-body" aria-live="polite">
            {children}
          </section>
          <footer className={cn('sb-foot')}>
            <Button variant="ghost" disabled={at === 0} onClick={() => onAt(Math.max(0, at - 1))}>
              Back
            </Button>
            {last ? (
              finished
            ) : (
              <Button size="lg" disabled={!step.done || busy} onClick={() => void next()}>
                {busy ? 'Saving…' : 'Continue'}
              </Button>
            )}
            {status ? <span className="text-sm">{status}</span> : null}
          </footer>
        </main>
      </div>
    </div>
  );
}
