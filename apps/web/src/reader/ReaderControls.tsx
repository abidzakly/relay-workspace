import { useState } from 'react';
import { cn } from '@/lib/utils';

const SIZES = [
  { id: 's', label: 'Small text', glyph: 'text-[0.8125rem]', value: '1rem' },
  { id: 'm', label: 'Medium text', glyph: 'text-base', value: '1.125rem' },
  { id: 'l', label: 'Large text', glyph: 'text-xl', value: '1.25rem' },
] as const;

export type ReaderSize = (typeof SIZES)[number]['id'];

const KEY = 'reader-size';

const stored = (): ReaderSize => {
  try {
    const v = localStorage.getItem(KEY);
    return SIZES.some((s) => s.id === v) ? (v as ReaderSize) : 'm';
  } catch {
    return 'm';
  }
};

/** The reader's text size, kept in this browser. `value` goes on the article as `--reader-size`. */
export function useReaderSize() {
  const [size, setSize] = useState<ReaderSize>(stored);
  const choose = (next: ReaderSize) => {
    setSize(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode or full storage: the choice lasts for this visit only.
    }
  };
  return { size, value: SIZES.find((s) => s.id === size)!.value, choose };
}

/** Three "A"s, small to large: the reader's text size. */
export function ReaderSizeSwitch({
  size,
  onChange,
}: {
  size: ReaderSize;
  onChange: (s: ReaderSize) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Text size"
      className="flex h-8 items-center rounded-control border border-hairline p-0.5"
    >
      {SIZES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={size === s.id}
          aria-label={s.label}
          title={s.label}
          onClick={() => onChange(s.id)}
          className={cn(
            'grid h-full w-7 place-items-center rounded-[2px] font-accent leading-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            s.glyph,
            size === s.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          A
        </button>
      ))}
    </div>
  );
}
