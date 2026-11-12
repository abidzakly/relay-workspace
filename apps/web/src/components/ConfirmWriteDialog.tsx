import { useEffect, useRef } from 'react';
import { ArrowRight, Loader2, Undo2 } from 'lucide-react';
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
import {
  REVIEW_AGAIN_CODES,
  useApplyWrite,
  usePreviewWrite,
  useUndoWrite,
  type WriteRequest,
} from '@/lib/cardApi';

/**
 * The confirm dialog every Notion write goes through. It opens with a READ-ONLY preview
 * (`before -> after`, live from Notion); only the Confirm button sends the write, carrying the single-use token
 * the preview returned. The server re-checks everything, so this dialog is the user's consent, not the gate.
 */
export function ConfirmWriteDialog({
  request,
  onClose,
  onApplied,
}: {
  request: WriteRequest | null;
  onClose: () => void;
  /** The server confirmed the write (not a dry-run preview of it). The board keeps a dragged card where it was dropped. */
  onApplied?: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(o) => !o && onClose()}>
      {/* keyed: a new request starts from a clean state */}
      {request && (
        <Body
          key={JSON.stringify(request)}
          request={request}
          onClose={onClose}
          onApplied={onApplied}
        />
      )}
    </Dialog>
  );
}

function StatusChange({ before, after }: { before: string | null; after: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
      <span className="text-xs tracking-wide text-muted-foreground uppercase">Status</span>
      <span className="rounded-md bg-secondary px-2 py-0.5 line-through decoration-muted-foreground/60">
        {before ?? 'no status'}
      </span>
      <ArrowRight className="size-4 text-muted-foreground" aria-label="becomes" />
      <span className="rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground">
        {after}
      </span>
    </div>
  );
}

function Body({
  request,
  onClose,
  onApplied,
}: {
  request: WriteRequest;
  onClose: () => void;
  onApplied?: (() => void) | undefined;
}) {
  const preview = usePreviewWrite();
  const apply = useApplyWrite();
  const undo = useUndoWrite();
  const started = useRef(false);

  const load = () => {
    apply.reset();
    undo.reset();
    preview.mutate(request);
  };
  useEffect(() => {
    // Once per mount (StrictMode runs effects twice in dev).
    if (started.current) return;
    started.current = true;
    preview.mutate(request);
  }, []);

  const p = preview.data;
  const busy = apply.isPending || undo.isPending;
  const done = apply.data;
  const applyCode = apply.error instanceof ApiError ? apply.error.code : null;

  return (
    <DialogContent
      onInteractOutside={(e) => busy && e.preventDefault()}
      onEscapeKeyDown={(e) => busy && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle>{done ? 'Done' : 'Change the Notion status?'}</DialogTitle>
        <DialogDescription>
          {p
            ? p.cardTitle
            : request.kind === 'fix'
              ? 'Applying a suggested fix'
              : 'Checking Notion…'}
        </DialogDescription>
      </DialogHeader>

      {preview.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> Reading the card from Notion…
        </p>
      )}

      {preview.isError && (
        <Alert variant="destructive">
          <AlertTitle>
            Nothing to confirm
            {preview.error instanceof ApiError ? ` (${preview.error.code})` : ''}
          </AlertTitle>
          <AlertDescription>{describeError(preview.error)}</AlertDescription>
        </Alert>
      )}

      {p && !done && (
        <>
          <StatusChange before={p.before} after={p.after} />
          {p.dryRun && (
            <Alert variant="warning">
              <AlertTitle>Dry-run is ON</AlertTitle>
              <AlertDescription>
                Nothing will be written to Notion; the change is only simulated and logged.
              </AlertDescription>
            </Alert>
          )}
          {p.warnings.map((w) => (
            <Alert key={w} variant="warning">
              <AlertDescription>{w}</AlertDescription>
            </Alert>
          ))}
          <ul className="grid gap-1 text-sm text-muted-foreground">
            <li>
              The card is re-read from Notion when you confirm; if it changed, nothing is written.
            </li>
            <li>The change is written to the audit log with before/after and can be undone.</li>
          </ul>
        </>
      )}

      {apply.isError && (
        <Alert variant="destructive">
          <AlertTitle>Not changed{applyCode ? ` (${applyCode})` : ''}</AlertTitle>
          <AlertDescription>{describeError(apply.error)}</AlertDescription>
        </Alert>
      )}

      {done && (
        <>
          <StatusChange before={done.before} after={done.after} />
          <Alert variant={done.dryRun ? 'warning' : 'success'}>
            <AlertDescription>
              {done.dryRun
                ? `Simulated (dry-run): Notion is unchanged. Audit #${done.auditId}.`
                : `Written to Notion. Audit #${done.auditId}.`}
            </AlertDescription>
          </Alert>
          {undo.isSuccess && (
            <Alert variant={undo.data.dryRun ? 'warning' : 'success'}>
              <AlertDescription>
                {undo.data.dryRun
                  ? `Undo simulated (dry-run). Audit #${undo.data.auditId}.`
                  : `Restored “${done.before ?? 'no status'}”. Audit #${undo.data.auditId}.`}
              </AlertDescription>
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
        </>
      )}

      <DialogFooter>
        {done ? (
          <>
            {done.undoable && !undo.isSuccess && (
              <Button variant="outline" disabled={busy} onClick={() => undo.mutate(done.auditId)}>
                {undo.isPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Undo2 className="size-4" />
                )}
                Undo (back to “{done.before ?? 'no status'}”)
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
            {apply.isError && applyCode && REVIEW_AGAIN_CODES.has(applyCode) && (
              <Button variant="secondary" onClick={load}>
                Review again
              </Button>
            )}
            {preview.isError && (
              <Button variant="secondary" onClick={load}>
                Retry
              </Button>
            )}
            <Button
              disabled={!p || busy || apply.isError}
              onClick={() =>
                p &&
                apply.mutate(
                  { request, confirmToken: p.confirmToken },
                  { onSuccess: () => onApplied?.() },
                )
              }
            >
              {apply.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
              {apply.isPending ? 'Writing…' : p?.dryRun ? 'Simulate change' : 'Confirm change'}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
