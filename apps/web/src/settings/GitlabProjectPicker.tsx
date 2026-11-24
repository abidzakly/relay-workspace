import { useEffect, useState } from 'react';
import type { GitlabProjectOption } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useGitlabProjects } from '@/lib/oauthApi';
import { ErrorAlert } from './SectionCard';

/** Finds a GitLab project the signed-in user is a member of, so its id and clone URL never have to be looked up. */
export function GitlabProjectPicker({ onPick }: { onPick: (p: GitlabProjectOption) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const list = useGitlabProjects(search, open);

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Pick a project from GitLab
      </Button>
    );
  }
  return (
    <div className="grid gap-2 rounded-control border border-hairline p-3">
      <Input
        aria-label="Search GitLab projects"
        placeholder="Search your projects…"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoFocus
      />
      {list.error ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        list.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">No project matches.</p>
        ) : (
          <ul className="grid max-h-48 gap-1 overflow-y-auto">
            {list.data.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="w-full truncate rounded-control px-2 py-1 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onPick(p);
                    setOpen(false);
                  }}
                >
                  {p.pathWithNamespace}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Reading GitLab…</p>
      )}
    </div>
  );
}
