import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { LAND, WIND_UP } from '@/lib/motion/patterns';
import { SPRING } from '@/lib/motion/presets';
import type { Reward } from '@/lib/reward/engine';

/** What a reward looks like. Its own chunk: most visits never show one. `RewardLayer` decides what plays and when. */

/** Light shards: thin slivers of ink and dream violet, like light breaking off a crystal. */
const SHARD_COLOURS = ['bg-foreground', 'bg-terracotta', 'bg-foreground/50', 'bg-emphasis'];

function Streamers({ count }: { count: number }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        return (
          <motion.span
            key={i}
            className={`absolute top-1/2 left-1/2 h-4 w-px ${SHARD_COLOURS[i % SHARD_COLOURS.length]}`}
            initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
            animate={{
              x: Math.cos(angle) * 220,
              y: Math.sin(angle) * 150 + 60,
              rotate: 200 + i * 37,
              opacity: 0,
            }}
            transition={{ ...SPRING.windup, opacity: { duration: 1.6 } }}
          />
        );
      })}
    </div>
  );
}

/** `+N XP` flying from the lower middle of the screen into the chip. With reduced motion, the same words, still. */
function PopScene({
  reward,
  reduced,
  holdMs,
}: {
  reward: Reward;
  reduced: boolean;
  holdMs: number;
}) {
  const [target] = useState(() => {
    // The HUD's chip is still mounted, faded out, while a page is open.
    const chip = [...document.querySelectorAll<HTMLElement>('[data-xp-chip]')].find(
      (el) =>
        typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkOpacity: true }),
    );
    const box = chip?.getBoundingClientRect();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  });
  const label = (
    <span className="rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold tracking-[0.04em] text-primary-foreground uppercase shadow-lift">
      {reward.title}
    </span>
  );
  if (reduced || !target) {
    return (
      <motion.div
        variants={LAND}
        initial="hidden"
        animate="shown"
        exit="gone"
        className="fixed inset-x-0 bottom-24 flex justify-center"
      >
        {label}
      </motion.div>
    );
  }
  const start = { x: window.innerWidth / 2, y: window.innerHeight * 0.72 };
  return (
    <motion.div
      className="fixed top-0 left-0 -translate-1/2"
      initial={{ x: start.x, y: start.y, scale: 0.8, opacity: 0 }}
      animate={{
        x: [start.x, start.x, target.x],
        y: [start.y, start.y - 16, target.y],
        scale: [0.8, 1, 0.5],
        opacity: [0, 1, 0],
      }}
      transition={{ duration: holdMs / 1000, times: [0, 0.3, 1] }}
    >
      {label}
    </motion.div>
  );
}

/** The title as poster type, with its last word in the serif italic: "Merge *confirmed*". */
function PosterTitle({ title }: { title: string }) {
  const words = title.trim().split(/\s+/);
  const last = words.length > 1 ? words.pop() : null;
  return (
    <>
      {words.join(' ')}
      {last && (
        <>
          {' '}
          <span className="type-accent font-normal normal-case">{last}</span>
        </>
      )}
    </>
  );
}

function WinCard({ reward, large }: { reward: Reward; large: boolean }) {
  return (
    <motion.div
      variants={WIND_UP}
      initial="hidden"
      animate="shown"
      exit="gone"
      className={
        large
          ? 'relative grid max-w-3xl justify-items-center gap-4 px-6 text-center'
          : 'relative grid max-w-sm justify-items-start gap-2 rounded-sheet border border-hairline bg-popover px-6 py-5 text-popover-foreground shadow-float'
      }
    >
      <p className="type-micro text-muted-foreground">{large ? 'A big win' : 'A win'}</p>
      <p className={large ? 'type-display' : 'type-headline text-3xl'}>
        <PosterTitle title={reward.title ?? ''} />
      </p>
      {reward.detail && <p className="text-sm text-muted-foreground">{reward.detail}</p>}
    </motion.div>
  );
}

function Scene({
  reward,
  reduced,
  popHoldMs,
  onSkip,
}: {
  reward: Reward;
  reduced: boolean;
  popHoldMs: number;
  onSkip: () => void;
}) {
  if (reward.level === 'pop') {
    return <PopScene reward={reward} reduced={reduced} holdMs={popHoldMs} />;
  }
  if (reward.level === 'burst') {
    return (
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center p-4">
        {!reduced && <Streamers count={18} />}
        <WinCard reward={reward} large={false} />
      </div>
    );
  }
  // An event: the whole screen, skippable. It does not take focus from what the user was doing.
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="dark fixed inset-0 flex flex-col items-center justify-center gap-8 bg-background/95 p-4 text-foreground"
      onClick={onSkip}
    >
      {!reduced && <Streamers count={36} />}
      <WinCard reward={reward} large />
      <Button variant="outline" size="sm" onClick={onSkip}>
        Continue
      </Button>
    </motion.div>
  );
}

export interface RewardStageProps {
  current: Reward | null;
  reduced: boolean;
  popHoldMs: number;
  onSkip: () => void;
}

/** The reward on screen now, if any. Stays mounted between rewards so the last one can play its exit. */
export function RewardStage({ current, reduced, popHoldMs, onSkip }: RewardStageProps) {
  return (
    <AnimatePresence>
      {current && (
        <div
          key={current.key}
          className={current.level === 'event' ? 'pointer-events-auto' : undefined}
        >
          <Scene reward={current} reduced={reduced} popHoldMs={popHoldMs} onSkip={onSkip} />
        </div>
      )}
    </AnimatePresence>
  );
}
