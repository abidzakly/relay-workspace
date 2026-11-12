import type { StatusGroups } from './config';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Status-group membership tests (case/space-insensitive). */
export function statusGroupTest(groups: StatusGroups) {
  const sets = {
    complete: new Set(groups.complete.map(norm)),
    done: new Set(groups.done.map(norm)),
    inactive: new Set(groups.inactive.map(norm)),
    uncommitted: new Set(groups.uncommitted.map(norm)),
  };
  const has = (k: keyof typeof sets) => (status: string | null | undefined) =>
    status != null && sets[k].has(norm(status));
  return {
    isComplete: has('complete'),
    isDone: has('done'),
    isInactive: has('inactive'),
    isUncommitted: has('uncommitted'),
    /** Work I can still act on: neither parked/closed nor already handed to QA. */
    isActionable: (status: string | null | undefined) =>
      !has('inactive')(status) && !has('done')(status),
  };
}
