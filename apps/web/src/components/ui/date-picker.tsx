import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';

/**
 * The app's date picker (Paper & Ink), in place of the browser's own. Values are the native formats, so callers keep
 * their strings: `date` is `YYYY-MM-DD`, `month` is `YYYY-MM`, `datetime` is `YYYY-MM-DDTHH:mm` (local time). The
 * trigger matches the Dropdown; the calendar is a frosted sheet with the chosen day in solid ink (it slides from day
 * to day), today marked with a dot, months that slide sideways, and a year view behind the title. Keyboard: arrows move
 * a day or a week, Page Up/Down a month, Home/End the week, Enter picks, Escape closes.
 */
export type DateKind = 'date' | 'month' | 'datetime';

interface Ymd {
  y: number;
  m: number; // 0-11
  d: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
const keyOf = (v: Ymd) => `${v.y}-${pad(v.m + 1)}-${pad(v.d)}`;
const monthKey = (y: number, m: number) => `${y}-${pad(m + 1)}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function todayYmd(): Ymd {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}

/** The date part of any of the three formats, or null. */
function parse(value: string | undefined | null): Ymd | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: m[3] ? Number(m[3]) : 1 };
}
function timeOf(value: string | undefined | null): [number, number] {
  const m = /T(\d{2}):(\d{2})/.exec(value ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
}
/** Move by days, keeping a real date. */
function shift(v: Ymd, days: number): Ymd {
  const t = new Date(v.y, v.m, v.d + days);
  return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() };
}
function shiftMonth(v: Ymd, months: number): Ymd {
  const first = new Date(v.y, v.m + months, 1);
  const y = first.getFullYear();
  const m = first.getMonth();
  return { y, m, d: Math.min(v.d, daysIn(y, m)) };
}

function display(kind: DateKind, value: string): string {
  const v = parse(value);
  if (!v) return '';
  if (kind === 'month') return `${MONTHS[v.m]} ${v.y}`;
  const date = `${v.d} ${MONTHS[v.m]!.slice(0, 3)} ${v.y}`;
  if (kind === 'date') return date;
  const [h, mi] = timeOf(value);
  return `${date}, ${pad(h)}:${pad(mi)}`;
}

export function DatePicker({
  kind = 'date',
  value,
  onChange,
  min,
  max,
  id,
  className,
  placeholder,
  disabled,
  size = 'md',
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: {
  kind?: DateKind;
  value: string;
  /** The new value in the kind's native format. */
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'md' | 'sm';
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const [up, setUp] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const chosen = parse(value);
  const [focus, setFocus] = useState<Ymd>(chosen ?? todayYmd());
  const [view, setView] = useState<'days' | 'months'>(kind === 'month' ? 'months' : 'days');
  const [dir, setDir] = useState(0);
  const [time, setTime] = useState<[number, number]>(timeOf(value));
  const today = todayYmd();

  const minDay = min ? min.slice(0, kind === 'month' ? 7 : 10) : null;
  const maxDay = max ? max.slice(0, kind === 'month' ? 7 : 10) : null;
  const outOfRange = (k: string) =>
    (minDay !== null && cmp(k, minDay.slice(0, k.length)) < 0) ||
    (maxDay !== null && cmp(k, maxDay.slice(0, k.length)) > 0);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const isUp = window.innerHeight - r.bottom < 380 && r.top > 380;
    setUp(isUp);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 300);
    setPos({
      ...(isUp ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }),
      left,
    });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrap.current?.contains(t) && !sheet.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  // Keyboard focus follows the focused day inside the open grid.
  useEffect(() => {
    if (!open || view !== 'days') return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${keyOf(focus)}"]`)?.focus();
  }, [open, focus, view]);

  const openSheet = () => {
    if (disabled) return;
    setFocus(chosen ?? today);
    setTime(timeOf(value));
    setView(kind === 'month' ? 'months' : 'days');
    setDir(0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };

  const commitDay = (v: Ymd, t: [number, number] = time) => {
    if (outOfRange(keyOf(v))) return;
    if (kind === 'datetime') {
      onChange(`${keyOf(v)}T${pad(t[0])}:${pad(t[1])}`);
      setFocus(v);
      return; // stays open so the time can be set
    }
    onChange(keyOf(v));
    close();
  };
  const commitMonth = (y: number, m: number) => {
    if (kind === 'month') {
      if (outOfRange(monthKey(y, m))) return;
      onChange(monthKey(y, m));
      close();
      return;
    }
    setDir(cmp(monthKey(y, m), monthKey(focus.y, focus.m)));
    setFocus({ y, m, d: Math.min(focus.d, daysIn(y, m)) });
    setView('days');
  };
  const goMonth = (n: number) => {
    setDir(n);
    setFocus((f) => shiftMonth(f, n));
  };
  const setClock = (h: number, mi: number) => {
    const t: [number, number] = [(h + 24) % 24, (mi + 60) % 60];
    setTime(t);
    if (chosen) onChange(`${keyOf(chosen)}T${pad(t[0])}:${pad(t[1])}`);
  };

  const onGridKey = (e: KeyboardEvent) => {
    const moves: Record<string, () => Ymd> = {
      ArrowLeft: () => shift(focus, -1),
      ArrowRight: () => shift(focus, 1),
      ArrowUp: () => shift(focus, -7),
      ArrowDown: () => shift(focus, 7),
      PageUp: () => shiftMonth(focus, -1),
      PageDown: () => shiftMonth(focus, 1),
      Home: () => shift(focus, -((new Date(focus.y, focus.m, focus.d).getDay() + 6) % 7)),
      End: () => shift(focus, 6 - ((new Date(focus.y, focus.m, focus.d).getDay() + 6) % 7)),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      const next = move();
      if (next.m !== focus.m || next.y !== focus.y)
        setDir(cmp(monthKey(next.y, next.m), monthKey(focus.y, focus.m)));
      setFocus(next);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commitDay(focus);
    }
  };
  const onSheetKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  // The month's grid, Monday first, with the neighbouring days greyed in.
  const lead = (new Date(focus.y, focus.m, 1).getDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, i) =>
    shift({ y: focus.y, m: focus.m, d: 1 }, i - lead),
  );
  const rows = cells[35]!.m !== focus.m ? 5 : 6;
  const text = display(kind, value);
  const Icon = kind === 'datetime' ? Clock : CalendarDays;

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <button
        ref={btn}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel}${text ? `: ${text}` : ''}` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={ariaInvalid || undefined}
        onClick={() => (open ? setOpen(false) : openSheet())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            openSheet();
          }
        }}
        className={cn(
          'group/trigger flex w-full items-center gap-2 rounded-control border border-input bg-card/60 text-left transition-[border-color,background-color] hover:border-foreground/60 hover:bg-card focus-visible:border-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive',
          open && 'border-foreground bg-card',
          size === 'md' ? 'h-9 px-3 text-sm' : 'h-8 px-2.5 text-xs',
        )}
      >
        <Icon aria-hidden className={cn('shrink-0', size === 'md' ? 'size-4' : 'size-3.5')} />
        <span className={cn('flex-1 truncate tabular-nums', !text && 'text-muted-foreground')}>
          {text || placeholder || (kind === 'month' ? 'Pick a month' : 'Pick a date')}
        </span>
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={sheet}
              data-floating-menu=""
              role="dialog"
              aria-label={ariaLabel ?? (kind === 'month' ? 'Choose a month' : 'Choose a date')}
              style={pos}
              onKeyDown={onSheetKey}
              initial={{ opacity: 0, y: up ? 6 : -6, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: up ? 4 : -4, filter: 'blur(4px)' }}
              transition={SPRING.settle}
              className="pointer-events-auto fixed z-[70] w-72 overflow-hidden rounded-surface border border-hairline bg-popover/95 p-3 text-popover-foreground shadow-float backdrop-blur-md"
            >
              {/* the title: month and year, and the way to the year view */}
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setView(view === 'days' ? 'months' : kind === 'month' ? 'months' : 'days')
                  }
                  className="rounded-control px-1.5 py-1 text-left outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={view === 'days' ? 'Choose the month and year' : 'Back to the days'}
                >
                  <span className="type-micro">{view === 'days' ? MONTHS[focus.m] : 'Year'} </span>
                  <span className="type-accent text-lg">{focus.y}</span>
                </button>
                <div className="flex items-center gap-1">
                  {[-1, 1].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-label={
                        view === 'days'
                          ? n < 0
                            ? 'Previous month'
                            : 'Next month'
                          : n < 0
                            ? 'Previous year'
                            : 'Next year'
                      }
                      onClick={() =>
                        view === 'days'
                          ? goMonth(n)
                          : (setDir(n), setFocus((f) => ({ ...f, y: f.y + n })))
                      }
                      className="tactile grid size-7 place-items-center rounded-full border border-hairline outline-none hover:border-foreground hover:bg-foreground hover:text-background focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {n < 0 ? (
                        <ChevronLeft aria-hidden className="size-3.5" />
                      ) : (
                        <ChevronRight aria-hidden className="size-3.5" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative overflow-hidden">
                <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                  {view === 'days' ? (
                    <motion.div
                      key={`d-${focus.y}-${focus.m}`}
                      custom={dir}
                      initial={{ opacity: 0, x: dir * 40 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: dir * -40 }}
                      transition={SPRING.settle}
                    >
                      <div className="grid grid-cols-7 pb-1">
                        {WEEKDAYS.map((w) => (
                          <span
                            key={w}
                            className="py-1 text-center text-micro font-semibold text-muted-foreground uppercase"
                          >
                            {w}
                          </span>
                        ))}
                      </div>
                      <div
                        ref={grid}
                        role="grid"
                        onKeyDown={onGridKey}
                        className="grid grid-cols-7 gap-y-0.5"
                      >
                        {cells.slice(0, rows * 7).map((c) => {
                          const k = keyOf(c);
                          const inMonth = c.m === focus.m;
                          const isChosen = chosen !== null && keyOf(chosen) === k;
                          const isToday = keyOf(today) === k;
                          const off = outOfRange(k);
                          return (
                            <button
                              key={k}
                              type="button"
                              role="gridcell"
                              data-day={k}
                              tabIndex={keyOf(focus) === k ? 0 : -1}
                              disabled={off}
                              aria-selected={isChosen}
                              aria-current={isToday ? 'date' : undefined}
                              aria-label={`${c.d} ${MONTHS[c.m]} ${c.y}`}
                              onClick={() => commitDay(c)}
                              className={cn(
                                'relative grid h-8 place-items-center rounded-full text-sm tabular-nums outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30',
                                !isChosen && 'hover:bg-foreground/[0.07]',
                                inMonth ? 'text-foreground' : 'text-muted-foreground/60',
                                isChosen && 'text-background',
                              )}
                            >
                              {isChosen && (
                                <motion.span
                                  layoutId={`${uid}-pick`}
                                  className="absolute inset-0.5 rounded-full bg-foreground"
                                  transition={SPRING.press}
                                />
                              )}
                              <span className="relative">{c.d}</span>
                              {isToday && (
                                <span
                                  aria-hidden
                                  className={cn(
                                    'absolute bottom-1 size-1 rounded-full',
                                    isChosen ? 'bg-background' : 'bg-terracotta',
                                  )}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`m-${focus.y}`}
                      custom={dir}
                      initial={{ opacity: 0, x: dir * 40 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: dir * -40 }}
                      transition={SPRING.settle}
                      className="grid grid-cols-3 gap-1"
                    >
                      {MONTHS.map((name, m) => {
                        const k = monthKey(focus.y, m);
                        const isChosen = chosen !== null && chosen.y === focus.y && chosen.m === m;
                        const isNow = today.y === focus.y && today.m === m;
                        const off = kind === 'month' && outOfRange(k);
                        return (
                          <button
                            key={name}
                            type="button"
                            disabled={off}
                            aria-pressed={isChosen}
                            onClick={() => commitMonth(focus.y, m)}
                            className={cn(
                              'relative h-10 rounded-full text-xs font-semibold uppercase outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30',
                              isChosen
                                ? 'bg-foreground text-background'
                                : 'hover:bg-foreground/[0.07]',
                            )}
                          >
                            {name.slice(0, 3)}
                            {isNow && (
                              <span
                                aria-hidden
                                className={cn(
                                  'absolute bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full',
                                  isChosen ? 'bg-background' : 'bg-terracotta',
                                )}
                              />
                            )}
                          </button>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* time, for date and time */}
              {kind === 'datetime' && view === 'days' && (
                <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-3">
                  <span className="type-micro text-muted-foreground">Time</span>
                  <div className="flex items-center gap-1 font-mono text-sm">
                    <Spin
                      label="Hour"
                      value={time[0]}
                      onStep={(n) => setClock(time[0] + n, time[1])}
                    />
                    <span aria-hidden>:</span>
                    <Spin
                      label="Minute"
                      value={time[1]}
                      onStep={(n) => setClock(time[0], time[1] + n)}
                      step={5}
                    />
                  </div>
                </div>
              )}

              {/* the shortcut */}
              <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (kind === 'month') commitMonth(today.y, today.m);
                    else if (kind === 'datetime') {
                      const now = new Date();
                      const t: [number, number] = [now.getHours(), now.getMinutes()];
                      setTime(t);
                      commitDay(today, t);
                    } else commitDay(today);
                  }}
                  className="arrow-link text-xs font-semibold tracking-[0.04em] uppercase outline-none hover:underline focus-visible:underline"
                >
                  {kind === 'month' ? 'This month' : kind === 'datetime' ? 'Now' : 'Today'}
                </button>
                {kind === 'datetime' && (
                  <button
                    type="button"
                    onClick={close}
                    className="tactile rounded-full bg-foreground px-3 py-1 text-xs font-semibold tracking-[0.04em] text-background uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Done
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/** A two-digit field you step with arrows, the wheel or the small buttons. */
function Spin({
  label,
  value,
  onStep,
  step = 1,
}: {
  label: string;
  value: number;
  onStep: (n: number) => void;
  step?: number;
}) {
  return (
    <span className="flex items-center rounded-control border border-input">
      <button
        type="button"
        aria-label={`${label} down`}
        onClick={() => onStep(-step)}
        className="grid h-7 w-5 place-items-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ChevronLeft aria-hidden className="size-3" />
      </button>
      <span
        role="spinbutton"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={value}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            onStep(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            onStep(-1);
          }
        }}
        onWheel={(e) => onStep(e.deltaY < 0 ? 1 : -1)}
        className="w-6 text-center tabular-nums outline-none focus-visible:underline"
      >
        {pad(value)}
      </span>
      <button
        type="button"
        aria-label={`${label} up`}
        onClick={() => onStep(step)}
        className="grid h-7 w-5 place-items-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <ChevronRight aria-hidden className="size-3" />
      </button>
    </span>
  );
}
