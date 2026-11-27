import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { isBenchPath } from '@/lib/benchReturn';

/**
 * "Back to test device": a session sent from the Test Bench goes back to that branch's bench. Same look as
 * `MrBackLink`; nothing when the session did not come from the bench.
 */
export function BenchBackLink({ to }: { to?: string | null }) {
  if (!isBenchPath(to)) return null;
  return (
    <Link
      to={to}
      title="Back to test device"
      className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">Back to test device</span>
    </Link>
  );
}
