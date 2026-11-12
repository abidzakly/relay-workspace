import { describe, expect, it } from 'vitest';
import { aimAt, observatoryPoses } from '../environment/placement';
import {
  HOME_LAYOUT,
  HOME_SHIP,
  OBSERVATORY,
  TELESCOPE_PIVOT,
  homeGround,
} from '../environments/home/homeLayout';
import type { Pose } from '../layout';
import { GATEWAYS, OBJECTS, pickInfo, viaOf } from '../registry';
import { CAMERA_MS, planFlight, planMs, sampleFlight } from './cameraMachine';
import { RING_SEGMENTS, shipLook } from './shipModel';

const obs = HOME_LAYOUT.observatory!;
const world = HOME_LAYOUT.world;
const states = (p: ReturnType<typeof planFlight>) => p.segments.map((s) => s.state);

describe('the way into Overview', () => {
  it('goes through the observatory: approach, align with the telescope, travel to the ship', () => {
    const plan = planFlight(HOME_LAYOUT, world, 'plant', false, {
      from: 'world',
      via: 'observatory',
    });
    expect(states(plan)).toEqual(['observatory-approach', 'observatory-approach', 'ship-approach']);
    expect(plan.segments.map((s) => s.to)).toEqual([obs.approach, obs.align, obs.ship]);
    expect(plan.arrive).toBe('overview');
    expect(planMs(plan)).toBe(CAMERA_MS.observatory + CAMERA_MS.align + CAMERA_MS.ship);
    const end = sampleFlight(world, plan, planMs(plan) + 1);
    expect(end).toEqual({ pose: obs.ship, state: 'overview', done: true });
  });
  it('from the Overview object (or the menu), frames it and then lifts to the ship', () => {
    const plan = planFlight(HOME_LAYOUT, world, 'plant', false, { from: 'world' });
    expect(states(plan)).toEqual(['object-focus', 'ship-approach']);
    expect(plan.segments[0]!.to).toEqual(HOME_LAYOUT.focus.plant);
  });
  it('lands at the ship at once on a direct link or reduced motion', () => {
    const plan = planFlight(HOME_LAYOUT, world, 'plant', true, { via: 'observatory' });
    expect(planMs(plan)).toBe(0);
    expect(sampleFlight(world, plan, 0)).toMatchObject({
      pose: obs.ship,
      state: 'overview',
      done: true,
    });
  });
  it('returns past the observatory to the wide shot when Overview closes', () => {
    const plan = planFlight(HOME_LAYOUT, world, null, false, { from: 'overview' });
    expect(states(plan)).toEqual(['returning', 'returning']);
    expect(plan.segments.map((s) => s.to)).toEqual([obs.align, world]);
    expect(plan.arrive).toBe('world');
  });
  it('passes the observatory too when leaving Overview for another object', () => {
    const plan = planFlight(HOME_LAYOUT, world, 'kpi', false, { from: 'overview' });
    expect(states(plan)).toEqual(['returning', 'object-focus']);
  });
  it('stays put when Overview is asked for while already there', () => {
    const plan = planFlight(HOME_LAYOUT, world, 'plant', false, { from: 'overview' });
    expect(plan.segments).toEqual([]);
    expect(sampleFlight(obs.ship, plan, 0)).toEqual({
      pose: obs.ship,
      state: 'overview',
      done: true,
    });
  });
});

describe('observatory poses', () => {
  const dist = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  it('aligns behind the telescope and looks along it at the ship', () => {
    const p = observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: HOME_SHIP, world });
    const toShip = HOME_SHIP.map((v, i) => v - p.align.pos[i]!);
    const toLook = p.align.look.map((v, i) => v - p.align.pos[i]!);
    const cos =
      (toShip[0]! * toLook[0]! + toShip[1]! * toLook[1]! + toShip[2]! * toLook[2]!) /
      (Math.hypot(...toShip) * Math.hypot(...toLook));
    expect(cos).toBeGreaterThan(0.99);
  });
  it('stops the last leg close to the ship, looking at it', () => {
    const p = observatoryPoses({ pivot: TELESCOPE_PIVOT, ship: HOME_SHIP, world, shipDist: 30 });
    expect(dist(p.ship.pos, HOME_SHIP)).toBeCloseTo(30);
    expect(p.ship.look).toEqual(HOME_SHIP);
  });
  it('approaches from above the hill, never inside it', () => {
    const [x, y, z] = obs.approach.pos;
    expect(y).toBeGreaterThan(homeGround(x, z) + 1);
    expect(obs.place.pos[1]).toBe(OBSERVATORY.y);
  });
  it('aims the telescope upwards at the ship', () => {
    const a = aimAt(TELESCOPE_PIVOT, HOME_SHIP);
    expect(a.pitch).toBeGreaterThan(0);
    // The ship hangs far behind the village (-z): the telescope looks that way.
    expect(Math.cos(a.yaw)).toBeLessThan(0);
  });
});

describe('the observatory gateway', () => {
  it('opens Overview by the cinematic way and shows its signal, without being a dashboard object', () => {
    expect(GATEWAYS.map((g) => g.id)).toEqual(['observatory']);
    expect(OBJECTS.map((o) => o.id)).not.toContain('observatory');
    expect(pickInfo('observatory')).toMatchObject({
      route: '/overview',
      signalOf: 'plant',
      state: { via: 'observatory' },
    });
    expect(pickInfo('plant')).toMatchObject({ route: '/overview', signalOf: 'plant' });
    expect(pickInfo('plant').state).toBeUndefined();
  });
  it('reads the way in from route state only', () => {
    expect(viaOf({ via: 'observatory' })).toBe('observatory');
    expect(viaOf({ via: 'elsewhere' })).toBeNull();
    expect(viaOf(null)).toBeNull();
  });
});

describe('distant ship', () => {
  it('assembles its ring with progress, on CoreStage thresholds', () => {
    expect(shipLook(null).segments.every((s) => s === 0)).toBe(true);
    const half = shipLook(45);
    expect(half.segments.filter((s) => s === 1).length).toBe(RING_SEGMENTS / 2);
    expect(shipLook(90).segments.every((s) => s === 1)).toBe(true);
  });
  it('lights windows and engines for the finale and the complete ring', () => {
    expect(shipLook(50).windows).toBeLessThan(shipLook(98).windows);
    expect(shipLook(98).engines).toBeGreaterThan(shipLook(80).engines);
    expect(shipLook(100)).toMatchObject({ stage: 'complete', windows: 1, engines: 1 });
  });
  it('spins faster as progress rises', () => {
    expect(shipLook(90).spin).toBeGreaterThan(shipLook(10).spin);
  });
});

describe('poses stay finite', () => {
  it('has no NaN anywhere in the home observatory poses', () => {
    const all: Pose[] = [obs.approach, obs.align, obs.ship];
    for (const p of all)
      for (const v of [...p.pos, ...p.look, p.fov]) expect(Number.isFinite(v)).toBe(true);
  });
});
