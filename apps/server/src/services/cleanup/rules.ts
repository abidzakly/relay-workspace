import type { CleanupCandidate } from '@relay/shared';
import type { TmpCleanupFacts, WsCleanupFacts, WsCleanupItem } from '../cockpit/wsCleanup';

/**
 * Storage cleanup rules. Pure and deterministic, with no AI: each candidate comes from one rule over facts the
 * dashboard already holds. A rule never sees file contents. Every rule has a grace period, and anything a rule is
 * unsure about is kept. The tiers:
 *  - safe: leftovers only the cockpit uses (attachments, checkpoint refs, temp files, caches). Auto-clean may take them.
 *  - confirm: things a person might still want (local branches, APKs, a whole clone). Only removed on a click.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const GRACE = {
  attachmentDone: 7 * DAY,
  attachmentUnknown: 30 * DAY,
  attachmentCeiling: 90 * DAY,
  checkpointAge: 14 * DAY,
  checkpointKeep: 5,
  preSquash: 7 * DAY,
  branchIdle: 3 * DAY,
  cloneBuild: 3 * DAY,
  apkKeep: 5,
  apkAge: 14 * DAY,
  evidenceDone: 30 * DAY,
  evidenceOrphan: 1 * DAY,
  figma: 7 * DAY,
  tmpLeftover: 1 * HOUR,
} as const;

/** Branches that are a base somewhere: never cleanup material, whatever git says. */
const PROTECTED_BRANCH = /^(main|master|develop|dev|staging|production|release)$/;

export type CleanupAction =
  | { on: 'ws'; workspaceId: string; base: string; item: WsCleanupItem }
  | { on: 'tmp'; name: string }
  | { on: 'fs'; root: string; rel: string }
  /** A bulk-start worktree: its folder and its workspace row. */
  | { on: 'worktree'; workspaceId: string };

export interface PlannedCandidate extends CleanupCandidate {
  action: CleanupAction;
}

// ───────────────────────────── facts ─────────────────────────────

export interface CardFact {
  status: string | null;
  archived: boolean;
  branchName: string | null;
}

export interface MrFact {
  iid: number;
  state: string;
}

export interface AttachmentRow {
  kind: string;
  refId: string;
  createdAt: number;
}

export interface WorkspaceFacts {
  ws: { id: string; name: string; repoId: string | null; base: string };
  facts: WsCleanupFacts;
}

export interface DbFacts {
  now: number;
  workspaceIds: ReadonlySet<string>;
  cards: ReadonlyMap<string, CardFact>;
  /** Newest MR per `<repoId>\t<sourceBranch>`. */
  mrByBranch: ReadonlyMap<string, MrFact>;
  /** `<repoId>!<iid>` → state. */
  mrState: ReadonlyMap<string, string>;
  /** Discussions whose resolvable notes are all resolved, as `<repoId>!<iid>#<discussionId>`. */
  resolvedThreads: ReadonlySet<string>;
  findings: ReadonlyMap<string, string>;
  /** Last pushed sha per `<repoId>\t<branch>` (webhook push events). */
  pushedSha: ReadonlyMap<string, string>;
  attachments: ReadonlyMap<string, AttachmentRow>;
}

export const isDoneCard = (c: CardFact | undefined): boolean =>
  !!c && (c.archived || /complete|done/i.test(c.status ?? ''));

const ago = (now: number, at: number) => {
  const d = Math.floor((now - at) / DAY);
  return d >= 1 ? `${d} d ago` : `${Math.max(1, Math.floor((now - at) / HOUR))} h ago`;
};

// ───────────────────────────── workspace rules ─────────────────────────────

