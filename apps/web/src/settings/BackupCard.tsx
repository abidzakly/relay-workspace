import { useRef, useState } from 'react';
import { Database, Download, Upload } from 'lucide-react';
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_PASSPHRASE_MIN,
  type ConfigImportPreview,
} from '@relay/shared';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  useApplyImport,
  useDownloadDbBackup,
  useExportConfig,
  usePreviewImport,
} from '@/lib/backupApi';
import { ErrorAlert, SectionCard } from './SectionCard';
import { SetupChecklist } from './SetupChecklist';

function ExportSection() {
  const exporter = useExportConfig();
  const [withSecrets, setWithSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');

  const tooShort = passphrase.length < CONFIG_PASSPHRASE_MIN;
  const mismatch = repeat !== passphrase;
  const blocked = withSecrets && (tooShort || mismatch);

  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Export config</h3>
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="export-secrets">Include secrets, encrypted with a passphrase</Label>
          <p className="text-xs text-muted-foreground">
            Off: tokens and webhook secrets are left out, and you enter tokens again after a
            restore. On: they are sealed in the file, and only this passphrase opens them. It cannot
            be recovered.
          </p>
        </div>
        <Switch
          id="export-secrets"
          checked={withSecrets}
          onCheckedChange={(on) => {
            setWithSecrets(on);
            setPassphrase('');
            setRepeat('');
          }}
        />
      </div>
      {withSecrets && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="export-pass">Passphrase (at least {CONFIG_PASSPHRASE_MIN})</Label>
            <Input
              id="export-pass"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="export-repeat">Repeat passphrase</Label>
            <Input
              id="export-repeat"
              type="password"
              autoComplete="new-password"
              aria-invalid={repeat !== '' && mismatch}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </div>
        </div>
      )}
      <div>
        <Button
          variant="outline"
          disabled={blocked || exporter.isPending}
          onClick={() =>
            exporter.mutate(
              withSecrets ? { includeSecrets: true, passphrase } : { includeSecrets: false },
              {
                onSuccess: () => {
                  setPassphrase('');
                  setRepeat('');
                },
              },
            )
          }
        >
          <Download />
          {exporter.isPending ? 'Preparing…' : 'Download config'}
        </Button>
      </div>
      <ErrorAlert error={exporter.error} />
    </div>
  );
}

