import type { ReleaseUnknownReason } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ProgressModel } from '@/core3d/progressMapping';
import { useRepos } from '@/lib/settingsApi';
import {
  useUiStore,
  type AsciiMode,
  type AsciiTone,
  type CoreMode,
  type CoreScope,
} from '@/store/ui';

const SCOPES: { value: CoreScope; label: string }[] = [
  { value: 'cycle', label: 'Current cycle' },
  { value: 'all', label: 'All-time' },
];

const REASON_TEXT: Record<ReleaseUnknownReason, string> = {
  never_checked: 'not checked yet',
  stale: 'its last check is too old',
  list_incomplete: 'too many merged MRs to read',
  no_boundary: 'no version MR, and its tags do not settle it',
};

/** Persisted in the UI store. Sits in the view's header, next to the title. */
export function ScopeSwitch() {
  const scope = useUiStore((s) => s.scope);
  const setScope = useUiStore((s) => s.setScope);
  return (
    <div role="group" aria-label="Progress scope" className="flex gap-1 rounded-md border p-0.5">
      {SCOPES.map(({ value, label }) => (
        <Button
          key={value}
          size="sm"
          variant={scope === value ? 'secondary' : 'ghost'}
          aria-pressed={scope === value}
          onClick={() => setScope(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

const MODES: { value: CoreMode; label: string }[] = [
  { value: 'S', label: 'Crystal' },
  { value: 'A', label: 'Ring' },
  { value: 'B', label: 'Shatter' },
];

/** Persisted in the UI store; the same preference as Settings -> Appearance. */
export function ModeSwitch() {
  const mode = useUiStore((s) => s.mode3d);
  const setMode = useUiStore((s) => s.setMode3d);
  return (
    <div role="group" aria-label="Core mode" className="flex gap-1 rounded-md border p-0.5">
      {MODES.map(({ value, label }) => (
        <Button
          key={value}
          size="sm"
          variant={mode === value ? 'secondary' : 'ghost'}
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

const ASCII_MODES: { value: AsciiMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'full', label: 'Full scene' },
];

const ASCII_TONES: { value: AsciiTone; label: string }[] = [
  { value: 'dull', label: 'Dull' },
  { value: 'color', label: 'Color' },
];

/** Persisted in the UI store; the same preferences as Settings -> Appearance. Tone only applies to the full scene. */
export function AsciiSwitch() {
  const ascii = useUiStore((s) => s.ascii);
  const setAscii = useUiStore((s) => s.setAscii);
  const tone = useUiStore((s) => s.asciiTone);
  const setTone = useUiStore((s) => s.setAsciiTone);
  return (
    <>
      <div
        role="group"
        aria-label="ASCII rendering"
        className="flex items-center gap-1 rounded-md border p-0.5"
      >
        <span className="px-1.5 text-xs text-muted-foreground">ASCII</span>
        {ASCII_MODES.map(({ value, label }) => (
          <Button
            key={value}
            size="sm"
            variant={(ascii === 'full' ? 'full' : 'off') === value ? 'secondary' : 'ghost'}
            aria-pressed={(ascii === 'full' ? 'full' : 'off') === value}
            onClick={() => setAscii(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {ascii === 'full' && (
        <div role="group" aria-label="ASCII tone" className="flex gap-1 rounded-md border p-0.5">
          {ASCII_TONES.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={tone === value ? 'secondary' : 'ghost'}
              aria-pressed={tone === value}
              onClick={() => setTone(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Which repos leave the release percent partial or unknown, and why. Nothing renders when every state is known. */
export function UnknownReposAlert({ model }: { model: ProgressModel }) {
  const repos = useRepos();
  const repoName = (id: string) => repos.data?.find((r) => r.id === id)?.name ?? id;
  if (model.unknownRepos.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>
        {model.percent === null
          ? 'Release state unknown'
          : 'Partial: some release states are unknown'}
      </AlertTitle>
      <AlertDescription>
        <ul>
          {model.unknownRepos.map((r) => (
            <li key={r.repoId}>
              {repoName(r.repoId)}: {r.reason ? REASON_TEXT[r.reason] : 'unknown'}
            </li>
          ))}
        </ul>
        {model.undetermined.length > 0 && (
          <p>
            {plural(model.undetermined.length, 'Ready to Test card')} left out until these repos
            answer.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
