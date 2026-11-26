import { ArrowRight, Bot, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  AGENT_EFFORTS,
  AI_ENGINES,
  agentModelLabel,
  type AgentEffort,
  type AiEngine,
  type AiModelChoice,
  type AiModelKey,
  type GlobalConfigPublic,
} from '@relay/shared';
import { useAiCheckStore } from '@/components/AiCheck';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useSaveGlobal } from '@/lib/settingsApi';
import { cn } from '@/lib/utils';
import { AiEngineChain } from './AiEngineChain';
import { aiFeatureGroups } from './aiFeatures';
import { ModelPicker } from './ModelPicker';
import { ErrorAlert, SectionCard } from './SectionCard';

const GROUPS = aiFeatureGroups();

const ENGINE_NAME: Record<AiEngine, string> = {
  claude_cli: 'Claude CLI',
  anthropic_api: 'Anthropic API',
  cursor_cli: 'Cursor CLI',
};

/** "Cursor CLI · Composer 2.5 Fast · high", or null when nothing is chosen. */
function choiceSummary(c: AiModelChoice): string | null {
  const parts = [
    c.engine ? ENGINE_NAME[c.engine] : null,
    c.model ? agentModelLabel(c.model) : null,
    c.effort ? `${c.effort} effort` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Settings → AI engines, read top to bottom as the route a request takes: which engine answers, which agent and models
 * a coding session uses, then the features that go their own way.
 */
export function AiCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const open = useAiCheckStore((s) => s.setOpen);
  const patchModels = (p: Partial<GlobalConfigPublic['agentModels']>) =>
    save.mutate({ patch: (s) => ({ ...s, agentModels: { ...s.agentModels, ...p } }) });
  const setChoice = (key: AiModelKey, next: AiModelChoice) =>
    save.mutate({
      patch: (s) => {
        const aiModels = { ...s.aiModels };
        if (next.engine || next.model || next.effort) aiModels[key] = next;
        else delete aiModels[key];
        return { ...s, aiModels };
      },
    });
  const overrides = GROUPS.flatMap((g) => g.features).filter((f) =>
    choiceSummary(settings.aiModels[f.key] ?? {}),
  ).length;

  return (
    <SectionCard
      id="ai"
      brand="ai"
      title="AI engines"
      description="Claude answers first; the API and then Cursor take over when it fails (for example when its usage limit is spent)."
      action={
        <Button variant="outline" onClick={() => open(true)}>
          <Bot aria-hidden="true" />
          Check connection
        </Button>
      }
    >
      <Block title="Engines">
        <AiEngineChain />
      </Block>

      <Block
        title="Coding agent"
        hint="Starts new sessions from “Fix with agent” and “Review” (Deck, Test Bench, MR threads). A running session is reused."
      >
        <Segmented
          label="Coding agent"
          value={settings.agentPreference}
          disabled={save.isPending}
          options={[
            { value: 'claude', label: 'Claude' },
            { value: 'cursor', label: 'Cursor' },
          ]}
          onChange={(agentPreference) => save.mutate({ patch: (s) => ({ ...s, agentPreference }) })}
        />
        <div className="grid gap-3 rounded-surface border border-hairline p-4">
          <p className="text-xs text-muted-foreground">
            Claude plans on the plan model, then switches to the execution model and effort when you
            approve the plan.
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <ModelPicker
              agent="claude"
              label="Plan model"
              value={settings.agentModels.planModel}
              disabled={save.isPending}
              onChange={(planModel) => planModel && patchModels({ planModel })}
            />
            <ArrowRight aria-hidden className="mt-2.5 size-4 shrink-0 text-muted-foreground" />
            <ModelPicker
              agent="claude"
              label="Execution model"
              value={settings.agentModels.execModel}
              disabled={save.isPending}
              onChange={(execModel) => execModel && patchModels({ execModel })}
            />
            <Select
              aria-label="Execution effort"
              className="w-28"
              value={settings.agentModels.execEffort}
              disabled={save.isPending}
              onChange={(e) => patchModels({ execEffort: e.target.value as AgentEffort })}
            >
              {AGENT_EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-28 text-muted-foreground">On approval</span>
            <Select
              aria-label="When a plan is approved"
              className="max-w-56"
              value={settings.agentModels.execSwitch}
              disabled={save.isPending}
              onChange={(e) => patchModels({ execSwitch: e.target.value as 'ask' | 'auto' })}
            >
              <option value="ask">Ask me which model</option>
              <option value="auto">Switch automatically</option>
            </Select>
          </label>
        </div>
        <div className="grid gap-2 rounded-surface border border-hairline p-4">
          <p className="text-xs text-muted-foreground">
            Cursor has no approval hook, so it keeps one model.
          </p>
          <ModelPicker
            agent="cursor"
            label="Cursor model"
            value={settings.agentModels.cursorModel}
            disabled={save.isPending}
            onChange={(cursorModel) => cursorModel && patchModels({ cursorModel })}
          />
        </div>
      </Block>

      <Block
        title="Per feature"
        hint={
          overrides
            ? `${overrides === 1 ? '1 feature goes its' : `${overrides} features go their`} own way. Open a row to change it.`
            : 'Every feature uses the default. Open a row to give it its own agent or model.'
        }
      >
        <ul className="grid">
          <FeatureRow
            name="default"
            label="Default"
            hint="Every feature without its own choice"
            empty="Automatic · built-in model"
            choice={settings.aiModels.default ?? {}}
            disabled={save.isPending}
            onChange={(next) => setChoice('default', next)}
          />
        </ul>
        {GROUPS.map((g) => (
          <div key={g.name} className="grid gap-1">
            <p className="font-mono text-micro tracking-[0.06em] text-muted-foreground uppercase">
              {g.name}
            </p>
            <ul className="grid">
              {g.features.map((f) => (
                <FeatureRow
                  key={f.key}
                  name={f.key}
                  label={f.label}
                  hint={f.hint}
                  empty="uses default"
                  choice={settings.aiModels[f.key] ?? {}}
                  disabled={save.isPending}
                  onChange={(next) => setChoice(f.key, next)}
                />
              ))}
            </ul>
          </div>
        ))}
      </Block>
      <ErrorAlert error={save.error} />
    </SectionCard>
  );
}

/** One step of the route, ruled off from the one above. */
function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 rule-row pt-5 first:border-0 first:pt-0">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex h-8 w-fit items-center rounded-control border border-hairline p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => value !== o.value && onChange(o.value)}
          className={cn(
            'h-full rounded-[2px] px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60',
            value === o.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A feature's line: its name, a dotted leader, and its choice. Opens to the editor. */
function FeatureRow({
  name,
  label,
  hint,
  empty,
  choice,
  disabled,
  onChange,
}: {
  name: AiModelKey;
  label: string;
  hint: string;
  empty: string;
  choice: AiModelChoice;
  disabled: boolean;
  onChange: (next: AiModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = choiceSummary(choice);
  return (
    <li className="rule-row first:border-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-baseline gap-2 rounded-control py-2 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 self-center text-muted-foreground transition-transform motion-reduce:transition-none',
            !open && '-rotate-90',
          )}
        />
        <span className="grid min-w-0">
          <span className="text-sm">{label}</span>
          <span className="truncate text-xs text-muted-foreground">{hint}</span>
        </span>
        <span aria-hidden className="mx-1 min-w-6 flex-1 border-b border-dotted border-border" />
        <span
          className={cn(
            'shrink-0 text-xs',
            summary ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {summary ?? empty}
        </span>
      </button>
      {open && (
        <div className="grid gap-2 pb-3 pl-5.5">
          <ModelRow name={name} choice={choice} disabled={disabled} onChange={onChange} />
          {summary && (
            <Button
              size="sm"
              variant="ghost"
              className="w-fit"
              disabled={disabled}
              onClick={() => onChange({})}
            >
              Reset to {name === 'default' ? 'automatic' : 'default'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function ModelRow({
  name,
  choice,
  disabled,
  onChange,
}: {
  name: AiModelKey;
  choice: AiModelChoice;
  disabled: boolean;
  onChange: (next: AiModelChoice) => void;
}) {
  const clean = (c: AiModelChoice): AiModelChoice => ({
    ...(c.engine ? { engine: c.engine } : {}),
    ...(c.model ? { model: c.model } : {}),
    ...(c.effort && c.engine !== 'cursor_cli' ? { effort: c.effort } : {}),
  });
  // With no agent chosen the model applies to the Claude engines (see AiService.run).
  const agent = choice.engine === 'cursor_cli' ? 'cursor' : 'claude';
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Select
        aria-label={`${name} agent`}
        className="w-44"
        value={choice.engine ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const engine = (e.target.value || undefined) as AiEngine | undefined;
          // A model id belongs to one agent family: switching between Claude and Cursor drops it.
          const family = (x: AiEngine | undefined) => (x === 'cursor_cli' ? 'cursor' : 'claude');
          const keep = family(engine) === family(choice.engine);
          onChange(
            clean({
              ...choice,
              engine,
              model: keep ? choice.model : undefined,
              effort: keep ? choice.effort : undefined,
            }),
          );
        }}
      >
        <option value="">Automatic</option>
        {AI_ENGINES.map((e) => (
          <option key={e} value={e}>
            {ENGINE_NAME[e]}
          </option>
        ))}
      </Select>
      <ModelPicker
        key={agent}
        agent={agent}
        label={`${name} model`}
        defaultLabel="Built-in default"
        value={choice.model}
        disabled={disabled}
        onChange={(model) => onChange(clean({ ...choice, model }))}
      />
      {agent === 'claude' && (
        <Select
          aria-label={`${name} effort`}
          className="w-32"
          value={choice.effort ?? ''}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              clean({
                ...choice,
                effort: (e.target.value || undefined) as AgentEffort | undefined,
              }),
            )
          }
        >
          <option value="">Effort: auto</option>
          {AGENT_EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
