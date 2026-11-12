import type { AppDb } from '../db';
import { cards, links, mrs } from '../db/schema';

/**
 * Content fingerprints of the cache, used to tell which rows a sync run really changed
 * (the services report counts, not ids). `synced_at` is excluded: every sync bumps it.
 */
export interface CacheFingerprint {
  cards: Map<string, string>;
  /** key `"<repoId>#<iid>"` */
  mrs: Map<string, string>;
  links: Map<string, string>;
}

export const mrKey = (repoId: string, iid: number) => `${repoId}#${iid}`;

export function fingerprintCache(app: AppDb): CacheFingerprint {
  const c = new Map<string, string>();
  for (const { syncedAt: _s, ...rest } of app.db.select().from(cards).all()) {
    c.set(rest.id, JSON.stringify(rest));
  }
  const m = new Map<string, string>();
  for (const { syncedAt: _s, ...rest } of app.db.select().from(mrs).all()) {
    m.set(mrKey(rest.repoId, rest.iid), JSON.stringify(rest));
  }
  const l = new Map<string, string>();
  for (const { createdAt: _c, id: _i, ...rest } of app.db.select().from(links).all()) {
    l.set(`${rest.cardId}\u0000${rest.repoId}\u0000${rest.mrIid}`, JSON.stringify(rest));
  }
  return { cards: c, mrs: m, links: l };
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) out.push(k);
  for (const k of before.keys()) if (!after.has(k)) out.push(k);
  return out;
}

export interface CacheDiff {
  cardIds: string[];
  /** iids per repo, ascending. */
  mrs: Map<string, number[]>;
  links: number;
}

export function diffFingerprints(before: CacheFingerprint, after: CacheFingerprint): CacheDiff {
  const mrsByRepo = new Map<string, number[]>();
  for (const k of changedKeys(before.mrs, after.mrs)) {
    const at = k.lastIndexOf('#');
    const repoId = k.slice(0, at);
    const iid = Number(k.slice(at + 1));
    const list = mrsByRepo.get(repoId);
    if (list) list.push(iid);
    else mrsByRepo.set(repoId, [iid]);
  }
  for (const list of mrsByRepo.values()) list.sort((a, b) => a - b);
  return {
    cardIds: changedKeys(before.cards, after.cards),
    mrs: mrsByRepo,
    links: changedKeys(before.links, after.links).length,
  };
}
