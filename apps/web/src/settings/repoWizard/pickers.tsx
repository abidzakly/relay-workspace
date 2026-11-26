import { useEffect, useState } from 'react';
import type { GitlabMember, GitlabProjectOption } from '@relay/shared';
import { initials, PickRow, PickTag } from '@/components/PickRow';
import { Input } from '@/components/ui/input';
import {
  usePickBranches,
  usePickMembers,
  usePickProjects,
  type PickWho,
} from '@/lib/gitlabPickerApi';
import { ErrorAlert } from '../SectionCard';

/** Typed text, settled for 300 ms before it searches. */
function useSettled(typed: string) {
  const [v, setV] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setV(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  return v;
}

function SearchBox({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <Input
      aria-label={label}
      placeholder={`${label}…`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus={autoFocus}
    />
  );
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
);

/** The GitLab projects the token can see; the picked one stays on top. */
export function ProjectList({
  who,
  enabled,
  selectedId,
  onPick,
}: {
  who: PickWho;
  enabled: boolean;
  selectedId: number | undefined;
  onPick: (p: GitlabProjectOption) => void;
}) {
  const [typed, setTyped] = useState('');
  const search = useSettled(typed);
  const list = usePickProjects(who, search, enabled);
  return (
    <div className="grid gap-2">
      <SearchBox label="Search your GitLab projects" value={typed} onChange={setTyped} autoFocus />
      {list.error ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        list.data.length === 0 ? (
          <Note>{search ? 'No project matches.' : 'This token sees no project.'}</Note>
        ) : (
          <ul className="grid max-h-64 gap-1.5 overflow-y-auto p-0.5">
            {list.data.map((p) => {
              const slash = p.pathWithNamespace.lastIndexOf('/');
              return (
                <li key={p.id}>
                  <PickRow
                    size="sm"
                    selected={p.id === selectedId}
                    onSelect={() => onPick(p)}
                    leading={initials(p.name)}
                    title={p.name}
                    meta={slash > 0 ? p.pathWithNamespace.slice(0, slash) : p.pathWithNamespace}
                    trailing={p.defaultBranch ? <PickTag>{p.defaultBranch}</PickTag> : null}
                  />
                </li>
              );
            })}
          </ul>
        )
      ) : list.isFetching ? (
        <Note>Reading GitLab…</Note>
      ) : null}
    </div>
  );
}

/** The project's branches, default first, to pick the base branch. */
export function BranchList({
  who,
  projectId,
  value,
  onPick,
}: {
  who: PickWho;
  projectId: number | undefined;
  value: string;
  onPick: (name: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const search = useSettled(typed);
  const list = usePickBranches(who, projectId, search);
  const many = (list.data?.branches.length ?? 0) > 6 || search !== '';
  return (
    <div className="grid gap-2">
      {many ? <SearchBox label="Search branches" value={typed} onChange={setTyped} /> : null}
      {list.error ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        list.data.branches.length === 0 ? (
          <Note>No branch matches.</Note>
        ) : (
          <ul className="grid max-h-56 gap-1.5 overflow-y-auto p-0.5">
            {list.data.branches.map((b) => (
              <li key={b.name}>
                <PickRow
                  size="sm"
                  selected={b.name === value}
                  onSelect={() => onPick(b.name)}
                  title={<code className="font-mono text-xs">{b.name}</code>}
                  meta={
                    b.committedAt
                      ? `Last commit ${new Date(b.committedAt).toLocaleDateString()}`
                      : null
                  }
                  trailing={
                    <>
                      {b.default ? <PickTag em>default</PickTag> : null}
                      {b.protected ? <PickTag>protected</PickTag> : null}
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        )
      ) : list.isFetching ? (
        <Note>Reading branches…</Note>
      ) : null}
      {list.data?.truncated ? <Note>Showing the first 100. Search to find others.</Note> : null}
    </div>
  );
}

const LEVEL: Record<number, string> = { 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };

function Avatar({ m }: { m: GitlabMember }) {
  return m.avatarUrl ? (
    <img src={m.avatarUrl} alt="" className="size-full rounded-[inherit] object-cover" />
  ) : (
    initials(m.name)
  );
}

/**
 * Project members with Developer access or more. `multi`: tick several (reviewers); else pick one, or none.
 */
export function MemberList({
  who,
  projectId,
  selected,
  onToggle,
  multi,
}: {
  who: PickWho;
  projectId: number | undefined;
  selected: string[];
  onToggle: (username: string) => void;
  multi: boolean;
}) {
  const [typed, setTyped] = useState('');
  const search = useSettled(typed);
  const list = usePickMembers(who, projectId, search);
  const many = (list.data?.length ?? 0) > 6 || search !== '';
  return (
    <div className="grid gap-2">
      {many ? <SearchBox label="Search members" value={typed} onChange={setTyped} /> : null}
      {list.error ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        list.data.length === 0 ? (
          <Note>{search ? 'No member matches.' : 'No member with Developer access or more.'}</Note>
        ) : (
          <ul className="grid max-h-56 gap-1.5 overflow-y-auto p-0.5">
            {list.data.map((m) => (
              <li key={m.username}>
                <PickRow
                  size="sm"
                  selected={selected.includes(m.username)}
                  onSelect={() => onToggle(m.username)}
                  pickedLabel={multi ? 'Reviewer' : 'Picked'}
                  leading={<Avatar m={m} />}
                  title={m.name}
                  meta={`@${m.username}`}
                  trailing={<PickTag>{LEVEL[m.accessLevel] ?? 'Member'}</PickTag>}
                />
              </li>
            ))}
          </ul>
        )
      ) : list.isFetching ? (
        <Note>Reading members…</Note>
      ) : null}
    </div>
  );
}
