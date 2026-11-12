import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Search, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';

/**
 * Ported from dashboard-qa `components/Dropdown.tsx`, on this app's tokens and springs. A soft
 * trigger and a rounded menu with check marks. Focus stays on the trigger; arrows move the highlight
 * (`aria-activedescendant`), Enter picks, Esc closes. The menu is portalled to `<body>` above dialogs, placed under the
 * trigger (above it when there is no room) and follows scroll and resize. Dialogs ignore clicks inside it
 * (`data-floating-menu`, see ui/dialog.tsx). `searchable` adds a filter box for long lists (Figma frames).
 */

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface Common<T extends string> {
  options: DropdownOption<T>[];
  /** Accessible name (also the trigger tooltip). Leave out when a `<label htmlFor={id}>` names it. */
  label?: string;
  /** The trigger's id, so a `<Label htmlFor>` names it and focuses it. */
  id?: string;
  /** A hidden input carries the value for a native form submit. */
  name?: string;
  ariaInvalid?: boolean;
  ariaRequired?: boolean;
  icon?: LucideIcon;
  /** Shown on the trigger when nothing is picked. */
  placeholder?: string;
  /** `full` stretches the trigger to its container (forms, dialogs). */
  width?: 'auto' | 'full';
  size?: 'md' | 'sm';
  align?: 'left' | 'right';
  className?: string;
  disabled?: boolean;
  searchable?: boolean;
  /** Extra content under the options (e.g. "empty" text). */
  footer?: ReactNode;
}

