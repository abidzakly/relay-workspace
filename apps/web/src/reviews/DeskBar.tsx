import { Link, useLocation } from 'react-router';
import { Check, GitCompare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { withBack } from '@/lib/reviewApi';
import { useDeskItem, useMarkReviewed } from '@/lib/reviewsApi';
import { LANE_INFO, SnoozeSelect, SourceMark } from './DeskBits';

/**
 * Inside a review of a Reviews project (`~<projectId>`): where this MR sits on the desk, how it arrives (live or
 * polled, and why), "What changed since you looked", and "Mark reviewed" for the version on screen.
 */
export function DeskBar({
  repo,
  iid,
  headSha,
}: {
  repo: string;
  iid: number;
  headSha: string | null;
}) {
  const item = useDeskItem(repo, iid);
  const mark = useMarkReviewed();
  const { pathname, search } = useLocation();
  if (!item) return null;
  const sha = headSha ?? item.headSha;
  const reviewedThis =
    !!item.lastReviewedSha &&
    !!sha &&
    sha.toLowerCase().startsWith(item.lastReviewedSha.toLowerCase().slice(0, 7));
  const since =
    item.lastReviewedSha && sha && !reviewedThis
      ? withBack(
          `/review/${encodeURIComponent(repo)}/compare?${new URLSearchParams({ from: item.lastReviewedSha, to: sha }).toString()}`,
          `${pathname}${search}`,
        )
      : null;
  return (
    <div className="rv-card grid gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="type-micro text-foreground">{LANE_INFO[item.lane].label}</span>
        <span className="text-muted-foreground">{LANE_INFO[item.lane].hint}</span>
      </div>
      <SourceMark item={item} detailed />
      <div className="flex flex-wrap items-center gap-2">
        {since && (
          <Button asChild size="sm" variant="outline">
            <Link to={since}>
              <GitCompare aria-hidden /> What changed since you looked
            </Link>
          </Button>
        )}
        {reviewedThis ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Check className="size-3.5" aria-hidden /> You marked this version reviewed
          </span>
        ) : (
          sha && (
            <Button
              size="sm"
              disabled={mark.isPending}
              onClick={() => mark.mutate({ key: item.key, sha })}
            >
              Mark this version reviewed
            </Button>
          )
        )}
        <SnoozeSelect item={item} />
      </div>
    </div>
  );
}
