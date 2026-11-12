import { type ReactNode } from 'react';
import { Gem } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router';
import type { InboxMr } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { deckPath } from '@/lib/deckApi';
import { SPRING } from '@/lib/motion/presets';
import {
  notificationTitle,
  useMarkNotificationRead,
  useNotifications,
  type NotificationQuery,
} from '@/lib/notificationApi';
import { emit } from '@/lib/reward/engine';

const UNREAD_QUERY: NotificationQuery = {
  filter: 'unread',
  lifecycle: [],
  priority: [],
  category: [],
};

function Offer({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="min-w-0 text-sm">{text}</p>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Nothing is waiting, so the reward is just something to poke. It claims nothing and counts for nothing. */
function AllClear() {
  return (
    <div className="flex items-center gap-3">
      <motion.button
        type="button"
        aria-label="Poke the crystal"
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        whileTap={{ scale: 0.92, rotate: 12 }}
        transition={SPRING.wobble}
        onClick={() => emit({ level: 'tick', key: 'poke:toy', repeatable: true })}
      >
        <Gem className="size-5" strokeWidth={1.5} />
      </motion.button>
      <p className="text-xl font-semibold tracking-[-0.03em] uppercase">
        All <span className="type-accent font-normal">clear</span>
      </p>
    </div>
  );
}

/**
 * One small, real thing to finish, in order: review a first deck card, read a notification.
 * A reward follows only what the server confirmed. None of these award XP, so they stay a tick and never touch the chip.
 */
export function FirstWin({
  jobWaiting,
  jobsSettled,
  inboxItems,
}: {
  /** A next job is showing, so this is not "all clear". */
  jobWaiting: boolean;
  /** Every source behind the next job answered, so an empty list really is empty. */
  jobsSettled: boolean;
  inboxItems: readonly InboxMr[];
}) {
  const notifications = useNotifications(UNREAD_QUERY);
  const markRead = useMarkNotificationRead();

  const review = inboxItems.find((m) => m.action.kind === 'review_requested');
  const unread = notifications.data?.pages[0]?.items[0];

  // "All clear" is a claim, so it needs a clean read of everything it speaks for.
  const clear = !jobWaiting && jobsSettled && !notifications.isPending && !notifications.error;

  let body: ReactNode = null;
  if (review) {
    body = (
      <Offer text={`Your review is waiting on !${review.iid}.`}>
        <Button asChild size="sm">
          <Link to={deckPath({ kind: 'mr', repoId: review.repoId, iid: review.iid })}>
            Open the deck
          </Link>
        </Button>
      </Offer>
    );
  } else if (unread) {
    body = (
      <Offer text={notificationTitle(unread.title)}>
        <Button
          size="sm"
          disabled={markRead.isPending}
          onClick={() =>
            markRead.mutate(unread.id, {
              onSuccess: () =>
                emit({ level: 'tick', key: `first-win:notification:${unread.id}`, persist: true }),
            })
          }
        >
          Mark read
        </Button>
      </Offer>
    );
  } else if (clear) {
    body = <AllClear />;
  }

  return (
    <>
      {(body || markRead.error) && (
        <section
          aria-label="A small win"
          className="flex flex-col gap-2 border-t border-hairline pt-3"
        >
          {body}
          {markRead.error && (
            <p className="text-xs text-destructive">{describeError(markRead.error)}</p>
          )}
        </section>
      )}
    </>
  );
}