type SingleProps<T extends string> = Common<T> & {
  multiple?: false;
  value: T | null;
  onChange: (v: T) => void;
};
type MultiProps<T extends string> = Common<T> & {
  multiple: true;
  value: T[];
  onChange: (v: T[]) => void;
  /** The "everything" row on top; selecting it clears the list. */
  allLabel: string;
};

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function Dropdown<T extends string>(props: SingleProps<T> | MultiProps<T>) {
  const {
    options,
    label,
    icon: Icon,
    placeholder,
    width = 'auto',
    size = 'md',
    align = 'left',
    className,
    disabled,
    searchable,
    footer,
    id: triggerId,
    name,
    ariaInvalid,
    ariaRequired,
  } = props;
  const id = useId();
  const name0 = label ?? '';
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const multi = props.multiple === true;
  const rows = useMemo(() => {
    const all: {
      value: T | null;
      label: string;
      hint?: string | undefined;
      disabled?: boolean | undefined;
    }[] = multi ? [{ value: null, label: (props as MultiProps<T>).allLabel }, ...options] : options;
    if (!query.trim()) return all;
    const words = fold(query).split(/\s+/).filter(Boolean);
    return all.filter((r) => {
      const hay = fold(`${r.label} ${r.hint ?? ''}`);
      return words.every((w) => hay.includes(w));
    });
  }, [multi, options, props, query]);
  const isSelected = (v: T | null) =>
    multi
      ? v === null
        ? (props.value as T[]).length === 0
        : (props.value as T[]).includes(v)
      : v === props.value;

  const text = multi
    ? (() => {
        const v = props.value as T[];
        if (v.length === 0) return (props as MultiProps<T>).allLabel;
        if (v.length === 1) return options.find((o) => o.value === v[0])?.label ?? v[0]!;
        return `${v.length} ${name0.toLowerCase() || 'selected'}`;
      })()
    : (options.find((o) => o.value === props.value)?.label ?? placeholder ?? name0);

  const place = useCallback(() => {
    const rect = btn.current?.getBoundingClientRect();
    if (!rect) return;
    const isUp = window.innerHeight - rect.bottom < 300 && rect.top > 300;
    setUp(isUp);
    setPos({
      ...(isUp ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }),
      ...(align === 'right'
        ? { right: window.innerWidth - rect.right }
        : { left: Math.max(8, rect.left) }),
      ...(width === 'full' ? { width: rect.width } : {}),
    });
  }, [align, width]);

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
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open && searchable) search.current?.focus();
    if (!open) setQuery('');
  }, [open, searchable]);

  const openMenu = () => {
    if (disabled) return;
    const current = rows.findIndex((r) => isSelected(r.value));
    setActive(
      current >= 0
        ? current
        : Math.max(
            0,
            rows.findIndex((r) => !r.disabled),
          ),
    );
    setOpen(true);
  };
  /** The next row that can be picked, from `from` in direction `dir` (stays put at the ends). */
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (!rows[i]!.disabled) return i;
    return from;
  };
  // Type to jump: the first letters of an option move the highlight to it, like a native select.
  const typed = useRef({ text: '', at: 0 });
  const typeahead = (key: string) => {
    const now = performance.now();
    typed.current = {
      text: (now - typed.current.at > 700 ? '' : typed.current.text) + key.toLowerCase(),
      at: now,
    };
    const i = rows.findIndex(
      (r) => !r.disabled && fold(r.label).startsWith(fold(typed.current.text)),
    );
    if (i >= 0) setActive(i);
  };

  const pick = (v: T | null) => {
    if (multi) {
      const p = props as MultiProps<T>;
      if (v === null) p.onChange([]);
      else p.onChange(p.value.includes(v) ? p.value.filter((x) => x !== v) : [...p.value, v]);
    } else if (v !== null) {
      (props as SingleProps<T>).onChange(v);
      setOpen(false);
      btn.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (!searchable && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey) {
      typeahead(e.key);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => step(a, -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? step(-1, 1) : step(rows.length, -1));
    } else if (e.key === 'Enter' || (e.key === ' ' && !searchable)) {
      e.preventDefault();
      const row = rows[active];
      if (row && !row.disabled) pick(row.value);
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={ref} className={cn('relative', width === 'full' && 'w-full', className)}>
      {name && (
        <input type="hidden" name={name} value={multi ? '' : ((props.value as T | null) ?? '')} />
      )}
      <button
        ref={btn}
        id={triggerId}
        type="button"
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-invalid={ariaInvalid || undefined}
        aria-required={ariaRequired || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && !searchable ? `${id}-opt-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKey}
        className={cn(
          'group/trigger flex items-center gap-2 rounded-control border border-input bg-card/60 text-left transition-[border-color,background-color] hover:border-foreground/60 hover:bg-card focus-visible:border-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive',
          open && 'border-foreground bg-card',
          size === 'md' ? 'h-9 px-3 text-sm' : 'h-8 px-2.5 text-xs',
          width === 'full' && 'w-full',
        )}
      >
        {Icon && (
          <Icon
            aria-hidden
            className={cn('shrink-0 text-foreground', size === 'md' ? 'size-4' : 'size-3.5')}
          />
        )}
        <span className={cn('truncate text-left', width === 'full' ? 'flex-1' : 'max-w-48')}>
          {text}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-300 ease-[var(--ease-editorial)] group-hover/trigger:text-foreground',
            size === 'md' ? 'size-4' : 'size-3.5',
            open && 'rotate-180',
          )}
        />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menu}
              data-floating-menu=""
              style={pos}
              initial={{ opacity: 0, y: up ? 6 : -6, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: up ? 4 : -4, filter: 'blur(4px)' }}
              transition={SPRING.settle}
              className="pointer-events-auto fixed z-[70] grid max-h-80 max-w-[calc(100vw-1rem)] min-w-56 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-surface border border-hairline bg-popover/95 shadow-float backdrop-blur-md"
            >
              {searchable ? (
                <label className="flex items-center gap-2 border-b border-hairline px-3">
                  <Search aria-hidden className="size-4 text-muted-foreground" />
                  <input
                    ref={search}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKey}
                    placeholder="Filter"
                    aria-label={`Filter ${name0.toLowerCase() || 'options'}`}
                    aria-controls={`${id}-list`}
                    aria-activedescendant={`${id}-opt-${active}`}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                </label>
              ) : (
                <span />
              )}
              <ul
                id={`${id}-list`}
                role="listbox"
                aria-label={label}
                aria-labelledby={label ? undefined : triggerId}
                aria-multiselectable={multi || undefined}
                className="overflow-y-auto p-1"
              >
                {rows.map((r, i) => (
                  <li
                    key={r.value ?? '__all'}
                    id={`${id}-opt-${i}`}
                    role="option"
                    aria-selected={isSelected(r.value)}
                    aria-disabled={r.disabled || undefined}
                    onMouseEnter={() => !r.disabled && setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => !r.disabled && pick(r.value)}
                    className={cn(
                      'group/opt relative flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition-colors duration-150',
                      r.disabled ? 'cursor-not-allowed text-muted-foreground/60' : 'cursor-pointer',
                      i === active && !r.disabled && 'bg-foreground text-background',
                    )}
                  >
                    {/* the chosen one carries a small ink dot, like the active nav item */}
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 shrink-0 rounded-full bg-current transition-transform duration-200',
                        isSelected(r.value) ? 'scale-100' : 'scale-0',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    {r.hint && (
                      <span
                        className={cn(
                          'shrink-0 text-xs',
                          i === active && !r.disabled
                            ? 'text-background/70'
                            : 'text-muted-foreground',
                        )}
                      >
                        {r.hint}
                      </span>
                    )}
                    {isSelected(r.value) && <Check aria-hidden className="size-3.5 shrink-0" />}
                  </li>
                ))}
                {rows.length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted-foreground">Nothing matches.</li>
                )}
                {footer && <li className="px-3 py-2 text-sm text-muted-foreground">{footer}</li>}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
