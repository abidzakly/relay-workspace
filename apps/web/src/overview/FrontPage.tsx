import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
import { NoIdentityNotice } from '@/components/MonthFilter';
import { BacklogList, CoreStage, useBacklogPromotion } from '@/core3d/CoreStage';
import { KpiSky } from '@/kpi/sky/KpiSky';
import { FocusList } from '@/kpi/TodaysFocus';
import { describeError } from '@/lib/api';
import { useKpiPresets } from '@/lib/features';
import { useVisual } from '@/lib/visuals';
import { kpiContext } from './KpiGrid';
import { releaseSummary } from './model';
import { OverviewControls } from './OverviewHeader';
import { OverviewSummary } from './OverviewSummary';
import {
  Barcode,
  Briefs,
  Classifieds,
  edition,
  headline,
  Markets,
  PressHead,
  Standings,
} from './press';
import { UnknownReposAlert } from './ProgressSummary';
import type { OverviewData } from './useOverviewData';
import { FOCUS_LIMIT, FocusCount } from './FocusPanel';

/**
 * Overview in Classic: the day's front page. A masthead with the edition and the weather (where you work today); the
 * release as the lead story, its headline written from the numbers and the crystal as its photograph; what needs you
 * as the briefs beside it; the KPIs as the markets; then the agenda, the classifieds and the standings.
 */
