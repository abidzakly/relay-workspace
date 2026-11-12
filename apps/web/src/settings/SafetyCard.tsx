import { ENGINES, type Engine, type GlobalConfigPublic } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useReleaseEngines } from '@/lib/releaseApi';
import { useSaveGlobal } from '@/lib/settingsApi';
import { PtyNotice } from '@/release/PtyNotice';
import { ErrorAlert, SectionCard } from './SectionCard';

const ENGINE_LABEL: Record<Engine, string> = {
  node: 'Built in (Node and git, default)',
  pty: 'Custom release command (in a terminal)',
};

/** Dry-run + release engine. Both save immediately (single field each). */
export function SafetyCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const pty = useReleaseEngines().data?.pty;
  const ptyUnavailable = pty?.available === false;
  return (
    <SectionCard
      id="safety"
      title="Safety & engine"
      description="Dry-run records what a write WOULD do without calling GitLab, Notion or Drive."
    >
      {!settings.dryRun ? (
        <Alert variant="warning">
          <AlertTitle>Dry-run is off</AlertTitle>
          <AlertDescription>
            Confirmed actions will really write to Notion, GitLab and Drive. Turn dry-run on while
            you set things up.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="success">
          <AlertTitle>Dry-run is on</AlertTitle>
          <AlertDescription>
            No external writes will be made; they are only logged to Audit.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="dry-run">Dry-run mode</Label>
          <p className="text-xs text-muted-foreground">
            Writes are never automatic either way: each one needs your confirmation and is audited.
          </p>
        </div>
        <Switch
          id="dry-run"
          checked={settings.dryRun}
          disabled={save.isPending}
          onCheckedChange={(dryRun) => save.mutate({ patch: (s) => ({ ...s, dryRun }) })}
        />
      </div>
      <div className="grid max-w-md gap-1.5">
        <Label htmlFor="engine">Release engine</Label>
        <Select
          id="engine"
          value={settings.engine}
          disabled={save.isPending}
          onChange={(e) =>
            save.mutate({ patch: (s) => ({ ...s, engine: e.target.value as Engine }) })
          }
        >
          {ENGINES.map((e) => (
            <option key={e} value={e} disabled={e === 'pty' && ptyUnavailable}>
              {ENGINE_LABEL[e]}
              {e === 'pty' && ptyUnavailable ? ' (unavailable)' : ''}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          The custom command is <code>vu</code> from the release scripts, or any executable that
          takes the same arguments, named by <code>RELEASE_COMMAND</code> in <code>.env</code> on
          the machine that runs it.
          {pty?.command ? (
            <>
              {' '}
              Now: <code>{pty.command}</code>.
            </>
          ) : null}
        </p>
        {ptyUnavailable && (
          <p className="text-xs text-muted-foreground">
            The custom command is unavailable: {pty.reason}.
          </p>
        )}
      </div>
      {settings.engine === 'pty' && <PtyNotice />}
      <ErrorAlert error={save.error} />
    </SectionCard>
  );
}
