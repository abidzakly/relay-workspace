import { Bell, BellOff, Send } from 'lucide-react';
import {
  NOTIFICATION_EVENTS,
  type GlobalConfigPublic,
  type NotificationEvent,
} from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useBrowserPush, useSendTestPush } from '@/lib/push';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

interface EventInfo {
  label: string;
  description: string;
  /** No rule produces it yet (later parts): the toggle is stored and honoured once one does. */
  later?: boolean;
}

const EVENT_INFO: Record<NotificationEvent, EventInfo> = {
  approved: {
    label: 'Approved by a reviewer',
    description: 'A configured reviewer approves an MR.',
  },
  comment: { label: 'New comment', description: 'Someone else starts a discussion on an MR.' },
  reply: { label: 'Reply', description: 'Someone else replies in an existing discussion.' },
  merged: { label: 'Merged', description: 'An MR is merged by someone else.' },
  pipelineFailed: {
    label: 'Pipeline failed',
    description: 'The pipeline of a tracked open MR fails.',
  },
  mismatch: {
    label: 'Sync mismatch',
    description:
      'Notion and GitLab disagree on a card (new findings only, after a short settle time).',
  },
  buildDone: {
    label: 'Upload finished',
    description: 'A staging APK reaches Drive and can be sent to QA.',
  },
  slaWarn: { label: 'SLA at 80%', description: 'A card is close to its SLA.', later: true },
  slaBreach: { label: 'SLA breached', description: 'A card passed its SLA.', later: true },
  readyForMr: {
    label: 'Branch ready for MR',
    description: "A pushed branch matches a card's Branch formula and has no MR yet.",
  },
  agentDone: {
    label: 'Agent finished',
    description: 'A cockpit agent session finished its turn or waits for your input.',
  },
  reviewRequested: {
    label: 'Review asked',
    description: 'Someone asked for your review or mentioned you on a merge request (Reviews).',
  },
};

const BROWSER_BADGE: Record<string, string> = {
  on: 'On in this browser',
  off: 'Off in this browser',
  denied: 'Blocked by the browser',
  unsupported: 'Not supported here',
  insecure: 'Needs a secure context',
  install: 'Add to Home Screen first',
  server_off: 'Server not configured',
  loading: 'Checking…',
};

/** Per-event toggles + ignoreOwn (saved at once) and the push status / test for this browser. */
export function NotificationsCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const push = useBrowserPush();
  const test = useSendTestPush();
  const enabled = new Set<NotificationEvent>(settings.notifications.events);
  const status = push.status;

  const toggle = (event: NotificationEvent, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(event);
    else next.delete(event);
    save.mutate({
      patch: (s) => ({
        ...s,
        notifications: {
          ...s.notifications,
          events: NOTIFICATION_EVENTS.filter((e) => next.has(e)),
        },
      }),
    });
  };

  return (
    <SectionCard
      id="notifications"
      title="Notifications"
      description="Web Push to this browser, even with the tab closed (the browser process must be running)."
      action={
        <Badge variant={push.kind === 'on' ? 'default' : 'secondary'}>
          {push.kind === 'on' ? <Bell className="size-3" /> : <BellOff className="size-3" />}
          {BROWSER_BADGE[push.kind]}
        </Badge>
      }
    >
      {status && !status.configured ? (
        <Alert variant="warning">
          <AlertTitle>
            {status.problem === 'vapid_invalid'
              ? 'VAPID keys are invalid'
              : 'VAPID keys are not set'}
          </AlertTitle>
          <AlertDescription>
            Run <code>pnpm push:keys</code>, paste the three lines into <code>.env</code> (set{' '}
            <code>VAPID_SUBJECT</code> to a mailto: address) and restart the server. Changing the
            keys later invalidates every browser subscription.
          </AlertDescription>
        </Alert>
      ) : null}
      {push.kind === 'install' ? (
        <Alert variant="warning">
          <AlertTitle>Install the app first</AlertTitle>
          <AlertDescription>
            On iPhone and iPad, Safari only allows notifications for web apps on the Home Screen.
            Tap <strong>Share</strong> › <strong>Add to Home Screen</strong>, open Core from the
            Home Screen, and enable notifications there.
          </AlertDescription>
        </Alert>
      ) : null}
      {push.kind === 'denied' ? (
        <Alert variant="warning">
          <AlertTitle>Notifications are blocked</AlertTitle>
          <AlertDescription>
            Allow notifications for this site in the browser’s site settings, then enable them here.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={push.kind === 'on' ? 'outline' : 'default'}
          size="sm"
          disabled={(push.kind !== 'on' && push.kind !== 'off') || push.busy}
          onClick={push.toggle}
        >
          {push.kind === 'on' ? 'Turn off in this browser' : 'Enable in this browser'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!status?.configured || (status?.subscriptions ?? 0) === 0 || test.isPending}
          onClick={() => test.mutate()}
        >
          <Send />
          {test.isPending ? 'Sending…' : 'Send test notification'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {status
            ? `${status.subscriptions} browser subscription${status.subscriptions === 1 ? '' : 's'}`
            : null}
          {status?.channels
            .filter((c) => c.name !== 'webpush')
            .map((c) => ` · ${c.name} ${c.configured ? 'on' : 'off'}`)}
        </span>
      </div>
      {push.error ? <ErrorAlert error={new Error(push.error)} /> : null}
      <ErrorAlert error={test.error} />
      {test.data ? (
        <p className="text-xs text-muted-foreground" role="status">
          Test result:{' '}
          {test.data.channels.length === 0
            ? 'no channel is configured.'
            : test.data.channels
                .map(
                  (c) =>
                    `${c.name}: ${c.sent}/${c.attempted} sent` +
                    (c.removed ? `, ${c.removed} expired subscription(s) removed` : '') +
                    (c.failed ? `, ${c.failed} failed` : ''),
                )
                .join(' · ')}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <div className="grid gap-1">
          <Label htmlFor="notif-ignore-own">Ignore my own actions</Label>
          <p className="text-xs text-muted-foreground">
            No notification for approvals, comments or merges done by{' '}
            {settings.gitlab.myUsername ? (
              <code>{settings.gitlab.myUsername}</code>
            ) : (
              'your GitLab username (set it in the GitLab section first)'
            )}
            .
          </p>
        </div>
        <Switch
          id="notif-ignore-own"
          checked={settings.notifications.ignoreOwn}
          disabled={save.isPending}
          onCheckedChange={(ignoreOwn) =>
            save.mutate({
              patch: (s) => ({ ...s, notifications: { ...s.notifications, ignoreOwn } }),
            })
          }
        />
      </div>

      <ul className="grid gap-3 border-t pt-4">
        {NOTIFICATION_EVENTS.map((event) => {
          const info = EVENT_INFO[event];
          return (
            <li key={event} className="flex items-center justify-between gap-4">
              <div className="grid gap-0.5">
                <Label htmlFor={`notif-${event}`}>
                  {info.label}
                  {info.later ? ' ' : null}
                  {info.later ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (nothing sends this yet)
                    </span>
                  ) : null}
                </Label>
                <p className="text-xs text-muted-foreground">{info.description}</p>
              </div>
              <Switch
                id={`notif-${event}`}
                checked={enabled.has(event)}
                disabled={save.isPending}
                onCheckedChange={(on) => toggle(event, on)}
              />
            </li>
          );
        })}
      </ul>
      <ErrorAlert error={save.error} />
    </SectionCard>
  );
}
