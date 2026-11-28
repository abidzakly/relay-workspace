import { BOTTOM_BAR } from '@/components/FloatingThemeSwitch';
import { BranchSwitcher } from '@/components/branches/BranchSwitcher';
import { QuickRunBanner } from '@/components/branches/QuickRunBanner';
import { branchesPath } from '@/lib/branchesApi';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ExternalLink,
  ListChecks,
  Loader2,
  Globe,
  PenTool,
  RefreshCw,
  Sparkles,
  Smartphone,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Finding, TestBenchState } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { Dropdown } from '@/components/Dropdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/api';
import { useWorkspaces } from '@/lib/cockpitApi';
import { benchPath, benchSessionsFor, rememberBenchReturn } from '@/lib/benchReturn';
import { launchEmulator, useDevices, useRunTargets, useSessions } from '@/lib/sessionApi';
import { emit } from '@/lib/reward/engine';
import {
  refreshBody,
  testBenchKeys,
  useDeviceList,
  useFinish,
  useFixWithAi,
  useTestBench,
} from '@/lib/testBenchApi';
import { cn, safeHref } from '@/lib/utils';
import { AcChecklist } from '@/testBench/AcChecklist';
import { AiRunPanel } from '@/testBench/AiRunPanel';
import { LogDrawer, type LogTab } from '@/testBench/LogDrawer';
import { DeviceMirror, type DeviceMirrorHandle } from '@/testBench/DeviceMirror';
import { FigmaPanel, figmaImageUrl, frameFor, type CompareMode } from '@/testBench/FigmaPanel';
import { FindingDialog } from '@/testBench/FindingDialog';
import { MrSteps } from '@/testBench/MrSteps';
import { RunStrip } from '@/testBench/RunStrip';
import { WebPreview } from '@/testBench/WebPreview';
import { WebRunStrip } from '@/testBench/WebRunStrip';
import { PageTitle } from '@/components/PageTitle';

/**
 * `/test-bench/:repo?branch=`: one page to test a branch before its MR. The card's Acceptance
 * Criteria on the left, the phone in the middle, the Figma frame on the right. On a phone the three become tabs.
 * The verdict is the server's; this page only asks for it.
 */

const DEVICE_KEY = 'test-bench:device';
const readDevice = () => {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
};
const saveDevice = (serial: string) => {
  try {
    localStorage.setItem(DEVICE_KEY, serial);
  } catch {
    /* private mode: just not remembered */
  }
};

type Pane = 'checks' | 'phone' | 'design';
const PANES: { id: Pane; icon: typeof ListChecks }[] = [
  { id: 'checks', icon: ListChecks },
  { id: 'phone', icon: Smartphone },
  { id: 'design', icon: PenTool },
];

