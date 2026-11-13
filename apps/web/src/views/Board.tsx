import { ColumnEffort } from '@/components/EffortChip';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ListChecks, Rocket } from 'lucide-react';
import { BULK_READY_MAX_CARDS, BULK_START_MAX, type StateCard } from '@relay/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/Badge';
import { BulkReadyDialog } from '@/components/BulkReadyDialog';
import { BulkStartDialog } from '@/cockpit/BulkStartDialog';
import { MonthFilter, NoIdentityNotice } from '@/components/MonthFilter';
import { Button } from '@/components/ui/button';
import { TimeAgo } from '@/components/TimeAgo';
import { BoardFilterBar } from '@/board/BoardFilters';
import { BoardDnd, DragTile, DropColumn, type PendingMove } from '@/board/BoardDnd';
import { CardTile, OrphanTile } from '@/board/CardTile';
import {
  buildBoard,
  bulkReadyCandidates,
  filterOptions,
  matchesFilters,
  NO_FILTERS,
  nid,
  orphanMatchesFilters,
  type BoardFilters,
} from '@/board/model';
import { describeError } from '@/lib/api';
import { inEnabledRepos, visibleCards } from '@/lib/cardScope';
import { useKpiCards } from '@/lib/kpiApi';
import { useRepos, useSettings } from '@/lib/settingsApi';
import { useHealthReport, useStateSnapshot } from '@/lib/stateApi';
import { useUiStore } from '@/store/ui';
import { PageTitle } from '@/components/PageTitle';
import { CardRiver } from '@/board/CardRiver';
import { PriorityList } from '@/board/PriorityList';
import { useVisual } from '@/lib/visuals';

