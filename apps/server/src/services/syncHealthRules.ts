import type {
  Card,
  DomainState,
  Fix,
  FamilyTree,
  Mr,
  MrDerivedState,
  ReleaseFact,
  Rule,
  Severity,
} from '@relay/shared';
import type { MrMatch } from './matcher';

/**
 * Sync Health rule table. One rule object per table row:
 *   `{ id, severity, message, when(card, mr, ctx), fix(card, mr, ctx) }`
 * Rules are PURE and only SUGGEST: a `fix` is applied later, user-confirmed, audited and undoable.
 * Adding a rule = adding one object to `HEALTH_RULES`.
 *
 * Inputs: the card's Notion status and the card's MR state ∈ {none, open, draft, reviewed,
 * approved, merged, closed}. For a card with several MRs the primary one is used (newest live, else newest).
 */

// ───────────────────────────── severities (one place to tune) ─────────────────────────────
//
// Icons: ✅ ok · 💡 info · ⚠️ warn · 🟠 action · 🔴 critical. The last rule row says "⚠️ / 🔴" for orphan /
// mismatch / duplicate: orphan ⚠️, duplicate ⚠️ (as in matching), mismatch 🔴 (the keys disagree about identity).
export const LINK_SEVERITY = {
  orphan: 'warn',
  mismatch: 'critical',
  duplicate: 'warn',
} as const satisfies Record<string, Severity>;

// ───────────────────────────── status roles ─────────────────────────────

export const STATUS_ROLES = [
  'backlog',
  'nextUp',
  'inProgress',
  'complete',
  'readyToTest',
  'onFeedback',
  'issues',
] as const;
export type StatusRole = (typeof STATUS_ROLES)[number];

/** names. `readyToTest` comes from `notion.readyStatus` at runtime. */
export const CANONICAL_STATUS: Record<StatusRole, string> = {
  backlog: 'Backlog',
  nextUp: 'Next Up',
  inProgress: 'In Progress',
  complete: 'Complete',
  readyToTest: 'Ready to Test',
  onFeedback: 'On Feedback',
  issues: 'Issues',
};

// ───────────────────────────── context ─────────────────────────────

export interface HealthCtx {
  now: number;
  /** Role of a card's status (case/space-insensitive), `null` when the status is unknown or empty. */
  roleOf(card: Card): StatusRole | null;
  /** The configured spelling of a role's status (what a `set_card_status` fix must write). */
  statusName(role: StatusRole): string;
  /** Cosmetic derived MR state (`none` for no MR). */
  mrStateOf(mr: Mr | null): MrDerivedState;
  /** Release facts of a merged MR (cache-derived, tri-state). */
  releaseOf(mr: Mr | null): ReleaseFact | undefined;
  /** Product Domain → repo state of a card (`unknown` when the card has no domain). */
  domainOf(card: Card): DomainState;
  /** Family tree of an On Feedback card. */
  familyOf(card: Card): FamilyTree | undefined;
  /** Live MRs of a card when it has more than one (never auto-resolved). */
  duplicatesOf(card: Card): { repoId: string; iid: number }[] | undefined;
  /** Matcher outcome of a (non-version) MR. */
  matchOf(mr: Mr): MrMatch | undefined;
}

export type RuleScope = 'card' | 'mr';

export interface HealthRule extends Rule<HealthCtx> {
  /** `card`: evaluated once per non-archived card with its primary MR. `mr`: once per in-scope MR (card may be null). */
  scope: RuleScope;
  /**
   * Does a firing of this rule explain the card's (status, MR state) pair? Cards for which no covering rule fired
   * are reported as `unruled` instead of silently looking healthy. Default: `scope === 'card'`.
   */
  coversStatus?(card: Card, ctx: HealthCtx): boolean;
}

// ───────────────────────────── helpers ─────────────────────────────

const LIVE: readonly MrDerivedState[] = ['open', 'draft', 'reviewed', 'approved'];
/** Open for review (a draft is deliberately not in here). */
const REVIEWABLE: readonly MrDerivedState[] = ['open', 'reviewed', 'approved'];

const role = (card: Card | null, ctx: HealthCtx): StatusRole | null =>
  card ? ctx.roleOf(card) : null;

const setStatus = (card: Card | null, to: StatusRole, ctx: HealthCtx): Fix | null =>
  card ? { type: 'set_card_status', cardId: card.id, to: ctx.statusName(to) } : null;

