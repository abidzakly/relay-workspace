import type { EnvId } from '../envFor';
import type { WorldModule } from '../world/types';

/**
 * The outdoor worlds, each its own lazily loaded chunk. Loading is cached: the same promise every time, so
 * React's `use()` suspends only once.
 */
const LOADERS: Partial<Record<EnvId, () => Promise<{ default: WorldModule }>>> = {
  home: () => import('./home'),
  leave: () => import('./leave'),
  trip: () => import('./trip'),
  office: () => import('./office'),
  sick: () => import('./sick'),
};

const cache = new Map<EnvId, Promise<WorldModule>>();

export function loadWorld(env: EnvId): Promise<WorldModule> {
  let p = cache.get(env);
  if (!p) {
    const load = LOADERS[env];
    if (!load) throw new Error(`no world for ${env}`);
    p = load().then((m) => m.default);
    cache.set(env, p);
  }
  return p;
}
