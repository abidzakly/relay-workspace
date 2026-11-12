import type { KpiCardRow, StateMr } from '@relay/shared';
import { useState } from 'react';
import {
  CornerDownRight,
  ExternalLink,
  Lightbulb,
  Link2,
  type LucideIcon,
  Rocket,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router';
import { Badge, MrStateBadge, SeverityBadge, WaitingBadge } from '@/components/Badge';
import { TimeAgo } from '@/components/TimeAgo';
import { RepoName } from '@/components/RepoMark';
import { ConfirmWriteDialog } from '@/components/ConfirmWriteDialog';
import { FixButtons } from '@/components/FixButtons';
import { Dropdown } from '@/components/Dropdown';
import { Button } from '@/components/ui/button';
import { SlaSlot } from '@/kpi/SlaSlot';
import { EffortChip } from '@/components/EffortChip';
import type { WriteRequest } from '@/lib/cardApi';
import { useSettings } from '@/lib/settingsApi';
import { cn, safeHref } from '@/lib/utils';
import type { CardTileModel, LinkKind, OrphanMrModel } from './model';

/** The agent action per Board column; columns not listed have none. */
const AGENT_LABEL: Partial<Record<CardTileModel['column'], string>> = {
  Backlog: 'Start early with agent',
  'Next Up': 'Start with agent',
  'In Progress': 'Continue with agent',
};

const tileTone = (severity: CardTileModel['severity']): string =>
  severity === 'critical'
    ? 'border-destructive/60'
    : severity === 'warn' || severity === 'action'
      ? 'border-warning/60'
      : '';

const LINK_CHIP: Record<
  LinkKind,
  {
    icon: LucideIcon;
    label: string;
    variant: 'success' | 'warning' | 'destructive' | 'secondary';
    hint: string;
  } | null
> = {
  strong: {
    icon: Link2,
    label: 'strong link',
    variant: 'success',
    hint: 'Title key and description key agree on this card',
  },
  weak_title: {
    icon: Link2,
    label: 'weak link · title only',
    variant: 'warning',
    hint: 'Matched by the MR title only; the MR description has no Notion link',
  },
  weak_description: {
    icon: Link2,
    label: 'weak link · description only',
    variant: 'warning',
    hint: 'Matched by the MR description only; the MR title is not the branch name',
  },
  manual: {
    icon: Link2,
    label: 'manual link',
    variant: 'secondary',
    hint: 'Confirmed by hand in the linker',
  },
  mismatch: {
    icon: TriangleAlert,
    label: 'link mismatch',
    variant: 'destructive',
    hint: 'The MR title and description point to different cards',
  },
  duplicate: {
    icon: TriangleAlert,
    label: 'duplicate MR',
    variant: 'warning',
    hint: 'More than one live MR for this card; resolve it in Notion/GitLab',
  },
  none: null,
};

function MrTimingLine({ mr }: { mr: StateMr }) {
  const t = mr.timing;
  const open = t.openFor;
  const done = t.finishedAfter;
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {t.phase === 'open' && open && (
        <span
          className={cn(
            'font-medium',
            open.level === 'red' && 'text-destructive',
            open.level === 'amber' && 'text-warning',
          )}
        >
          open {open.label}
        </span>
      )}
      {t.phase !== 'open' && done && (
        <span>
          {done.kind} after {done.approx ? '~' : ''}
          {done.label}
        </span>
      )}
      {t.lastComment && (
        <span>
          last comment <TimeAgo at={t.lastComment.at} />
          {t.lastComment.by ? ` by @${t.lastComment.by}` : ''}
        </span>
      )}
    </div>
  );
}

