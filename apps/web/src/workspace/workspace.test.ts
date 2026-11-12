import { describe, expect, it } from 'vitest';
import type { SyncSourceStatus } from '@relay/shared';
import { isStowed } from './envFor';
import { ENVIRONMENTS } from './environment/config';
import { HOME_LAYOUT } from './environments/home/homeLayout';
import { clampOrbit, easeInOutCubic, lerpPose, ORBIT_HOME, orbitPose } from './layout';
import { isPagePath, OBJECTS, objectForPath } from './registry';
import { buildSceneData, dartScores, syncTone, type SignalInput } from './signals';

const WIDE = HOME_LAYOUT.world;
const FOCUS = HOME_LAYOUT.focus;
const LIMITS = HOME_LAYOUT.orbit;

describe('isStowed', () => {
  it('stows the work only on off-duty days', () => {
    expect(isStowed('sick')).toBe(true);
    expect(isStowed('leave')).toBe(true);
    expect(isStowed('home')).toBe(false);
    expect(isStowed('office')).toBe(false);
  });
});

describe('registry', () => {
  it('finds the object of a route and its sub-routes', () => {
    expect(objectForPath('/')).toBeNull();
    expect(objectForPath('/mrs')).toBe('monitor');
    expect(objectForPath('/mrs/group%2Frepo/12')).toBe('monitor');
    expect(objectForPath('/board/')).toBe('notes');
    expect(objectForPath('/overview')).toBe('plant');
    expect(objectForPath('/mrsx')).toBeNull();
    expect(objectForPath('/review')).toBe('review');
    expect(objectForPath('/review/group%2Frepo/mr/12')).toBe('review');
    expect(objectForPath('/review/group%2Frepo/compare')).toBe('review');
  });
  it('keeps the original eleven tabs and adds the Code Review gateway beside them', () => {
    const routes = OBJECTS.map((o) => o.route);
    for (const r of [
      '/mrs',
      '/board',
      '/kpi',
      '/overview',
      '/sync',
      '/release',
      '/sprints',
      '/builds',
      '/settings',
      '/audit',
    ])
      expect(routes).toContain(r);
    expect(routes).toContain('/review');
    expect(OBJECTS).toHaveLength(12);
  });
  it('treats every path but / as a page', () => {
    expect(isPagePath('/')).toBe(false);
    expect(isPagePath('')).toBe(false);
    expect(isPagePath('/kpi')).toBe(true);
  });
  it('has one object per route, each with a focus pose in every world', () => {
    const routes = OBJECTS.map((o) => o.route);
    expect(new Set(routes).size).toBe(routes.length);
    for (const env of Object.values(ENVIRONMENTS))
      for (const o of OBJECTS) expect(env.layout.focus[o.id], `${env.id}/${o.id}`).toBeDefined();
  });
});

describe('camera', () => {
  it('eases from 0 to 1 symmetrically', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75));
  });
  it('interpolates position, look-at and fov', () => {
    const to = FOCUS.monitor;
    expect(lerpPose(WIDE, to, 0)).toEqual(WIDE);
    expect(lerpPose(WIDE, to, 1)).toEqual({
      pos: [...to.pos],
      look: [...to.look],
      fov: to.fov,
    });
    expect(lerpPose(WIDE, to, 0.5).fov).toBeCloseTo((WIDE.fov + to.fov) / 2);
  });
});

const source = (state: SyncSourceStatus['state'], name = 'gitlab'): SyncSourceStatus => ({
  source: name,
  state,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastDurationMs: null,
  consecutiveFailures: 0,
  error: null,
  warnings: [],
  rateLimit: null,
});

const base: SignalInput = {
  loading: false,
  mrTitles: [],
  mrsWaiting: 0,
  reviewTitles: [],
  reviewKeys: [],
  offDuty: false,
  pipelinesFailed: 0,
  mismatches: 0,
  slaRisks: 0,
  awaitingRelease: 0,
  columns: [
    {
      name: 'In Progress',
      count: 2,
      notes: [
        { id: 'a', title: 'Login screen' },
        { id: 'b', title: 'Push opt-in' },
      ],
    },
    { name: 'Issues', count: 0, notes: [] },
  ],
  completion: { rate: 0.5, target: 0.8 },
  slaHitRate: 0.9,
  bugs: { ratio: 0.1, max: 0.2, total: 10 },
  research: { count: 1, required: 2 },
  progress: 60,
  sources: [source('ok')],
  syncRunning: false,
  buildRunning: false,
  buildsQueued: 0,
  sprint: null,
  undoable: 0,
};

