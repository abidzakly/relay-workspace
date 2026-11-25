import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { SECRET_MASK, type GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Field, errorMap } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { ApiError } from '@/lib/api';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useSaveGlobal, useTestNotion } from '@/lib/settingsApi';
import { GROUPS } from '@/setup/notion/autoMap';
import { opt, splitList, useDraft } from './drafts';
import { NotionSourcePicker } from './NotionSourcePicker';
import { OAuthConnect } from './OAuthConnect';
import { ErrorAlert, SectionCard } from './SectionCard';
import { Advanced, ExtLink, ModeSwitch, Steps, Ui } from './SetupGuide';

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

const GROUP_FIELDS = GROUPS.map((g) => [g.key, g.label, g.means] as const);

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

/** Advanced mode: the integration token and the mapping typed by hand. Rendered only while Advanced mode is on. */
function AdvancedForm({ settings }: { settings: GlobalConfigPublic }) {
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

  const errIn = (prefix: string) => Object.keys(errs).some((k) => k.startsWith(prefix));
  // Open until a token is stored, and on a token or version error.
  const manualOpen =
    !settings.notion.tokenSet || !!errs['notion.token'] || !!errs['notion.version'];

  return (
    <div className="grid gap-5">
      <Advanced summary="Integration token and API version" open={manualOpen}>
        <p className="text-muted-foreground">
          Advanced mode reads Notion with an integration token you make yourself. The Notion
          sign-in, if any, is kept but not used.
        </p>
        <Steps>
          <li>
            Open{' '}
            <ExtLink href="https://www.notion.so/profile/integrations">Notion integrations</ExtLink>
            , press <Ui>New integration</Ui>, pick your workspace and type <Ui>Internal</Ui>.
          </li>
          <li>
            Under <Ui>Capabilities</Ui> allow read content, update content and read user information
            (with email). Save, then copy the <Ui>Internal Integration Secret</Ui> (
            <code>ntn_…</code>).
          </li>
          <li>
            Open your board in Notion, press <Ui>•••</Ui> &gt; <Ui>Connections</Ui> and add the
            integration, so it can see the database.
          </li>
          <li>
            Paste the secret below, press Save, then <Ui>Pick from Notion</Ui> under “Data source
            id”.
          </li>
        </Steps>
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
            label="Notion-Version"
            htmlFor="nt-ver"
            error={errs['notion.version']}
            hint="The Notion API version Relay speaks. Leave it as is unless “Test connection” says otherwise."
          >
            <Input
              id="nt-ver"
              value={draft.version}
              onChange={(e) => set('version', e.target.value)}
            />
          </Field>
        </div>
      </Advanced>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Data source id"
          htmlFor="nt-ds"
          error={errs['notion.dataSourceId']}
          hint="Your board. Save the token, then press “Pick from Notion”, or paste the data source (not the database) id."
        >
          <div className="grid gap-2">
            <Input
              id="nt-ds"
              value={draft.dataSourceId}
              onChange={(e) => set('dataSourceId', e.target.value)}
            />
            <NotionSourcePicker
              tokenSet={settings.notion.tokenSet}
              value={draft.dataSourceId}
              onPick={(id) => set('dataSourceId', id)}
            />
          </div>
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

      <Advanced summary="Database property names" open={errIn('notion.props.')}>
        <p className="text-muted-foreground">
          The defaults match the standard board. Change a name only if that column is named
          differently in your database.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PROP_FIELDS.map(([key, label, hint]) => (
            <Field
              key={key}
              label={label}
              htmlFor={`nt-${key}`}
              hint={hint}
              error={errs[`notion.props.${key}`]}
            >
              <Input
                id={`nt-${key}`}
                value={draft[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </Field>
          ))}
        </div>
      </Advanced>

      <fieldset className="grid gap-4">
        <legend className="mb-1 text-sm font-semibold">Status groups</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUP_FIELDS.map(([key, label, means]) => (
            <Field
              key={key}
              label={label}
              htmlFor={`nt-g-${key}`}
              hint={`${means} Comma separated.`}
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
      </fieldset>

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
    </div>
  );
}

/**
 * Notion, one way in at a time. Connect mode (the default): the sign-in plus the setup wizard; nothing to type here.
 * Advanced mode: an integration token and the mapping by hand. The switch saves at once; the other way's sign-in or
 * token is kept but not used.
 */
export function NotionCard({ settings }: { settings: GlobalConfigPublic }) {
  const advanced = settings.notion.authMode === 'token';
  const save = useSaveGlobal();
  const qc = useQueryClient();
  const setMode = (on: boolean) =>
    save.mutate(
      { patch: (s) => ({ ...s, notion: { ...s.notion, authMode: on ? 'token' : 'connect' } }) },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ['oauth', 'notion'] }) },
    );

  return (
    <SectionCard
      id="notion"
      title="Notion"
      description={
        advanced
          ? 'Advanced mode: an integration token, and the board mapped by hand.'
          : 'Connect, then the setup walks you through the board, columns and statuses.'
      }
      action={
        <ModeSwitch
          id="nt-advanced"
          advanced={advanced}
          pending={save.isPending}
          onChange={setMode}
        />
      }
    >
      <ErrorAlert error={save.error} />
      {advanced ? <AdvancedForm settings={settings} /> : <ConnectMode settings={settings} />}
    </SectionCard>
  );
}

/** Connect mode: the sign-in, what the setup saved, and the way into the wizard. No manual fields. */
function ConnectMode({ settings }: { settings: GlobalConfigPublic }) {
  const connected = !!useOAuthStatus().data?.notion.connected;
  const test = useTestNotion();
  const n = settings.notion;
  const setUp = !!n.dataSourceId;
  return (
    <div className="grid gap-4">
      <OAuthConnect
        provider="notion"
        what="Sign in on Notion's page and tick the databases Relay may use. No integration token to make or paste."
      />
      {connected ? (
        <div className="grid gap-3 rounded-control border border-hairline px-4 py-3 text-sm">
          {setUp ? (
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Board</dt>
              <dd className="truncate font-mono text-xs">{n.dataSourceId}</dd>
              <dt className="text-muted-foreground">Statuses</dt>
              <dd>{n.statuses.join(' · ')}</dd>
              <dt className="text-muted-foreground">Ready for QA</dt>
              <dd>{n.readyStatus}</dd>
              <dt className="text-muted-foreground">My names</dt>
              <dd className="truncate">{n.assigneeAliases.join(', ') || 'not set'}</dd>
            </dl>
          ) : (
            <p className="text-muted-foreground">
              Connected. One more step: pick your board and check how Relay reads it.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm" variant={setUp ? 'outline' : 'default'}>
              <Link to="/setup/notion">{setUp ? 'Run the setup again' : 'Set up Notion'}</Link>
            </Button>
            {setUp ? (
              <Button
                size="sm"
                variant="outline"
                disabled={test.isPending}
                onClick={() => test.mutate()}
              >
                {test.isPending ? 'Testing…' : 'Test connection'}
              </Button>
            ) : null}
          </div>
          {test.error ? <ErrorAlert error={test.error} /> : null}
          {test.data ? <ConnectionChecklist result={test.data} /> : null}
        </div>
      ) : null}
    </div>
  );
}
