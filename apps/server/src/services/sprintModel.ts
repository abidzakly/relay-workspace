import {
  domainResolver,
  pointEffort,
  statusGroupTest,
  type DockStage,
  type GlobalConfig,
  type MrDerivedState,
  type RepoConfigStored,
  type Sprint,
  type SprintMr,
  type SprintSubTask,
  type SprintTask,
  type SprintsResponse,
} from '@relay/shared';
import { eq } from 'drizzle-orm';
import type { AppDb } from '../db';
import { cards, links, mrs } from '../db/schema';
import { loadMrStates } from './linkStore';
import { rowToMr } from './healthReport';
import { mrKey } from './syncHealthEngine';
import { isVersionMr } from './versionMr';

/** Sprint Harbor data (`GET /api/sprints`). Cache only, never calls Notion or GitLab. */

type CardRow = typeof cards.$inferSelect;
const nid = (id: string) => id.replace(/-/g, '').toLowerCase();
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Natural order ("Sprint 9" < "Sprint 24"). */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function dockStage(
  status: string | null,
  cfg: Pick<GlobalConfig['notion'], 'statusGroups' | 'readyStatus'>,
): DockStage {
  const g = statusGroupTest(cfg.statusGroups);
  if (status !== null && (norm(status) === norm(cfg.readyStatus) || g.isDone(status)))
    return 'sealed';
  if (g.isComplete(status)) return 'deck';
  if (status === null || g.isUncommitted(status) || /next up|backlog|to ?do|draft/i.test(status)) {
    return 'quay';
  }
  return 'crane';
}

const isBlocked = (status: string | null) =>
  status !== null && /block|hold/i.test(status) && !/hold test/i.test(status);

