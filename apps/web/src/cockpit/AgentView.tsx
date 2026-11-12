import { Layers, Loader2, Smartphone, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useRef } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import type { TerminalHandle } from '@/components/term/Terminal';
import { deckPath } from '@/lib/deckApi';
import { sendPrompt, useKillSession, type SessionView } from '@/lib/sessionApi';
import { SPRING } from '@/lib/motion/presets';
import { useCoarsePointer } from '@/workspace/useMedia';
import { Composer } from './Composer';
import { FinishBurst, MoodCrystal, MoodLine, terminalMood } from './TerminalChrome';
import { ExtraKeys } from './ExtraKeys';

const Terminal = lazy(() => import('@/components/term/Terminal'));

/**
 * One session (agent or shell) full height: the real CLI in xterm, a turn-done banner ("Agent finished, N files
 * changed → Review"), quick chips + composer, and the extra-key bar on touch devices.
 */
export function AgentView({ s, returnTo }: { s: SessionView; returnTo?: string | null }) {
  const term = useRef<TerminalHandle>(null);
  const kill = useKillSession();
  const touch = useCoarsePointer();
  const agent = s.kind === 'claude' || s.kind === 'cursor';
  const turn = s.turn;
  const exited = s.state === 'exited';
  const mood = terminalMood(s);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-t-surface border-b border-border/60 px-1 pb-2">
        <MoodCrystal mood={mood} />
        <MoodLine
          mood={mood}
          detail={exited ? `${s.title} · exit ${s.exitCode ?? '?'}` : s.title}
        />
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 shrink-0 px-2"
          onClick={() => kill.mutate(s.id)}
          disabled={kill.isPending}
          aria-label="Close session"
        >
          <X className="size-3.5" /> {exited ? 'Close' : 'Stop'}
        </Button>
      </div>

      {returnTo && (
        <Link
          to={returnTo}
          className={
            s.waiting || exited
              ? 'flex items-center gap-2 rounded-surface border border-primary/40 bg-primary/10 px-3 py-2 text-sm'
              : 'flex items-center gap-2 rounded-surface border px-3 py-2 text-sm text-muted-foreground'
          }
        >
          <Smartphone className="size-4 shrink-0 text-primary-ink" />
          <span className="min-w-0 flex-1 truncate">
            {s.waiting || exited
              ? 'Agent done: retest the fixes on the phone'
              : 'Fixing findings from the Test Bench'}
          </span>
          <span className="shrink-0 font-medium text-primary-ink">Back to testing →</span>
        </Link>
      )}

      <AnimatePresence initial={false}>
        {agent && s.waiting && turn && !turn.reviewed && (turn.files ?? 0) > 0 && (
          <motion.div
            key={`turn-${turn.checkpoint ?? 'x'}`}
            initial={{ opacity: 0, y: -10, rotate: -0.6 }}
            animate={{ opacity: 1, y: 0, rotate: 0, transition: SPRING.wobble }}
            exit={{ opacity: 0, y: -6, transition: SPRING.settle }}
          >
            <Link
              to={deckPath({
                kind: 'local',
                workspaceId: s.workspaceId,
                mode: 'turn',
                ...(turn.checkpoint ? { base: String(turn.checkpoint) } : {}),
              })}
              state={{ from: `/cockpit?session=${s.id}` }}
              className="flex items-center gap-2 rounded-surface border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
            >
              <Layers className="size-4 shrink-0 text-primary-ink" />
              <span className="min-w-0 flex-1 truncate">
                {turn.headline ??
                  `Agent finished, ${turn.files} file${turn.files === 1 ? '' : 's'} changed`}
              </span>
              <span className="shrink-0 font-medium text-primary-ink">Review →</span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center rounded-surface bg-terminal">
              <Loader2 className="size-5 text-terminal-foreground motion-safe:animate-spin" />
            </div>
          }
        >
          <Terminal ref={term} sessionId={s.id} fontSize={touch ? 12 : 13} mood={mood} />
        </Suspense>
        {agent && <FinishBurst mood={mood} />}
      </div>

      {touch && !exited && <ExtraKeys onKey={(d) => term.current?.send(d)} />}
      {!exited && (
        <Composer
          kind={s.kind}
          onPrompt={(t) => void sendPrompt(s.id, t)}
          onKeys={(d) => term.current?.send(d)}
        />
      )}
    </div>
  );
}
