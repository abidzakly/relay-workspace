import { nextTheme, resolveDark, useUiStore, type Theme } from '@/store/ui';
import { cn } from '@/lib/utils';

const LABEL: Record<Theme, string> = {
  light: 'Wake',
  dark: 'Dream',
  system: 'Auto',
};

/** The small moon-or-sun dot: an ink dot when awake, a violet orb when dreaming. */
function Orb({ dark }: { dark: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        dark ? 'bg-terracotta shadow-[0_0_6px_1px_var(--terracotta)]' : 'bg-current',
      )}
    />
  );
}

/** Compact text toggle for tight bars: `● Wake`. Cycles Wake, Dream, Auto (same order as the `t` key). */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  return (
    <button
      type="button"
      data-theme-toggle
      title={`${LABEL[theme]} (click to change)`}
      aria-label={`Theme: ${LABEL[theme]}`}
      onClick={() => setTheme(nextTheme(theme))}
      className={cn(
        'tactile inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 type-micro text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Orb dark={resolveDark(theme)} />
      {LABEL[theme]}
    </button>
  );
}

/** The floating glass pill: `[ WAKE ][ ● DREAM ]`. Wake is light, Dream is dark, Auto follows the system. */
export function WakeDreamSwitch({ className }: { className?: string }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const options: Theme[] = ['light', 'dark', 'system'];
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-theme-toggle
      className={cn('glass inline-flex items-center gap-0.5 rounded-full p-1', className)}
    >
      {options.map((t) => {
        const on = theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setTheme(t)}
            className={cn(
              'tactile inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium tracking-[0.06em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring',
              t === 'system' && 'px-2.5 text-muted-foreground',
              on ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/70',
            )}
          >
            {t === 'dark' && <Orb dark />}
            {LABEL[t]}
          </button>
        );
      })}
    </div>
  );
}