const linker = (card: Card | null, mr: Mr | null): Fix => ({
  type: 'open_linker',
  cardId: card?.id ?? null,
  repoId: mr?.repoId ?? null,
  mrIid: mr?.iid ?? null,
});

/** `card` rule that fires for `statuses` × `mrStates`. */
function pair(
  card: Card | null,
  mr: Mr | null,
  ctx: HealthCtx,
  statuses: readonly StatusRole[],
  states: readonly MrDerivedState[],
): boolean {
  const r = role(card, ctx);
  return r !== null && statuses.includes(r) && states.includes(ctx.mrStateOf(mr));
}

/** The card's Product Domain is known but no repo is registered for it. */
const unconnected = (card: Card | null, ctx: HealthCtx): boolean =>
  card !== null && ctx.domainOf(card) === 'unconnected';

// ───────────────────────────── the table ─────────────────────────────

export const HEALTH_RULES: readonly HealthRule[] = [
  // ── Next Up / Backlog ─────────────────────────────────────────────
  {
    // Not a rule-table row: an untouched Backlog / Next Up card (or one whose earlier MR was closed) is plainly normal.
    // Without it every such card would be listed as "unruled".
    id: 'ok.backlog_no_mr',
    scope: 'card',
    severity: 'ok',
    message: 'Not started, no live MR: normal.',
    when: (c, m, ctx) => pair(c, m, ctx, ['backlog', 'nextUp'], ['none', 'closed']),
  },
  {
    id: 'behind.backlog_has_mr',
    scope: 'card',
    severity: 'warn',
    message: 'Card is behind: an MR is already open but the card is still Backlog / Next Up.',
    when: (c, m, ctx) => pair(c, m, ctx, ['backlog', 'nextUp'], LIVE),
    fix: (c, _m, ctx) => setStatus(c, 'inProgress', ctx),
  },
  {
    id: 'stale.backlog_merged',
    scope: 'card',
    severity: 'critical',
    message: 'MR is merged but the card is still Backlog / Next Up.',
    when: (c, m, ctx) => pair(c, m, ctx, ['backlog', 'nextUp'], ['merged']),
    fix: (c, _m, ctx) => setStatus(c, 'complete', ctx),
  },

  // ── In Progress ───────────────────────────────────────────────────
  {
    // Rule-table row "In Progress | none ✅ normal". A DRAFT MR is work in progress too (a decision).
    id: 'ok.in_progress_no_mr',
    scope: 'card',
    severity: 'ok',
    message: 'In progress, no MR ready for review yet: normal.',
    when: (c, m, ctx) => pair(c, m, ctx, ['inProgress'], ['none', 'draft']),
  },
  {
    id: 'behind.in_progress_mr_opened',
    scope: 'card',
    severity: 'warn',
    message: 'Card is behind: the MR is open for review, so the card should be Complete.',
    // A DRAFT MR is still work in progress and does not trigger this.
    when: (c, m, ctx) => pair(c, m, ctx, ['inProgress'], REVIEWABLE),
    fix: (c, _m, ctx) => setStatus(c, 'complete', ctx),
  },
  {
    id: 'stale.in_progress_merged',
    scope: 'card',
    severity: 'critical',
    message: 'Stale: the MR is merged but the card is still In Progress.',
    when: (c, m, ctx) => pair(c, m, ctx, ['inProgress'], ['merged']),
    fix: (c, _m, ctx) => setStatus(c, 'complete', ctx),
  },

  // ── Complete ──────────────────────────────────────────────────────
  {
    id: 'missing_mr.complete',
    scope: 'card',
    severity: 'warn',
    message: 'Card is Complete but has no MR: link one or create it.',
    when: (c, m, ctx) => pair(c, m, ctx, ['complete'], ['none']) && !unconnected(c, ctx),
    fix: (c, m) => linker(c, m),
  },
  {
    id: 'ok.complete_in_review',
    scope: 'card',
    severity: 'ok',
    message: 'Complete and the MR is in review: normal.',
    when: (c, m, ctx) => pair(c, m, ctx, ['complete'], REVIEWABLE),
  },
  {
    id: 'release.awaiting_release',
    scope: 'card',
    severity: 'action',
    message: 'Awaiting release: merged, but no version-update MR has been merged since.',
    when: (c, m, ctx) =>
      pair(c, m, ctx, ['complete'], ['merged']) &&
      ctx.releaseOf(m)?.onBase === true &&
      ctx.releaseOf(m)?.bumped === false,
    fix: (_c, m) => (m ? { type: 'start_release', repoId: m.repoId } : null),
    detail: () => 'Based on the merged-MR list read from GitLab.',
  },
  {
    id: 'release.awaiting_build',
    scope: 'card',
    severity: 'action',
    message: 'Awaiting build: the version is bumped but no build exists for it.',
    when: (c, m, ctx) =>
      pair(c, m, ctx, ['complete'], ['merged']) &&
      ctx.releaseOf(m)?.bumped === true &&
      ctx.releaseOf(m)?.built === false,
    fix: (_c, m) => (m ? { type: 'build_and_share', repoId: m.repoId } : null),
    detail: (_c, m, ctx) => {
      const v = ctx.releaseOf(m)?.version;
      return v ? `Release ${v} has no successful build.` : null;
    },
  },
  {
    // Not a rule-table row: the rows above need facts that may not be known yet. Reported honestly as unknown
    // instead of staying silent (merged-MR list not read or out of date / no build history).
    id: 'release.unknown',
    scope: 'card',
    severity: 'info',
    message: 'Merged, but the release state cannot be determined yet.',
    when: (c, m, ctx) => {
      if (!pair(c, m, ctx, ['complete'], ['merged'])) return false;
      const f = ctx.releaseOf(m);
      return f?.onBase === true && (f.bumped === null || (f.bumped === true && f.built === null));
    },
    detail: (_c, m, ctx) =>
      ctx.releaseOf(m)?.bumped === null
        ? 'The merged-MR list of this repo was not read recently and completely. See GET /api/release/:repo.'
        : ctx.releaseOf(m)?.version === null
          ? 'Included in a version bump, but older than the merged-MR history read so far.'
          : 'The dashboard has no build history for this repo.',
  },
  {
    id: 'contradiction.complete_closed',
    scope: 'card',
    severity: 'critical',
    message: 'Contradiction: the card is Complete but its MR was closed.',
    when: (c, m, ctx) => pair(c, m, ctx, ['complete'], ['closed']),
    fix: (c, _m, ctx) => setStatus(c, 'inProgress', ctx),
    alternatives: (c, _m, ctx) => {
      const f = setStatus(c, 'issues', ctx);
      return f ? [f] : [];
    },
  },

  // ── Ready to Test ─────────────────────────────────────────────────
  {
    id: 'ahead.rtt_mr_open',
    scope: 'card',
    severity: 'warn',
    message: 'Card is ahead: it is Ready to Test but the MR is not merged yet.',
    when: (c, m, ctx) => pair(c, m, ctx, ['readyToTest'], LIVE),
    fix: (c, _m, ctx) => setStatus(c, 'complete', ctx),
  },
  {
    id: 'ok.rtt_released',
    scope: 'card',
    severity: 'ok',
    message: 'Merged and released: done.',
    when: (c, m, ctx) =>
      pair(c, m, ctx, ['readyToTest'], ['merged']) &&
      ctx.releaseOf(m)?.onBase === true &&
      ctx.releaseOf(m)?.bumped === true,
  },
  {
    id: 'contradiction.rtt_closed_or_none',
    scope: 'card',
    severity: 'critical',
    message: 'Contradiction: the card is Ready to Test but its MR is closed or missing.',
    when: (c, m, ctx) =>
      pair(c, m, ctx, ['readyToTest'], ['closed', 'none']) && !unconnected(c, ctx),
  },
  {
    // The card's Product Domain has no registered repo: its MR cannot be tracked, so "MR missing" would be false.
    id: 'info.repo_not_connected',
    scope: 'card',
    severity: 'info',
    message: 'Product Domain has no connected repo: the MR is not tracked here.',
    detail: (c) => (c?.productDomain ? `Domain: ${c.productDomain}.` : null),
    when: (c, m, ctx) =>
      unconnected(c, ctx) &&
      pair(c, m, ctx, ['inProgress', 'complete', 'readyToTest'], ['none', 'closed']),
  },

  // ── On Feedback ───────────────────────────────────────────────────
  {
    id: 'family.on_feedback_children_ready',
    scope: 'card',
    severity: 'info',
    message: 'All child Issues cards are Ready to Test: move the parent back to Ready to Test.',
    when: (c, _m, ctx) =>
      role(c, ctx) === 'onFeedback' && ctx.familyOf(c!)?.suggestParentReady === true,
    fix: (c, _m, ctx) => setStatus(c, 'readyToTest', ctx),
    detail: (c, _m, ctx) => {
      const f = ctx.familyOf(c!);
      return f
        ? `${f.readyIssuesChildren} of ${f.issuesChildren} child Issues are Ready to Test.`
        : null;
    },
  },
  {
    id: 'family.on_feedback_waiting',
    scope: 'card',
    severity: 'ok',
    message: 'On Feedback: waiting for its child Issues to reach Ready to Test.',
    when: (c, _m, ctx) => {
      if (role(c, ctx) !== 'onFeedback') return false;
      const f = ctx.familyOf(c!);
      return f !== undefined && f.issuesChildren > 0 && !f.allIssuesReady;
    },
    detail: (c, _m, ctx) => {
      const f = ctx.familyOf(c!);
      return f
        ? `${f.readyIssuesChildren} of ${f.issuesChildren} child Issues are Ready to Test.`
        : null;
    },
  },
  {
    id: 'family.on_feedback_orphan',
    scope: 'card',
    severity: 'warn',
    message: 'Orphan feedback: this On Feedback card has no child Issues.',
    when: (c, _m, ctx) =>
      role(c, ctx) === 'onFeedback' && (ctx.familyOf(c!)?.issuesChildren ?? 0) === 0,
    fix: (c) => (c ? { type: 'link_child', parentId: c.id } : null),
  },

  // ── Issues ────────────────────────────────────────────────────────
  {
    // An Issues card without a parent is normal too (not every issue comes from a feedback round), so a missing
    // parent is not reported.
    id: 'ok.issues',
    scope: 'card',
    severity: 'ok',
    message: 'Issues card: normal.',
    when: (c, _m, ctx) => role(c, ctx) === 'issues',
  },

  // ── Duplicate MR for a card (rule table, last row) ────────────────────
  {
    id: 'link.duplicate',
    scope: 'card',
    severity: LINK_SEVERITY.duplicate,
    message: 'Duplicate MRs: more than one live MR is linked to this card (1 card = 1 MR).',
    when: (c, _m, ctx) => c !== null && ctx.duplicatesOf(c) !== undefined,
    fix: (c, m) => linker(c, m),
    detail: (c, _m, ctx) => {
      const d = c ? ctx.duplicatesOf(c) : undefined;
      return d ? d.map((x) => `${x.repoId}!${x.iid}`).join(', ') : null;
    },
    coversStatus: () => false,
  },

  // ── MR-level: orphan / mismatch / weak links ───
  {
    id: 'link.orphan',
    scope: 'mr',
    severity: LINK_SEVERITY.orphan,
    message: 'Orphan MR: neither the title nor the description points to a card.',
    // A closed MR is history: nothing is left to link it for.
    when: (_c, m, ctx) =>
      m !== null && m.state !== 'closed' && ctx.matchOf(m)?.outcome === 'orphan',
    fix: (c, m) => linker(c, m),
    detail: (_c, m, ctx) =>
      m && ctx.matchOf(m)?.descriptionUnresolved
        ? 'The description has a Notion link, but it is not a known card.'
        : null,
  },
  {
    id: 'link.mismatch',
    scope: 'mr',
    severity: LINK_SEVERITY.mismatch,
    message: 'Mismatch: the MR title and the description point to different cards.',
    when: (_c, m, ctx) => m !== null && ctx.matchOf(m)?.outcome === 'mismatch',
    fix: (c, m) => linker(c, m),
    detail: (_c, m, ctx) =>
      m && ctx.matchOf(m)?.mismatchReason === 'ambiguous_title'
        ? 'Several cards share this branch name.'
        : null,
  },
  {
    id: 'link.weak_title',
    scope: 'mr',
    severity: 'info',
    message: 'Linked by title only: add the Notion link to the MR description.',
    when: (_c, m, ctx) => m !== null && ctx.matchOf(m)?.outcome === 'weak_title',
    fix: (c, m) =>
      c && m
        ? { type: 'add_notion_link_to_mr', repoId: m.repoId, mrIid: m.iid, cardId: c.id }
        : null,
  },
  {
    id: 'link.weak_description',
    scope: 'mr',
    severity: 'info',
    message: 'Linked by description only: rename the MR title to the branch name.',
    when: (_c, m, ctx) => m !== null && ctx.matchOf(m)?.outcome === 'weak_description',
    fix: (c, m) =>
      c && m ? { type: 'rename_mr_title', repoId: m.repoId, mrIid: m.iid, cardId: c.id } : null,
  },
];

export const ruleCoversStatus = (r: HealthRule, card: Card, ctx: HealthCtx): boolean =>
  r.coversStatus ? r.coversStatus(card, ctx) : r.scope === 'card';
