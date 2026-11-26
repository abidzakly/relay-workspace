import { Bot } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { cn } from '@/lib/utils';
import { sessionHref, sessionStateLabel, useMrSessions } from '@/lib/mrSessions';

/**
 * "Agent · working": the Cockpit session already working on this MR, one tap away, with a way back here. Hidden when
 * no session works on the MR.
 */
export function MrSessionLink({
  repo,
  iid,
  className,
}: {
  repo: string;
  iid: number;
  className?: string;
}) {
  const { pathname, search } = useLocation();
  const s = useMrSessions(repo, iid)[0];
  if (!s) return null;
  const state = sessionStateLabel(s);
  return (
    <Link
      to={sessionHref(s, `${pathname}${search}`)}
      aria-label={`Open the agent session on this MR (${state})`}
      title={`Open the agent session on this MR in the Cockpit (${state})`}
      className={cn(
        'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-hairline px-3 text-sm font-medium transition-[background-color,transform] duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.97]',
        className,
      )}
    >
      <span className="relative">
        <Bot className="size-4" aria-hidden />
        <span
          aria-hidden
          className={cn(
            'absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background',
            s.waiting ? 'bg-primary' : s.state === 'running' ? 'bg-moss' : 'bg-muted-foreground',
          )}
        />
      </span>
      <span className="hidden sm:inline">Agent · {state}</span>
    </Link>
  );
}
