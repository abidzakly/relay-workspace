import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { AiEngine } from '@relay/shared';
import { useAgentModels, useAiStatus } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';

/** The engines in the order AI actions try them (see AiService.run). */
const CHAIN: { engine: AiEngine; name: string; role: string }[] = [
  { engine: 'claude_cli', name: 'Claude CLI', role: 'First choice' },
  { engine: 'anthropic_api', name: 'Anthropic API', role: 'Fallback' },
  { engine: 'cursor_cli', name: 'Cursor CLI', role: 'Last resort' },
];

/**
 * The fallback chain as three tiles, the one answering now marked. A failing engine (for example a spent Claude usage
 * limit) hands the request to the next tile.
 */
export function AiEngineChain() {
  const status = useAiStatus();
  const now = status.data?.engine;
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
        {CHAIN.map((c, i) => {
          const active = now === c.engine;
          return (
            <Fragment key={c.engine}>
              {i > 0 && (
                <li aria-hidden className="hidden place-items-center text-muted-foreground sm:grid">
                  <ChevronRight className="size-4" />
                </li>
              )}
              <li
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'grid gap-1 rounded-surface border px-4 py-3 transition-colors',
                  active
                    ? 'border-[color-mix(in_oklch,var(--brand)_45%,transparent)] bg-[color-mix(in_oklch,var(--brand)_8%,var(--card))]'
                    : 'border-hairline',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 rounded-full',
                      active ? 'bg-success' : 'border border-muted-foreground/50',
                    )}
                  />
                  {c.name}
                </span>
                <span className="font-mono text-micro tracking-[0.06em] text-muted-foreground uppercase">
                  {active ? 'Answering now' : c.role}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        {!status.data
          ? 'Checking which engine answers…'
          : now === 'none'
            ? 'No engine is available, so AI features are off.'
            : 'Each AI action tries the engines left to right.'}
        {status.data?.reason ? ` ${status.data.reason}.` : ''} <PlanLine />
      </p>
    </div>
  );
}

const TIER_NAME: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
};
const tierName = (t: string) => TIER_NAME[t.toLowerCase()] ?? t;

/** The local logins' plans, which decide the models offered. */
function PlanLine() {
  const q = useAgentModels();
  const c = q.data;
  if (!c || q.isPlaceholderData) return null;
  const parts = [
    c.accounts.claude?.tier
      ? `Claude ${tierName(c.accounts.claude.tier)}`
      : c.accounts.claude?.authMethod
        ? 'Claude (API key)'
        : null,
    c.accounts.cursor?.tier ? `Cursor ${tierName(c.accounts.cursor.tier)}` : null,
  ].filter(Boolean);
  return (
    <>
      {parts.length > 0
        ? `Models offered for your plans: ${parts.join(' · ')}.`
        : 'Could not read your Claude or Cursor plan, so every known model is offered.'}{' '}
      {c.source === 'live'
        ? 'Cursor models come live from your Cursor CLI.'
        : 'Cursor models are the built-in list.'}
    </>
  );
}
