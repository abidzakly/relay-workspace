import { describe, expect, it } from 'vitest';
import type { Card } from '@relay/shared';
import { buildProgress } from './progressMapping';
import { pieceBuilt, progressFx } from './progressFx';
import { growthStep, shipStageFor } from './shipStage';

const card = (id: string, status: string | null): Card =>
  ({ id, title: `Card ${id}`, status, archived: false, lastEditedAt: 0 }) as unknown as Card;

const allTime = (cards: Card[]) =>
  buildProgress(
    {
      cards,
      mrs: [],
      links: [],
      releases: [],
      readyStatus: undefined,
      completeStatuses: undefined,
    },
    'all',
  );

describe('progress model', () => {
  it('averages the stages of counted cards', () => {
    const m = allTime([card('1', 'Next Up'), card('2', 'Complete'), card('3', 'Ready to Test')]);
    expect(m.percent).toBeCloseTo(((1 + 3 + 4) / 12) * 100);
    expect(m.gap).toBeNull();
    expect(m.coreFill).toBeCloseTo(1 / 3);
  });
  it('turns Backlog into dust and Issues into cracks, outside the sum', () => {
    const m = allTime([card('1', 'Backlog'), card('2', 'Issues'), card('3', 'Complete')]);
    expect(m.percent).toBe(75);
    expect(m.dust.map((d) => d.cardId)).toEqual(['1']);
    expect(m.cracks.map((d) => d.cardId)).toEqual(['2']);
  });
  it('reports a gap instead of 0%', () => {
    expect(allTime([]).gap).toBe('no_cards');
    expect(allTime([]).percent).toBeNull();
    expect(allTime([card('1', 'Backlog')]).gap).toBe('only_excluded');
  });
  it('skips archived cards', () => {
    const m = allTime([{ ...card('1', 'Next Up'), archived: true }, card('2', 'Complete')]);
    expect(m.percent).toBe(75);
  });
});

describe('progress effects', () => {
  it('assembles by 90%, spins faster with progress, plays the finale from 98%', () => {
    expect(progressFx(45).assembly).toBeCloseTo(0.5);
    expect(progressFx(90).assembly).toBe(1);
    expect(progressFx(0).spin).toBeCloseTo(0.12);
    expect(progressFx(100).spin).toBeCloseTo(1);
    expect(progressFx(97).finale).toBe(0);
    expect(progressFx(99).finale).toBeCloseTo(0.5);
    expect(progressFx(100).complete).toBe(true);
    expect(progressFx(null).p).toBe(0);
  });
  it('builds pieces one by one', () => {
    expect(pieceBuilt(0, 4, 0)).toBe(0);
    expect(pieceBuilt(0, 4, 0.25)).toBe(1);
    expect(pieceBuilt(1, 4, 0.375)).toBeCloseTo(0.5);
  });
});

describe('ship stage', () => {
  it('reads the same thresholds as CoreStage', () => {
    expect(shipStageFor(null)).toBe('unknown');
    expect(shipStageFor(10)).toBe('low');
    expect(shipStageFor(40)).toBe('medium');
    expect(shipStageFor(70)).toBe('high');
    expect(shipStageFor(90)).toBe('assembled');
    expect(shipStageFor(98)).toBe('ignition');
    expect(shipStageFor(99.9)).toBe('ignition');
    expect(shipStageFor(100)).toBe('complete');
  });
  it('grows living Overview objects in five steps, full once assembled', () => {
    expect(growthStep(null)).toBe(0);
    expect(growthStep(0)).toBe(0);
    expect(growthStep(30)).toBe(1);
    expect(growthStep(89)).toBe(3);
    expect(growthStep(90)).toBe(4);
    expect(growthStep(100)).toBe(4);
  });
});