export function Board() {
  const stateQ = useStateSnapshot();
  const healthQ = useHealthReport();
  const settingsQ = useSettings();
  const reposQ = useRepos();
  const kpiQ = useKpiCards();
  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [bulkIds, setBulkIds] = useState<string[] | null>(null);
  // Select mode: tick cards, then start each with its own agent.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStart, setBulkStart] = useState<StateCard[] | null>(null);
  const toggleSelected = useCallback(
    (id: string) =>
      setSelected((s) =>
        s.includes(id) ? s.filter((x) => x !== id) : s.length >= BULK_START_MAX ? s : [...s, id],
      ),
    [],
  );
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const repoNames = useMemo(
    () => new Map((reposQ.data ?? []).map((r) => [r.id, r.name] as const)),
    [reposQ.data],
  );
  const repoName = useCallback((id: string) => repoNames.get(id) ?? id, [repoNames]);

  const slaByCard = useMemo(
    () => new Map((kpiQ.data?.rows ?? []).map((r) => [nid(r.cardId), r] as const)),
    [kpiQ.data],
  );

  // Repos switched "On the board" in Settings; null until they load (nothing is hidden meanwhile).
  const enabledRepos = useMemo(
    () => (reposQ.data ? new Set(reposQ.data.filter((r) => r.enabled).map((r) => r.id)) : null),
    [reposQ.data],
  );
  const boardRepos = useMemo(() => (reposQ.data ?? []).filter((r) => r.enabled), [reposQ.data]);

  const cardMonth = useUiStore((s) => s.cardMonth);
  // Only my cards of the enabled repos, and the month, come first; the repo / assignee / type filters work inside.
  const scoped = useMemo(
    () =>
      stateQ.data
        ? {
            ...stateQ.data,
            cards: inEnabledRepos(
              visibleCards(stateQ.data.cards, cardMonth),
              enabledRepos,
              stateQ.data.links,
            ),
          }
        : undefined,
    [stateQ.data, cardMonth, enabledRepos],
  );

  const readyStatus = settingsQ.data?.notion.readyStatus;
  const completeStatuses = settingsQ.data?.notion.statusGroups.complete;
  const model = useMemo(
    () =>
      scoped && healthQ.data
        ? buildBoard(scoped, healthQ.data, readyStatus, completeStatuses)
        : null,
    [scoped, healthQ.data, readyStatus, completeStatuses],
  );
  const options = useMemo(() => filterOptions(scoped?.cards ?? []), [scoped]);

  // Drag and drop: every tile by card id, and the configured status each column stands for.
  const tileById = useMemo(
    () =>
      new Map((model?.columns ?? []).flatMap((c) => c.tiles.map((t) => [t.card.id, t] as const))),
    [model],
  );
  const statuses = settingsQ.data?.notion.statuses;
  const statusForColumn = useCallback(
    (column: string) =>
      (statuses ?? []).find((st) => st.trim().toLowerCase() === column.trim().toLowerCase()) ??
      null,
    [statuses],
  );
  const currentStatus = useCallback(
    (cardId: string) => tileById.get(cardId)?.card.status ?? null,
    [tileById],
  );

  const jump = useCallback((cardId: string) => {
    const el = [...document.querySelectorAll<HTMLElement>('[id^="card-"]')].find(
      (e) => nid(e.id.slice('card-'.length)) === nid(cardId),
    );
    if (!el) return; // parent filtered out of view
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    setHighlight(nid(cardId));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHighlight(null), 2000);
  }, []);

  // The palette's "jump to card". A filter could be hiding the card, so filters clear first and this runs again.
  const [params, setParams] = useSearchParams();
  const wantedCard = params.get('card');
  const setCardMonth = useUiStore((s) => s.setCardMonth);
  useEffect(() => {
    if (!wantedCard || !model) return;
    if (filters.repo || filters.assignee || filters.type || filters.query) {
      setFilters(NO_FILTERS);
      return;
    }
    if (cardMonth !== 'all') {
      const hidden = !model.columns.some((col) =>
        col.tiles.some((t) => nid(t.card.id) === nid(wantedCard)),
      );
      if (hidden) {
        setCardMonth('all');
        return;
      }
    }
    jump(wantedCard);
    setParams({}, { replace: true });
  }, [wantedCard, model, filters, jump, setParams, cardMonth, setCardMonth]);

  // "Work on next": a prioritized card can start when it is on the board and has a Branch formula, as in select mode.
  const boardCardById = useMemo(
    () => new Map((scoped?.cards ?? []).map((c) => [nid(c.id), c] as const)),
    [scoped],
  );
  const canStart = useCallback(
    (cardId: string) => !!boardCardById.get(nid(cardId))?.branchName,
    [boardCardById],
  );
  const startPrioritized = useCallback(
    (cardIds: string[]) =>
      setBulkStart(
        cardIds
          .map((id) => boardCardById.get(nid(id)))
          .filter((c): c is StateCard => c !== undefined && !!c.branchName),
      ),
    [boardCardById],
  );
  const pickPrioritized = useCallback(
    (cardId: string) => setParams({ card: cardId }, { replace: true }),
    [setParams],
  );

  // The river shows the same cards the columns do, after the filters.
  const showVisual = useVisual('board');
  const riverColumns = useMemo(
    () =>
      (model?.columns ?? []).map((col) => ({
        name: col.name,
        tiles: col.tiles.filter((t) => matchesFilters(t, filters)),
      })),
    [model, filters],
  );
  const showColumn = useCallback((name: string) => {
    document
      .querySelector(`[role="listitem"][aria-label="${CSS.escape(name)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, []);

  // Visible cards that look done.
  const bulkCandidates = useMemo(
    () => (model ? bulkReadyCandidates(model, filters) : []),
    [model, filters],
  );

  const error = stateQ.error ?? healthQ.error;
  const sync = stateQ.data?.health.sync;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Board</PageTitle>
          <p className="text-sm text-muted-foreground">
            Notion status and GitLab MR state side by side. Changes are confirmed first, audited and
            undoable
            {stateQ.data && (
              <>
                {' '}
                · snapshot <TimeAgo at={stateQ.data.generatedAt} />
              </>
            )}
            {sync?.lastRun && (
              <>
                {' '}
                · last sync <TimeAgo at={sync.lastRun.finishedAt} /> ({sync.lastRun.outcome})
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <MonthFilter cards={stateQ.data?.cards ?? []} />
          <BoardFilterBar
            filters={filters}
            onChange={setFilters}
            repos={boardRepos.map((r) => ({ id: r.id, name: r.name }))}
            assignees={options.assignees}
            types={options.types}
            matches={riverColumns.reduce((n, c) => n + c.tiles.length, 0)}
          />
          {selecting ? (
            <>
              <Button
                disabled={selected.length === 0}
                onClick={() =>
                  setBulkStart(
                    selected
                      .map((id) => stateQ.data?.cards.find((c) => c.id === id))
                      .filter((c): c is StateCard => c !== undefined),
                  )
                }
              >
                <Rocket />
                Start {selected.length} with agents
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSelecting(false);
                  setSelected([]);
                }}
              >
                Done
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              title={`Tick up to ${BULK_START_MAX} cards and start each with its own agent`}
              onClick={() => setSelecting(true)}
            >
              <ListChecks />
              Select
            </Button>
          )}
          <Button
            variant="outline"
            disabled={bulkCandidates.length === 0}
            title="Review the visible Complete / merged cards and move them to Ready to Test"
            onClick={() => setBulkIds(bulkCandidates.slice(0, BULK_READY_MAX_CARDS))}
          >
            Bulk Ready to Test ({Math.min(bulkCandidates.length, BULK_READY_MAX_CARDS)})
          </Button>
        </div>
      </div>
      <BulkReadyDialog cardIds={bulkIds} onClose={() => setBulkIds(null)} />
      <BulkStartDialog
        cards={bulkStart}
        onClose={() => {
          setBulkStart(null);
          setSelecting(false);
          setSelected([]);
        }}
      />
      <NoIdentityNotice />
      {reposQ.data && reposQ.data.length > 0 && boardRepos.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No repos are on the board. Turn one on in{' '}
          <Link to="/settings#repos" className="underline underline-offset-4">
            Settings → Repositories
          </Link>
          .
        </p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Cannot load the board</AlertTitle>
          <AlertDescription>{describeError(error)}</AlertDescription>
        </Alert>
      )}
      {kpiQ.isError && (
        <p className="text-xs text-muted-foreground">
          SLA timers are unavailable: {describeError(kpiQ.error)}
        </p>
      )}
      {!error && !model && <p className="text-sm text-muted-foreground">Loading…</p>}

      {model && (
        <>
          <PriorityList
            canStart={canStart}
            onPick={pickPrioritized}
            onStartAll={startPrioritized}
          />
          {showVisual && (
            <CardRiver columns={riverColumns} onPickColumn={showColumn} onPickCard={jump} />
          )}
          <BoardDnd
            pending={pending}
            onPending={setPending}
            statusForColumn={statusForColumn}
            currentStatus={currentStatus}
            overlay={(id) => {
              const t = tileById.get(id);
              return t ? (
                <CardTile
                  tile={t}
                  sla={slaByCard.get(nid(t.card.id)) ?? null}
                  repoName={repoName}
                  highlighted={false}
                  onJump={jump}
                />
              ) : null;
            }}
          >
            <div className="flex gap-3 overflow-x-auto pb-2" role="list" aria-label="Board columns">
              {model.columns.map((col) => {
                // A card waiting for its move to be confirmed shows in the column it was dropped on.
                const tiles = [
                  ...col.tiles.filter((t) => t.card.id !== pending?.cardId),
                  ...(pending?.column === col.name && tileById.get(pending.cardId)
                    ? [tileById.get(pending.cardId)!]
                    : []),
                ].filter((t) => matchesFilters(t, filters));
                return (
                  <DropColumn
                    key={col.name}
                    name={col.name}
                    enabled={statusForColumn(col.name) !== null}
                    role="listitem"
                    aria-label={col.name}
                    className="flex w-72 shrink-0 flex-col gap-2 rounded-lg bg-muted/40 p-2"
                  >
                    <header className="flex items-center justify-between px-1 py-1">
                      <h2 className="text-sm font-semibold">
                        {col.name}
                        {col.name === 'Backlog' && (
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            (not in progress %)
                          </span>
                        )}
                      </h2>
                      <span className="flex items-center gap-1">
                        <ColumnEffort points={tiles.map((t) => t.card.point)} />
                        <Badge variant="secondary">{tiles.length}</Badge>
                      </span>
                    </header>
                    {tiles.length === 0 && (
                      <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                        No cards
                      </p>
                    )}
                    {tiles.map((t) => (
                      <DragTile
                        key={t.card.id}
                        cardId={t.card.id}
                        column={col.name}
                        moving={pending?.cardId === t.card.id}
                      >
                        <CardTile
                          tile={t}
                          sla={slaByCard.get(nid(t.card.id)) ?? null}
                          repoName={repoName}
                          highlighted={highlight === nid(t.card.id)}
                          onJump={jump}
                          {...(selecting
                            ? {
                                select: {
                                  checked: selected.includes(t.card.id),
                                  disabled:
                                    !t.card.branchName ||
                                    (!selected.includes(t.card.id) &&
                                      selected.length >= BULK_START_MAX),
                                  onToggle: () => toggleSelected(t.card.id),
                                },
                              }
                            : {})}
                        />
                      </DragTile>
                    ))}
                  </DropColumn>
                );
              })}
            </div>
          </BoardDnd>

          {(() => {
            const orphans = model.orphans.filter(
              (o) => orphanMatchesFilters(o, filters) && o.mr.mine,
            );
            if (orphans.length === 0) return null;
            return (
              <section aria-label="Orphan MRs" className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">
                  MRs without a card <Badge variant="warning">{orphans.length}</Badge>
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {orphans.map((o) => (
                    <OrphanTile key={`${o.mr.repoId}#${o.mr.iid}`} orphan={o} repoName={repoName} />
                  ))}
                </div>
              </section>
            );
          })()}
        </>
      )}
    </div>
  );
}
