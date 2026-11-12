import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowLeft, Maximize, Minimize, RotateCcw } from 'lucide-react';
import { motion } from 'motion/react';
import { useLocation, useNavigate } from 'react-router';
import { CommandButton } from '@/components/CommandPalette';
import { AiStatusButton } from '@/components/AiCheck';
import { ConnectionIndicator } from '@/components/ConnectionIndicator';
import { NotificationBell } from '@/components/NotificationBell';
import { PageSwap } from '@/components/PageSwap';
import { SoundToggle } from '@/components/SoundToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { XpChip } from '@/components/XpChip';
import { Button } from '@/components/ui/button';
import { SPRING } from '@/lib/motion/presets';
import { useWallClock } from '@/lib/useWallClock';
import { cn } from '@/lib/utils';
import { detectWebgl } from '@/lib/webgl';
import { useNeedsActionGroups } from '@/overview/useNeedsActionGroups';
import { DEFAULT_ENV, ENV_LABEL, isStowed, type EnvId } from './envFor';
import { FirstWin } from './FirstWin';
import { pickNextJob } from './nextJob';
import { NextJobCard } from './NextJobCard';
import { thingIn } from './objects/names';
import { PresentationContext, type Presentation } from './presentation';
import { RESET_VIEW_EVENT } from './layout';
import {
  isPagePath,
  objectById,
  objectForPath,
  pickInfo,
  viaOf,
  type ObjectId,
  type PickId,
} from './registry';
import { SceneMenu, ToneDot } from './SceneMenu';
import { useFullscreen } from './useFullscreen';
import { useCoarsePointer, useNarrow, useReducedMotion } from './useMedia';
import { useWorkspaceSignals } from './useWorkspaceSignals';

const WorkspaceCanvas = lazy(() =>
  import('./WorkspaceCanvas').then((m) => ({ default: m.WorkspaceCanvas })),
);

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm';
const dialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
const typing = (el: EventTarget | null) => el instanceof Element && el.closest(TYPING) !== null;

/** A renderer that fails despite the WebGL check, or a chunk that fails to load: the 2D menu takes over. */
class SceneBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** How long the waking room may hide the world if the world's chunk never answers. */
const WAKING_LIMIT_MS = 6000;

/**
 * The room waking: covers the canvas until the right world has loaded. A deep link gets a plain cover and no words,
 * because its page opens straight away.
 */
