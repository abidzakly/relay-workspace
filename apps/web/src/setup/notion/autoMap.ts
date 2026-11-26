import type { NotionSchemaProp, NotionSchemaView } from '@relay/shared';

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
/** Relay's four status lists, as stored in `notion.statusGroups`. */
export type GroupKey = 'complete' | 'done' | 'inactive' | 'uncommitted';

/**
 * Where a status sits in the flow. Each status gets exactly one stage; the stored status lists are derived from it,
 * so a status can never land in two lists that contradict each other.
 */
export const STAGES = [
  {
    key: 'parked',
    label: 'Parked or dropped',
    hint: 'Nobody has committed to it yet, or it was dropped. Backlog, Draft, Assign to PM, Cancelled.',
    focus: false,
    rate: 'left out',
    groups: ['inactive', 'uncommitted'],
  },
  {
    key: 'hold',
    label: 'On hold',
    hint: 'Committed, but nothing to do right now. On Hold, Blocked.',
    focus: false,
    rate: 'unfinished',
    groups: ['inactive'],
  },
  {
    key: 'working',
    label: 'Working',
    hint: 'Yours to do. To Do, In Progress.',
    focus: true,
    rate: 'unfinished',
    groups: [],
  },
  {
    key: 'review',
    label: 'In review',
    hint: 'Coding finished, merge request open. Relay moves a card here when its merge request opens.',
    focus: true,
    rate: 'finished',
    groups: ['complete'],
  },
  {
    key: 'qa',
    label: 'With QA or finished',
    hint: 'Handed to QA, or closed. Ready to Test, QA, Done, Released, Archived. The SLA timer stops.',
    focus: false,
    rate: 'finished',
    groups: ['done'],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  hint: string;
  focus: boolean;
  rate: 'left out' | 'unfinished' | 'finished';
  groups: readonly GroupKey[];
}[];
export type StageKey = (typeof STAGES)[number]['key'];

const has = (s: string, ...words: string[]) => words.some((w) => s.toLowerCase().includes(w));

/** A first guess for each status, from its name. */
export function autoStages(statuses: readonly string[]): Record<string, StageKey> {
  return Object.fromEntries(
    statuses.map((s): [string, StageKey] => [
      s,
      has(s, 'complete')
        ? 'review'
        : has(s, 'ready to test', 'test', 'qa', 'done', 'archiv', 'release')
          ? 'qa'
          : has(s, 'backlog', 'draft', 'assign to pm', 'cancel')
            ? 'parked'
            : has(s, 'hold', 'block')
              ? 'hold'
              : 'working',
    ]),
  );
}

/** Stages from stored status lists. Statuses in none of the lists fall back to the name guess. */
export function stagesFromGroups(
  statuses: readonly string[],
  groups: Record<GroupKey, readonly string[]>,
): Record<string, StageKey> {
  const guess = autoStages(statuses);
  const known = new Set(Object.values(groups).flat());
  const inG = (k: GroupKey, s: string) => groups[k].includes(s);
  return Object.fromEntries(
    statuses.map((s): [string, StageKey] => [
      s,
      inG('done', s)
        ? 'qa'
        : inG('complete', s)
          ? 'review'
          : inG('uncommitted', s)
            ? 'parked'
            : inG('inactive', s)
              ? 'hold'
              : known.size > 0
                ? 'working'
                : guess[s]!,
    ]),
  );
}

/** The stored status lists for a set of stages. */
export function groupsFromStages(
  statuses: readonly string[],
  stages: Record<string, StageKey>,
): Record<GroupKey, string[]> {
  const out: Record<GroupKey, string[]> = { complete: [], done: [], inactive: [], uncommitted: [] };
  for (const s of statuses) {
    const stage = STAGES.find((x) => x.key === (stages[s] ?? 'working'))!;
    for (const g of stage.groups) out[g].push(s);
  }
  return out;
}

/** Text of one sample card's column, as Notion shows it. */
export function sampleOf(view: NotionSchemaView | undefined, column: string | undefined): string {
  if (!view || !column) return '';
  for (const s of view.samples) {
    const v = s[column];
    if (v) return v;
  }
  return '';
}
