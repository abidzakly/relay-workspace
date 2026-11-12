import { GitBranch, History, Layers, PencilLine } from 'lucide-react';
import { Link } from 'react-router';
import type { Workspace } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { useWsStatus } from '@/lib/cockpitApi';
import { deckPath } from '@/lib/deckApi';
import { mrCreatePath } from '@/lib/mrCreateApi';

/** Review tab: decks over local diffs (turn / working / branch) and the way to an MR. */
export function ReviewView({ ws }: { ws: Workspace }) {
  const st = useWsStatus(ws.id);
  const items = [
    {
      icon: History,
      title: 'Last agent turn',
      body: 'Only what the agent changed since the last prompt.',
      to: deckPath({ kind: 'local', workspaceId: ws.id, mode: 'turn' }),
    },
    {
      icon: PencilLine,
      title: 'Uncommitted',
      body: `Working tree vs HEAD${st.data ? ` · ${st.data.dirty.length} file${st.data.dirty.length === 1 ? '' : 's'}` : ''}.`,
      to: deckPath({ kind: 'local', workspaceId: ws.id, mode: 'working' }),
    },
    {
      icon: GitBranch,
      title: `Branch vs ${ws.defaultBase}`,
      body: 'Everything on this card (commits + working tree).',
      to: deckPath({ kind: 'local', workspaceId: ws.id, mode: 'branch', base: ws.defaultBase }),
    },
  ];
  return (
    <div className="grid gap-3">
      {st.data && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <GitBranch className="size-4 text-muted-foreground" />
          <span className="font-mono text-xs">{st.data.branch ?? '(detached)'}</span>
          {st.data.ahead > 0 && <Badge variant="outline">↑{st.data.ahead}</Badge>}
          {st.data.behind > 0 && <Badge variant="warning">↓{st.data.behind}</Badge>}
          {st.data.dirty.length > 0 && (
            <Badge variant="warning">{st.data.dirty.length} changed</Badge>
          )}
        </div>
      )}
      <ul className="grid gap-2">
        {items.map((it) => (
          <li key={it.title}>
            <Link
              to={it.to}
              state={{ from: `/cockpit?ws=${ws.id}&tab=review` }}
              className="flex items-center gap-3 rounded-surface border bg-card p-4 transition-colors hover:bg-accent/50"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary-ink">
                <it.icon className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{it.title}</span>
                <span className="block text-xs text-muted-foreground">{it.body}</span>
              </span>
              <Layers className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
      {ws.repoId && st.data?.branch && st.data.branch !== ws.defaultBase && (
        <Link
          to={mrCreatePath(ws.repoId, st.data.branch)}
          className="text-sm text-primary-ink underline-offset-4 hover:underline"
        >
          Create MR for {st.data.branch} →
        </Link>
      )}
    </div>
  );
}
