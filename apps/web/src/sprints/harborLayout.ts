import { pointEffort, type DockStage, type Sprint, type SprintTask } from '@relay/shared';

/**
 * Pure geometry of the Sprint Atelier scene (SVG viewBox 1000 × 520). No React. The ids keep their old harbor names
 * (quay, crane, ship) so stored state and tests stay valid: quay = the quarry, crane = the cutting bench, ship = the vitrine.
 */

export const VIEW = { w: 1000, h: 520 } as const;
export const WATER_Y = 392;
export const ROW_H = 30;

export type CrateKind = 'crate' | 'box' | 'container' | 'long' | 'heavy' | 'research' | 'unknown';

export interface Crate {
  task: SprintTask;
  kind: CrateKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Seconds of animation offset, so neighbours do not move in lockstep. */
  phase: number;
}

/** Size follows the Point: the bigger the estimate, the bigger the box. */
export function crateFor(point: number | null): { kind: CrateKind; w: number } {
  const e = pointEffort(point);
  if (!e) return { kind: 'unknown', w: 40 };
  if (e.kind === 'research') return { kind: 'research', w: 46 };
  switch (e.hours) {
    case 1:
      return { kind: 'crate', w: 30 };
    case 2:
      return { kind: 'crate', w: 38 };
    case 4:
      return { kind: 'box', w: 52 };
    case 8:
      return { kind: 'container', w: 76 };
    default:
      return { kind: 'heavy', w: 118 };
  }
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
};

/** Shelf-packs crates bottom-up inside [x0, x1], starting at `floorY` and stacking upwards. */
function stack(
  tasks: readonly SprintTask[],
  x0: number,
  x1: number,
  floorY: number,
  gap = 4,
): Crate[] {
  const out: Crate[] = [];
  let x = x0;
  let row = 0;
  for (const t of tasks) {
    const { kind, w } = crateFor(t.point);
    if (x + w > x1 && x > x0) {
      row++;
      x = x0 + (row % 2) * 8; // brick offset
    }
    out.push({
      task: t,
      kind,
      x,
      y: floorY - (row + 1) * ROW_H,
      w,
      h: ROW_H - 4,
      phase: hash(t.id) * 4,
    });
    x += w + gap;
  }
  return out;
}

/** The vitrine (glass case): its floor, its top, and where 100% of capacity sits between them. */
export const VITRINE = { x0: 570, x1: 950, top: 170, floor: 404, full: 180 } as const;

export interface ShipModel {
  /** load / capacity (can exceed 1). */
  ratio: number;
  /** How high the fill line stands above the vitrine floor, px (100% = `VITRINE.full`; capped at the case's top). */
  sink: number;
  overloadedBy: number;
  /** Degrees: heavy pieces make the case lean a little. */
  list: number;
  /** The vitrine floor: cut crystals stack up from here. */
  deckY: number;
}

export function shipModel(
  sprint: Pick<Sprint, 'loadHours' | 'capacityHours'> & { tasks: readonly SprintTask[] },
): ShipModel {
  const ratio = sprint.capacityHours > 0 ? sprint.loadHours / sprint.capacityHours : 0;
  const sink = Math.min((VITRINE.floor - VITRINE.top) / VITRINE.full, ratio) * VITRINE.full;
  const heavy = sprint.tasks.filter((t) => crateFor(t.point).kind === 'heavy').length;
  return {
    ratio,
    sink,
    overloadedBy: Math.max(0, sprint.loadHours - sprint.capacityHours),
    list: Math.min(2, heavy * 0.6),
    deckY: VITRINE.floor,
  };
}

export interface HarborLayout {
  quay: Crate[];
  crane: Crate[];
  deck: Crate[];
  ship: ShipModel;
}

/** At most this many hang from the crane; the rest wait on its pallet. */
const MAX_HOOK = 3;

