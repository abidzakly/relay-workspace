import { Loader2, Square } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useKillSession, type SessionView } from '@/lib/sessionApi';

const Terminal = lazy(() => import('@/components/term/Terminal'));

/** The log of a web dev server (install, then the script's output), with Stop. No hot-reload keys: it reloads itself. */
export function WebSessionLog({ s }: { s: SessionView }) {
  const { t } = useTranslation();
  const kill = useKillSession();
  const exited = s.state === 'exited';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{s.title}</span>
        {!exited && (
          <Button
            size="sm"
            variant="outline"
            disabled={kill.isPending}
            onClick={() => kill.mutate(s.id)}
          >
            <Square className="size-4" /> {t('testBench.web.stop')}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<Loader2 className="size-5 motion-safe:animate-spin" />}>
          <Terminal sessionId={s.id} fontSize={11} />
        </Suspense>
      </div>
    </div>
  );
}
