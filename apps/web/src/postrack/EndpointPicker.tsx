import { ChevronRight, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  POSTRACK_ENDPOINTS_MAX,
  type PostrackEndpointRef,
  type PostrackFolderNode,
  type PostrackTree,
} from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describeError } from '@/lib/api';
import { usePostrackTree, usePostrackWorkspaces } from '@/lib/postrackApi';
import { cn } from '@/lib/utils';

/** The endpoints picked for one start. `projectId` follows the first pick: its environments go along. */
export interface PostrackPick {
  workspaceId: string | null;
  projectId: string | null;
  endpoints: PostrackEndpointRef[];
  write: boolean;
}

export const EMPTY_PICK: PostrackPick = {
  workspaceId: null,
  projectId: null,
  endpoints: [],
  write: false,
};

const WS_KEY = (relayWs: string) => `relay.postrack.workspace.${relayWs}`;

function rememberedWorkspace(relayWs: string): string | null {
  try {
    return localStorage.getItem(WS_KEY(relayWs));
  } catch {
    return null;
  }
}

function rememberWorkspace(relayWs: string, id: string): void {
  try {
    localStorage.setItem(WS_KEY(relayWs), id);
  } catch {
    /* private window: the picker just asks again */
  }
}

interface Row {
  e: PostrackEndpointRef;
  projectId: string;
  /** "Project / Collection / Folder". */
  where: string;
}

function rows(tree: PostrackTree): Row[] {
  const out: Row[] = [];
  const walk = (n: PostrackFolderNode, projectId: string, where: string) => {
    for (const e of n.endpoints) out.push({ e, projectId, where });
    for (const f of n.folders) walk(f, projectId, `${where} / ${f.name}`);
  };
  for (const p of tree.projects)
    for (const c of p.collections) walk(c, p.id, `${p.name} / ${c.name}`);
  return out;
}

/** HTTP method as a short mark; colour is never the only signal, the word is always there. */
function Method({ m }: { m: string }) {
  return (
    <span className="inline-block w-12 shrink-0 font-mono text-2xs font-semibold text-muted-foreground uppercase">
      {m.slice(0, 6)}
    </span>
  );
}

/**
 * Picks the Postrack endpoints a card works with: a workspace (remembered per Relay workspace), then a search over all
 * its endpoints by name, URL or folder. The agent gets each picked one in full, plus the project's environments.
 */
export function EndpointPicker({
  relayWorkspaceId,
  value,
  onChange,
  disabled,
}: {
  relayWorkspaceId: string;
  value: PostrackPick;
  onChange: (v: PostrackPick) => void;
  disabled?: boolean;
}) {
  const workspaces = usePostrackWorkspaces(true);
  const list = workspaces.data?.items;
  const wsId = value.workspaceId;
  const tree = usePostrackTree(wsId);
  const [q, setQ] = useState('');

  // First open: the workspace used last time with this Relay workspace, else the only one there is.
  useEffect(() => {
    if (wsId || !list || list.length === 0) return;
    const saved = rememberedWorkspace(relayWorkspaceId);
    const pick = list.find((w) => w.id === saved) ?? (list.length === 1 ? list[0] : undefined);
    if (pick) onChange({ ...value, workspaceId: pick.id });
  }, [list, wsId, relayWorkspaceId, onChange, value]);

  const all = useMemo(() => (tree.data ? rows(tree.data) : []), [tree.data]);
  const picked = new Set(value.endpoints.map((e) => e.id));
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all.slice(0, 50);
    return all
      .filter((r) => {
        const hay = `${r.e.method} ${r.e.name} ${r.e.url} ${r.where}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 50);
  }, [all, q]);
  const full = value.endpoints.length >= POSTRACK_ENDPOINTS_MAX;

  const toggle = (r: Row) => {
    if (picked.has(r.e.id)) {
      const endpoints = value.endpoints.filter((e) => e.id !== r.e.id);
      onChange({ ...value, endpoints, projectId: endpoints.length ? value.projectId : null });
    } else if (!full) {
      onChange({
        ...value,
        endpoints: [...value.endpoints, r.e],
        projectId: value.projectId ?? r.projectId,
      });
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Select
          aria-label="Postrack workspace"
          value={wsId ?? ''}
          disabled={disabled || !list}
          onChange={(e) => {
            rememberWorkspace(relayWorkspaceId, e.target.value);
            onChange({ ...EMPTY_PICK, write: value.write, workspaceId: e.target.value || null });
          }}
          className="min-w-0 flex-1"
        >
          <option value="">
            {workspaces.isPending ? 'Loading workspaces…' : 'Pick a workspace'}
          </option>
          {(list ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Read the endpoints again"
          title="Read the endpoints again"
          disabled={disabled || !wsId || tree.isFetching}
          onClick={() => void tree.refetch()}
        >
          <RefreshCw className={cn(tree.isFetching && 'motion-safe:animate-spin')} aria-hidden />
        </Button>
      </div>

      {value.endpoints.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Picked endpoints">
          {value.endpoints.map((e) => (
            <li
              key={e.id}
              className="flex max-w-full items-center gap-1 rounded-control border border-hairline py-0.5 pr-0.5 pl-2"
            >
              <span className="font-mono text-2xs font-semibold uppercase">{e.method}</span>
              <span className="min-w-0 truncate text-xs">{e.name}</span>
              <button
                type="button"
                aria-label={`Remove ${e.name}`}
                disabled={disabled}
                className="rounded-control p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                onClick={() => toggle({ e, projectId: value.projectId ?? '', where: '' })}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {wsId && (
        <>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={q}
              disabled={disabled}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, URL or folder…"
              aria-label="Search Postrack endpoints"
              className="pl-8 text-sm"
            />
          </div>
          <div className="max-h-52 overflow-y-auto rounded-surface border border-hairline">
            {tree.isPending ? (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> Reading the
                endpoints…
              </p>
            ) : tree.error ? (
              <p className="px-3 py-2 text-xs text-destructive">{describeError(tree.error)}</p>
            ) : hits.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {all.length === 0 ? 'This workspace has no endpoints.' : 'No endpoint matches.'}
              </p>
            ) : (
              <ul>
                {hits.map((r) => {
                  const on = picked.has(r.e.id);
                  return (
                    <li key={r.e.id} className="border-t border-hairline first:border-t-0">
                      <label
                        className={cn(
                          'flex cursor-pointer items-start gap-2 px-3 py-1.5',
                          on ? 'bg-accent/50' : 'hover:bg-accent/30',
                          !on && full && 'cursor-not-allowed opacity-60',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={on}
                          disabled={disabled || (!on && full)}
                          onChange={() => toggle(r)}
                        />
                        <Method m={r.e.method} />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-xs font-medium">{r.e.name}</span>
                          <span className="truncate font-mono text-2xs text-muted-foreground">
                            {r.e.url}
                          </span>
                          <span className="flex items-center gap-0.5 truncate text-2xs text-muted-foreground">
                            <ChevronRight className="size-3 shrink-0" aria-hidden />
                            {r.where}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {all.length > hits.length && (
            <p className="text-2xs text-muted-foreground">
              Showing {hits.length} of {all.length}. Search to narrow it down.
            </p>
          )}
          {full && (
            <p className="text-2xs text-muted-foreground">
              {POSTRACK_ENDPOINTS_MAX} endpoints at most. The agent can look up others itself.
            </p>
          )}
        </>
      )}
      {workspaces.error && (
        <p className="text-xs text-destructive">{describeError(workspaces.error)}</p>
      )}
    </div>
  );
}