function ImportSummary({ preview }: { preview: ConfigImportPreview }) {
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(', ');
  return (
    <div className="grid gap-3 text-sm">
      {preview.dryRunTurnsOff && (
        <Alert variant="warning">
          <AlertTitle>This turns dry-run off</AlertTitle>
          <AlertDescription>
            After the import, confirmed actions really write to Notion, GitLab and Drive.
          </AlertDescription>
        </Alert>
      )}
      <ul className="grid gap-1">
        <li>Exported {new Date(preview.exportedAt).toLocaleString()}</li>
        <li>
          Settings changed:{' '}
          {preview.settingsChanged.length > 0 ? preview.settingsChanged.join(', ') : 'none'}
        </li>
        <li>Repos added: {preview.reposAdded.length > 0 ? names(preview.reposAdded) : 'none'}</li>
        <li>
          Repos updated: {preview.reposUpdated.length > 0 ? names(preview.reposUpdated) : 'none'}
        </li>
        <li>Repos unchanged: {preview.reposUnchanged.length}</li>
        {preview.reposNotInFile.length > 0 && (
          <li>Not in the file, and kept: {preview.reposNotInFile.join(', ')}</li>
        )}
        <li>
          Secrets:{' '}
          {preview.secrets === 'restored'
            ? `${preview.secretCount} restored, replacing the ones here`
            : preview.secrets === 'ignored'
              ? 'in the file, but left out as no passphrase was given. The ones here stay'
              : 'none in the file. The ones here stay'}
        </li>
      </ul>
      {preview.reposWithoutToken.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>New repos without a token</AlertTitle>
          <AlertDescription>
            {preview.reposWithoutToken.join(', ')} will not sync until you enter a token under
            Repositories.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function ImportSection() {
  const previewer = usePreviewImport();
  const applier = useApplyImport();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; content: unknown; sealed: boolean } | null>(
    null,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [done, setDone] = useState(false);

  const preview = previewer.data;
  const args = () => ({
    file: file?.content,
    ...(passphrase ? { passphrase } : {}),
  });
  const reset = () => {
    setFile(null);
    setPassphrase('');
    previewer.reset();
    if (input.current) input.current.value = '';
  };

  const onPick = async (picked: File | undefined) => {
    setFile(null);
    setFileError(null);
    setDone(false);
    setPassphrase('');
    previewer.reset();
    applier.reset();
    if (!picked) return;
    if (picked.size > CONFIG_FILE_MAX_BYTES) {
      setFileError('This file is too large to be a config export.');
      return;
    }
    try {
      const content: unknown = JSON.parse(await picked.text());
      const sealed =
        typeof content === 'object' &&
        content !== null &&
        (content as { secrets?: unknown }).secrets != null;
      setFile({ name: picked.name, content, sealed });
    } catch {
      setFileError('This file is not valid JSON.');
    }
  };

  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Import config</h3>
      <p className="text-xs text-muted-foreground">
        The file is checked first and you see what would change. Nothing is written until you
        confirm. Older-schema, partial or edited files are refused. Repos that are not in the file
        are kept. The import is recorded in Audit.
      </p>
      <div className="grid max-w-md gap-1.5">
        <Label htmlFor="import-file">Config file</Label>
        <Input
          id="import-file"
          ref={input}
          type="file"
          accept="application/json,.json"
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
      </div>
      {file?.sealed && (
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor="import-pass">Passphrase</Label>
          <Input
            id="import-pass"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            This file has sealed secrets. Leave this empty to import only the settings.
          </p>
        </div>
      )}
      <div>
        <Button
          variant="outline"
          disabled={!file || previewer.isPending}
          onClick={() => {
            applier.reset();
            setDone(false);
            previewer.mutate(args());
          }}
        >
          <Upload />
          {previewer.isPending ? 'Checking…' : 'Check file'}
        </Button>
      </div>
      {fileError && (
        <Alert variant="destructive">
          <AlertDescription>{fileError}</AlertDescription>
        </Alert>
      )}
      <ErrorAlert error={previewer.error} />
      {done && (
        <>
          <Alert variant="success">
            <AlertDescription>
              Config imported. Some things never travel in the file (repo tokens without a
              passphrase, the Drive key, workspaces, this browser&apos;s notifications); the list
              below shows what is still missing here.
            </AlertDescription>
          </Alert>
          <SetupChecklist />
        </>
      )}

      <Dialog
        open={preview !== undefined}
        onOpenChange={(open) => {
          if (!open && !applier.isPending) previewer.reset();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import {file?.name}?</DialogTitle>
            <DialogDescription>
              This replaces this dashboard's settings. It writes nothing to GitLab, Notion or Drive.
            </DialogDescription>
          </DialogHeader>
          {preview && <ImportSummary preview={preview} />}
          <ErrorAlert error={applier.error} />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={applier.isPending}
              onClick={() => previewer.reset()}
            >
              Cancel
            </Button>
            <Button
              disabled={applier.isPending}
              onClick={() =>
                applier.mutate(args(), {
                  onSuccess: () => {
                    reset();
                    setDone(true);
                  },
                })
              }
            >
              {applier.isPending ? 'Importing…' : 'Import'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DbSection() {
  const backup = useDownloadDbBackup();
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium">Database backup</h3>
      <Alert variant="warning">
        <AlertTitle>Treat this file as sensitive</AlertTitle>
        <AlertDescription>
          It holds your tokens and webhook secrets, encrypted with <code>MASTER_KEY</code>, so never
          store that key beside it. Cards, merge requests, the audit log and webhook payloads are
          not encrypted at all, and can be read by anyone who has the file.
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" disabled={backup.isPending} onClick={() => backup.mutate()}>
          <Database />
          {backup.isPending ? 'Preparing…' : 'Download database'}
        </Button>
      </div>
      <ErrorAlert error={backup.error} />
    </div>
  );
}

/** Config export and import, and the DB backup. */
export function BackupCard() {
  return (
    <SectionCard
      id="backup"
      title="Backup & export"
      description="Served by this private dashboard only, never through the public webhook address."
    >
      <ExportSection />
      <ImportSection />
      <DbSection />
    </SectionCard>
  );
}
