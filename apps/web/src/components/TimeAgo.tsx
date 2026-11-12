import { formatAgo } from '@relay/shared';
import { useNow } from '@/lib/useNow';

/** "3h ago" with the absolute local time on hover (GitLab-like). */
export function TimeAgo({ at, className }: { at: number | null | undefined; className?: string }) {
  const now = useNow();
  if (at == null) return <span className={className}>—</span>;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={new Date(at).toLocaleString()}
      className={className}
    >
      {formatAgo(now - at)}
    </time>
  );
}
