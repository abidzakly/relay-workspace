import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { NavItem } from '@/components/nav';
import { useEnabledNav } from '@/lib/features';
import { cn } from '@/lib/utils';

/** `(04)` from the page's place in the main nav, so every page carries its section number. */
function sectionNumber(nav: readonly NavItem[], pathname: string): string | null {
  const items = nav.filter((n) => !n.sceneOnly);
  const i = items.findIndex((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
  return i < 0 ? null : String(i + 1).padStart(2, '0');
}

/**
 * The page title: a numbered section label over poster type. `(04) Board` then `BOARD`.
 * `accent` is the one serif italic word that may follow the title, such as a sprint name.
 */
export function PageTitle({
  children,
  label,
  accent,
  className,
}: {
  children: ReactNode;
  /** Overrides the section label (default: the nav label). */
  label?: string;
  accent?: ReactNode;
  className?: string;
}) {
  const { pathname } = useLocation();
  const nav = useEnabledNav();
  const n = sectionNumber(nav, pathname);
  const navLabel = nav
    .filter((x) => !x.sceneOnly)
    .find((x) => pathname === x.to || pathname.startsWith(`${x.to}/`))?.label;
  const eyebrow = label ?? navLabel;
  return (
    <div className={cn('mb-3 flex min-w-0 flex-col gap-3', className)}>
      {eyebrow && (
        <p className="type-micro text-foreground">
          {n && <span className="mr-1">({n})</span>}
          {eyebrow}
        </p>
      )}
      <h1 className="rise-in type-headline break-words">
        {children}
        {accent && (
          <>
            {' '}
            <span className="type-accent font-normal normal-case">{accent}</span>
          </>
        )}
      </h1>
    </div>
  );
}

/** A numbered section label inside a page: `(02) Pipelines`. */
export function SectionLabel({
  n,
  children,
  className,
}: {
  n?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn('type-micro text-foreground', className)}>
      {n !== undefined && <span className="mr-1">({String(n).padStart(2, '0')})</span>}
      {children}
    </p>
  );
}
