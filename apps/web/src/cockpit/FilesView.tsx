import { ChevronLeft, ChevronRight, FileCode2, Folder, Loader2, Save, Search } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import type { DiffFile, Workspace } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import { useSaveWsFile, useWsFile, useWsTree, useWsStatus } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';
import { buildTree, type DirNode } from '@/review/fileTree';

const CodeEditor = lazy(() => import('./CodeEditor'));

const asFile = (path: string): DiffFile => ({
  path,
  oldPath: null,
  kind: 'modified',
  diff: null,
  binary: false,
  tooLarge: false,
  collapsed: false,
  additions: 0,
  deletions: 0,
});

function Dir({
  node,
  depth,
  dirty,
  onOpen,
}: {
  node: DirNode;
  depth: number;
  dirty: ReadonlySet<string>;
  onOpen: (p: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <li>
      {depth > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
          style={{ paddingLeft: depth * 10 }}
          aria-expanded={open}
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <Folder className="size-4 shrink-0 text-primary-ink" />
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {open && (
        <ul>
          {node.dirs.map((d) => (
            <Dir key={d.path} node={d} depth={depth + 1} dirty={dirty} onOpen={onOpen} />
          ))}
          {node.files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onOpen(f.path)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                style={{ paddingLeft: (depth + 1) * 10 + 4 }}
              >
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.path.split('/').pop()}</span>
                {dirty.has(f.path) && (
                  <span
                    className="ml-auto size-1.5 shrink-0 rounded-full bg-primary"
                    aria-label="changed"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Editor({ ws, path, onBack }: { ws: Workspace; path: string; onBack: () => void }) {
  const file = useWsFile(ws.id, path);
  const save = useSaveWsFile(ws.id);
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = draft !== null && draft !== file.data?.content;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} aria-label="Back to the file list">
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
          {dirty && <span className="ml-1 text-warning">unsaved</span>}
        </span>
        <Button
          size="sm"
          disabled={!dirty || save.isPending || !file.data}
          onClick={() =>
            save.mutate(
              { path, content: draft!, expectedHash: file.data!.hash },
              { onSuccess: () => setDraft(null) },
            )
          }
        >
          {save.isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save
        </Button>
      </div>
      {file.isPending && <Loader2 className="size-5 motion-safe:animate-spin" />}
      {file.error && <p className="text-sm text-destructive">{describeError(file.error)}</p>}
      {save.error && (
        <p className="text-sm text-destructive">
          {describeError(save.error)}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void file.refetch().then(() => setDraft(null))}
          >
            Reload
          </button>
        </p>
      )}
      {file.data && (
        <Suspense fallback={<Loader2 className="size-5 motion-safe:animate-spin" />}>
          <CodeEditor path={path} value={draft ?? file.data.content} onChange={setDraft} />
        </Suspense>
      )}
    </div>
  );
}

/** Files tab: small edits, not the main view. Changed files are marked. */
export function FilesView({ ws, initialPath }: { ws: Workspace; initialPath?: string | null }) {
  const tree = useWsTree(ws.id);
  const status = useWsStatus(ws.id);
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [filter, setFilter] = useState('');
  const dirty = useMemo(
    () => new Set((status.data?.dirty ?? []).map((d) => d.path)),
    [status.data],
  );
  const root = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const paths = (tree.data?.paths ?? []).filter((p) => !f || p.toLowerCase().includes(f));
    return buildTree(paths.slice(0, f ? 400 : 5000).map(asFile));
  }, [tree.data, filter]);

  if (path) return <Editor key={path} ws={ws} path={path} onBack={() => setPath(null)} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search files…"
          className="pl-8"
        />
      </div>
      {dirty.size > 0 && !filter && (
        <div className="grid gap-1 rounded-xl border border-primary/30 bg-primary/5 p-2">
          <p className="text-xs font-medium text-primary-ink">Changed ({dirty.size})</p>
          {[...dirty].slice(0, 20).map((p) => (
            <button
              key={p}
              type="button"
              className="truncate text-left font-mono text-xs hover:underline"
              onClick={() => setPath(p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {tree.isPending && <Loader2 className="size-5 motion-safe:animate-spin" />}
      {tree.error && <p className="text-sm text-destructive">{describeError(tree.error)}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto rounded-xl border p-1">
        <Dir node={root} depth={0} dirty={dirty} onOpen={setPath} />
      </ul>
    </div>
  );
}
