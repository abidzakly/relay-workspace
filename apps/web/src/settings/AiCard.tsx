import { Bot } from 'lucide-react';
import {
  AGENT_EFFORTS,
  AI_ENGINES,
  AI_MODEL_KEYS,
  type AgentEffort,
  type AiEngine,
  type AiModelChoice,
  type AiModelKey,
  type GlobalConfigPublic,
} from '@relay/shared';
import { useAiCheckStore } from '@/components/AiCheck';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useAgentModels, useAiStatus } from '@/lib/cockpitApi';
import { ModelPicker } from './ModelPicker';
import { useSaveGlobal } from '@/lib/settingsApi';
import { ErrorAlert, SectionCard } from './SectionCard';

const ENGINE_NAME: Record<AiEngine, string> = {
  claude_cli: 'Claude CLI',
  anthropic_api: 'Anthropic API',
  cursor_cli: 'Cursor CLI',
};

const LABEL = {
  claude_cli: 'Claude CLI',
  anthropic_api: 'Anthropic API',
  cursor_cli: 'Cursor CLI (Claude is down)',
  none: 'none',
} as const;

export function AiCard({ settings }: { settings: GlobalConfigPublic }) {
  const save = useSaveGlobal();
  const status = useAiStatus();
  const open = useAiCheckStore((s) => s.setOpen);
  return (
    <SectionCard
      id="ai"
      brand="ai"
      title="AI engines"
      description="Claude answers first; Cursor takes over when Claude fails (for example when its usage limit is spent)."
      action={
        <Button variant="outline" onClick={() => open(true)}>
          <Bot aria-hidden="true" />
          Check connection
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Answering now:{' '}
        <span className="text-foreground">{status.data ? LABEL[status.data.engine] : '…'}</span>
        {status.data?.reason ? ` (${status.data.reason})` : ''}
      </p>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Coding agent</p>
        <p className="text-xs text-muted-foreground">
          Used when “Fix with agent” or “Review” starts a new session (Deck, Test Bench, MR
          threads). A session that is already running is reused.
        </p>
        <Select
          aria-label="Coding agent"
          className="max-w-48"
          value={settings.agentPreference}
          disabled={save.isPending}
          onChange={(e) => {
            const agentPreference = e.target.value as 'claude' | 'cursor';
            save.mutate({ patch: (s) => ({ ...s, agentPreference }) });
          }}
        >
          <option value="claude">Claude</option>
          <option value="cursor">Cursor</option>
        </Select>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Agent models</p>
        <PlanLine />
        <p className="text-xs text-muted-foreground">
          A Claude session plans on the plan model. When you approve the plan, it switches to the
          execution model and effort. Cursor has no approval hook, so it keeps one model.
        </p>
        <div className="grid items-center gap-2 sm:grid-cols-[10rem_1fr_8rem]">
          <span className="text-sm">Claude plan / execute</span>
          <div className="grid gap-2 sm:grid-cols-2">
            <ModelPicker
              agent="claude"
              label="Plan model"
              value={settings.agentModels.planModel}
              disabled={save.isPending}
              onChange={(planModel) =>
                planModel &&
                save.mutate({
                  patch: (s) => ({ ...s, agentModels: { ...s.agentModels, planModel } }),
                })
              }
            />
            <ModelPicker
              agent="claude"
              label="Execution model"
              value={settings.agentModels.execModel}
              disabled={save.isPending}
              onChange={(execModel) =>
                execModel &&
                save.mutate({
                  patch: (s) => ({ ...s, agentModels: { ...s.agentModels, execModel } }),
                })
              }
            />
          </div>
          <Select
            aria-label="Execution effort"
            value={settings.agentModels.execEffort}
            disabled={save.isPending}
            onChange={(e) => {
              const execEffort = e.target.value as AgentEffort;
              save.mutate({
                patch: (s) => ({ ...s, agentModels: { ...s.agentModels, execEffort } }),
              });
            }}
          >
            {AGENT_EFFORTS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          <span className="text-sm">On approval</span>
          <Select
            aria-label="When a plan is approved"
            className="sm:col-span-2 sm:max-w-64"
            value={settings.agentModels.execSwitch}
            disabled={save.isPending}
            onChange={(e) => {
              const execSwitch = e.target.value as 'ask' | 'auto';
              save.mutate({
                patch: (s) => ({ ...s, agentModels: { ...s.agentModels, execSwitch } }),
              });
            }}
          >
            <option value="ask">Ask me which model</option>
            <option value="auto">Switch automatically</option>
          </Select>
          <span className="text-sm">Cursor</span>
          <ModelPicker
            agent="cursor"
            label="Cursor model"
            className="sm:col-span-2"
            value={settings.agentModels.cursorModel}
            disabled={save.isPending}
            onChange={(cursorModel) =>
              cursorModel &&
              save.mutate({
                patch: (s) => ({ ...s, agentModels: { ...s.agentModels, cursorModel } }),
              })
            }
          />
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Agent and model per feature</p>
        <p className="text-xs text-muted-foreground">
          “default” applies to every feature without its own row. Empty = automatic (Claude, then
          Cursor) with the built-in model.
        </p>
        {AI_MODEL_KEYS.map((key) => (
          <ModelRow
            key={key}
            name={key}
            choice={settings.aiModels[key] ?? {}}
            disabled={save.isPending}
            onChange={(next) =>
              save.mutate({
                patch: (s) => {
                  const aiModels = { ...s.aiModels };
                  if (next.engine || next.model || next.effort) aiModels[key] = next;
                  else delete aiModels[key];
                  return { ...s, aiModels };
                },
              })
            }
          />
        ))}
      </div>
      <ErrorAlert error={save.error} />
    </SectionCard>
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
    <div className="grid items-start gap-2 sm:grid-cols-[10rem_12rem_1fr]">
      <span className="text-sm">{name}</span>
      <Select
        aria-label={`${name} agent`}
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
      <div className="flex flex-wrap items-start gap-2">
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
    </div>
  );
}

const TIER_NAME: Record<string, string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
};
const tierName = (t: string) => TIER_NAME[t.toLowerCase()] ?? t;

/** The local logins' plans, which decide the models offered. */
function PlanLine() {
  const q = useAgentModels();
  const c = q.data;
  if (!c || q.isPlaceholderData) return null;
  const parts = [
    c.accounts.claude?.tier
      ? `Claude ${tierName(c.accounts.claude.tier)}`
      : c.accounts.claude?.authMethod
        ? 'Claude (API key)'
        : null,
    c.accounts.cursor?.tier ? `Cursor ${tierName(c.accounts.cursor.tier)}` : null,
  ].filter(Boolean);
  return (
    <p className="text-xs text-muted-foreground">
      {parts.length > 0
        ? `Models offered for your plans: ${parts.join(' · ')}.`
        : 'Could not read your Claude or Cursor plan, so every known model is offered.'}{' '}
      {c.source === 'live'
        ? 'Cursor models come live from your Cursor CLI.'
        : 'Cursor models are the built-in list.'}
    </p>
  );
}
