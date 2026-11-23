import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { CalendarIdSchema, type CalendarStatus, type GlobalConfigPublic } from '@relay/shared';
import { Field } from '@/components/Field';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  useCalendarStatus,
  useConnectCalendar,
  useDisconnectCalendar,
  useRefreshMeetings,
  useSaveCalendarConfig,
} from '@/lib/calendarApi';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

const LEAD_CHOICES = [
  { value: 0, label: 'At the start' },
  { value: 60, label: '1 min before' },
  { value: 120, label: '2 min before' },
  { value: 300, label: '5 min before' },
];

const RANGE_CHOICES = [
  { value: 1, label: '24 hours' },
  { value: 3, label: '3 days' },
  { value: 7, label: '1 week' },
  { value: 14, label: '2 weeks' },
  { value: 31, label: '1 month' },
];

function parseIds(raw: string): { ids: string[]; bad: string | null } {
  const ids = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  const bad = ids.find((id) => !CalendarIdSchema.safeParse(id).success) ?? null;
  return { ids, bad };
}

function CopyLine({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-control border border-hairline px-2.5 py-2 font-mono text-2xs">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Copy redirect URI"
        title="Copy redirect URI"
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Google Calendar: your own OAuth client, a read-only sign-in, and how the meeting alert behaves. */
export function CalendarCard({ settings }: { settings: GlobalConfigPublic }) {
  const status = useCalendarStatus();
  return (
    <SectionCard
      id="calendar"
      title="Google Calendar"
      description="Reads your meetings (read-only) so a floating alert stays on screen while one is under way and you have not joined or dismissed it."
      action={
        status.data ? (
          <Badge variant={status.data.connected ? 'default' : 'outline'}>
            {status.data.connected ? 'Connected' : 'Not connected'}
          </Badge>
        ) : null
      }
    >
      {status.error ? <ErrorAlert error={status.error} /> : null}
      {status.data ? (
        <CalendarForm
          key={JSON.stringify([status.data.config, status.data.clientSecretSet])}
          status={status.data}
          settings={settings}
        />
      ) : null}
    </SectionCard>
  );
}

function CalendarForm({
  status,
  settings,
}: {
  status: CalendarStatus;
  settings: GlobalConfigPublic;
}) {
  const save = useSaveCalendarConfig();
  const connect = useConnectCalendar();
  const disconnect = useDisconnectCalendar();
  const refresh = useRefreshMeetings();
  const saveGlobal = useSaveGlobal();

  const [clientId, setClientId] = useState(status.config.clientId);
  const [secret, setSecret] = useState('');
  const [idsRaw, setIdsRaw] = useState(status.config.calendarIds.join(', '));
  const [lead, setLead] = useState(status.config.leadSeconds);
  const [range, setRange] = useState(status.config.lookAheadDays);
  const { ids, bad } = parseIds(idsRaw);

  const dirty =
    clientId.trim() !== status.config.clientId ||
    secret.trim() !== '' ||
    ids.join(',') !== status.config.calendarIds.join(',') ||
    lead !== status.config.leadSeconds ||
    range !== status.config.lookAheadDays;
  const clientChanges = clientId.trim() !== status.config.clientId || secret.trim() !== '';
  const ready = status.config.clientId !== '' && status.clientSecretSet;
  const featureOn = settings.features.calendar;
  const pushOn = settings.notifications.events.includes('meetingStarted');

  const onSave = () =>
    save.mutate({
      clientId: clientId.trim(),
      calendarIds: ids.length ? ids : ['primary'],
      leadSeconds: lead,
      lookAheadDays: range,
      ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
    });

  const setPush = (on: boolean) =>
    saveGlobal.mutate({
      patch: (s) => ({
        ...s,
        notifications: {
          ...s.notifications,
          events: on
            ? [...new Set([...s.notifications.events, 'meetingStarted' as const])]
            : s.notifications.events.filter((e) => e !== 'meetingStarted'),
        },
      }),
    });

  return (
    <div className="grid gap-5">
      {!featureOn ? (
        <Alert>
          <AlertTitle>Meetings is switched off</AlertTitle>
          <AlertDescription>
            Turn on “Meetings” under Settings &gt; General &gt; Features to read your calendar and
            show the alert.
          </AlertDescription>
        </Alert>
      ) : null}

      <details className="group rounded-control border border-hairline px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">
          One-time setup in Google Cloud (5 min)
        </summary>
        <ol className="mt-3 grid list-decimal gap-1.5 pl-5 text-muted-foreground">
          <li>
            Open console.cloud.google.com, pick or create a project, and enable the{' '}
            <span className="text-foreground">Google Calendar API</span>.
          </li>
          <li>
            Under <span className="text-foreground">Google Auth Platform</span>, set up the consent
            screen (External or Internal) and add yourself as a test user.
          </li>
          <li>
            Create an OAuth client of type <span className="text-foreground">Desktop app</span>.
            Copy its client ID and secret here.
          </li>
          <li>Save, then press Connect and allow read-only access.</li>
        </ol>
        <div className="mt-3 grid gap-1.5">
          <Label>Redirect URI Relay uses (desktop clients accept it as is)</Label>
          <CopyLine value={status.redirectUri} />
        </div>
      </details>

      <Field label="OAuth client ID" htmlFor="gc-client">
        <Input
          id="gc-client"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="1234…apps.googleusercontent.com"
          autoComplete="off"
        />
      </Field>
      <Field
        label="OAuth client secret"
        htmlFor="gc-secret"
        hint={
          status.clientSecretSet ? 'Saved (encrypted). Type a new one to replace it.' : undefined
        }
      >
        <Input
          id="gc-secret"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={status.clientSecretSet ? '•••••••• saved' : 'GOCSPX-…'}
          autoComplete="off"
        />
      </Field>
      <Field
        label="Calendars"
        htmlFor="gc-ids"
        error={bad ? `“${bad}” is not a calendar id.` : undefined}
        hint="“primary” is your own calendar. Add others by their id (Calendar settings > Integrate calendar), separated by commas."
      >
        <Input id="gc-ids" value={idsRaw} onChange={(e) => setIdsRaw(e.target.value)} />
      </Field>
      <div className="grid gap-2">
        <Label>Show the alert</Label>
        <div className="flex flex-wrap gap-2">
          {LEAD_CHOICES.map((c) => (
            <Button
              key={c.value}
              type="button"
              size="sm"
              variant={lead === c.value ? 'default' : 'outline'}
              aria-pressed={lead === c.value}
              onClick={() => setLead(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <Label>Meetings page shows the next</Label>
        <div className="flex flex-wrap gap-2">
          {RANGE_CHOICES.map((c) => (
            <Button
              key={c.value}
              type="button"
              size="sm"
              variant={range === c.value ? 'default' : 'outline'}
              aria-pressed={range === c.value}
              onClick={() => setRange(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </div>

      <ErrorAlert error={save.error ?? connect.error ?? disconnect.error ?? null} />

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!dirty || !!bad || save.isPending} onClick={onSave}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {status.connected ? (
          <>
            <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? 'Reading…' : 'Read now'}
            </Button>
            <Button
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={!ready || dirty || connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? 'Opening Google…' : 'Connect Google Calendar'}
          </Button>
        )}
        {dirty && clientChanges && status.connected ? (
          <span className="text-sm text-muted-foreground">
            Saving a new client disconnects the current sign-in.
          </span>
        ) : null}
        {!status.connected && !ready ? (
          <span className="text-sm text-muted-foreground">Save a client ID and secret first.</span>
        ) : null}
      </div>

      {status.connected ? (
        <p className="text-sm text-muted-foreground">
          Signed in{status.accountEmail ? ` as ${status.accountEmail}` : ''}. Last read{' '}
          <TimeAgo at={status.lastSyncAt} />.
        </p>
      ) : null}
      {status.lastError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not read the calendar</AlertTitle>
          <AlertDescription>{status.lastError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <div className="grid gap-1">
          <Label htmlFor="gc-push">Push notification when a meeting starts</Label>
          <p className="text-xs text-muted-foreground">
            Uses the browser push set up under Notifications. The floating alert shows either way.
          </p>
        </div>
        <Switch
          id="gc-push"
          checked={pushOn}
          disabled={saveGlobal.isPending}
          onCheckedChange={setPush}
        />
      </div>
    </div>
  );
}
