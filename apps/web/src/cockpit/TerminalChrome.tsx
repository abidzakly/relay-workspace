import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { CockpitSession } from '@relay/shared';
import type { TerminalMood } from '@/components/term/Terminal';
import { cn } from '@/lib/utils';
import { helperState } from './Helper';

/**
 * The agent terminal's chrome (playful by the user's choice, 2026-11-11): a cut crystal that hums while the agent
 * works, bobs when it waits for you, sparkles when it is done and cracks when it fails; a state line with one italic
 * accent word; and a constellation that draws itself over the sheet when a run finishes cleanly. Everything rests
 * under reduced motion, and the state is always also a word.
 */

export function terminalMood(
  s: Pick<CockpitSession, 'state' | 'waiting' | 'exitCode' | 'lastOutputAt'>,
): TerminalMood {
  switch (helperState(s)) {
    case 'start':
      return 'start';
    case 'working':
      return 'working';
    case 'needs-you':
      return 'waiting';
    case 'finished':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

const WORDS: Record<TerminalMood, { lead: string; accent: string; tail?: string }> = {
  start: { lead: 'Waking the', accent: 'agent' },
  working: { lead: 'Agent is', accent: 'working' },
  waiting: { lead: 'Your', accent: 'turn' },
  idle: { lead: 'Taking a', accent: 'breath' },
  done: { lead: 'All', accent: 'done' },
  failed: { lead: 'It', accent: 'stumbled' },
};

const TINT: Record<TerminalMood, string> = {
  start: 'text-muted-foreground',
  working: 'text-moss',
  waiting: 'text-terracotta',
  idle: 'text-muted-foreground',
  done: 'text-moss',
  failed: 'text-destructive',
};

export function MoodLine({ mood, detail }: { mood: TerminalMood; detail?: string }) {
  const w = WORDS[mood];
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" aria-live="polite">
      <span className="text-sm text-foreground">
        {w.lead} <span className="type-accent">{w.accent}</span>
      </span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  );
}

/** A small cut crystal; its motion is the agent's state. */
export function MoodCrystal({ mood }: { mood: TerminalMood }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-6 shrink-0', TINT[mood])}>
      <g className="mood-crystal" data-mood={mood}>
        <path d="M12 2.5 L19 8.5 L12 21.5 L5 8.5 Z" fill="currentColor" fillOpacity={0.2} />
        <path d="M12 2.5 L19 8.5 H12 Z" fill="currentColor" fillOpacity={0.55} />
        <path
          d="M12 2.5 L19 8.5 L12 21.5 L5 8.5 Z M5 8.5 H19 M12 2.5 V21.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
        {mood === 'failed' && (
          <path
            d="M9 6 L11.5 10 L9.5 13 L12.5 17"
            fill="none"
            className="stroke-background"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        )}
      </g>
      {mood === 'done' && <Sparks />}
    </svg>
  );
}

function Sparks() {
  const still = useReducedMotion();
  const pts = [
    [3, 4],
    [21, 5],
    [20, 18],
    [4, 19],
  ] as const;
  return (
    <g fill="currentColor">
      {pts.map(([x, y], i) => (
        <motion.circle
          key={i}
          cx={x}
          cy={y}
          r={1.1}
          initial={still ? false : { opacity: 0, scale: 0 }}
          animate={{ opacity: [0, 1, 0.6], scale: [0, 1.4, 1] }}
          transition={{ duration: 0.7, delay: 0.08 * i }}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        />
      ))}
    </g>
  );
}

// A small constellation, in a 100 × 60 box over the sheet's top right.
const STARS: [number, number][] = [
  [12, 40],
  [26, 22],
  [44, 30],
  [58, 12],
  [74, 24],
  [88, 8],
  [70, 46],
];
const LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [4, 6],
];

/**
 * Plays once when the run turns `done` (not when one opens already finished). The stars land, the lines draw between
 * them, then it all fades and leaves the text alone.
 */
export function FinishBurst({ mood }: { mood: TerminalMood }) {
  const before = useRef<TerminalMood | null>(null);
  const [play, setPlay] = useState(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (before.current !== null && before.current !== 'done' && mood === 'done')
      setPlay((n) => n + 1);
    before.current = mood;
  }, [mood]);
  useEffect(() => {
    if (play === 0) return;
    const t = setTimeout(() => setPlay(0), 2_400);
    return () => clearTimeout(t);
  }, [play]);

  return (
    <AnimatePresence>
      {play > 0 && !still && (
        <motion.svg
          key={play}
          viewBox="0 0 100 60"
          aria-hidden
          className="pointer-events-none absolute top-3 right-3 z-10 w-48 text-moss"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.6 } }}
        >
          {LINKS.map(([a, b], i) => (
            <motion.line
              key={`l${i}`}
              x1={STARS[a]![0]}
              y1={STARS[a]![1]}
              x2={STARS[b]![0]}
              y2={STARS[b]![1]}
              stroke="currentColor"
              strokeWidth={0.6}
              strokeOpacity={0.7}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, delay: 0.25 + i * 0.12, ease: 'easeOut' }}
            />
          ))}
          {STARS.map(([x, y], i) => (
            <motion.circle
              key={`s${i}`}
              cx={x}
              cy={y}
              r={1.6}
              fill="currentColor"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: [0, 1.8, 1] }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
            />
          ))}
        </motion.svg>
      )}
    </AnimatePresence>
  );
}
