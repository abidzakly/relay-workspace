import type { GoogleFeature, OAuthProvider, OAuthStatus } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { useConnect } from '@/lib/oauthApi';
import { ErrorAlert } from './SectionCard';

const NAMES: Record<OAuthProvider, string> = {
  google: 'Google',
  gitlab: 'GitLab',
  notion: 'Notion',
};

function isConnected(s: OAuthStatus, provider: OAuthProvider, feature?: GoogleFeature): boolean {
  const c = s[provider];
  return provider === 'google' && feature ? c.features.includes(feature) : c.connected;
}

/**
 * The "Connect with …" row of a settings card: one click opens the provider's own sign-in page, the user signs in with
 * their own account, and the card shows the connection as soon as it lands. Nothing to copy or paste.
 */
export function OAuthConnect({
  provider,
  feature,
  what,
  disconnectNote,
}: {
  provider: OAuthProvider;
  /** Google only: what this card asks access for. */
  feature?: GoogleFeature;
  /** What the sign-in is used for, shown under the button. */
  what: string;
  /** Shown next to Disconnect (e.g. that Google signs out Calendar and Drive together). */
  disconnectNote?: string;
}) {
  const { status, start, disconnect, waiting } = useConnect(provider, (s) =>
    isConnected(s, provider, feature),
  );
  const s = status.data;
  if (!s) return status.error ? <ErrorAlert error={status.error} /> : null;
  const c = s[provider];
  const name = NAMES[provider];
  const connected = isConnected(s, provider, feature);

  if (!c.available && !c.connected) {
    return (
      <div className="rounded-control border border-dashed border-hairline px-4 py-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Connect with {name}</span> ·{' '}
        {c.unavailableReason}
      </div>
    );
  }

  return (
    <div className="grid gap-2 rounded-control border border-hairline px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {connected ? (
          <>
            <span className="text-sm">
              Connected with {name}
              {c.account ? (
                <>
                  {' '}
                  as <span className="font-medium">{c.account}</span>
                </>
              ) : null}
              .
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
            {disconnectNote ? (
              <span className="text-xs text-muted-foreground">{disconnectNote}</span>
            ) : null}
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={!c.available || start.isPending}
              onClick={() => start.mutate(feature)}
            >
              {start.isPending
                ? `Opening ${name}…`
                : c.connected && feature
                  ? `Allow ${name} ${feature === 'drive' ? 'Drive' : 'Calendar'}`
                  : `Connect with ${name}`}
            </Button>
            {waiting ? (
              <span className="text-sm text-muted-foreground">
                Waiting for you to sign in in the {name} tab…
              </span>
            ) : null}
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{what}</p>
      {c.lastError && !connected ? <p className="text-xs text-destructive">{c.lastError}</p> : null}
      <ErrorAlert error={start.error ?? disconnect.error ?? null} />
    </div>
  );
}
