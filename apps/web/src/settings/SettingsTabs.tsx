import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { SETTINGS_GROUPS, type SettingsGroupId } from './sections';

export const tabId = (g: SettingsGroupId) => `settings-tab-${g}`;
export const panelId = (g: SettingsGroupId) => `settings-panel-${g}`;

/**
 * The Settings group tabs. An ink underline slides to the chosen tab; arrows, Home and End move between tabs.
 * The underline is measured, not a shared layout: the page scrolls inside a frame, which threw a `layoutId` off.
 * `attention` marks a group with something to set up, with a dot and a word for screen readers.
 */
export function SettingsTabs({
  active,
  onSelect,
  dimmed,
  attention,
}: {
  active: SettingsGroupId;
  onSelect: (g: SettingsGroupId) => void;
  /** A search is showing every group, so no tab is the current one. */
  dimmed: boolean;
  attention: Partial<Record<SettingsGroupId, string>>;
}) {
  const refs = useRef(new Map<SettingsGroupId, HTMLButtonElement>());
  const [line, setLine] = useState<{ x: number; width: number } | null>(null);
  // Glide the row only after the first paint: a deep link lands on its tab at once, while the page itself scrolls.
  const settled = useRef(false);
  useLayoutEffect(() => {
    const btn = refs.current.get(active);
    if (!btn) return;
    const row = btn.parentElement;
    const measure = () => {
      setLine({ x: btn.offsetLeft + 10, width: btn.offsetWidth - 20 });
      // On a phone the tab row scrolls sideways; keep the chosen tab in view.
      if (
        row &&
        (btn.offsetLeft < row.scrollLeft ||
          btn.offsetLeft + btn.offsetWidth > row.scrollLeft + row.clientWidth)
      ) {
        row.scrollTo({
          left: btn.offsetLeft - 16,
          behavior: settled.current ? 'smooth' : 'instant',
        });
      }
    };
    measure();
    const t = setTimeout(() => (settled.current = true), 500);
    const ro = new ResizeObserver(measure);
    ro.observe(btn);
    if (row) ro.observe(row);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [active]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SETTINGS_GROUPS.findIndex((g) => g.id === active);
    const last = SETTINGS_GROUPS.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % SETTINGS_GROUPS.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + SETTINGS_GROUPS.length) % SETTINGS_GROUPS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    const g = SETTINGS_GROUPS[next]!.id;
    onSelect(g);
    refs.current.get(g)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Settings groups"
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex min-w-0 gap-1 overflow-x-auto transition-opacity duration-300',
        dimmed && 'opacity-50',
      )}
    >
      {SETTINGS_GROUPS.map((g) => {
        const selected = !dimmed && g.id === active;
        const note = attention[g.id];
        return (
          <button
            key={g.id}
            ref={(el) => {
              if (el) refs.current.set(g.id, el);
              else refs.current.delete(g.id);
            }}
            id={tabId(g.id)}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId(g.id)}
            tabIndex={g.id === active ? 0 : -1}
            title={note}
            onClick={() => onSelect(g.id)}
            className={cn(
              'relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-micro font-semibold tracking-[0.06em] whitespace-nowrap uppercase transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {g.label}
            {note && (
              <>
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                <span className="sr-only">, {note}</span>
              </>
            )}
          </button>
        );
      })}
      {line && !dimmed && (
        <motion.span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 bg-foreground"
          initial={false}
          animate={{ x: line.x, width: line.width }}
          transition={SPRING.settle}
        />
      )}
    </div>
  );
}
