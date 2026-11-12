import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { NoIdentityNotice } from '@/components/MonthFilter';
import { CoreStage, useBacklogPromotion } from '@/core3d/CoreStage';
import { useFocusCount } from '@/kpi/TodaysFocus';
import { useGamification } from '@/lib/gamificationApi';
import { mrCreatePath, useReadyForMr } from '@/lib/mrCreateApi';
import { cn } from '@/lib/utils';
import { FOCUS_LIMIT } from './FocusPanel';
import { kpiItems, progressionSummary, releaseSummary } from './model';
import { OverviewControls } from './OverviewHeader';
import { OverviewSummary } from './OverviewSummary';
import { ToneDot } from './Panel';
import { Barcode, edition, headline } from './press';
import { calmTone } from './tone';
import type { OverviewData } from './useOverviewData';
import './cover.css';
import { useKpiPresets } from '@/lib/features';

/** One cover line: a small kicker over a large line, optionally a link. */
function CoverLine({
  kicker,
  to,
  children,
  className,
}: {
  kicker: string;
  to?: string;
  children: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <span className="type-micro text-muted-foreground">{kicker}</span>
      <span className="block text-2xl leading-[1.02] font-semibold tracking-[-0.03em] xl:text-3xl">
        {children}
      </span>
    </>
  );
  return to ? (
    <Link to={to} className={cn('cv-line group grid gap-1', className)}>
      {body}
    </Link>
  ) : (
    <div className={cn('cv-line grid gap-1', className)}>{body}</div>
  );
}

/**
 * Overview in the Living Workspace: a magazine cover. The crystal is the cover subject; the release percent is
 * printed over the scene in ink, as large as the page allows; cover lines run down both sides (what the release says,
 * where you are today, the classifieds, your level; and inside, what needs you), and the barcode strip carries the KPIs.
 * Every line is a way into its page.
 */
