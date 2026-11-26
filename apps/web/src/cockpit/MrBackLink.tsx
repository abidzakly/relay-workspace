import { ArrowLeft } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { isMrReturnPath } from '@/lib/mrSessions';
import type { SessionView } from '@/lib/sessionApi';

/**
 * "Back to MR !12": a session started from an MR goes back to it. The exact page it was opened from (`?returnTo=`,
 * MR pages only) when this is that session, else the MR's detail.
 */
export function MrBackLink({ s }: { s: SessionView }) {
  const [params] = useSearchParams();
  if (!s.mr) return null;
  const fromUrl = params.get('session') === s.id ? params.get('returnTo') : null;
  const to = isMrReturnPath(fromUrl)
    ? fromUrl
    : `/mrs/${encodeURIComponent(s.mr.repoId)}/${s.mr.iid}`;
  return (
    <Link
      to={to}
      title={s.mr.title ? `Back to MR !${s.mr.iid}: ${s.mr.title}` : `Back to MR !${s.mr.iid}`}
      className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Back to MR !{s.mr.iid}</span>
    </Link>
  );
}