/** "Move to…": a manual status change. Picking a status only opens the confirm dialog (nothing is written yet). */
function StatusMenu({ card }: { card: CardTileModel['card'] }) {
  const settings = useSettings();
  const [req, setReq] = useState<WriteRequest | null>(null);
  const statuses = (settings.data?.notion.statuses ?? []).filter(
    (s) => s.trim().toLowerCase() !== (card.status ?? '').trim().toLowerCase(),
  );
  if (statuses.length === 0) return null;
  return (
    // Pointer and keys here belong to the menu, not to a card drag.
    <div onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Dropdown
        size="sm"
        label={`Move “${card.title}” to another status`}
        placeholder="Move to…"
        value={null}
        onChange={(to) => setReq({ kind: 'status', cardId: card.id, to })}
        options={statuses.map((s) => ({ value: s, label: s }))}
      />
      <ConfirmWriteDialog request={req} onClose={() => setReq(null)} />
    </div>
  );
}

export function CardTile({
  tile,
  sla,
  repoName,
  highlighted,
  onJump,
  select,
}: {
  tile: CardTileModel;
  /** This card's SLA line. null = it has none: not one of my cards, or finished in an earlier month. */
  sla: KpiCardRow | null;
  repoName: (repoId: string) => string;
  highlighted: boolean;
  onJump: (cardId: string) => void;
  /** Board select mode (bulk start): a checkbox on the tile. Disabled = the card cannot be started. */
  select?: { checked: boolean; disabled: boolean; onToggle: () => void };
}) {
  const { card, mr, link, severity, family, parentChip, statusMismatch } = tile;
  const chip = LINK_CHIP[link];
  const headline = statusMismatch ?? tile.verdicts.find((v) => v.severity !== 'ok') ?? null;

  return (
    <article
      id={`card-${card.id}`}
      aria-label={card.title}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm text-card-foreground shadow-xs',
        tileTone(severity),
        highlighted && 'ring-2 ring-ring',
        select?.checked && 'ring-2 ring-foreground/70',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {select && (
            <input
              type="checkbox"
              className="mr-1 size-4 accent-foreground disabled:opacity-40"
              aria-label={`Select ${card.title}`}
              title={select.disabled ? 'No Branch formula: this card cannot start' : undefined}
              checked={select.checked}
              disabled={select.disabled}
              onChange={select.onToggle}
              onPointerDown={(e) => e.stopPropagation()}
            />
          )}
          {card.type ? (
            <Badge variant="outline">{card.type}</Badge>
          ) : (
            <Badge variant="outline">no type</Badge>
          )}
          <EffortChip point={card.point} />
        </div>
        <SeverityBadge
          severity={severity}
          title={tile.unruled ? 'No Sync Health rule covers this status / MR pair' : undefined}
        />
      </div>

      <div className="flex items-start gap-1">
        <h3 className="min-w-0 flex-1 leading-snug font-medium break-words">{card.title}</h3>
        {card.url && (
          <a
            href={safeHref(card.url)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open card in Notion"
            className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {sla ? (
        <div data-slot="sla">
          <SlaSlot row={sla} />
        </div>
      ) : (
        <div data-slot="sla" aria-hidden className="min-h-4" />
      )}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border text-xs">
        <div className="bg-card p-2">
          <div className="mb-1 type-micro text-muted-foreground">Notion</div>
          <Badge variant="secondary">{card.status ?? 'no status'}</Badge>
        </div>
        <div className="bg-card p-2">
          <div className="mb-1 type-micro text-muted-foreground">GitLab</div>
          <div className="flex flex-wrap items-center gap-1">
            <MrStateBadge state={mr ? mr.derivedState : 'none'} />
            {mr && (
              <>
                <RepoName repoId={mr.repoId} name={repoName(mr.repoId)} />
                {mr.webUrl ? (
                  <a
                    href={safeHref(mr.webUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-ink hover:underline"
                  >
                    !{mr.iid}
                  </a>
                ) : (
                  <span>!{mr.iid}</span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {headline && (
        <p
          className={cn(
            'text-xs',
            severity === 'critical' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {headline.message}
          {headline.detail ? ` — ${headline.detail}` : ''}
        </p>
      )}

      {headline && (headline.fix || headline.alternatives.length > 0) && (
        <FixButtons v={headline} />
      )}

      <div className="flex flex-wrap items-center gap-1">
        {chip && (
          <Badge variant={chip.variant} title={chip.hint}>
            <chip.icon aria-hidden />
            {chip.label}
          </Badge>
        )}
        {tile.extraMrs > 0 && (
          <Badge variant="warning" title="Other MRs are also linked to this card">
            +{tile.extraMrs} more MR{tile.extraMrs > 1 ? 's' : ''}
          </Badge>
        )}
        {mr && <WaitingBadge kind={mr.timing.waitingOn.kind} />}
      </div>

      {(parentChip || family) && (
        <div className="flex flex-wrap items-center gap-1">
          {parentChip &&
            (parentChip.parentKnown ? (
              <button
                type="button"
                onClick={() => onJump(parentChip.parentId)}
                className="max-w-full truncate rounded-md border px-2 py-0.5 text-left text-xs hover:bg-accent"
                title="Jump to the parent card"
              >
                ↰ Parent: {parentChip.parentTitle ?? 'untitled'}
                {parentChip.parentStatus ? ` [${parentChip.parentStatus}]` : ''}
              </button>
            ) : (
              <Badge
                variant="warning"
                title="The parent page is not in the cache (not synced, archived, or outside the data source)"
              >
                ↰ Parent not in cache
              </Badge>
            ))}
          {family && (
            <Badge
              variant={family.suggestParentReady ? 'success' : 'secondary'}
              title={family.children
                .map((c) => `${c.title} (${c.status ?? 'no status'})`)
                .join('\n')}
            >
              <CornerDownRight aria-hidden />
              {family.readyIssuesChildren}/{family.issuesChildren} child Issues ready
              {family.suggestParentReady && (
                <>
                  {' · '}
                  <Lightbulb aria-hidden />
                  parent can move to Ready to Test
                </>
              )}
            </Badge>
          )}
        </div>
      )}

      {mr && <MrTimingLine mr={mr} />}

      {card.assignees.length > 0 && (
        <div className="truncate text-xs text-muted-foreground">{card.assignees.join(', ')}</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <StatusMenu card={card} />
        {AGENT_LABEL[tile.column] &&
          (card.branchName ? (
            <Button asChild size="sm" className="h-7 text-xs">
              <Link to={`/cockpit?startCard=${encodeURIComponent(card.id)}`}>
                <Rocket className="size-3.5" aria-hidden /> {AGENT_LABEL[tile.column]}
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled
              title="This card has no Branch formula in Notion"
            >
              <Rocket className="size-3.5" aria-hidden /> {AGENT_LABEL[tile.column]}
            </Button>
          ))}
      </div>
    </article>
  );
}

/** An MR with no card at all (`link.orphan`): there is no Notion side to show. */
export function OrphanTile({
  orphan,
  repoName,
}: {
  orphan: OrphanMrModel;
  repoName: (repoId: string) => string;
}) {
  const { mr, verdict } = orphan;
  return (
    <article
      aria-label={mr.title}
      className="flex flex-col gap-2 rounded-lg border border-warning/60 border-dashed bg-card p-3 text-sm shadow-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline">orphan MR</Badge>
        <SeverityBadge severity={verdict.severity} />
      </div>
      <div className="flex items-start gap-1">
        <h3 className="min-w-0 flex-1 leading-snug font-medium break-words">{mr.title}</h3>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <MrStateBadge state={mr.derivedState} />
        <RepoName repoId={mr.repoId} name={repoName(mr.repoId)} />
        {mr.webUrl ? (
          <a
            href={safeHref(mr.webUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-ink hover:underline"
          >
            !{mr.iid}
          </a>
        ) : (
          <span>!{mr.iid}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{verdict.message}</p>
      <MrTimingLine mr={mr} />
      <WaitingBadge kind={mr.timing.waitingOn.kind} />
    </article>
  );
}
