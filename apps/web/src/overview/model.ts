import type { GamificationReport, KpiScorecard } from '@relay/shared';
import type { ProgressGap, ProgressModel } from '@/core3d/progressMapping';
import {
  bugGauge,
  completionGauge,
  hitRateGauge,
  researchGauge,
  type GaugeModel,
} from '@/kpi/model';
import type { CoreScope } from '@/store/ui';
import type { ActionGroup, ActionRow } from './needsActionModel';
import { toneOfGauge, type Tone } from './tone';

/**
 * Overview 2.0 view models. Pure: no React, no fetching. Both presentation shells read these, so
 * Classic and the Living Workspace show the same numbers, labels and states. Nothing here takes the stage view
 * (Ship / Rings / Blocks) or the ASCII mode: presentation controls cannot move a metric.
 */

/* ───────────────────────── release ───────────────────────── */

export const SCOPE_LABEL: Record<CoreScope, string> = {
  cycle: 'Current cycle',
  all: 'All-time',
};

export const GAP_TEXT: Record<ProgressGap, string> = {
  no_cards: 'No cards to count yet.',
  only_excluded: 'Nothing to count: every card is in Backlog, Issues or outside the flow.',
  boundary_unknown: 'Cannot tell where this cycle starts. All-time still works.',
};

export interface ReleaseFact {
  key: 'cards' | 'issues' | 'outside' | 'backlog';
  label: string;
  value: number;
}

export interface ReleaseSummary {
  scope: CoreScope;
  scopeLabel: string;
  /** Rounded down, so 100% only ever means every counted card is Ready to Test. Null = no progress to show. */
  percent: number | null;
  percentText: string;
  /** Every count is listed, zero included, so the summary keeps its shape. */
  facts: ReleaseFact[];
  /** One line, the same as the facts the old summary joined with " · ". */
  factsText: string;
  gapText: string | null;
  /** Some release states are unknown, so the percent is partial (or unknown). */
  partial: boolean;
  tone: Tone;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Reads the CoreStage progress model; it never computes a second progress. */
export function releaseSummary(model: ProgressModel): ReleaseSummary {
  const percent = model.percent === null ? null : Math.floor(model.percent);
  const counted = model.percent === null ? 0 : model.segments.length;
  const facts: ReleaseFact[] = [
    { key: 'cards', label: 'in the flow', value: counted },
    { key: 'issues', label: 'in Issues', value: model.cracks.length },
    { key: 'outside', label: 'outside the flow', value: model.uncounted },
    { key: 'backlog', label: 'in Backlog', value: model.dust.length },
  ];
  // The one-line form drops zeros, as the summary always has.
  const line = [
    model.percent !== null && plural(model.segments.length, 'card'),
    model.cracks.length > 0 && `${model.cracks.length} in Issues`,
    model.uncounted > 0 && `${model.uncounted} outside the flow`,
    model.dust.length > 0 && `${model.dust.length} in Backlog`,
  ].filter(Boolean);
  const partial = model.unknownRepos.length > 0;
  return {
    scope: model.scope,
    scopeLabel: SCOPE_LABEL[model.scope],
    percent,
    percentText: percent === null ? '—' : `${percent}%`,
    facts,
    factsText: line.join(' · '),
    gapText: model.gap ? GAP_TEXT[model.gap] : null,
    partial,
    tone: percent === null ? 'nodata' : partial ? 'warn' : percent >= 100 ? 'good' : 'info',
  };
}

/* ───────────────────────── action center ───────────────────────── */

export interface ActionCategory {
  id: ActionGroup['id'];
  title: string;
  count: number;
  tone: Tone;
  /** The first rows, in the source's own order (already most urgent first). */
  preview: ActionRow[];
  /** Rows not in the preview. */
  more: number;
  to: string;
}

/** A group's tone from its kind and the server's severities, never from titles. */
export function groupTone(group: ActionGroup): Tone {
  if (group.rows.length === 0) return 'good';
  switch (group.id) {
    case 'pipelines':
      return 'bad';
    case 'mismatches':
    case 'sla':
      return group.rows.some((r) => r.severity === 'critical') ? 'bad' : 'warn';
    case 'mrs':
      return 'warn';
    case 'release':
      return 'info';
  }
}

export interface ActionCenter {
  /** Groups with at least one row, in the existing urgency order. */
  categories: ActionCategory[];
  total: number;
  /** The most urgent tone present; `good` when nothing needs you. */
  tone: Tone;
}

const TONE_RANK: Record<Tone, number> = { bad: 4, warn: 3, info: 2, good: 1, nodata: 0 };

export function actionCenter(groups: readonly ActionGroup[], previewLimit = 3): ActionCenter {
  const categories = groups
    .filter((g) => g.rows.length > 0)
    .map((g) => ({
      id: g.id,
      title: g.title,
      count: g.rows.length,
      tone: groupTone(g),
      preview: g.rows.slice(0, previewLimit),
      more: Math.max(0, g.rows.length - previewLimit),
      to: g.to,
    }));
  const tone = categories.reduce<Tone>(
    (worst, c) => (TONE_RANK[c.tone] > TONE_RANK[worst] ? c.tone : worst),
    'good',
  );
  return { categories, total: categories.reduce((n, c) => n + c.count, 0), tone };
}

/* ───────────────────────── KPI ───────────────────────── */

export interface KpiItem {
  key: 'completion' | 'bug' | 'sla' | 'research';
  gauge: GaugeModel;
  tone: Tone;
}

/** The four engineering-health KPIs, in a fixed order, on top of the existing gauges (definitions unchanged). */
export function kpiItems(
  scorecard: KpiScorecard,
  presets: { bugRatio: boolean; researchQuota: boolean } = { bugRatio: true, researchQuota: true },
): KpiItem[] {
  const all: [KpiItem['key'], GaugeModel][] = [
    ['completion', completionGauge(scorecard.completion)],
    ['bug', bugGauge(scorecard.bugRatio)],
    ['sla', hitRateGauge(scorecard.sla.overall)],
    ['research', researchGauge(scorecard.research)],
  ];
  // KPI presets (Settings > Planning): a switched-off preset is not shown.
  const items = all.filter(
    ([key]) => (key !== 'bug' || presets.bugRatio) && (key !== 'research' || presets.researchQuota),
  );
  return items.map(([key, gauge]) => ({
    key,
    gauge,
    tone: toneOfGauge(gauge.status.tone, gauge.fraction !== null),
  }));
}

/* ───────────────────────── progression ───────────────────────── */

export interface ProgressionSummary {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  xpToNext: number;
  /** 0..1 inside the current level. */
  fraction: number;
  releases: { current: number; best: number };
  slaDays: { current: number; best: number };
  reviewDays: { current: number; best: number };
  badgesEarned: number;
  badgesTotal: number;
}

export function progressionSummary(report: GamificationReport): ProgressionSummary {
  const { level, xpIntoLevel, xpForLevel } = report.level;
  return {
    level,
    xp: report.xp,
    xpIntoLevel,
    xpForLevel,
    xpToNext: Math.max(0, xpForLevel - xpIntoLevel),
    fraction: Math.min(1, Math.max(0, xpIntoLevel / xpForLevel)),
    releases: report.streaks.releases,
    slaDays: report.streaks.slaDays,
    reviewDays: report.streaks.reviewDays ?? { current: 0, best: 0 },
    badgesEarned: report.badges.filter((b) => b.count > 0).length,
    badgesTotal: report.badges.length,
  };
}
