import { describe, expect, it } from 'vitest';
import type { GamificationReport, KpiScorecard } from '@relay/shared';
import type { ProgressModel } from '@/core3d/progressMapping';
import { actionCenter, groupTone, kpiItems, progressionSummary, releaseSummary } from './model';
import type { ActionGroup, ActionRow } from './needsActionModel';
import { calmTone, toneOfGauge } from './tone';

const ref = (n: number) => ({ cardId: `c${n}`, title: `Card ${n}` });

function progress(over: Partial<ProgressModel> = {}): ProgressModel {
  return {
    scope: 'cycle',
    segments: [],
    percent: null,
    gap: 'no_cards',
    coreFill: 0,
    dust: [],
    cracks: [],
    uncounted: 0,
    undetermined: [],
    unknownRepos: [],
    ...over,
  };
}

const segments = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ...ref(i), stage: 2 })) as ProgressModel['segments'];

describe('releaseSummary', () => {
  it('reads the CoreStage model and rounds down', () => {
    const s = releaseSummary(
      progress({
        percent: 99.9,
        gap: null,
        segments: segments(17),
        uncounted: 891,
        dust: [ref(1)],
      }),
    );
    expect(s.percentText).toBe('99%');
    expect(s.factsText).toBe('17 cards · 891 outside the flow · 1 in Backlog');
    expect(s.facts.map((f) => [f.key, f.value])).toEqual([
      ['cards', 17],
      ['issues', 0],
      ['outside', 891],
      ['backlog', 1],
    ]);
    expect(s.tone).toBe('info');
    expect(s.scopeLabel).toBe('Current cycle');
  });

  it('shows no data, not 0%, when nothing can be counted', () => {
    const s = releaseSummary(progress());
    expect(s.percent).toBeNull();
    expect(s.percentText).toBe('—');
    expect(s.tone).toBe('nodata');
    expect(s.gapText).toMatch(/No cards/);
  });

  it('marks a partial percent', () => {
    const s = releaseSummary(
      progress({
        percent: 50,
        gap: null,
        segments: segments(2),
        unknownRepos: [{ repoId: 'r', reason: 'stale' }] as ProgressModel['unknownRepos'],
      }),
    );
    expect(s.partial).toBe(true);
    expect(s.tone).toBe('warn');
  });
});

const row = (key: string, severity?: ActionRow['severity']): ActionRow => ({
  key,
  title: key,
  detail: '',
  to: '/x',
  ...(severity ? { severity } : {}),
});
const group = (id: ActionGroup['id'], rows: ActionRow[]): ActionGroup => ({
  id,
  title: id,
  to: `/${id}`,
  rows,
});

describe('actionCenter', () => {
  it('keeps the source order, drops empty groups, and counts every row', () => {
    const ac = actionCenter(
      [
        group('mismatches', [
          row('a', 'warn'),
          row('b', 'warn'),
          row('c', 'warn'),
          row('d', 'warn'),
        ]),
        group('mrs', []),
        group('release', [row('r')]),
      ],
      3,
    );
    expect(ac.categories.map((c) => c.id)).toEqual(['mismatches', 'release']);
    expect(ac.total).toBe(5);
    expect(ac.categories[0]!.preview).toHaveLength(3);
    expect(ac.categories[0]!.more).toBe(1);
    expect(ac.tone).toBe('warn');
  });

  it('takes tone from the server severity, never from titles', () => {
    expect(groupTone(group('mismatches', [row('critical-looking title', 'warn')]))).toBe('warn');
    expect(groupTone(group('mismatches', [row('x', 'critical')]))).toBe('bad');
    expect(groupTone(group('sla', [row('x', 'critical')]))).toBe('bad');
    expect(groupTone(group('pipelines', [row('x')]))).toBe('bad');
    expect(groupTone(group('release', [row('x')]))).toBe('info');
  });

  it('is calm when nothing needs you', () => {
    const ac = actionCenter([group('mrs', [])]);
    expect(ac.categories).toEqual([]);
    expect(ac.tone).toBe('good');
  });
});

const scorecard = (over: Partial<KpiScorecard> = {}): KpiScorecard =>
  ({
    completion: { completed: 9, total: 10, rate: 0.9, target: 0.9, met: true, needed: 0 },
    bugRatio: { bugs: 0, total: 0, ratio: 0, max: 0.3, overLimit: false, nonBugCardsToRecover: 0 },
    sla: {
      overall: {
        met: 0,
        breached: 0,
        inFlight: 2,
        hitRate: null,
        avgResolutionMs: null,
        avgResolutionLabel: null,
      },
      byType: [],
    },
    research: { count: 1, required: 2, remaining: 1, state: 'in_progress', reminderDue: false },
    ...over,
  }) as unknown as KpiScorecard;

describe('kpiItems', () => {
  it('keeps the four KPIs in order with distinct no-data states', () => {
    const items = kpiItems(scorecard());
    expect(items.map((i) => i.key)).toEqual(['completion', 'bug', 'sla', 'research']);
    expect(items.map((i) => i.tone)).toEqual(['good', 'nodata', 'nodata', 'info']);
    // No data is not zero.
    expect(items[1]!.gauge.valueText).toBe('—');
    expect(items[2]!.gauge.valueText).toBe('—');
  });

  it('shows a real 0% as a value, not as no data', () => {
    const items = kpiItems(
      scorecard({
        bugRatio: {
          bugs: 0,
          total: 4,
          ratio: 0,
          max: 0.3,
          overLimit: false,
          nonBugCardsToRecover: 0,
        } as unknown as KpiScorecard['bugRatio'],
      }),
    );
    expect(items[1]!.tone).toBe('good');
    expect(items[1]!.gauge.valueText).toBe('0%');
  });
});

describe('tones', () => {
  it('maps gauges and calms urgency off duty without hiding it', () => {
    expect(toneOfGauge('critical', true)).toBe('bad');
    expect(toneOfGauge('critical', false)).toBe('nodata');
    expect(toneOfGauge('neutral', true)).toBe('info');
    expect(calmTone('bad', true)).toBe('warn');
    expect(calmTone('bad', false)).toBe('bad');
    expect(calmTone('info', true)).toBe('info');
  });
});

describe('progressionSummary', () => {
  it('summarises level, XP and earned badges', () => {
    const p = progressionSummary({
      xp: 1250,
      level: { level: 4, xpIntoLevel: 250, xpForLevel: 1000 },
      streaks: { releases: { current: 2, best: 5 }, slaDays: { current: 0, best: 3 } },
      badges: [
        { id: 'bug_slayer', count: 1, lastEarnedAt: 1 },
        { id: 'first_try', count: 0, lastEarnedAt: null },
      ],
      releases: [],
    } as unknown as GamificationReport);
    expect(p.xpToNext).toBe(750);
    expect(p.fraction).toBe(0.25);
    expect(p.badgesEarned).toBe(1);
    expect(p.badgesTotal).toBe(2);
  });
});
