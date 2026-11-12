import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFigmaUrl,
  type AcState,
  type AdbInput,
  type BenchAct,
  type CursorTestModel,
  type UiNode,
  type UiTree,
  type TestRunEngine,
  type FindingInput,
  type TestRun,
} from '@relay/shared';
import type { ConfigStore } from '../../config/store';
import type { Logger } from '../../util/logger';
import { ActionError } from '../actionError';
import type { CockpitHost } from '../cockpit/host';
import type { CockpitSessionService } from '../cockpit/sessionService';
import type { WorkspaceService } from '../cockpit/workspaces';
import type { DeviceHost } from '../device/deviceHost';
import { nodeCenter, nodeLabel, treeSignature } from '../device/uiTree';
import type { FigmaService } from '../figma/figmaService';
import type { Notifier } from '../notifier';
import { branchHints, diffScreens, findText, flutterErrorLines, formatScreen } from './aiObserve';
import { aiTestPrompt } from './aiPrompt';
import type { TestBenchService } from './testBench';

/**
 * AI device test runs. Starts the app on the phone, then a Claude session whose only hands are
 * the `bench` MCP tools; those call back into the routes below with a token that is valid for this run only and dies
 * with it. Ticks and findings go through the same TestBenchService as a human's, marked `by: ai`. The verdict is
 * computed from them by the server; the agent's own summary never decides it.
 */

