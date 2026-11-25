import { CURSOR_MODELS_SNAPSHOT } from './agentModelsSnapshot';

/**
 * The models each agent offers, for the Settings pickers. Claude takes a model id plus a separate `--effort`; Cursor
 * folds effort, speed and thinking into the id (`claude-opus-5-5-high-fast`, `grok-4.7-medium`), so its flat list is
 * grouped into families with those capabilities as controls. The live Cursor list comes from the host
 * (`cursor-agent --list-models`, which lists what the logged-in account may use); the snapshot is the fallback.
 */

export const MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export const MODEL_EFFORT_LABEL: Record<ModelEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const MODEL_VENDORS = ['cursor', 'anthropic', 'openai', 'xai', 'google', 'other'] as const;
export type ModelVendor = (typeof MODEL_VENDORS)[number];
export const MODEL_VENDOR_LABEL: Record<ModelVendor, string> = {
  cursor: 'Cursor',
  anthropic: 'Claude',
  openai: 'GPT',
  xai: 'Grok',
  google: 'Gemini',
  other: 'Other',
};

export interface ModelVariant {
  id: string;
  label: string;
  /** null = the model has one fixed effort. */
  effort: ModelEffort | null;
  fast: boolean;
  thinking: boolean;
}

export interface ModelFamily {
  key: string;
  label: string;
  vendor: ModelVendor;
  /** e.g. "No ZDR" (the provider keeps data; no zero data retention). */
  note: string | null;
  /** The variant picked when the family is chosen. */
  defaultId: string;
  variants: ModelVariant[];
}

/** What the CLIs report about the local logins. Emails are never kept. */
export interface AgentAccounts {
  /** From `claude auth status`: `pro`, `max`, `team`, `enterprise`…; `authMethod` `claude.ai` or an API key. */
  claude: { tier: string | null; authMethod: string | null } | null;
  /** From `cursor-agent about`: e.g. `Team`, `Pro`. */
  cursor: { tier: string | null } | null;
}

export interface AgentModelCatalog {
  claude: ModelFamily[];
  cursor: ModelFamily[];
  /** `live`: the Cursor list came from the CLI for this account. `builtin`: the snapshot. */
  source: 'live' | 'builtin';
  accounts: AgentAccounts;
}

