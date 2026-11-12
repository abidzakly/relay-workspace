import {
  statusGroupTest,
  type InboxMr,
  type KpiCardRow,
  type PendingRelease,
  type StateCard,
  type StateMr,
  type StatusGroups,
  type Verdict,
} from '@relay/shared';

import { groupByStack, stackWaitLabel } from '@/lib/mrStacks';

/** The Overview's "needs your action" list. Pure: no React, no fetching. */

export interface ActionRow {
  key: string;
  title: string;
  detail: string;
  to: string;
  /** The server's severity, when the source has one (verdicts, SLA states). Never guessed from the title. */
  severity?: 'critical' | 'warn';
  /** A stack member that cannot move yet, because something below it comes first. */
  blocked?: boolean;
}

export interface ActionGroup {
  id: 'mismatches' | 'release' | 'mrs' | 'sla' | 'pipelines';
  title: string;
  /** Where the whole group lives. */
  to: string;
  rows: ActionRow[];
}

const mrPath = (repoId: string, iid: number) => `/mrs/${encodeURIComponent(repoId)}/${iid}`;
const repoQuery = (path: string, repoId: string) => `${path}?repo=${encodeURIComponent(repoId)}`;

/** Sync Health problems. 🟠 release verdicts have their own group; `ok` and `info` ask nothing of the user. */
export function mismatchRows(verdicts: readonly Verdict[]): ActionRow[] {
  const problems = verdicts.filter(
    (v) => (v.severity === 'critical' || v.severity === 'warn') && !v.ruleId.startsWith('release.'),
  );
  // Stable: the engine's order is kept within a severity.
  const ordered = [
    ...problems.filter((v) => v.severity === 'critical'),
    ...problems.filter((v) => v.severity === 'warn'),
  ];
  return ordered.map((v, i) => ({
    key: `${v.ruleId}:${v.cardId ?? ''}:${v.repoId ?? ''}#${v.mrIid ?? ''}:${i}`,
    title: v.cardTitle ?? v.mrTitle ?? v.message,
    detail: v.message,
    to: '/sync',
    severity: v.severity === 'critical' ? 'critical' : 'warn',
  }));
}

/** A card edited this recently still counts as current work, whatever month it started in. */
export const RECENT_EDIT_MS = 14 * 24 * 60 * 60 * 1000;

export interface RelevanceContext {
  now: number;
  /** `YYYY-MM` of `now`. */
  currentMonth: string;
  cards: readonly StateCard[];
  mrs: readonly StateMr[];
  /** Absent while settings load: only the defaults below apply. */
  statusGroups?: StatusGroups;
}

/**
 * Overview only (Sync Health keeps the full analysis): a finding is worth your attention when it is about current
 * work. A card finding needs a card that is not parked/closed (Archived, Done, Backlog…) and that is this month's or
 * was edited in the last two weeks. A finding with only an MR needs that MR to still be open.
 */
export function relevantVerdicts(verdicts: readonly Verdict[], ctx: RelevanceContext): Verdict[] {
  const cardBy = new Map(ctx.cards.map((c) => [c.id.replace(/-/g, '').toLowerCase(), c]));
  const mrBy = new Map(ctx.mrs.map((m) => [`${m.repoId}#${m.iid}`, m]));
  const groups = ctx.statusGroups ? statusGroupTest(ctx.statusGroups) : null;
  return verdicts.filter((v) => {
    if (v.cardId) {
      const card = cardBy.get(v.cardId.replace(/-/g, '').toLowerCase());
      if (!card) return false; // archived / trashed in Notion
      if (groups?.isInactive(card.status)) return false;
      return card.month === ctx.currentMonth || card.lastEditedAt >= ctx.now - RECENT_EDIT_MS;
    }
    if (v.repoId && v.mrIid) {
      const mr = mrBy.get(`${v.repoId}#${v.mrIid}`);
      return mr !== undefined && mr.state === 'opened';
    }
    return true;
  });
}

/** One row per repo: a version bump to do goes to the Release, a build still owed goes to Builds. */
export function releaseRows(
  pending: readonly PendingRelease[],
  verdicts: readonly Verdict[],
  repoName: (id: string) => string,
): ActionRow[] {
  const rows: ActionRow[] = pending
    .filter((p) => p.needsVersionBump)
    .map((p) => ({
      key: `release:${p.repoId}`,
      title: repoName(p.repoId),
      detail: `Awaiting release: ${p.pendingMrs.length} merged MR${p.pendingMrs.length === 1 ? '' : 's'}`,
      to: repoQuery('/release', p.repoId),
    }));
  const buildCounts = new Map<string, number>();
  for (const v of verdicts) {
    if (v.ruleId === 'release.awaiting_build' && v.repoId) {
      buildCounts.set(v.repoId, (buildCounts.get(v.repoId) ?? 0) + 1);
    }
  }
  for (const [repoId, count] of buildCounts) {
    rows.push({
      key: `build:${repoId}`,
      title: repoName(repoId),
      detail: `Awaiting build: ${count} card${count === 1 ? '' : 's'}`,
      to: repoQuery('/builds', repoId),
    });
  }
  return rows;
}

/** A failed pipeline has its own group, so it is not listed here for that reason as well. */
export function waitingMrRows(items: readonly InboxMr[]): ActionRow[] {
  // Stack-aware: members of one stack stay together, dependents above, the parent (#1) at the bottom.
  const mine = items.filter((m) => m.action.yours && m.action.kind !== 'pipeline_failed');
  return groupByStack(mine)
    .flatMap((g) => g.items)
    .map((m) => {
      const wait = stackWaitLabel(m);
      const pos = m.stack && m.stack.size > 1 ? `#${m.stack.position} · ` : '';
      return {
        key: `mr:${m.repoId}#${m.iid}`,
        title: m.title,
        detail: `${pos}${wait ?? m.action.label} · ${m.repoName} · !${m.iid}`,
        to: mrPath(m.repoId, m.iid),
        ...(wait !== null ? { blocked: true } : {}),
      };
    });
}

/** The user's own MRs when `myUsername` is known; a reviewer does not fix someone else's pipeline. */
export function failedPipelineRows(
  items: readonly InboxMr[],
  myUsername: string | undefined,
): ActionRow[] {
  const me = myUsername?.toLowerCase();
  return items
    .filter(
      (m) => m.headPipeline?.status === 'failed' && (!me || (m.author ?? '').toLowerCase() === me),
    )
    .map((m) => ({
      key: `pipeline:${m.repoId}#${m.iid}`,
      title: m.title,
      detail: `Pipeline failed · ${m.repoName} · !${m.iid}`,
      to: mrPath(m.repoId, m.iid),
    }));
}

const SLA_LABEL: Partial<Record<KpiCardRow['sla']['state'], string>> = {
  breached: 'SLA breached',
  over_90: 'Over 90% of SLA used',
  over_70: 'Over 70% of SLA used',
};

/** The focus list is already least-time-first. Timers still on track are not a risk yet. */
export function slaRows(rows: readonly KpiCardRow[]): ActionRow[] {
  return rows.flatMap((row) => {
    const label = SLA_LABEL[row.sla.state];
    if (!label) return [];
    const severity = row.sla.state === 'breached' ? 'critical' : 'warn';
    return [{ key: `sla:${row.cardId}`, title: row.title, detail: label, to: '/kpi', severity }];
  });
}
