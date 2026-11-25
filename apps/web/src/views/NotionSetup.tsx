import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { GlobalConfigPublic } from '@relay/shared';
import { PaperGrid } from '@/components/PaperGrid';
import { ThemeSync } from '@/components/ThemeSync';
import { Button } from '@/components/ui/button';
import { describeError, post } from '@/lib/api';
import { useNotionMe, useNotionSchema, useOAuthStatus } from '@/lib/oauthApi';
import { useSaveGlobal, useSettings } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';
import {
  autoGroups,
  autoMap,
  GROUPS,
  ROLES,
  type GroupKey,
  type RoleKey,
} from '@/setup/notion/autoMap';
import {
  BoardPreview,
  ColumnsStep,
  ConnectStep,
  DatabasePicker,
  StatusesStep,
  YouStep,
} from '@/setup/notion/steps';

type StepKey = 'connect' | 'board' | 'columns' | 'statuses' | 'you' | 'done';
const STEPS: StepKey[] = ['connect', 'board', 'columns', 'statuses', 'you', 'done'];

const STEP_COPY: Record<StepKey, { rail: string; title: string; lede: string }> = {
  connect: {
    rail: 'Connect',
    title: 'Plug Relay into your Notion',
    lede: 'One sign-in on Notion’s own page. Nothing to create or paste.',
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
  groups: Record<GroupKey, string[]>;
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
    groups: {
      complete: [...n.statusGroups.complete],
      done: [...n.statusGroups.done],
      inactive: [...n.statusGroups.inactive],
      uncommitted: [...n.statusGroups.uncommitted],
    },
    aliases: n.assigneeAliases.join(', '),
  };
}

const splitAliases = (s: string) => [
  ...new Set(
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
const USER_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;

/**
 * Set up Notion through the sign-in: a full-screen walk from Connect to a saved setup. Nothing is written until Save;
 * the result is the normal Notion settings (and Connect mode). Advanced mode in Settings > Notion is the by-hand way.
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
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [at, setAt] = useState(0);
  const step = STEPS[at]!;
  // The wizard works on the sign-in, so the schema reads need Connect mode on the server.
  const modeReady = settings.notion.authMode === 'connect';
  const board = useNotionSchema(
    connected && modeReady && draft.dataSourceId ? draft.dataSourceId : undefined,
  );
  const me = useNotionMe(connected && modeReady);
  const save = useSaveGlobal();
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
      return {
        ...d,
        boardTitle: v.title,
        map,
        statuses,
        readyStatus: statuses.includes(d.readyStatus)
          ? d.readyStatus
          : (statuses.find((s) => /ready to test/i.test(s)) ?? statuses[0] ?? d.readyStatus),
        groups: sameStatuses ? d.groups : autoGroups(statuses),
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
      connect: connected && modeReady,
      board: !!draft.dataSourceId && !!board.data,
      columns: !!board.data && missingRequired.length === 0,
      statuses: draft.statuses.includes(draft.readyStatus),
      you: USER_ID.test(draft.aliases),
      done: true,
    }),
    [connected, modeReady, draft, board.data, missingRequired.length],
  );

  const onSave = () => {
    const keep = (xs: string[]) => xs.filter((x) => draft.statuses.includes(x));
    save.mutate(
      {
        patch: (s) => ({
          ...s,
          notion: {
            ...s.notion,
            authMode: 'connect',
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
            statusGroups: {
              complete: keep(draft.groups.complete),
              done: keep(draft.groups.done),
              inactive: keep(draft.groups.inactive),
              uncommitted: keep(draft.groups.uncommitted),
            },
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
              <div className="grid gap-4">
                <ConnectStep connected={connected} />
                {!modeReady ? (
                  <p role="alert" className="text-sm text-destructive">
                    Advanced mode is on, so Relay uses the integration token. Turn Advanced mode off
                    in <Link to="/settings#notion">Settings &gt; Notion</Link> to set up through the
                    sign-in.
                  </p>
                ) : null}
              </div>
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
                ready={draft.readyStatus}
                groups={draft.groups}
                onReady={(s) => setDraft((d) => ({ ...d, readyStatus: s }))}
                onToggle={(g, s) =>
                  setDraft((d) => ({
                    ...d,
                    groups: {
                      ...d.groups,
                      [g]: d.groups[g].includes(s)
                        ? d.groups[g].filter((x) => x !== s)
                        : [...d.groups[g], s],
                    },
                  }))
                }
              />
            ) : step === 'you' ? (
              <YouStep
                me={me.data}
                meError={me.error}
                aliases={draft.aliases}
                onChange={(v) => setDraft((d) => ({ ...d, aliases: v }))}
              />
            ) : step === 'done' ? (
              <Summary draft={draft} />
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
                <Button size="lg" disabled={save.isPending} onClick={onSave}>
                  {save.isPending ? 'Saving…' : 'Save and start reading'}
                </Button>
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

function Summary({ draft }: { draft: Draft }) {
  const rows: [string, string][] = [
    ['Board', draft.boardTitle || draft.dataSourceId || 'not picked'],
    ...ROLES.filter((r) => draft.map[r.key]).map((r): [string, string] => [
      r.label,
      draft.map[r.key]!,
    ]),
    ['Ready for QA', draft.readyStatus],
    ...GROUPS.map((g): [string, string] => [g.label, draft.groups[g.key].join(', ') || 'none']),
    ['My names', draft.aliases || 'not set'],
  ];
  return (
    <dl className="sb-summary">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
