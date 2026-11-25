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
import { OAuthConnect } from './OAuthConnect';
import { ErrorAlert, SectionCard } from './SectionCard';
import { Advanced, ExtLink, Steps, Ui } from './SetupGuide';

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
      description="Uploads staging builds to Drive for QA: as you, with “Connect with Google”, or through a service account."
    >
      <OAuthConnect
        provider="google"
        feature="drive"
        what="Relay only sees the files and folders it makes itself. A repo with no Drive folder set gets one made for it on its first upload (“Relay builds · <repo>”)."
        disconnectNote="Signs Google out of Calendar and Drive together."
      />
      <Advanced
        summary="Without Connect: use a service account"
        open={!!settings.drive.serviceAccountKeyPath || !!errs['drive.serviceAccountKeyPath']}
      >
        <p className="text-muted-foreground">
          Only needed when “Connect with Google” is not set up, or a repo must upload into a folder
          Relay did not make. Uploads then belong to the service account.
        </p>
        <Steps>
          <li>
            In Google Cloud, enable the{' '}
            <ExtLink href="https://console.cloud.google.com/apis/library/drive.googleapis.com">
              Google Drive API
            </ExtLink>
            .
          </li>
          <li>
            Open{' '}
            <ExtLink href="https://console.cloud.google.com/iam-admin/serviceaccounts/create">
              Service accounts
            </ExtLink>{' '}
            and create one (no roles needed).
          </li>
          <li>
            On the account, open <Ui>Keys</Ui> &gt; <Ui>Add key</Ui> &gt; <Ui>Create new key</Ui>{' '}
            &gt; <Ui>JSON</Ui>. Save the file on this machine, outside the repo.
          </li>
          <li>
            In Drive, share each repo’s folder with the service account’s email (
            <code>…@….iam.gserviceaccount.com</code>) as <Ui>Editor</Ui>.
          </li>
          <li>Put the key file’s path below and save.</li>
        </Steps>
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
      </Advanced>
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
