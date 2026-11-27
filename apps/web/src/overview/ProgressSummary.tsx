import { useTranslation } from 'react-i18next';
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

const SCOPES = [
  { value: 'cycle', key: 'scopeCycle' },
  { value: 'all', key: 'scopeAll' },
] as const satisfies readonly { value: CoreScope; key: string }[];

/** Persisted in the UI store. Sits in the view's header, next to the title. */
export function ScopeSwitch() {
  const scope = useUiStore((s) => s.scope);
  const setScope = useUiStore((s) => s.setScope);
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('overview.controls.scopeLabel')}
      className="flex gap-1 rounded-md border p-0.5"
    >
      {SCOPES.map(({ value, key }) => (
        <Button
          key={value}
          size="sm"
          variant={scope === value ? 'secondary' : 'ghost'}
          aria-pressed={scope === value}
          onClick={() => setScope(value)}
        >
          {t(`overview.controls.${key}`)}
        </Button>
      ))}
    </div>
  );
}

const MODES: CoreMode[] = ['S', 'A', 'B'];

/** Persisted in the UI store; the same preference as Settings -> Appearance. */
export function ModeSwitch() {
  const mode = useUiStore((s) => s.mode3d);
  const setMode = useUiStore((s) => s.setMode3d);
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('overview.controls.modeLabel')}
      className="flex gap-1 rounded-md border p-0.5"
    >
      {MODES.map((value) => (
        <Button
          key={value}
          size="sm"
          variant={mode === value ? 'secondary' : 'ghost'}
          aria-pressed={mode === value}
          onClick={() => setMode(value)}
        >
          {t(`overview.controls.mode${value}` as const)}
        </Button>
      ))}
    </div>
  );
}

const ASCII_MODES = [
  { value: 'off', key: 'asciiOff' },
  { value: 'full', key: 'asciiFull' },
] as const satisfies readonly { value: AsciiMode; key: string }[];

const ASCII_TONES = [
  { value: 'dull', key: 'toneDull' },
  { value: 'color', key: 'toneColor' },
] as const satisfies readonly { value: AsciiTone; key: string }[];

/** Persisted in the UI store; the same preferences as Settings -> Appearance. Tone only applies to the full scene. */
export function AsciiSwitch() {
  const ascii = useUiStore((s) => s.ascii);
  const setAscii = useUiStore((s) => s.setAscii);
  const tone = useUiStore((s) => s.asciiTone);
  const setTone = useUiStore((s) => s.setAsciiTone);
  const { t } = useTranslation();
  return (
    <>
      <div
        role="group"
        aria-label={t('overview.controls.asciiLabel')}
        className="flex items-center gap-1 rounded-md border p-0.5"
      >
        <span className="px-1.5 text-xs text-muted-foreground">ASCII</span>
        {ASCII_MODES.map(({ value, key }) => (
          <Button
            key={value}
            size="sm"
            variant={(ascii === 'full' ? 'full' : 'off') === value ? 'secondary' : 'ghost'}
            aria-pressed={(ascii === 'full' ? 'full' : 'off') === value}
            onClick={() => setAscii(value)}
          >
            {t(`overview.controls.${key}`)}
          </Button>
        ))}
      </div>
      {ascii === 'full' && (
        <div
          role="group"
          aria-label={t('overview.controls.toneLabel')}
          className="flex gap-1 rounded-md border p-0.5"
        >
          {ASCII_TONES.map(({ value, key }) => (
            <Button
              key={value}
              size="sm"
              variant={tone === value ? 'secondary' : 'ghost'}
              aria-pressed={tone === value}
              onClick={() => setTone(value)}
            >
              {t(`overview.controls.${key}`)}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

/** Which repos leave the release percent partial or unknown, and why. Nothing renders when every state is known. */
export function UnknownReposAlert({ model }: { model: ProgressModel }) {
  const repos = useRepos();
  const { t } = useTranslation();
  const repoName = (id: string) => repos.data?.find((r) => r.id === id)?.name ?? id;
  if (model.unknownRepos.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>
        {model.percent === null ? t('overview.unknown.title') : t('overview.unknown.partial')}
      </AlertTitle>
      <AlertDescription>
        <ul>
          {model.unknownRepos.map((r) => (
            <li key={r.repoId}>
              {repoName(r.repoId)}:{' '}
              {r.reason ? t(`overview.unknown.${r.reason}`) : t('overview.unknown.reason')}
            </li>
          ))}
        </ul>
        {model.undetermined.length > 0 && (
          <p>{t('overview.unknown.leftOut', { count: model.undetermined.length })}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