export interface CursorModelEntry {
  id: string;
  label: string;
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

/** `id - Label` lines (the CLI's `--list-models` output); anything else is skipped. */
export function parseCursorModelList(text: string): CursorModelEntry[] {
  const out: CursorModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\u200b-\u200f\ufeff]/g, '').trim();
    const m = /^(\S+) - (.+)$/.exec(line);
    if (!m || !ID_RE.test(m[1]!) || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    out.push({ id: m[1]!, label: m[2]!.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const EFFORT_TOKENS: Record<string, ModelEffort> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'extra-high': 'xhigh',
  max: 'max',
};

/** `claude-opus-5-5-high-fast` → family `claude-opus-5-5`, effort high, fast. Exported for tests. */
export function parseCursorModelId(id: string): {
  familyKey: string;
  effort: ModelEffort | null;
  fast: boolean;
  thinking: boolean;
} {
  let rest = id;
  const fast = rest.endsWith('-fast');
  if (fast) rest = rest.slice(0, -'-fast'.length);
  let thinking = false;
  if (rest.endsWith('-thinking')) {
    thinking = true;
    rest = rest.slice(0, -'-thinking'.length);
  }
  let effort: ModelEffort | null = null;
  // Longest first: `-extra-high` before `-high`.
  for (const [token, e] of Object.entries(EFFORT_TOKENS).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (rest.endsWith(`-${token}`)) {
      effort = e;
      rest = rest.slice(0, -(token.length + 1));
      break;
    }
  }
  if (!thinking && rest.endsWith('-thinking')) {
    thinking = true;
    rest = rest.slice(0, -'-thinking'.length);
  }
  return { familyKey: rest || id, effort, fast, thinking };
}

function vendorOf(key: string): ModelVendor {
  if (key === 'auto' || key.startsWith('composer')) return 'cursor';
  if (key.startsWith('claude')) return 'anthropic';
  if (key.startsWith('gpt')) return 'openai';
  if (key.includes('grok')) return 'xai';
  if (key.startsWith('gemini')) return 'google';
  return 'other';
}

const NOTE_RE = /\(NO ZDR\)/i;
const CAPABILITY_WORDS =
  /\b(No Thinking|Extra High|Low|Medium|High|Max|None|Minimal|Fast|Thinking)\b|\((current|default)\)/gi;
const EFFORT_WORDS = /\b(Extra High|Low|Medium|High|Max|None|Minimal)\b/i;

const cleanLabel = (label: string) =>
  label.replace(NOTE_RE, '').replace(CAPABILITY_WORDS, '').replace(/\s+/g, ' ').trim();

/** Groups a flat Cursor list into families, vendors in a fixed order and Cursor's own order within each. */
export function groupCursorModels(entries: readonly CursorModelEntry[]): ModelFamily[] {
  const byKey = new Map<string, { family: ModelFamily; labels: string[] }>();
  for (const e of entries) {
    const p = parseCursorModelId(e.id);
    let slot = byKey.get(p.familyKey);
    if (!slot) {
      slot = {
        family: {
          key: p.familyKey,
          label: cleanLabel(e.label) || e.id,
          vendor: vendorOf(p.familyKey),
          note: NOTE_RE.test(e.label) ? 'No ZDR' : null,
          defaultId: e.id,
          variants: [],
        },
        labels: [],
      };
      byKey.set(p.familyKey, slot);
    }
    slot.family.variants.push({
      id: e.id,
      label: e.label.replace(NOTE_RE, '').replace(/\s+/g, ' ').trim(),
      effort: p.effort,
      fast: p.fast,
      thinking: p.thinking,
    });
  }
  const families = [...byKey.values()].map(({ family }) => {
    const v = family.variants;
    // Cursor names its standard variant without an effort word ("Claude Opus 5.5 1M" is medium).
    const plain = (x: ModelVariant) => !x.fast && !EFFORT_WORDS.test(x.label);
    const pick =
      v.find((x) => plain(x) && !x.thinking) ??
      v.find(plain) ??
      v.find((x) => !x.fast && !x.thinking && x.effort === 'medium') ??
      v.find((x) => !x.fast && x.effort === 'medium') ??
      v.find((x) => !x.fast) ??
      v[0]!;
    v.sort(
      (a, b) =>
        +a.thinking - +b.thinking ||
        effortRank(a.effort) - effortRank(b.effort) ||
        +a.fast - +b.fast,
    );
    return { ...family, label: cleanLabel(pick.label) || family.label, defaultId: pick.id };
  });
  return MODEL_VENDORS.flatMap((vendor) => families.filter((f) => f.vendor === vendor));
}

const effortRank = (e: ModelEffort | null) => (e === null ? -1 : MODEL_EFFORTS.indexOf(e));

let snapshot: ModelFamily[] | undefined;
/** The built-in Cursor families (parsed once). */
export function builtinCursorModels(): ModelFamily[] {
  snapshot ??= groupCursorModels(parseCursorModelList(CURSOR_MODELS_SNAPSHOT));
  return snapshot;
}

const claudeFamily = (id: string, label: string): ModelFamily => ({
  key: id,
  label,
  vendor: 'anthropic',
  note: null,
  defaultId: id,
  variants: [{ id, label, effort: null, fast: false, thinking: false }],
});

/** Claude CLI and Anthropic API models. Effort is a separate setting (`--effort`). */
export const CLAUDE_MODELS: readonly ModelFamily[] = [
  claudeFamily('claude-opus-5-5', 'Opus 5.5'),
  claudeFamily('claude-sonnet-5-5', 'Sonnet 5.5'),
  claudeFamily('claude-haiku-5-5', 'Haiku 5.5'),
  claudeFamily('claude-fable-5-2', 'Fable 5.2'),
];

/** Efforts the Claude CLI accepts (`--effort`). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Claude models a subscription does not include, by `claude auth status` tier. The CLI does not list allowed models,
 * so this is kept by hand: on Pro, Fable 5.2 answers "requires usage credits". An unknown tier or an API key gets all.
 */
const CLAUDE_TIER_EXCLUDES: Readonly<Record<string, readonly string[]>> = {
  pro: ['claude-fable-5-2'],
  free: ['claude-fable-5-2'],
};

/** The Claude models the local login can use. */
export function claudeModelsFor(accounts: AgentAccounts | null | undefined): ModelFamily[] {
  const a = accounts?.claude;
  const tier = a && a.authMethod === 'claude.ai' ? (a.tier?.toLowerCase() ?? '') : '';
  const out = CLAUDE_TIER_EXCLUDES[tier] ?? [];
  return CLAUDE_MODELS.filter((f) => !out.includes(f.key));
}

/** The family and variant holding `id`, or null for an id the list does not have. */
export function findModel(
  families: readonly ModelFamily[],
  id: string,
): { family: ModelFamily; variant: ModelVariant } | null {
  for (const family of families) {
    const variant = family.variants.find((v) => v.id === id);
    if (variant) return { family, variant };
  }
  return null;
}

/**
 * The family's variant closest to what was asked: exact match first, then the asked effort with the current
 * thinking/fast where possible, then the default.
 */
export function resolveVariant(
  family: ModelFamily,
  want: { effort?: ModelEffort | null; fast?: boolean; thinking?: boolean },
): ModelVariant {
  const v = family.variants;
  const eq = (x: ModelVariant, keys: ('effort' | 'fast' | 'thinking')[]) =>
    keys.every((k) => want[k] === undefined || x[k] === want[k]);
  return (
    v.find((x) => eq(x, ['effort', 'fast', 'thinking'])) ??
    v.find((x) => eq(x, ['effort', 'thinking'])) ??
    v.find((x) => eq(x, ['effort', 'fast'])) ??
    v.find((x) => eq(x, ['effort'])) ??
    v.find((x) => x.id === family.defaultId) ??
    v[0]!
  );
}

/** Which capability controls a family needs, given the variant shown now. */
export function familyCapabilities(
  family: ModelFamily,
  current: ModelVariant,
): { efforts: (ModelEffort | null)[]; fast: boolean; thinking: boolean } {
  const v = family.variants;
  // null = the model's standard effort (e.g. `gpt-5.3-codex` next to `gpt-5.3-codex-high`).
  const efforts = [null, ...MODEL_EFFORTS].filter((e) =>
    v.some((x) => x.effort === e && x.thinking === current.thinking),
  );
  return {
    efforts: efforts.length > 1 ? efforts : [],
    fast: v.some((x) => x.fast) && v.some((x) => !x.fast),
    thinking: v.some((x) => x.thinking) && v.some((x) => !x.thinking),
  };
}

let labels: Map<string, string> | undefined;
/** "Opus 5.5", "Grok 4.7 High Fast" for a known model id, else null. */
export function catalogModelLabel(id: string): string | null {
  if (!labels) {
    labels = new Map();
    for (const f of builtinCursorModels()) for (const v of f.variants) labels.set(v.id, v.label);
    for (const f of CLAUDE_MODELS) labels.set(f.key, f.label);
  }
  return labels.get(id) ?? null;
}
