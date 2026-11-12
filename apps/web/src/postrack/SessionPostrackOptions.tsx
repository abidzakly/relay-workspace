import { Waypoints } from 'lucide-react';
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useFeatures } from '@/lib/features';
import { usePostrackStatus } from '@/lib/postrackApi';
import { PostrackConnect } from './PostrackConnect';
import { PostrackWriteToggle } from './PostrackBrief';

export interface SessionPostrack {
  on: boolean;
  write: boolean;
}

export const DEFAULT_SESSION_POSTRACK: SessionPostrack = { on: true, write: false };

/** What a new Claude session asks for: `false` = no Postrack tools, else read (and maybe write). */
export const sessionPostrackRequest = (p: SessionPostrack) =>
  p.on ? { write: p.write } : (false as const);

/**
 * Postrack for a plain Claude session (Cockpit > New session): on by default once connected, read only unless the
 * user ticks writes. Not connected: a Connect right here.
 */
export function SessionPostrackOptions({
  value,
  onChange,
  disabled,
}: {
  value: SessionPostrack;
  onChange: (v: SessionPostrack) => void;
  disabled?: boolean;
}) {
  const on = useFeatures().postrack;
  const status = usePostrackStatus(on);
  const [connecting, setConnecting] = useState(false);
  if (!on) return null;
  const connected = status.data?.connected === true;

  return (
    <div className="grid gap-2 rounded-surface border border-hairline px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="ns-postrack" className="flex items-center gap-2">
          <Waypoints className="size-3.5" aria-hidden /> Postrack tools for Claude
        </Label>
        {connected ? (
          <Switch
            id="ns-postrack"
            checked={value.on}
            disabled={disabled}
            onCheckedChange={(c) => onChange({ ...value, on: c })}
          />
        ) : (
          <button
            type="button"
            className="text-xs underline underline-offset-4"
            onClick={() => setConnecting((c) => !c)}
          >
            {connecting ? 'Hide' : 'Connect'}
          </button>
        )}
      </div>
      {connected ? (
        value.on && (
          <PostrackWriteToggle
            id="ns-postrack-write"
            checked={value.write}
            onChange={(write) => onChange({ ...value, write })}
            disabled={disabled}
          />
        )
      ) : connecting ? (
        <PostrackConnect
          idPrefix="session"
          disabled={disabled}
          onConnected={() => setConnecting(false)}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {status.isPending
            ? 'Checking the connection…'
            : 'Not connected. Claude starts without the Postrack tools.'}
        </p>
      )}
    </div>
  );
}
