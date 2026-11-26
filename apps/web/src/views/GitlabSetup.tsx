import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { GlobalConfigPublic } from '@relay/shared';
import { PaperGrid } from '@/components/PaperGrid';
import { PickRow, PickTag } from '@/components/PickRow';
import { SecretInput } from '@/components/SecretInput';
import { ThemeSync } from '@/components/ThemeSync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChoiceCard } from '@/components/wizard/StepDialog';
import { WizardShell, type ShellStep } from '@/components/wizard/WizardShell';
import { describeError } from '@/lib/api';
import { useCheckGitlabHost, usePickMe, useTunnels } from '@/lib/gitlabPickerApi';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useReviewToken, useSaveReviewToken } from '@/lib/reviewsApi';
import { useRepos, useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { useCheckPublicUrl } from '@/lib/webhookApi';
import { OAuthConnect } from '@/settings/OAuthConnect';
import { RepoDialog } from '@/settings/RepoDialog';
import { ErrorAlert } from '@/settings/SectionCard';
import { CopyLine, ExtLink, Steps, Ui } from '@/settings/SetupGuide';

type StepKey = 'host' | 'connect' | 'you' | 'public' | 'repos' | 'done';

const GITLAB_COM = 'https://gitlab.com';

/**
 * Set up GitLab: a full-screen walk from the host to a first repository. Each step saves what it chose when you
 * continue, so leaving half way keeps the finished steps.
 */
export function GitlabSetup() {
  const settings = useSettings();
  if (!settings.data) {
    return (
      <div className="sb-shell">
        <ThemeSync />
        <PaperGrid />
        <p className="p-10 text-sm text-muted-foreground">
          {settings.error ? describeError(settings.error) : 'Loading…'}
        </p>
      </div>
    );
  }
  return <Wizard settings={settings.data} />;
}

function Wizard({ settings }: { settings: GlobalConfigPublic }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const save = useSaveGlobal();
  const oauth = useOAuthStatus().data?.gitlab;
  const token = useReviewToken();
  const saveToken = useSaveReviewToken();
  const repos = useRepos().data ?? [];

  const savedHost = settings.gitlab.host?.replace(/\/+$/, '') ?? '';
  const [hostKind, setHostKind] = useState<'com' | 'own'>(
    savedHost && savedHost !== GITLAB_COM ? 'own' : savedHost ? 'com' : 'own',
  );
  const [ownHost, setOwnHost] = useState(savedHost === GITLAB_COM ? '' : savedHost);
  const host = hostKind === 'com' ? GITLAB_COM : ownHost.trim().replace(/\/+$/, '');
  const checkHost = useCheckGitlabHost();
  const hostOk = checkHost.data?.ok && checkHost.data.host === host;

  const advanced = settings.gitlab.authMode === 'token';
  const [pat, setPat] = useState('');
  const connected = advanced ? !!token.data?.tokenSet && !token.data.viaSignIn : !!oauth?.connected;

  const me = usePickMe({}, connected && !!savedHost);
  const [publicUrl, setPublicUrl] = useState(settings.publicBaseUrl ?? '');
  const [lookForTunnel, setLookForTunnel] = useState(!settings.publicBaseUrl);
  const tunnels = useTunnels(lookForTunnel);
  const check = useCheckPublicUrl();
  const [repoOpen, setRepoOpen] = useState(false);

  // A tunnel that points at the webhook port fills the public URL when none is set.
  useEffect(() => {
    const hit = tunnels.data?.find((t) => t.webhook);
    if (hit && !publicUrl) setPublicUrl(hit.publicUrl);
  }, [tunnels.data, publicUrl]);

  const [at, setAt] = useState(() => (savedHost ? 1 : 0));

  const steps: ShellStep<StepKey>[] = [
    {
      key: 'host',
      rail: 'Host',
      title: 'Where is your GitLab?',
      lede: 'gitlab.com, or the address of your company’s own GitLab.',
      done: !!host && (hostOk || host === savedHost),
    },
    {
      key: 'connect',
      rail: 'Connect',
      title: 'Let Relay in',
      lede: advanced
        ? 'Advanced mode: a personal access token, made in one click on GitLab’s own page.'
        : 'One sign-in on GitLab’s own page. Nothing to copy.',
      done: connected,
    },
    {
      key: 'you',
      rail: 'You',
      title: 'Is this you?',
      lede: 'Relay uses your username for “mine” filters and as the default assignee.',
      // Read, not typed: when GitLab cannot be read, the step can still be passed.
      done: true,
    },
    {
      key: 'public',
      rail: 'Webhooks',
      title: 'Where GitLab can reach Relay',
      lede: 'GitLab tells Relay about merge requests through a public address (an ngrok tunnel). Only the webhook path is exposed.',
      done: true,
    },
    {
      key: 'repos',
      rail: 'Repos',
      title: 'Add your repositories',
      lede: 'Pick each project from GitLab; Relay fills in the rest.',
      done: true,
    },
    {
      key: 'done',
      rail: 'Done',
      title: 'GitLab is connected',
      lede: 'Change any of this later under Settings > GitLab, or run this setup again.',
      done: true,
    },
  ];

  const patch = (f: (s: GlobalConfigPublic) => GlobalConfigPublic) =>
    save.mutateAsync({ patch: f }).then(
      () => true,
      () => false,
    );

  const onContinue = async (k: StepKey): Promise<boolean> => {
    if (k === 'host') {
      if (host === savedHost) return true;
      const ok = await patch((s) => ({ ...s, gitlab: { ...s.gitlab, host } }));
      // The Connect button needs the host.
      if (ok) void qc.invalidateQueries({ queryKey: ['oauth'] });
      return ok;
    }
    if (k === 'you' && me.data && me.data.username !== settings.gitlab.myUsername) {
      return patch((s) => ({ ...s, gitlab: { ...s.gitlab, myUsername: me.data?.username } }));
    }
    if (k === 'public') {
      const url = publicUrl.trim().replace(/\/+$/, '');
      if (url === (settings.publicBaseUrl ?? '')) return true;
      return patch((s) => ({ ...s, publicBaseUrl: url || undefined }));
    }
    return true;
  };

  const setMode = (token: boolean) =>
    save.mutate(
      { patch: (s) => ({ ...s, gitlab: { ...s.gitlab, authMode: token ? 'token' : 'connect' } }) },
      { onSuccess: () => void qc.invalidateQueries() },
    );

  const step = steps[at]!.key;
  const patUrl = savedHost
    ? `${savedHost}/-/user_settings/personal_access_tokens?name=Relay&scopes=api`
    : '';

  return (
    <WizardShell
      mark={['GitLab', 'Relay']}
      backTo="/settings#gitlab"
      steps={steps}
      at={at}
      onAt={setAt}
      onContinue={onContinue}
      busy={save.isPending}
      status={
        save.error ? (
          <span role="alert" className="text-destructive">
            {describeError(save.error)}
          </span>
        ) : null
      }
      finished={
        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => navigate('/settings#repos')}>
            Open Repositories
          </Button>
          <Button size="lg" variant="ghost" onClick={() => navigate('/reviews')}>
            Open Reviews
          </Button>
        </div>
      }
    >
      {step === 'host' ? (
        <div className="grid max-w-xl gap-4">
          <div role="radiogroup" aria-label="GitLab host" className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              selected={hostKind === 'com'}
              onSelect={() => setHostKind('com')}
              title="gitlab.com"
              detail="The public GitLab."
            />
            <ChoiceCard
              selected={hostKind === 'own'}
              onSelect={() => setHostKind('own')}
              title="Our own GitLab"
              detail="Self-managed, at your company’s address."
            />
          </div>
          {hostKind === 'own' ? (
            <Input
              aria-label="GitLab address"
              inputMode="url"
              value={ownHost}
              onChange={(e) => setOwnHost(e.target.value)}
              placeholder="https://gitlab.example.com"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!/^https?:\/\/\S+/.test(host) || checkHost.isPending}
              onClick={() => checkHost.mutate(host)}
            >
              {checkHost.isPending ? 'Checking…' : 'Check the address'}
            </Button>
            {checkHost.data && checkHost.data.host === host ? (
              <span
                className={checkHost.data.ok ? 'text-sm text-success' : 'text-sm text-destructive'}
              >
                {checkHost.data.message}
                {checkHost.data.version ? ` Version ${checkHost.data.version}.` : ''}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Copy it from your browser’s address bar on any GitLab page.
              </span>
            )}
          </div>
          <ErrorAlert error={checkHost.error} />
        </div>
      ) : null}

      {step === 'connect' ? (
        <div className="grid max-w-xl gap-4">
          <div
            role="radiogroup"
            aria-label="How Relay signs in"
            className="grid gap-2 sm:grid-cols-2"
          >
            <ChoiceCard
              selected={!advanced}
              onSelect={() => advanced && setMode(false)}
              title="Sign in with GitLab"
              badge={<span className="text-2xs text-muted-foreground">recommended</span>}
              detail="What Relay writes shows under your name."
            />
            <ChoiceCard
              selected={advanced}
              onSelect={() => !advanced && setMode(true)}
              title="Access tokens (Advanced)"
              detail="A personal token for Reviews, a project token per repo."
            />
          </div>
          {advanced ? (
            <div className="grid gap-3">
              <Steps>
                <li>
                  Open{' '}
                  {patUrl ? (
                    <ExtLink href={patUrl}>a new personal access token</ExtLink>
                  ) : (
                    'your GitLab’s Access tokens page'
                  )}{' '}
                  (name and <code>api</code> scope are filled in).
                </li>
                <li>
                  Pick an expiry date, press <Ui>Create token</Ui>, copy it.
                </li>
                <li>Paste it here. Relay checks it with GitLab before saving.</li>
              </Steps>
              <div className="flex flex-wrap gap-2">
                <SecretInput
                  aria-label="Personal access token"
                  className="min-w-0 flex-1"
                  value={pat}
                  onChange={setPat}
                  placeholder="glpat-…"
                />
                <Button
                  disabled={!pat.trim() || saveToken.isPending}
                  onClick={() => saveToken.mutate(pat.trim(), { onSuccess: () => setPat('') })}
                >
                  {saveToken.isPending ? 'Checking…' : 'Check and save'}
                </Button>
              </div>
              <ErrorAlert error={saveToken.error} />
              {token.data?.tokenSet && !token.data.viaSignIn ? (
                <p className="text-sm text-success">
                  Token saved for @{token.data.username}
                  {token.data.canWrite ? '' : ' (read only: it has no api scope)'}.
                </p>
              ) : null}
            </div>
          ) : (
            <OAuthConnect
              provider="gitlab"
              gitlabHost={savedHost}
              what="One sign-in for every repo, for Reviews and for git over HTTPS."
            />
          )}
        </div>
      ) : null}

      {step === 'you' ? (
        <div className="grid max-w-xl gap-3">
          {me.data ? (
            <PickRow
              selected
              onSelect={() => undefined}
              pickedLabel="You"
              title={me.data.name ?? me.data.username}
              meta={`@${me.data.username}${me.data.email ? ` · ${me.data.email}` : ''}`}
            />
          ) : me.isFetching ? (
            <p className="text-sm text-muted-foreground">Reading your GitLab profile…</p>
          ) : (
            <ErrorAlert error={me.error} />
          )}
          <p className="text-sm text-muted-foreground">
            Read from GitLab: nothing to type. Continue saves it.
          </p>
        </div>
      ) : null}

      {step === 'public' ? (
        <div className="grid max-w-xl gap-4">
          {tunnels.data && tunnels.data.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Tunnels running on this machine</p>
              <ul className="grid gap-1.5">
                {tunnels.data.map((t) => (
                  <li key={t.publicUrl}>
                    <PickRow
                      size="sm"
                      selected={publicUrl.replace(/\/+$/, '') === t.publicUrl}
                      onSelect={() => setPublicUrl(t.publicUrl)}
                      title={t.publicUrl}
                      meta={`forwards to ${t.addr}`}
                      trailing={t.webhook ? <PickTag em>webhook port</PickTag> : null}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="grid gap-2">
              <Steps>
                <li>
                  In the{' '}
                  <ExtLink href="https://dashboard.ngrok.com/domains">ngrok dashboard</ExtLink>,
                  take your free static domain.
                </li>
                <li>
                  Run this on this machine (with your domain):
                  <CopyLine
                    value="ngrok http --url=your-name.ngrok-free.app 3001"
                    label="command"
                  />
                </li>
                <li>
                  Then{' '}
                  <button
                    type="button"
                    className="underline underline-offset-4"
                    onClick={() => {
                      setLookForTunnel(true);
                      void tunnels.refetch();
                    }}
                  >
                    look for the tunnel again
                  </button>
                  , or paste its address below.
                </li>
              </Steps>
            </div>
          )}
          <Input
            aria-label="Public base URL"
            inputMode="url"
            value={publicUrl}
            onChange={(e) => setPublicUrl(e.target.value)}
            placeholder="https://your-name.ngrok-free.app"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={check.isPending || publicUrl.trim() !== (settings.publicBaseUrl ?? '')}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check the saved address'}
            </Button>
            {check.data ? (
              <span
                className={
                  check.data.state === 'reachable'
                    ? 'text-sm text-success'
                    : 'text-sm text-destructive'
                }
              >
                {check.data.state === 'reachable'
                  ? 'GitLab can reach Relay here.'
                  : `Not reachable (${check.data.state.replace(/_/g, ' ')}).`}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Continue saves it; this step can also be skipped for now.
              </span>
            )}
          </div>
          <ErrorAlert error={check.error} />
        </div>
      ) : null}

      {step === 'repos' ? (
        <div className="grid max-w-xl gap-3">
          {repos.length > 0 ? (
            <ul className="grid gap-1.5">
              {repos.map((r) => (
                <li key={r.id}>
                  <PickRow
                    size="sm"
                    selected
                    onSelect={() => undefined}
                    pickedLabel="Added"
                    title={r.name}
                    meta={`${r.baseBranch} · ${r.id}`}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No repository yet.</p>
          )}
          <div>
            <Button onClick={() => setRepoOpen(true)}>
              {repos.length ? 'Add another repository' : 'Add a repository'}
            </Button>
          </div>
          <RepoDialog open={repoOpen} onOpenChange={setRepoOpen} repo={undefined} />
        </div>
      ) : null}

      {step === 'done' ? (
        <dl className="grid max-w-xl gap-1 text-sm">
          <Fact k="Host" v={settings.gitlab.host ?? '—'} />
          <Fact
            k="Signed in as"
            v={me.data ? `@${me.data.username}` : (settings.gitlab.myUsername ?? '—')}
          />
          <Fact k="Mode" v={advanced ? 'Access tokens (Advanced)' : 'GitLab sign-in'} />
          <Fact k="Public URL" v={settings.publicBaseUrl ?? 'Not set: webhooks are off'} />
          <Fact k="Repositories" v={String(repos.length)} />
        </dl>
      ) : null}
    </WizardShell>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 border-b border-hairline py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="break-words">{v}</dd>
    </div>
  );
}