export function Cover({ data }: { data: OverviewData }) {
  const kpiPresets = useKpiPresets();
  const ed = edition();
  const promotion = useBacklogPromotion();
  const model = data.release.model;
  const s = model ? releaseSummary(model) : null;
  const h = headline(model, data.actions.center, data.offDuty);
  const ready = useReadyForMr().data?.items ?? [];
  const focus = useFocusCount(FOCUS_LIMIT);
  const game = useGamification().data;
  const level = game ? progressionSummary(game) : null;
  const report = data.kpi.report.data;
  const center = data.actions.center;

  return (
    <div className="cv-root" data-off-duty={data.offDuty || undefined}>
      <OverviewSummary data={data} />
      <div className="cv-stage">
        <CoreStage model={model} variant="stage" onPromote={promotion.promote} />
      </div>

      {/* the percent, printed over the scene */}
      <div className="cv-ink" aria-hidden>
        {s?.percent ?? '—'}
        {s?.percent !== null && s?.percent !== undefined && <span className="cv-ink-pct">%</span>}
      </div>

      <div className="cv-layer">
        <header className="cv-mast">
          <span className="cv-meta">
            No. {ed.no}
            <br />
            printed {ed.printed}
          </span>
          <h1 className="cv-title">
            The <span className="type-accent font-normal normal-case">Relay</span>
          </h1>
          <span className="cv-meta text-right">
            {ed.dateLine.split(', ')[0]}
            <br />
            {ed.dateLine.split(', ')[1]}
          </span>
        </header>

        <div className="cv-controls">
          <OverviewControls cards={data.cards} />
        </div>

        {/* left: the cover lines */}
        <nav className="cv-left" aria-label="Cover">
          <CoverLine kicker={h.kicker} to="/release">
            {h.before} <span className="type-accent font-normal">{h.accent}</span>
            {h.after}
          </CoverLine>
          {s && (
            <p className="font-mono text-xs text-muted-foreground">
              {s.facts.map((f) => `${f.value} ${f.label}`).join(' · ')}
            </p>
          )}
          {ready.length > 0 && ready[0] && (
            <CoverLine kicker="Classifieds" to={mrCreatePath(ready[0].repoId, ready[0].branch)}>
              {ready.length} branch{ready.length === 1 ? '' : 'es'} want
              {ready.length === 1 ? 's' : ''} an <span className="type-accent font-normal">MR</span>
            </CoverLine>
          )}
          {level && (
            <CoverLine kicker="Standings">
              Level {level.level},{' '}
              <span className="type-accent font-normal">{level.xpToNext} XP</span> to go
            </CoverLine>
          )}
          {model && model.dust.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {model.dust.length} backlog grain{model.dust.length === 1 ? '' : 's'} drift round the
              crystal: pick one to move it to Next Up.
            </p>
          )}
          <NoIdentityNotice />
        </nav>

        {/* right: inside this issue */}
        <aside className="cv-right" aria-label="Needs attention">
          <p className="flex items-baseline justify-between border-b-[3px] border-foreground pb-1">
            <span className="type-micro">Inside · needs you</span>
            <span className="font-mono text-xs tabular-nums">
              {String(center.total).padStart(2, '0')}
            </span>
          </p>
          {data.actions.loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!data.actions.loading && center.total === 0 && (
            <p className="text-2xl leading-tight font-semibold tracking-[-0.03em]">
              Nothing <span className="type-accent font-normal">needs</span> you.
            </p>
          )}
          <ol className="grid">
            {center.categories.map((c) => (
              <li key={c.id} className="border-b border-hairline">
                <Link to={c.to} className="cv-line group grid gap-0.5 py-2.5">
                  <span className="flex items-baseline gap-3">
                    <span className="font-mono text-3xl leading-none tabular-nums">
                      {String(c.count).padStart(2, '0')}
                    </span>
                    <span className="flex-1 text-lg leading-tight font-semibold tracking-[-0.02em]">
                      {c.title}
                    </span>
                    <ToneDot tone={calmTone(c.tone, data.offDuty)} />
                    <ArrowRight
                      aria-hidden
                      className="size-4 transition-transform group-hover:translate-x-1"
                    />
                  </span>
                  {c.preview[0] && (
                    <span className="line-clamp-1 pl-12 text-xs text-muted-foreground">
                      {c.preview[0].title}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {focus && (
              <li className="border-b border-hairline">
                <Link to="/kpi" className="cv-line group flex items-baseline gap-3 py-2.5">
                  <span className="font-mono text-3xl leading-none tabular-nums">
                    {String(focus.total).padStart(2, '0')}
                  </span>
                  <span className="flex-1 text-lg leading-tight font-semibold tracking-[-0.02em]">
                    On today&apos;s <span className="type-accent font-normal">agenda</span>
                  </span>
                  <ArrowRight
                    aria-hidden
                    className="size-4 transition-transform group-hover:translate-x-1"
                  />
                </Link>
              </li>
            )}
          </ol>
        </aside>

        {/* the barcode strip: the KPIs */}
        <footer className="cv-foot">
          <Link to="/kpi" className="cv-kpis" aria-label="KPI, open the full table">
            {report ? (
              kpiItems(report.scorecard, kpiPresets).map((item) => (
                <span key={item.key} className="grid min-w-0 gap-0.5">
                  <span className="flex items-center gap-1.5 type-micro text-muted-foreground">
                    <ToneDot tone={item.tone} className="size-1.5" />
                    <span className="truncate">{item.gauge.label}</span>
                  </span>
                  <span className="font-mono text-2xl leading-none tabular-nums">
                    {item.gauge.valueText}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {item.gauge.status.label}
                  </span>
                </span>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">KPI loading…</span>
            )}
          </Link>
          <div className="flex items-end gap-3">
            <Barcode seed={ed.no} />
            <span className="font-mono text-2xs leading-tight text-muted-foreground uppercase">
              Issue {ed.no}
              <br />
              {ed.short}
            </span>
          </div>
        </footer>
      </div>
      {promotion.dialog}
    </div>
  );
}
