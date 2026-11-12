import { Bot, Check, GitPullRequestCreate, Layers, StickyNote } from 'lucide-react';
import { Link } from 'react-router';
import { TimeAgo } from '@/components/TimeAgo';
import { describeError } from '@/lib/api';
import { useAttention, type AttentionItem } from '@/lib/workflowApi';

const ICON: Record<AttentionItem['kind'], typeof Bot> = {
  agent_waiting: Bot,
  turn_review: Layers,
  ready_for_mr: GitPullRequestCreate,
  saved_note: StickyNote,
};

/**
 * "Needs your attention": one place for agents waiting, turns ready to review, branches
 * ready for an MR, and "save for later" notes not acted on yet.
 */
export function AttentionPanel({ compact }: { compact?: boolean }) {
  const q = useAttention();
  const items = q.data ?? [];
  if (compact && items.length === 0) return null;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="Needs your attention">
      <p className="flex items-center gap-2 text-sm font-medium">
        Needs your attention
        {items.length > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-2xs font-semibold text-primary-foreground">
            {items.length}
          </span>
        )}
      </p>
      {q.error && <p className="text-xs text-destructive">{describeError(q.error)}</p>}
      {items.length === 0 && q.data && (
        <p className="flex items-center gap-1 text-sm text-muted-foreground">
          <Check aria-hidden className="size-4" />
          All clear
        </p>
      )}
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        {items.slice(0, compact ? 5 : 50).map((it, i) => {
          const Icon = ICON[it.kind];
          return (
            <li key={`${it.kind}:${it.to}:${i}`}>
              <Link
                to={it.to}
                className="flex min-w-0 items-center gap-3 tactile rounded-control border bg-card px-3 py-2 hover:bg-accent/50"
              >
                <Icon className="size-4 shrink-0 text-primary-ink" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{it.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{it.detail}</span>
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  <TimeAgo at={it.at} />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
