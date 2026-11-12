import { Link } from 'react-router';
import { Radar, Webhook } from 'lucide-react';
import {
  reviewSourceText,
  type ReviewDeskItem,
  type ReviewLane,
  type ReviewReason,
  type ReviewSource,
} from '@relay/shared';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { TimeAgo } from '@/components/TimeAgo';
import { useSnooze } from '@/lib/reviewsApi';

export const LANE_INFO: Record<ReviewLane, { label: string; hint: string }> = {
  needs_you: {
    label: 'Needs you',
    hint: 'Asked for your review and not looked at yet, or asked again since you looked.',
  },
  changed: {
    label: 'Changed since you looked',
    hint: 'New commits arrived after you marked it reviewed. Read only what changed.',
  },
  mentioned: { label: 'Mentioned', hint: 'You were mentioned; nobody asked for a review.' },
  waiting: {
    label: 'Waiting on the author',
    hint: 'You reviewed this version, or it is still a draft.',
  },
  approved: { label: 'Approved', hint: 'You approved this version.' },
  snoozed: { label: 'Snoozed', hint: 'Hidden until the time you chose.' },
};

const REASON_LABEL: Record<ReviewReason, string> = {
  reviewer: 'Reviewer',
  review_requested: 'Review asked',
  directly_addressed: 'Addressed to you',
  mentioned: 'Mentioned',
  approval_required: 'Approval needed',
  assigned: 'Assigned',
};

export const reasonLabel = (r: ReviewReason) => REASON_LABEL[r];

/** Where to fix a polled project: its repo's webhook, or the Reviews webhook. */
export function sourceFixLink(s: ReviewSource): { to: string; label: string } {
  return s.repoId
    ? { to: '/settings#webhooks', label: 'Check webhook health' }
    : { to: '/settings#reviewer', label: 'Add the Reviews webhook' };
}

/**
 * How an item reaches the desk. Live = a webhook brings changes at once. Polled = no webhook reaches its project, so
 * it is seen by the once-a-minute check; the mark is a warning and always says why, in words.
 */
export function SourceMark({
  item,
  detailed = false,
}: {
  item: ReviewDeskItem;
  detailed?: boolean;
}) {
  const s = item.source;
  if (s.via === 'webhook') {
    return (
      <Badge variant="outline" title="Changes arrive instantly through a webhook.">
        <Webhook aria-hidden /> Live
      </Badge>
    );
  }
  const why = reviewSourceText(s, item.projectPath);
  if (!detailed) {
    return (
      <Badge variant="warning" title={why}>
        <Radar aria-hidden /> Polled
        <span className="sr-only">. {why}</span>
      </Badge>
    );
  }
  const fix = sourceFixLink(s);
  return (
    <details className="group text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Badge variant="warning">
          <Radar aria-hidden /> Polled
        </Badge>
        <span className="text-muted-foreground underline-offset-2 group-open:underline">Why?</span>
      </summary>
      <p className="mt-2 max-w-prose text-muted-foreground">
        {why}{' '}
        {s.lastDeliveryAt ? (
          <>
            Last webhook <TimeAgo at={s.lastDeliveryAt} />.{' '}
          </>
        ) : null}
        <Link to={fix.to} className="text-foreground underline underline-offset-2">
          {fix.label}
        </Link>
      </p>
    </details>
  );
}

const HOUR = 3_600_000;

function at9(daysAhead: number): number {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function nextMonday9(): number {
  const d = new Date();
  const add = (8 - d.getDay()) % 7 || 7;
  return at9(add);
}

/** Snooze: hide an item until later. Local to this machine; GitLab is not told. */
export function SnoozeSelect({ item }: { item: ReviewDeskItem }) {
  const snooze = useSnooze();
  const snoozed = item.snoozedUntil !== null;
  return (
    <Select
      aria-label={snoozed ? 'Snoozed: change or wake' : 'Snooze'}
      value=""
      disabled={snooze.isPending}
      className="h-8 w-auto min-w-28 text-xs"
      onChange={(e) => {
        const v = e.target.value;
        const until =
          v === 'wake'
            ? null
            : v === '1h'
              ? Date.now() + HOUR
              : v === '4h'
                ? Date.now() + 4 * HOUR
                : v === 'tomorrow'
                  ? at9(1)
                  : v === 'monday'
                    ? nextMonday9()
                    : undefined;
        if (until !== undefined) snooze.mutate({ key: item.key, until });
      }}
    >
      <option value="" disabled>
        {snoozed ? 'Snoozed' : 'Snooze'}
      </option>
      {snoozed && <option value="wake">Wake now</option>}
      <option value="1h">For an hour</option>
      <option value="4h">For 4 hours</option>
      <option value="tomorrow">Until tomorrow 9:00</option>
      <option value="monday">Until Monday 9:00</option>
    </Select>
  );
}
