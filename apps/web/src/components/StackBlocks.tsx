import { CircleDashed, GitMerge, Lock, MapPin } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import type { MrDetail } from '@relay/shared';
import { FADE_RISE } from '@/lib/motion/patterns';
import { SPRING } from '@/lib/motion/presets';
import { useMrInbox } from '@/lib/mrApi';
import { stackWaitLabel } from '@/lib/mrStacks';
import { rememberStacks } from '@/lib/mrStackProgress';
import { cn } from '@/lib/utils';

const STACK_REASONS = new Set(['stack_parent_open', 'stack_unknown']);

/**
 * A stack as toy blocks built from the bottom up, so "parent first" explains itself: only the bottom block can merge,
 * and when it does the others drop down. Blocks only navigate. Merging stays with this MR's gate and confirm dialog.
 */
export function StackBlocks({ d }: { d: MrDetail }) {
  const { mr } = d;
  const { search } = useLocation();
  const inbox = useMrInbox({ repo: mr.repoId, state: 'open', reviewer: '' });
  const stacks = inbox.data?.stacks;

  useEffect(() => {
    if (stacks) rememberStacks(stacks);
  }, [stacks]);

  const stack = stacks?.find((s) => s.groupId === mr.stack?.groupId);
  if (!stack || !mr.stack) return null;

  const reasons = d.approvals.gate.reasons.filter((r) => STACK_REASONS.has(r.code));
  const wait = reasons.length > 0 ? reasons.map((r) => r.message) : [stackWaitLabel(mr)];
  const top = [...stack.nodes].sort((a, b) => b.position - a.position);

  return (
    <section className="grid min-w-0 gap-2" aria-label="Stacked MRs, parent at the bottom">
      <h3 className="text-sm font-semibold">Stack</h3>
      <p className="text-xs text-muted-foreground">
        Merged one at a time from the bottom block up, never squashed.
      </p>
      <LayoutGroup id={`stack-${stack.groupId}`}>
        <ol className="grid min-w-0 gap-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {top.map((node) => {
              const here = node.iid === mr.iid;
              const next = node.position === 1 && node.iid !== null;
              const Mark = node.iid === null ? CircleDashed : next ? GitMerge : Lock;
              const word =
                node.iid === null
                  ? 'No MR yet'
                  : next
                    ? 'Next to merge'
                    : 'Waits for the block below';
              const face = (
                <>
                  <span className="grid size-7 shrink-0 place-items-center rounded-control bg-muted font-mono text-xs tabular-nums">
                    {node.position}
                  </span>
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-mono text-xs">
                      {node.iid !== null && `!${node.iid} `}
                      {node.branch}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Mark aria-hidden className="size-3" />
                        {word}
                      </span>
                      {here && (
                        <span className="inline-flex items-center gap-1 font-medium text-primary-ink">
                          <MapPin aria-hidden className="size-3" />
                          You are here
                        </span>
                      )}
                    </span>
                  </span>
                </>
              );
              const block = cn(
                'flex min-w-0 items-center gap-2 rounded-control border bg-card p-2',
                next && !here ? 'shadow-block-next' : 'shadow-block',
                here && 'border-primary',
                node.iid === null && 'border-dashed',
              );
              return (
                <motion.li
                  key={node.key}
                  layout
                  variants={FADE_RISE}
                  initial="hidden"
                  animate="shown"
                  exit="gone"
                  transition={{ layout: SPRING.wobble }}
                >
                  {node.iid === null || here ? (
                    <div className={block} aria-current={here ? 'true' : undefined}>
                      {face}
                    </div>
                  ) : (
                    <Link
                      to={{ pathname: `/mrs/${mr.repoId}/${node.iid}`, search }}
                      className={cn(
                        block,
                        'tactile outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
                      )}
                    >
                      {face}
                    </Link>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      </LayoutGroup>
      {wait
        .flatMap((line) => (line ? [line] : []))
        .map((line) => (
          <p key={line} className="flex items-start gap-1.5 text-sm [overflow-wrap:anywhere]">
            <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            {line}
          </p>
        ))}
    </section>
  );
}
