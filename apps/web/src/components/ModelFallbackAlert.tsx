import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Settings2, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { create } from 'zustand';
import { agentModelLabel, type AiGeneratedBy } from '@relay/shared';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/workspace/useMedia';

/**
 * "That model is not in your plan": a glass card in the bottom corner when an agent refused the chosen model and the
 * answer (or the session) moved to the default. Raised by `GeneratedBy` for one-shot answers and by the session view
 * for a `model_fallback` event. Each refused model shows once per page load; it stays until dismissed, or 14 s
 * without the pointer on it.
 */

export interface ModelFallback {
  agent: 'claude' | 'cursor';
  from: string;
  to: string;
  reason?: string | undefined;
}

type Shown = ModelFallback & { key: string };

const seen = new Set<string>();

export const useModelFallbackStore = create<{
  items: Shown[];
  push: (f: ModelFallback) => void;
  dismiss: (key: string) => void;
}>((set) => ({
  items: [],
  push: (f) => {
    const key = `${f.agent}:${f.from}`;
    if (seen.has(key)) return;
    seen.add(key);
    set((s) => ({ items: [...s.items, { ...f, key }].slice(-3) }));
  },
  dismiss: (key) => set((s) => ({ items: s.items.filter((x) => x.key !== key) })),
}));

/** Raises the alert for an AI answer that fell back. */
export function notifyGeneratedByFallback(by: AiGeneratedBy): void {
  if (!by.fallbackFrom) return;
  useModelFallbackStore.getState().push({
    agent: by.engine === 'cursor_cli' ? 'cursor' : 'claude',
    from: by.fallbackFrom,
    to: by.model,
  });
}

const AGENT = { claude: 'Claude', cursor: 'Cursor' } as const;
const toLabel = (id: string) =>
  id === 'default' ? 'its default model' : id === 'auto' ? 'Auto' : agentModelLabel(id);

export function ModelFallbackAlert() {
  const items = useModelFallbackStore((s) => s.items);
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 flex w-[min(23rem,calc(100vw-1.5rem))] flex-col items-stretch gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {items.map((f) => (
          <FallbackCard key={f.key} f={f} />
        ))}
      </AnimatePresence>
    </div>
  );
}

const LIFETIME_MS = 14_000;

function FallbackCard({ f }: { f: Shown }) {
  const dismiss = useModelFallbackStore((s) => s.dismiss);
  const reduced = useReducedMotion();
  const [hover, setHover] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (hover) return;
    timer.current = window.setTimeout(() => dismiss(f.key), LIFETIME_MS);
    return () => window.clearTimeout(timer.current);
  }, [hover, dismiss, f.key]);

  return (
    <motion.section
      layout
      role="status"
      aria-label="Model not available"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96, filter: 'blur(4px)' }}
      transition={{ ...SPRING.wobble, layout: SPRING.settle }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={cn(
        'glass pointer-events-auto relative isolate overflow-hidden rounded-[22px] p-4 text-foreground',
        '[--glass-blur:var(--glass-blur-strong)]',
      )}
    >
      {/* A warm wash from the corner: a caution, not an error. */}
      <div
        aria-hidden
        className="absolute -top-16 -left-16 -z-10 size-44 rounded-full bg-warning/25 blur-3xl"
      />
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warning/15 text-warning ring-1 ring-warning/30">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5">{agentModelLabel(f.from)} isn’t available</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {AGENT[f.agent]} {f.reason ? `says it is ${f.reason}` : 'refused this model'}, so it
            switched to <span className="text-foreground">{toLabel(f.to)}</span> and carried on.
          </p>
          <div className="mt-2 flex items-center gap-1.5 text-2xs">
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground line-through decoration-warning/70">
              {agentModelLabel(f.from)}
            </span>
            <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">
              {toLabel(f.to)}
            </span>
          </div>
          <Link
            to="/settings#ai"
            onClick={() => dismiss(f.key)}
            className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            <Settings2 className="size-3.5" aria-hidden />
            Choose another model
          </Link>
        </div>
        <button
          type="button"
          onClick={() => dismiss(f.key)}
          aria-label="Dismiss"
          className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {!reduced && (
        <motion.div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-warning/50"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: hover ? 1 : 0 }}
          transition={hover ? { duration: 0.2 } : { duration: LIFETIME_MS / 1000, ease: 'linear' }}
        />
      )}
    </motion.section>
  );
}