export function workspaceCandidates(w: WorkspaceFacts, db: DbFacts): PlannedCandidate[] {
  const out: PlannedCandidate[] = [];
  const { ws, facts } = w;
  const now = db.now;
  const where = ws.name;
  const act = (item: WsCleanupItem): CleanupAction => ({
    on: 'ws',
    workspaceId: ws.id,
    base: ws.base,
    item,
  });
  const branches = new Map(facts.branches.map((b) => [b.name, b]));
  const mrOf = (branch: string) =>
    ws.repoId ? db.mrByBranch.get(`${ws.repoId}\t${branch}`) : undefined;

  // Rule 1: attachment folders.
  for (const a of facts.attachments) {
    const row = db.attachments.get(a.group);
    const age = now - Math.max(a.mtimeMs, row?.createdAt ?? 0);
    let reason: string | null = null;
    if (age >= GRACE.attachmentCeiling) {
      reason = `Untouched for ${ago(now, now - age)}, past the 90-day limit`;
    } else if (row) {
      if (age >= GRACE.attachmentDone) reason = attachmentDoneReason(row, db, branches);
    } else if (age >= GRACE.attachmentUnknown) {
      reason = `Not linked to a card, thread or finding, last changed ${ago(now, now - age)}`;
    }
    if (!reason) continue;
    out.push({
      id: `ws:${ws.id}:att:${a.group}`,
      category: 'attachments',
      tier: 'safe',
      label: `Agent files ${a.group.slice(0, 12)}`,
      reason,
      bytes: a.bytes,
      where,
      action: act({ kind: 'attachment', group: a.group }),
    });
  }

  // Rules 2 and 3: cockpit refs (checkpoints pin old snapshots against git gc).
  const own: { n: number; ref: (typeof facts.refs)[number] }[] = [];
  for (const r of facts.refs) {
    const parts = r.name.split('/');
    if (parts[2] === 'pre-squash') {
      const branch = parts.slice(3).join('/');
      const mr = mrOf(branch);
      const gone = !branches.has(branch);
      const closed = mr && (mr.state === 'merged' || mr.state === 'closed');
      if ((gone || closed) && now - r.committedAt >= GRACE.preSquash) {
        out.push({
          id: `ws:${ws.id}:ref:${r.name}:${r.sha}`,
          category: 'checkpoints',
          tier: 'safe',
          label: `Pre-squash backup of ${branch}`,
          reason: gone
            ? 'The branch no longer exists locally'
            : `Its MR !${mr!.iid} is ${mr!.state}`,
          bytes: null,
          where,
          action: act({ kind: 'ref', name: r.name, sha: r.sha }),
        });
      }
      continue;
    }
    const wsId = parts[2] ?? '';
    const n = Number(parts[3]);
    if (wsId !== ws.id) {
      if (!db.workspaceIds.has(wsId)) {
        out.push({
          id: `ws:${ws.id}:ref:${r.name}:${r.sha}`,
          category: 'checkpoints',
          tier: 'safe',
          label: `Checkpoint ${wsId}#${parts[3] ?? '?'}`,
          reason: 'Left by a workspace that was removed',
          bytes: null,
          where,
          action: act({ kind: 'ref', name: r.name, sha: r.sha }),
        });
      }
      continue;
    }
    if (Number.isInteger(n)) own.push({ n, ref: r });
  }
  own.sort((a, b) => b.n - a.n);
  for (const { n, ref } of own.slice(GRACE.checkpointKeep)) {
    if (now - ref.committedAt < GRACE.checkpointAge) continue;
    out.push({
      id: `ws:${ws.id}:ref:${ref.name}:${ref.sha}`,
      category: 'checkpoints',
      tier: 'safe',
      label: `Agent turn checkpoint #${n}`,
      reason: `Older than 14 days, the newest ${GRACE.checkpointKeep} are kept`,
      bytes: null,
      where,
      action: act({ kind: 'ref', name: ref.name, sha: ref.sha }),
    });
  }

  // Rule 4: local branches. Only when no commit can be lost.
  for (const b of facts.branches) {
    if (b.name === facts.head || b.name === ws.base || PROTECTED_BRANCH.test(b.name)) continue;
    if (/^release\//.test(b.name)) continue;
    if (now - b.committedAt < GRACE.branchIdle) continue;
    const mr = mrOf(b.name);
    const pushed = ws.repoId ? db.pushedSha.get(`${ws.repoId}\t${b.name}`) : undefined;
    const card = [...db.cards.values()].find((c) => c.branchName === b.name);
    let reason: string | null = null;
    let force = false;
    const finished =
      isDoneCard(card) || mr?.state === 'merged' || mr?.state === 'closed' || b.upstreamGone;
    if (facts.baseKnown && b.inBase && (finished || !card)) {
      // A fresh card branch has no commits yet (so it is "in base" too): an active card keeps it.
      reason = `Every commit is already in origin/${ws.base}`;
    } else if (mr?.state === 'merged' && pushed === b.tip) {
      // A squash merge leaves the branch's own commits outside the base; the pushed tip is what was merged.
      reason = `MR !${mr.iid} is merged and the local tip is what was pushed`;
      force = true;
    } else if (mr?.state === 'closed' && isDoneCard(card) && pushed === b.tip) {
      reason = `MR !${mr.iid} is closed, the card is done, and the local tip is what was pushed`;
      force = true;
    }
    if (!reason) continue;
    out.push({
      id: `ws:${ws.id}:branch:${b.name}:${b.tip}`,
      category: 'branches',
      tier: 'confirm',
      label: b.name,
      reason: `${reason}. Last commit ${ago(now, b.committedAt)}`,
      bytes: null,
      where,
      action: act({ kind: 'branch', name: b.name, tip: b.tip, force }),
    });
  }

  // Rule 5: drop remote branches deleted on origin, let git pack loose objects.
  if (facts.branches.some((b) => b.upstreamGone) || out.length > 0) {
    out.push({
      id: `ws:${ws.id}:prune`,
      category: 'git',
      tier: 'safe',
      label: 'Prune remote branches, pack git objects',
      reason: 'git fetch --prune and git gc --auto: frees what the removed refs held',
      bytes: null,
      where,
      action: act({ kind: 'prune' }),
    });
  }
  return out;
}

function attachmentDoneReason(
  row: AttachmentRow,
  db: DbFacts,
  branches: ReadonlyMap<string, unknown>,
): string | null {
  if (row.kind === 'card') {
    const card = db.cards.get(row.refId);
    if (isDoneCard(card)) return `Its card is ${card!.archived ? 'archived' : card!.status}`;
    if (card?.branchName && !branches.has(card.branchName)) {
      return `Its card's branch ${card.branchName} no longer exists`;
    }
    return null;
  }
  if (row.kind === 'thread') {
    const mrKey = row.refId.split('#')[0] ?? '';
    const state = db.mrState.get(mrKey);
    if (state === 'merged' || state === 'closed') return `Its MR is ${state}`;
    if (db.resolvedThreads.has(row.refId)) return 'Its review thread is resolved';
    return null;
  }
  if (row.kind === 'finding') {
    const status = db.findings.get(row.refId);
    if (status === 'verified' || status === 'wontfix') return `Its test finding is ${status}`;
    if (!status) return 'Its test finding was deleted';
  }
  return null;
}

// ───────────────────────────── host temp dir ─────────────────────────────

export function tmpCandidates(
  t: TmpCleanupFacts,
  now: number,
  runActive: (runId: string) => boolean,
): PlannedCandidate[] {
  const out: PlannedCandidate[] = [];
  for (const e of t.entries) {
    let reason: string | null = null;
    switch (e.kind) {
      case 'bench-config': {
        const runId = e.name.slice('cockpit-bench-'.length, -'.json'.length);
        if (!runActive(runId) && now - e.mtimeMs >= GRACE.tmpLeftover) {
          reason = 'Device-test MCP config (holds a run token) of a run that is over';
        }
        break;
      }
      case 'bench-cursor-dir':
      case 'agent-shim':
        if (e.mtimeMs < t.startedAt - 60_000) reason = 'Left by an earlier run of the host agent';
        break;
      case 'git-index':
      case 'squash':
        if (now - e.mtimeMs >= GRACE.tmpLeftover) reason = 'Temporary git work left after a crash';
        break;
    }
    if (!reason) continue;
    out.push({
      id: `tmp:${e.name}`,
      category: 'temp',
      tier: 'safe',
      label: e.name,
      reason,
      bytes: e.bytes,
      where: 'Mac temp dir',
      action: { on: 'tmp', name: e.name },
    });
  }
  return out;
}

// ───────────────────────────── server data ─────────────────────────────

export interface FsEntry {
  /** Relative to its root. */
  rel: string;
  bytes: number;
  mtimeMs: number;
}

export interface DataFacts {
  now: number;
  dataDir: string;
  clonesRoot: string;
  repoIds: ReadonlySet<string>;
  /** Repos with a queued, running or paused job. */
  busyRepos: ReadonlySet<string>;
  lastBuildFinished: ReadonlyMap<string, number>;
  /** `<repoId>/build` folders inside clones. */
  cloneBuilds: (FsEntry & { repoId: string })[];
  /** Top-level clone folders that hold a `.git`. */
  clones: (FsEntry & { repoId: string })[];
  /** `<repoId>/<file>` under `apks/`. */
  apks: (FsEntry & { repoId: string })[];
  /** `<runId>` folders under `testbench/`. */
  evidence: (FsEntry & { runId: string })[];
  runs: ReadonlyMap<string, { status: string; endedAt: number | null }>;
  /** Run ids whose screenshots an open/fixing/fixed finding still points to. */
  runsInUse: ReadonlySet<string>;
  /** `<fileKey>` folders under `figma/`. */
  figma: FsEntry[];
  /** `<cardId>` folders under `figma-cards/` (saved Figma snapshots of a card). */
  figmaCards: (FsEntry & { cardId: string })[];
  /** Card and MR facts, for the snapshots: kept until the card's MR is merged or the card is done. */
  cards: ReadonlyMap<string, CardFact>;
  mrByBranch: ReadonlyMap<string, MrFact>;
  /** Files under `scrcpy/`. */
  scrcpy: FsEntry[];
  scrcpyCurrent: string;
}

export function dataCandidates(d: DataFacts): PlannedCandidate[] {
  const out: PlannedCandidate[] = [];
  const now = d.now;
  const fs = (root: string, rel: string): CleanupAction => ({ on: 'fs', root, rel });

  // Rule 6: build outputs in bot clones (rebuilt by the next build).
  for (const c of d.cloneBuilds) {
    if (d.busyRepos.has(c.repoId) || !d.repoIds.has(c.repoId)) continue;
    const last = d.lastBuildFinished.get(c.repoId) ?? c.mtimeMs;
    if (now - Math.max(last, c.mtimeMs) < GRACE.cloneBuild) continue;
    out.push({
      id: `fs:clones:${c.rel}`,
      category: 'clone-builds',
      tier: 'safe',
      label: `${c.repoId}/build`,
      reason: `Build output, last build ${ago(now, last)}; the next build recreates it`,
      bytes: c.bytes,
      where: c.repoId,
      action: fs(d.clonesRoot, c.rel),
    });
  }

  // Rule 7: a clone whose repo was removed from Settings.
  for (const c of d.clones) {
    if (d.repoIds.has(c.repoId) || d.busyRepos.has(c.repoId)) continue;
    out.push({
      id: `fs:clones:${c.rel}`,
      category: 'clones',
      tier: 'confirm',
      label: `Bot clone ${c.repoId}`,
      reason: 'This repo is no longer configured in Settings',
      bytes: c.bytes,
      where: c.repoId,
      action: fs(d.clonesRoot, c.rel),
    });
  }

  // Rule 8: APKs beyond the newest few per repo.
  const byRepo = new Map<string, (typeof d.apks)[number][]>();
  for (const a of d.apks) byRepo.set(a.repoId, [...(byRepo.get(a.repoId) ?? []), a]);
  for (const [repoId, list] of byRepo) {
    const sorted = [...list].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const a of sorted.slice(GRACE.apkKeep)) {
      if (now - a.mtimeMs < GRACE.apkAge) continue;
      out.push({
        id: `fs:data:${a.rel}`,
        category: 'apks',
        tier: 'confirm',
        label: a.rel.split('/').pop() ?? a.rel,
        reason: `Built ${ago(now, a.mtimeMs)}; the newest ${GRACE.apkKeep} of ${repoId} are kept`,
        bytes: a.bytes,
        where: repoId,
        action: fs(d.dataDir, a.rel),
      });
    }
  }

  // Rule 9: test-bench evidence screenshots.
  for (const e of d.evidence) {
    const run = d.runs.get(e.runId);
    let reason: string | null = null;
    if (!run) {
      if (now - e.mtimeMs >= GRACE.evidenceOrphan) reason = 'Its test run was deleted';
    } else if (
      (run.status === 'done' || run.status === 'aborted') &&
      run.endedAt !== null &&
      now - run.endedAt >= GRACE.evidenceDone &&
      !d.runsInUse.has(e.runId)
    ) {
      reason = `Run ${run.status} ${ago(now, run.endedAt)}, no open finding uses it`;
    }
    if (!reason) continue;
    out.push({
      id: `fs:data:${e.rel}`,
      category: 'evidence',
      tier: 'safe',
      label: `Test run ${e.runId.slice(0, 8)} screenshots`,
      reason,
      bytes: e.bytes,
      where: 'Test Bench',
      action: fs(d.dataDir, e.rel),
    });
  }

  // Rule 10: Figma frame cache (re-downloaded on demand).
  for (const f of d.figma) {
    if (now - f.mtimeMs < GRACE.figma) continue;
    out.push({
      id: `fs:data:${f.rel}`,
      category: 'figma',
      tier: 'safe',
      label: `Figma frames ${f.rel.split('/').pop()}`,
      reason: `Cache, last used ${ago(now, f.mtimeMs)}; fetched again when needed`,
      bytes: f.bytes,
      where: 'Figma cache',
      action: fs(d.dataDir, f.rel),
    });
  }

  // Rule 10b: a card's saved Figma snapshots, once its MR is merged or the card is done.
  for (const f of d.figmaCards) {
    const reason = figmaCardReason(f, d);
    if (!reason) continue;
    out.push({
      id: `fs:data:${f.rel}`,
      category: 'figma',
      tier: 'safe',
      label: `Figma snapshot of card ${f.cardId.slice(0, 8)}`,
      reason,
      bytes: f.bytes,
      where: 'Figma snapshots',
      action: fs(d.dataDir, f.rel),
    });
  }

  // Rule 11: scrcpy servers of older versions.
  for (const s of d.scrcpy) {
    if (s.rel.endsWith(`/${d.scrcpyCurrent}`)) continue;
    out.push({
      id: `fs:data:${s.rel}`,
      category: 'scrcpy',
      tier: 'safe',
      label: s.rel.split('/').pop() ?? s.rel,
      reason: `Not the version in use (${d.scrcpyCurrent})`,
      bytes: s.bytes,
      where: 'Device bridge',
      action: fs(d.dataDir, s.rel),
    });
  }
  return out;
}

/** Why a card's Figma snapshot can go, or null to keep it. Pure. */
export function figmaCardReason(
  f: FsEntry & { cardId: string },
  d: Pick<DataFacts, 'now' | 'cards' | 'mrByBranch'>,
): string | null {
  const card = d.cards.get(f.cardId);
  if (!card) {
    return d.now - f.mtimeMs >= GRACE.attachmentUnknown
      ? `Its card is no longer on the board, saved ${ago(d.now, f.mtimeMs)}`
      : null;
  }
  const branch = card.branchName?.trim();
  if (branch) {
    for (const [key, mr] of d.mrByBranch) {
      if (mr.state === 'merged' && key.endsWith(`\t${branch}`))
        return `Its MR !${mr.iid} is merged`;
    }
  }
  return isDoneCard(card) ? 'Its card is done' : null;
}
