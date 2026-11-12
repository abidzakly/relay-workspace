import { KeyRound, Loader2, LogIn } from 'lucide-react';
import { useState } from 'react';
import { Field } from '@/components/Field';
import { SecretInput } from '@/components/SecretInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/api';
import { useConnectPostrackOAuth, usePostrackStatus, useSavePostrackKey } from '@/lib/postrackApi';
import { useSettings } from '@/lib/settingsApi';

const URL_HINT = 'The MCP address from Postrack > Integrations, ending in /api/mcp/connect.';

const validUrl = (u: string) => {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Connects Relay to Postrack, wherever it is needed: in the Start dialogs (so nobody has to leave for Settings) and in
 * Settings > Connections. Sign-in with the Postrack account (OAuth) is the main path; an API key is for servers that
 * set `MCP_API_KEY`.
 */
export function PostrackConnect({
  idPrefix,
  disabled,
  onConnected,
}: {
  /** Keeps the field ids unique when two of these are on one page. */
  idPrefix: string;
  disabled?: boolean;
  onConnected?: () => void;
}) {
  const status = usePostrackStatus().data;
  const settingsUrl = useSettings().data?.postrack.url ?? '';
  const [url, setUrl] = useState<string | null>(null);
  const value = url ?? status?.url ?? settingsUrl;
  const [useKey, setUseKey] = useState(status?.authMode === 'apiKey');
  const [key, setKey] = useState('');
  const oauth = useConnectPostrackOAuth();
  const saveKey = useSavePostrackKey();
  const ok = validUrl(value.trim());
  const busy = disabled || oauth.state !== 'idle' || saveKey.isPending;

  return (
    <div className="grid gap-3">
      <Field
        label="Postrack MCP URL"
        htmlFor={`${idPrefix}-pt-url`}
        hint={value && !ok ? undefined : URL_HINT}
        error={value && !ok ? 'Not a web address.' : undefined}
      >
        <Input
          id={`${idPrefix}-pt-url`}
          value={value}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://postrack.example.com/api/mcp/connect"
          className="text-sm"
        />
      </Field>

      {useKey ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok || !key.trim()) return;
            saveKey.mutate(
              { url: value.trim(), apiKey: key.trim() },
              {
                onSuccess: () => {
                  setKey('');
                  onConnected?.();
                },
              },
            );
          }}
        >
          <Field
            label="API key"
            htmlFor={`${idPrefix}-pt-key`}
            hint="The server's MCP_API_KEY. Checked with Postrack before it is saved; stored encrypted."
          >
            <SecretInput
              id={`${idPrefix}-pt-key`}
              value={key}
              onChange={setKey}
              disabled={busy}
              placeholder={status?.authMode === 'apiKey' ? 'Saved. Type to replace' : ''}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !ok || !key.trim()}>
              {saveKey.isPending ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <KeyRound aria-hidden />
              )}
              {saveKey.isPending ? 'Checking…' : 'Check and save'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setUseKey(false)}
            >
              Sign in instead
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !ok}
            onClick={() => oauth.connect(value.trim(), onConnected)}
          >
            {oauth.state === 'idle' ? (
              <LogIn aria-hidden />
            ) : (
              <Loader2 className="motion-safe:animate-spin" aria-hidden />
            )}
            {oauth.state === 'waiting' ? 'Waiting for Postrack…' : 'Connect with Postrack'}
          </Button>
          {oauth.state === 'waiting' ? (
            <Button type="button" size="sm" variant="ghost" onClick={oauth.cancel}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setUseKey(true)}
            >
              Use an API key instead
            </Button>
          )}
        </div>
      )}
      {oauth.state === 'waiting' && (
        <p className="text-xs text-muted-foreground">
          Sign in and allow access in the Postrack window. This updates by itself when you are done.
        </p>
      )}
      {(oauth.error || saveKey.error) && (
        <p role="alert" className="text-xs text-destructive">
          {oauth.error ?? describeError(saveKey.error)}
        </p>
      )}
    </div>
  );
}