function RoomWaking({ visible, quiet }: { visible: boolean; quiet: boolean }) {
  const count = useWakingCount(visible && !quiet);
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 bg-scrim text-terminal-foreground transition-[opacity,visibility] duration-700',
        !visible && 'invisible opacity-0',
      )}
    >
      {!quiet && (
        <>
          <p className="absolute top-1/2 left-4 -translate-y-1/2 type-micro md:left-10">
            Waking the <span className="type-accent text-sm">room</span>
          </p>
          <p
            className="absolute top-1/2 right-4 -translate-y-1/2 font-mono text-sm tabular-nums md:right-10"
            aria-hidden
          >
            {String(count).padStart(3, '0')}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The loader's counter: it runs towards 99 on an easing curve while the world loads, and lands on 100 when it is
 * ready. It is a feeling of progress, not a measure of bytes, so it never claims 100 before the world is there.
 */
function useWakingCount(running: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!running) {
      setCount(100);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = 1 - Math.exp(-(t - start) / 1400);
      setCount(Math.min(99, Math.floor(k * 100)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  return count;
}

/**
 * The header's clock: its own component, so ticking re-renders only this text, not the world. It shares the page's
 * wall clock (`useWallClock`) with the scene's daylight, so the time shown and the light drawn always agree.
 */
function HeaderClock() {
  const now = useWallClock();
  return <>{new Date(now).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</>;
}

/**
 * The Living Workspace (`homeMode: 'scene'`): the world fills the screen, and every route opens as a page over it.
 * The URL is the source of truth: a click on an object navigates, and the camera follows the URL, so the browser's
 * back button, `g <key>` chords, the command palette and deep links all move the camera too.
 *
 * Free of three.js: the canvas is a lazy chunk, loaded only when WebGL2 is there.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [webgl] = useState(detectWebgl);
  const reducedMotion = useReducedMotion();
  const narrow = useNarrow();
  const coarse = useCoarsePointer();
  const fullscreen = useFullscreen();
  const data = useWorkspaceSignals();
  const now = useWallClock();
  // Dev only: `?env=leave&hour=21` previews another world and hour.
  const preview = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
  const env = (preview?.get('env') as EnvId | null) ?? DEFAULT_ENV;
  const hourParam = preview?.get('hour');
  const hour = hourParam ? Number(hourParam) : new Date(now).getHours();
  const needs = useNeedsActionGroups();
  // Only from a clean read: a failed source must not hide what is urgent, and off-duty worlds never nag.
  const job = needs.settled && !isStowed(env) ? pickNextJob(needs.groups) : null;

  const page = isPagePath(location.pathname);
  const focus = objectForPath(location.pathname);
  // A deep link opens its page at once (the camera jumps there unseen); otherwise the page waits for the camera.
  const [open, setOpen] = useState(page);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState<PickId | null>(null);
  const [tipAt, setTipAt] = useState<{ x: number; y: number } | null>(null);
  const [armed, setArmed] = useState<PickId | null>(null);
  const via = viaOf(location.state);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  useEffect(() => {
    if (!page) setOpen(false);
    setHovered(null);
    setArmed(null);
  }, [page, location.pathname]);

  // The arrival waits for today's world to load.
  const [startedOnPage] = useState(page);
  const [sawPage, setSawPage] = useState(page);
  const [readyEnv, setReadyEnv] = useState<EnvId | null>(null);
  const [wakingExpired, setWakingExpired] = useState(false);
  useEffect(() => {
    if (page) setSawPage(true);
  }, [page]);
  useEffect(() => {
    const timer = setTimeout(() => setWakingExpired(true), WAKING_LIMIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const awake = wakingExpired || readyEnv === env;
  const arrive = awake && !page && !sawPage && !reducedMotion;

  const shown = page && (open || !webgl || reducedMotion || focus === null);
  // Overview in a world is the ship itself: its panels float over the detailed CoreStage.
  const presentation: Presentation = webgl && focus === 'plant' ? 'world' : 'page';
  // Fetch the detailed core while the camera is still flying, so the hand-over does not wait for a download.
  useEffect(() => {
    if (presentation === 'world') void import('@/core3d/CoreCanvas');
  }, [presentation]);
  const travelling = focus !== null && !shown;

  const onArrive = useCallback((id: ObjectId | null, at: { x: number; y: number } | null) => {
    if (id !== null && id === focusRef.current) {
      setOrigin(at);
      setOpen(true);
    }
  }, []);

  const pick = useCallback(
    (id: PickId, touch: boolean) => {
      if (travelling) return; // clicks during the flight are ignored
      // Touch has no hover: the first tap shows what the object is, the second opens it.
      if (touch && armed !== id) {
        setArmed(id);
        return;
      }
      const info = pickInfo(id);
      void navigate(info.route, info.state ? { state: info.state } : undefined);
    },
    [armed, navigate, travelling],
  );

  const back = useCallback(() => void navigate('/'), [navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target) || typing(document.activeElement) || dialogOpen()) return;
      if (e.key === 'Escape' && page) {
        e.preventDefault();
        back();
      } else if (e.key === 'f' && fullscreen.supported) {
        e.preventDefault();
        fullscreen.toggle();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [page, back, fullscreen]);

  const fallback = (
    <div className="absolute inset-0 overflow-y-auto bg-background p-4 pt-24 md:p-10 md:pt-32">
      <p className="mb-6 type-micro text-muted-foreground">
        The 3D world is off in this browser. Every tab is here instead.
      </p>
      <SceneMenu data={data} env={env} layout="grid" />
    </div>
  );

  const tipId = hovered ?? armed;
  const tipObject = tipId ? pickInfo(tipId) : null;
  const tipSignal = tipObject?.signalOf ? data.signals[tipObject.signalOf] : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
      {/* The world. Hidden from assistive tech: the menu below says everything it shows. */}
      <div className="absolute inset-0" aria-hidden="true">
        {webgl ? (
          <SceneBoundary fallback={fallback}>
            <RoomWaking visible={!awake} quiet={startedOnPage} />
            <Suspense fallback={null}>
              <WorkspaceCanvas
                data={data}
                env={env}
                hour={hour}
                focus={focus}
                instant={open}
                highlighted={tipId}
                nudge={job?.object ?? null}
                via={via}
                paused={shown}
                reducedMotion={reducedMotion}
                narrow={narrow}
                arrive={arrive}
                onHover={setHovered}
                onProject={setTipAt}
                onPick={pick}
                onArrive={onArrive}
                onWorldReady={setReadyEnv}
              />
            </Suspense>
          </SceneBoundary>
        ) : (
          fallback
        )}
      </div>

      {/* Tooltip, pinned to the object. */}
      {!page && tipId && tipAt && tipObject && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-surface border border-hairline bg-popover/95 px-3 py-2 text-popover-foreground shadow-lift"
          style={{ left: tipAt.x, top: tipAt.y }}
        >
          <p className="flex items-center gap-1.5 type-micro">
            {tipSignal && <ToneDot tone={tipSignal.tone} />}
            {tipObject.label}
          </p>
          <p className="type-accent text-base text-muted-foreground">{thingIn(env, tipId!)}</p>
          {tipSignal && <p className="text-xs text-muted-foreground">{tipSignal.summary}</p>}
          {coarse && armed === tipId && (
            <p className="mt-1 text-xs font-medium text-primary-ink">Tap again to open</p>
          )}
        </div>
      )}

      {/* HUD */}
      <header
        className={cn(
          // Phones stack the toolbar above the title card: side by side they are wider than the screen.
          'pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col-reverse items-start gap-2 px-4 py-3 transition-opacity duration-300 md:flex-row md:justify-between md:px-10 md:py-5',
          shown && 'opacity-0',
        )}
        inert={shown}
      >
        <div className="pointer-events-auto flex flex-col gap-1.5">
          <h1 className="type-micro">Relay</h1>
          <p className="type-micro text-muted-foreground">
            Living <span className="type-accent text-sm">workspace</span> — {ENV_LABEL[env]} ·{' '}
            <span className="tabular-nums">
              <HeaderClock />
            </span>
          </p>
          <XpChip className="mt-1" />
          {webgl && (
            <p className="hidden type-micro text-muted-foreground md:block">
              Drag to look · scroll to zoom · double-click to reset
            </p>
          )}
        </div>
        <div className="pointer-events-auto flex max-w-full items-center gap-0.5 self-end rounded-full glass p-1 md:self-auto">
          <CommandButton compact />
          {/* A long state ("Reconnecting…") shortens on a phone, so it cannot push the buttons off screen. */}
          <ConnectionIndicator className="px-1 max-sm:[&>span]:max-w-9 max-sm:[&>span]:truncate max-[359px]:[&>span]:sr-only" />
          <AiStatusButton compact />
          <NotificationBell />
          <SoundToggle />
          <ThemeToggle />
          {webgl && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.dispatchEvent(new Event(RESET_VIEW_EVENT))}
              aria-label="Reset view"
              title="Reset view (0 or double-click). Drag to look around, scroll to zoom, or use the arrow keys."
            >
              <RotateCcw />
            </Button>
          )}
          {fullscreen.supported && (
            <Button
              variant="ghost"
              size="icon"
              onClick={fullscreen.toggle}
              aria-pressed={fullscreen.active}
              aria-label={fullscreen.active ? 'Exit full screen' : 'Full screen'}
              title={fullscreen.active ? 'Exit full screen (f or Esc)' : 'Full screen (f)'}
            >
              {fullscreen.active ? <Minimize /> : <Maximize />}
            </Button>
          )}
        </div>
      </header>

      {webgl && !page && !isStowed(env) && (
        <div className="absolute inset-x-4 bottom-24 z-20 flex flex-col gap-2 md:inset-x-auto md:top-44 md:bottom-auto md:left-10 md:w-80">
          {job && <NextJobCard job={job} />}
          <FirstWin
            jobWaiting={job !== null}
            jobsSettled={needs.settled}
            inboxItems={needs.inboxItems}
          />
        </div>
      )}

      {/* The 2D way into every tab: keyboard, screen reader, touch. Hovering an item highlights its object. */}
      {webgl && !page && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center p-3 md:p-5">
          <SceneMenu data={data} env={env} layout="dock" onHover={setHovered} />
        </div>
      )}

      <PagePanel
        presentation={presentation}
        mounted={page}
        shown={shown}
        focus={focus}
        origin={origin}
        reducedMotion={reducedMotion}
        onBack={back}
        tools={
          <>
            <CommandButton compact />
            <AiStatusButton compact />
            <NotificationBell />
            <SoundToggle compact />
            <ThemeToggle />
            {fullscreen.supported && (
              <Button
                variant="ghost"
                size="icon"
                onClick={fullscreen.toggle}
                aria-pressed={fullscreen.active}
                aria-label={fullscreen.active ? 'Exit full screen' : 'Full screen'}
                title={fullscreen.active ? 'Exit full screen (f or Esc)' : 'Full screen (f)'}
              >
                {fullscreen.active ? <Minimize /> : <Maximize />}
              </Button>
            )}
          </>
        }
      >
        {children}
      </PagePanel>
    </div>
  );
}

