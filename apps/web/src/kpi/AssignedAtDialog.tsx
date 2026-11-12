import { DatePicker } from '@/components/ui/date-picker';
import { useId, useState, type FormEvent } from 'react';
import type { AssignedAtOverrideResult, AssignedAtResolution } from '@relay/shared';
import { Field } from '@/components/Field';
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
import { describeError } from '@/lib/api';
import { useUndoAudit } from '@/lib/auditApi';
import { useSetAssignedAt } from '@/lib/kpiApi';
import { AssignedAtFlags } from './SlaBits';

export interface AssignedAtTarget {
  cardId: string;
  title: string;
  assignedAt: AssignedAtResolution;
}

/** `YYYY-MM-DDTHH:mm` in local time, which is what a datetime-local input holds. */
function toLocalInput(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The server's own allowance for clock skew. It re-checks, so this only gives a quicker answer. */
const FUTURE_SLACK_MS = 60_000;

/** Manual assigned-at. Stored locally, never sent to Notion, audited and undoable. */
export function AssignedAtDialog({
  target,
  onClose,
}: {
  target: AssignedAtTarget;
  onClose: () => void;
}) {
  const inputId = useId();
  const [openedAt] = useState(() => Date.now());
  const [value, setValue] = useState(() =>
    target.assignedAt.at === null ? '' : toLocalInput(target.assignedAt.at),
  );
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<AssignedAtOverrideResult | null>(null);
  const set = useSetAssignedAt();
  const undo = useUndoAudit();

  const write = (assignedAt: number | null) =>
    set.mutate({ cardId: target.cardId, assignedAt }, { onSuccess: setSaved });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(value).getTime();
    if (value === '' || Number.isNaN(at)) {
      setFieldError('Choose a date and time.');
    } else if (at > Date.now() + FUTURE_SLACK_MS) {
      setFieldError('Assigned-at cannot be in the future.');
    } else {
      setFieldError(undefined);
      write(at);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assigned at</DialogTitle>
          <DialogDescription>{target.title}</DialogDescription>
        </DialogHeader>

        {saved ? (
          <>
            <p className="flex flex-wrap items-center gap-1 text-sm" role="status">
              {saved.auditId === null ? 'Already set to this: nothing changed.' : 'Saved.'}
              {saved.assignedAt.at !== null && (
                <span>Now {new Date(saved.assignedAt.at).toLocaleString()}</span>
              )}
              <AssignedAtFlags assignedAt={saved.assignedAt} />
            </p>
            {undo.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not undo</AlertTitle>
                <AlertDescription>{describeError(undo.error)}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              {saved.auditId !== null && (
                <Button
                  variant="outline"
                  disabled={undo.isPending}
                  onClick={() => {
                    if (saved.auditId !== null) undo.mutate(saved.auditId, { onSuccess: onClose });
                  }}
                >
                  Undo
                </Button>
              )}
              <Button onClick={onClose}>Close</Button>
            </DialogFooter>
          </>
        ) : (
          <form className="grid gap-4" onSubmit={submit}>
            <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              {target.assignedAt.at === null
                ? 'Not known yet.'
                : `Now ${new Date(target.assignedAt.at).toLocaleString()}`}
              <AssignedAtFlags assignedAt={target.assignedAt} />
            </p>
            <Field
              label="Assigned at (your local time)"
              htmlFor={inputId}
              error={fieldError}
              hint="The SLA timer runs from this moment, or from the estimation start if that is later, and the card is flagged manual. The card then counts in your KPI even if it is not assigned to you. It may move to another month. Frozen months do not change."
            >
              <DatePicker
                id={inputId}
                kind="datetime"
                value={value}
                max={toLocalInput(openedAt)}
                onChange={setValue}
                aria-invalid={fieldError !== undefined && fieldError !== null}
              />
            </Field>
            {set.isError && (
              <Alert variant="destructive">
                <AlertTitle>Could not save</AlertTitle>
                <AlertDescription>{describeError(set.error)}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              {target.assignedAt.source === 'manual' && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={set.isPending}
                  onClick={() => write(null)}
                >
                  Remove override
                </Button>
              )}
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={set.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
