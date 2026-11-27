import { Plus, Rocket } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import type { Workspace } from '@relay/shared';
import type { SessionView } from '@/lib/sessionApi';
import { SPRING } from '@/lib/motion/presets';
import { cn } from '@/lib/utils';
import { Helper, helperState } from './Helper';
import { WS_DOT } from './wsColors';

/**
 * Every session as a helper in one dock under the focus sheet: its figure shows what it is doing, a badge marks the
 * ones waiting for you, and the open one stands lifted. New session and Start card sit at the dock's end.
 */
export function SessionDock({
  sessions,
  workspaces,
  active,
  onPick,
  onNew,
  onStartCard,
}: {
  sessions: readonly SessionView[];
  workspaces: readonly Workspace[];
  active: string | null;
  onPick: (s: SessionView) => void;
  onNew: () => void;
  onStartCard: () => void;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const wsOf = (id: string) => workspaces.find((w) => w.id === id);
  // Numbered per workspace and kind, so two Claude sessions read "Claude 1", "Claude 2".
  const label = (s: SessionView) => {
    if (s.cardId) return s.title;
    const same = sessions
      .filter((x) => x.workspaceId === s.workspaceId && x.kind === s.kind)
      .sort((a, b) => a.startedAt - b.startedAt);
    return `${t(`cockpit.kind.${s.kind}`)} ${same.indexOf(s) + 1}`;
  };
  return (
    <nav
      aria-label={t('cockpit.dock.label')}
      className="glass mx-auto flex max-w-full min-w-0 shrink-0 items-stretch gap-1 rounded-sheet p-1.5"
    >
      <ul className="flex min-w-0 items-stretch gap-1 overflow-x-auto [scrollbar-width:none]">
        {sessions.length === 0 && (
          <li className="grid place-items-center px-4 text-xs text-muted-foreground">
            {t('cockpit.dock.empty')}
          </li>
        )}
        {sessions.map((s) => {
          const on = s.id === active;
          const ws = wsOf(s.workspaceId);
          const needs = helperState(s) === 'needs-you';
          return (
            <li key={s.id} className="shrink-0">
              <motion.button
                type="button"
                onClick={() => onPick(s)}
                aria-current={on ? 'page' : undefined}
                title={`${s.title} · ${ws?.name ?? t('cockpit.workspace.removed')}`}
                animate={{ y: on ? -3 : 0 }}
                transition={reduced ? { duration: 0 } : SPRING.settle}
                className={cn(
                  'relative grid w-24 justify-items-center gap-0.5 rounded-surface px-1.5 pt-1.5 pb-1 text-center sm:w-28 [@media(max-height:760px)]:pt-1',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  on
                    ? 'bg-card text-foreground shadow-rest'
                    : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                )}
              >
                {needs && (
                  <span className="absolute top-1 right-2 rounded-full bg-emphasis px-1.5 text-micro font-semibold text-background">
                    <span className="sr-only">{t('cockpit.dock.needsYou')}</span>
                    <span aria-hidden>!</span>
                  </span>
                )}
                <Helper session={s} size="lg" showWord={false} />
                <span className="flex w-full min-w-0 items-center justify-center gap-1 text-2xs font-medium">
                  {ws && (
                    <span
                      aria-hidden
                      className={cn('size-1.5 shrink-0 rounded-full', WS_DOT[ws.color])}
                    />
                  )}
                  <span className="truncate">{label(s)}</span>
                </span>
                <span
                  className={cn(
                    'text-micro [@media(max-height:760px)]:hidden',
                    needs ? 'font-semibold text-emphasis' : 'text-muted-foreground',
                  )}
                >
                  {t(`cockpit.helper.${helperState(s)}`)}
                </span>
              </motion.button>
            </li>
          );
        })}
      </ul>
      <span aria-hidden className="my-2 w-px shrink-0 bg-hairline" />
      <button
        type="button"
        onClick={onNew}
        aria-label={t('cockpit.dock.newSession')}
        title={t('cockpit.dock.newSession')}
        className="grid w-12 shrink-0 place-items-center rounded-surface text-muted-foreground hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Plus className="size-5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onStartCard}
        aria-label={t('cockpit.dock.startCard')}
        title={t('cockpit.dock.startCard')}
        className="grid w-12 shrink-0 place-items-center rounded-surface text-muted-foreground hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Rocket className="size-5" aria-hidden />
      </button>
    </nav>
  );
}
