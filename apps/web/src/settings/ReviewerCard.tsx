import { useState } from 'react';
import { Check, Copy, Radio, Webhook } from 'lucide-react';
import { Link } from 'react-router';
import type { GlobalConfigPublic } from '@relay/shared';
import { Field } from '@/components/Field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TimeAgo } from '@/components/TimeAgo';
import {
  useReviewDesk,
  useReviewToken,
  useRevealWebhookSecret,
  useSaveReviewToken,
} from '@/lib/reviewsApi';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-control border border-hairline px-2.5 py-2 font-mono text-2xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Reviews' personal GitLab token, the Reviews webhook and the poll switch. The token reads any project I can see
 * (`read_api`), or also comments and approves (`api`). It is checked against GitLab before it is saved, encrypted at
 * rest, and never sent back to the browser.
 */
export function ReviewerCard({ settings }: { settings: GlobalConfigPublic }) {
  const token = useReviewToken();
  const saveToken = useSaveReviewToken();
  const desk = useReviewDesk(settings.features.reviews && token.data?.tokenSet === true).data;
  const reveal = useRevealWebhookSecret();
  const saveGlobal = useSaveGlobal();
  const [value, setValue] = useState('');
  const status = token.data;
  const hostMissing = !settings.gitlab.host;

  return (
    <SectionCard
      id="reviewer"
      title="Reviewer access"
      description="A personal GitLab token for Reviews: merge requests in any project where you are a reviewer or were mentioned."
    >
      {!settings.features.reviews && (
        <Alert>
          <AlertTitle>Reviews is switched off</AlertTitle>
          <AlertDescription>
            Turn it on under <Link to="/settings#features">General &gt; Features</Link>. You can
            save the token first.
          </AlertDescription>
        </Alert>
      )}

      {status?.tokenSet ? (
        <div className="grid gap-3">
          <p className="text-sm">
            Signed in as <span className="font-semibold">@{status.username ?? 'unknown'}</span>
            {status.name ? <span className="text-muted-foreground"> ({status.name})</span> : null}
            {status.expiresAt ? (
              <span className="text-muted-foreground"> · expires {status.expiresAt}</span>
            ) : null}
          </p>
          {!status.canWrite && (
            <Alert variant="warning">
              <AlertTitle>Read only</AlertTitle>
              <AlertDescription>
                This token has <code>read_api</code> only: you can read reviews, but comments,
                replies and approvals need a token with the <code>api</code> scope.
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={saveToken.isPending}
              onClick={() => saveToken.mutate(null)}
            >
              Remove token
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) saveToken.mutate(value.trim(), { onSuccess: () => setValue('') });
          }}
        >
          <Field
            label="Personal access token"
            htmlFor="rv-token"
            hint={
              hostMissing
                ? 'Set the GitLab host above first.'
                : 'GitLab > Preferences > Access tokens. Scope read_api to read, api to also comment and approve.'
            }
          >
            <Input
              id="rv-token"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="glpat-…"
            />
          </Field>
          <div>
            <Button type="submit" disabled={!value.trim() || hostMissing || saveToken.isPending}>
              {saveToken.isPending ? 'Checking…' : 'Check and save'}
            </Button>
          </div>
        </form>
      )}
      <ErrorAlert error={saveToken.error} />

      <div className="grid gap-3 border-t border-hairline pt-4">
        <p className="flex items-center gap-2 type-micro text-foreground">
          <Webhook className="size-3.5" aria-hidden /> Instant updates (webhooks)
        </p>
        <p className="text-xs text-muted-foreground">
          Your configured repos already send webhooks, so their reviews arrive instantly. For other
          projects, add the Reviews webhook to the GitLab group (needs Owner) or project (needs
          Maintainer): Settings &gt; Webhooks, with <em>Comments</em> and{' '}
          <em>Merge request events</em> ticked.
        </p>
        {desk?.webhook.url ? (
          <>
            <CopyValue label="Webhook URL" value={desk.webhook.url} />
            {reveal.data ? (
              <CopyValue label="Secret token" value={reveal.data.secret} />
            ) : (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reveal.isPending}
                  onClick={() => reveal.mutate()}
                >
                  {desk.webhook.secretSet ? 'Show secret token' : 'Create secret token'}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {desk.webhook.lastDeliveryAt ? (
                <>
                  Last delivery <TimeAgo at={desk.webhook.lastDeliveryAt} />.
                </>
              ) : (
                'No delivery from the Reviews webhook yet.'
              )}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Set the public base URL above to get the webhook address.
          </p>
        )}
        <ErrorAlert error={reveal.error} />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-hairline pt-4">
        <div className="grid gap-1">
          <Label htmlFor="rv-poll" className="flex items-center gap-2">
            <Radio className="size-3.5" aria-hidden /> Check other projects every minute
          </Label>
          <p className="text-xs text-muted-foreground">
            For projects no webhook reaches, one small to-do check a minute. Projects with a working
            webhook are never polled. Off: those projects update only when you press Refresh.
          </p>
        </div>
        <Switch
          id="rv-poll"
          checked={settings.reviews.poll}
          disabled={saveGlobal.isPending}
          onCheckedChange={(poll) =>
            saveGlobal.mutate({ patch: (s) => ({ ...s, reviews: { ...s.reviews, poll } }) })
          }
        />
      </div>
      <ErrorAlert error={saveGlobal.error} />
    </SectionCard>
  );
}
