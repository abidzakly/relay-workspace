import { SECRET_MASK, type GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Field, errorMap } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { ApiError } from '@/lib/api';
import { useSaveGlobal, useTestNotion } from '@/lib/settingsApi';
import { opt, splitList, useDraft } from './drafts';
import { ErrorAlert, SectionCard } from './SectionCard';

const PROP_FIELDS = [
  ['title', 'Title property', '“auto” = detect the title property'],
  ['status', 'Status property', '“auto” = first status-type property, else a select named Status'],
  ['type', 'Type', 'select: Issues / New Feature / Improvement / Research / Feedback / …'],
  ['assignee', 'Assignee', 'people'],
  ['estimation', 'Estimation', 'date range (start is used for SLA)'],
  ['branchName', 'Branch name', 'rich text or formula (text result)'],
  ['parent', 'Parent item', 'relation (Issues → parent card)'],
  ['assignedAt', 'Assigned at', 'date, optional: used when SLA assigned-at source is “property”'],
  ['productDomain', 'Product Domain', 'select or text, optional: maps a card to its repo'],
  ['point', 'Point', 'number or select (1-6), optional: estimated effort'],
  ['sprint', 'Sprint', 'select, optional: groups cards in the Sprint Atelier'],
  ['subTasks', 'Sub-task', 'relation, optional: the parent’s side of “Parent item”'],
] as const;

const GROUP_FIELDS = [
  ['complete', 'Complete role', 'How this workspace spells “Complete” (e.g. Completed).'],
  [
    'done',
    'Reached Ready to Test',
    'Ready to Test and every later status: counts as completed for the completion rate.',
  ],
  [
    'inactive',
    'Not actionable',
    'Parked or closed: never in Today’s focus or “Needs your action”.',
  ],
  ['uncommitted', 'Not committed', 'Left out of the completion-rate denominator.'],
] as const;

export function toNotionDraft(s: GlobalConfigPublic) {
  const n = s.notion;
  return {
    token: n.tokenSet ? SECRET_MASK : '',
    dataSourceId: n.dataSourceId ?? '',
    version: n.version,
    title: n.props.title,
    status: n.props.status,
    type: n.props.type,
    assignee: n.props.assignee,
    estimation: n.props.estimation,
    branchName: n.props.branchName,
    parent: n.props.parent,
    assignedAt: n.props.assignedAt,
    productDomain: n.props.productDomain,
    point: n.props.point,
    sprint: n.props.sprint,
    subTasks: n.props.subTasks,
    complete: n.statusGroups.complete.join(', '),
    done: n.statusGroups.done.join(', '),
    inactive: n.statusGroups.inactive.join(', '),
    uncommitted: n.statusGroups.uncommitted.join(', '),
    statuses: n.statuses.join('\n'),
    readyStatus: n.readyStatus,
    assigneeAliases: n.assigneeAliases.join(', '),
  };
}

