import { useTranslation } from 'react-i18next';
import { nextTheme, resolveDark, useUiStore, type Theme } from '@/store/ui';
import { cn } from '@/lib/utils';

/** Wake / Dream / Auto, in the UI language. */
function useThemeLabel() {
  const { t } = useTranslation();
  return { t, label: (theme: Theme) => t(`shell.theme.${theme}` as const) };
}

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
  const { t, label } = useThemeLabel();
  return (
    <button
      type="button"
      data-theme-toggle
      title={t('shell.theme.clickToChange', { name: label(theme) })}
      aria-label={t('shell.theme.current', { name: label(theme) })}
      onClick={() => setTheme(nextTheme(theme))}
      className={cn(
        'tactile inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 type-micro text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Orb dark={resolveDark(theme)} />
      {label(theme)}
    </button>
  );
}

/** The floating glass pill: `[ WAKE ][ ● DREAM ]`. Wake is light, Dream is dark, Auto follows the system. */
export function WakeDreamSwitch({ className }: { className?: string }) {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const options: Theme[] = ['light', 'dark', 'system'];
  const { t, label } = useThemeLabel();
  return (
    <div
      role="radiogroup"
      aria-label={t('shell.theme.label')}
      data-theme-toggle
      className={cn('glass inline-flex items-center gap-0.5 rounded-full p-1', className)}
    >
      {options.map((o) => {
        const on = theme === o;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setTheme(o)}
            className={cn(
              'tactile inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium tracking-[0.06em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring',
              o === 'system' && 'px-2.5 text-muted-foreground',
              on ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/70',
            )}
          >
            {o === 'dark' && <Orb dark />}
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}
