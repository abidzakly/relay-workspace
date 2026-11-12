import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, layoutFor } from '../environment/config';
import { ENV_LABEL, type EnvId } from '../envFor';
import { HOME_LAYOUT } from '../environments/home/homeLayout';
import type { Pose } from '../layout';
import { OBJECTS, objectById } from '../registry';
import { CAMERA_MS, planFlight, planMs, sampleFlight } from './cameraMachine';

const ENVS = Object.keys(ENV_LABEL) as EnvId[];
const LAYOUT = HOME_LAYOUT;
const WIDE = HOME_LAYOUT.world;
const FOCUS = HOME_LAYOUT.focus;

describe('camera machine', () => {
  it('flies to an object in one eased leg and lands framed on it', () => {
    const plan = planFlight(LAYOUT, WIDE, 'monitor', false);
    expect(plan.id).toBe('monitor');
    expect(plan.segments).toHaveLength(1);
    expect(planMs(plan)).toBe(CAMERA_MS.objectFocus);
    const mid = sampleFlight(WIDE, plan, CAMERA_MS.objectFocus / 2);
    expect(mid.state).toBe('object-focus');
    expect(mid.done).toBe(false);
    const end = sampleFlight(WIDE, plan, CAMERA_MS.objectFocus + 1);
    expect(end).toEqual({ pose: FOCUS.monitor, state: 'object-focus', done: true });
  });
  it('approaches the Code Review gateway in its own state', () => {
    const plan = planFlight(LAYOUT, WIDE, 'review', false);
    expect(sampleFlight(WIDE, plan, 10).state).toBe('review-gateway-approach');
  });
  it('returns to the wide shot and settles in the world state', () => {
    const plan = planFlight(LAYOUT, WIDE, null, false);
    expect(sampleFlight(FOCUS.kpi, plan, 1).state).toBe('returning');
    expect(sampleFlight(FOCUS.kpi, plan, 10_000)).toEqual({
      pose: WIDE,
      state: 'world',
      done: true,
    });
  });
  it('lands at once when instant (deep link, first frame, reduced motion)', () => {
    const plan = planFlight(LAYOUT, WIDE, 'plant', true);
    expect(planMs(plan)).toBe(0);
    expect(sampleFlight(WIDE, plan, 0).done).toBe(true);
  });
  it('starts from wherever the camera is, so a reversal never snaps', () => {
    const somewhere: Pose = { pos: [1, 2, 3], look: [0, 1, -1], fov: 41 };
    const plan = planFlight(LAYOUT, WIDE, null, false);
    expect(sampleFlight(somewhere, plan, 0).pose).toEqual(somewhere);
  });
  it('eases through every leg of a multi-leg plan in order', () => {
    const a: Pose = { pos: [0, 0, 0], look: [0, 0, -1], fov: 40 };
    const b: Pose = { pos: [10, 0, 0], look: [10, 0, -1], fov: 40 };
    const c: Pose = { pos: [10, 10, 0], look: [10, 10, -1], fov: 30 };
    const plan = {
      id: null,
      arrive: 'overview' as const,
      segments: [
        { state: 'observatory-approach' as const, to: b, ms: 100 },
        { state: 'ship-approach' as const, to: c, ms: 100 },
      ],
    };
    expect(sampleFlight(a, plan, 50).state).toBe('observatory-approach');
    expect(sampleFlight(a, plan, 100).pose.pos).toEqual(b.pos);
    expect(sampleFlight(a, plan, 150).state).toBe('ship-approach');
    expect(sampleFlight(a, plan, 200)).toEqual({ pose: c, state: 'overview', done: true });
  });
});

describe('environments', () => {
  it('configures all five environments', () => {
    expect(Object.keys(ENVIRONMENTS).sort()).toEqual([...ENVS].sort());
  });
  it('places and frames every object in every environment', () => {
    for (const env of ENVS) {
      const layout = layoutFor(env);
      for (const { id } of OBJECTS) {
        expect(layout.anchors[id], `${env}/${id}`).toBeDefined();
        expect(layout.pivot[id], `${env}/${id}`).toBeDefined();
        expect(layout.focus[id], `${env}/${id}`).toBeDefined();
        expect(layout.tipLift[id], `${env}/${id}`).toBeTypeOf('number');
      }
    }
  });
  it('keeps the avatar resting on off-duty days', () => {
    expect(ENVIRONMENTS.sick.avatar.activity).toBe('sick');
    expect(ENVIRONMENTS.leave.avatar.activity).toBe('leave');
    for (const env of ['office', 'trip'] as const)
      expect(ENVIRONMENTS[env].avatar.activity).toBe('work');
    // Home works too, with a coffee break now and then (2.0 §8.1).
    expect(ENVIRONMENTS.home.avatar.activity).toBe('home');
  });
});

describe('destinations', () => {
  it('keeps the original tabs and Code Review as a destination beside them', () => {
    const tabs = OBJECTS.filter((o) => o.kind === 'tab').map((o) => o.destination);
    expect(tabs.sort()).toEqual(
      [
        'audit',
        'board',
        'builds',
        'kpi',
        'mrInbox',
        'overview',
        'releaseTrain',
        'settings',
        'sprintHarbor',
        'syncHealth',
      ].sort(),
    );
    expect(objectById('review')).toMatchObject({ kind: 'destination', destination: 'codeReview' });
    expect(new Set(OBJECTS.map((o) => o.destination)).size).toBe(OBJECTS.length);
  });
});
