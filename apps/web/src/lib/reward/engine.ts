/**
 * The single reward engine (design system: Rewards). Pure: no React and no DOM rendering. Callers `emit`, and
 * `components/RewardLayer` presents what is queued, one at a time, with sound and haptics.
 *
 * Emit only what the server has confirmed. This has its own claims, so it never takes `effectFor`'s from
 * `core3d/effectModel.ts`: one server event may drive both the core's effect and a reward.
 */
export type RewardLevel = 'tick' | 'pop' | 'burst' | 'event';

export interface Reward {
  level: RewardLevel;
  /** Dedupe key, for example `deck:<id>:<sha>`. A key is rewarded once. */
  key: string;
  title?: string;
  detail?: string;
  /** Shown flying into the XP chip. Only ever a number from a server report. */
  xp?: number;
}

const CLAIM_LIMIT = 200;
const CLAIMS_STORAGE_KEY = 'core-reward-claims';

const claims = new Set<string>();

function claimInMemory(key: string): boolean {
  if (claims.has(key)) return false;
  claims.add(key);
  if (claims.size > CLAIM_LIMIT) {
    for (const oldest of claims) {
      claims.delete(oldest);
      break;
    }
  }
  return true;
}

function readStoredClaims(): string[] {
  try {
    const raw = localStorage.getItem(CLAIMS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** For keys that must stay claimed across reloads. If storage is unavailable, the claim lasts for this page. */
function claimDurably(key: string): boolean {
  const stored = readStoredClaims();
  if (stored.includes(key)) return false;
  try {
    localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify([...stored, key].slice(-CLAIM_LIMIT)));
  } catch {
    /* the in-memory claim still holds */
  }
  return true;
}

/** How many may wait, per level. What arrives beyond this is dropped. */
const WAITING_CAP: Record<RewardLevel, number> = { tick: 2, pop: 4, burst: 3, event: 1 };

export class RewardQueue {
  private waiting: Reward[] = [];

  push(reward: Reward): void {
    if (this.waiting.filter((r) => r.level === reward.level).length >= WAITING_CAP[reward.level]) {
      return;
    }
    // A big win is the point of the moment, so it never waits behind routine rewards.
    if (reward.level === 'event') this.waiting.unshift(reward);
    else this.waiting.push(reward);
  }

  next(): Reward | null {
    return this.waiting.shift() ?? null;
  }
}

/** Off-duty worlds (sick, leave) drop every reward one level and never nag. A tick drops to nothing. */
export function offDutyLevel(level: RewardLevel): RewardLevel | null {
  switch (level) {
    case 'event':
      return 'burst';
    case 'burst':
      return 'pop';
    case 'pop':
      return 'tick';
    case 'tick':
      return null;
  }
}

const queue = new RewardQueue();
const emitted = new Set<() => void>();
const presented = new Set<(reward: Reward) => void>();

/**
 * Queue a reward, unless its key was already rewarded. Pass `persist` when a reload must not replay it.
 *
 * Pass `repeatable` for a touch that can happen any number of times (poking a toy). It takes no claim: unique keys
 * would push real rewards' claims out of the capped set, and those rewards could then replay.
 */
export function emit({
  persist = false,
  repeatable = false,
  ...reward
}: Reward & { persist?: boolean; repeatable?: boolean }): void {
  if (!repeatable) {
    if (!claimInMemory(reward.key)) return;
    if (persist && !claimDurably(reward.key)) return;
  }
  queue.push(reward);
  for (const fn of emitted) fn();
}

export function nextReward(): Reward | null {
  return queue.next();
}

/** The layer listens here for new work. */
export function subscribeEmitted(fn: () => void): () => void {
  emitted.add(fn);
  return () => {
    emitted.delete(fn);
  };
}

/** Told when a reward starts showing, at its final level: the XP chip's pulse, and the world in later phases. */
export function subscribePresented(fn: (reward: Reward) => void): () => void {
  presented.add(fn);
  return () => {
    presented.delete(fn);
  };
}

export function announcePresented(reward: Reward): void {
  for (const fn of presented) fn(reward);
}
