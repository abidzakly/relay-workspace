import { useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import type { GlobalConfigPublic, PublicUrlCheck, WebhookHealthRepo } from '@relay/shared';
import { TimeAgo } from '@/components/TimeAgo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCheckPublicUrl, useRegisterWebhooks, useWebhookHealth } from '@/lib/webhookApi';
import { ErrorAlert, SectionCard } from './SectionCard';

const CHECK_TEXT: Record<
  PublicUrlCheck['state'],
  { title: string; variant: 'success' | 'warning' | 'destructive'; hint: string }
> = {
  reachable: {
    title: 'Reachable',
    variant: 'success',
    hint: 'The webhook listener answered through the public URL.',
  },
  tunnel_error: {
    title: 'The tunnel answered with an error',
    variant: 'destructive',
    hint: 'Check that the ngrok agent is running and points at the webhook port.',
  },
  unexpected: {
    title: 'Something else answered',
    variant: 'warning',
    hint: 'The address responds, but not like the webhook listener. Check where the tunnel points.',
  },
  unreachable: {
    title: 'No answer',
    variant: 'destructive',
    hint: 'Check the public URL, and that ngrok is running.',
  },
  not_configured: {
    title: 'No usable public URL',
    variant: 'warning',
    hint: 'Set an https public URL under GitLab first.',
  },
};

function CheckResult({ check }: { check: PublicUrlCheck }) {
  const text = CHECK_TEXT[check.state];
  const facts = [
    check.host,
    check.httpStatus !== null ? `HTTP ${check.httpStatus}` : null,
    check.detail,
  ].filter(Boolean);
  return (
    <Alert variant={text.variant}>
      <AlertTitle>{text.title}</AlertTitle>
      <AlertDescription>
        {text.hint}
        {facts.length > 0 && <span className="block text-xs">{facts.join(' · ')}</span>}
        <span className="block text-xs">
          Checked <TimeAgo at={check.checkedAt} />
        </span>
      </AlertDescription>
    </Alert>
  );
}

function RepoRow({ repo, onRegister }: { repo: WebhookHealthRepo; onRegister: () => void }) {
  const last = repo.lastEvent;
  return (
    <tr className="border-t align-top">
      <td className="py-2 pr-3 font-medium">{repo.name}</td>
      <td className="py-2 pr-3 whitespace-nowrap">
        <TimeAgo at={last?.receivedAt} />
        {last && <span className="block text-xs text-muted-foreground">{last.objectKind}</span>}
      </td>
      <td className="py-2 pr-3">
        {last ? (
          <Badge variant={last.status === 'failed' ? 'destructive' : 'outline'}>
            {last.status}
          </Badge>
        ) : (
          <span className="text-muted-foreground">None yet</span>
        )}
        {last?.error && (
          <span className="mt-1 block text-xs break-words text-destructive">{last.error}</span>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {repo.last24h.total}
        {repo.last24h.failed > 0 && (
          <span className="text-destructive"> ({repo.last24h.failed} failed)</span>
        )}
      </td>
      <td className="py-2 text-right">
        <Button variant="outline" size="sm" onClick={onRegister}>
          Register
        </Button>
      </td>
    </tr>
  );
}

/** Webhook health panel. Reading it stays local; the two buttons are the only outbound actions. */
export function WebhookHealthCard({ settings }: { settings: GlobalConfigPublic }) {
  const health = useWebhookHealth();
  const check = useCheckPublicUrl();
  const register = useRegisterWebhooks();
  /** `undefined` = closed, `null` = every repo. */
  const [target, setTarget] = useState<WebhookHealthRepo | null | undefined>(undefined);

  const repos = health.data?.repos ?? [];
  const urlProblem = health.data?.publicUrlProblem ?? null;

  const open = (next: WebhookHealthRepo | null) => {
    register.reset();
    setTarget(next);
  };

  return (
    <SectionCard
      id="webhooks"
      title="Webhook health"
      description="Last delivery per repo, from the local database. Polling still covers anything a webhook misses."
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
            <Radio />
            {check.isPending ? 'Checking…' : 'Check public URL'}
          </Button>
          <Button
            variant="outline"
            disabled={repos.length === 0 || urlProblem !== null}
            onClick={() => open(null)}
          >
            <RefreshCw />
            Re-register all
          </Button>
        </div>
      }
    >
      {urlProblem && (
        <Alert variant="warning">
          <AlertDescription>
            {urlProblem === 'public_url_missing'
              ? 'Set the public URL (your ngrok https domain) before registering webhooks.'
              : 'The public URL must be https, as the webhook token is sent in a header.'}
          </AlertDescription>
        </Alert>
      )}
      {check.data && <CheckResult check={check.data} />}
      <ErrorAlert error={check.error} />
      {health.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ErrorAlert error={health.error} />
      {health.isSuccess && repos.length === 0 && (
        <p className="text-sm text-muted-foreground">No repositories yet.</p>
      )}
      {repos.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pr-3 pb-2 font-medium">Repo</th>
                <th className="pr-3 pb-2 font-medium">Last received</th>
                <th className="pr-3 pb-2 font-medium">Status</th>
                <th className="pr-3 pb-2 font-medium">24 h</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <RepoRow key={r.repoId} repo={r} onRegister={() => open(r)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={target !== undefined}
        onOpenChange={(isOpen) => {
          if (!isOpen && !register.isPending) setTarget(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {target ? `Register the webhook for ${target.name}?` : 'Re-register all webhooks?'}
            </DialogTitle>
            <DialogDescription>
              {settings.dryRun
                ? 'Dry-run is on: GitLab is not called, and Audit records what would have happened.'
                : target
                  ? 'This creates or updates the project hook in GitLab and re-sends its secret token (fixes deliveries rejected with HTTP 401). The change is recorded in Audit.'
                  : 'This creates or updates project hooks in GitLab. A hook that already looks correct is left alone (use a repo’s own Register to re-send its secret). Each change is recorded in Audit.'}
            </DialogDescription>
          </DialogHeader>
          {register.data && (
            <ul className="grid gap-1 text-sm">
              {register.data.map((r) => (
                <li key={r.repoId} className="break-words">
                  <span className="font-medium">{r.repoId}</span>: {r.outcome}
                  {r.dryRun && r.outcome !== 'failed' ? ' (dry-run)' : ''}
                  {r.error && <span className="text-destructive"> {r.error.message}</span>}
                </li>
              ))}
            </ul>
          )}
          <ErrorAlert error={register.error} />
          <DialogFooter>
            {register.data ? (
              <Button onClick={() => setTarget(undefined)}>Close</Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={register.isPending}
                  onClick={() => setTarget(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={register.isPending || target === undefined}
                  onClick={() => {
                    if (target !== undefined) register.mutate(target ? target.repoId : null);
                  }}
                >
                  {register.isPending ? 'Working…' : 'Register'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
