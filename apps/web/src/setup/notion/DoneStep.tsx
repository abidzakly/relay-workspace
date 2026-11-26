import { ArrowUpRight, CalendarDays, GitBranch, Layers, UserRound } from 'lucide-react';
import type { NotionMe, NotionSchemaView } from '@relay/shared';
import { initials } from '@/components/PickRow';
import { ROLES, STAGES, type RoleKey, type StageKey } from './autoMap';

type EditStep = 'board' | 'columns' | 'statuses' | 'you';

const USER_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/** The latest card with the most of the wired columns filled in: the best proof the wiring reads right. */
function bestSample(view: NotionSchemaView | undefined, map: Partial<Record<RoleKey, string>>) {
  if (!view?.samples.length) return null;
  const cols = Object.values(map).filter(Boolean) as string[];
  return [...view.samples].sort(
    (a, b) => cols.filter((c) => b[c]).length - cols.filter((c) => a[c]).length,
  )[0]!;
}

/**
 * Done: the board's latest card drawn the way Relay will read it (each value says which column it came from), then
 * the board, the status flow and you, each one step away from being changed.
 */
export function DoneStep({
  view,
  boardTitle,
  map,
  statuses,
  stages,
  readyStatus,
  aliases,
  me,
  onEdit,
}: {
  view: NotionSchemaView | undefined;
  boardTitle: string;
  map: Partial<Record<RoleKey, string>>;
  statuses: string[];
  stages: Record<string, StageKey>;
  readyStatus: string;
  aliases: string;
  me: NotionMe | undefined;
  onEdit: (step: EditStep) => void;
}) {
  const card = bestSample(view, map);
  const read = (k: RoleKey) => (map[k] && card ? card[map[k]!] : '') || '';
  const status = read('status');
  const stage = STAGES.find((g) => g.key === stages[status]);
  const wired = ROLES.filter((r) => map[r.key]);
  const required = ROLES.filter((r) => r.required);
  const names = aliases
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const id = names.find((n) => USER_ID.test(n));
  const name = me?.name ?? names.find((n) => !USER_ID.test(n) && !n.includes('@')) ?? 'You';
  const email = me?.email ?? names.find((n) => n.includes('@'));

  const facts: { role: RoleKey; icon?: React.ReactNode; mono?: boolean }[] = [
    { role: 'assignee', icon: <UserRound className="size-3.5" aria-hidden /> },
    { role: 'estimation', icon: <CalendarDays className="size-3.5" aria-hidden /> },
    { role: 'branchName', icon: <GitBranch className="size-3.5" aria-hidden />, mono: true },
    { role: 'parent', icon: <Layers className="size-3.5" aria-hidden /> },
    { role: 'sprint' },
    { role: 'productDomain' },
    { role: 'point' },
  ];

  return (
    <div className="grid gap-8">
      <figure className="sb-proof">
        <figcaption className="sb-proof-cap">
          Your latest card on {boardTitle || 'the board'}, as Relay will read it
        </figcaption>
        {card ? (
          <article className="sb-ticket">
            <header className="flex flex-wrap items-center gap-2">
              {read('type') ? <span className="sb-ticket-type">{read('type')}</span> : null}
              {status ? (
                <span className="sb-ticket-status" data-stage={stage?.key}>
                  <span className="sb-stage-dot" data-stage={stage?.key} aria-hidden />
                  {status}
                  {stage ? <span className="text-muted-foreground"> · {stage.label}</span> : null}
                </span>
              ) : null}
            </header>
            <h3 className="sb-ticket-title">{read('title') || 'Untitled card'}</h3>
            <dl className="sb-ticket-facts">
              {facts.map((f) => {
                const role = ROLES.find((r) => r.key === f.role)!;
                const v = read(f.role);
                if (!map[f.role]) return null;
                return (
                  <div key={f.role}>
                    <dt>
                      {f.icon}
                      {role.label}
                    </dt>
                    <dd className={f.mono ? 'font-mono text-xs' : undefined} title={v}>
                      {v || <span className="text-muted-foreground">empty on this card</span>}
                    </dd>
                    <span className="sb-ticket-from">from “{map[f.role]}”</span>
                  </div>
                );
              })}
            </dl>
          </article>
        ) : (
          <p className="sb-ticket text-sm text-muted-foreground">
            This board has no cards yet, so there is nothing to preview. The wiring still saves.
          </p>
        )}
      </figure>

      <div className="sb-ledger">
        <section className="sb-ledger-cell">
          <LedgerHead title="Board" onEdit={() => onEdit('board')} />
          <p className="sb-ledger-big">{boardTitle || 'not picked'}</p>
          <p className="sb-ledger-sub">
            <button type="button" className="sb-inline-link" onClick={() => onEdit('columns')}>
              {wired.length} of {ROLES.length} lines wired
            </button>
            {' · '}
            {required.every((r) => map[r.key]) ? 'every required one' : 'some required missing'}
          </p>
        </section>

        <section className="sb-ledger-cell">
          <LedgerHead title="You" onEdit={() => onEdit('you')} />
          <div className="flex items-center gap-3">
            <span className="sb-avatar" aria-hidden>
              {initials(name)}
            </span>
            <span className="grid min-w-0">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {email ?? (id ? `id ${id.slice(0, 8)}…` : 'no Notion user id yet')}
              </span>
            </span>
          </div>
        </section>

        <section className="sb-ledger-cell sb-ledger-wide">
          <LedgerHead title="Status flow" onEdit={() => onEdit('statuses')} />
          <ol className="sb-flow">
            {STAGES.map((g) => {
              const inStage = statuses.filter((s) => stages[s] === g.key);
              return (
                <li key={g.key} data-stage={g.key} data-empty={inStage.length === 0}>
                  <span className="sb-flow-head">
                    <span className="sb-stage-dot" data-stage={g.key} aria-hidden />
                    {g.label}
                  </span>
                  {g.key === 'qa' && inStage.includes(readyStatus) ? (
                    <span className="sb-flow-ready">Ready for QA: {readyStatus}</span>
                  ) : null}
                  <span className="flex flex-wrap gap-1">
                    {inStage.length ? (
                      inStage.map((s) => (
                        <span key={s} className="sb-flow-chip" data-ready={s === readyStatus}>
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">none</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}

function LedgerHead({ title, onEdit }: { title: string; onEdit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="sb-bay-head">{title}</h3>
      <button type="button" className="sb-inline-link" onClick={onEdit}>
        Change
        <ArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
