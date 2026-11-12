import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { JOB_MODES, type JobMode } from '@relay/shared';
import { Field } from '@/components/Field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError, describeError } from '@/lib/api';
import { useReleaseEngines, useReleasePreview, useStartRelease } from '@/lib/releaseApi';
import { missingScriptValues } from '@/lib/scriptsApi';
import { ScriptSetupDialog } from '@/scripts/ScriptSetupDialog';
import { versionInputError } from './model';
import { PtyNotice } from './PtyNotice';
import { StarTrigger } from './StarTrigger';
import { useVisual } from '@/lib/visuals';

const MODE_LABEL: Record<JobMode, string> = {
  staging: 'Staging (next alpha)',
  prod: 'Prod (next patch)',
  custom: 'Custom version',
};

const PREVIEW_DELAY_MS = 300;

function PreviewRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Mode chooser, live version preview and override. Only "Start release" starts anything. */
export function StartForm({
  repo,
  dryRun,
  strandedWarning,
  onClose,
}: {
  repo: string;
  dryRun: boolean;
  /** The previous release may be merged without a tag: said again here, where it can still be acted on. */
  strandedWarning: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<JobMode>('staging');
  const [input, setInput] = useState('');
  const version = input.trim();
  const [debounced, setDebounced] = useState(version);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(version), PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [version]);

  const inputError = version === '' && mode === 'custom' ? null : versionInputError(mode, version);
  const inputOk = versionInputError(mode, version) === null;
  const settled = debounced === version;
  const preview = useReleasePreview(repo, mode, debounced, inputOk && settled);
  const start = useStartRelease(repo);
  const engines = useReleaseEngines();
  const usesPty = engines.data?.current === 'pty';
  const ptyUnavailable = usesPty && engines.data?.pty.available === false;
  const ptyBlocked = usesPty && (dryRun || ptyUnavailable);
  const ready = inputOk && settled && preview.isSuccess && !preview.isFetching && !ptyBlocked;
  const form = useRef<HTMLFormElement>(null);
  const showVisual = useVisual('release');

  return (
    <form
      ref={form}
      className="grid gap-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || start.isPending) return;
        start.mutate({ mode, ...(version ? { version } : {}) });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mode" htmlFor={`mode-${repo}`}>
          <Select
            id={`mode-${repo}`}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as JobMode);
              setInput('');
              setDebounced('');
              start.reset();
            }}
          >
            {JOB_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={mode === 'custom' ? 'Version' : 'Override (optional)'}
          htmlFor={`version-${repo}`}
          error={inputError ?? undefined}
          hint={
            mode === 'staging'
              ? 'A bare number sets the alpha number.'
              : mode === 'custom'
                ? 'Full version, for example 2.1.0-alpha-3+52.'
                : 'Leave empty to use the computed version.'
          }
        >
          <Input
            id={`version-${repo}`}
            value={input}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={inputError !== null}
            onChange={(e) => {
              setInput(e.target.value);
              start.reset();
            }}
          />
        </Field>
      </div>

      <div aria-live="polite" className="min-h-10 rounded-md bg-muted/40 p-2">
        {!inputOk ? (
          <p className="text-xs text-muted-foreground">
            {version === ''
              ? 'Enter a version to see the preview.'
              : 'Fix the version to see the preview.'}
          </p>
        ) : !settled || preview.isPending || preview.isFetching ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 motion-safe:animate-spin" /> Reading pubspec.yaml from
            GitLab…
          </p>
        ) : preview.isError ? (
          <p role="alert" className="text-xs text-destructive">
            No preview: {describeError(preview.error)}
          </p>
        ) : (
          <PreviewRows
            rows={[
              ['Current', preview.data.current],
              [preview.data.overridden ? 'Your version' : 'New version', preview.data.newVersion],
              ...(preview.data.overridden
                ? ([['Computed', preview.data.proposed]] as [string, string][])
                : []),
              ['Branch', preview.data.branch],
              ['Commit', preview.data.commitMessage],
              ['Tag', preview.data.tag],
            ]}
          />
        )}
      </div>

      {mode !== 'staging' && (
        <p className="text-xs text-muted-foreground">
          Only staging releases are ever shared with QA. This one will not be.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {dryRun
          ? 'Dry-run: every write is simulated.'
          : 'This pushes a version branch and opens an MR. It stops before the merge and waits for you.'}{' '}
        If an unfinished version MR is open, it is picked up instead and decides the version.
      </p>
      {!usesPty && (
        <p className="text-xs text-muted-foreground">
          {mode === 'staging'
            ? 'After the merge it tags, builds the APK, uploads it to the Drive folder and moves Complete cards to Ready to Test in Notion. Starting confirms that upload and that change. Send to QA waits for your own click.'
            : 'After the merge it tags, builds the APK and AAB as this mode requires, and moves Complete cards to Ready to Test in Notion. Starting confirms that change. Nothing is uploaded.'}
        </p>
      )}

      {usesPty && <PtyNotice />}
      {ptyUnavailable && (
        <Alert variant="destructive">
          <AlertTitle>The PTY engine is unavailable</AlertTitle>
          <AlertDescription>
            {engines.data?.pty.reason}. Choose the node engine under Settings to release now.
          </AlertDescription>
        </Alert>
      )}
      {usesPty && dryRun && !ptyUnavailable && (
        <Alert variant="warning">
          <AlertTitle>PTY cannot run in dry-run</AlertTitle>
          <AlertDescription>
            vu writes for real. Turn dry-run off, or choose the node engine under Settings.
          </AlertDescription>
        </Alert>
      )}

      {strandedWarning && (
        <Alert variant="warning">
          <AlertTitle>The previous release may be merged without a tag</AlertTitle>
          <AlertDescription>
            Tag it first (see the steps below). A new release bumps from the merged version, and
            that version would stay untagged.
          </AlertDescription>
        </Alert>
      )}

      {/* The scripts lack values: ask for them here, then start again. */}
      <ScriptSetupDialog
        missing={missingScriptValues(start.error)}
        onClose={() => start.reset()}
        onSaved={() => {
          start.reset();
          form.current?.requestSubmit();
        }}
      />
      {start.isError && !missingScriptValues(start.error) && (
        <Alert variant="destructive">
          <AlertTitle>
            {start.error instanceof ApiError && start.error.code === 'engine_unavailable'
              ? 'The PTY engine is unavailable'
              : 'Not started'}
          </AlertTitle>
          <AlertDescription>
            {describeError(start.error)}
            {start.error instanceof ApiError && start.error.code === 'engine_unavailable'
              ? '. Choose the node engine under Settings to release now.'
              : ''}
          </AlertDescription>
        </Alert>
      )}

      {/* Trace the constellation to release: it submits this same form, so every check above still applies. */}
      {showVisual && (
        <StarTrigger
          ready={ready}
          busy={start.isPending}
          failed={start.isError}
          action={dryRun ? 'simulate the release' : 'start the release'}
          onFire={() => form.current?.requestSubmit()}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready || start.isPending}>
          {start.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
          {dryRun ? 'Simulate release' : usesPty ? 'Start release (runs vu)' : 'Start release'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}
