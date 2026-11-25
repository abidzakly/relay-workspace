import { useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { OAuthProvider } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Pieces for the setup help inside the settings cards: a fold for what most people never touch, numbered steps with
 * links that open the right page, and a copyable line. The steps mirror docs/CONNECT.md, so nobody has to go and
 * look up how a token or an OAuth client is made.
 */

/** A one-line value with a copy button (redirect URIs, `.env` lines). */
export function CopyLine({ value, label = 'value' }: { value: string; label?: string }) {
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
  );
}

/** A link to an outside page, opened in a new tab. */
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-4 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** Numbered setup steps. */
export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground">{children}</ol>
  );
}

/** Text the user clicks or types, as it reads on the other service's page. */
export function Ui({ children }: { children: ReactNode }) {
  return <span className="text-foreground">{children}</span>;
}

/**
 * A folded group inside a card. It stays mounted while folded, so an unsaved draft inside it survives. `open` opens it
 * from the start (a save error inside it, or the manual path is the one in use); the user can still fold it.
 */
export function Advanced({
  summary,
  open,
  className,
  children,
}: {
  summary: ReactNode;
  open?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details
      className={cn('group rounded-control border border-hairline px-4 py-3 text-sm', className)}
      open={open || undefined}
    >
      <summary className="cursor-pointer font-medium">{summary}</summary>
      <div className="mt-3 grid gap-4">{children}</div>
    </details>
  );
}

function EnvLines({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto rounded-control border border-hairline px-3 py-2 font-mono text-2xs">
      {lines.join('\n')}
    </pre>
  );
}

function RedirectUri({ value }: { value: string }) {
  return <CopyLine value={value} label="redirect URI" />;
}

const RESTART = (
  <li>
    Save <code>.env</code> in the Relay folder, then restart Relay. This card then shows the Connect
    button.
  </li>
);

/** How to register Relay as an OAuth client with each service, so its "Connect with …" button works. */
export function ConnectGuide({
  provider,
  redirectUri,
  gitlabHost,
}: {
  provider: OAuthProvider;
  redirectUri: string;
  gitlabHost?: string | undefined;
}) {
  if (provider === 'google') {
    return (
      <>
        <p className="text-muted-foreground">
          Done once by whoever runs Relay for the team; everyone then puts the same two values in
          their <code>.env</code>. One client covers Calendar and Drive.
        </p>
        <Steps>
          <li>
            Open{' '}
            <ExtLink href="https://console.cloud.google.com/projectcreate">Google Cloud</ExtLink>{' '}
            and pick or create a project.
          </li>
          <li>
            Enable the{' '}
            <ExtLink href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com">
              Google Calendar API
            </ExtLink>{' '}
            and the{' '}
            <ExtLink href="https://console.cloud.google.com/apis/library/drive.googleapis.com">
              Google Drive API
            </ExtLink>
            .
          </li>
          <li>
            Set up the{' '}
            <ExtLink href="https://console.cloud.google.com/auth/overview">consent screen</ExtLink>:{' '}
            <Ui>Internal</Ui> if your team shares one Google Workspace. Otherwise <Ui>External</Ui>,
            then under{' '}
            <ExtLink href="https://console.cloud.google.com/auth/audience">Audience</ExtLink> press{' '}
            <Ui>Publish app</Ui>: in “Testing” Google ends every sign-in after 7 days.
          </li>
          <li>
            Under{' '}
            <ExtLink href="https://console.cloud.google.com/auth/clients/create">Clients</ExtLink>,
            create a client of type <Ui>Desktop app</Ui>. It accepts Relay’s address as is:
            <div className="mt-1.5">
              <RedirectUri value={redirectUri} />
            </div>
          </li>
          <li>
            Copy its client ID and secret into <code>.env</code>:
            <div className="mt-1.5">
              <EnvLines
                lines={[
                  'GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com',
                  'GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-…',
                ]}
              />
            </div>
          </li>
          {RESTART}
        </Steps>
      </>
    );
  }

  if (provider === 'gitlab') {
    const host = gitlabHost?.replace(/\/+$/, '');
    return (
      <>
        <p className="text-muted-foreground">
          Done once; everyone then puts the same Application ID in their <code>.env</code>. No
          secret needed: Relay uses PKCE.
        </p>
        <Steps>
          <li>
            In GitLab open{' '}
            {host ? (
              <ExtLink href={`${host}/-/user_settings/applications`}>
                User settings &gt; Applications
              </ExtLink>
            ) : (
              <Ui>User settings &gt; Applications</Ui>
            )}
            {host ? (
              <>
                {' '}
                (an admin can use{' '}
                <ExtLink href={`${host}/admin/applications`}>Admin &gt; Applications</ExtLink> so it
                belongs to the instance)
              </>
            ) : null}
            .
          </li>
          <li>
            Add a new application: name <Ui>Relay</Ui>, <Ui>Confidential</Ui> off, scope{' '}
            <code>api</code>, and this redirect URI:
            <div className="mt-1.5">
              <RedirectUri value={redirectUri} />
            </div>
          </li>
          <li>
            Copy the <Ui>Application ID</Ui> into <code>.env</code> (if you left Confidential on,
            also set <code>GITLAB_OAUTH_CLIENT_SECRET</code>):
            <div className="mt-1.5">
              <EnvLines lines={['GITLAB_OAUTH_CLIENT_ID=…']} />
            </div>
          </li>
          {RESTART}
        </Steps>
      </>
    );
  }

  return (
    <>
      <p className="text-muted-foreground">
        Done once; everyone then puts the same two values in their <code>.env</code>. Share the
        secret only with your team, and never commit it.
      </p>
      <Steps>
        <li>
          Open{' '}
          <ExtLink href="https://www.notion.so/profile/integrations">Notion integrations</ExtLink>{' '}
          and create a new integration of type <Ui>Public</Ui>.
        </li>
        <li>
          Fill in the required fields (name, website, privacy and terms links: your company’s pages
          will do).
        </li>
        <li>
          Set the redirect URI to:
          <div className="mt-1.5">
            <RedirectUri value={redirectUri} />
          </div>
          If Notion refuses <code>127.0.0.1</code>, use the same address with <code>localhost</code>{' '}
          and also set <code>NOTION_OAUTH_REDIRECT_URI</code> to it in <code>.env</code>.
        </li>
        <li>
          Copy the <Ui>OAuth client ID</Ui> and <Ui>OAuth client secret</Ui> into <code>.env</code>:
          <div className="mt-1.5">
            <EnvLines lines={['NOTION_OAUTH_CLIENT_ID=…', 'NOTION_OAUTH_CLIENT_SECRET=…']} />
          </div>
        </li>
        {RESTART}
      </Steps>
    </>
  );
}
