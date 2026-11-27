import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationMode } from '@relay/shared';
import type { DocItem } from '@/lib/conversation';
import type { SessionView } from '@/lib/sessionApi';
import { cn } from '@/lib/utils';

export const PHASES = ['plan', 'approve', 'work', 'review'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Where an agent session stands on Plan → Approve → Work → Review, from what the Cockpit already knows: the latest
 * plan and its answer, whether the agent is running, and the turn's unreviewed changes. `done` counts finished
 * steps; `now` is the step in progress, or null when nothing is (your turn, paused, ended). `planned` is false when
 * the agent never brought a plan (Allow everything): Plan and Approve then read as skipped, not done.
 */
export function phaseOf(
  s: SessionView,
  items: readonly DocItem[],
  mode: ConversationMode,
): { now: Phase | null; done: number; needsYou: boolean; planned: boolean } {
  let plan: Extract<DocItem, { kind: 'ask' }>['ask'] | null = null;
  for (let i = items.length - 1; i >= 0 && !plan; i--) {
    const it = items[i]!;
    if (it.kind === 'ask' && it.ask.ask === 'plan') plan = it.ask;
  }
  const approved = plan?.outcome === 'approved';
  const running = s.state === 'running';
  const unreviewed = !!s.turn && !s.turn.reviewed && (s.turn.files ?? 0) > 0;
  if (s.state === 'exited')
    return {
      now: null,
      done: approved ? (unreviewed ? 3 : 4) : 0,
      needsYou: false,
      planned: !!plan,
    };
  if (plan && !plan.outcome) return { now: 'approve', done: 1, needsYou: true, planned: !!plan };
  if (running && !approved && mode === 'plan')
    return { now: 'plan', done: 0, needsYou: false, planned: !!plan };
  if (running) return { now: 'work', done: 2, needsYou: false, planned: !!plan };
  if (unreviewed) return { now: 'review', done: 3, needsYou: true, planned: !!plan };
  return { now: null, done: approved ? 4 : 0, needsYou: false, planned: !!plan };
}

/** The four steps as a quiet track: moss when done, ink with a ring where the agent is now. */
export function PhaseTrack({
  now,
  done,
  planned = true,
}: {
  now: Phase | null;
  done: number;
  planned?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ol
      aria-label={t('cockpit.phase.label')}
      className="flex min-w-0 items-center gap-1 sm:gap-1.5"
    >
      {PHASES.map((p, i) => {
        const skipped = !planned && i < 2;
        const state = p === now ? 'now' : i < done && !skipped ? 'done' : 'todo';
        return (
          <li
            key={p}
            aria-current={state === 'now' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 text-2xs font-semibold tracking-wide uppercase',
              state === 'done' && 'text-success',
              state === 'now' && 'text-foreground',
              state === 'todo' && 'text-muted-foreground',
              skipped && 'line-through decoration-muted-foreground/60',
            )}
          >
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  'h-px w-3 sm:w-5',
                  i <= done && !(skipped || (!planned && i === 2)) ? 'bg-moss' : 'bg-border',
                )}
              />
            )}
            <span
              aria-hidden
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded-full border',
                state === 'done' && 'border-moss bg-moss text-white',
                state === 'now' &&
                  'border-foreground bg-card ring-3 ring-moss/30 motion-safe:animate-pulse',
                state === 'todo' && 'border-border bg-card',
              )}
            >
              {state === 'done' && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            <span className={cn(state !== 'now' && 'hidden sm:inline')}>
              {t(`cockpit.phase.${p}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** How far along the track the meter under the sheet header reaches (0 to 1). */
export function phaseProgress(now: Phase | null, done: number): number {
  return Math.min(1, (done + (now ? 0.5 : 0)) / PHASES.length);
}
