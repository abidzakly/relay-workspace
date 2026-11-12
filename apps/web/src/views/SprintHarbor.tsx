import { Gem } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DOCK_STAGES, formatHours, pointHours, type Sprint, type SprintTask } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { EffortChip } from '@/components/EffortChip';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { describeError } from '@/lib/api';
import { useSprints } from '@/lib/sprintsApi';
import { cn } from '@/lib/utils';
import { HarborMagnifier } from '@/sprints/HarborMagnifier';
import { HarborScene, type TapPoint } from '@/sprints/HarborScene';
import { shipModel, type HarborZone } from '@/sprints/harborLayout';
import { STAGE_LABEL, TaskPanel } from '@/sprints/TaskPanel';
import { usePhonePortrait } from '@/workspace/useMedia';
import { PageTitle } from '@/components/PageTitle';

const ALL = '';

/** Load of a sprint for the selected project only. */
function filtered(s: Sprint, project: string): Sprint {
  if (project === ALL) return s;
  const tasks = s.tasks.filter((t) => t.project === project);
  let loadHours = 0;
  let doneHours = 0;
  for (const t of tasks) {
    const pts = [t.point, ...t.subTasks.filter((x) => x.title !== null).map((x) => x.point)];
    for (const p of pts) {
      const h = pointHours(p);
      loadHours += h;
      if (t.stage === 'sealed') doneHours += h;
    }
  }
  return { ...s, tasks, loadHours, doneHours, active: tasks.some((t) => t.stage !== 'sealed') };
}

function Gauge({ s }: { s: Sprint }) {
  const m = shipModel(s);
  const pct = Math.min(100, Math.round(m.ratio * 100));
  return (
    <span className="flex w-full items-center gap-1.5">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            'block h-full rounded-full',
            m.overloadedBy > 0 ? 'bg-destructive' : m.ratio > 0.85 ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="text-2xs tabular-nums text-muted-foreground">
        {Math.round(m.ratio * 100)}%
      </span>
    </span>
  );
}

