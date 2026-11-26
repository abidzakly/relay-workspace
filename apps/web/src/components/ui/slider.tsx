import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * A number picked by dragging: a native range input (keyboard and screen readers for free) with the value read out
 * beside it. `onChange` follows the drag; `onCommit` fires once the pointer or key lets go, for saving.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  format = String,
  id,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  format?: (v: number) => string;
  id?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const commit = (raw: string) => onCommit?.(Number(raw));
  const commitKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (/^(Arrow|Page|Home|End)/.test(e.key)) commit(e.currentTarget.value);
  };
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-valuetext={format(value)}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => commit(e.currentTarget.value)}
        onKeyUp={commitKey}
      />
      <output
        htmlFor={id}
        className="min-w-14 text-right font-mono text-sm tabular-nums text-foreground"
      >
        {format(value)}
      </output>
    </div>
  );
}
