import { describe, expect, it } from 'vitest';
import { qualityTier } from '../../environment/quality';
import { scatter } from '../../environment/scatter';
import { OBJECTS } from '../../registry';
import { HOME_SET, arrowSpot } from './HomeObjects';
import {
  HOME_LAYOUT,
  homeGround,
  OBSERVATORY_HILL,
  RIVER_HALF_WIDTH,
  riverZ,
  WATER_Y,
} from './homeLayout';

const place = HOME_LAYOUT.place!;

describe('home world layout', () => {
  it('places, frames and draws every object', () => {
    for (const { id } of OBJECTS) {
      expect(place[id], id).toBeDefined();
      expect(HOME_LAYOUT.focus[id], id).toBeDefined();
      expect(HOME_SET[id], id).toBeTypeOf('function');
    }
  });
  it('stands every object on the ground, the porch or the water', () => {
    for (const { id } of OBJECTS) {
      const [x, y, z] = place[id]!.pos;
      const g = homeGround(x, z);
      if (id === 'ship') expect(y).toBe(WATER_Y);
      else expect(y === g || y > g, id).toBe(true);
    }
  });
  it('keeps objects apart, and out of the river (except the boat)', () => {
    const ids = OBJECTS.map((o) => o.id);
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const pa = place[a]!.pos;
        const pb = place[b]!.pos;
        expect(Math.hypot(pa[0] - pb[0], pa[2] - pb[2]), `${a}/${b}`).toBeGreaterThan(1.2);
      }
    for (const id of ids) {
      if (id === 'ship') continue;
      const [x, , z] = place[id]!.pos;
      expect(Math.abs(z - riverZ(x)), id).toBeGreaterThan(RIVER_HALF_WIDTH);
    }
    const [bx, , bz] = place.ship!.pos;
    expect(Math.abs(bz - riverZ(bx))).toBeLessThan(0.5);
  });
  it('frames each close-up in front of its object, never inside it', () => {
    for (const { id } of OBJECTS) {
      const f = HOME_LAYOUT.focus[id];
      const a = HOME_LAYOUT.anchors[id];
      const d = Math.hypot(f.pos[0] - a[0], f.pos[1] - a[1], f.pos[2] - a[2]);
      expect(d, id).toBeGreaterThan(1.5);
      expect(f.pos[1], id).toBeGreaterThan(homeGround(f.pos[0], f.pos[2]));
    }
  });
  it('turns objects towards the wide shot (their fronts are seen)', () => {
    const [cx, , cz] = HOME_LAYOUT.world.pos;
    for (const { id } of OBJECTS) {
      const { pos, rotY } = place[id]!;
      const toCam = [cx - pos[0], cz - pos[2]];
      const front = [Math.sin(rotY), Math.cos(rotY)];
      expect(front[0]! * toCam[0]! + front[1]! * toCam[1]!, id).toBeGreaterThan(0);
    }
  });
  it('raises the observatory hill above the village', () => {
    expect(homeGround(OBSERVATORY_HILL.x, OBSERVATORY_HILL.z)).toBeGreaterThan(4);
    expect(homeGround(0, 0)).toBe(0);
  });
});

describe('scenery helpers', () => {
  it('scatters deterministically and honours keep-out zones', () => {
    const opts = {
      count: 40,
      seed: 5,
      rMin: 5,
      rMax: 20,
      ground: () => 0,
      keep: (x: number) => x > 0,
    };
    const a = scatter(opts);
    expect(scatter(opts)).toEqual(a);
    expect(a.every((p) => p.x > 0)).toBe(true);
    expect(
      a.every((p) => Math.hypot(p.x, p.z) >= 5 - 1e-9 && Math.hypot(p.x, p.z) <= 20 + 1e-9),
    ).toBe(true);
  });
  it('draws less scenery on smaller devices', () => {
    expect(qualityTier(true, true, 8)).toBe('low');
    expect(qualityTier(false, true, 8)).toBe('medium');
    expect(qualityTier(false, false, 4)).toBe('medium');
    expect(qualityTier(false, false, 12)).toBe('high');
  });
  it('lands an arrow in the gold for a met target, outside for a miss, none without data', () => {
    const dart = (score: number | null) => ({
      id: 'sla' as const,
      label: 'SLA',
      score,
      reading: '',
    });
    expect(arrowSpot(dart(1), 0, 0.75)).toEqual([0, 0]);
    const miss = arrowSpot(dart(0.2), 0, 0.75)!;
    expect(Math.hypot(...miss)).toBeCloseTo(0.8 * 0.75 * 0.92);
    expect(arrowSpot(dart(null), 0, 0.75)).toBeNull();
  });
});
