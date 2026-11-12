import { Link } from 'react-router';
import { Ban, ExternalLink, X } from 'lucide-react';
import type { DockStage, SprintTask } from '@relay/shared';
import { Badge, MrStateBadge } from '@/components/Badge';
import { EffortChip } from '@/components/EffortChip';
import { Button } from '@/components/ui/button';
import { safeHref } from '@/lib/utils';

export const STAGE_LABEL: Record<DockStage, string> = {
  quay: 'In the quarry (not started)',
  crane: 'On the bench (in progress)',
  deck: 'In the vitrine (in review)',
  sealed: 'Sealed (with QA)',
};

const mrPath = (repoId: string, iid: number) => `/mrs/${encodeURIComponent(repoId)}/${iid}`;

/** The card for one piece: everything about the task, its MRs and sub-tasks. */
export function TaskPanel({ task, onClose }: { task: SprintTask; onClose: () => void }) {
  const href = safeHref(task.url);
  return (
    <aside
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs"
      aria-label="Container details"
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-semibold break-words">{task.title}</h2>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Notion"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-4" />
          </a>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close details"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge variant="secondary">{task.status ?? 'no status'}</Badge>
        {task.type && <Badge variant="outline">{task.type}</Badge>}
        <EffortChip point={task.point} />
        {task.blocked && (
          <Badge variant="destructive">
            <Ban aria-hidden />
            blocked
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">
        {STAGE_LABEL[task.stage]} · {task.project}
      </p>
      <section>
        <h3 className="mb-1 font-medium">MRs</h3>
        {task.mrs.length === 0 ? (
          <p className="text-muted-foreground">No MR linked yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.mrs.map((m) => (
              <li key={`${m.repoId}#${m.iid}`} className="flex flex-wrap items-center gap-2">
                <MrStateBadge state={m.state} />
                <Link
                  to={mrPath(m.repoId, m.iid)}
                  className="min-w-0 break-words underline-offset-4 hover:underline"
                >
                  !{m.iid} {m.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-1 font-medium">Sub-tasks</h3>
        {task.subTasks.length === 0 ? (
          <p className="text-muted-foreground">None.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.subTasks.map((s) => {
              const sh = safeHref(s.url);
              const title = s.title ?? 'Sub-task not on your list';
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  {s.status ? (
                    <Badge variant="secondary">{s.status}</Badge>
                  ) : (
                    <Badge variant="outline">?</Badge>
                  )}
                  <EffortChip point={s.point} />
                  {sh ? (
                    <a
                      href={sh}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 break-words underline-offset-4 hover:underline"
                    >
                      {title}
                    </a>
                  ) : (
                    <span className="min-w-0 break-words">{title}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
