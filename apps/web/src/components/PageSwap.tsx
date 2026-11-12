import { useEffect, useRef, ViewTransition, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useReducedMotion } from '@/workspace/useMedia';

/**
 * Cross-fades from one page to the next. Must stay mounted across navigations, around a single DOM element.
 *
 * Only a new path counts: filters and `?card=` also navigate, and those must not fade the whole page under the user.
 * Browsers without View Transitions swap instantly.
 */
/**
 * The page a path belongs to. Drawers that are nested routes (the MR drawer at `/mrs/:repo/:iid`) open over their
 * page, so they count as the same page: fading the inbox under a sliding drawer is what made it judder.
 */
export function pageKey(pathname: string): string {
  return pathname.replace(/^\/mrs\/[^/]+\/[^/]+\/?$/, '/mrs');
}

export function PageSwap({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const pathname = pageKey(useLocation().pathname);
  const reduced = useReducedMotion();
  const committed = useRef(pathname);
  useEffect(() => {
    committed.current = pathname;
  }, [pathname]);
  const swap = enabled && !reduced && committed.current !== pathname;
  return (
    <ViewTransition default="none" update={swap ? 'page-swap' : 'none'}>
      {children}
    </ViewTransition>
  );
}