const RUN_MAX_MS = 45 * 60_000;
const HUMAN_WAIT_MS = 10 * 60_000;
const VM_RE = /Dart VM Service[^\n]*?available at:\s*(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/;
/** Actions per AC or regression check before the server marks it blocked and moves on. */
const AC_BUDGET = 25;
const NOTES_MAX = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Packages that are never the app under test (launcher, settings, system dialogs). */
const SYSTEM_PKG_RE = /launcher|^com\.android\.|^com\.google\.android\.(?!apps\.)|^android$/;

interface Current {
  target: string;
  actions: number;
  asserts: number;
  /** The tester looked at the screen (observe, an action or an assert) since this item was handed out. */
  looked: boolean;
}

interface BenchItem {
  target: string;
  kind: 'acceptance criterion' | 'regression check';
  text: string;
  section: string | null;
  expected: string | null;
  steps: string | null;
  hasFigmaFrame: boolean;
}

interface Live {
  run: TestRun;
  token: Buffer;
  workspaceId: string;
  sessionId: string | null;
  flutterSessionId: string | null;
  timer: NodeJS.Timeout;
  waiting: { resolve: (helped: boolean) => void; timer: NodeJS.Timeout } | null;
  shots: number;
  /** The last screen read and its fingerprint: element numbers refer to it. */
  tree: UiTree | null;
  sig: string | null;
  /** Package of the app under test, learned from the first screen read with a non-system app in front. */
  pkg: string | null;
  /** Read position in the `flutter run` output; null = not read yet (startup errors still count). */
  flutterOffset: number | null;
  flutterExited: boolean;
  /** logcat mark (device epoch seconds). */
  logSince: number | null;
  /** Flutter errors read while waiting for a hot restart, handed out with the next answer. */
  pendingErrors: string[];
  current: Current | null;
  served: Set<string>;
  marked: Set<string>;
  hints: ReturnType<typeof branchHints> | null;
}

export interface AiRunDeps {
  bench: TestBenchService;
  config: ConfigStore;
  host: Pick<CockpitHost, 'sessionAttach' | 'sessions' | 'sessionInput' | 'wsDiff'>;
  workspaces: Pick<WorkspaceService, 'ref'>;
  sessions: Pick<CockpitSessionService, 'start' | 'startTestRun' | 'prompt' | 'kill'>;
  devices: DeviceHost;
  figma?: FigmaService;
  notifier?: Notifier;
  prepareBranch: (
    repoId: string,
    branch: string,
    base: string,
  ) => Promise<{ workspaceId: string } | null>;
  /** `http://127.0.0.1:<port>` as seen from the Mac where the agent runs. */
  benchUrl: string;
  /** `<data dir>/testbench`: evidence screenshots. */
  evidenceDir: string;
  log: Logger;
}

/** Flip to `true` to take the AI device tester away again. */
export const AI_TESTING_PAUSED = false;
export class AiRunService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly d: AiRunDeps) {}

  // ── run lifecycle (dashboard UI)

  async start(
    repoId: string,
    branch: string,
    serial: string,
    opts: { engine?: TestRunEngine; cursorModel?: CursorTestModel } = {},
  ): Promise<TestRun> {
    if (AI_TESTING_PAUSED) {
      throw new ActionError(409, 'ai_testing_paused', 'AI testing is paused.');
    }
    const engine = opts.engine ?? 'claude';
    const cursorModel = opts.cursorModel ?? 'auto';
    const st = await this.d.bench.state(repoId, branch);
    if (!st.card) throw new ActionError(404, 'no_card', 'No Notion card has this Branch formula.');
    if (!st.body?.ac.length)
      throw new ActionError(409, 'no_ac', 'The card has no Acceptance Criteria to test.');
    if (!st.headSha)
      throw new ActionError(409, 'no_head', 'The branch HEAD is unknown: open its workspace.');
    const phones = await this.d.devices.list();
    if (!phones.devices.some((p) => p.serial === serial && p.state === 'device')) {
      throw new ActionError(
        409,
        'device_unavailable',
        'That phone is not connected (or USB debugging is not allowed).',
      );
    }
    for (const l of this.live.values()) {
      if (l.run.repoId === repoId && l.run.branch === branch) {
        throw new ActionError(409, 'run_active', 'An AI run is already testing this branch.');
      }
    }
    const base = this.d.config.getRepo(repoId)?.baseBranch ?? 'main';
    const ws = await this.d.prepareBranch(repoId, branch, base);
    if (!ws)
      throw new ActionError(409, 'no_workspace', 'Add a cockpit workspace for this repo first.');

    const run = this.d.bench.startRun(repoId, branch, st.headSha, 'ai', serial);
    const token = randomBytes(32).toString('base64url');
    const live: Live = {
      run,
      token: Buffer.from(token),
      workspaceId: ws.workspaceId,
      sessionId: null,
      flutterSessionId: null,
      timer: setTimeout(
        () => void this.abort(run.id, 'Stopped: the run took longer than 45 minutes.'),
        RUN_MAX_MS,
      ),
      waiting: null,
      shots: 0,
      tree: null,
      sig: null,
      pkg: null,
      flutterOffset: null,
      flutterExited: false,
      logSince: null,
      pendingErrors: [],
      current: null,
      served: new Set(),
      marked: new Set(),
      hints: null,
    };
    live.timer.unref();
    this.live.set(run.id, live);

    try {
      // The app: reuse a running `flutter run` of this workspace, else start one on the phone.
      const existing = (await this.d.host.sessions()).find(
        (s) => s.workspaceId === ws.workspaceId && s.kind === 'flutter' && s.state !== 'exited',
      );
      const startApp = (flavor?: string) =>
        this.d.sessions.start({
          workspaceId: ws.workspaceId,
          kind: 'flutter',
          deviceId: serial,
          cols: 100,
          rows: 30,
          ...(flavor ? { flavor } : {}),
        });
      live.flutterSessionId =
        existing?.id ??
        (
          await startApp().catch((e: unknown) => {
            // Several flavors and none configured: a test never ships, so take the least-production one.
            const m = /^Choose a flavor: (.+)$/.exec((e as Error).message);
            if (!m) throw e;
            const flavors = m[1]!.split(',').map((f) => f.trim());
            const pick =
              ['development', 'staging', 'preprod'].find((f) => flavors.includes(f)) ?? flavors[0];
            return startApp(pick);
          })
        ).id;
      // Crashes logged before the run are not this run's: set the logcat mark now.
      live.logSince =
        (await this.d.devices.logErrors(serial, null).catch(() => null))?.last ?? null;
      const s = await this.d.sessions.startTestRun(ws.workspaceId, {
        benchUrl: this.d.benchUrl,
        token,
        runId: run.id,
        engine,
        cursorModel,
      });
      live.sessionId = s.id;
      // A TUI needs a moment before it accepts a pasted prompt.
      if (engine === 'cursor') await new Promise((r) => setTimeout(r, 2_500));
      const regressions = st.findings.filter((f) => f.status === 'fixed').length;
      await this.d.sessions.prompt(
        s.id,
        aiTestPrompt({
          card: { title: st.card.title, url: st.card.url },
          branch,
          acCount: st.body.ac.length,
          regressionCount: regressions,
        }),
      );
    } catch (e) {
      await this.abort(run.id, `Could not start: ${(e as Error).message}`);
      throw e;
    }
    return this.d.bench.getRun(run.id);
  }

  sessionOf(
    runId: string,
  ): { sessionId: string | null; workspaceId: string; flutterSessionId: string | null } | null {
    const l = this.live.get(runId);
    return l
      ? {
          sessionId: l.sessionId,
          workspaceId: l.workspaceId,
          flutterSessionId: l.flutterSessionId,
        }
      : null;
  }

  async abort(runId: string, summary = 'Stopped.'): Promise<TestRun> {
    const l = this.live.get(runId);
    if (l) {
      this.live.delete(runId);
      clearTimeout(l.timer);
      if (l.waiting) {
        clearTimeout(l.waiting.timer);
        l.waiting.resolve(false);
      }
      if (l.sessionId) await this.d.sessions.kill(l.sessionId).catch(() => {});
    }
    return this.d.bench.abortRun(runId, summary);
  }

  /** "I did it on the phone": resumes a run paused by `ask_human`. */
  resume(runId: string): TestRun {
    const l = this.live.get(runId);
    if (!l?.waiting) throw new ActionError(409, 'not_waiting', 'This run is not waiting for you.');
    clearTimeout(l.waiting.timer);
    l.waiting.resolve(true);
    l.waiting = null;
    return this.d.bench.pauseRun(runId, null);
  }

  // ── the agent's tools (token-checked)

  /** The run behind a bench-tools token, or 401. Constant-time compare. */
  auth(runId: string, token: string | undefined): Live {
    const l = this.live.get(runId);
    const got = Buffer.from(token ?? '');
    if (!l || got.length !== l.token.length || !timingSafeEqual(got, l.token)) {
      throw new ActionError(401, 'bad_run_token', 'Unknown run or token.');
    }
    return l;
  }

  async context(l: Live) {
    const st = await this.d.bench.state(l.run.repoId, l.run.branch);
    const items = await this.items(l);
    if (!l.hints) l.hints = await this.branchChanges(l);
    return {
      card: st.card,
      branch: l.run.branch,
      device: l.run.deviceSerial,
      vmServiceUri: await this.vmServiceUri(l).catch(() => null),
      toTest: {
        acceptanceCriteria: items.filter((i) => i.kind === 'acceptance criterion').length,
        regressionChecks: items.filter((i) => i.kind === 'regression check').length,
        howTo: 'Call next_ac to get them one at a time.',
      },
      branchChanges: l.hints,
      notesFromEarlierRuns: await this.readNotes(l.run.repoId),
    };
  }

  /** Everything this run must give a result: the AC in card order, then the regression checks. */
  private async items(l: Live): Promise<BenchItem[]> {
    const st = await this.d.bench.state(l.run.repoId, l.run.branch);
    const figmaLinked = !!(st.body?.figmaUrl && parseFigmaUrl(st.body.figmaUrl)?.nodeId);
    return [
      ...(st.body?.ac ?? []).map((a): BenchItem => ({
        target: `ac:${a.key}`,
        kind: 'acceptance criterion',
        text: a.text,
        section: a.section,
        expected: null,
        steps: null,
        hasFigmaFrame: !!st.frames[a.key] || figmaLinked,
      })),
      ...st.findings
        .filter((f) => f.status === 'fixed')
        .map((f): BenchItem => ({
          target: `finding:${f.id}`,
          kind: 'regression check',
          text: f.title,
          section: null,
          expected: f.expected || null,
          steps: f.steps || null,
          hasFigmaFrame: false,
        })),
    ];
  }

  /** What the branch adds (strings, keys, routes, widgets), from its diff against the base. */
  private async branchChanges(l: Live): Promise<ReturnType<typeof branchHints> | null> {
    const ref = this.d.workspaces.ref(l.workspaceId);
    const base = this.d.config.getRepo(l.run.repoId)?.baseBranch ?? 'main';
    for (const b of [`origin/${base}`, base]) {
      try {
        return branchHints((await this.d.host.wsDiff(ref, 'branch', b)).files);
      } catch {
        /* try the next base */
      }
    }
    return null;
  }

  // ── harness-driven loop

  /** The next item to test, one at a time. An item handed out stays current until it is marked. */
  async nextAc(l: Live) {
    const items = await this.items(l);
    const pos = (t: string) => items.findIndex((i) => i.target === t) + 1;
    const left = (t: string) =>
      items.filter((i) => !l.marked.has(i.target) && i.target !== t).length;
    if (l.current && !l.marked.has(l.current.target)) {
      const it = items.find((i) => i.target === l.current!.target);
      if (it) {
        return {
          ...it,
          position: `${pos(it.target)} of ${items.length}`,
          actionsLeft: AC_BUDGET - l.current.actions,
          note: 'Still open: mark this one (pass, fail or blocked) before moving on.',
        };
      }
    }
    const next = items.find((i) => !l.marked.has(i.target));
    if (!next) return { done: true, message: 'Every item has a result. Call finish.' };
    l.current = { target: next.target, actions: 0, asserts: 0, looked: false };
    l.served.add(next.target);
    return {
      ...next,
      position: `${pos(next.target)} of ${items.length}`,
      actionsLeft: AC_BUDGET,
      itemsLeftAfterThis: left(next.target),
    };
  }

  // ── seeing the phone

  private async readTree(l: Live): Promise<{ tree: UiTree; sig: string }> {
    const tree = await this.d.devices.uiTree(l.run.deviceSerial!);
    if (!l.pkg && tree.pkg && tree.nodes.length && !SYSTEM_PKG_RE.test(tree.pkg)) l.pkg = tree.pkg;
    return { tree, sig: treeSignature(tree) };
  }

  /** Reads the screen until two reads agree (animations, loading), at most 4 reads. */
  private async settle(l: Live): Promise<{ tree: UiTree; sig: string }> {
    await sleep(350);
    let cur = await this.readTree(l);
    for (let i = 0; i < 3; i++) {
      await sleep(300);
      const next = await this.readTree(l);
      if (next.sig === cur.sig) return next;
      cur = next;
    }
    return cur;
  }

  private remember(l: Live, r: { tree: UiTree; sig: string }): void {
    l.tree = r.tree;
    l.sig = r.sig;
    if (l.current) l.current.looked = true;
  }

  /** New `flutter run` output since the last read, `waitMs` long. Advances the read position. */
  private async readFlutter(l: Live, waitMs: number): Promise<string> {
    if (!l.flutterSessionId) return '';
    const since = l.flutterOffset ?? 0;
    let end = since;
    let text = '';
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), waitMs);
    try {
      await this.d.host.sessionAttach(
        l.flutterSessionId,
        since,
        (e) => {
          if (e.t === 'data') {
            text += e.data;
            end = Math.max(end, e.offset + e.data.length);
          } else if (e.t === 'exit' && !l.flutterExited) {
            l.flutterExited = true;
            l.pendingErrors.push(
              'The `flutter run` session ended: the app crashed or lost its connection. Try restart_app.',
            );
          }
        },
        abort.signal,
      );
    } catch {
      /* aborted on purpose, or the session is gone */
    } finally {
      clearTimeout(t);
    }
    l.flutterOffset = end;
    return text;
  }

  /** Flutter exceptions and Android crashes since the last call. */
  private async appErrors(l: Live): Promise<string[]> {
    const out = l.pendingErrors.splice(0);
    out.push(...flutterErrorLines(await this.readFlutter(l, 400)));
    const log = await this.d.devices.logErrors(l.run.deviceSerial!, l.logSince).catch(() => null);
    if (log) {
      if (l.logSince !== null) out.push(...log.lines);
      l.logSince = log.last;
    }
    return [...new Set(out)];
  }

  private errorBlock(errors: string[]): string {
    return errors.length
      ? `APP ERRORS since your last step (report each as a finding unless it is clearly unrelated):\n${errors.map((e) => `  ! ${e}`).join('\n')}`
      : 'No new app errors.';
  }

  /** The screen as text and image. Element numbers in the text are what tap_element and type_into take. */
  async observe(l: Live): Promise<{ text: string; png: string }> {
    const [read, png] = await Promise.all([
      this.readTree(l).catch((e: unknown) => e as Error),
      this.d.devices.screenshot(l.run.deviceSerial!),
    ]);
    const errors = await this.appErrors(l);
    let screen: string;
    if (read instanceof Error) {
      l.tree = null;
      l.sig = null;
      if (l.current) l.current.looked = true;
      screen = `${read.message}\nNo element list: use the screenshot and pixel tap/swipe.`;
    } else {
      this.remember(l, read);
      screen = formatScreen(read.tree);
    }
    return {
      text: [screen, this.errorBlock(errors), this.budgetLine(l)].filter(Boolean).join('\n\n'),
      png: png.toString('base64'),
    };
  }

  async screenshot(l: Live): Promise<Buffer> {
    if (l.current) l.current.looked = true;
    return this.d.devices.screenshot(l.run.deviceSerial!);
  }

  private budgetLine(l: Live): string {
    return l.current
      ? `Testing ${l.current.target}: ${AC_BUDGET - l.current.actions} actions left.`
      : 'No item open: call next_ac.';
  }

  private node(l: Live, n: number): UiNode {
    if (!l.tree) {
      throw new ActionError(409, 'observe_first', 'No element list yet: call observe first.');
    }
    const node = l.tree.nodes.find((x) => x.n === n);
    if (!node) {
      throw new ActionError(
        404,
        'no_element',
        `There is no element [${n}] on the last screen read (it has ${l.tree.nodes.length}). Numbers change after every action: use the latest list.`,
      );
    }
    return node;
  }

  private input(l: Live, ev: AdbInput): Promise<void> {
    return this.d.devices.input(l.run.deviceSerial!, ev);
  }

  /**
   * One action, then the screen once it settles, what changed, and new app errors. Counts against the open item's
   * budget; when the budget is spent the item is marked blocked and the action refused.
   */
  async act(l: Live, a: BenchAct): Promise<{ text: string; png: string | null }> {
    const cur = l.current && !l.marked.has(l.current.target) ? l.current : null;
    if (cur) {
      if (cur.actions >= AC_BUDGET) {
        await this.mark(
          l,
          cur.target,
          'blocked',
          `Stopped after ${AC_BUDGET} actions without a result.`,
        );
        throw new ActionError(
          409,
          'budget_used',
          `${cur.target} used its ${AC_BUDGET} actions and is now marked blocked. Call next_ac.`,
        );
      }
      cur.actions++;
    }
    const before = l.tree;
    const sigBefore = l.sig;
    const note = await this.perform(l, a);
    let after: { tree: UiTree; sig: string } | Error;
    try {
      after = await this.settle(l);
    } catch (e) {
      after = e as Error;
    }
    const errors = await this.appErrors(l);
    if (after instanceof Error) {
      l.tree = null;
      l.sig = null;
      const png = await this.d.devices.screenshot(l.run.deviceSerial!).catch(() => null);
      return {
        text: [
          note,
          `${after.message} The screenshot is attached instead.`,
          this.errorBlock(errors),
          this.budgetLine(l),
        ].join('\n\n'),
        png: png ? png.toString('base64') : null,
      };
    }
    this.remember(l, after);
    return {
      text: [
        note,
        diffScreens(before, after.tree, sigBefore, after.sig),
        this.errorBlock(errors),
        formatScreen(after.tree),
        this.budgetLine(l),
      ].join('\n\n'),
      png: after.tree.nodes.length
        ? null
        : (await this.d.devices.screenshot(l.run.deviceSerial!)).toString('base64'),
    };
  }

  private async perform(l: Live, a: BenchAct): Promise<string> {
    switch (a.kind) {
      case 'tap_element': {
        const n = this.node(l, a.n);
        const { x, y } = nodeCenter(n);
        await this.input(l, { kind: 'tap', x, y });
        return `Tapped [${n.n}] ${nodeLabel(n) ? `"${nodeLabel(n)}"` : '(no label)'} at ${x},${y}.${n.enabled ? '' : ' It is disabled.'}`;
      }
      case 'type_into': {
        const n = this.node(l, a.n);
        const { x, y } = nodeCenter(n);
        await this.input(l, { kind: 'tap', x, y });
        await sleep(300);
        if (a.clear) {
          await this.input(l, {
            kind: 'clear',
            chars: Math.min(500, Math.max(n.text.length, 1) + 5),
          });
        }
        await this.input(l, { kind: 'text', text: a.text });
        return `Typed "${a.text}" into [${n.n}]. The keyboard may now cover the bottom of the screen: press back to close it.`;
      }
      case 'scroll_until': {
        if (!l.tree) this.remember(l, await this.readTree(l));
        for (let i = 0; i <= a.maxSwipes; i++) {
          const hit = findText(l.tree!, a.text);
          if (hit.length) return `Found "${a.text}" after ${i} swipe(s).`;
          if (i === a.maxSwipes) break;
          const area = [...l.tree!.nodes]
            .filter((n) => n.scrollable)
            .sort(
              (p, q) =>
                (q.bounds[2] - q.bounds[0]) * (q.bounds[3] - q.bounds[1]) -
                (p.bounds[2] - p.bounds[0]) * (p.bounds[3] - p.bounds[1]),
            )[0]?.bounds ?? [0, 0, l.tree!.width, l.tree!.height];
          const x = Math.round((area[0] + area[2]) / 2);
          const top = Math.round(area[1] + (area[3] - area[1]) * 0.25);
          const bottom = Math.round(area[1] + (area[3] - area[1]) * 0.75);
          const [y1, y2] = a.direction === 'down' ? [bottom, top] : [top, bottom];
          const sig = l.sig;
          await this.input(l, { kind: 'swipe', x1: x, y1, x2: x, y2, ms: 350 });
          await sleep(450);
          this.remember(l, await this.readTree(l));
          if (l.sig === sig)
            return `"${a.text}" not found: reached the ${a.direction === 'down' ? 'end' : 'top'} after ${i + 1} swipe(s).`;
        }
        return `"${a.text}" not found after ${a.maxSwipes} swipes.`;
      }
      case 'wait_for': {
        const until = Date.now() + a.timeoutMs;
        for (;;) {
          const r = await this.readTree(l);
          this.remember(l, r);
          const seen = findText(r.tree, a.text).length > 0;
          if (seen !== a.gone) {
            return a.gone ? `"${a.text}" is gone.` : `"${a.text}" is on screen.`;
          }
          if (Date.now() > until) {
            return `TIMED OUT after ${a.timeoutMs} ms: "${a.text}" ${a.gone ? 'is still on screen' : 'never appeared'}.`;
          }
          await sleep(500);
        }
      }
      case 'key':
        await this.input(l, { kind: 'key', key: a.key });
        return `Pressed ${a.key}.`;
      case 'tap':
        await this.input(l, { kind: 'tap', x: a.x, y: a.y });
        return `Tapped pixel ${a.x},${a.y}.`;
      case 'swipe':
        await this.input(l, { ...a, kind: 'swipe' });
        return `Swiped ${a.x1},${a.y1} to ${a.x2},${a.y2}.`;
      case 'type_text':
        await this.input(l, { kind: 'text', text: a.text });
        return `Typed "${a.text}" into the focused field.`;
      case 'restart_app':
        return this.restartApp(l);
    }
  }

  /** Hot restart through `flutter run` when it is alive (keeps the debug connection), else force-stop and launch. */
  private async restartApp(l: Live): Promise<string> {
    const alive =
      !!l.flutterSessionId &&
      !l.flutterExited &&
      (await this.d.host.sessions()).some(
        (s) => s.id === l.flutterSessionId && s.state !== 'exited',
      );
    if (alive) {
      l.pendingErrors.push(...flutterErrorLines(await this.readFlutter(l, 300)));
      await this.d.host.sessionInput(l.flutterSessionId!, 'R');
      let text = '';
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        text += await this.readFlutter(l, 1_000);
        if (/Restarted application|Hot restart performed/i.test(text)) {
          l.pendingErrors.push(...flutterErrorLines(text));
          return 'Hot restarted the app (state reset, same build).';
        }
      }
      l.pendingErrors.push(...flutterErrorLines(text));
      return 'Sent hot restart, but `flutter run` did not confirm it within 25 s.';
    }
    if (!l.pkg) {
      throw new ActionError(
        409,
        'no_package',
        'The app package is not known yet: open the app first (observe it once).',
      );
    }
    await this.d.devices.restartApp(l.run.deviceSerial!, l.pkg);
    await sleep(1_500);
    return `Force-stopped and relaunched ${l.pkg}.`;
  }

  /** A check the server makes against the screen's elements, not the model's reading of a picture. */
  async assertText(l: Live, text: string, visible: boolean) {
    const r = await this.readTree(l);
    // Keep the element numbers the tester was given unless the screen is the same anyway.
    if (r.sig === l.sig) this.remember(l, r);
    else if (l.current) l.current.looked = true;
    const hits = findText(r.tree, text);
    const ok = visible ? hits.length > 0 : hits.length === 0;
    if (l.current) l.current.asserts++;
    const shown = r.tree.nodes.map(nodeLabel).filter(Boolean);
    return {
      ok,
      result: ok
        ? visible
          ? `PASS: "${text}" is on screen (${hits
              .map((h) => `"${nodeLabel(h)}"`)
              .slice(0, 3)
              .join(', ')}).`
          : `PASS: "${text}" is not on screen.`
        : visible
          ? `FAIL: "${text}" is not on screen. Visible labels: ${
              shown
                .slice(0, 25)
                .map((x) => `"${x}"`)
                .join(', ') || 'none'
            }. (Maybe scroll_until first.)`
          : `FAIL: "${text}" is still on screen.`,
    };
  }

  // ── memory across runs

  private notesFile(repoId: string): string {
    return join(this.d.evidenceDir, 'notes', `${repoId}.json`);
  }

  private async readNotes(repoId: string): Promise<string[]> {
    try {
      const v = JSON.parse(await readFile(this.notesFile(repoId), 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** A navigation tip for later runs on this repo ("Settings: avatar, top right"). Newest first, deduplicated. */
  async rememberNote(l: Live, note: string): Promise<{ saved: number }> {
    const notes = [
      note.trim(),
      ...(await this.readNotes(l.run.repoId)).filter((n) => n !== note.trim()),
    ].slice(0, NOTES_MAX);
    await mkdir(join(this.d.evidenceDir, 'notes'), { recursive: true });
    await writeFile(this.notesFile(l.run.repoId), JSON.stringify(notes, null, 2));
    return { saved: notes.length };
  }

  /** `ws://…/ws` of the running app's Dart VM service, read from the `flutter run` output. */
  private async vmServiceUri(l: Live): Promise<string | null> {
    if (!l.flutterSessionId) return null;
    const abort = new AbortController();
    let text = '';
    const t = setTimeout(() => abort.abort(), 1_500);
    try {
      await this.d.host.sessionAttach(
        l.flutterSessionId,
        0,
        (e) => {
          if (e.t === 'data') {
            text += e.data;
            if (VM_RE.test(text)) abort.abort();
          }
        },
        abort.signal,
      );
    } catch {
      /* aborted on purpose */
    } finally {
      clearTimeout(t);
    }
    const http = VM_RE.exec(text)?.[1];
    if (!http) return null;
    return `${http.replace(/^http/, 'ws').replace(/\/?$/, '/')}ws`;
  }

  async figmaFrame(l: Live, acKey: string): Promise<Buffer> {
    const st = await this.d.bench.state(l.run.repoId, l.run.branch);
    const link = st.body?.figmaUrl ? parseFigmaUrl(st.body.figmaUrl) : null;
    const node = st.frames[acKey] ?? link?.nodeId ?? null;
    if (!link || !node || !this.d.figma?.configured) {
      throw new ActionError(404, 'no_frame', 'This AC has no Figma frame.');
    }
    return this.d.figma.image(link.fileKey, node);
  }

  /** Saves the screen as evidence; returns the path served by `/api/test-bench/evidence/…`. */
  private async evidence(l: Live): Promise<string | null> {
    try {
      const png = await this.d.devices.screenshot(l.run.deviceSerial!);
      const name = `${String(++l.shots).padStart(3, '0')}.png`;
      await mkdir(join(this.d.evidenceDir, l.run.id), { recursive: true });
      await writeFile(join(this.d.evidenceDir, l.run.id, name), png);
      return `${l.run.id}/${name}`;
    } catch (e) {
      this.d.log.warn({ err: (e as Error).message }, 'evidence screenshot failed');
      return null;
    }
  }

  /**
   * A result for one item. A pass is refused unless the item was handed out by next_ac and the tester looked at
   * the screen since; a pass with no assert gets a warning back.
   */
  async mark(
    l: Live,
    target: string,
    state: Exclude<AcState, 'untested' | 'excused'>,
    note: string,
  ) {
    const cur = l.current?.target === target ? l.current : null;
    if (state === 'pass') {
      if (!l.served.has(target)) {
        throw new ActionError(
          409,
          'not_served',
          `Get ${target} with next_ac and check it before passing it.`,
        );
      }
      if (cur && !cur.looked) {
        throw new ActionError(
          409,
          'not_looked',
          'A pass needs something you saw: observe the screen or act first.',
        );
      }
    }
    const evidencePath = await this.evidence(l);
    const check = await this.d.bench.setCheck(l.run.repoId, l.run.branch, {
      target,
      state,
      note,
      by: 'ai',
      evidencePath,
    });
    l.marked.add(target);
    if (cur) l.current = null;
    const warning =
      state === 'pass' && cur && cur.asserts === 0
        ? 'Passed without assert_visible/assert_gone. Next time confirm the expected result with an assert before passing.'
        : null;
    return { ...check, ...(warning ? { warning } : {}), next: 'Call next_ac.' };
  }

  async finding(l: Live, input: FindingInput) {
    const screenshotPath = await this.evidence(l);
    return this.d.bench.addFinding(l.run.repoId, l.run.branch, input, {
      source: 'ai',
      screenshotPath,
    });
  }

  /** Pauses the run until the user resumes it in the dashboard (true) or 10 minutes pass (false). */
  async askHuman(l: Live, reason: string): Promise<boolean> {
    if (l.waiting) throw new ActionError(409, 'already_waiting', 'Already waiting for the user.');
    this.d.bench.pauseRun(l.run.id, reason);
    this.d.notifier?.notifyCockpit({
      event: 'agentDone',
      key: `bench-human:${l.run.id}:${Date.now()}`,
      ttlMs: 60_000,
      title: 'The AI tester needs you',
      body: reason,
      url: `/test-bench/${l.run.repoId}?branch=${encodeURIComponent(l.run.branch)}`,
      tag: `bench-${l.run.id}`,
      repoId: l.run.repoId,
      subject: null,
    });
    const helped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        l.waiting = null;
        resolve(false);
      }, HUMAN_WAIT_MS);
      timer.unref();
      l.waiting = { resolve, timer };
    });
    if (!helped && this.live.has(l.run.id)) this.d.bench.pauseRun(l.run.id, null);
    return helped;
  }

  /** Ends the run. The verdict is the server's readiness, whatever the summary says. */
  async finish(l: Live, summary: string, blockRest: string | null = null): Promise<TestRun> {
    const open = (await this.items(l)).filter((i) => !l.marked.has(i.target));
    if (open.length && !blockRest) {
      throw new ActionError(
        409,
        'unfinished',
        `${open.length} item(s) have no result yet (${open
          .slice(0, 8)
          .map((i) => i.target)
          .join(
            ', ',
          )}). Call next_ac, or finish with blockRest = the reason if the whole app is blocked.`,
      );
    }
    if (open.length && blockRest) {
      const evidencePath = await this.evidence(l);
      for (const i of open) {
        await this.d.bench.setCheck(l.run.repoId, l.run.branch, {
          target: i.target,
          state: 'blocked',
          note: blockRest,
          by: 'ai',
          evidencePath,
        });
        l.marked.add(i.target);
      }
    }
    const st = await this.d.bench.state(l.run.repoId, l.run.branch);
    const verdict = st.readiness.ready ? 'ready' : 'not_ready';
    const run = await this.d.bench.finish(l.run.repoId, l.run.branch, verdict, summary, l.run.id);
    this.live.delete(l.run.id);
    clearTimeout(l.timer);
    // The session stays open so its reasoning can be read; it has nothing left to do.
    return run;
  }
}
