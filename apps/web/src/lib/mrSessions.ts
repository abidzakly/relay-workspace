import { useMemo } from 'react';
import { useSessions, type SessionView } from './sessionApi';

/** In-app MR pages only: `?returnTo=` must never send the Cockpit anywhere else. */
export const isMrReturnPath = (p: string | null | undefined): p is string =>
  !!p && /^\/(mrs|review)\/[^\s\\]*$/.test(p) && !p.startsWith('//');

/** The MR's agent sessions (started from its threads or "Make more changes"), the newest live one first. */
export function useMrSessions(repo: string, iid: number): SessionView[] {
  const sessions = useSessions().data;
  return useMemo(
    () =>
      (sessions ?? [])
        .filter(
          (s) =>
            s.mr?.repoId === repo &&
            s.mr.iid === iid &&
            (s.state !== 'exited' || s.restorable === true),
        )
        .sort((a, b) => b.startedAt - a.startedAt),
    [sessions, repo, iid],
  );
}

/** The Cockpit view of one session, with a way back to the MR page it was opened from. */
export function sessionHref(s: { id: string; workspaceId: string }, returnTo?: string): string {
  const q = new URLSearchParams({ ws: s.workspaceId, session: s.id, tab: 'agent' });
  if (isMrReturnPath(returnTo)) q.set('returnTo', returnTo);
  return `/cockpit?${q.toString()}`;
}

/** One-word state of an agent session for a chip. */
export function sessionStateLabel(s: SessionView): string {
  if (s.state === 'exited') return 'paused';
  if (s.waiting) return 'needs you';
  return s.state === 'running' ? 'working' : 'idle';
}
