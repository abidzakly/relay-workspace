import { X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { useLocation } from 'react-router';
import type { RewardStageProps } from '@/components/RewardScenes';
import { Button } from '@/components/ui/button';
import { vibrate } from '@/lib/haptics';
import {
  announcePresented,
  emit,
  nextReward,
  offDutyLevel,
  subscribeEmitted,
  type Reward,
  type RewardLevel,
} from '@/lib/reward/engine';
import { useReleaseReward } from '@/lib/reward/useReleaseReward';
import { useXpDelta } from '@/lib/reward/useXpDelta';
import type { XpDelta } from '@/lib/reward/xpDelta';
import { listenForFirstGesture, playSound } from '@/lib/sound/engine';
import { DEFAULT_ENV, type EnvId } from '@/workspace/envFor';
import { useReducedMotion } from '@/workspace/useMedia';

/** How long each level holds the screen. A tick shows nothing here, it is only sound and touch. */
const HOLD_MS: Record<RewardLevel, number> = { tick: 0, pop: 900, burst: 2200, event: 3400 };
const LEVELS: readonly RewardLevel[] = ['tick', 'pop', 'burst', 'event'];

/** A chunk that fails to load must not take the page down: the win still gets its words, sound and touch. */
const loadStage = (): Promise<{ default: ComponentType<RewardStageProps> }> =>
  import('./RewardScenes')
    .then((m) => ({ default: m.RewardStage }))
    .catch(() => ({ default: () => null }));
const RewardStage = lazy(loadStage);

/**
 * Confirm dialogs and permission prompts are calm zones: a reward waits until they close. A reading drawer that is built
 * on a dialog (`data-reward-through`) is not one: the merge it holds is rewarded right there.
 */
const calmZoneOpen = () =>
  document.querySelector('[role="dialog"]:not([data-reward-through]), [role="alertdialog"]') !==
  null;

function AwayRecap({ delta, onDismiss }: { delta: XpDelta; onDismiss: () => void }) {
  const parts = [
    delta.xp > 0 && `+${delta.xp} XP`,
    delta.level !== null && `level ${delta.level}`,
    delta.badges.length > 0 &&
      `${delta.badges.length} badge${delta.badges.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return (
    <div
      role="status"
      className="glass pointer-events-auto fixed bottom-20 left-4 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full py-1 pr-1 pl-4 text-sm md:bottom-5 md:left-10"
    >
      <span>
        <span className="type-micro text-muted-foreground">While you were away —</span>{' '}
        {parts.join(' · ')}
      </span>
      <Button variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss">
        <X />
      </Button>
    </div>
  );
}

/**
 * Shows what the reward engine queues, one at a time, with sound and haptics. Mounted once by `Layout`, above pages and
 * drawers, below dialogs. A reward never relies on sound or touch alone: each has words, and a status line for screen readers.
 */
export function RewardLayer() {
  const location = useLocation();
  const reduced = useReducedMotion();
  // Dev only: `?env=leave` previews an off-duty world, and `?reward=burst` previews a level.
  const preview = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
  const env = (preview?.get('env') as EnvId | null) ?? DEFAULT_ENV;
  const offDuty = env === 'sick' || env === 'leave';
  const previewLevel = preview?.get('reward') as RewardLevel | null | undefined;

  useReleaseReward();
  const { away, dismissAway } = useXpDelta();
  const [current, setCurrent] = useState<Reward | null>(null);
  const [stageLoaded, setStageLoaded] = useState(false);
  const [spoken, setSpoken] = useState('');
  const busy = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const offDutyRef = useRef(offDuty);
  offDutyRef.current = offDuty;

  const pump = useCallback(function run() {
    if (busy.current) return;
    clearTimeout(waitTimer.current);
    // A calm zone is open, or nobody is looking: hold everything until that ends.
    if (document.hidden || calmZoneOpen()) {
      waitTimer.current = setTimeout(run, 400);
      return;
    }
    const queued = nextReward();
    if (!queued) return;
    const level = offDutyRef.current ? offDutyLevel(queued.level) : queued.level;
    if (!level) {
      run();
      return;
    }
    const reward: Reward = { ...queued, level };
    playSound(level);
    vibrate(level);
    announcePresented(reward);
    if (reward.title) setSpoken(reward.title);
    if (level === 'tick') {
      run();
      return;
    }
    busy.current = true;
    setCurrent(reward);
    holdTimer.current = setTimeout(() => {
      busy.current = false;
      setCurrent(null);
      run();
    }, HOLD_MS[level]);
  }, []);

  const skip = useCallback(() => {
    clearTimeout(holdTimer.current);
    busy.current = false;
    setCurrent(null);
    pump();
  }, [pump]);

  useEffect(() => {
    listenForFirstGesture();
    const unsubscribe = subscribeEmitted(pump);
    pump();
    return () => {
      unsubscribe();
      clearTimeout(holdTimer.current);
      clearTimeout(waitTimer.current);
      busy.current = false;
    };
  }, [pump]);

  // Fetched once the page has settled, so the first win does not spend its time on screen downloading. A win that comes
  // sooner loads it itself. Safari has no `requestIdleCallback`.
  useEffect(() => {
    const load = () => void loadStage().then(() => setStageLoaded(true));
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(load);
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(load, 1000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!previewLevel || !LEVELS.includes(previewLevel)) return;
    emit({
      level: previewLevel,
      key: `preview:${previewLevel}:${location.key}`,
      title:
        previewLevel === 'pop' ? '+25 XP' : previewLevel === 'burst' ? 'Level 4' : 'Deck cleared',
      detail: previewLevel === 'event' ? 'Preview of a big win' : 'Preview',
      xp: 25,
    });
  }, [previewLevel, location.key]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[55]" data-reward-layer>
      <span role="status" className="sr-only">
        {spoken}
      </span>
      {(stageLoaded || current) && (
        <Suspense fallback={null}>
          <RewardStage current={current} reduced={reduced} popHoldMs={HOLD_MS.pop} onSkip={skip} />
        </Suspense>
      )}
      {away && !offDuty && <AwayRecap delta={away} onDismiss={dismissAway} />}
    </div>
  );
}
