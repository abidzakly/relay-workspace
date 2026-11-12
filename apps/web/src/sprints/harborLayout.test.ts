import { describe, expect, it } from 'vitest';
import type { DockStage, Sprint, SprintTask } from '@relay/shared';
import {
  HARBOR_ZONES,
  layoutHarbor,
  VIEW,
  widenBox,
  ZONE_COLUMNS,
  zoneBox,
  zoneCrates,
  type Box,
} from './harborLayout';

let n = 0;
function task(stage: DockStage, point: number | null = 2): SprintTask {
  n++;
  return {
    id: `t${n}`,
    title: `Task ${n}`,
    stage,
    point,
    subTasks: [],
    mrs: [],
    project: 'p',
  } as unknown as SprintTask;
}

function sprint(tasks: SprintTask[]): Sprint {
  return {
    name: 'S1',
    tasks,
    loadHours: 10,
    capacityHours: 40,
    doneHours: 0,
    active: true,
  } as unknown as Sprint;
}

const inside = (b: Box, x: number, y: number, w: number, h: number) =>
  x >= b.x && y >= b.y && x + w <= b.x + b.w && y + h <= b.y + b.h;

describe('zoneBox', () => {
  const tasks = [
    ...Array.from({ length: 9 }, () => task('quay', 3)),
    ...Array.from({ length: 5 }, () => task('crane')),
    ...Array.from({ length: 14 }, () => task('sealed', 1)),
    task('deck', 5),
  ];
  const s = sprint(tasks);
  const L = layoutHarbor(s, tasks);

  it.each(HARBOR_ZONES)('contains every crate of the %s, sub-task boxes included', (zone) => {
    const box = zoneBox(L, zone);
    const crates = zoneCrates(L, zone);
    expect(crates.length).toBeGreaterThan(0);
    for (const c of crates) expect(inside(box, c.x, c.y - 7, c.w, c.h + 7)).toBe(true);
  });

  it.each(HARBOR_ZONES)('stays inside the scene for the %s', (zone) => {
    const b = zoneBox(L, zone);
    expect(inside({ x: 0, y: 0, w: VIEW.w, h: VIEW.h }, b.x, b.y, b.w, b.h)).toBe(true);
  });

  it('falls back to a fixed box when a zone is empty', () => {
    const only = [task('quay')];
    const E = layoutHarbor(sprint(only), only);
    for (const zone of ['crane', 'ship'] as const) {
      const b = zoneBox(E, zone);
      expect(b.w).toBeGreaterThan(100);
      expect(b.h).toBeGreaterThan(100);
    }
  });
});

describe('ZONE_COLUMNS', () => {
  it('tiles the full width without gaps, left to right', () => {
    let x = 0;
    for (const z of HARBOR_ZONES) {
      expect(ZONE_COLUMNS[z].x0).toBe(x);
      x = ZONE_COLUMNS[z].x1;
    }
    expect(x).toBe(VIEW.w);
  });

  it('puts each zone’s crates in its own column', () => {
    const tasks = [
      task('quay', 8),
      task('crane'),
      task('crane'),
      task('crane'),
      task('crane'),
      task('deck', 8),
    ];
    const L = layoutHarbor(sprint(tasks), tasks);
    for (const z of HARBOR_ZONES) {
      for (const c of zoneCrates(L, z)) {
        const mid = c.x + c.w / 2;
        expect(mid).toBeGreaterThanOrEqual(ZONE_COLUMNS[z].x0);
        expect(mid).toBeLessThan(ZONE_COLUMNS[z].x1);
      }
    }
  });
});

describe('widenBox', () => {
  it('widens around the centre and stays inside the scene', () => {
    expect(widenBox({ x: 400, y: 0, w: 100, h: 50 }, 300)).toEqual({ x: 300, y: 0, w: 300, h: 50 });
    expect(widenBox({ x: 950, y: 0, w: 50, h: 50 }, 300).x).toBe(VIEW.w - 300);
    expect(widenBox({ x: 0, y: 0, w: 50, h: 50 }, 300).x).toBe(0);
  });

  it('leaves a wide enough box alone', () => {
    const b = { x: 10, y: 20, w: 400, h: 50 };
    expect(widenBox(b, 300)).toBe(b);
  });
});
