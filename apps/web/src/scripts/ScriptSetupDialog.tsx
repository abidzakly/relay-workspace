import { useState } from 'react';
import type { ScriptsMissing } from '@relay/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSaveScripts, useScripts } from '@/lib/scriptsApi';
import { ErrorAlert } from '@/settings/SectionCard';
import { ScriptFieldInputs } from './ScriptFieldInputs';

/**
 * Asked just in time: a release through the scripts was refused because they lack a few values. Fill them in, save,
 * and the release starts again. Saved values are kept (Settings > Repos > Release scripts).
 */
export function ScriptSetupDialog({
  missing,
  onClose,
  onSaved,
}: {
  missing: ScriptsMissing | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const status = useScripts(missing !== null);
  const save = useSaveScripts();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const keys = missing?.required ?? [];
  const complete = keys.every((k) => (draft[k] ?? '').trim() !== '');

  return (
    <Dialog open={missing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>A few values for the release scripts</DialogTitle>
          <DialogDescription>
            Without these, vu would stop and wait for an answer nobody can type. They are saved for
            next time and for terminal runs.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!complete) return;
            save.mutate(Object.fromEntries(keys.map((k) => [k, draft[k]!.trim()])), {
              onSuccess: () => {
                setDraft({});
                onSaved();
              },
            });
          }}
        >
          <ScriptFieldInputs
            keys={keys}
            states={status.data?.fields ?? []}
            draft={draft}
            idPrefix="script-setup"
            onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
          />
          <ErrorAlert error={save.error} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button type="submit" disabled={!complete || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save and start'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
