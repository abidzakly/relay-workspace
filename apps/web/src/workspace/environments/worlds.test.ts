import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../registry';
import { OBJECTS } from '../registry';
import type { EnvLayout } from '../layout';
import { HOME_GEO } from './home/homeLayout';
import { LEAVE_GEO } from './leave/leaveLayout';
import { OFFICE_GEO } from './office/officeLayout';
import { SICK_GEO } from './sick/sickLayout';
import { TRIP_GEO } from './trip/tripLayout';

/**
 * Every outdoor world obeys the same rules (2.0 §4.1, §14): all objects placed, apart, on land (boats on water),
 * turned towards the wide shot, framed from above the ground, and an observatory with its poses.
 */
interface Geo {
  layout: EnvLayout;
  ground: (x: number, z: number) => number;
  isWater: (x: number, z: number) => boolean;
  floating: readonly ObjectId[];
}

const WORLDS: Record<string, Geo> = {
  home: HOME_GEO,
  leave: LEAVE_GEO,
  trip: TRIP_GEO,
  office: OFFICE_GEO,
  sick: SICK_GEO,
};

describe.each(Object.entries(WORLDS))('%s world', (_name, geo) => {
  const place = geo.layout.place!;
  const ids = OBJECTS.map((o) => o.id);
  it('places and frames every object', () => {
    for (const id of ids) {
      expect(place[id], id).toBeDefined();
      expect(geo.layout.focus[id], id).toBeDefined();
      expect(geo.layout.hit?.[id], id).toBeDefined();
    }
  });
  it('keeps objects apart', () => {
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const pa = place[a]!.pos;
        const pb = place[b]!.pos;
        expect(Math.hypot(pa[0] - pb[0], pa[2] - pb[2]), `${a}/${b}`).toBeGreaterThan(1.2);
      }
  });
  it('stands objects on land and floats only boats', () => {
    for (const id of ids) {
      const [x, y, z] = place[id]!.pos;
      if (geo.floating.includes(id)) {
        expect(geo.isWater(x, z), id).toBe(true);
        continue;
      }
      expect(geo.isWater(x, z), id).toBe(false);
      expect(y, id).toBeGreaterThanOrEqual(geo.ground(x, z) - 1e-9);
    }
  });
  it('turns every object towards the wide shot', () => {
    const [cx, , cz] = geo.layout.world.pos;
    for (const id of ids) {
      const { pos, rotY } = place[id]!;
      expect(Math.sin(rotY) * (cx - pos[0]) + Math.cos(rotY) * (cz - pos[2]), id).toBeGreaterThan(
        0,
      );
    }
  });
  it('frames each close-up from above the ground', () => {
    for (const id of ids) {
      const f = geo.layout.focus[id];
      expect(f.pos[1], id).toBeGreaterThan(geo.ground(f.pos[0], f.pos[2]) + 0.3);
    }
  });
  it('has an observatory on land, with its way to the ship', () => {
    const obs = geo.layout.observatory!;
    expect(obs).toBeDefined();
    const [x, y, z] = obs.place.pos;
    expect(geo.isWater(x, z)).toBe(false);
    expect(y).toBeGreaterThanOrEqual(geo.ground(x, z) - 1e-9);
    for (const p of [obs.approach, obs.align, obs.ship])
      for (const v of [...p.pos, ...p.look, p.fov]) expect(Number.isFinite(v)).toBe(true);
    expect(obs.approach.pos[1]).toBeGreaterThan(
      geo.ground(obs.approach.pos[0], obs.approach.pos[2]),
    );
  });
});