export function layoutHarbor(sprint: Sprint, tasks: readonly SprintTask[]): HarborLayout {
  const byStage = (s: DockStage) => tasks.filter((t) => t.stage === s);
  const ship = shipModel({ ...sprint, tasks });
  const quay = stack(byStage('quay'), 18, 300, 404);
  const working = byStage('crane');
  const hook: Crate[] = working.slice(0, MAX_HOOK).map((t, i) => {
    const { kind, w } = crateFor(t.point);
    return {
      task: t,
      kind,
      x: 400 + i * 4 - w / 2,
      y: 150 + i * (ROW_H + 6),
      w,
      h: ROW_H - 4,
      phase: hash(t.id) * 4,
    };
  });
  const pallet = stack(working.slice(MAX_HOOK), 346, 476, 398);
  // Sealed cargo sits low in the hold line, in-review cargo stacks on top of it.
  const deck = stack(
    [...byStage('sealed'), ...byStage('deck')],
    VITRINE.x0 + 12,
    VITRINE.x1 - 12,
    ship.deckY,
  );
  return { quay, crane: [...hook, ...pallet], deck, ship };
}

// ───────────── Magnify (phone portrait): the scene split into three tappable zones ─────────────

export type HarborZone = 'quay' | 'crane' | 'ship';
export const HARBOR_ZONES: readonly HarborZone[] = ['quay', 'crane', 'ship'];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Full-height columns of the scene, left to right, so a tap anywhere picks the nearest zone. The crane column holds
 * the mast (330–342), the hook (~400) and its pallet (330–470); the quay ends at 320 and the hull starts at 560.
 */
export const ZONE_COLUMNS: Record<HarborZone, { x0: number; x1: number }> = {
  quay: { x0: 0, x1: 322 },
  crane: { x0: 322, x1: 530 },
  ship: { x0: 530, x1: VIEW.w },
};

/** What the lens shows when a zone has no cargo: the bare quay, crane or ship. */
const EMPTY_BOX: Record<HarborZone, Box> = {
  quay: { x: 0, y: 334, w: 320, h: 110 },
  crane: { x: 322, y: 50, w: 190, h: 320 },
  ship: { x: 550, y: 160, w: 420, h: 280 },
};

/** Room around the crates: sub-task boxes ride 7 units above a crate, plus a margin so edges are not clipped. */
const PAD = 16;

export function zoneCrates(layout: HarborLayout, zone: HarborZone): Crate[] {
  return zone === 'quay' ? layout.quay : zone === 'crane' ? layout.crane : layout.deck;
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * The viewBox the magnifier crops to: every crate of the zone plus some context (the quay edge, the hook line, the
 * hull top), clamped to the scene. Crates are drawn unrotated in the lens (animations paused), so the box is exact.
 */
export function zoneBox(layout: HarborLayout, zone: HarborZone): Box {
  const crates = zoneCrates(layout, zone);
  if (crates.length === 0) return EMPTY_BOX[zone];
  let box: Box | null = null;
  for (const c of crates) {
    const b = { x: c.x - PAD, y: c.y - 7 - PAD, w: c.w + 2 * PAD, h: c.h + 7 + 2 * PAD };
    box = box ? union(box, b) : b;
  }
  const context: Record<HarborZone, Box> = {
    quay: { x: 0, y: 394, w: 160, h: 50 }, // the quarry floor + its label
    crane: { x: 392, y: 110, w: 16, h: 40 }, // a stretch of hook line above the hanging crates
    ship: { x: 560, y: layout.ship.deckY - 6, w: 400, h: 58 }, // the vitrine's floor and its plinth label
  };
  const b = union(box as Box, context[zone]);
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return { x, y, w: Math.min(VIEW.w, b.x + b.w) - x, h: Math.min(VIEW.h, b.y + b.h) - y };
}

/** `box` widened symmetrically to at least `w` units (for a narrow zone like the crane), kept inside the scene. */
export function widenBox(box: Box, w: number): Box {
  if (box.w >= w) return box;
  const width = Math.min(w, VIEW.w);
  const x = Math.min(Math.max(0, box.x - (width - box.w) / 2), VIEW.w - width);
  return { ...box, x, w: width };
}

/** Stable per-project hue, so a project's cargo is recognisable across sprints. */
export function projectHue(project: string): number {
  return Math.round(hash(project) * 360);
}
