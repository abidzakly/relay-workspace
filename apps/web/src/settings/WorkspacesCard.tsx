import { FolderGit2, FolderOpen, GitBranch, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { WorkspaceColor } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  useAddWorkspace,
  usePickFolder,
  useRemoveWorkspace,
  useWorkspaces,
} from '@/lib/cockpitApi';
import { useRepos } from '@/lib/settingsApi';
import { RepoMark, RepoMarkPicker } from '@/components/RepoMark';
import { ErrorAlert, SectionCard } from './SectionCard';
import { WorkspaceBranchPicker } from './WorkspaceBranchPicker';
import { sameGitRemote, workspaceName } from './workspaceForm';

/**
 * Settings → Workspaces: directories on this computer the cockpit may work in. The host agent
 * validates each path (`git rev-parse`, inside HOST_AGENT_WORKSPACE_ROOTS, default ~/Work).
 */
export function WorkspacesCard() {
  const list = useWorkspaces();
  const repos = useRepos();
  const add = useAddWorkspace();
  const remove = useRemoveWorkspace();
  const pick = usePickFolder();
  const [name, setName] = useState('');
  const [absPath, setAbsPath] = useState('');
  // The branch checked out in the picked folder; offered as the base when no repo is chosen.
  const [folderBranch, setFolderBranch] = useState<string | null>(null);
  // The folder dialog cannot open here: type the path instead.
  const [typePath, setTypePath] = useState<string | null>(null);
  const [repoId, setRepoId] = useState('');
  const [base, setBase] = useState('main');
  const repoList = repos.data ?? [];
  const repo = repoList.find((r) => r.id === repoId);
  const autoName = workspaceName(
    repo?.name ?? absPath,
    (list.data ?? []).map((w) => w.name),
  );
  const chooseRepo = (id: string) => {
    setRepoId(id);
    const r = repoList.find((x) => x.id === id);
    setBase(r?.baseBranch ?? folderBranch ?? 'main');
  };
  const chooseFolder = () =>
    pick.mutate(undefined, {
      onSuccess: (r) => {
        if (r.status === 'unsupported') setTypePath(r.reason);
        if (r.status !== 'picked') return;
        setTypePath(null);
        setAbsPath(r.path);
        setFolderBranch(r.branch);
        const match = r.origin ? repoList.find((x) => sameGitRemote(x.cloneUrl, r.origin!)) : null;
        if (match) {
          setRepoId(match.id);
          setBase(match.baseBranch);
        } else if (!repoId && r.branch) {
          setBase(r.branch);
        }
      },
    });
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
              name: name.trim() || autoName,
              absPath: absPath.trim(),
              repoId: repoId || null,
              defaultBase: base.trim() || 'main',
              ...(color ? { color } : {}),
            },
            {
              onSuccess: () => {
                setName('');
                setAbsPath('');
                setFolderBranch(null);
                setColor(undefined);
              },
            },
          );
        }}
      >
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor="ws-path">Folder on this computer</Label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {absPath && typePath === null ? (
              <p
                className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-xs"
                title={absPath}
              >
                {absPath}
              </p>
            ) : null}
            {typePath !== null ? (
              <Input
                id="ws-path"
                value={absPath}
                onChange={(e) => setAbsPath(e.target.value)}
                placeholder="~/Work/app-mobile"
                className="min-w-0 flex-1 font-mono text-xs"
              />
            ) : (
              <Button
                id="ws-path"
                type="button"
                variant={absPath ? 'outline' : 'default'}
                size="sm"
                disabled={pick.isPending}
                onClick={chooseFolder}
              >
                {pick.isPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <FolderOpen className="size-4" />
                )}
                {pick.isPending
                  ? 'Waiting for the folder dialog…'
                  : absPath
                    ? 'Change'
                    : 'Choose folder…'}
              </Button>
            )}
          </div>
          {typePath !== null && (
            <p className="text-xs text-muted-foreground">{typePath} Type the path instead.</p>
          )}
          {folderBranch && absPath && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="size-3" /> On {folderBranch}
            </p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-repo">GitLab repo (optional)</Label>
          <Select id="ws-repo" value={repoId} onChange={(e) => chooseRepo(e.target.value)}>
            <option value="">—</option>
            {repoList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-base">Base branch</Label>
          <WorkspaceBranchPicker
            id="ws-base"
            repoId={repoId}
            value={base}
            extra={[folderBranch, repo?.baseBranch]}
            onChange={setBase}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ws-name">Name (optional)</Label>
          <Input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={absPath || repo ? autoName : 'From the repo or folder'}
          />
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor="ws-color">Mark</Label>
          <RepoMarkPicker id="ws-color" value={color} onChange={setColor} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!absPath.trim() || add.isPending}>
            {add.isPending ? (
              <Loader2 className="size-4 motion-safe:animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Add workspace
          </Button>
        </div>
      </form>
      <ErrorAlert error={add.error ?? pick.error ?? remove.error ?? list.error} />
    </SectionCard>
  );
}
