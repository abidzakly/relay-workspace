import { WORKSPACE_COLORS, type WorkspaceColor } from '@relay/shared';
import { useCallback } from 'react';
import { useWorkspaces } from '@/lib/cockpitApi';
import { cn } from '@/lib/utils';
import { WS_NAME, WS_TEXT } from '@/cockpit/wsColors';

/**
 * A repo / workspace mark (Paper & Ink): a small cut crystal in the workspace's pigment, in place of a plain dot.
 * Each pigment has its own cut, so two marks never differ by colour alone. The body is the pigment, the lit face
 * a paper-white facet, the outline one ink hairline, on a 24-unit grid.
 */

interface Cut {
  /** The whole stone. */
  body: string;
  /** The lit face, drawn over the body. */
  facet: string;
  /** Inner cut lines. */
  lines: string;
}

const CUTS: Record<WorkspaceColor, Cut> = {
  // Ink: a brilliant, seen from above.
  amber: {
    body: 'M12 3 L20 9 L12 21 L4 9 Z',
    facet: 'M12 3 L20 9 H12 Z',
    lines: 'M4 9 H20 M12 3 V21',
  },
  // Moss: a hexagonal prism.
  emerald: {
    body: 'M12 3 L19.5 7.5 V16.5 L12 21 L4.5 16.5 V7.5 Z',
    facet: 'M12 3 L19.5 7.5 L12 12 Z',
    lines: 'M4.5 7.5 L12 12 L19.5 7.5 M12 12 V21',
  },
  // River: a tall point.
  sky: {
    body: 'M12 2.5 L17 8 V18 L12 21.5 L7 18 V8 Z',
    facet: 'M12 2.5 L17 8 H12 Z',
    lines: 'M7 8 H17 M12 2.5 V21.5',
  },
  // Plum: a pentagon cut.
  violet: {
    body: 'M12 3 L20.5 9.5 L17.2 20 H6.8 L3.5 9.5 Z',
    facet: 'M12 3 L20.5 9.5 L12 12.5 Z',
    lines: 'M3.5 9.5 L12 12.5 L20.5 9.5 M12 12.5 L6.8 20 M12 12.5 L17.2 20',
  },
  // Rosewood: a kite.
  rose: {
    body: 'M12 2.5 L19 10 L12 21.5 L5 10 Z',
    facet: 'M12 2.5 L5 10 H12 Z',
    lines: 'M5 10 H19 M12 10 V21.5',
  },
  // Olive: a broken shard.
  lime: {
    body: 'M8 3 L19 6 L17 15 L10 21 L5 12 Z',
    facet: 'M8 3 L19 6 L11.5 10.5 Z',
    lines: 'M5 12 L11.5 10.5 L19 6 M11.5 10.5 L10 21 M11.5 10.5 L17 15',
  },
  // Terracotta: an octagon table cut.
  orange: {
    body: 'M8.5 3 H15.5 L21 8.5 V15.5 L15.5 21 H8.5 L3 15.5 V8.5 Z',
    facet: 'M8.5 3 H15.5 L14 8 H10 Z',
    lines: 'M10 8 H14 L16 12 L14 16 H10 L8 12 Z',
  },
  // Sea: an emerald-step trapezoid.
  teal: {
    body: 'M6 4 H18 L21 12 L18 20 H6 L3 12 Z',
    facet: 'M6 4 H18 L16 8 H8 Z',
    lines: 'M8 8 H16 L17.5 12 L16 16 H8 L6.5 12 Z',
  },
};

const SIZE = { sm: 'size-3.5', md: 'size-5', lg: 'size-7' } as const;

export function RepoMark({
  color,
  size = 'sm',
  label,
  className,
}: {
  color: WorkspaceColor;
  size?: keyof typeof SIZE;
  /** Accessible name; omitted = decorative (the repo name is next to it). */
  label?: string;
  className?: string;
}) {
  const cut = CUTS[color] ?? CUTS.amber;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('shrink-0', SIZE[size], WS_TEXT[color], className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <path d={cut.body} fill="currentColor" />
      <path d={cut.facet} className="fill-card" fillOpacity={0.55} />
      <path
        d={cut.lines}
        fill="none"
        className="stroke-foreground"
        strokeOpacity={0.35}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <path
        d={cut.body}
        fill="none"
        className="stroke-foreground"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A row of marks to pick a workspace pigment. The mark grows and gains a ring when picked. */
export function RepoMarkPicker({
  value,
  onChange,
  id,
}: {
  value: WorkspaceColor | undefined;
  onChange: (c: WorkspaceColor) => void;
  id?: string;
}) {
  return (
    <div id={id} role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1">
      {WORKSPACE_COLORS.map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={on}
            title={WS_NAME[c]}
            onClick={() => onChange(c)}
            className={cn(
              'grid size-9 place-items-center rounded-control transition-transform active:scale-[0.97]',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              on ? 'bg-accent ring-1 ring-foreground/20' : 'hover:bg-accent/60',
            )}
          >
            <RepoMark color={c} size={on ? 'md' : 'sm'} label={WS_NAME[c]} />
          </button>
        );
      })}
    </div>
  );
}

/** The pigment of a repo = its first workspace's. null = no workspace for it yet. */
export function useRepoColor(): (repoId: string) => WorkspaceColor | null {
  const ws = useWorkspaces().data;
  return useCallback((repoId: string) => ws?.find((w) => w.repoId === repoId)?.color ?? null, [ws]);
}

/** A repo's name with its mark in front, when it has a workspace. */
export function RepoName({ repoId, name }: { repoId: string; name: string }) {
  const color = useRepoColor()(repoId);
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      {color && <RepoMark color={color} size="sm" />}
      {name}
    </span>
  );
}
