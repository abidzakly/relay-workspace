import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  AcCheck,
  AcState,
  BenchReadiness,
  Card,
  CardBody,
  Finding,
  FindingInput,
  FindingPatch,
  FindingStatus,
  OpenBench,
  TestBenchState,
  TestRun,
} from '@relay/shared';
import { TEST_FINDING_TRAILER } from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { AppDb } from '../../db';
import {
  acChecks,
  cardBodies,
  mrs,
  testBenchSessions,
  testFindings,
  testRuns,
} from '../../db/schema';
import type { EventBus } from '../../sync/eventBus';
import { ActionError } from '../actionError';
import { listCards } from '../notionStore';
import { NotionApiError, type NotionService } from '../notionService';
import { parseBody, parseFigmaUrl, type ParsedBody } from './body';

/**
 * Test Bench service. Owns the card body cache, the AC / regression ticks, the findings and
 * the runs. The verdict is decided HERE from the stored ticks and findings, never taken from a client or an agent.
 */

export class TestBenchError extends ActionError {
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'TestBenchError';
  }
}

export interface TestBenchDeps {
  store: AppDb;
  config: ConfigStore;
  notion: Pick<NotionService, 'readBlocksDeep'>;
  /** HEAD of the branch: a workspace's checkout first, else the last pushed sha. */
  headOf: (repoId: string, branch: string) => Promise<string | null>;
  /** Commits of the branch with their trailers (local ones included), or null when no workspace has it. */
  localCommits?: (
    repoId: string,
    branch: string,
  ) => Promise<{ sha: string; trailers: Record<string, string[]> }[] | null>;
  bus?: EventBus;
  now?: () => number;
}

const FINDING_TARGET = 'finding:';
const AC_TARGET = 'ac:';

export class TestBenchService {
  private readonly now: () => number;
  /** One body read per card at a time (two tabs opening the bench share it). */
  private readonly reading = new Map<string, Promise<CardBody>>();

  constructor(private readonly d: TestBenchDeps) {
    this.now = d.now ?? Date.now;
  }

  // ── lookups

  cardOf(branch: string): Card | null {
    return listCards(this.d.store).find((c) => c.branchName?.trim() === branch) ?? null;
  }

  private requireCard(branch: string): Card {
    const card = this.cardOf(branch);
    if (!card) {
      throw new TestBenchError(404, 'no_card', 'No Notion card has this Branch formula.');
    }
    return card;
  }

  private changed(repoId: string, branch: string, runId?: string): void {
    this.d.bus?.emit({ type: 'testbench.changed', repoId, branch, ...(runId ? { runId } : {}) });
  }

  // ── body

  /** The parsed body; re-read from Notion only when the card was edited since (or `force`). */
  async body(card: Card, opts: { force?: boolean } = {}): Promise<CardBody> {
    const row = this.d.store.db
      .select()
      .from(cardBodies)
      .where(eq(cardBodies.cardId, card.id))
      .get();
    if (row && !opts.force && row.lastEditedAt >= card.lastEditedAt) return this.toBody(row);
    const pending = this.reading.get(card.id);
    if (pending) return pending;
    const p = this.readBody(card).finally(() => this.reading.delete(card.id));
    this.reading.set(card.id, p);
    return p;
  }

  private async readBody(card: Card): Promise<CardBody> {
    const { blocks, truncated } = await this.d.notion.readBlocksDeep(card.id);
    const acCfg = this.d.config.getGlobal().notion.ac;
    const parsed = parseBody(blocks, {
      headings: acCfg.headings,
      reasonMarker: acCfg.reasonMarker,
    });
    const now = this.now();
    this.d.store.db
      .insert(cardBodies)
      .values({
        cardId: card.id,
        body: parsed,
        lastEditedAt: card.lastEditedAt,
        fetchedAt: now,
        truncated,
      })
      .onConflictDoUpdate({
        target: cardBodies.cardId,
        set: { body: parsed, lastEditedAt: card.lastEditedAt, fetchedAt: now, truncated },
      })
      .run();
    const row = this.d.store.db
      .select()
      .from(cardBodies)
      .where(eq(cardBodies.cardId, card.id))
      .get()!;
    return this.toBody(row);
  }

