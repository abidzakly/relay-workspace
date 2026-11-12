import { Check, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

/**
 * "You are here, next is this" for opening an MR: test on a device, review the deck, create.
 * Done steps carry a check mark and the word "done", never colour alone.
 */
export type StepState = 'done' | 'current' | 'todo';

export function MrSteps({
  steps,
}: {
  steps: { label: string; state: StepState; to?: string | undefined }[];
}) {
  return (
    <nav aria-label="Steps to open the MR">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {steps.map((s, i) => {
          const body = (
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-control border px-2 py-1',
                s.state === 'current' && 'border-primary bg-primary text-primary-foreground',
                s.state === 'done' && 'border-moss/50 bg-moss/10 text-success',
                s.state === 'todo' && 'text-muted-foreground',
              )}
            >
              <span className="font-mono">{i + 1}</span>
              {s.state === 'done' && <Check aria-hidden className="size-3.5" />}
              {s.label}
              {s.state === 'done' && <span className="sr-only">(done)</span>}
              {s.state === 'current' && <span className="sr-only">(you are here)</span>}
            </span>
          );
          return (
            <li
              key={s.label}
              className="flex items-center gap-1.5"
              aria-current={s.state === 'current' ? 'step' : undefined}
            >
              {s.to && s.state !== 'current' ? (
                <Link
                  to={s.to}
                  className="rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {body}
                </Link>
              ) : (
                body
              )}
              {i < steps.length - 1 && (
                <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
