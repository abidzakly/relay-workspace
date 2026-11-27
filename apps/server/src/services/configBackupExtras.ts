import { z } from 'zod';
import {
  SCRIPT_FIELDS,
  SecretSchema,
  ScriptValuesExportSchema,
  type ScriptValuesExport,
  type Workspace,
  type WorkspaceCreate,
  type WorkspaceExport,
} from '@relay/shared';
import type { ConfigStore } from '../config/store';
import { ActionError } from './actionError';

/**
 * The parts of a config export added after the first version: secrets pasted in Reviews and Release scripts, the
 * typed Release script values, and the registered workspaces. Sign-ins ("Connect") and other machine-bound values are
 * never exported.
 */

/** ConfigStore keys (`secret.<name>` / `state.<name>`), the same rows their own services read. */
const REVIEWS_HOOK_SECRET = 'reviews.webhookSecret';
const SCRIPT_VALUES = 'scripts.values';
const scriptSecret = (key: string) => `scripts.${key}`;

const SECRET_SCRIPT_KEYS = new Set(SCRIPT_FIELDS.filter((f) => f.secret).map((f) => f.key));
const PLAIN_SCRIPT_KEYS = new Set(SCRIPT_FIELDS.filter((f) => !f.secret).map((f) => f.key));

/** Spread into the sealed payload's schema. Every field is optional, so older sealed blocks still open. */
export const EXTRA_SECRET_FIELDS = {
  /** Reviews: the personal access token pasted in Advanced mode (not the GitLab sign-in). */
  reviewerToken: SecretSchema.optional(),
  /** The secret GitLab sends to `POST /webhook/reviews`: restoring it keeps existing hooks working. */
  reviewsWebhookSecret: SecretSchema.optional(),
  /** Settings > Release scripts, the secret fields, by variable name. */
  scripts: z.record(z.string(), SecretSchema).optional(),
};

export interface ExtraSecrets {
  reviewerToken?: string;
  reviewsWebhookSecret?: string;
  scripts?: Record<string, string>;
}

/** Call inside `store.withoutFallbacks`: only what was pasted on this machine. */
export function collectExtraSecrets(store: ConfigStore): ExtraSecrets {
  const out: ExtraSecrets = {};
  const reviewerToken = store.getPastedReviewerToken();
  if (reviewerToken) out.reviewerToken = reviewerToken;
  const hook = store.getReviewsWebhookSecret(false);
  if (hook) out.reviewsWebhookSecret = hook;
  const scripts: Record<string, string> = {};
  for (const key of SECRET_SCRIPT_KEYS) {
    const v = store.getSecret(scriptSecret(key));
    if (v) scripts[key] = v;
  }
  if (Object.keys(scripts).length > 0) out.scripts = scripts;
  return out;
}

/** Every value, for the leak check and the restored count. */
export function extraSecretValues(s: ExtraSecrets | null | undefined): string[] {
  if (!s) return [];
  return [s.reviewerToken, s.reviewsWebhookSecret, ...Object.values(s.scripts ?? {})].filter(
    (v): v is string => !!v,
  );
}

/** A sealed script secret must name a secret field: anything else means the block was not made by Relay. */
export function checkExtraSecrets(s: ExtraSecrets): void {
  for (const key of Object.keys(s.scripts ?? {})) {
    if (!SECRET_SCRIPT_KEYS.has(key)) {
      throw new ActionError(
        400,
        'bad_passphrase',
        'Wrong passphrase, or the secrets in this file were altered.',
      );
    }
  }
}

/** Writes what the file holds; a secret it lacks keeps this machine's value. */
export function applyExtraSecrets(store: ConfigStore, s: ExtraSecrets | null): void {
  if (!s) return;
  if (s.reviewerToken) store.setReviewerToken(s.reviewerToken);
  if (s.reviewsWebhookSecret) store.setSecret(REVIEWS_HOOK_SECRET, s.reviewsWebhookSecret);
  for (const [key, value] of Object.entries(s.scripts ?? {})) {
    store.setSecret(scriptSecret(key), value);
  }
}

// ───────────────────────────── Release script values ─────────────────────────────

export function readScriptValues(store: ConfigStore): ScriptValuesExport {
  const raw = store.getState<Record<string, unknown>>(SCRIPT_VALUES) ?? {};
  const out: ScriptValuesExport = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PLAIN_SCRIPT_KEYS.has(key) && typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

/** A plain value must name a non-secret field: a secret one never leaves unsealed. */
export function parseScriptValues(raw: unknown): ScriptValuesExport {
  const parsed = ScriptValuesExportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ActionError(
      400,
      'scripts_invalid',
      'The Release scripts part of the file is invalid.',
    );
  }
  for (const key of Object.keys(parsed.data)) {
    if (!PLAIN_SCRIPT_KEYS.has(key)) {
      throw new ActionError(
        400,
        'scripts_invalid',
        `"${key}" is not a Release scripts field this version keeps in plain text.`,
      );
    }
  }
  return parsed.data;
}

export function scriptValuesChanged(store: ConfigStore, values: ScriptValuesExport): boolean {
  return JSON.stringify(readScriptValues(store)) !== JSON.stringify(values);
}

/** Replaces the typed values. The env file is re-written on the `settings.changed` the import's audit emits. */
export function applyScriptValues(
  store: ConfigStore,
  values: ScriptValuesExport | undefined,
): void {
  if (values !== undefined) store.setState(SCRIPT_VALUES, values);
}

// ───────────────────────────── workspaces ─────────────────────────────

export function exportableWorkspaces(list: Workspace[]): WorkspaceExport[] {
  return list
    .filter((w) => w.kind === 'repo')
    .map((w) => ({
      name: w.name,
      absPath: w.absPath,
      repoId: w.repoId,
      defaultBase: w.defaultBase,
      color: w.color,
    }));
}

export interface WorkspaceRegistry {
  list(): Workspace[];
  /** The folder's real path when it is a usable git checkout here, else null. Writes nothing. */
  checkPath(absPath: string, name: string): Promise<string | null>;
  add(input: WorkspaceCreate): Promise<Workspace>;
}

export interface WorkspacePlan {
  added: string[];
  skipped: { name: string; absPath: string }[];
}

/**
 * What the import does with the file's workspaces: a folder already registered here is left as it is, a missing one
 * is skipped, and the rest are added (`apply`). Nothing is ever removed.
 */
export async function planWorkspaces(
  registry: WorkspaceRegistry | undefined,
  store: ConfigStore,
  file: WorkspaceExport[] | undefined,
  apply: boolean,
): Promise<WorkspacePlan> {
  const plan: WorkspacePlan = { added: [], skipped: [] };
  if (!file || file.length === 0) return plan;
  if (!registry) {
    plan.skipped = file.map(({ name, absPath }) => ({ name, absPath }));
    return plan;
  }
  const known = new Set(registry.list().map((w) => w.absPath));
  for (const ws of file) {
    if (known.has(ws.absPath)) continue;
    const real = await registry.checkPath(ws.absPath, ws.name);
    if (!real) {
      plan.skipped.push({ name: ws.name, absPath: ws.absPath });
      continue;
    }
    if (known.has(real)) continue;
    if (apply) {
      try {
        await registry.add({
          name: ws.name,
          absPath: real,
          repoId: ws.repoId && store.getRepo(ws.repoId) ? ws.repoId : null,
          defaultBase: ws.defaultBase,
          color: ws.color,
        });
      } catch {
        plan.skipped.push({ name: ws.name, absPath: ws.absPath });
        continue;
      }
    }
    known.add(real);
    plan.added.push(ws.name);
  }
  return plan;
}