  private toBody(row: typeof cardBodies.$inferSelect): CardBody {
    const b = row.body as ParsedBody;
    const figma = row.figmaOverride ?? b.figmaUrl;
    return {
      cardId: row.cardId,
      ac: b.ac,
      figmaUrl: figma,
      figmaSource: row.figmaOverride ? 'override' : b.figmaUrl ? 'notion' : 'none',
      docLinks: b.docLinks,
      description: b.description,
      lastEditedAt: row.lastEditedAt,
      fetchedAt: row.fetchedAt,
      truncated: row.truncated,
    };
  }

  private bodyRow(cardId: string) {
    const row = this.d.store.db
      .select()
      .from(cardBodies)
      .where(eq(cardBodies.cardId, cardId))
      .get();
    if (!row)
      throw new TestBenchError(
        409,
        'body_not_read',
        'Open the Test Bench once to read the card first.',
      );
    return row;
  }

  /** Hand-set Figma link (null = back to the one in Notion). */
  setFigmaOverride(repoId: string, branch: string, url: string | null): void {
    const card = this.requireCard(branch);
    if (url !== null && !parseFigmaUrl(url)) {
      throw new TestBenchError(422, 'bad_figma_url', 'Not a Figma design link.');
    }
    this.bodyRow(card.id);
    this.d.store.db
      .update(cardBodies)
      .set({ figmaOverride: url })
      .where(eq(cardBodies.cardId, card.id))
      .run();
    this.changed(repoId, branch);
  }

  /** The Figma frame an AC is compared with (null = none). */
  setFrame(repoId: string, branch: string, acKey: string, nodeId: string | null): void {
    const card = this.requireCard(branch);
    if (nodeId !== null && !/^\d+:\d+$/.test(nodeId)) {
      throw new TestBenchError(422, 'bad_node_id', 'A Figma node id looks like 12:34.');
    }
    const row = this.bodyRow(card.id);
    const frames = { ...row.frames };
    if (nodeId === null) delete frames[acKey];
    else frames[acKey] = nodeId;
    this.d.store.db.update(cardBodies).set({ frames }).where(eq(cardBodies.cardId, card.id)).run();
    this.changed(repoId, branch);
  }

  // ── state

  async state(
    repoId: string,
    branch: string,
    opts: { refresh?: boolean } = {},
  ): Promise<TestBenchState> {
    const card = this.cardOf(branch);
    const headSha = await this.d.headOf(repoId, branch).catch(() => null);
    let body: CardBody | null = null;
    let bodyError: string | null = null;
    if (card) {
      try {
        body = await this.body(card, { force: opts.refresh ?? false });
      } catch (e) {
        bodyError = bodyErrorText(e);
        const row = this.d.store.db
          .select()
          .from(cardBodies)
          .where(eq(cardBodies.cardId, card.id))
          .get();
        // A stale copy beats nothing; the error still shows.
        if (row) body = this.toBody(row);
      }
    }
    if (card) {
      await this.landFixes(card.id, repoId, branch);
      this.rememberOpened(repoId, branch, card);
    }
    const checks = card ? this.checksOf(card.id) : [];
    const findings = card ? this.findingsOf(card.id) : [];
    const frames = card
      ? (this.d.store.db
          .select({ f: cardBodies.frames })
          .from(cardBodies)
          .where(eq(cardBodies.cardId, card.id))
          .get()?.f ?? {})
      : {};
    const latestRun = this.latestRun(repoId, branch);
    const readiness = readinessOf(body, checks, findings);
    return {
      repoId,
      branch,
      headSha,
      card: card ? { id: card.id, title: card.title, url: card.url ?? null } : null,
      body,
      bodyError: card ? bodyError : 'No Notion card has this Branch formula.',
      checks,
      findings,
      frames,
      latestRun,
      readiness,
      testOk: testOkOf(latestRun, headSha),
    };
  }

  // ── open benches ("Continue testing")

