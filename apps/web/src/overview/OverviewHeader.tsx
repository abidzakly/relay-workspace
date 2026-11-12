import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { StateCard } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { MonthFilter } from '@/components/MonthFilter';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/store/ui';
import { AsciiSwitch, ModeSwitch, ScopeSwitch } from './ProgressSummary';
import { PageTitle } from '@/components/PageTitle';

/**
 * Rendering controls: the stage view and ASCII change only how the CoreStage is drawn, so they sit
 * behind one disclosure instead of competing with the analytic filters. Escape or a click outside closes it.
 */
export function ViewSettings({ className }: { className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const close = (e: Event) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details
      ref={ref}
      className={cn('ov-view-settings relative', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && ref.current?.open) {
          // Escape closes this first; the world's own Escape (back to the world) waits for the next press.
          e.preventDefault();
          e.stopPropagation();
          ref.current.open = false;
          ref.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4" aria-hidden />
        View settings
      </summary>
      <div
        role="group"
        aria-label="View settings"
        className="absolute left-0 z-20 mt-2 sm:right-0 sm:left-auto flex w-max max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lift"
      >
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Stage view · presentation only</span>
          <ModeSwitch />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Rendering</span>
          <div className="flex flex-wrap gap-2">
            <AsciiSwitch />
          </div>
        </div>
      </div>
    </details>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-2xs leading-none font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

/** The Overview's filters (Period, Scope, reset) and the view settings, without a title, for any layout. */
export function OverviewControls({
  cards,
  className,
}: {
  cards: readonly StateCard[];
  className?: string;
}) {
  const month = useUiStore((s) => s.cardMonth);
  const scope = useUiStore((s) => s.scope);
  const setMonth = useUiStore((s) => s.setCardMonth);
  const setScope = useUiStore((s) => s.setScope);
  const filtered = month !== 'current' || scope !== 'cycle';
  return (
    <div className={cn('flex flex-wrap items-end gap-3', className)}>
      <Labelled label="Period · KPI">
        <MonthFilter cards={cards} />
      </Labelled>
      <Labelled label="Scope · Release">
        <ScopeSwitch />
      </Labelled>
      {filtered && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setMonth('current');
            setScope('cycle');
          }}
        >
          Reset filters
        </Button>
      )}
      <ViewSettings />
    </div>
  );
}

/**
 * P0 orientation: where you are, which month the KPIs show, which scope the release counts, and the
 * view settings. Period and Scope are independent filters, each labelled with what it changes.
 */
export function OverviewHeader({
  cards,
  className,
  title = 'Overview',
}: {
  cards: readonly StateCard[];
  className?: string;
  title?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-3', className)}>
      <PageTitle>{title}</PageTitle>
      <OverviewControls cards={cards} />
    </header>
  );
}
