import { cn } from '@/lib/utils';

export interface ModeOption<T extends string> {
  value: T;
  label: string;
}

/** A small glass pill of choices, one of them on: the theme switch's pattern for any either/or view. */
export function ModeSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly ModeOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers: "Log view". */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('glass inline-flex items-center gap-0.5 rounded-full p-1', className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'tactile inline-flex h-7 items-center rounded-full px-3 text-xs font-medium tracking-[0.06em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-primary text-primary-foreground' : 'hover:bg-accent/70',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
