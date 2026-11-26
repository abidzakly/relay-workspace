import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { PickRow, PickTag } from '@/components/PickRow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConnectCalendar } from '@/lib/calendarApi';
import { useCalendarList, useDriveFolders, useUploadDriveKey } from '@/lib/googleSetupApi';
import { useConnect } from '@/lib/oauthApi';
import { ErrorAlert } from './SectionCard';
import { CopyLine, ExtLink } from './SetupGuide';

/**
 * Pieces the Google setup and the Google card share: the calendars as a checklist, the service-account key as a file
 * pick, the OAuth client read from its downloaded JSON, and the folders a service account can see.
 */

/** Reads a picked file as text (a key or client JSON is a few KB). */
function readText(file: File): Promise<string> {
  return file.size > 64 * 1024 ? Promise.reject(new Error('That file is too large.')) : file.text();
}

function FilePick({
  label,
  busy,
  onText,
}: {
  label: string;
  busy?: boolean;
  onText: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setError(null);
          readText(f).then(onText, (err: Error) => setError(err.message));
        }}
      />
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <FileUp aria-hidden />
          {busy ? 'Reading…' : label}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * The account's calendars to tick. `advanced`: the sign-in is the own OAuth client. When the sign-in predates the
 * calendar-list permission, one button asks Google for it.
 */
export function CalendarChecklist({
  enabled,
  advanced,
  value,
  onChange,
}: {
  enabled: boolean;
  advanced: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const list = useCalendarList(enabled);
  const relay = useConnect('google', (s) => s.google.features.includes('calendar'));
  const own = useConnectCalendar();
  const primaryId = list.data?.calendars.find((c) => c.primary)?.id;
  // "primary" and the primary calendar's own id are the same calendar.
  const has = (id: string) => value.includes(id) || (id === primaryId && value.includes('primary'));
  const toggle = (id: string) => {
    const isPrimary = id === primaryId;
    const without = value.filter((v) => v !== id && !(isPrimary && v === 'primary'));
    onChange(has(id) ? without : [...without, isPrimary ? 'primary' : id]);
  };

  if (!enabled) return null;
  if (list.error) return <ErrorAlert error={list.error} />;
  if (!list.data) return <p className="text-sm text-muted-foreground">Reading your calendars…</p>;
  if (list.data.needsConsent) {
    return (
      <div className="grid gap-2 rounded-control border border-hairline px-4 py-3 text-sm">
        <p>
          Let Relay see the list of your calendars, so you tick them instead of copying their ids.
          Google asks once; it covers names and ids only.
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            onClick={() => (advanced ? own.mutate() : relay.start.mutate('calendar'))}
          >
            Allow the calendar list
          </Button>
        </div>
        <ErrorAlert error={own.error ?? relay.start.error} />
      </div>
    );
  }
  return (
    <ul className="grid gap-1.5">
      {list.data.calendars.map((c) => (
        <li key={c.id}>
          <PickRow
            size="sm"
            selected={has(c.id)}
            onSelect={() => toggle(c.id)}
            pickedLabel="Read"
            leading={
              <span
                className="block size-3 rounded-full"
                style={{ background: c.color ?? 'var(--color-muted-foreground)' }}
              />
            }
            title={c.summary}
            meta={c.primary ? 'Your own calendar' : c.id}
            trailing={c.primary ? <PickTag em>primary</PickTag> : null}
          />
        </li>
      ))}
    </ul>
  );
}

/** Pick the downloaded service-account key; Relay stores it at the key path and shows who to share folders with. */
export function DriveKeyUpload({ onDone }: { onDone?: (clientEmail: string) => void }) {
  const upload = useUploadDriveKey();
  return (
    <div className="grid gap-2">
      <FilePick
        label="Choose the key file (.json)"
        busy={upload.isPending}
        onText={(json) => upload.mutate(json, { onSuccess: (r) => onDone?.(r.clientEmail) })}
      />
      <ErrorAlert error={upload.error} />
      {upload.data ? (
        <div className="grid gap-1.5 text-sm">
          <p className="text-success">
            Key saved (readable by you only). Share each Drive folder with this account as{' '}
            <span className="text-foreground">Editor</span>:
          </p>
          <CopyLine value={upload.data.clientEmail} label="service account email" />
          <p className="text-xs text-muted-foreground">
            Open the folder in{' '}
            <ExtLink href="https://drive.google.com/drive/shared-drives">Drive</ExtLink>, press
            Share, paste the address.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Fill the OAuth client ID and secret from the JSON Google offers to download when the client is made. */
export function ClientJsonLoader({
  onClient,
}: {
  onClient: (c: { clientId: string; clientSecret: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5">
      <FilePick
        label="Load from the downloaded client file"
        onText={(text) => {
          setError(null);
          try {
            const j = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
            const c = j.installed ?? j.web;
            const clientId = typeof c?.client_id === 'string' ? c.client_id : '';
            const clientSecret = typeof c?.client_secret === 'string' ? c.client_secret : '';
            if (!clientId || !clientSecret) throw new Error('no client');
            onClient({ clientId, clientSecret });
          } catch {
            setError(
              'That is not an OAuth client file. In Google Cloud, open the client and use Download JSON.',
            );
          }
        }}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Folders the service account can see (Advanced mode), to pick one for a repo. */
export function DriveFolderList({
  value,
  onPick,
}: {
  value: string;
  onPick: (id: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const list = useDriveFolders(search, true);
  return (
    <div className="grid gap-2">
      <Input
        aria-label="Search Drive folders"
        placeholder="Search folders shared with the service account…"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      {list.error ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        list.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No folder yet: share one with the service account as Editor, then search again.
          </p>
        ) : (
          <ul className="grid max-h-48 gap-1.5 overflow-y-auto p-0.5">
            {list.data.map((f) => (
              <li key={f.id}>
                <PickRow
                  size="sm"
                  selected={f.id === value}
                  onSelect={() => onPick(f.id)}
                  title={f.name}
                  meta={f.id}
                  trailing={f.driveId ? <PickTag>Shared Drive</PickTag> : null}
                />
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Reading Drive…</p>
      )}
    </div>
  );
}
