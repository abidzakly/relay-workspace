import { Component, lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { ConfirmWriteDialog } from '@/components/ConfirmWriteDialog';
import { Button } from '@/components/ui/button';
import type { WriteRequest } from '@/lib/cardApi';
import { useSettings } from '@/lib/settingsApi';
import { detectWebgl } from '@/lib/webgl';
import { useUiStore, type AsciiMode, type CoreMode } from '@/store/ui';
import { nextUpStatus, type ProgressCardRef, type ProgressModel } from './progressMapping';

const CoreCanvas = lazy(() =>
  import('./CoreCanvas').then((module) => ({ default: module.CoreCanvas })),
);

function describe(model: ProgressModel | null, mode: CoreMode, ascii: AsciiMode): string {
  const base =
    mode === 'A'
      ? 'A glass crystal with its shards on one ring around it; the ring tightens as cards progress.'
      : mode === 'B'
        ? 'A glass crystal opened into its fracture pieces, its shards flung wide.'
        : 'A glass crystal whose loose shards gather to it as cards progress.';
  if (!model) return base;
  const count = model.segments.length;
  const asciiNote = ascii === 'full' ? ' Drawn as text characters.' : '';
  const issues =
    model.cracks.length > 0
      ? ` ${model.cracks.length} card${model.cracks.length === 1 ? '' : 's'} in Issues shown as red orbs.`
      : '';
  return `${base} ${count} card${count === 1 ? '' : 's'} in the flow, ${model.dust.length} in Backlog as dust.${issues}${asciiNote}`;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Catches a renderer that fails despite the check (a blocklisted GPU, say) and a chunk that fails to load. */
class CoreBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return <Notice>The 3D core could not start. The rest of the dashboard is unaffected.</Notice>;
    }
    return this.props.children;
  }
}

/** The same promotion as a Backlog speck, for the keyboard, for touch, and for a browser with no core at all. */
export function BacklogList({
  cards,
  onPick,
}: {
  cards: readonly ProgressCardRef[];
  onPick: (card: ProgressCardRef) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Backlog ({cards.length}), not counted in progress
      </summary>
      <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
        {cards.map((card) => (
          <li key={card.cardId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{card.title}</span>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => onPick(card)}>
              To Next Up
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Moving a Backlog card to Next Up: the preview-and-confirm dialog and the action that opens it. Nothing is written
 * until the dialog's Confirm (an audited write). Shared by the core's dust and the Backlog list.
 */
export function useBacklogPromotion() {
  const [request, setRequest] = useState<WriteRequest | null>(null);
  const statuses = useSettings().data?.notion.statuses;
  const promote = useCallback(
    (card: ProgressCardRef) =>
      setRequest({ kind: 'status', cardId: card.cardId, to: nextUpStatus(statuses) }),
    [statuses],
  );
  const dialog = <ConfirmWriteDialog request={request} onClose={() => setRequest(null)} />;
  return { promote, dialog };
}

/**
 * Free of three.js imports, so the app's main bundle stays free of it too.
 *
 * `card` (default): a stage inside the Overview's Release progress card, with its Backlog list.
 * `stage`: fills its positioned parent (the Living Workspace's Overview, where the ship IS the scene);
 * the caller places the Backlog list in its panels and passes `onPromote`.
 */
export function CoreStage({
  model,
  variant = 'card',
  onPromote,
}: {
  model: ProgressModel | null;
  variant?: 'card' | 'stage';
  onPromote?: (card: ProgressCardRef) => void;
}) {
  const [webgl] = useState(detectWebgl);
  const [hovered, setHovered] = useState<ProgressCardRef | null>(null);
  const own = useBacklogPromotion();
  const mode = useUiStore((s) => s.mode3d);
  const ascii = useUiStore((s) => s.ascii);

  const promote = (card: ProgressCardRef) => {
    setHovered(null);
    (onPromote ?? own.promote)(card);
  };

  const stage = (
    <div
      className={variant === 'stage' ? 'absolute inset-0' : 'relative h-72 w-full sm:h-96'}
      role="img"
      aria-label={describe(model, mode, ascii)}
    >
      {webgl ? (
        <CoreBoundary>
          <Suspense fallback={<Notice>Loading the 3D core…</Notice>}>
            <CoreCanvas model={model} onDustPick={promote} onDustHover={setHovered} />
          </Suspense>
        </CoreBoundary>
      ) : (
        <Notice>
          This browser has no WebGL, so the 3D core is off. Nothing else depends on it.
        </Notice>
      )}
      {hovered && (
        <p className="pointer-events-none absolute inset-x-2 bottom-2 truncate rounded-md bg-popover/90 px-2 py-1 text-xs text-popover-foreground">
          Backlog: {hovered.title}. Click to move it to Next Up.
        </p>
      )}
    </div>
  );
  if (variant === 'stage') return stage;
  return (
    <div className="flex flex-col gap-2">
      {stage}
      <BacklogList cards={model?.dust ?? []} onPick={promote} />
      {!onPromote && own.dialog}
    </div>
  );
}
