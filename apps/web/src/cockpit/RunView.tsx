import {
  Apple,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flame,
  Loader2,
  MonitorSmartphone,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Square,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { FlutterDevice, FlutterRunMode, Workspace } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { TerminalHandle } from '@/components/term/Terminal';
import { describeError } from '@/lib/api';
import {
  launchEmulator,
  pickedFlavor,
  readRunPrefs,
  saveRunPrefs,
  useDevices,
  useKillSession,
  useRunTargets,
  useStartSession,
  type SessionView,
} from '@/lib/sessionApi';
import { cn } from '@/lib/utils';

const Terminal = lazy(() => import('@/components/term/Terminal'));

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const DEVTOOLS_RE =
  /(https?:\/\/127\.0\.0\.1:\d+\/[^\s"']*devtools[^\s"']*|https?:\/\/127\.0\.0\.1:\d+\/\?uri=[^\s"']+)/i;
const ERROR_RE = /(error|exception|failed|══╡)/i;

export type RunPhase = 'building' | 'running' | 'reloading' | 'reloaded' | 'stopped';

/** Status from `flutter run` output. Pure; exported for tests. */
export function nextPhase(prev: RunPhase, chunk: string): RunPhase {
  const t = chunk.replace(ANSI, '');
  if (/Application finished|Lost connection to device/i.test(t)) return 'stopped';
  if (/Reloaded \d+ of \d+ libraries|Restarted application/i.test(t)) return 'reloaded';
  if (/Performing hot (reload|restart)/i.test(t)) return 'reloading';
  if (/Flutter run key commands|To hot reload changes/i.test(t))
    return prev === 'building' ? 'running' : prev;
  return prev;
}

const PHASE: Record<RunPhase, { label: string; cls: string }> = {
  building: { label: 'building…', cls: 'bg-river/15 text-river-ink' },
  running: { label: 'running', cls: 'bg-moss/15 text-success' },
  reloading: { label: 'reloading…', cls: 'bg-primary/15 text-primary-ink' },
  reloaded: {
    label: 'reloaded',
    cls: 'bg-moss/15 text-success',
  },
  stopped: { label: 'stopped', cls: 'bg-muted text-muted-foreground' },
};

function DeviceIcon({ d }: { d: FlutterDevice }) {
  if (/ios|darwin|macos/i.test(d.platform)) return <Apple className="size-5" />;
  if (/web|chrome/i.test(d.platform)) return <MonitorSmartphone className="size-5" />;
  return <Smartphone className="size-5" />;
}

/** iOS keeps `-t` and drops `--flavor`. macOS (`darwin`) still passes `--flavor`. */
function deviceIsIos(platform: string): boolean {
  return /ios/i.test(platform);
}

function DevicePicker({
  ws,
  onRun,
  starting,
}: {
  ws: Workspace;
  onRun: (opts: { deviceId: string; flavor?: string; mode: FlutterRunMode; ios: boolean }) => void;
  starting: boolean;
}) {
  const q = useDevices(ws.id);
  const targets = useRunTargets(ws.id);
  const [booting, setBooting] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [flavor, setFlavor] = useState(() => readRunPrefs(ws.id).flavor);
  const [mode, setMode] = useState<FlutterRunMode>(() => readRunPrefs(ws.id).mode);
  const flavors = targets.data?.flavors ?? [];
  const chosen = pickedFlavor(flavors, flavor);
  const canRun = !!targets.data && (flavors.length > 0 ? chosen !== '' : targets.data.plainMain);

  // After "Boot", poll until the emulator shows up as a device.
  useEffect(() => {
    if (!booting) return;
    const t = setInterval(() => void q.refetch(), 4_000);
    const stop = setTimeout(() => setBooting(null), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [booting]);
  useEffect(() => {
    if (booting && q.data?.some((d) => d.source === 'device' && d.emulator)) setBooting(null);
  }, [q.data, booting]);
  useEffect(() => {
    const prefs = readRunPrefs(ws.id);
    setFlavor(prefs.flavor);
    setMode(prefs.mode);
  }, [ws.id]);

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {flavors.length > 1 ? (
          <label className="grid gap-1 text-sm font-medium">
            Flavor
            <Select
              aria-label="Flavor"
              value={chosen}
              onChange={(e) => {
                setFlavor(e.target.value);
                saveRunPrefs(ws.id, e.target.value, mode);
              }}
            >
              <option value="">Choose…</option>
              {flavors.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <p className="self-end text-sm">
            {targets.isPending ? (
              <span className="text-muted-foreground">Reading entrypoints…</span>
            ) : flavors.length === 1 ? (
              <>
                Entrypoint <span className="font-mono">lib/main_{flavors[0]}.dart</span>
              </>
            ) : targets.data?.plainMain ? (
              <>
                Entrypoint <span className="font-mono">lib/main.dart</span>
              </>
            ) : targets.data ? (
              <span className="text-destructive">
                {'No lib/main.dart or lib/main_<flavor>.dart in this workspace.'}
              </span>
            ) : null}
          </p>
        )}
        <label className="grid gap-1 text-sm font-medium">
          Mode
          <Select
            aria-label="Mode"
            value={mode}
            onChange={(e) => {
              const next = e.target.value as FlutterRunMode;
              setMode(next);
              saveRunPrefs(ws.id, flavor, next);
            }}
          >
            <option value="debug">Debug</option>
            <option value="profile">Profile</option>
            <option value="release">Release</option>
          </Select>
        </label>
      </div>
      {targets.error && <p className="text-sm text-destructive">{describeError(targets.error)}</p>}
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Device</p>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw className={cn('size-4', q.isFetching && 'motion-safe:animate-spin')} />
        </Button>
      </div>
      {q.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" /> flutter devices…
        </p>
      )}
      {q.error && <p className="text-sm text-destructive">{describeError(q.error)}</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {(q.data ?? []).map((d) => (
          <li
            key={`${d.source}:${d.id}`}
            className="flex items-center gap-3 rounded-surface border bg-card p-3"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-muted">
              <DeviceIcon d={d} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{d.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {d.platform} · {d.source === 'device' ? 'ready' : 'off'}
              </p>
            </div>
            {d.source === 'device' ? (
              <Button
                size="sm"
                onClick={() =>
                  onRun({
                    deviceId: d.id,
                    mode,
                    ios: deviceIsIos(d.platform),
                    ...(chosen ? { flavor: chosen } : {}),
                  })
                }
                disabled={starting || !canRun}
              >
                <Play className="size-4" /> Run
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={booting !== null}
                onClick={() => {
                  setBootError(null);
                  setBooting(d.id);
                  launchEmulator(ws.id, d.id).catch((e: unknown) => {
                    setBooting(null);
                    setBootError(describeError(e));
                  });
                }}
              >
                {booting === d.id ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Power className="size-4" />
                )}
                Boot
              </Button>
            )}
          </li>
        ))}
      </ul>
      {booting && (
        <p className="text-xs text-muted-foreground">Waiting for emulator {booting} to boot…</p>
      )}
      {bootError && <p className="text-xs text-destructive">{bootError}</p>}
      {q.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No device or emulator.</p>
      )}
    </div>
  );
}

export function RunSession({ s }: { s: SessionView }) {
  const term = useRef<TerminalHandle>(null);
  const kill = useKillSession();
  const [phase, setPhase] = useState<RunPhase>(s.state === 'exited' ? 'stopped' : 'building');
  const [devtools, setDevtools] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const exited = s.state === 'exited';

  const onOutput = (chunk: string) => {
    setPhase((p) => nextPhase(p, chunk));
    const plain = chunk.replace(ANSI, '');
    const m = DEVTOOLS_RE.exec(plain);
    if (m) setDevtools(m[1]!);
    const errs = plain.split('\n').filter((l) => ERROR_RE.test(l) && l.trim());
    if (errs.length) setErrors((prev) => [...prev, ...errs].slice(-200));
  };
  const p = PHASE[exited ? 'stopped' : phase];
  const ctrl = 'h-12 rounded-surface';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', p.cls)}>{p.label}</span>
        <span className="truncate text-xs text-muted-foreground">{s.title}</span>
        {devtools && (
          <a
            href={devtools}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-primary-ink underline-offset-4 hover:underline"
          >
            DevTools <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Button className={ctrl} disabled={exited} onClick={() => term.current?.send('r')}>
          <Flame className="size-4" /> Hot reload
        </Button>
        <Button
          className={ctrl}
          variant="outline"
          disabled={exited}
          onClick={() => term.current?.send('R')}
        >
          <RotateCcw className="size-4" /> Restart
        </Button>
        <Button
          className={ctrl}
          variant="outline"
          onClick={() => (exited ? kill.mutate(s.id) : term.current?.send('q'))}
        >
          <Square className="size-4" /> {exited ? 'Close' : 'Stop'}
        </Button>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          className="font-medium"
          onClick={() => setShowLog((v) => !v)}
          aria-expanded={showLog}
        >
          {showLog ? (
            <ChevronDown aria-hidden className="inline size-3.5" />
          ) : (
            <ChevronRight aria-hidden className="inline size-3.5" />
          )}{' '}
          Log
        </button>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={(e) => setOnlyErrors(e.target.checked)}
          />
          errors only {errors.length > 0 && <Badge variant="destructive">{errors.length}</Badge>}
        </label>
      </div>
      {onlyErrors && (
        <pre className="max-h-48 overflow-auto rounded-xl bg-muted p-2 font-mono text-2xs whitespace-pre-wrap text-destructive">
          {errors.join('\n') || 'No errors yet.'}
        </pre>
      )}
      <div className={cn('flex min-h-0 flex-1 flex-col', !showLog && 'hidden')}>
        <Suspense fallback={<Loader2 className="size-5 motion-safe:animate-spin" />}>
          <Terminal ref={term} sessionId={s.id} onOutput={onOutput} fontSize={11} />
        </Suspense>
      </div>
    </div>
  );
}

/** Run tab: devices/emulators → `flutter run -d` in a PTY → reload controls. */
export function RunView({ ws, sessions }: { ws: Workspace; sessions: SessionView[] }) {
  const start = useStartSession();
  const runs = useMemo(
    () => sessions.filter((s) => s.kind === 'flutter' && s.workspaceId === ws.id),
    [sessions, ws.id],
  );
  const active = runs.find((s) => s.state !== 'exited') ?? runs.at(-1);
  if (active) return <RunSession key={active.id} s={active} />;
  return (
    <div className="grid gap-3">
      <DevicePicker
        ws={ws}
        starting={start.isPending}
        onRun={(opts) => start.mutate({ workspaceId: ws.id, kind: 'flutter', ...opts })}
      />
      {start.error && <p className="text-sm text-destructive">{describeError(start.error)}</p>}
    </div>
  );
}
