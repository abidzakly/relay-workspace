import { Check, Hand, Hammer, type LucideIcon, Moon, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CockpitSession } from '@relay/shared';
import { LAND } from '@/lib/motion/patterns';
import { emit } from '@/lib/reward/engine';
import { cn } from '@/lib/utils';

export type HelperState = 'start' | 'working' | 'needs-you' | 'idle' | 'finished' | 'failed';

/** What a session's helper is doing, from the server's own fields. A kill has no clean exit, so it reads as failed. */
export function helperState(
  s: Pick<CockpitSession, 'state' | 'waiting' | 'exitCode' | 'lastOutputAt' | 'restorable'>,
): HelperState {
  if (s.state === 'exited' && s.restorable) return 'idle';
  if (s.state === 'exited') return s.exitCode === 0 ? 'finished' : 'failed';
  if (s.waiting) return 'needs-you';
  if (s.lastOutputAt === null) return 'start';
  return s.state === 'running' ? 'working' : 'idle';
}

const LOOK: Record<HelperState, { mark: LucideIcon; fill: string }> = {
  start: { mark: Sparkles, fill: 'fill-muted-foreground' },
  working: { mark: Hammer, fill: 'fill-moss' },
  'needs-you': { mark: Hand, fill: 'fill-primary' },
  idle: { mark: Moon, fill: 'fill-muted-foreground' },
  finished: { mark: Check, fill: 'fill-moss' },
  failed: { mark: X, fill: 'fill-destructive' },
};

/** A small helper at their desk. It lands when its state changes, then rests. Its word is never left out. */
export function Helper({
  session,
  showWord = true,
  size = 'sm',
}: {
  session: Pick<CockpitSession, 'state' | 'waiting' | 'exitCode' | 'lastOutputAt'>;
  showWord?: boolean;
  /** `lg`: the figure on its own in the Cockpit's session dock. */
  size?: 'sm' | 'lg';
}) {
  const { t } = useTranslation();
  const state = helperState(session);
  const look = LOOK[state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <motion.svg
        key={state}
        variants={LAND}
        initial="hidden"
        animate="shown"
        viewBox="0 0 16 20"
        aria-hidden
        className={cn('shrink-0', size === 'lg' ? 'h-7 w-6' : 'h-4 w-3.5', look.fill)}
      >
        <circle cx="8" cy="5" r="4" />
        <rect x="3" y="10" width="10" height="9" rx="3" />
        {state === 'needs-you' && <rect x="13" y="2" width="2.5" height="10" rx="1.25" />}
      </motion.svg>
      {size === 'sm' && <look.mark aria-hidden className="size-3 text-muted-foreground" />}
      <span className={cn('text-2xs text-muted-foreground', !showWord && 'sr-only')}>
        {t(`cockpit.helper.${state}`)}
      </span>
    </span>
  );
}

/** A pop when an agent's session is seen finishing cleanly. A failure, a kill or a plain shell earns nothing. */
export function useFinishedSessionReward(
  sessions: readonly Pick<CockpitSession, 'id' | 'kind' | 'title' | 'state' | 'exitCode'>[],
) {
  const last = useRef(new Map<string, CockpitSession['state']>());
  useEffect(() => {
    for (const s of sessions) {
      const before = last.current.get(s.id);
      last.current.set(s.id, s.state);
      const agent = s.kind === 'claude' || s.kind === 'cursor';
      if (!agent || before === undefined || before === 'exited') continue;
      if (s.state !== 'exited' || s.exitCode !== 0) continue;
      emit({
        level: 'pop',
        key: `session:${s.id}:finished`,
        persist: true,
        title: `${s.title} finished`,
      });
    }
  }, [sessions]);
}
