/**
 * Where a cockpit session sent from the Test Bench goes back to: session id → bench path, kept in this browser so it
 * survives a reload or opening the cockpit from a notification. Read both ways: the cockpit's "Back to test device",
 * and the Test Bench's way into the agent session fixing its findings.
 */
const RETURN_KEY = 'cockpit:return-to';
/** How many sessions are remembered (the newest win). */
const KEEP = 20;

/** In-app Test Bench paths only: `?returnTo=` must never send the cockpit anywhere else. */
export const isBenchPath = (p: string | null | undefined): p is string =>
  !!p && /^\/test-bench\/[a-z0-9-]+\?branch=/.test(p);

/** The Test Bench page of a branch, as the server builds it for `returnTo`. */
export const benchPath = (repo: string, branch: string) =>
  `/test-bench/${repo}?branch=${encodeURIComponent(branch)}`;

export function readBenchReturns(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(RETURN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remembers `path` for `sessionId` and returns the map as stored (the newest {@link KEEP}). */
export function rememberBenchReturn(
  sessionId: string,
  path: string,
  map: Record<string, string> = readBenchReturns(),
): Record<string, string> {
  if (!isBenchPath(path)) return map;
  const { [sessionId]: _old, ...rest } = map;
  const trimmed = Object.fromEntries(Object.entries({ ...rest, [sessionId]: path }).slice(-KEEP));
  try {
    localStorage.setItem(RETURN_KEY, JSON.stringify(trimmed));
  } catch {
    /* private mode: the URL still carries it */
  }
  return trimmed;
}

/** Sessions sent from this bench page, the newest first. */
export function benchSessionsFor(path: string): string[] {
  return Object.entries(readBenchReturns())
    .filter(([, p]) => p === path)
    .map(([id]) => id)
    .reverse();
}