  /** Opening the bench (re)lists it, newest first. Re-opening a dismissed bench brings it back. */
  private rememberOpened(repoId: string, branch: string, card: Card): void {
    const row = {
      repoId,
      branch,
      cardId: card.id,
      cardTitle: card.title,
      openedAt: this.now(),
      dismissedAt: null,
    };
    this.d.store.db
      .insert(testBenchSessions)
      .values(row)
      .onConflictDoUpdate({
        target: [testBenchSessions.repoId, testBenchSessions.branch],
        set: row,
      })
      .run();
  }

  /** Opened benches not dismissed, without an MR, and not yet tested on their current HEAD. */
  async openBenches(): Promise<OpenBench[]> {
    const rows = this.d.store.db
      .select()
      .from(testBenchSessions)
      .where(isNull(testBenchSessions.dismissedAt))
      .orderBy(desc(testBenchSessions.openedAt))
      .limit(20)
      .all();
    const out: OpenBench[] = [];
    for (const r of rows) {
      const hasMr = this.d.store.db
        .select({ iid: mrs.iid })
        .from(mrs)
        .where(and(eq(mrs.repoId, r.repoId), eq(mrs.sourceBranch, r.branch)))
        .get();
      if (hasMr) continue;
      const run = this.latestRun(r.repoId, r.branch);
      if (run?.status === 'done' && run.verdict === 'ready') {
        const head = await this.d.headOf(r.repoId, r.branch).catch(() => null);
        if (testOkOf(run, head)) continue;
      }
      const bodyRow = this.d.store.db
        .select()
        .from(cardBodies)
        .where(eq(cardBodies.cardId, r.cardId))
        .get();
      const body = bodyRow ? this.toBody(bodyRow) : null;
      const counts = readinessOf(body, this.checksOf(r.cardId), this.findingsOf(r.cardId)).counts;
      out.push({
        repoId: r.repoId,
        branch: r.branch,
        cardTitle: r.cardTitle,
        openedAt: r.openedAt,
        passed: counts.passed,
        ac: counts.ac,
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  dismissBench(repoId: string, branch: string): void {
    this.d.store.db
      .update(testBenchSessions)
      .set({ dismissedAt: this.now() })
      .where(and(eq(testBenchSessions.repoId, repoId), eq(testBenchSessions.branch, branch)))
      .run();
    this.changed(repoId, branch);
  }

  /**
   * A commit carrying `Test-Finding: <id>` moves that finding from open/fixing to "fixed, retest". Read from the
   * workspace's git log, so local fixups count before they are pushed.
   */
  private async landFixes(cardId: string, repoId: string, branch: string): Promise<void> {
    const waiting = this.findingsOf(cardId).filter(
      (f) => f.status === 'open' || f.status === 'fixing',
    );
    if (!waiting.length || !this.d.localCommits) return;
    const commits = await this.d.localCommits(repoId, branch).catch(() => null);
    if (!commits) return;
    const fixedBy = new Map<string, string>();
    // Oldest first, so the first commit that names a finding is recorded.
    for (const c of [...commits].reverse()) {
      for (const id of c.trailers[TEST_FINDING_TRAILER] ?? [])
        if (!fixedBy.has(id)) fixedBy.set(id, c.sha);
    }
    for (const f of waiting) {
      const sha = fixedBy.get(f.id);
      if (sha) this.setFindingStatus(f.id, 'fixed', sha);
    }
  }

  /**
   * Create MR squashed the branch into one commit with the SAME files: a `ready` run on the old HEAD stays valid on
   * the new one. Called only with the result of a squash that checked the trees match.
   */
  carryRun(repoId: string, branch: string, oldHead: string, newHead: string): void {
    const run = this.latestRun(repoId, branch);
    if (!run || run.headSha !== oldHead || oldHead === newHead) return;
    this.d.store.db.update(testRuns).set({ headSha: newHead }).where(eq(testRuns.id, run.id)).run();
    this.d.store.db
      .update(acChecks)
      .set({ verifiedSha: newHead })
      .where(and(eq(acChecks.cardId, run.cardId), eq(acChecks.verifiedSha, oldHead)))
      .run();
    this.changed(repoId, branch, run.id);
  }

  /** What the Create MR gate reads: the latest run is `ready` and was made on the current HEAD. */
  async gate(
    repoId: string,
    branch: string,
  ): Promise<{ testOk: boolean; stale: boolean; headSha: string | null; runId: string | null }> {
    const headSha = await this.d.headOf(repoId, branch).catch(() => null);
    const run = this.latestRun(repoId, branch);
    const testOk = testOkOf(run, headSha);
    const stale = !testOk && run?.status === 'done' && run.verdict === 'ready';
    return { testOk, stale, headSha, runId: run?.id ?? null };
  }

  private checksOf(cardId: string): AcCheck[] {
    return this.d.store.db
      .select()
      .from(acChecks)
      .where(eq(acChecks.cardId, cardId))
      .all()
      .map((r) => ({ ...r, state: r.state as AcState, by: r.by as AcCheck['by'] }));
  }

  private findingsOf(cardId: string): Finding[] {
    return this.d.store.db
      .select()
      .from(testFindings)
      .where(eq(testFindings.cardId, cardId))
      .orderBy(testFindings.createdAt)
      .all()
      .map(toFinding);
  }

  latestRun(repoId: string, branch: string): TestRun | null {
    const r = this.d.store.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.repoId, repoId), eq(testRuns.branch, branch)))
      .orderBy(desc(testRuns.startedAt))
      .limit(1)
      .get();
    return r ? toRun(r) : null;
  }

  getRun(id: string): TestRun {
    const r = this.d.store.db.select().from(testRuns).where(eq(testRuns.id, id)).get();
    if (!r) throw new TestBenchError(404, 'run_not_found');
    return toRun(r);
  }

  /** The run a tick belongs to: the open one on this branch, if any. */
  private openRunId(repoId: string, branch: string): string | null {
    const run = this.latestRun(repoId, branch);
    return run && (run.status === 'active' || run.status === 'paused') ? run.id : null;
  }

  // ── ticks

  async setCheck(
    repoId: string,
    branch: string,
    input: {
      target: string;
      state: AcState;
      note: string;
      by?: 'human' | 'ai';
      evidencePath?: string | null;
    },
  ): Promise<AcCheck> {
    const card = this.requireCard(branch);
    if (input.state === 'excused' && input.note.trim().length < 3) {
      throw new TestBenchError(422, 'reason_required', 'Say why this AC does not apply.');
    }
    if (input.target.startsWith(FINDING_TARGET)) {
      const f = this.finding(input.target.slice(FINDING_TARGET.length));
      if (f.cardId !== card.id) throw new TestBenchError(404, 'finding_not_found');
    }
    const headSha = await this.d.headOf(repoId, branch).catch(() => null);
    const row = {
      cardId: card.id,
      target: input.target,
      state: input.state,
      by: input.by ?? 'human',
      runId: this.openRunId(repoId, branch),
      verifiedSha: input.state === 'untested' ? null : headSha,
      note: input.note,
      evidencePath: input.evidencePath ?? null,
      updatedAt: this.now(),
    };
    this.d.store.db
      .insert(acChecks)
      .values(row)
      .onConflictDoUpdate({ target: [acChecks.cardId, acChecks.target], set: row })
      .run();
    // A regression check moves its finding: pass → verified, fail → open again.
    if (input.target.startsWith(FINDING_TARGET)) {
      const id = input.target.slice(FINDING_TARGET.length);
      if (input.state === 'pass') this.setFindingStatus(id, 'verified');
      else if (input.state === 'fail') this.setFindingStatus(id, 'open');
    }
    this.changed(repoId, branch, row.runId ?? undefined);
    return { ...row, state: row.state, by: row.by };
  }

  // ── findings

  finding(id: string): Finding {
    const r = this.d.store.db.select().from(testFindings).where(eq(testFindings.id, id)).get();
    if (!r) throw new TestBenchError(404, 'finding_not_found');
    return toFinding(r);
  }

  addFinding(
    repoId: string,
    branch: string,
    input: FindingInput,
    opts: { source?: 'human' | 'ai'; screenshotPath?: string | null } = {},
  ): Finding {
    const card = this.requireCard(branch);
    const now = this.now();
    const row = {
      id: randomUUID(),
      cardId: card.id,
      repoId,
      branch,
      title: input.title,
      severity: input.severity,
      acKey: input.acKey,
      steps: input.steps,
      expected: input.expected,
      actual: input.actual,
      screenshotPath: opts.screenshotPath ?? null,
      source: opts.source ?? 'human',
      status: 'open',
      runId: this.openRunId(repoId, branch),
      fixCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    this.d.store.db.insert(testFindings).values(row).run();
    this.changed(repoId, branch, row.runId ?? undefined);
    return toFinding(row);
  }

  updateFinding(id: string, patch: FindingPatch): Finding {
    const f = this.finding(id);
    this.d.store.db
      .update(testFindings)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(testFindings.id, id))
      .run();
    this.changed(f.repoId, f.branch);
    return this.finding(id);
  }

  deleteFinding(id: string): void {
    const f = this.finding(id);
    this.d.store.db.delete(testFindings).where(eq(testFindings.id, id)).run();
    this.d.store.db
      .delete(acChecks)
      .where(and(eq(acChecks.cardId, f.cardId), eq(acChecks.target, `${FINDING_TARGET}${id}`)))
      .run();
    this.changed(f.repoId, f.branch);
  }

  /** Status moves made by the app (sent to an agent, a fix commit landed, a retest). */
  setFindingStatus(id: string, status: FindingStatus, fixCommitSha?: string): void {
    const f = this.finding(id);
    this.d.store.db
      .update(testFindings)
      .set({ status, updatedAt: this.now(), ...(fixCommitSha ? { fixCommitSha } : {}) })
      .where(eq(testFindings.id, id))
      .run();
    // A finding that is fixed again needs a fresh retest.
    if (status === 'fixed') {
      this.d.store.db
        .delete(acChecks)
        .where(and(eq(acChecks.cardId, f.cardId), eq(acChecks.target, `${FINDING_TARGET}${id}`)))
        .run();
    }
    this.changed(f.repoId, f.branch);
  }

  // ── runs

  startRun(
    repoId: string,
    branch: string,
    headSha: string,
    mode: 'manual' | 'ai',
    deviceSerial: string | null,
  ): TestRun {
    const card = this.requireCard(branch);
    const open = this.openRunId(repoId, branch);
    if (open) this.endRun(open, 'aborted', null, 'Replaced by a new run.');
    const row = {
      id: randomUUID(),
      cardId: card.id,
      repoId,
      branch,
      headSha,
      mode,
      status: 'active',
      verdict: null,
      summary: '',
      waitingFor: null,
      deviceSerial,
      startedAt: this.now(),
      endedAt: null,
    };
    this.d.store.db.insert(testRuns).values(row).run();
    this.changed(repoId, branch, row.id);
    return toRun(row);
  }

  pauseRun(id: string, waitingFor: string | null): TestRun {
    const run = this.getRun(id);
    if (run.status !== 'active' && run.status !== 'paused') {
      throw new TestBenchError(409, 'run_closed', 'This run has ended.');
    }
    this.d.store.db
      .update(testRuns)
      .set({ status: waitingFor ? 'paused' : 'active', waitingFor })
      .where(eq(testRuns.id, id))
      .run();
    this.changed(run.repoId, run.branch, id);
    return this.getRun(id);
  }

  private endRun(
    id: string,
    status: 'done' | 'aborted',
    verdict: 'ready' | 'not_ready' | null,
    summary: string,
  ): void {
    this.d.store.db
      .update(testRuns)
      .set({ status, verdict, summary, waitingFor: null, endedAt: this.now() })
      .where(eq(testRuns.id, id))
      .run();
  }

  abortRun(id: string, summary = 'Stopped.'): TestRun {
    const run = this.getRun(id);
    if (run.status === 'done' || run.status === 'aborted') return run;
    this.endRun(id, 'aborted', null, summary);
    this.changed(run.repoId, run.branch, id);
    return this.getRun(id);
  }

  /**
   * Ends testing with a verdict. `ready` is refused unless the server's own readiness says so. A manual finish with
   * no open run records a run on the current HEAD.
   */
  async finish(
    repoId: string,
    branch: string,
    verdict: 'ready' | 'not_ready',
    summary: string,
    runId?: string,
  ): Promise<TestRun> {
    const st = await this.state(repoId, branch);
    if (!st.card)
      throw new TestBenchError(404, 'no_card', 'No Notion card has this Branch formula.');
    if (verdict === 'ready' && !st.readiness.ready) {
      throw new TestBenchError(422, 'not_ready', 'Not every check passed.', {
        blockers: st.readiness.blockers,
      });
    }
    if (!st.headSha)
      throw new TestBenchError(
        409,
        'no_head',
        'The branch HEAD is unknown: push it or open its workspace.',
      );
    let id = runId ?? this.openRunId(repoId, branch);
    if (id) {
      const run = this.getRun(id);
      if (run.repoId !== repoId || run.branch !== branch)
        throw new TestBenchError(404, 'run_not_found');
      if (run.headSha !== st.headSha && verdict === 'ready') {
        throw new TestBenchError(
          409,
          'head_moved',
          'The branch moved during the run: test it again.',
        );
      }
    } else {
      id = this.startRun(repoId, branch, st.headSha, 'manual', null).id;
    }
    this.endRun(id, 'done', verdict, summary);
    this.changed(repoId, branch, id);
    return this.getRun(id);
  }
}

// ── pure helpers

function bodyErrorText(e: unknown): string {
  if (e instanceof NotionApiError) {
    if (e.kind === 'not_configured') return 'Notion is not set up.';
    if (e.kind === 'rate_limited') return 'Notion is rate limiting: try again in a minute.';
    if (e.kind === 'not_found' || e.kind === 'forbidden')
      return 'The integration cannot read this page.';
    return `Notion: ${e.kind}.`;
  }
  return 'Could not read the card body.';
}

function toFinding(r: typeof testFindings.$inferSelect): Finding {
  return {
    ...r,
    severity: r.severity as Finding['severity'],
    source: r.source as Finding['source'],
    status: r.status as FindingStatus,
  };
}

function toRun(r: typeof testRuns.$inferSelect): TestRun {
  return {
    ...r,
    mode: r.mode as TestRun['mode'],
    status: r.status as TestRun['status'],
    verdict: (r.verdict as TestRun['verdict']) ?? null,
  };
}

export function testOkOf(run: TestRun | null, headSha: string | null): boolean {
  return (
    !!run &&
    run.status === 'done' &&
    run.verdict === 'ready' &&
    headSha !== null &&
    run.headSha === headSha
  );
}

/**
 * Ready = every AC passed (or excused with a reason), every fixed finding retested, and nothing open.
 * `fixing` counts as open: the agent has not landed its fix yet.
 */
export function readinessOf(
  body: CardBody | null,
  checks: AcCheck[],
  findings: Finding[],
): BenchReadiness {
  const byTarget = new Map(checks.map((c) => [c.target, c.state]));
  const ac = body?.ac ?? [];
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let untested = 0;
  for (const item of ac) {
    const s = byTarget.get(`${AC_TARGET}${item.key}`) ?? 'untested';
    if (s === 'pass' || s === 'excused') passed++;
    else if (s === 'fail') failed++;
    else if (s === 'blocked') blocked++;
    else untested++;
  }
  const regressions = findings.filter((f) => f.status === 'fixed');
  const regressionsLeft = regressions.filter(
    (f) => byTarget.get(`${FINDING_TARGET}${f.id}`) !== 'pass',
  ).length;
  const open = findings.filter((f) => f.status === 'open' || f.status === 'fixing').length;

  const blockers: string[] = [];
  if (!body) blockers.push('The card body has not been read.');
  else if (ac.length === 0) blockers.push('The card has no Acceptance Criteria.');
  if (untested) blockers.push(`${untested} AC untested`);
  if (failed) blockers.push(`${failed} AC failed`);
  if (blocked) blockers.push(`${blocked} AC blocked`);
  if (regressionsLeft)
    blockers.push(`${regressionsLeft} regression check${regressionsLeft > 1 ? 's' : ''} left`);
  if (open) blockers.push(`${open} open finding${open > 1 ? 's' : ''}`);
  return {
    ready: blockers.length === 0,
    blockers,
    counts: {
      ac: ac.length,
      passed,
      failed,
      blocked,
      untested,
      regressions: regressions.length,
      openFindings: open,
    },
  };
}
