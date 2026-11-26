import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { SECRET_MASK, type GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Field, errorMap } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { ApiError } from '@/lib/api';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useSaveGlobal, useTestNotion } from '@/lib/settingsApi';
import { STAGES, stagesFromGroups } from '@/setup/notion/autoMap';
import { useDraft } from './drafts';
import { OAuthConnect } from './OAuthConnect';
import { ErrorAlert, SectionCard } from './SectionCard';
import { Advanced, ExtLink, ModeSwitch, Steps, Ui } from './SetupGuide';

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

/**
 * Advanced mode: Relay reads Notion with a token you make yourself, a personal access token (it reads what your
 * account can open) or an internal integration secret. Only the token is typed here; the board, columns and
 * statuses are set up in the same wizard as Connect mode.
 */
function AdvancedForm({ settings }: { settings: GlobalConfigPublic }) {
  const initial = {
    token: settings.notion.tokenSet ? SECRET_MASK : '',
    version: settings.notion.version,
  };
  const { draft, set, dirty } = useDraft(initial);
  const save = useSaveGlobal();
  const qc = useQueryClient();
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

  // Open until a token is stored, and on a token or version error.
  const manualOpen =
    !settings.notion.tokenSet || !!errs['notion.token'] || !!errs['notion.version'];

  return (
    <div className="grid gap-4">
      <Advanced summary="Token and API version" open={manualOpen}>
        <p className="text-muted-foreground">
          Advanced mode reads Notion with a token you make yourself. The Notion sign-in, if any, is
          kept but not used.
        </p>
        <Steps>
          <li>
            Open{' '}
            <ExtLink href="https://www.notion.so/developers/tokens">
              Notion personal access tokens
            </ExtLink>
            , press <Ui>New token</Ui>, tick <Ui>Notion API</Ui> and <Ui>Create token</Ui>. It reads
            every page your account can open, with no page to share and no Full access needed. It
            expires (1 year by default).
          </li>
          <li>
            Or make an internal integration at{' '}
            <ExtLink href="https://www.notion.so/profile/integrations">Notion integrations</ExtLink>{' '}
            and add it to your board under <Ui>•••</Ui> &gt; <Ui>Connections</Ui>.
          </li>
          <li>
            Paste the token below and press Save, then <Ui>Set up Notion</Ui>.
          </li>
        </Steps>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Token"
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
        <ErrorAlert error={save.error && Object.keys(errs).length === 0 ? save.error : null} />
        <div>
          <Button
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  notionToken: tokenArg,
                  patch: (s) => ({ ...s, notion: { ...s.notion, version: draft.version.trim() } }),
                },
                // A new token sees other databases: drop the lists read with the old one.
                { onSuccess: () => void qc.invalidateQueries({ queryKey: ['oauth', 'notion'] }) },
              )
            }
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Advanced>
      {settings.notion.tokenSet ? <SetupStatus settings={settings} intro="Token saved." /> : null}
    </div>
  );
}

/**
 * Notion, one way in at a time. Connect mode (the default): the sign-in. Advanced mode: a token you make yourself.
 * Both set up the board in the same wizard. The switch saves at once; the other way's sign-in or token is kept but
 * not used.
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
      brand="notion"
      title="Notion"
      description={
        advanced
          ? 'Advanced mode: a personal access token, then the setup walks you through the board.'
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
  return (
    <div className="grid gap-4">
      <OAuthConnect
        provider="notion"
        what="Sign in on Notion's page and tick the databases Relay may use. No integration token to make or paste."
      />
      {connected ? <SetupStatus settings={settings} intro="Connected." /> : null}
    </div>
  );
}

/** What the setup saved, the way into the wizard, and the connection test. Shown once Relay can read Notion. */
function SetupStatus({ settings, intro }: { settings: GlobalConfigPublic; intro: string }) {
  const test = useTestNotion();
  const n = settings.notion;
  const setUp = !!n.dataSourceId;
  const stages = stagesFromGroups(n.statuses, n.statusGroups);
  return (
    <div className="grid gap-3 rounded-control border border-hairline px-4 py-3 text-sm">
      {setUp ? (
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Board</dt>
          <dd className="truncate font-mono text-xs">{n.dataSourceId}</dd>
          {STAGES.map((g) => {
            const in_ = n.statuses.filter((s) => stages[s] === g.key);
            return in_.length ? (
              <div key={g.key} className="contents">
                <dt className="text-muted-foreground">{g.label}</dt>
                <dd>{in_.join(' · ')}</dd>
              </div>
            ) : null;
          })}
          <dt className="text-muted-foreground">Ready for QA</dt>
          <dd>{n.readyStatus}</dd>
          <dt className="text-muted-foreground">My names</dt>
          <dd className="truncate">{n.assigneeAliases.join(', ') || 'not set'}</dd>
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {intro} One more step: pick your board and check how Relay reads it.
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
  );
}