export function buildSprints(
  app: AppDb,
  repos: readonly Pick<
    RepoConfigStored,
    'id' | 'name' | 'productDomains' | 'reviewers' | 'versionBranchPrefix'
  >[],
  global: Pick<GlobalConfig, 'notion' | 'sprint'>,
  now: number,
): SprintsResponse {
  const domainOf = domainResolver(repos);
  const repoName = new Map(repos.map((r) => [r.id, r.name] as const));
  const cfg = global.notion;

  const all = app.db.select().from(cards).where(eq(cards.archived, false)).all();
  const byId = new Map(all.map((c) => [nid(c.id), c] as const));
  const mine = all.filter((c) => c.assignedToMe || c.assignedAtManual !== null);

  // MRs per card (version MRs never belong to a card).
  const states = loadMrStates(app, repos);
  const prefix = new Map(repos.map((r) => [r.id, r.versionBranchPrefix] as const));
  const mrBy = new Map(
    app.db
      .select()
      .from(mrs)
      .all()
      .map((row) => [mrKey(row.repoId, row.iid), rowToMr(row)] as const),
  );
  const mrsOfCard = new Map<string, SprintMr[]>();
  for (const l of app.db.select().from(links).all()) {
    const m = mrBy.get(mrKey(l.repoId, l.mrIid));
    if (!m) continue;
    const p = prefix.get(m.repoId);
    if (p !== undefined && isVersionMr(m, p)) continue;
    const entry: SprintMr = {
      repoId: m.repoId,
      iid: m.iid,
      title: m.title,
      state: (states.get(mrKey(m.repoId, m.iid)) ?? 'open') as MrDerivedState,
      webUrl: m.webUrl,
    };
    const list = mrsOfCard.get(nid(l.cardId));
    if (list) list.push(entry);
    else mrsOfCard.set(nid(l.cardId), [entry]);
  }

  // Children known from their own Parent relation.
  const childrenOf = new Map<string, CardRow[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const list = childrenOf.get(nid(c.parentId));
    if (list) list.push(c);
    else childrenOf.set(nid(c.parentId), [c]);
  }

  const subTask = (id: string): SprintSubTask => {
    const c = byId.get(nid(id));
    return c
      ? {
          id: c.id,
          title: c.title,
          status: c.status,
          stage: dockStage(c.status, cfg),
          url: c.url,
          point: c.point,
        }
      : {
          id,
          title: null,
          status: null,
          stage: null,
          url: `https://www.notion.so/${nid(id)}`,
          point: null,
        };
  };

  let skippedUnconnected = 0;
  let withoutSprint = 0;
  const projects = new Map<string, { name: string; repoId: string; repoName: string }>();
  const groups = new Map<string, SprintTask[]>();
  /** Newest card per sprint: sprint names are not reliably sortable ("SPRINT 8" vs "V.1 Sprint 24"). */
  const latest = new Map<string, number>();
  const nestedIds = new Set<string>();

  const candidates = mine.filter((c) => {
    const d = domainOf(c.productDomain);
    if (d.state !== 'connected') {
      if (c.sprint && d.state === 'unconnected') skippedUnconnected++;
      return false;
    }
    if (!c.sprint) {
      withoutSprint++;
      return false;
    }
    return true;
  });
  // A sub-task that is itself one of my sprint cards is drawn inside its parent, not twice.
  const candidateIds = new Set(candidates.map((c) => nid(c.id)));
  for (const c of candidates) {
    for (const s of c.subTaskIds) if (candidateIds.has(nid(s))) nestedIds.add(nid(s));
    for (const ch of childrenOf.get(nid(c.id)) ?? [])
      if (candidateIds.has(nid(ch.id))) nestedIds.add(nid(ch.id));
  }

  for (const c of candidates) {
    if (nestedIds.has(nid(c.id))) continue;
    const d = domainOf(c.productDomain);
    const project = c.productDomain!.trim();
    const cardMrs = mrsOfCard.get(nid(c.id)) ?? [];
    // A shared domain serves several repos: the card's own MR picks among them, else the first.
    const repoId = cardMrs.find((m) => d.repoIds.includes(m.repoId))?.repoId ?? d.repoId!;
    projects.set(norm(project), {
      name: project,
      repoId: d.repoId!,
      repoName: d.repoIds.map((id) => repoName.get(id) ?? id).join(', '),
    });
    const subIds = new Map<string, string>();
    for (const s of c.subTaskIds) subIds.set(nid(s), s);
    for (const ch of childrenOf.get(nid(c.id)) ?? []) subIds.set(nid(ch.id), ch.id);
    const task: SprintTask = {
      id: c.id,
      title: c.title,
      url: c.url,
      status: c.status,
      type: c.type,
      stage: dockStage(c.status, cfg),
      blocked: isBlocked(c.status),
      point: c.point,
      project,
      repoId,
      mrs: cardMrs.sort((a, b) => b.iid - a.iid),
      subTasks: [...subIds.values()].map(subTask),
    };
    const key = c.sprint!.trim();
    latest.set(key, Math.max(latest.get(key) ?? 0, c.notionCreatedAt ?? c.lastEditedAt));
    const list = groups.get(key);
    if (list) list.push(task);
    else groups.set(key, [task]);
  }

  const capacityHours = global.sprint.capacityHours;
  const sprints: Sprint[] = [...groups.entries()]
    .map(([name, tasks]) => {
      let loadHours = 0;
      let doneHours = 0;
      let research = 0;
      let unestimated = 0;
      const counts: Record<DockStage, number> = { quay: 0, crane: 0, deck: 0, sealed: 0 };
      const add = (point: number | null, stage: DockStage | null) => {
        const e = pointEffort(point);
        if (!e) unestimated++;
        else if (e.kind === 'research') research++;
        else {
          loadHours += e.hours;
          if (stage === 'sealed') doneHours += e.hours;
        }
      };
      for (const t of tasks) {
        counts[t.stage]++;
        add(t.point, t.stage);
        for (const s of t.subTasks) if (s.title !== null) add(s.point, s.stage);
      }
      const order: Record<DockStage, number> = { crane: 0, deck: 1, quay: 2, sealed: 3 };
      tasks.sort((a, b) => order[a.stage] - order[b.stage] || (b.point ?? 0) - (a.point ?? 0));
      return {
        name,
        projects: [...new Set(tasks.map((t) => t.project))].sort(),
        tasks,
        capacityHours,
        loadHours,
        doneHours,
        research,
        unestimated,
        counts,
        active: tasks.some((t) => t.stage !== 'sealed'),
      };
    })
    .sort(
      (a, b) =>
        (latest.get(b.name) ?? 0) - (latest.get(a.name) ?? 0) || natural.compare(b.name, a.name),
    );

  return {
    generatedAt: now,
    capacityHours,
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
    sprints,
    skippedUnconnected,
    withoutSprint,
  };
}
