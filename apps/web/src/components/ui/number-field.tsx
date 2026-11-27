import { ChevronsLeftRight } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '@/lib/utils';

/** A suffix the field understands, e.g. `{ suffix: 'd', factor: 8 }` makes `5d` read as 40. */
export interface NumberUnit {
  suffix: string;
  factor: number;
}

/**
 * Reads what was typed: a number (`,` or `.` for decimals), `+ - * /`, parentheses and unit suffixes after a number
 * (`2w + 3d`). No `eval`. null when it does not read as one finite number.
 */
export function parseNumberExpr(text: string, units: readonly NumberUnit[] = []): number | null {
  const src = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!src) return null;
  const byLongest = [...units].sort((a, b) => b.suffix.length - a.suffix.length);
  let i = 0;
  const peek = () => src[i];

  const number = (): number | null => {
    const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    let n = Number(m[0].replace(',', '.'));
    const unit = byLongest.find((u) => src.startsWith(u.suffix, i));
    if (unit) {
      i += unit.suffix.length;
      n *= unit.factor;
    }
    return n;
  };
  const factor = (): number | null => {
    if (peek() === '-') {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    if (peek() === '(') {
      i++;
      const v = sum();
      if (v === null || peek() !== ')') return null;
      i++;
      return v;
    }
    return number();
  };
  const product = (): number | null => {
    let v = factor();
    while (v !== null && (peek() === '*' || peek() === 'x' || peek() === '/')) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === '/' ? v / r : v * r;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = src[i++];
      const r = product();
      if (r === null) return null;
      v = op === '-' ? v - r : v + r;
    }
    return v;
  };

  const v = sum();
  return v !== null && i === src.length && Number.isFinite(v) ? v : null;
}

const decimalsOf = (n: number) => (String(n).split('.')[1] ?? '').length;
const round = (v: number, decimals: number) => Number(v.toFixed(decimals));
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** Pixels of drag per step when scrubbing. */
const SCRUB_PX = 4;

/**
 * An exact number you type, with the feel of a dial when you want it. Type `72`, `2w`, `5d + 4` or `3*8*5` and press
 * Enter (or leave the field); Esc puts the old value back. While typing, the value it reads as is shown in the field.
 * ↑/↓ step (Shift ten steps), and dragging the unit sideways scrubs the value (Shift ten steps, Alt a tenth).
 *
 * `onChange` follows every nudge and scrub; `onCommit` fires once per settled value, for saving.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  precision = decimalsOf(step),
  unit,
  units = [],
  format = (v) => String(v),
  onChange,
  onCommit,
  id,
  disabled,
  size = 'md',
  className,
  inputClassName,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Decimals kept on commit. Defaults to the step's. */
  precision?: number;
  /** Shown after the number; also the scrub handle. */
  unit?: string;
  units?: readonly NumberUnit[];
  /** How the settled value reads in the field (no unit). */
  format?: (v: number) => string;
  onChange?: (v: number) => void;
  onCommit: (v: number) => void;
  id?: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  /** What is being typed; null while the field shows the value. */
  const [text, setText] = useState<string | null>(null);
  /** The value mid-scrub or mid-nudge, before it settles. */
  const [live, setLive] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrub = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  const shown = live ?? value;
  const parsed = text === null ? null : parseNumberExpr(text, units);
  const literal = text !== null && /^\s*\d+(?:[.,]\d*)?\s*$/.test(text);
  const fmt = (v: number) => `${format(v)}${unit ? ` ${unit}` : ''}`;

  const flash = (message: string) => {
    setNote(message);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2200);
  };
  /** Clamp and round; says so when the typed value had to move. */
  const settle = (raw: number, explain: boolean) => {
    const v = round(clamp(raw, min, max), precision);
    if (explain && raw > max) flash(`max ${fmt(max)}`);
    else if (explain && raw < min) flash(`min ${fmt(min)}`);
    return v;
  };
  const commit = (v: number) => {
    setLive(null);
    if (v !== value) onCommit(v);
  };
  const finishTyping = () => {
    if (text !== null) {
      if (parsed === null) {
        if (text.trim()) flash('not a number');
      } else commit(settle(parsed, true));
    } else if (live !== null) commit(live);
    setText(null);
  };
  const nudge = (by: number) => {
    const base = text !== null ? (parsed ?? shown) : shown;
    const next = settle(base + by, false);
    setText(null);
    setLive(next);
    onChange?.(next);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'Enter') {
      finishTyping();
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      if (text === null && live === null) return;
      setText(null);
      setLive(null);
      onChange?.(value);
    } else if (e.key === 'ArrowUp') nudge(step * big);
    else if (e.key === 'ArrowDown') nudge(-step * big);
    else if (e.key === 'PageUp') nudge(step * 10);
    else if (e.key === 'PageDown') nudge(-step * 10);
    else return;
    e.preventDefault();
  };

  const onScrubDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (text !== null && parsed !== null) setLive(settle(parsed, false));
    setText(null);
    scrub.current = { x: e.clientX, from: text !== null ? (parsed ?? shown) : shown, moved: false };
  };
  const onScrubMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 2) return;
    s.moved = true;
    const per = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    const next = settle(s.from + Math.round(dx / SCRUB_PX) * per, false);
    setLive(next);
    onChange?.(next);
  };
  const onScrubUp = () => {
    const s = scrub.current;
    scrub.current = null;
    if (!s) return;
    if (!s.moved) {
      inputRef.current?.focus();
      return;
    }
    if (live !== null) commit(live);
  };

  const lg = size === 'lg';
  const hint =
    note ??
    (text !== null && !literal
      ? parsed === null
        ? '…'
        : `= ${fmt(settle(parsed, false))}`
      : null);

  return (
    <span
      className={cn(
        'group/nf relative inline-flex min-w-0 items-center rounded-control border border-input bg-card/60 transition-colors focus-within:border-foreground focus-within:ring-1 focus-within:ring-ring',
        lg ? 'h-14 pl-3' : 'h-8 pl-2',
        disabled && 'opacity-50',
        className,
      )}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        role="spinbutton"
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-valuenow={shown}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuetext={fmt(shown)}
        aria-invalid={text !== null && parsed === null && text.trim() !== '' ? true : undefined}
        disabled={disabled}
        value={text ?? format(shown)}
        className={cn(
          'min-w-0 flex-1 bg-transparent font-mono tabular-nums outline-none',
          lg ? 'text-3xl font-semibold tracking-tight' : 'text-sm',
          inputClassName,
        )}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={finishTyping}
        onKeyDown={onKey}
      />
      {hint && (
        <span
          aria-live="polite"
          className={cn(
            'pointer-events-none shrink-0 whitespace-nowrap font-mono tabular-nums',
            lg
              ? 'absolute top-full left-0 z-10 mt-1 rounded-sm bg-card px-1 text-xs shadow-sm'
              : 'pr-1 text-xs',
            note ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {hint}
        </span>
      )}
      <span
        aria-hidden
        title="Drag sideways to adjust · Shift ×10 · Alt ×0.1"
        className={cn(
          'flex h-full shrink-0 cursor-ew-resize touch-none select-none items-center gap-0.5 rounded-r-control text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          lg ? 'px-2.5 text-base' : 'px-1.5 text-xs',
          disabled && 'pointer-events-none',
        )}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
      >
        {unit}
        <ChevronsLeftRight
          className={cn(
            'opacity-40 transition-opacity group-hover/nf:opacity-100',
            lg ? 'size-4' : 'size-3',
          )}
        />
      </span>
    </span>
  );
}
