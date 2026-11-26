import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CalendarStatus, GlobalConfigPublic } from '@relay/shared';
import { PaperGrid } from '@/components/PaperGrid';
import { ThemeSync } from '@/components/ThemeSync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChoiceCard } from '@/components/wizard/StepDialog';
import { WizardShell, type ShellStep } from '@/components/wizard/WizardShell';
import { describeError } from '@/lib/api';
import { useCalendarStatus, useConnectCalendar, useSaveCalendarConfig } from '@/lib/calendarApi';
import { useOAuthStatus } from '@/lib/oauthApi';
import { useDriveKey, useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { CalendarChecklist, ClientJsonLoader, DriveKeyUpload } from '@/settings/googleParts';
import { OAuthConnect } from '@/settings/OAuthConnect';
import { ErrorAlert } from '@/settings/SectionCard';
import { CopyLine, ExtLink, Steps, Ui } from '@/settings/SetupGuide';

type StepKey = 'mode' | 'calendar' | 'calendars' | 'drive' | 'done';

/**
 * Set up Google: Calendar and Drive in one walk. Connect mode is two sign-ins on Google's page; Advanced mode reads
 * the OAuth client from its downloaded file and takes the service-account key as a file pick. Nothing is typed.
 */
export function GoogleSetup() {
  const settings = useSettings();
  const calendar = useCalendarStatus();
  if (!settings.data || !calendar.data) {
    const error = settings.error ?? calendar.error;
    return (
      <div className="sb-shell">
        <ThemeSync />
        <PaperGrid />
        <p className="p-10 text-sm text-muted-foreground">
          {error ? describeError(error) : 'Loading…'}
        </p>
      </div>
    );
  }
  return <Wizard settings={settings.data} calendar={calendar.data} />;
}

function Wizard({
  settings,
  calendar,
}: {
  settings: GlobalConfigPublic;
  calendar: CalendarStatus;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const saveGlobal = useSaveGlobal();
  const saveCal = useSaveCalendarConfig();
  const connectOwn = useConnectCalendar();
  const oauth = useOAuthStatus().data?.google;
  const driveKey = useDriveKey().data;
  const advanced = settings.google.authMode === 'token';
  const calendarOn = settings.features.calendar;
  const buildsOn = settings.features.builds;

  const [clientId, setClientId] = useState(calendar.config.clientId);
  const [secret, setSecret] = useState('');
  const [ids, setIds] = useState<string[]>(calendar.config.calendarIds);
  const [at, setAt] = useState(0);

  const driveReady = advanced ? !!driveKey?.ok : !!oauth?.features.includes('drive');

  const steps: ShellStep<StepKey>[] = [
    {
      key: 'mode',
      rail: 'Mode',
      title: 'How Relay talks to Google',
      lede: 'One Google sign-in for Calendar and Drive, or your own Google Cloud credentials.',
      done: true,
    },
    {
      key: 'calendar',
      rail: 'Calendar',
      title: calendarOn ? 'Let Relay read your calendar' : 'Calendar is switched off',
      lede: calendarOn
        ? 'Read-only: Relay shows a floating alert before meetings and never changes your calendar.'
        : 'Turn on “Meetings” under Settings > General > Features to use it. You can skip this.',
      done: !calendarOn || calendar.connected,
    },
    {
      key: 'calendars',
      rail: 'Calendars',
      title: 'Which calendars?',
      lede: 'Tick the ones whose meetings Relay should alert you about.',
      done: !calendarOn || ids.length > 0,
    },
    {
      key: 'drive',
      rail: 'Drive',
      title: buildsOn ? 'Drive for staging builds' : 'Builds are switched off',
      lede: buildsOn
        ? 'Relay uploads staging builds to Drive and sends QA the link.'
        : 'Turn on “Builds” under Settings > General > Features to use Drive. You can skip this.',
      done: true,
    },
    {
      key: 'done',
      rail: 'Done',
      title: 'Google is set up',
      lede: 'Change any of this later under Settings > Google, or run this setup again.',
      done: true,
    },
  ];

  const onContinue = async (k: StepKey): Promise<boolean> => {
    if (k === 'calendars' && calendarOn) {
      if (ids.join(',') === calendar.config.calendarIds.join(',')) return true;
      return saveCal.mutateAsync({ ...calendar.config, calendarIds: ids }).then(
        () => true,
        () => false,
      );
    }
    return true;
  };

  const setMode = (token: boolean) =>
    saveGlobal.mutate(
      { patch: (s) => ({ ...s, google: { ...s.google, authMode: token ? 'token' : 'connect' } }) },
      { onSuccess: () => void qc.invalidateQueries() },
    );

  const saveClient = () =>
    saveCal.mutate({
      ...calendar.config,
      clientId: clientId.trim(),
      ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
    });

  const step = steps[at]!.key;
  const error = saveGlobal.error ?? saveCal.error;

  return (
    <WizardShell
      mark={['Google', 'Relay']}
      backTo="/settings#google"
      steps={steps}
      at={at}
      onAt={setAt}
      onContinue={onContinue}
      busy={saveCal.isPending}
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {describeError(error)}
          </span>
        ) : null
      }
      finished={
        <div className="flex flex-wrap gap-3">
          {calendarOn ? (
            <Button size="lg" onClick={() => navigate('/meetings')}>
              Open Meetings
            </Button>
          ) : null}
          <Button size="lg" variant="ghost" onClick={() => navigate('/settings#google')}>
            Back to Settings
          </Button>
        </div>
      }
    >
      {step === 'mode' ? (
        <div role="radiogroup" aria-label="Google mode" className="grid max-w-xl gap-2">
          <ChoiceCard
            selected={!advanced}
            onSelect={() => advanced && setMode(false)}
            title="Sign in with Google"
            badge={<span className="text-2xs text-muted-foreground">recommended</span>}
            detail="Two clicks on Google’s own page. Drive only sees the folders Relay makes."
          />
          <ChoiceCard
            selected={advanced}
            onSelect={() => !advanced && setMode(true)}
            title="My own Google Cloud (Advanced)"
            detail="Your OAuth client for Calendar, a service account for Drive (it can use Shared Drive folders)."
          />
        </div>
      ) : null}

      {step === 'calendar' && calendarOn ? (
        <div className="grid max-w-xl gap-4">
          {advanced ? (
            <>
              <Steps>
                <li>
                  In Google Cloud,{' '}
                  <ExtLink href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">
                    enable the Calendar API
                  </ExtLink>{' '}
                  and{' '}
                  <ExtLink href="https://console.cloud.google.com/auth/overview">
                    set up the consent screen
                  </ExtLink>{' '}
                  (add yourself as a test user).
                </li>
                <li>
                  <ExtLink href="https://console.cloud.google.com/auth/clients/create">
                    Create an OAuth client
                  </ExtLink>{' '}
                  of type <Ui>Desktop app</Ui>, then <Ui>Download JSON</Ui>.
                </li>
                <li>Load that file here, save, and connect.</li>
              </Steps>
              <ClientJsonLoader
                onClient={(c) => {
                  setClientId(c.clientId);
                  setSecret(c.clientSecret);
                }}
              />
              <Input
                aria-label="OAuth client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="1234…apps.googleusercontent.com"
              />
              <Input
                aria-label="OAuth client secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={calendar.clientSecretSet ? '•••••••• saved' : 'GOCSPX-…'}
              />
              <div className="grid gap-1 text-xs text-muted-foreground">
                Redirect URI (a Desktop client accepts it as is):
                <CopyLine value={calendar.redirectUri} label="redirect URI" />
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  disabled={!clientId.trim() || saveCal.isPending}
                  onClick={saveClient}
                >
                  {saveCal.isPending ? 'Saving…' : 'Save the client'}
                </Button>
                <Button
                  disabled={!calendar.config.clientId || !calendar.clientSecretSet}
                  onClick={() => connectOwn.mutate()}
                >
                  {calendar.connected ? 'Connect again' : 'Connect Calendar'}
                </Button>
              </div>
              <ErrorAlert error={connectOwn.error} />
              {calendar.connected ? (
                <p className="text-sm text-success">
                  Connected{calendar.accountEmail ? ` as ${calendar.accountEmail}` : ''}.
                </p>
              ) : null}
            </>
          ) : (
            <OAuthConnect
              provider="google"
              feature="calendar"
              what="Read-only: your meetings and the list of your calendars."
              disconnectNote="Signs Google out of Calendar and Drive together."
            />
          )}
        </div>
      ) : null}

      {step === 'calendars' && calendarOn ? (
        <div className="grid max-w-xl gap-2">
          <CalendarChecklist
            enabled={calendar.connected}
            advanced={advanced}
            value={ids}
            onChange={setIds}
          />
          <p className="text-xs text-muted-foreground">Continue saves the choice.</p>
        </div>
      ) : null}

      {step === 'drive' && buildsOn ? (
        <div className="grid max-w-xl gap-4">
          {advanced ? (
            <>
              <Steps>
                <li>
                  <ExtLink href="https://console.cloud.google.com/apis/library/drive.googleapis.com">
                    Enable the Drive API
                  </ExtLink>
                  .
                </li>
                <li>
                  <ExtLink href="https://console.cloud.google.com/iam-admin/serviceaccounts/create">
                    Create a service account
                  </ExtLink>{' '}
                  (no roles needed), open <Ui>Keys</Ui> &gt; <Ui>Add key</Ui> &gt; <Ui>JSON</Ui>.
                </li>
                <li>Choose the downloaded key here.</li>
              </Steps>
              <DriveKeyUpload />
              {driveKey?.ok ? (
                <p className="text-sm text-success">A key is in place at {driveKey.keyPath}.</p>
              ) : null}
            </>
          ) : (
            <OAuthConnect
              provider="google"
              feature="drive"
              what="Relay only sees the files and folders it makes. Each repo gets its own folder (“Relay builds · <repo>”) on its first upload: nothing to create or paste."
              disconnectNote="Signs Google out of Calendar and Drive together."
            />
          )}
          <p className="text-xs text-muted-foreground">
            Folders per repo are chosen in{' '}
            <Link to="/settings#repos" className="underline">
              Repositories
            </Link>{' '}
            (Build &amp; QA step).
          </p>
        </div>
      ) : null}

      {step === 'done' ? (
        <dl className="grid max-w-xl gap-1 text-sm">
          <Fact k="Mode" v={advanced ? 'Own Google Cloud (Advanced)' : 'Google sign-in'} />
          <Fact
            k="Calendar"
            v={
              !calendarOn
                ? 'Switched off'
                : calendar.connected
                  ? `Connected, ${ids.length} calendar${ids.length === 1 ? '' : 's'}`
                  : 'Not connected'
            }
          />
          <Fact k="Drive" v={!buildsOn ? 'Switched off' : driveReady ? 'Ready' : 'Not set up'} />
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
