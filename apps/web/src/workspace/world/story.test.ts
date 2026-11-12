import { describe, expect, it } from 'vitest';
import { dayKey, WEATHER_FX, weatherFor, type Weather } from '../environment/weather';
import { ENV_LABEL, type EnvId } from '../envFor';
import {
  EVENT_COLOR,
  EVENT_STORY,
  eventStrength,
  reviewStartedSince,
  storyBeat,
  type WorldEventKind,
} from '../worldEvents';
import { celebrationStarts } from './useCelebration';

const ENVS = Object.keys(ENV_LABEL) as EnvId[];
const KINDS = Object.keys(EVENT_COLOR) as WorldEventKind[];

describe('weather', () => {
  it('is the same all day for a place, and changes between days', () => {
    expect(weatherFor('home', '2026-11-03')).toBe(weatherFor('home', '2026-11-03'));
    const days = Array.from(
      { length: 60 },
      (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`,
    );
    expect(new Set(days.map((d) => weatherFor('home', d))).size).toBeGreaterThan(2);
  });
  it('only picks what a place can have (no rain on the sky campus, mostly sun on leave)', () => {
    const days = Array.from({ length: 400 }, (_, i) => `d${i}`);
    const office = new Set(days.map((d) => weatherFor('office', d)));
    expect(office.has('rain')).toBe(false);
    expect(office.has('mist')).toBe(false);
    const leave = days.map((d) => weatherFor('leave', d));
    expect(leave.filter((w) => w === 'clear').length / leave.length).toBeGreaterThan(0.55);
  });
  it('has an effect for every kind, and rain only in rain', () => {
    for (const w of Object.keys(WEATHER_FX) as Weather[]) {
      expect(WEATHER_FX[w].fog[0]).toBeLessThan(WEATHER_FX[w].fog[1]);
      expect(WEATHER_FX[w].rain).toBe(w === 'rain');
    }
  });
  it('keys days locally', () => {
    expect(dayKey(new Date(2026, 10, 3, 23, 59).getTime())).toBe('2026-11-03');
  });
});

describe('release celebration', () => {
  it('starts when 100% is reached while watching, never on the first reading', () => {
    expect(celebrationStarts('ignition', 'complete')).toBe(true);
    expect(celebrationStarts('high', 'complete')).toBe(true);
    expect(celebrationStarts(null, 'complete')).toBe(false);
    expect(celebrationStarts('complete', 'complete')).toBe(false);
    expect(celebrationStarts('high', 'assembled')).toBe(false);
  });
});

describe('engineering events', () => {
  it('tells a review as started when a session was opened since the last look', () => {
    expect(reviewStartedSince([{ kind: 'mr', at: 200 }], 100)).toBe(true);
    expect(reviewStartedSince([{ kind: 'mr', at: 50 }], 100)).toBe(false);
    // a branch comparison is not a review of an MR
    expect(reviewStartedSince([{ kind: 'compare', at: 200 }], 100)).toBe(false);
  });
  it('maps every event the blueprint lists to a beat in every environment (3.0 §9.3)', () => {
    for (const env of ENVS)
      for (const k of [
        'review.requested',
        'review.started',
        'mr.comment',
        'mr.approval',
        'mr.merged',
      ] as const)
        expect(storyBeat(env, k), `${env}/${k}`).not.toBeNull();
    expect(storyBeat('home', 'mr.merged')).toBe('bell');
    expect(storyBeat('office', 'mr.approval')).toBe('reactor-pulse');
    expect(storyBeat('trip', 'mr.merged')).toBe('shuttle-depart');
    expect(storyBeat('leave', 'mr.merged')).toBe('sail-out');
    expect(Object.keys(EVENT_STORY).sort()).toEqual([...ENVS].sort());
  });
  it('keeps off-duty worlds quiet: only a merge, softly', () => {
    for (const env of ['sick', 'leave'] as const)
      for (const k of KINDS)
        expect(eventStrength(k, env), `${env}/${k}`).toBe(k === 'mr.merged' ? 0.35 : 0);
    expect(eventStrength('review.started', 'home')).toBe(1);
  });
});

describe('names of things', () => {
  it('names every object and the observatory in every environment, uniquely', async () => {
    const { THINGS } = await import('../objects/names');
    const { OBJECTS } = await import('../registry');
    for (const env of ENVS) {
      const names = [...OBJECTS.map((o) => THINGS[env][o.id]), THINGS[env].observatory];
      expect(
        names.every((n) => typeof n === 'string' && n.length > 0),
        env,
      ).toBe(true);
      expect(new Set(names).size, env).toBe(names.length);
    }
    expect(THINGS.office.plant).toBe('Energy reactor');
  });
});