/**
 * The real route, full size, over the world. Not a modal dialog: the app's shortcuts stay on, and the MR drawer and
 * confirm dialogs portal above it as usual. It grows out of the object the camera just reached.
 */
function PagePanel({
  presentation,
  mounted,
  shown,
  focus,
  origin,
  reducedMotion,
  onBack,
  tools,
  children,
}: {
  presentation: Presentation;
  tools: ReactNode;
  mounted: boolean;
  shown: boolean;
  focus: ObjectId | null;
  origin: { x: number; y: number } | null;
  reducedMotion: boolean;
  onBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const object = focus ? objectById(focus) : null;

  // Move focus into the page when it opens, so the keyboard continues where the eye goes.
  useEffect(() => {
    if (shown) ref.current?.focus({ preventScroll: true });
  }, [shown, focus]);

  const world = presentation === 'world';

  // `origin` is in screen pixels and the panel is inset on desktop, so measure from the panel's own corner.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transformOrigin =
      origin && !world ? `${origin.x - el.offsetLeft}px ${origin.y - el.offsetTop}px` : '';
  }, [origin, world]);

  return (
    <motion.section
      ref={ref}
      tabIndex={-1}
      aria-label={object ? object.label : 'Page'}
      aria-hidden={!shown}
      inert={!shown}
      className={cn(
        'absolute inset-0 z-30 flex flex-col overflow-hidden outline-none',
        // A page grows out of its object; Overview in a world fades in over the ship (no card, no frame).
        !world &&
          'bg-background md:inset-x-[2vw] md:top-[2vh] md:bottom-[2vh] md:rounded-sheet md:border md:border-hairline md:shadow-float',
        !shown && 'pointer-events-none',
      )}
      // A new target picks up from wherever the panel is, so going back halfway just turns around.
      initial={false}
      animate={shown ? { opacity: 1, scale: 1 } : { opacity: 0, scale: world ? 1 : 0.92 }}
      transition={reducedMotion ? { duration: 0 } : SPRING.settle}
    >
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 px-3 py-2 md:px-6',
          world
            ? 'glass absolute top-2 right-2 left-2 z-10 rounded-full md:top-3 md:right-3 md:left-3'
            : 'border-b border-hairline bg-background',
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          title="Back to the world (Esc)"
          aria-label="Back to the workspace"
        >
          <ArrowLeft />
          <span className="hidden sm:inline">Workspace</span>
        </Button>
        {object && (
          <span className="flex min-w-0 items-center gap-1.5 type-micro text-muted-foreground">
            <span aria-hidden>/</span>
            <span className="truncate text-foreground">{object.label}</span>
          </span>
        )}
        <XpChip className="ml-auto" />
        <div className="flex shrink-0 items-center gap-1">{tools}</div>
      </div>
      {world ? (
        // Full-bleed under the floating bar; Overview lays its own panels out over the ship.
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <PresentationContext.Provider value="world">
            {mounted && children}
          </PresentationContext.Provider>
        </main>
      ) : (
        <PageSwap enabled={shown}>
          <main className="relative min-w-0 flex-1 overflow-y-auto px-4 pt-6 pb-10 md:px-10 md:pt-10">
            {mounted && children}
          </main>
        </PageSwap>
      )}
    </motion.section>
  );
}