/** Sprint Atelier: each sprint is a vitrine; tasks are crystals sized by Point; the fill line is the load. */
export function SprintHarbor() {
  const q = useSprints();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') ?? ALL;
  const [picked, setPicked] = useState<SprintTask | null>(null);
  // Phone portrait only: crates are ~10 px there, so a tap opens the magnifier on that zone instead.
  const phone = usePhonePortrait();
  const [magnify, setMagnify] = useState<{ zone: HarborZone; at: TapPoint } | null>(null);

  const sprints = useMemo(
    () =>
      (q.data?.sprints ?? []).map((s) => filtered(s, project)).filter((s) => s.tasks.length > 0),
    [q.data, project],
  );
  const wanted = params.get('sprint');
  const current =
    sprints.find((s) => s.name === wanted) ?? sprints.find((s) => s.active) ?? sprints[0] ?? null;

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPicked(null);
    setMagnify(null);
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Sprint Atelier</PageTitle>
          <p className="text-sm text-muted-foreground">
            Each sprint is a vitrine. Tasks are crystals sized by Point: raw in the quarry, cut on
            the bench, set in the case. The fill line is estimated hours against capacity.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by project">
          {[
            { name: ALL, label: 'All projects' },
            ...(q.data?.projects ?? []).map((p) => ({ name: p.name, label: p.name })),
          ].map((p) => (
            <button
              key={p.name || 'all'}
              type="button"
              aria-pressed={project === p.name}
              onClick={() => setParam('project', p.name)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                project === p.name
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {q.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load sprints</AlertTitle>
          <AlertDescription>{describeError(q.error)}</AlertDescription>
        </Alert>
      )}
      {q.data && sprints.length === 0 && (
        <Alert>
          <AlertTitle>The atelier is empty</AlertTitle>
          <AlertDescription>
            No sprint has tasks in a connected project. Check that “Select Sprint” and “Product
            Domain” resolve in Settings → Notion (Test connection), and that each project’s repo
            lists its Product Domain.
            {q.data.skippedUnconnected > 0 &&
              ` ${q.data.skippedUnconnected} sprint card(s) belong to projects without a connected repo.`}
          </AlertDescription>
        </Alert>
      )}

      {current && (
        <>
          <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="Sprints">
            {sprints.map((s) => (
              <button
                key={s.name}
                type="button"
                aria-current={s.name === current.name}
                onClick={() => setParam('sprint', s.name)}
                className={cn(
                  'flex w-40 shrink-0 flex-col items-start gap-1 rounded-surface border px-3 py-2 text-left text-xs',
                  s.name === current.name
                    ? 'border-foreground bg-foreground/5'
                    : 'border-hairline hover:bg-muted',
                )}
              >
                <span className="w-full truncate font-medium">
                  <Gem aria-hidden className="mr-1 inline size-3.5" />
                  {s.name}
                </span>
                <span className="text-muted-foreground">
                  {s.tasks.length} tasks · {formatHours(s.loadHours)}
                </span>
                <Gauge s={s} />
              </button>
            ))}
          </nav>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <Card className="min-w-0 overflow-hidden p-0">
              <HarborScene
                sprint={current}
                tasks={current.tasks}
                selectedId={picked?.id ?? null}
                onPick={setPicked}
                {...(phone ? { onMagnify: (zone, at) => setMagnify({ zone, at }) } : {})}
              />
            </Card>
            {phone && magnify && (
              <HarborMagnifier
                sprint={current}
                tasks={current.tasks}
                selectedId={picked?.id ?? null}
                zone={magnify.zone}
                origin={magnify.at}
                onZone={(zone) => setMagnify({ ...magnify, zone })}
                onClose={() => setMagnify(null)}
                onPick={(t) => {
                  setMagnify(null);
                  setPicked(t);
                }}
              />
            )}
            <div className="flex min-w-0 flex-col gap-3">
              {picked ? (
                <TaskPanel task={picked} onClose={() => setPicked(null)} />
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>{current.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2 text-sm">
                    <p>
                      {formatHours(current.doneHours)} of {formatHours(current.loadHours)} sealed ·{' '}
                      capacity {formatHours(current.capacityHours)}
                    </p>
                    {current.loadHours > current.capacityHours && (
                      <Badge variant="destructive">
                        Overloaded by {formatHours(current.loadHours - current.capacityHours)}
                      </Badge>
                    )}
                    {(current.research > 0 || current.unestimated > 0) && (
                      <p className="text-muted-foreground">
                        {current.research} research (open-ended) · {current.unestimated} without a
                        Point
                      </p>
                    )}
                    <ul className="grid grid-cols-2 gap-1 text-xs">
                      {DOCK_STAGES.map((st) => (
                        <li key={st} className="rounded-md bg-muted px-2 py-1">
                          {STAGE_LABEL[st].split(' (')[0]}:{' '}
                          <b>{current.tasks.filter((t) => t.stage === st).length}</b>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {phone
                        ? 'Tap the quarry, bench or vitrine to magnify it, then tap a piece for its MRs and sub-tasks.'
                        : 'Click a piece for its MRs and sub-tasks.'}{' '}
                      Legend: piece size = Point, rough = not started, tick = with QA, dots = MR
                      stamps, chips on top = sub-tasks, violet “?” = research, HEAVY = 2-day task.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Manifest</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {DOCK_STAGES.map((st) => {
                const list = current.tasks.filter((t) => t.stage === st);
                if (list.length === 0) return null;
                return (
                  <section key={st}>
                    <h3 className="mb-1 text-sm font-medium">{STAGE_LABEL[st]}</h3>
                    <ul className="flex flex-col divide-y text-sm">
                      {list.map((t) => (
                        <li key={t.id} className="py-1">
                          <button
                            type="button"
                            onClick={() => setPicked(t)}
                            className="flex w-full flex-wrap items-center gap-1.5 text-left hover:underline"
                          >
                            <span className="min-w-0 flex-1 break-words">{t.title}</span>
                            <EffortChip point={t.point} />
                            {t.mrs.length > 0 && <Badge variant="outline">{t.mrs.length} MR</Badge>}
                            {t.subTasks.length > 0 && (
                              <Badge variant="outline">{t.subTasks.length} sub</Badge>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