describe('signals', () => {
  it('rates sync from its sources and mismatches', () => {
    expect(syncTone([], 0)).toBe('idle');
    expect(syncTone([source('ok')], 0)).toBe('ok');
    expect(syncTone([source('ok')], 2)).toBe('warn');
    expect(syncTone([source('partial')], 0)).toBe('warn');
    expect(syncTone([source('ok'), source('error', 'notion')], 0)).toBe('bad');
  });
  it('puts a badge on the laptop for waiting MRs, red for a failed pipeline', () => {
    const calm = buildSceneData(base).signals.monitor;
    expect(calm.badge).toBeNull();
    expect(calm.summary).toBe('No MR is waiting on you.');
    const busy = buildSceneData({ ...base, mrsWaiting: 2, pipelinesFailed: 1 }).signals.monitor;
    expect(busy.badge).toBe(3);
    expect(busy.tone).toBe('bad');
    expect(busy.summary).toBe('2 MRs waiting on you, 1 failed pipeline.');
  });
  it('lights the review tablet for reviews requested of me, quietly when off duty', () => {
    const calm = buildSceneData(base);
    expect(calm.signals.review.badge).toBeNull();
    expect(calm.signals.review.tone).toBe('ok');
    expect(calm.reviews).toEqual({ titles: [], count: 0, keys: [] });
    const asked = buildSceneData({
      ...base,
      reviewTitles: ['a', 'b', 'c', 'd'],
      reviewKeys: ['r#1', 'r#2', 'r#3', 'r#4'],
    });
    expect(asked.signals.review.badge).toBe(4);
    expect(asked.signals.review.tone).toBe('warn');
    expect(asked.signals.review.summary).toBe('4 reviews requested of you.');
    expect(asked.reviews).toEqual({
      titles: ['a', 'b', 'c'],
      count: 4,
      keys: ['r#1', 'r#2', 'r#3', 'r#4'],
    });
    const resting = buildSceneData({ ...base, reviewTitles: ['a'], offDuty: true }).signals.review;
    expect(resting.tone).toBe('idle');
    expect(resting.summary).toBe('1 review requested of you, for when you are back.');
  });
  it('counts board cards and flags Issues', () => {
    const d = buildSceneData({
      ...base,
      columns: [
        ...base.columns.slice(0, 1),
        { name: 'Issues', count: 1, notes: [{ id: 'c', title: 'Crash on resume' }] },
      ],
    });
    expect(d.signals.notes.badge).toBe(1);
    expect(d.signals.notes.tone).toBe('bad');
    expect(d.signals.notes.summary).toBe('3 cards this month, 1 in Issues.');
  });
  it('caps the train at six wagons and fills the sail by sealed hours', () => {
    const d = buildSceneData({
      ...base,
      awaitingRelease: 9,
      sprint: { name: 'S1', done: 30, load: 40 },
    });
    expect(d.wagons).toBe(6);
    expect(d.sprintFill).toBeCloseTo(0.75);
    expect(
      buildSceneData({ ...base, sprint: { name: 'S1', done: 1, load: 0 } }).sprintFill,
    ).toBeNull();
  });
  it('says loading while the first data arrives', () => {
    expect(buildSceneData({ ...base, loading: true }).signals.kpi.summary).toBe('Loading…');
  });
});

describe('orbit', () => {
  const dist = (p: { pos: readonly number[]; look: readonly number[] }) =>
    Math.hypot(p.pos[0]! - p.look[0]!, p.pos[1]! - p.look[1]!, p.pos[2]! - p.look[2]!);

  it('leaves the pose alone at home', () => {
    const p = orbitPose(WIDE, ORBIT_HOME, LIMITS);
    p.pos.forEach((v, i) => expect(v).toBeCloseTo(WIDE.pos[i]!));
    expect(p.look).toEqual(WIDE.look);
  });
  it('turns on a sphere around the look-at point and zooms along it', () => {
    const turned = orbitPose(WIDE, { yaw: 0.5, pitch: 0, zoom: 1 }, LIMITS);
    expect(dist(turned)).toBeCloseTo(dist(WIDE));
    expect(turned.pos[1]).toBeCloseTo(WIDE.pos[1]);
    expect(dist(orbitPose(WIDE, { yaw: 0, pitch: 0, zoom: 0.5 }, LIMITS))).toBeCloseTo(
      dist(WIDE) * 0.5,
    );
  });
  it('stays within the world limits: never below the look-at point, never too far', () => {
    const o = clampOrbit(WIDE, { yaw: 9, pitch: -9, zoom: 99 }, LIMITS);
    expect(o.yaw).toBe(LIMITS.yaw[1]);
    expect(o.zoom).toBe(LIMITS.zoom[1]);
    const p = orbitPose(WIDE, o, LIMITS);
    expect(p.pos[1]).toBeGreaterThan(WIDE.look[1]);
  });
});

describe('darts', () => {
  const score = (over: Partial<SignalInput>) =>
    Object.fromEntries(dartScores({ ...base, ...over }).map((d) => [d.id, d.score]));

  it('scores each KPI against its own target', () => {
    expect(score({})).toEqual({ completion: 0.625, sla: 0.9, bugs: 1, research: 0.5 });
  });
  it('caps at the bullseye once a target is met', () => {
    const s = score({
      completion: { rate: 0.95, target: 0.8 },
      research: { count: 3, required: 2 },
    });
    expect(s.completion).toBe(1);
    expect(s.research).toBe(1);
    expect(score({ research: { count: 0, required: 0 } }).research).toBe(1);
  });
  it('falls off once bugs pass their limit', () => {
    expect(score({ bugs: { ratio: 0.4, max: 0.2, total: 10 } }).bugs).toBeCloseTo(0.5);
    expect(score({ bugs: { ratio: 0.1, max: 0, total: 10 } }).bugs).toBe(0);
  });
  it('keeps a dart in its cup while there is nothing to measure', () => {
    const s = score({
      completion: { rate: null, target: 0.8 },
      slaHitRate: null,
      bugs: { ratio: 0, max: 0.2, total: 0 },
      research: null,
    });
    expect(s).toEqual({ completion: null, sla: null, bugs: null, research: null });
  });
  it('reads every dart in the tooltip', () => {
    expect(buildSceneData(base).signals.kpi.summary).toBe(
      'Completion 50% · SLA 90% · Bugs within limit · Research 1/2.',
    );
  });
});
