import { ChevronDown, Loader2, Waypoints } from 'lucide-react';
import { useState } from 'react';
import type { CardStartPostrackInput } from '@relay/shared';
import { useFeatures } from '@/lib/features';
import { usePostrackStatus } from '@/lib/postrackApi';
import { cn } from '@/lib/utils';
import { EndpointPicker, type PostrackPick } from './EndpointPicker';
import { PostrackConnect } from './PostrackConnect';

/** The pick as the card-start API takes it; undefined when there is nothing to send (the defaults apply). */
export function postrackRequest(p: PostrackPick): CardStartPostrackInput | undefined {
  if (p.endpoints.length === 0 && !p.write) return undefined;
  return {
    endpointIds: p.endpoints.map((e) => e.id),
    ...(p.projectId ? { projectId: p.projectId } : {}),
    write: p.write,
  };
}

/** "Agent may update Postrack": off by default, and every change still asks in the session. */
export function PostrackWriteToggle({
  id,
  checked,
  onChange,
  disabled,
  cursor,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  cursor?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-xs">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled || cursor}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="grid gap-0.5">
        <span className="font-medium text-foreground">Agent may update Postrack</span>
        <span className="text-muted-foreground">
          {cursor
            ? 'Claude only: Cursor gets the endpoint files, not the Postrack tools.'
            : 'For backend work: it can add or fix endpoints, examples and variables after the code is done. Each change asks you first. Off: it only reads, and lists what Postrack needs in its report.'}
        </span>
      </span>
    </label>
  );
}

/**
 * The Postrack part of a card brief. Not connected: connect right here. Connected: pick the endpoints the card works
 * with. Hidden while the Postrack feature is off.
 */
export function PostrackBrief({
  relayWorkspaceId,
  agent,
  value,
  onChange,
  disabled,
}: {
  relayWorkspaceId: string;
  agent: 'claude' | 'cursor';
  value: PostrackPick;
  onChange: (v: PostrackPick) => void;
  disabled?: boolean;
}) {
  const on = useFeatures().postrack;
  const status = usePostrackStatus(on);
  const [open, setOpen] = useState(value.endpoints.length > 0);
  if (!on) return null;
  const st = status.data;
  const connected = st?.connected === true;
  const summary = status.isPending
    ? 'Checking the connection…'
    : !connected
      ? st?.authMode
        ? 'Not reachable: connect again.'
        : 'Not connected yet.'
      : value.endpoints.length > 0
        ? `${value.endpoints.length} endpoint${value.endpoints.length === 1 ? '' : 's'} picked${value.write ? ' · may update Postrack' : ''}`
        : agent === 'claude'
          ? 'None picked. The agent can still look endpoints up.'
          : 'None picked.';

  return (
    <section className="rounded-surface border border-hairline">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Waypoints className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">API endpoints from Postrack (optional)</span>
          <span className="block text-xs text-muted-foreground">{summary}</span>
        </span>
        {status.isPending ? (
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
        ) : (
          <ChevronDown
            className={cn('size-4 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        )}
      </button>
      {open && (
        <div className="grid gap-3 border-t border-hairline px-3 py-3">
          {!connected ? (
            <>
              <p className="text-xs text-muted-foreground">
                {st?.error ??
                  'Connect once and the agent reads the real requests and responses of the endpoints you pick, instead of guessing them.'}
              </p>
              <PostrackConnect idPrefix="brief" disabled={disabled} />
            </>
          ) : (
            <>
              <EndpointPicker
                relayWorkspaceId={relayWorkspaceId}
                value={value}
                onChange={onChange}
                disabled={disabled}
              />
              <p className="text-xs text-muted-foreground">
                The agent gets every picked endpoint in full (headers, params, body, auth, example
                responses) and the project&apos;s environments, with secrets masked.
                {agent === 'claude'
                  ? ' It can also look up any other endpoint in Postrack while it works.'
                  : ''}
              </p>
              <PostrackWriteToggle
                id={`pt-write-${relayWorkspaceId}`}
                checked={value.write && agent === 'claude'}
                onChange={(write) => onChange({ ...value, write })}
                disabled={disabled}
                cursor={agent === 'cursor'}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