export function FrontPage({ data }: { data: OverviewData }) {
  const { t, i18n } = useTranslation();
  const ed = edition(new Date(), i18n.language);
  const promotion = useBacklogPromotion();
  const kpiPresets = useKpiPresets();
  const skyOn = useVisual('kpi');
  const model = data.release.model;
  const h = headline(model, data.actions.center, data.offDuty, t, i18n.language);
  const s = model ? releaseSummary(model) : null;
  const fact = (key: string) => s?.facts.find((f) => f.key === key)?.value ?? 0;

  return (
    <article className="paper mx-auto flex w-full max-w-7xl flex-col gap-8">
      <OverviewSummary data={data} />

      {/* the masthead */}
      <header className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-2xs tracking-wide text-muted-foreground uppercase">
          <span>{t('overview.edition', { no: ed.no, printed: ed.printed })}</span>
          <span>{ed.dateLine}</span>
        </div>
        <h1 className="rise-in text-center text-[clamp(3rem,11vw,9.5rem)] leading-[0.82] font-semibold tracking-[-0.06em] uppercase">
          <Trans
            i18nKey="overview.masthead"
            components={[<span key="relay" className="type-accent font-normal normal-case" />]}
          />
        </h1>
        <div className="border-y-[3px] border-double border-foreground py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <OverviewControls cards={data.cards} />
          </div>
        </div>
        <NoIdentityNotice />
      </header>

      {h.breaking && (
        <Link
          to={data.actions.center.categories[0]?.to ?? '/'}
          className="rise-in flex items-center gap-3 bg-destructive px-4 py-2 text-background"
        >
          <span className="type-micro animate-pulse">{t('overview.breaking')}</span>
          <span className="truncate text-sm font-semibold">{h.breaking}</span>
        </Link>
      )}

      {/* the lead story and the briefs */}
      <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-0">
        <section
          className="grid gap-5 lg:border-r lg:border-hairline lg:pr-8"
          aria-label={t('overview.release')}
        >
          <p className="type-micro text-muted-foreground">{h.kicker}</p>
          <h2 className="rise-in text-[clamp(2.25rem,5.2vw,4.75rem)] leading-[0.9] font-semibold tracking-[-0.045em]">
            {h.before} <span className="type-accent font-normal">{h.accent}</span>
            {h.after}
          </h2>
          <p className="max-w-2xl text-lg leading-snug text-muted-foreground">{h.deck}</p>

          <figure className="grid gap-2">
            <div className="relative h-80 border border-hairline bg-foreground/[0.03] sm:h-112">
              <CoreStage model={model} variant="stage" onPromote={promotion.promote} />
            </div>
            <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                <Trans
                  i18nKey="overview.figure"
                  components={[<span key="fig" className="type-micro text-foreground" />]}
                />
              </span>
              <Link to="/release" className="arrow-link shrink-0 font-semibold uppercase">
                {t('overview.openRelease')}
              </Link>
            </figcaption>
          </figure>

          {model ? (
            <div className="columns-1 gap-8 text-sm leading-relaxed sm:columns-2">
              <p className="first-letter:float-left first-letter:mr-2 first-letter:text-6xl first-letter:leading-[0.8] first-letter:font-semibold">
                {t('overview.story.flow', {
                  count: fact('cards'),
                  scope: s?.scopeLabel.toLowerCase() ?? '',
                })}
                {s?.percent === null
                  ? t('overview.story.none')
                  : t('overview.story.percent', { percent: s?.percent })}
                .{' '}
                {fact('issues') > 0
                  ? t('overview.story.issues', { count: fact('issues') })
                  : t('overview.story.noIssues')}
                {fact('backlog') > 0
                  ? t('overview.story.backlog', { count: fact('backlog') })
                  : t('overview.story.noBacklog')}
                {t('overview.story.outside', { count: fact('outside') })}
              </p>
              <p className="mt-3">{s?.gapText ?? t('overview.story.gap')}</p>
              <BacklogList cards={model.dust} onPick={promotion.promote} />
              <UnknownReposAlert model={model} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {data.release.error
                ? t('overview.releaseError', { error: describeError(data.release.error) })
                : t('overview.settingType')}
            </p>
          )}
        </section>

        <aside
          className="grid content-start gap-4 lg:pl-8"
          aria-label={t('overview.needsAttention')}
        >
          <PressHead
            aside={
              <span className="font-mono text-xs tabular-nums">
                {String(data.actions.center.total).padStart(2, '0')}
              </span>
            }
          >
            {t('overview.inBrief')}
          </PressHead>
          <Briefs
            center={data.actions.center}
            offDuty={data.offDuty}
            errors={data.actions.errors}
            loading={data.actions.loading}
          />
        </aside>
      </div>

      {/* the markets */}
      <section className="grid gap-3" aria-label={t('overview.engineering')}>
        <PressHead
          aside={
            <Link to="/kpi" className="arrow-link text-2xs font-semibold uppercase hover:underline">
              {t('overview.fullTable')}
            </Link>
          }
        >
          {t('overview.markets', {
            about: kpiContext(t, data.kpi.report.data, data.kpi.allMonths),
          })}
        </PressHead>
        {data.kpi.report.isPending && (
          <p className="text-sm text-muted-foreground">{t('overview.loading')}</p>
        )}
        {data.kpi.report.isError && (
          <p className="text-xs text-destructive">{describeError(data.kpi.report.error)}</p>
        )}
        {data.kpi.report.data &&
          (skyOn ? (
            <div className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
              <Link
                to="/kpi"
                aria-label={t('overview.kpiPicture')}
                className="justify-self-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <KpiSky
                  compact
                  size="md"
                  report={data.kpi.report.data}
                  presets={kpiPresets}
                  onPick={() => undefined}
                />
              </Link>
              <Markets report={data.kpi.report.data} />
            </div>
          ) : (
            <Markets report={data.kpi.report.data} />
          ))}
      </section>

      {/* the back of the page */}
      <div className="grid gap-10 lg:grid-cols-3 lg:gap-8">
        <section className="grid content-start gap-3" aria-label={t('overview.todaysFocus')}>
          <PressHead aside={<FocusCount />}>{t('overview.agenda')}</PressHead>
          <FocusList limit={FOCUS_LIMIT} compact />
        </section>
        <section className="grid content-start gap-3" aria-label={t('overview.readyForMr')}>
          <PressHead>{t('overview.classifieds')}</PressHead>
          <Classifieds compact />
        </section>
        <section className="grid content-start gap-3" aria-label={t('overview.progression')}>
          <PressHead>{t('overview.standings')}</PressHead>
          <Standings />
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t-[3px] border-double border-foreground pt-3">
        <p className="font-mono text-2xs text-muted-foreground uppercase">
          {t('overview.footer', { no: ed.no, short: ed.short })}
        </p>
        <Barcode seed={ed.no} />
      </footer>
      {promotion.dialog}
    </article>
  );
}
