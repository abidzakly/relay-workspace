import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { GlobalConfigPublic } from '@relay/shared';
import { PaperGrid } from '@/components/PaperGrid';
import { DoneStep } from '@/setup/notion/DoneStep';
import { ThemeSync } from '@/components/ThemeSync';
import { Button } from '@/components/ui/button';
import { describeError, post } from '@/lib/api';
import { useNotionMe, useNotionSchema, useOAuthStatus } from '@/lib/oauthApi';
import { useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';
import {
  autoMap,
  autoStages,
  groupsFromStages,
  ROLES,
  stagesFromGroups,
  type RoleKey,
  type StageKey,
} from '@/setup/notion/autoMap';
import {
  BoardPreview,
  ColumnsStep,
  ConnectStep,
  DatabasePicker,
  StatusesStep,
  TokenStep,
  YouStep,
} from '@/setup/notion/steps';

type StepKey = 'connect' | 'board' | 'columns' | 'statuses' | 'you' | 'done';
const STEPS: StepKey[] = ['connect', 'board', 'columns', 'statuses', 'you', 'done'];

const STEP_COPY: Record<StepKey, { rail: string; title: string; lede: string }> = {
  connect: {
    rail: 'Connect',
    title: 'Plug Relay into your Notion',
    lede: 'One sign-in on Notion’s own page, or a personal access token.',
  },
  board: {
    rail: 'Board',
    title: 'Which database holds your cards?',
    lede: 'Pick the board your team plans in. Relay only ever reads the cards that are yours.',
  },
  columns: {
    rail: 'Columns',
    title: 'Wire the columns',
    lede: 'Each line is something Relay reads from a card. Relay guessed the column; change any that is wrong.',
  },
  statuses: {
    rail: 'Statuses',
    title: 'How your statuses count',
    lede: 'These are the statuses your board has. Relay uses them for the merge-request flow and the KPI.',
  },
  you: {
    rail: 'You',
    title: 'Which cards are yours?',
    lede: 'Relay reads only the cards where the Developer is you.',
  },
  done: {
    rail: 'Done',
    title: 'Ready to switch on',
    lede: 'Check the wiring, then save. Run this setup again from Settings > Notion at any time.',
  },
};

interface Draft {
  dataSourceId: string;
  boardTitle: string;
  map: Partial<Record<RoleKey, string>>;
  statuses: string[];
  readyStatus: string;
  /** One stage per status; the stored status lists are derived from it on Save. */
  stages: Record<string, StageKey>;
  aliases: string;
}

function draftOf(s: GlobalConfigPublic): Draft {
  const n = s.notion;
  const map: Partial<Record<RoleKey, string>> = {};
  for (const r of ROLES) {
    const v = (n.props as Record<string, string | undefined>)[r.key];
    if (v && v !== 'auto') map[r.key] = v;
  }
  return {
    dataSourceId: n.dataSourceId ?? '',
    boardTitle: '',
    map,
    statuses: [...n.statuses],
    readyStatus: n.readyStatus,
    stages: stagesFromGroups(n.statuses, n.statusGroups),
    aliases: n.assigneeAliases.join(', '),
  };
}

/** Ready to Test must be a "with QA" status: keep the current one when it still is, else the best match. */
function pickReady(statuses: string[], stages: Record<string, StageKey>, current: string): string {
  const qa = statuses.filter((s) => stages[s] === 'qa');
  if (qa.includes(current)) return current;
  return qa.find((s) => /ready to test/i.test(s)) ?? qa[0] ?? current;
}

const splitAliases = (s: string) => [
  ...new Set(
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
/** Advanced mode reads with the saved token, so it is ready without the sign-in. */
const tokenMode = (s: GlobalConfigPublic) => s.notion.authMode === 'token';
const USER_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/**
 * Set up Notion: a full-screen walk from Connect to a saved setup. Relay reads with the active mode's credential, the
 * sign-in (Connect mode) or a personal access token (Advanced mode). Only the mode and token save early; the rest is
 * written on Save.
 */
export function NotionSetup() {
  const settings = useSettings();
  if (!settings.data) {
    return (
      <Shell>
        <p className="p-10 text-sm text-muted-foreground">
          {settings.error ? describeError(settings.error) : 'Loading…'}
        </p>
      </Shell>
    );
  }
  return <Wizard settings={settings.data} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="sb-shell">
      <ThemeSync />
      <PaperGrid />
      {children}
    </div>
  );
}

function Wizard({ settings }: { settings: GlobalConfigPublic }) {
  const navigate = useNavigate();
  const connected = !!useOAuthStatus().data?.notion.connected;
  const qc = useQueryClient();
  const viaToken = tokenMode(settings);
  // Relay can read Notion: the saved token in Advanced mode, the sign-in in Connect mode.
  const ready = viaToken ? settings.notion.tokenSet : connected;
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [at, setAt] = useState(0);
  const step = STEPS[at]!;
  const board = useNotionSchema(ready && draft.dataSourceId ? draft.dataSourceId : undefined);
  const me = useNotionMe(ready);
  const save = useSaveGlobal();
  const credential = useSaveGlobal();
  // Switch mode or store a token. Lists read with the other credential are dropped, since it sees other databases.
  const setCredential = (authMode: 'token' | 'connect', token?: string) =>
    credential.mutate(
      {
        ...(token ? { notionToken: token } : {}),
        patch: (s) => ({ ...s, notion: { ...s.notion, authMode } }),
      },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ['oauth', 'notion'] }) },
    );
  const [saved, setSaved] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  // A board (re)picked: map its columns, take its statuses. Kept choices survive when the columns still exist.
  const mappedFor = useRef<string>('');
  useEffect(() => {
    const v = board.data;
    if (!v || mappedFor.current === v.dataSourceId) return;
    mappedFor.current = v.dataSourceId;
    setDraft((d) => {
      const map = autoMap(v.props, d.map);
      const options = v.props.find((p) => p.name === map.status)?.options ?? [];
      const sameStatuses = options.length > 0 && d.statuses.every((s) => options.includes(s));
      const statuses = options.length ? options : d.statuses;
      const stages = sameStatuses ? { ...autoStages(statuses), ...d.stages } : autoStages(statuses);
      return {
        ...d,
        boardTitle: v.title,
        map,
        statuses,
        stages,
        readyStatus: pickReady(statuses, stages, d.readyStatus),
      };
    });
  }, [board.data]);

  // The signed-in user: fill "My names" with the id (and name, email) when it holds no user id yet.
  useEffect(() => {
    const m = me.data;
    if (!m) return;
    setDraft((d) =>
      USER_ID.test(d.aliases)
        ? d
        : {
            ...d,
            aliases: splitAliases(
              [m.id, m.name ?? '', m.email ?? '', d.aliases].filter(Boolean).join(', '),
            ).join(', '),
          },
    );
  }, [me.data]);

  useEffect(() => {
    stage.current?.focus({ preventScroll: true });
    stage.current?.scrollTo?.({ top: 0 });
  }, [at]);

  const missingRequired = ROLES.filter((r) => r.required && !draft.map[r.key]);
  const canGo: Record<StepKey, boolean> = useMemo(
    () => ({
      connect: ready,
      board: !!draft.dataSourceId && !!board.data,
      columns: !!board.data && missingRequired.length === 0,
      statuses: draft.stages[draft.readyStatus] === 'qa',
      you: USER_ID.test(draft.aliases),
      done: true,
    }),
    [ready, draft, board.data, missingRequired.length],
  );

  const onSave = () => {
    const groups = groupsFromStages(draft.statuses, draft.stages);
    save.mutate(
      {
        patch: (s) => ({
          ...s,
          notion: {
            ...s.notion,
            dataSourceId: draft.dataSourceId,
            props: {
              ...s.notion.props,
              ...Object.fromEntries(
                ROLES.map((r) => [
                  r.key,
                  draft.map[r.key] ?? (s.notion.props as Record<string, string>)[r.key],
                ]),
              ),
            },
            statuses: draft.statuses,
            readyStatus: draft.readyStatus,
            assigneeAliases: splitAliases(draft.aliases),
            statusGroups: groups,
          },
        }),
      },
      {
        onSuccess: () => {
          setSaved(true);
          void post('/api/sync/refresh').catch(() => undefined);
        },
      },
    );
  };

  const copy = STEP_COPY[step];
  const progress = saved ? 1 : at / (STEPS.length - 1);

  return (
    <Shell>
      <div className={cn('sb-layout', saved && 'sb-saved')}>
        <nav className="sb-rail" aria-label="Setup steps">
          <div className="sb-rail-head">
            <Link
              to="/settings#notion"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back to Settings
            </Link>
            <p className="sb-mark">
              <span>Notion</span>
              <span className="sb-mark-wire" aria-hidden />
              <span>Relay</span>
            </p>
          </div>
          <ol className="sb-steps" style={{ '--sb-progress': progress } as React.CSSProperties}>
            <span className="sb-cable" aria-hidden>
              <span className="sb-cable-fill" />
            </span>
            {STEPS.map((k, i) => {
              const state = saved || i < at ? 'done' : i === at ? 'now' : 'next';
              const reachable = i <= at || STEPS.slice(0, i).every((s) => canGo[s]);
              return (
                <li key={k} data-state={state}>
                  <button
                    type="button"
                    className="sb-step"
                    disabled={!reachable || saved}
                    aria-current={i === at ? 'step' : undefined}
                    onClick={() => setAt(i)}
                  >
                    <span className="sb-node" aria-hidden />
                    <span>{STEP_COPY[k].rail}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="sb-stage" ref={stage} tabIndex={-1}>
          <header className="sb-head">
            <h1 className="sb-title">{saved ? 'Relay is reading your cards' : copy.title}</h1>
            <p className="sb-lede">
              {saved ? 'Your setup is saved. The board fills in over the next minute.' : copy.lede}
            </p>
          </header>

          <section className="sb-body" aria-live="polite">
            {saved ? (
              <div className="flex flex-wrap gap-3">
                <Button size="lg" onClick={() => navigate('/board')}>
                  Open the board
                </Button>
                <Button variant="ghost" size="lg" onClick={() => navigate('/settings#notion')}>
                  Back to Settings
                </Button>
              </div>
            ) : step === 'connect' ? (
              viaToken ? (
                <TokenStep
                  tokenSet={settings.notion.tokenSet}
                  saving={credential.isPending}
                  error={credential.error}
                  onSave={(t) => setCredential('token', t)}
                  onUseSignIn={() => setCredential('connect')}
                />
              ) : (
                <ConnectStep connected={connected} onUseToken={() => setCredential('token')} />
              )
            ) : step === 'board' ? (
              <div className="grid gap-8">
                <DatabasePicker
                  label="Board database"
                  value={draft.dataSourceId}
                  onPick={(d) =>
                    setDraft((x) => ({ ...x, dataSourceId: d.id, boardTitle: d.title }))
                  }
                />
                {board.isFetching && !board.data ? (
                  <p className="text-sm text-muted-foreground">Reading the columns…</p>
                ) : null}
                {board.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {describeError(board.error)}
                  </p>
                ) : null}
                <BoardPreview view={board.data} />
              </div>
            ) : step === 'columns' && board.data ? (
              <ColumnsStep
                view={board.data}
                map={draft.map}
                onChange={(role, column) =>
                  setDraft((d) => ({ ...d, map: { ...d.map, [role]: column } }))
                }
              />
            ) : step === 'statuses' ? (
              <StatusesStep
                options={draft.statuses}
                stages={draft.stages}
                ready={draft.readyStatus}
                onReady={(s) => setDraft((d) => ({ ...d, readyStatus: s }))}
                onStage={(s, stage) =>
                  setDraft((d) => {
                    const stages = { ...d.stages, [s]: stage };
                    return {
                      ...d,
                      stages,
                      readyStatus: pickReady(d.statuses, stages, d.readyStatus),
                    };
                  })
                }
              />
            ) : step === 'you' ? (
              <YouStep
                me={me.data}
                meError={me.error}
                boardId={draft.dataSourceId}
                assigneeColumn={draft.map.assignee}
                aliases={draft.aliases}
                onChange={(v) => setDraft((d) => ({ ...d, aliases: v }))}
              />
            ) : step === 'done' ? (
              <DoneStep
                view={board.data}
                boardTitle={draft.boardTitle || board.data?.title || ''}
                map={draft.map}
                statuses={draft.statuses}
                stages={draft.stages}
                readyStatus={draft.readyStatus}
                aliases={draft.aliases}
                me={me.data}
                onEdit={(k) => setAt(Math.max(0, STEPS.indexOf(k)))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Pick a board first.</p>
            )}
          </section>

          {saved ? null : (
            <footer className="sb-foot">
              <Button
                variant="ghost"
                disabled={at === 0}
                onClick={() => setAt((i) => Math.max(0, i - 1))}
              >
                Back
              </Button>
              {step === 'done' ? (
                <button
                  type="button"
                  className="sb-switch"
                  data-on={save.isPending}
                  disabled={save.isPending}
                  onClick={onSave}
                >
                  <span className="sb-switch-track" aria-hidden>
                    <span className="sb-switch-knob" />
                  </span>
                  {save.isPending ? 'Switching on…' : 'Switch on and start reading'}
                </button>
              ) : (
                <Button size="lg" disabled={!canGo[step]} onClick={() => setAt((i) => i + 1)}>
                  Continue
                </Button>
              )}
              {step === 'columns' && missingRequired.length ? (
                <span className="text-sm text-muted-foreground">
                  Still to connect: {missingRequired.map((r) => r.label.toLowerCase()).join(', ')}.
                </span>
              ) : null}
              {save.error ? (
                <span role="alert" className="text-sm text-destructive">
                  {describeError(save.error)}
                </span>
              ) : null}
            </footer>
          )}
        </main>
      </div>
    </Shell>
  );
}
