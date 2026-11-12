import type { WorkspaceColor } from '@relay/shared';

/**
 * One accent per workspace: chips, dots, tab underline. The names are stored data;
 * what each one looks like comes from the studio's pigments.
 */
export const WS_DOT: Record<WorkspaceColor, string> = {
  amber: 'bg-primary',
  emerald: 'bg-moss',
  sky: 'bg-river',
  violet: 'bg-plum',
  rose: 'bg-rosewood',
  lime: 'bg-olive',
  orange: 'bg-terracotta',
  teal: 'bg-sea',
};

export const WS_RING: Record<WorkspaceColor, string> = {
  amber: 'ring-primary/60 text-primary-ink',
  emerald: 'ring-moss/60 text-success',
  sky: 'ring-river/60 text-river-ink',
  violet: 'ring-plum/60 text-plum-ink',
  rose: 'ring-rosewood/60 text-rosewood-ink',
  lime: 'ring-olive/60 text-olive-ink',
  orange: 'ring-terracotta/60 text-emphasis',
  teal: 'ring-sea/60 text-sea-ink',
};

/** Text colour = the pigment, for marks drawn with `currentColor` (`RepoMark`). */
export const WS_TEXT: Record<WorkspaceColor, string> = {
  amber: 'text-primary',
  emerald: 'text-moss',
  sky: 'text-river',
  violet: 'text-plum',
  rose: 'text-rosewood',
  lime: 'text-olive',
  orange: 'text-terracotta',
  teal: 'text-sea',
};

/** What each stored name looks like, in the studio's words. */
export const WS_NAME: Record<WorkspaceColor, string> = {
  amber: 'Ink',
  emerald: 'Moss',
  sky: 'River',
  violet: 'Plum',
  rose: 'Rosewood',
  lime: 'Olive',
  orange: 'Terracotta',
  teal: 'Sea',
};
