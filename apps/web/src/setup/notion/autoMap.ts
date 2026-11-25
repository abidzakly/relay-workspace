import type { NotionSchemaProp } from '@relay/shared';

/** What Relay reads from a card, in the user's words, and the Notion column types that can hold it. */
export interface Role {
  key: RoleKey;
  label: string;
  hint: string;
  types: readonly string[];
  required: boolean;
  /** Name fragments that make a column the likely match, best first. */
  names: readonly string[];
}

export type RoleKey =
  | 'title'
  | 'status'
  | 'type'
  | 'assignee'
  | 'estimation'
  | 'branchName'
  | 'parent'
  | 'subTasks'
  | 'sprint'
  | 'productDomain'
  | 'point'
  | 'assignedAt';

const LABELS = ['select', 'multi_select', 'status', 'rich_text', 'formula', 'rollup', 'relation'];

export const ROLES: readonly Role[] = [
  {
    key: 'title',
    label: 'Card title',
    hint: 'The name of the card.',
    types: ['title'],
    required: true,
    names: ['name', 'title'],
  },
  {
    key: 'status',
    label: 'Status',
    hint: 'Where the card is in your flow.',
    types: ['status', 'select'],
    required: true,
    names: ['status'],
  },
  {
    key: 'type',
    label: 'Card type',
    hint: 'Feature, issue, improvement…',
    types: ['select', 'status', 'multi_select'],
    required: true,
    names: ['type', 'kind', 'category'],
  },
  {
    key: 'assignee',
    label: 'Developer',
    hint: 'Who works on it. Relay shows the cards where this is you.',
    types: ['people'],
    required: true,
    names: ['developer', 'assignee', 'owner', 'assign'],
  },
  {
    key: 'estimation',
    label: 'Planned dates',
    hint: 'Start and end. SLA and the board read it.',
    types: ['date'],
    required: true,
    names: ['estimation start', 'estimation', 'due', 'date'],
  },
  {
    key: 'branchName',
    label: 'Branch name',
    hint: 'Links the card to its branch and merge request.',
    types: ['formula', 'rich_text', 'title'],
    required: true,
    names: ['branch'],
  },
  {
    key: 'parent',
    label: 'Parent card',
    hint: 'The card this one belongs to.',
    types: ['relation'],
    required: true,
    names: ['parent'],
  },
  {
    key: 'subTasks',
    label: 'Sub-tasks',
    hint: 'The cards under this one.',
    types: ['relation'],
    required: false,
    names: ['sub-task', 'subtask', 'sub task', 'children'],
  },
  {
    key: 'sprint',
    label: 'Sprint',
    hint: 'Groups cards in the Sprint Atelier.',
    types: LABELS,
    required: false,
    names: ['select sprint', 'sprint'],
  },
  {
    key: 'productDomain',
    label: 'Product domain',
    hint: 'Matches a card to its repository.',
    types: LABELS,
    required: false,
    names: ['product domain', 'domain', 'product', 'project'],
  },
  {
    key: 'point',
    label: 'Points',
    hint: 'Estimated effort, for the KPI.',
    types: ['number', 'select', 'formula', 'rich_text'],
    required: false,
    names: ['point'],
  },
  {
    key: 'assignedAt',
    label: 'Assigned at',
    hint: 'When the card became yours (optional, for SLA).',
    types: ['date'],
    required: false,
    names: ['assigned'],
  },
];

/** The columns a role can read, best guess first. */
export function candidates(role: Role, props: readonly NotionSchemaProp[]): NotionSchemaProp[] {
  const fit = props.filter((p) => role.types.includes(p.type) && !p.name.endsWith(' (title)'));
  const score = (p: NotionSchemaProp) => {
    const n = p.name.toLowerCase().trim();
    const i = role.names.findIndex((x) => n === x || n.startsWith(x) || n.includes(x));
    return (
      (i === -1 ? 100 : i * 2 + (n === role.names[i] ? 0 : 1)) +
      (p.name.startsWith('Helper') ? 50 : 0)
    );
  };
  return [...fit].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

/** A first mapping: the configured column when it still exists, else the best-scoring one with a name hint. */
export function autoMap(
  props: readonly NotionSchemaProp[],
  current: Partial<Record<RoleKey, string>>,
): Partial<Record<RoleKey, string>> {
  const out: Partial<Record<RoleKey, string>> = {};
  for (const role of ROLES) {
    const list = candidates(role, props);
    const keep = current[role.key];
    if (keep && list.some((p) => p.name === keep)) {
      out[role.key] = keep;
      continue;
    }
    const best = list[0];
    const hinted =
      best && role.names.some((x) => best.name.toLowerCase().includes(x)) ? best : undefined;
    // The title and the status have only one sensible column, even without a name hint.
    const pick = hinted ?? (role.key === 'title' || role.key === 'assignee' ? best : undefined);
    if (pick) out[role.key] = pick.name;
  }
  return out;
}

/**
 * Relay's status groups. `hint` is the short form (a column header's tooltip); `means` says in full what putting a
 * status in the group does, shown under it in the wizard and in Advanced mode.
 */
export const GROUPS = [
  {
    key: 'complete',
    label: 'Complete',
    hint: 'How your board says “coding finished”.',
    means:
      'The status your board uses for “coding finished, merge request in review”, however your workspace spells it (e.g. Completed). Relay moves a card here when its merge request is opened.',
  },
  {
    key: 'done',
    label: 'Ready to Test and later',
    hint: 'Counts as finished for the completion rate.',
    means:
      'Ready to Test and every status after it. A card in one of these counts as finished in the completion rate, and its SLA timer stops.',
  },
  {
    key: 'inactive',
    label: 'Not actionable',
    hint: 'Nothing to do now: never in Today’s focus.',
    means:
      'Statuses where there is nothing for you to do now: parked (Backlog, Draft) or closed (Done, Archived). These cards never appear in Today’s focus or “Needs your action”. They still count in the KPI.',
  },
  {
    key: 'uncommitted',
    label: 'Not committed',
    hint: 'Left out of the completion rate.',
    means:
      'Statuses of work nobody has committed to yet (Backlog, Draft, Assign to PM). These cards are left out of the completion rate, so they never count as unfinished. Usually the parked part of “Not actionable”, without Done or Archived.',
  },
] as const;
export type GroupKey = (typeof GROUPS)[number]['key'];

/** A sensible first sorting of the board's statuses into Relay's groups. */
export function autoGroups(statuses: readonly string[]): Record<GroupKey, string[]> {
  const has = (s: string, ...words: string[]) => words.some((w) => s.toLowerCase().includes(w));
  return {
    complete: statuses.filter((s) => has(s, 'complete')),
    done: statuses.filter((s) =>
      has(s, 'ready to test', 'test', 'done', 'archiv', 'qa', 'release'),
    ),
    inactive: statuses.filter((s) =>
      has(s, 'archiv', 'done', 'backlog', 'draft', 'cancel', 'hold', 'assign to pm'),
    ),
    uncommitted: statuses.filter((s) => has(s, 'backlog', 'draft', 'assign to pm')),
  };
}
