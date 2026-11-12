import { useState } from 'react';
import type { GlobalConfigPublic } from '@relay/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ConnectionChecklist } from '@/components/ConnectionChecklist';
import { Field, errorMap } from '@/components/Field';
import { ApiError } from '@/lib/api';
import { useSaveGlobal, useTestDrive } from '@/lib/settingsApi';
import { useDraft } from './drafts';
import { ErrorAlert, SectionCard } from './SectionCard';

export function toDriveDraft(s: GlobalConfigPublic) {
  return {
    serviceAccountKeyPath: s.drive.serviceAccountKeyPath,
    anyoneWithLink: s.drive.anyoneWithLink,
  };
}

export function DriveCard({ settings }: { settings: GlobalConfigPublic }) {
  const initial = toDriveDraft(settings);
  const { draft, set, dirty } = useDraft(initial);
  const save = useSaveGlobal();
  const test = useTestDrive();
  const [folderId, setFolderId] = useState('');
  const errs = errorMap(save.error instanceof ApiError ? save.error.issues : []);

  return (
    <SectionCard
      id="drive"
      title="Google Drive"
      description="A service account uploads staging builds to each repo's Shared Drive folder (set per repo)."
    >
      <Field
        label="Service-account key file"
        htmlFor="dr-key"
        error={errs['drive.serviceAccountKeyPath']}
        hint="Path to the JSON key on this machine (relative paths resolve from the project root). The key itself is never uploaded or shown."
      >
        <Input
          id="dr-key"
          value={draft.serviceAccountKeyPath}
          onChange={(e) => set('serviceAccountKeyPath', e.target.value)}
        />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="dr-anyone">Share uploads as “anyone with the link”</Label>
          <p className="text-xs text-muted-foreground">
            Only staging builds are ever shared to QA; production builds are never shared.
          </p>
        </div>
        <Switch
          id="dr-anyone"
          checked={draft.anyoneWithLink}
          onCheckedChange={(v) => set('anyoneWithLink', v)}
        />
      </div>
      <ErrorAlert error={save.error && Object.keys(errs).length === 0 ? save.error : null} />
      <div className="flex flex-wrap items-end gap-3">
        <Button
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              patch: (s) => ({
                ...s,
                drive: {
                  ...s.drive,
                  serviceAccountKeyPath: draft.serviceAccountKeyPath.trim(),
                  anyoneWithLink: draft.anyoneWithLink,
                },
              }),
            })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div className="grid gap-2 border-t pt-4">
        <Field
          label="Test a specific folder id (optional)"
          htmlFor="dr-folder"
          hint="Leave empty to test the folder of every repo that has one."
        >
          <Input
            id="dr-folder"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="Drive folder id"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={dirty || test.isPending}
            onClick={() => test.mutate(folderId.trim() || undefined)}
          >
            {test.isPending ? 'Testing…' : 'Test connection'}
          </Button>
          {dirty ? (
            <span className="text-sm text-muted-foreground">
              Save first: tests use the saved settings.
            </span>
          ) : null}
        </div>
        {test.error ? <ErrorAlert error={test.error} /> : null}
        {test.data ? <ConnectionChecklist result={test.data} /> : null}
      </div>
    </SectionCard>
  );
}
