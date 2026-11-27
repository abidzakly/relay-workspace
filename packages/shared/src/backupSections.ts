import { z } from 'zod';
import { RepoIdSchema } from './common';
import { WorkspaceColorSchema } from './cockpit';

/**
 * Optional sections of a config export, added after schema 1 shipped. Each is optional, so files made before it
 * still import, and a missing section leaves that part of this machine alone.
 */

/** Settings > Release scripts: the values you typed (not secret). Secret fields travel sealed, with the others. */
export const ScriptValuesExportSchema = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'not a script variable name'),
  z.string().min(1).max(4096),
);
export type ScriptValuesExport = z.infer<typeof ScriptValuesExportSchema>;

/**
 * A folder registered in Settings > Workspaces. Worktrees made for a bulk start are never exported. The path belongs
 * to the machine that exported it: an import adds it only when the folder is a git checkout here too.
 */
export const WorkspaceExportSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  absPath: z.string().trim().min(1).max(1024),
  repoId: RepoIdSchema.nullable(),
  defaultBase: z.string().trim().min(1).max(200),
  color: WorkspaceColorSchema,
});
export type WorkspaceExport = z.infer<typeof WorkspaceExportSchema>;

const flags = z.record(z.string().max(80), z.boolean());

/**
 * Preferences kept in the browser (`core-ui` in localStorage): language, theme, sound and the like. The browser adds
 * them to the file on export and restores them on import; the server only checks their shape. Never holds secrets.
 */
export const UiPrefsExportSchema = z.strictObject({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  lang: z.enum(['en', 'id']).optional(),
  mode3d: z.enum(['S', 'A', 'B']).optional(),
  scope: z.enum(['cycle', 'all']).optional(),
  ascii: z.enum(['off', 'full', 'text']).optional(),
  asciiTone: z.enum(['dull', 'color']).optional(),
  fpsCap: z.union([z.literal(0), z.literal(30), z.literal(60)]).optional(),
  cardMonth: z
    .string()
    .regex(/^(current|all|\d{4}-\d{2})$/)
    .optional(),
  homeMode: z.enum(['scene', 'classic']).optional(),
  avatarColor: z.string().max(40).nullable().optional(),
  soundOn: z.boolean().optional(),
  hapticsOn: z.boolean().optional(),
  visuals: flags.optional(),
  otherVisuals: z.boolean().optional(),
  settingsCollapsed: flags.optional(),
  setupIgnored: z.array(z.string().max(80)).max(200).optional(),
  logView: z.record(z.string().max(40), z.enum(['visual', 'raw'])).optional(),
});
export type UiPrefsExport = z.infer<typeof UiPrefsExportSchema>;
export const UI_PREF_KEYS = Object.keys(UiPrefsExportSchema.shape) as (keyof UiPrefsExport)[];
