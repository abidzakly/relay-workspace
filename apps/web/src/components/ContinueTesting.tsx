import { Smartphone, X } from 'lucide-react';
import { NavLink } from 'react-router';
import { useDismissBench, useOpenBenches } from '@/lib/testBenchApi';
import { cn } from '@/lib/utils';

/**
 * "Continue testing": Test Bench pages that were opened and are not finished yet, so a device test can be picked up
 * again without going through Create MR. An entry leaves once the branch is tested on its HEAD, gets an MR, or is
 * dismissed here. Renders nothing when there is none.
 */

const benchPath = (repo: string, branch: string) =>
  `/test-bench/${encodeURIComponent(repo)}?branch=${encodeURIComponent(branch)}`;

export function ContinueTesting({ variant }: { variant: 'rail' | 'chips' }) {
  const q = useOpenBenches();
  const dismiss = useDismissBench();
  const list = q.data ?? [];
  if (list.length === 0) return null;

  if (variant === 'chips') {
    return (
      <div
        className="flex gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none]"
        aria-label="Continue testing"
        role="group"
      >
        {list.map((b) => (
          <NavLink
            key={`${b.repoId}:${b.branch}`}
            to={benchPath(b.repoId, b.branch)}
            className="flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-full border border-hairline px-3 text-xs"
          >
            <Smartphone aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{b.cardTitle}</span>
            <span className="shrink-0 font-mono text-micro text-muted-foreground">
              {b.passed}/{b.ac}
            </span>
          </NavLink>
        ))}
      </div>
    );
  }

  return (
    <section aria-label="Continue testing" className="border-t border-hairline px-6 pt-3 pb-2">
      <p className="type-micro text-muted-foreground">Continue testing</p>
      <ul className="mt-1.5 grid">
        {list.map((b) => (
          <li key={`${b.repoId}:${b.branch}`} className="group flex items-center gap-1">
            <NavLink
              to={benchPath(b.repoId, b.branch)}
              title={b.branch}
              className={({ isActive }) =>
                cn(
                  'flex min-w-0 flex-1 items-start gap-2 py-1.5 text-xs transition-colors',
                  isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              <Smartphone aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span className="grid min-w-0 flex-1">
                <span className="truncate">{b.cardTitle}</span>
                <span className="truncate font-mono text-micro text-muted-foreground">
                  {b.branch}
                </span>
              </span>
              <span className="shrink-0 font-mono text-micro tabular-nums">
                {b.passed}/{b.ac}
                <span className="sr-only"> AC passed</span>
              </span>
            </NavLink>
            <button
              type="button"
              aria-label={`Stop listing ${b.cardTitle}`}
              title="Hide from this list (opening the bench again brings it back)"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate({ repo: b.repoId, branch: b.branch })}
              className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
