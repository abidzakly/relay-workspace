import { CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { GlobalConfigPublic } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useDisconnectPostrack, usePostrackStatus } from '@/lib/postrackApi';
import { cn } from '@/lib/utils';
import { PostrackConnect } from '@/postrack/PostrackConnect';
import { ErrorAlert, SectionCard } from './SectionCard';

/**
 * Postrack, the team's API workspace. Once connected, agents get the endpoints picked for a card as files and can look
 * up any other endpoint while they work. The same connect form shows in the Start dialogs, so this card is only the
 * place to check, change or drop the connection.
 */
export function PostrackCard({ settings }: { settings: GlobalConfigPublic }) {
  const status = usePostrackStatus();
  const disconnect = useDisconnectPostrack();
  const [changing, setChanging] = useState(false);
  const st = status.data;

  return (
    <SectionCard
      id="postrack"
      title="Postrack"
      description="Your Postrack API workspace: agents read the real endpoints, example responses and environments instead of guessing them."
    >
      {!settings.features.postrack && (
        <Alert>
          <AlertTitle>Postrack is switched off</AlertTitle>
          <AlertDescription>
            Turn it on under <Link to="/settings#features">General &gt; Features</Link>. You can
            connect first.
          </AlertDescription>
        </Alert>
      )}

      {st?.authMode && !changing ? (
        <div className="grid gap-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {st.connected ? (
              <CircleCheck className="size-4 text-success" aria-hidden />
            ) : (
              <CircleX className="size-4 text-destructive" aria-hidden />
            )}
            <span className={cn('font-semibold', !st.connected && 'text-destructive')}>
              {st.connected ? 'Connected' : 'Not reachable'}
            </span>
            <span className="text-muted-foreground">
              {st.authMode === 'oauth' ? 'with your Postrack account' : 'with an API key'}
              {st.connected && st.workspaces !== null
                ? ` · ${st.workspaces} workspace${st.workspaces === 1 ? '' : 's'}`
                : ''}
            </span>
          </p>
          <p className="truncate font-mono text-2xs text-muted-foreground">{st.url}</p>
          {st.error && <p className="text-xs text-destructive">{st.error}</p>}
          {st.authMode === 'apiKey' && (
            <p className="text-xs text-muted-foreground">
              An API key without <code>MCP_API_KEY_USER</code> on the server is a service account
              with access to every workspace. Signing in with your account keeps the agents to what
              you can see.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={status.isFetching}
              onClick={() => void status.refetch()}
            >
              <RefreshCw
                className={cn(status.isFetching && 'motion-safe:animate-spin')}
                aria-hidden
              />
              Test
            </Button>
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              Change
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <PostrackConnect idPrefix="settings" onConnected={() => setChanging(false)} />
          {changing && (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
      <ErrorAlert error={disconnect.error} />

      <div className="grid gap-1 border-t border-hairline pt-4 text-xs text-muted-foreground">
        <p className="type-micro text-foreground">What the agents get</p>
        <p>
          In Start card, pick the endpoints the card works with: each one goes to the agent in full,
          with the project&apos;s environments (secret values masked). Claude sessions can also look
          up any other endpoint through Relay; the Postrack credential never leaves Relay.
        </p>
        <p>
          Agents only read Postrack unless you tick &quot;Agent may update Postrack&quot; when you
          start them, and even then every change asks you first.
        </p>
      </div>
    </SectionCard>
  );
}
