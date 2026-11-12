import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Undo2 } from 'lucide-react';
import type { BulkReadyPreviewItem, BulkReadyResult } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, describeError } from '@/lib/api';
import { useUndoAudit } from '@/lib/auditApi';
import { REVIEW_AGAIN_CODES, useApplyBulkReady, usePreviewBulkReady } from '@/lib/cardApi';
import { emit } from '@/lib/reward/engine';

/**
 * Bulk "Ready to Test". Opens with a READ-ONLY preview of every card, live from Notion: Complete cards will
 * be updated, already-Ready ones skipped, and any other status needs its own tick (default unticked). Confirm sends the
 * single-use token; the server re-reads everything and refuses if the picture changed. `cardIds` null = closed.
 */
export function BulkReadyDialog({
  cardIds,
  onClose,
}: {
  cardIds: string[] | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={cardIds !== null} onOpenChange={(o) => !o && onClose()}>
      {cardIds && <Body key={cardIds.join()} cardIds={cardIds} onClose={onClose} />}
    </Dialog>
  );
}

function CardList({ items, note }: { items: BulkReadyPreviewItem[]; note?: boolean }) {
  return (
    <ul className="grid gap-1 text-sm">
      {items.map((i) => (
        <li key={i.cardId} className="flex flex-wrap justify-between gap-x-2">
          <span className="min-w-0 break-words">{i.title}</span>
          <span className="text-xs text-muted-foreground">
            {note && i.reason ? i.reason.message : (i.before ?? 'no status')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function ResultSummary({ result }: { result: BulkReadyResult }) {
  const count = (o: BulkReadyResult['items'][number]['outcome']) =>
    result.items.filter((i) => i.outcome === o).length;
  const problems = result.items.filter(
    (i) => i.outcome === 'failed' || i.outcome === 'not_attempted',
  );
  const moved = result.items.filter((i) => i.outcome === 'updated');
  const parts = [
    `${count('updated')} ${result.dryRun ? 'simulated' : 'updated'}`,
    `${count('skipped_ready')} already ${result.after}`,
    `${count('skipped_warned')} left out`,
  ];
  if (count('unavailable') > 0) parts.push(`${count('unavailable')} unavailable`);
  return (
    <>
      <Alert variant={result.partial || result.dryRun ? 'warning' : 'success'}>
        <AlertTitle>
          {result.dryRun
            ? 'Simulated (dry-run): Notion is unchanged'
            : result.partial
              ? 'Partly done'
              : 'Done'}
        </AlertTitle>
        <AlertDescription>{parts.join(' · ')}</AlertDescription>
      </Alert>
      {moved.length > 0 && (
        <Section title={result.dryRun ? 'Would move' : 'Moved'}>
          <ul className="grid gap-1 text-sm">
            {moved.map((m) => (
              <li key={m.cardId} className="flex items-start gap-1.5">
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span className="min-w-0 break-words">{m.title}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {problems.length > 0 && (
        <Section title="Not changed">
          <ul className="grid gap-1 text-sm">
            {problems.map((p) => (
              <li key={p.cardId}>
                {p.title}: <span className="text-muted-foreground">{p.failure?.message}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            The cards above kept their status; the others stay changed. Review again to retry these.
          </p>
        </Section>
      )}
    </>
  );
}

function Body({ cardIds, onClose }: { cardIds: string[]; onClose: () => void }) {
  const preview = usePreviewBulkReady();
  const apply = useApplyBulkReady();
  const undo = useUndoAudit();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const started = useRef(false);

  const load = () => {
    apply.reset();
    undo.reset();
    setTicked(new Set());
    preview.mutate(cardIds);
  };
  useEffect(() => {
    // Once per mount (StrictMode runs effects twice in dev).
    if (started.current) return;
    started.current = true;
    preview.mutate(cardIds);
  }, []);

  const p = preview.data;
  const done = apply.data;

  // Only what the result says moved. This dialog is a calm zone, so these wait and play once it closes.
  useEffect(() => {
    if (!done || done.dryRun) return;
    const moved = done.items.filter((i) => i.outcome === 'updated');
    if (moved.length === 0) return;
    const run = done.undoAuditId ?? moved.map((m) => m.cardId).join();
    for (const m of moved) emit({ level: 'tick', key: `bulk-ready:${run}:${m.cardId}` });
    emit({
      level: 'pop',
      key: `bulk-ready:${run}`,
      title: `${moved.length} card${moved.length === 1 ? '' : 's'} ready`,
    });
  }, [done]);

  const busy = preview.isPending || apply.isPending || undo.isPending;
  const applyCode = apply.error instanceof ApiError ? apply.error.code : null;
  const of = (k: BulkReadyPreviewItem['kind']) => p?.items.filter((i) => i.kind === k) ?? [];
  const writes = of('complete').length + ticked.size;
  const undoBlocked = undo.data?.batch?.blocked ?? [];
  const canUndo = done?.undoAuditId != null && (!undo.isSuccess || undoBlocked.length > 0);

  return (
    <DialogContent
      className="max-h-[85vh] overflow-y-auto"
      onInteractOutside={(e) => busy && e.preventDefault()}
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>
          {done ? 'Bulk result' : `Move to ${p?.after ?? 'Ready to Test'}?`}
        </DialogTitle>
        <DialogDescription>
          {cardIds.length} card{cardIds.length === 1 ? '' : 's'} checked against Notion.
        </DialogDescription>
      </DialogHeader>

      {preview.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Reading the cards from Notion…
        </p>
      )}
      {preview.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            Nothing to confirm{preview.error instanceof ApiError ? ` (${preview.error.code})` : ''}
          </AlertTitle>
          <AlertDescription>{describeError(preview.error)}</AlertDescription>
        </Alert>
      )}

      {p && !done && (
        <>
          {p.dryRun && (
            <Alert variant="warning">
              <AlertTitle>Dry-run is ON</AlertTitle>
              <AlertDescription>
                Nothing will be written to Notion; the changes are only simulated and logged.
              </AlertDescription>
            </Alert>
          )}
          {of('complete').length > 0 && (
            <Section title={`Will be updated (${of('complete').length})`}>
              <CardList items={of('complete')} />
            </Section>
          )}
          {of('warned').length > 0 && (
            <Section title={`Not Complete: tick to include (${of('warned').length})`}>
              <ul className="grid gap-1 text-sm">
                {of('warned').map((i) => (
                  <li key={i.cardId}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={ticked.has(i.cardId)}
                        disabled={busy}
                        onChange={(e) => {
                          const next = new Set(ticked);
                          if (e.target.checked) next.add(i.cardId);
                          else next.delete(i.cardId);
                          setTicked(next);
                        }}
                      />
                      <span className="min-w-0 break-words">
                        {i.title}{' '}
                        <span className="text-xs text-muted-foreground">
                          ({i.before ?? 'no status'})
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {of('ready').length > 0 && (
            <Section title={`Already ${p.after}: skipped (${of('ready').length})`}>
              <CardList items={of('ready')} />
            </Section>
          )}
          {of('unavailable').length > 0 && (
            <Section title={`Cannot be changed (${of('unavailable').length})`}>
              <CardList items={of('unavailable')} note />
            </Section>
          )}
          <p className="text-xs text-muted-foreground">
            Each change is audited with the previous status; one Undo bulk restores them all.
          </p>
        </>
      )}

      {apply.isError && (
        <Alert variant="destructive">
          <AlertTitle>Not changed{applyCode ? ` (${applyCode})` : ''}</AlertTitle>
          <AlertDescription>{describeError(apply.error)}</AlertDescription>
        </Alert>
      )}

      {done && <ResultSummary result={done} />}

      {undo.isSuccess && (
        <Alert variant={undo.data.dryRun || undoBlocked.length > 0 ? 'warning' : 'success'}>
          <AlertTitle>
            {undo.data.dryRun
              ? 'Undo simulated (dry-run)'
              : `Restored ${undo.data.batch?.restored.length ?? 0} card(s)`}
          </AlertTitle>
          {undoBlocked.length > 0 && (
            <AlertDescription>
              {undoBlocked.map((b) => `${b.title}: ${b.message}`).join(' ')}
            </AlertDescription>
          )}
        </Alert>
      )}
      {undo.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            Not undone{undo.error instanceof ApiError ? ` (${undo.error.code})` : ''}
          </AlertTitle>
          <AlertDescription>{describeError(undo.error)}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        {done ? (
          <>
            {done.partial && !undo.isSuccess && (
              <Button variant="secondary" disabled={busy} onClick={load}>
                Review again
              </Button>
            )}
            {canUndo && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => done.undoAuditId !== null && undo.mutate(done.undoAuditId)}
              >
                {undo.isPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Undo2 className="size-4" />
                )}
                Undo bulk
              </Button>
            )}
            <Button onClick={onClose} disabled={busy}>
              Close
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {((apply.isError && applyCode && REVIEW_AGAIN_CODES.has(applyCode)) ||
              preview.isError) && (
              <Button variant="secondary" disabled={busy} onClick={load}>
                Review again
              </Button>
            )}
            <Button
              disabled={!p || busy || apply.isError || writes === 0}
              onClick={() =>
                p &&
                apply.mutate({
                  cardIds,
                  includeWarned: [...ticked],
                  confirmToken: p.confirmToken,
                })
              }
            >
              {apply.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {apply.isPending
                ? 'Writing…'
                : `${p?.dryRun ? 'Simulate' : 'Update'} ${writes} card${writes === 1 ? '' : 's'}`}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
