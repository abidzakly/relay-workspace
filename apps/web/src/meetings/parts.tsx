import { motion } from 'motion/react';
import { ExternalLink, Undo2, Video, X } from 'lucide-react';
import type { Meeting } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { useDismissMeeting } from '@/lib/calendarApi';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import type { Row } from './meetingView';

/** Small pieces shared by the Next-up hero, the Horizon lens and the List rows. */

/** `◆ Key` / `Quiet`, with why. Normal meetings show nothing: plain is the default. */
export function PriorityChip({
  meeting,
  withReason = false,
  className,
}: {
  meeting: Pick<Meeting, 'priority' | 'priorityReason'>;
  withReason?: boolean;
  className?: string;
}) {
  if (meeting.priority === 'normal') return null;
  const key = meeting.priority === 'key';
  return (
    <span
      title={meeting.priorityReason ?? undefined}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 type-micro',
          key
            ? 'bg-emphasis text-background shadow-[0_0_14px_-2px_var(--emphasis)]'
            : 'border border-hairline text-muted-foreground',
        )}
      >
        {key ? <span aria-hidden>◆</span> : null}
        {key ? 'Key' : 'Quiet'}
      </span>
      {withReason && meeting.priorityReason ? (
        <span className="truncate text-muted-foreground">{meeting.priorityReason}</span>
      ) : null}
    </span>
  );
}

/** The team tag of a title (`[MDD]`), set in mono like a label on a crate. */
export function TagChip({ tag, className }: { tag: string | null; className?: string }) {
  if (!tag) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-[4px] border border-hairline px-1.5 py-px font-mono text-[10px] tracking-[0.06em] text-muted-foreground uppercase',
        className,
      )}
    >
      {tag}
    </span>
  );
}

/** Opens the meeting link; joining a live or soon meeting also takes it off the floating alert. */
export function useJoin(m: Row) {
  const dismiss = useDismissMeeting();
  const link = m.joinUrl ?? m.htmlLink;
  return () => {
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
    if (!m.dismissed && (m.phase === 'live' || m.phase === 'soon')) dismiss.mutate({ id: m.id });
  };
}

export function JoinButton({
  m,
  prominent,
  size = 'sm',
}: {
  m: Row;
  prominent: boolean;
  size?: 'sm' | 'default';
}) {
  const join = useJoin(m);
  if (!m.joinUrl) return null;
  return (
    <motion.span whileTap={{ scale: 0.96, transition: SPRING.press }} className="inline-flex">
      <Button size={size} variant={prominent ? 'default' : 'outline'} onClick={join}>
        <Video className="size-4" aria-hidden />
        Join
      </Button>
    </motion.span>
  );
}

/** Open in Google Calendar + dismiss/undo the floating alert. */
export function IconActions({ m }: { m: Row }) {
  const dismiss = useDismissMeeting();
  return (
    <>
      {m.htmlLink ? (
        <Button
          size="icon"
          variant="ghost"
          asChild
          aria-label="Open in Google Calendar"
          title="Open in Google Calendar"
        >
          <a href={m.htmlLink} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate({ id: m.id, dismissed: !m.dismissed })}
        aria-label={m.dismissed ? 'Show the alert again' : 'Dismiss the alert'}
        title={m.dismissed ? 'Show the alert again' : 'Dismiss the alert'}
      >
        {m.dismissed ? (
          <Undo2 className="size-4" aria-hidden />
        ) : (
          <X className="size-4" aria-hidden />
        )}
      </Button>
    </>
  );
}

/** A ring that fills as a live meeting runs. */
export function ProgressRing({
  start,
  end,
  now,
  size = 44,
  stroke = 3,
  className,
}: {
  start: number;
  end: number;
  now: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const p = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className={cn('-rotate-90', className)} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={stroke}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--emphasis)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={false}
        animate={{ strokeDashoffset: c * (1 - p) }}
        transition={SPRING.settle}
      />
    </svg>
  );
}

/** The live dot: a solid violet point with a slow ring going out (still when motion is reduced). */
export function LiveDot({ live, className }: { live: boolean; className?: string }) {
  return (
    <span
      className={cn('relative flex size-2.5 shrink-0 items-center justify-center', className)}
      aria-hidden
    >
      {live ? (
        <span className="absolute inset-0 rounded-full bg-emphasis/50 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          'relative size-2 rounded-full',
          live ? 'bg-emphasis' : 'border border-emphasis/70',
        )}
      />
    </span>
  );
}
