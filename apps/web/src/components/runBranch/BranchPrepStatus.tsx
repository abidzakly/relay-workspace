import { GitBranch, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import './runBranch.css';

/** Seconds since mount, while shown. */
function useElapsed(): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setS((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return s;
}

/** Shown while the workspace is being put on the branch: fetch from origin, then switch. A slow fetch hints at the VPN. */
export function BranchPrepStatus({ branch }: { branch: string }) {
  const s = useElapsed();
  return (
    <p className="rb-prep" role="status" aria-live="polite">
      <span className="rb-prep-step" data-state="active">
        <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />
        Fetching origin
      </span>
      <span className="rb-prep-step" data-state="todo">
        <GitBranch aria-hidden className="size-3.5" />
        Switching to <span className="max-w-48 truncate font-mono">{branch}</span>
      </span>
      {s >= 8 && <span className="text-warning">Taking a while — is the VPN on?</span>}
    </p>
  );
}
