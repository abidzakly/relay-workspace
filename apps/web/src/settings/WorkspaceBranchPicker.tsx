import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { describeError } from '@/lib/api';
import { useBranches } from '@/lib/reviewApi';

/**
 * The base branch of a new workspace, picked from the repo's branches on GitLab (searched as you type). Without a
 * repo it offers the folder's own branch. A name that is not listed can still be used from the search box.
 */
export function WorkspaceBranchPicker({
  id,
  repoId,
  value,
  extra,
  onChange,
}: {
  id: string;
  repoId: string;
  value: string;
  /** Other names worth offering: the folder's checked-out branch, the repo's base. */
  extra: readonly (string | null | undefined)[];
  onChange: (branch: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = useBranches(repoId, query.trim());
  const options: DropdownOption<string>[] = (repoId ? (q.data?.branches ?? []) : []).map((b) => ({
    value: b.name,
    label: b.name,
    hint: [b.default ? 'default' : null, b.protected ? 'protected' : null]
      .filter(Boolean)
      .join(' · '),
  }));
  for (const name of [value, ...extra, 'main']) {
    if (name && !options.some((o) => o.value === name)) options.push({ value: name, label: name });
  }
  const typed = query.trim();
  if (typed && !options.some((o) => o.value === typed)) {
    options.push({ value: typed, label: `Use “${typed}”`, hint: 'Not in the list' });
  }
  return (
    <Dropdown
      id={id}
      icon={GitBranch}
      width="full"
      searchable
      options={options}
      value={value}
      onQueryChange={setQuery}
      onChange={onChange}
      footer={
        !repoId
          ? 'Choose a repo to list its branches.'
          : q.error
            ? describeError(q.error)
            : q.isPending
              ? 'Listing branches…'
              : q.data?.truncated
                ? 'Type to find more.'
                : undefined
      }
    />
  );
}
