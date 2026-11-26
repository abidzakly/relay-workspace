import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  DoorOpen,
  ExternalLink,
  Flag,
  Headset,
  MapPin,
  Undo2,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Meeting, MeetingPresence } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { useDismissMeeting, useSetMeetingPresence } from '@/lib/calendarApi';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { timeFmt, type Row } from './meetingView';

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

/** Opens the meeting link; joining a live or soon meeting marks it joined (and takes it off the floating alert). */
export function useJoin(m: Row) {
  const presence = useSetMeetingPresence();
  const link = m.joinUrl ?? m.htmlLink;
  return () => {
    if (!link) return;
    window.open(link, '_blank', 'noopener,noreferrer');
    if (!m.presence && (m.phase === 'live' || m.phase === 'soon'))
      presence.mutate({ id: m.id, status: 'joined' });
  };
}

// ───────────────────────────── where: online / onsite ─────────────────────────────

const PROVIDER: Record<NonNullable<Meeting['provider']>, string> = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Teams',
  other: 'Video call',
};

/** A search for the place in Google Maps (only `https`, the place is plain text from the invitation). */
const mapsUrl = (place: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

/**
 * Where the meeting happens, so you know whether to open a link or walk to a room. Online reads in violet ink (it is
 * a link away), onsite in the paper's own ink with a pin (it is a place). Hybrid shows both; unknown shows nothing.
 */
export function ModeChip({
  m,
  withPlace = true,
  className,
}: {
  m: Pick<Meeting, 'mode' | 'place' | 'provider'>;
  /** Show the room / address next to the onsite chip. */
  withPlace?: boolean;
  className?: string;
}) {
  if (m.mode === 'unknown') return null;
  const online = m.mode === 'online' || m.mode === 'hybrid';
  const onsite = m.mode === 'onsite' || m.mode === 'hybrid';
  return (
    <span className={cn('inline-flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      {online ? (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emphasis/25 bg-emphasis/[0.07] px-2 py-0.5 text-xs text-emphasis"
          title={m.mode === 'hybrid' ? 'Hybrid: a call link and a room' : 'Online: a call link'}
        >
          <Video className="size-3" aria-hidden />
          {m.mode === 'hybrid' ? 'Hybrid' : 'Online'}
          {m.provider && m.provider !== 'other' ? (
            <span className="text-emphasis/70">· {PROVIDER[m.provider]}</span>
          ) : null}
        </span>
      ) : null}
      {onsite ? (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-full border border-hairline bg-foreground/[0.04] px-2 py-0.5 text-xs text-foreground"
          title={m.place ?? 'Onsite'}
        >
          <MapPin className="size-3 shrink-0" aria-hidden />
          {m.mode === 'onsite' ? <span className="shrink-0">Onsite</span> : null}
          {withPlace && m.place ? (
            <a
              href={mapsUrl(m.place)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'min-w-0 truncate underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none',
                m.mode === 'onsite' ? 'text-muted-foreground' : undefined,
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {m.mode === 'onsite' ? `· ${m.place}` : m.place}
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

// ───────────────────────────── what happened: joined / here / ended ─────────────────────────────

const PRESENCE: Record<MeetingPresence, { label: string; done: string; icon: LucideIcon }> = {
  joined: { label: 'Joined', done: 'Joined', icon: Headset },
  here: { label: 'I’m here', done: 'In the room', icon: DoorOpen },
  ended: { label: 'Ended', done: 'Ended', icon: Flag },
};

/** Which marks fit a meeting: the call for online, the room for onsite, both when hybrid or unknown. */
function presenceChoices(m: Pick<Meeting, 'mode'>): MeetingPresence[] {
  if (m.mode === 'online') return ['joined', 'ended'];
  if (m.mode === 'onsite') return ['here', 'ended'];
  return ['joined', 'here', 'ended'];
}

/**
 * Tell Relay what happened: in the call, in the room, or the meeting is over already. One segmented control; the
 * chosen mark fills, tapping it again clears it. Any mark takes the meeting off the floating alert.
 */
export function PresenceActions({
  m,
  compact = false,
  wideLabels = false,
  className,
}: {
  m: Row;
  /** Icons only (labels stay as tooltips and for screen readers). */
  compact?: boolean;
  /** Labels from `sm` up only; icons alone on a phone, where a row has no room for three words. */
  wideLabels?: boolean;
  className?: string;
}) {
  const set = useSetMeetingPresence();
  const current = m.presence?.status ?? null;
  return (
    <div
      role="group"
      aria-label="What happened"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full border border-hairline bg-card/70 p-0.5',
        className,
      )}
    >
      {presenceChoices(m).map((status) => {
        const on = current === status;
        const { label, icon: Icon } = PRESENCE[status];
        const ended = status === 'ended';
        return (
          <motion.button
            key={status}
            type="button"
            aria-pressed={on}
            title={on ? `${label}: tap to undo` : label}
            disabled={set.isPending}
            whileTap={{ scale: 0.94, transition: SPRING.press }}
            onClick={() => set.mutate({ id: m.id, status: on ? null : status })}
            className={cn(
              'relative isolate inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default',
              compact
                ? 'w-7 justify-center'
                : wideLabels
                  ? 'w-7 justify-center sm:w-auto sm:px-2.5'
                  : 'px-2.5',
              on
                ? 'text-background'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
            )}
          >
            {on ? (
              <motion.span
                layoutId={`presence-${m.id}`}
                transition={SPRING.settle}
                aria-hidden
                className={cn(
                  'absolute inset-0 -z-10 rounded-full',
                  ended ? 'bg-foreground/80' : 'bg-success',
                )}
              />
            ) : null}
            <Icon className="relative size-3.5" aria-hidden />
            <span className={cn('relative', compact && 'sr-only', wideLabels && 'max-sm:sr-only')}>
              {label}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}

/** The stamp once something is marked: "Joined 10:02", "In the room 10:01", "Ended 10:40". */
export function PresenceBadge({
  m,
  className,
}: {
  m: Pick<Meeting, 'presence'>;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {m.presence ? (
        <motion.span
          key={m.presence.status}
          initial={{ opacity: 0, scale: 0.6, filter: 'blur(3px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={SPRING.wobble}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
            m.presence.status === 'ended' ? 'text-muted-foreground' : 'text-success',
            className,
          )}
        >
          <span
            aria-hidden
            className={cn(
              'grid size-4 place-items-center rounded-full',
              m.presence.status === 'ended'
                ? 'bg-foreground/10'
                : 'bg-success text-background shadow-[0_2px_8px_-3px_var(--success)]',
            )}
          >
            <Check className="size-2.5" strokeWidth={3} />
          </span>
          {PRESENCE[m.presence.status].done}
          <span className="font-mono tabular-nums opacity-75">{timeFmt.format(m.presence.at)}</span>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/** Marks make sense from just before the start until the end (and for the next meeting today, to say it ended). */
export function canMark(m: Row): boolean {
  return m.phase === 'live' || m.phase === 'soon' || m.presence !== null;
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