function Readiness({ st }: { st: TestBenchState }) {
  const r = st.readiness;
  const run = st.latestRun;
  return (
    <section
      aria-label="Readiness"
      className="flex flex-wrap items-center gap-2 rounded-surface border bg-card px-3 py-2 text-sm"
    >
      <span className="font-medium">
        {r.counts.passed}/{r.counts.ac} AC passed
      </span>
      {r.counts.regressions > 0 && (
        <span className="text-muted-foreground">· {r.counts.regressions} to retest</span>
      )}
      {r.counts.openFindings > 0 && (
        <span className="text-muted-foreground">· {r.counts.openFindings} open</span>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {st.testOk ? (
          <Badge variant="success">
            <CheckCircle2 aria-hidden /> Tested on this commit
          </Badge>
        ) : run?.status === 'done' && run.verdict === 'ready' ? (
          <Badge variant="warning">
            <TriangleAlert aria-hidden /> Tested an older commit
          </Badge>
        ) : run?.status === 'done' && run.verdict === 'not_ready' ? (
          <Badge variant="destructive">
            <XCircle aria-hidden /> Marked not ready
          </Badge>
        ) : (
          <Badge variant="outline">Not tested yet</Badge>
        )}
        {st.headSha && (
          <span className="font-mono text-xs text-muted-foreground">{st.headSha.slice(0, 8)}</span>
        )}
      </span>
    </section>
  );
}

export function TestBench() {
  const { repo = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const branch = search.get('branch') ?? '';
  // The agent session last sent this branch's findings (this browser), while the cockpit still has it.
  const sessions = useSessions();
  const here = benchPath(repo, branch);
  const agentSession = useMemo(() => {
    const live = new Map((sessions.data ?? []).map((s) => [s.id, s]));
    for (const id of benchSessionsFor(here)) {
      const s = live.get(id);
      if (s) return s;
    }
    return null;
  }, [sessions.data, here]);
  // "Run this branch" (Create MR, MR Inbox, Code Review): check the branch out on arrival, then drop the flag.
  const autoRun = search.get('run') === '1';
  const clearAutoRun = useCallback(
    () =>
      setSearch(
        (p) => {
          p.delete('run');
          return p;
        },
        { replace: true },
      ),
    [setSearch],
  );
  const navigate = useNavigate();
  const { key: locationKey } = useLocation();
  const qc = useQueryClient();
  const q = useTestBench(repo, branch);
  const devices = useDeviceList();
  const workspaces = useWorkspaces();
  const ws = (workspaces.data ?? []).find((w) => w.repoId === repo) ?? null;
  // A web workspace (package.json, no pubspec.yaml) runs a dev server and shows its preview instead of a phone.
  const targets = useRunTargets(ws?.id ?? null);
  const web = targets.data?.kind === 'web' ? (targets.data.web ?? null) : null;
  const flutter = useDevices(ws && targets.data && !web ? ws.id : null);
  const { t } = useTranslation();
  const webSessions = (sessions.data ?? []).filter(
    (s) => s.workspaceId === ws?.id && s.kind === 'web',
  );
  const webSession =
    webSessions.find((s) => s.state !== 'exited') ??
    webSessions.sort((a, b) => b.startedAt - a.startedAt)[0] ??
    null;
  const finish = useFinish(repo, branch);
  const fix = useFixWithAi(repo, branch);
  const mirror = useRef<DeviceMirrorHandle>(null);

  const [serial, setSerial] = useState<string | null>(readDevice);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('checks');
  const [mode, setMode] = useState<CompareMode>('side');
  const [opacity, setOpacity] = useState(0.5);
  const [dialog, setDialog] = useState<{ editing: Finding | null; acKey: string | null } | null>(
    null,
  );
  const [logTab, setLogTab] = useState<LogTab | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [booting, setBooting] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const ready = (devices.data?.devices ?? []).filter((d) => d.state === 'device');
  const adbIds = new Set(ready.map((d) => d.serial));
  // `flutter devices` from the repo's workspace: adds iOS/desktop/web targets and emulators that can be booted.
  const flutterRunning = (flutter.data ?? []).filter((d) => d.source === 'device');
  const flutterOnly = flutterRunning.filter((d) => !adbIds.has(d.id));
  const bootable = (flutter.data ?? []).filter((d) => d.source === 'emulator');
  const runnable = [...ready.map((d) => d.serial), ...flutterOnly.map((d) => d.id)];
  const picked = flutterRunning.find((d) => d.id === serial);
  const pickedIsAdb = !!serial && adbIds.has(serial);
  const pickedIos = !!picked && /ios/i.test(picked.platform);
  useEffect(() => {
    // Keep the remembered device if it is still there; otherwise take the only plugged-in phone.
    if (serial && runnable.includes(serial)) return;
    if (ready.length === 1) setSerial(ready[0]!.serial);
  }, [runnable.join(','), serial]);

  // After "Boot", poll both lists until a new emulator shows up, then pick it.
  const bootBaseline = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!booting) return;
    // adb list is cheap and shows the emulator as soon as it is up; `flutter devices` spawns fvm, so refetch it only once.
    const t = setInterval(() => void devices.refetch(), 3_000);
    const stop = setTimeout(() => setBooting(null), 120_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [booting]);
  useEffect(() => {
    if (!booting) return;
    const fresh =
      ready.find((d) => d.serial.startsWith('emulator-') && !bootBaseline.current.has(d.serial))
        ?.serial ?? flutterRunning.find((d) => d.emulator && !bootBaseline.current.has(d.id))?.id;
    if (!fresh) return;
    setBooting(null);
    setSerial(fresh);
    saveDevice(fresh);
    void flutter.refetch();
  }, [ready.map((d) => d.serial).join(','), flutterRunning.map((d) => d.id).join(','), booting]);
  const boot = (emulatorId: string) => {
    if (!ws) return;
    bootBaseline.current = new Set([
      ...flutterRunning.map((d) => d.id),
      ...ready.map((d) => d.serial),
    ]);
    setBootError(null);
    setBooting(emulatorId);
    launchEmulator(ws.id, emulatorId).catch((e: unknown) => {
      setBooting(null);
      setBootError(describeError(e));
    });
  };

  const mrCreatePath = `/mr-create/${encodeURIComponent(repo)}?branch=${encodeURIComponent(branch)}`;
  const st = q.data;
  const overlaySrc = useMemo(() => {
    if (!st || mode !== 'overlay') return null;
    const t = frameFor(st, selectedKey);
    return t ? figmaImageUrl(t.fileKey, t.nodeId) : null;
  }, [st, mode, selectedKey]);

  if (!repo || !branch) return <Alert variant="destructive">Invalid address.</Alert>;

  const back = (
    <button
      type="button"
      className="rv-icon-btn"
      aria-label="Back"
      onClick={() =>
        void (locationKey === 'default'
          ? navigate(q.data && !q.data.card ? branchesPath(repo) : mrCreatePath)
          : navigate(-1))
      }
    >
      <ArrowLeft className="size-4" />
    </button>
  );
  if (q.isPending) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        {back}
        <Loader2 className="size-4 motion-safe:animate-spin" /> Reading the card…
      </div>
    );
  }
  if (q.error || !st) {
    return (
      <div className="grid max-w-2xl gap-3 p-4">
        {back}
        <Alert variant="destructive">
          <AlertTitle>Could not open the Test Bench</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const run = st.latestRun;
  const openFindings = st.findings.filter((f) => f.status === 'open').length;
  const fixing = st.findings.filter((f) => f.status === 'fixing').length;
  const sendToAgent = () =>
    fix.mutate(undefined, {
      onSuccess: (r) => {
        rememberBenchReturn(r.sessionId, r.returnTo);
        void navigate(
          `/cockpit?ws=${encodeURIComponent(r.workspaceId)}&session=${encodeURIComponent(r.sessionId)}&tab=agent&returnTo=${encodeURIComponent(r.returnTo)}`,
        );
      },
    });
  const canNotReady =
    st.findings.some((f) => f.status === 'open') || st.readiness.counts.failed > 0;
  const finishWith = (verdict: 'ready' | 'not_ready') =>
    finish.mutate(
      { verdict, summary: '' },
      {
        onSuccess: (r) => {
          // A real, server-confirmed unit of work: once per commit.
          if (verdict === 'ready') {
            emit({
              level: 'pop',
              key: `bench:${repo}:${branch}:${r.headSha}`,
              title: 'Tested on device',
              persist: true,
            });
          }
        },
      },
    );

  const unauthorized = (devices.data?.devices ?? []).filter((d) => d.state === 'unauthorized');
  // No card: run the app as is. The AC, Figma and "mark tested" parts need a card.
  const quick = !st.card;

  return (
    <div className="grid w-full min-w-0 gap-4 p-1 sm:p-4">
      <header className="flex min-w-0 flex-wrap items-end gap-2">
        {back}
        <div className="min-w-0 flex-1">
          <PageTitle>{web ? t('testBench.title.web') : t('testBench.title.device')}</PageTitle>
          <p className="truncate font-mono text-xs text-muted-foreground">{branch}</p>
        </div>
        <BranchSwitcher repo={repo} branch={branch} />
        {agentSession && (
          <Link
            to={`/cockpit?ws=${encodeURIComponent(agentSession.workspaceId)}&session=${encodeURIComponent(agentSession.id)}&tab=agent&returnTo=${encodeURIComponent(here)}`}
            title={`Open the agent session in the Cockpit: ${agentSession.title}`}
            className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full border px-2.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Bot className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Agent in Cockpit</span>
          </Link>
        )}
        {st.card?.url && (
          <Button size="sm" variant="ghost" asChild>
            <a href={safeHref(st.card.url) ?? undefined} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="size-4" /> Card
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-auto min-h-8 whitespace-normal"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            setRefreshError(null);
            refreshBody(repo, branch)
              .then((fresh) => qc.setQueryData(testBenchKeys.branch(repo, branch), fresh))
              .catch((e: unknown) => setRefreshError(describeError(e)))
              .finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw className={cn('size-4', refreshing && 'motion-safe:animate-spin')} /> Re-read
          card
        </Button>
      </header>

      {quick && <QuickRunBanner repo={repo} branch={branch} />}
      {!quick && (
        <MrSteps
          steps={[
            { label: 'Test on device', state: 'current' },
            { label: 'Review deck', state: 'todo', to: mrCreatePath },
            { label: 'Create MR', state: 'todo', to: mrCreatePath },
          ]}
        />
      )}

      {st.card && <p className="text-sm">{st.card.title}</p>}
      {!quick && (st.bodyError || refreshError) && (
        <Alert variant="warning">
          <AlertTitle>Card body</AlertTitle>
          <AlertDescription>
            {refreshError ?? st.bodyError}
            {st.body && ' Showing the last copy read.'}
          </AlertDescription>
        </Alert>
      )}
      {st.body?.truncated && (
        <p className="text-xs text-muted-foreground">
          The card is very long: only its first blocks were read.
        </p>
      )}

      {!quick && <Readiness st={st} />}

      {!quick && (
        <div
          role="tablist"
          aria-label="Test Bench panes"
          className="flex rounded-control border p-0.5 xl:hidden"
        >
          {PANES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={pane === id}
              onClick={() => setPane(id)}
              className={cn(
                'tactile flex h-9 flex-1 items-center justify-center gap-1.5 rounded-control text-sm',
                pane === id ? 'bg-accent font-medium' : 'text-muted-foreground',
              )}
            >
              {id === 'phone' && web ? (
                <Globe aria-hidden className="size-4" />
              ) : (
                <Icon aria-hidden className="size-4" />
              )}{' '}
              {t(`testBench.panes.${id === 'phone' && web ? 'preview' : id}`)}
            </button>
          ))}
        </div>
      )}

      <div
        className={cn(
          'grid min-w-0 gap-6',
          quick
            ? cn('mx-auto w-full', web ? 'max-w-6xl' : 'max-w-xl')
            : web
              ? 'xl:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)_minmax(16rem,1fr)] xl:items-start'
              : 'xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)_minmax(0,1fr)] xl:items-start',
        )}
      >
        {!quick && (
          <div className={cn('min-w-0', pane !== 'checks' && 'hidden xl:block')}>
            <AcChecklist
              repo={repo}
              branch={branch}
              st={st}
              selectedKey={selectedKey}
              onSelect={(k) => setSelectedKey((cur) => (cur === k ? null : k))}
              onAddFinding={(acKey) => setDialog({ editing: null, acKey })}
              onEditFinding={(f) => setDialog({ editing: f, acKey: f.acKey })}
            />
          </div>
        )}

        <div
          className={cn(
            'grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 xl:sticky xl:top-4',
            pane !== 'phone' && !quick && 'hidden xl:grid',
          )}
        >
          {web ? (
            <>
              <WebRunStrip
                repo={repo}
                branch={branch}
                targets={web}
                autoPrepare={autoRun}
                onAutoPrepared={clearAutoRun}
                onOpenLog={() => setLogTab('app')}
              />
              <WebPreview session={webSession} />
            </>
          ) : (
            <>
              <Dropdown
                label="Phone"
                icon={Smartphone}
                width="full"
                placeholder={
                  booting
                    ? `Booting ${booting}…`
                    : devices.isPending || flutter.isFetching
                      ? 'Looking for devices…'
                      : 'Plug in a phone or boot an emulator'
                }
                value={serial}
                onChange={(s) => {
                  if (s.startsWith('boot:')) {
                    boot(s.slice(5));
                    return;
                  }
                  setSerial(s);
                  saveDevice(s);
                }}
                options={[
                  ...ready.map((d) => ({
                    value: d.serial,
                    label:
                      d.model ?? flutterRunning.find((f) => f.id === d.serial)?.name ?? d.serial,
                    hint: d.serial,
                  })),
                  ...flutterOnly.map((d) => ({
                    value: d.id,
                    label: d.name,
                    hint: `${d.platform} · run only, no mirror`,
                  })),
                  ...bootable.map((d) => ({
                    value: `boot:${d.id}`,
                    label: `Boot ${d.name}`,
                    hint: `${d.platform} emulator · off`,
                    disabled: booting !== null,
                  })),
                ]}
                footer={
                  runnable.length === 0 && bootable.length === 0
                    ? flutter.isFetching
                      ? 'Running flutter devices…'
                      : 'No device found. Plug a phone in with USB debugging on, or add an emulator.'
                    : undefined
                }
              />
              {devices.data?.error && (
                <p className="text-xs text-destructive">{devices.data.error}</p>
              )}
              {flutter.error && (
                <p className="text-xs text-destructive">{describeError(flutter.error)}</p>
              )}
              {booting && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" /> Waiting for
                  emulator {booting} to boot…
                </p>
              )}
              {bootError && <p className="text-xs text-destructive">{bootError}</p>}
              {serial && picked && !pickedIsAdb && (
                <p className="text-xs text-muted-foreground">
                  {picked.name} can run the app, but the screen mirror and AI test need an Android
                  device over adb.
                </p>
              )}
              {unauthorized.length > 0 && (
                <p className="text-xs text-warning">
                  Allow USB debugging on the phone ({unauthorized[0]!.serial}).
                </p>
              )}
              <RunStrip
                repo={repo}
                branch={branch}
                serial={serial}
                ios={pickedIos}
                autoPrepare={autoRun}
                onAutoPrepared={clearAutoRun}
                onOpenLog={() => setLogTab('app')}
              />
              {!quick && (
                <AiRunPanel
                  repo={repo}
                  branch={branch}
                  st={st}
                  serial={pickedIsAdb ? serial : null}
                  onOpenLog={() => setLogTab('agent')}
                />
              )}
              {pickedIsAdb ? (
                <DeviceMirror
                  key={serial}
                  ref={mirror}
                  serial={serial}
                  overlay={overlaySrc ? { src: overlaySrc, opacity } : null}
                />
              ) : (
                <div className="grid aspect-[9/19] h-[min(64vh,44rem)] max-w-full place-items-center justify-self-center rounded-sheet border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Pick a plugged-in phone to see its screen here.
                </div>
              )}
            </>
          )}
        </div>

        {!quick && (
          <div className={cn('min-w-0', pane !== 'design' && 'hidden xl:block')}>
            <FigmaPanel
              repo={repo}
              branch={branch}
              st={st}
              selectedKey={selectedKey}
              mode={mode}
              onMode={setMode}
              opacity={opacity}
              onOpacity={setOpacity}
            />
          </div>
        )}
      </div>

      {!quick && (
        <div
          {...BOTTOM_BAR}
          className="sticky bottom-0 z-30 rounded-surface border bg-background px-4 py-3 shadow-lift"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="hidden min-w-0 flex-1 text-sm text-muted-foreground sm:block">
              {st.readiness.ready
                ? 'Every check passed. Mark it tested to continue to the review deck.'
                : st.readiness.blockers.join(' · ')}
            </p>
            {(finish.error || fix.error) && (
              <p className="w-full text-sm text-destructive">
                {describeError(finish.error ?? fix.error)}
              </p>
            )}
            {fixing > 0 && (
              <p className="w-full text-xs text-muted-foreground">
                An agent is fixing {fixing} finding{fixing > 1 ? 's' : ''}. They move to Regression
                checks when its commit lands.
              </p>
            )}
            {openFindings > 0 && run?.status === 'done' && run.verdict === 'not_ready' && (
              <Button
                variant="secondary"
                className="h-auto min-h-9 w-full whitespace-normal text-center sm:w-auto"
                disabled={fix.isPending}
                onClick={sendToAgent}
              >
                {fix.isPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Fix {openFindings} with AI
              </Button>
            )}
            {run?.status === 'done' && run.verdict === 'ready' && st.testOk ? (
              <Button
                asChild
                className="h-auto min-h-9 w-full whitespace-normal text-center sm:w-auto"
              >
                <Link to={mrCreatePath}>Continue to review deck</Link>
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="h-auto min-h-9 w-full whitespace-normal text-center sm:w-auto"
                  disabled={!canNotReady || finish.isPending}
                  onClick={() => finishWith('not_ready')}
                >
                  <XCircle className="size-4" /> Not ready, save findings
                </Button>
                <Button
                  className="h-auto min-h-9 w-full whitespace-normal text-center sm:w-auto"
                  disabled={!st.readiness.ready || finish.isPending}
                  onClick={() => finishWith('ready')}
                >
                  {finish.isPending ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Tested: all AC and Figma pass
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {dialog && st.body && (
        <FindingDialog
          key={dialog.editing?.id ?? `new:${dialog.acKey ?? ''}`}
          repo={repo}
          branch={branch}
          ac={st.body.ac}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          editing={dialog.editing}
          defaultAcKey={dialog.acKey}
        />
      )}
      <LogDrawer
        repo={repo}
        runId={run?.mode === 'ai' ? run.id : null}
        tab={logTab}
        onTab={setLogTab}
        onClose={() => setLogTab(null)}
      />
    </div>
  );
}