export function NotionCard({ settings }: { settings: GlobalConfigPublic }) {
  const initial = toNotionDraft(settings);
  const { draft, set, dirty } = useDraft(initial);
  const save = useSaveGlobal();
  const test = useTestNotion();
  const errs = errorMap(save.error instanceof ApiError ? save.error.issues : []);

  // undefined/mask = keep, string = replace, null = clear (field emptied while a token is stored)
  const tokenArg =
    draft.token === SECRET_MASK
      ? undefined
      : draft.token === ''
        ? settings.notion.tokenSet
          ? null
          : undefined
        : draft.token;

  return (
    <SectionCard
      id="notion"
      title="Notion mapping"
      description="Property names must match your database. “Test connection” reads the saved settings."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Integration token"
          htmlFor="nt-token"
          error={errs['notion.token']}
          hint={
            settings.notion.tokenSet
              ? 'Stored encrypted. Type to replace; empty the field and save to remove it.'
              : 'Stored encrypted (AES-256-GCM); never shown again.'
          }
        >
          <SecretInput id="nt-token" value={draft.token} onChange={(v) => set('token', v)} />
        </Field>
        <Field
          label="Data source id"
          htmlFor="nt-ds"
          error={errs['notion.dataSourceId']}
          hint="The data source (not the database) id."
        >
          <Input
            id="nt-ds"
            value={draft.dataSourceId}
            onChange={(e) => set('dataSourceId', e.target.value)}
          />
        </Field>
        <Field label="Notion-Version" htmlFor="nt-ver" error={errs['notion.version']}>
          <Input
            id="nt-ver"
            value={draft.version}
            onChange={(e) => set('version', e.target.value)}
          />
        </Field>
        <Field
          label="“Ready” status"
          htmlFor="nt-ready"
          error={errs['notion.readyStatus']}
          hint="Must be one of the statuses below."
        >
          <Input
            id="nt-ready"
            value={draft.readyStatus}
            onChange={(e) => set('readyStatus', e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PROP_FIELDS.map(([key, label, hint]) => (
          <Field
            key={key}
            label={label}
            htmlFor={`nt-${key}`}
            hint={hint}
            error={errs[`notion.props.${key}`]}
          >
            <Input id={`nt-${key}`} value={draft[key]} onChange={(e) => set(key, e.target.value)} />
          </Field>
        ))}
      </div>

      <Field
        label="My names"
        htmlFor="nt-aliases"
        error={errs['notion.assigneeAliases']}
        hint={`Comma separated: your name, email or Notion user id as it appears on the ${draft.assignee.trim() || 'Assignee'} property (the user id is the one nts uses). Your Notion user id is required: the sync fetches only cards that tag it, and does not run without it. Saving a change re-checks every card.`}
      >
        <Input
          id="nt-aliases"
          value={draft.assigneeAliases}
          onChange={(e) => set('assigneeAliases', e.target.value)}
        />
      </Field>

      <Field
        label="Statuses (one per line)"
        htmlFor="nt-statuses"
        error={errs['notion.statuses']}
        hint="Board column order."
      >
        <Textarea
          id="nt-statuses"
          rows={7}
          value={draft.statuses}
          onChange={(e) => set('statuses', e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        {GROUP_FIELDS.map(([key, label, hint]) => (
          <Field
            key={key}
            label={label}
            htmlFor={`nt-g-${key}`}
            hint={`${hint} Comma separated.`}
            error={errs[`notion.statusGroups.${key}`]}
          >
            <Input
              id={`nt-g-${key}`}
              value={draft[key]}
              onChange={(e) => set(key, e.target.value)}
            />
          </Field>
        ))}
      </div>

      <ErrorAlert error={save.error && Object.keys(errs).length === 0 ? save.error : null} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              notionToken: tokenArg,
              patch: (s) => ({
                ...s,
                notion: {
                  ...s.notion,
                  dataSourceId: opt(draft.dataSourceId),
                  version: draft.version.trim(),
                  readyStatus: draft.readyStatus.trim(),
                  statuses: splitList(draft.statuses),
                  assigneeAliases: splitList(draft.assigneeAliases),
                  statusGroups: {
                    complete: splitList(draft.complete),
                    done: splitList(draft.done),
                    inactive: splitList(draft.inactive),
                    uncommitted: splitList(draft.uncommitted),
                  },
                  props: {
                    title: draft.title.trim(),
                    status: draft.status.trim(),
                    type: draft.type.trim(),
                    assignee: draft.assignee.trim(),
                    estimation: draft.estimation.trim(),
                    branchName: draft.branchName.trim(),
                    parent: draft.parent.trim(),
                    assignedAt: draft.assignedAt.trim(),
                    productDomain: draft.productDomain.trim(),
                    point: draft.point.trim(),
                    sprint: draft.sprint.trim(),
                    subTasks: draft.subTasks.trim(),
                  },
                },
              }),
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="outline" disabled={dirty || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {dirty ? (
          <span className="text-sm text-muted-foreground">
            Save first: tests use the saved settings.
          </span>
        ) : null}
      </div>
      {test.error ? <ErrorAlert error={test.error} /> : null}
      {test.data ? <ConnectionChecklist result={test.data} /> : null}
    </SectionCard>
  );
}
