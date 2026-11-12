import { FolderGit2, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceColor } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useAddWorkspace, useRemoveWorkspace, useWorkspaces } from '@/lib/cockpitApi';
import { useRepos } from '@/lib/settingsApi';
import { RepoMark, RepoMarkPicker } from '@/components/RepoMark';
import { ErrorAlert, SectionCard } from './SectionCard';

/**
 * Settings → Workspaces: directories on this computer the cockpit may work in. The host agent
 * validates each path (`git rev-parse`, inside HOST_AGENT_WORKSPACE_ROOTS, default ~/Work).
 */
export function WorkspacesCard() {
  const list = useWorkspaces();
  const repos = useRepos();
  const add = useAddWorkspace();
  const remove = useRemoveWorkspace();
  const [name, setName] = useState('');
  const [absPath, setAbsPath] = useState('');
  const [repoId, setRepoId] = useState('');
  const [base, setBase] = useState('main');
  // Unset = the server picks the next unused pigment.
  const [color, setColor] = useState<WorkspaceColor | undefined>(undefined);

  return (
    <SectionCard
      id="workspaces"
      title="Workspaces"
      description="Repo folders on this computer for the Cockpit (agent, terminal, editor, run app). They must be inside HOST_AGENT_WORKSPACE_ROOTS (default ~/Work)."
    >
      <ul className="grid gap-2">
        {/* Worktrees made by a bulk start are managed in the Cockpit, next to their parent. */}
        {(list.data ?? [])
          .filter((w) => w.kind !== 'worktree')
          .map((w) => (
            <li key={w.id} className="flex min-w-0 items-center gap-3 rounded-lg border p-3">
              <RepoMark color={w.color} size="md" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{w.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground" title={w.absPath}>
                  {w.absPath}
                </p>
                <p className="text-xs text-muted-foreground">
                  {w.repoId ? `repo ${w.repoId}` : 'no repo'} · base {w.defaultBase}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove workspace ${w.name}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(w.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        {list.data?.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FolderGit2 className="size-4" /> No workspaces yet.
          </p>
        )}
      </ul>
      <form
        className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          add.mutate(
            {
              name: name.trim(),
              absPath: absPath.trim(),
              repoId: repoId || null,
              defaultBase: base.trim() || 'main',
              ...(color ? { color } : {}),
            },
            {
              onSuccess: () => {
                setName('');
                setAbsPath('');
                setColor(undefined);
              },
            },
          );
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="ws-name">Name</Label>
          <Input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="app-mobile"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-path">Folder on this computer</Label>
          <Input
            id="ws-path"
            value={absPath}
            onChange={(e) => setAbsPath(e.target.value)}
            placeholder="~/Work/app-mobile"
            className="font-mono text-xs"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-repo">GitLab repo (optional)</Label>
          <Select id="ws-repo" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            <option value="">—</option>
            {(repos.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-base">Base branch</Label>
          <Input id="ws-base" value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor="ws-color">Mark</Label>
          <RepoMarkPicker id="ws-color" value={color} onChange={setColor} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!name.trim() || !absPath.trim() || add.isPending}>
            {add.isPending ? (
              <Loader2 className="size-4 motion-safe:animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add workspace
          </Button>
        </div>
      </form>
      <ErrorAlert error={add.error ?? remove.error ?? list.error} />
    </SectionCard>
  );
}
