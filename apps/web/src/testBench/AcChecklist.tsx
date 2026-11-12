import { Ban, Bot, Check, CircleSlash, History, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { AcCheck, AcItem, AcState, Finding, TestBenchState } from '@relay/shared';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/api';
import { evidenceUrl, useDeleteFinding, useSetCheck, useUpdateFinding } from '@/lib/testBenchApi';
import { cn } from '@/lib/utils';

/**
 * The left column of the Test Bench: the card's Acceptance Criteria, the regression checks of
 * fixed findings, and the findings themselves. Every state has an icon and a word, never colour alone. Ticks are
 * stored in this app only; Notion's own checkbox is shown as "QA ticked" and never written.
 */

const STATES: {
  state: Exclude<AcState, 'untested' | 'excused'>;
  label: string;
  icon: typeof Check;
  on: string;
}[] = [
  { state: 'pass', label: 'Pass', icon: Check, on: 'bg-moss/15 text-success border-moss/50' },
  {
    state: 'fail',
    label: 'Fail',
    icon: X,
    on: 'bg-destructive/10 text-destructive border-destructive/40',
  },
  {
    state: 'blocked',
    label: 'Blocked',
    icon: Ban,
    on: 'bg-warning/15 text-warning border-warning/40',
  },
];

function StateButtons({
  current,
  onSet,
  disabled,
}: {
  current: AcState;
  onSet: (s: AcState) => void;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-label="Result" className="flex shrink-0 gap-1">
      {STATES.map(({ state, label, icon: Icon, on }) => {
        const active = current === state;
        return (
          <button
            key={state}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onSet(active ? 'untested' : state)}
            className={cn(
              'tactile flex h-8 items-center gap-1 rounded-control border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
              active ? on : 'border-transparent text-muted-foreground hover:bg-muted',
            )}
          >
            <Icon aria-hidden className="size-3.5" />
            <span className={cn(!active && 'sr-only sm:not-sr-only')}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function CheckMeta({ check, headSha }: { check: AcCheck | undefined; headSha: string | null }) {
  if (!check || check.state === 'untested') return null;
  const stale = check.verifiedSha !== null && headSha !== null && check.verifiedSha !== headSha;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {check.by === 'ai' && (
        <Badge variant="outline">
          <Bot aria-hidden /> AI
        </Badge>
      )}
      {stale && (
        <Badge variant="warning">
          <History aria-hidden /> Changed since verified
        </Badge>
      )}
      {check.note && <span className="min-w-0 [overflow-wrap:anywhere]">“{check.note}”</span>}
      {check.evidencePath && (
        <a
          href={evidenceUrl(check.evidencePath)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Screen
        </a>
      )}
    </span>
  );
}

function AcRow({
  item,
  check,
  headSha,
  selected,
  onSelect,
  onSet,
  busy,
  hasFrame,
}: {
  item: AcItem;
  check: AcCheck | undefined;
  headSha: string | null;
  selected: boolean;
  onSelect: () => void;
  onSet: (s: AcState, note?: string) => void;
  busy: boolean;
  hasFrame: boolean;
}) {
  const [excusing, setExcusing] = useState(false);
  const [reason, setReason] = useState(check?.state === 'excused' ? check.note : '');
  const state = check?.state ?? 'untested';
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] gap-2 rounded-surface border p-3 transition-colors',
        selected ? 'border-primary bg-primary/5' : 'bg-card',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="min-w-0 flex-1 text-left text-sm [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {item.text}
          <span className="mt-1 flex flex-wrap gap-1.5">
            {item.notionChecked && <Badge variant="outline">QA ticked in Notion</Badge>}
            {hasFrame && <Badge variant="outline">Figma frame</Badge>}
            {state === 'excused' && (
              <Badge variant="outline">
                <CircleSlash aria-hidden /> Not applicable
              </Badge>
            )}
          </span>
        </button>
        <StateButtons current={state} onSet={(s) => onSet(s)} disabled={busy} />
      </div>
      <CheckMeta check={check} headSha={headSha} />
      {item.reason && <p className="text-xs text-muted-foreground">Notion note: {item.reason}</p>}
      {excusing ? (
        <form
          className="grid grid-cols-[minmax(0,1fr)] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length < 3) return;
            onSet('excused', reason.trim());
            setExcusing(false);
          }}
        >
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why does this AC not apply to this branch?"
            className="min-h-14"
            maxLength={1000}
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={reason.trim().length < 3}>
              Save reason
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setExcusing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        state !== 'excused' && (
          <button
            type="button"
            className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setExcusing(true)}
          >
            Not applicable…
          </button>
        )
      )}
    </li>
  );
}

const SEVERITY_BADGE: Record<Finding['severity'], 'destructive' | 'warning' | 'outline'> = {
  blocker: 'destructive',
  major: 'warning',
  minor: 'outline',
  cosmetic: 'outline',
};
const STATUS_LABEL: Record<Finding['status'], string> = {
  open: 'Open',
  fixing: 'Agent fixing',
  fixed: 'Fixed, retest',
  verified: 'Verified',
  wontfix: "Won't fix",
};

function FindingRow({
  f,
  repo,
  branch,
  onEdit,
  acText,
}: {
  f: Finding;
  repo: string;
  branch: string;
  onEdit: () => void;
  acText: string | null;
}) {
  const update = useUpdateFinding(repo, branch);
  const remove = useDeleteFinding(repo, branch);
  const done = f.status === 'verified' || f.status === 'wontfix';
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-surface border bg-card p-3',
        done && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{f.title}</p>
        <Badge variant={SEVERITY_BADGE[f.severity]}>{f.severity}</Badge>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{STATUS_LABEL[f.status]}</span>
        {f.source === 'ai' && (
          <Badge variant="outline">
            <Bot aria-hidden /> Found by AI
          </Badge>
        )}
        {acText && <span className="min-w-0 truncate">· AC: {acText}</span>}
      </p>
      {f.actual && <p className="text-xs [overflow-wrap:anywhere]">Actual: {f.actual}</p>}
      {f.screenshotPath && (
        <a
          href={evidenceUrl(f.screenshotPath)}
          target="_blank"
          rel="noopener noreferrer"
          className="justify-self-start text-xs underline"
        >
          Screen when found
        </a>
      )}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        {f.status === 'open' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: f.id, patch: { status: 'wontfix' } })}
          >
            <CircleSlash className="size-3.5" /> Won't fix
          </Button>
        )}
        {done && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: f.id, patch: { status: 'open' } })}
          >
            Reopen
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete finding ${f.title}`}
          onClick={() => {
            if (window.confirm(`Delete the finding “${f.title}”?`)) remove.mutate(f.id);
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {(update.error || remove.error) && (
        <p className="text-xs text-destructive">{describeError(update.error ?? remove.error)}</p>
      )}
    </li>
  );
}

export function AcChecklist({
  repo,
  branch,
  st,
  selectedKey,
  onSelect,
  onAddFinding,
  onEditFinding,
}: {
  repo: string;
  branch: string;
  st: TestBenchState;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onAddFinding: (acKey: string | null) => void;
  onEditFinding: (f: Finding) => void;
}) {
  const setCheck = useSetCheck(repo, branch);
  const checks = new Map(st.checks.map((c) => [c.target, c]));
  const ac = st.body?.ac ?? [];
  const sections = new Map<string, AcItem[]>();
  for (const item of ac) {
    const k = item.section ?? 'Acceptance Criteria';
    sections.set(k, [...(sections.get(k) ?? []), item]);
  }
  const regressions = st.findings.filter((f) => f.status === 'fixed');
  const findings = st.findings.filter((f) => f.status !== 'fixed');
  const acText = (key: string | null) =>
    key ? (ac.find((a) => a.key === key)?.text ?? null) : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-5">
      {ac.length === 0 && st.body && (
        <p className="rounded-surface border border-dashed p-4 text-sm text-muted-foreground">
          No Acceptance Criteria found in the card. Add to-dos under an “Acceptance Criteria”
          heading in Notion, then refresh.
        </p>
      )}
      {[...sections].map(([title, items]) => (
        <section key={title} className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <h2 className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            {title}
          </h2>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {items.map((item) => (
              <AcRow
                key={item.key}
                item={item}
                check={checks.get(`ac:${item.key}`)}
                headSha={st.headSha}
                selected={selectedKey === item.key}
                onSelect={() => onSelect(item.key)}
                hasFrame={!!st.frames[item.key]}
                busy={setCheck.isPending && setCheck.variables?.target === `ac:${item.key}`}
                onSet={(state, note) => {
                  setCheck.mutate({ target: `ac:${item.key}`, state, ...(note ? { note } : {}) });
                  if (state === 'fail') onAddFinding(item.key);
                }}
              />
            ))}
          </ul>
        </section>
      ))}

      {regressions.length > 0 && (
        <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <h2 className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Regression checks
          </h2>
          <p className="text-xs text-muted-foreground">
            Fixed by a commit. Check them again on the phone.
          </p>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {regressions.map((f) => {
              const check = checks.get(`finding:${f.id}`);
              return (
                <li key={f.id} className="grid gap-2 rounded-surface border bg-card p-3">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{f.title}</p>
                    <StateButtons
                      current={check?.state ?? 'untested'}
                      disabled={setCheck.isPending}
                      onSet={(state) => setCheck.mutate({ target: `finding:${f.id}`, state })}
                    />
                  </div>
                  <CheckMeta check={check} headSha={st.headSha} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
            Findings
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => onAddFinding(selectedKey)}
          >
            <Plus className="size-4" /> Log a finding
          </Button>
        </div>
        {findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing logged.</p>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {findings.map((f) => (
              <FindingRow
                key={f.id}
                f={f}
                repo={repo}
                branch={branch}
                acText={acText(f.acKey)}
                onEdit={() => onEditFinding(f)}
              />
            ))}
          </ul>
        )}
      </section>
      {setCheck.error && (
        <p className="text-sm text-destructive">{describeError(setCheck.error)}</p>
      )}
    </div>
  );
}
