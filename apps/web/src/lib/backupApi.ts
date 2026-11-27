import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  UI_PREF_KEYS,
  UiPrefsExportSchema,
  type ConfigExportBody,
  type ConfigExportFile,
  type ConfigImportPreview,
  type UiPrefsExport,
} from '@relay/shared';
import { useUiStore } from '@/store/ui';
import { post, postForBlob } from './api';
import { saveBlob } from './saveFile';
import { keys as settingsKeys } from './settingsApi';

const dateTag = () => new Date().toISOString().slice(0, 10);

/** This browser's preferences, as they travel in the file (`ui`). */
function uiPrefs(): UiPrefsExport {
  const state = useUiStore.getState() as unknown as Record<string, unknown>;
  const picked = Object.fromEntries(UI_PREF_KEYS.map((k) => [k, state[k]]));
  const parsed = UiPrefsExportSchema.safeParse(picked);
  return parsed.success ? parsed.data : {};
}

/** Restores the file's browser preferences here. The server has already checked their shape. */
function applyUiPrefs(file: unknown): void {
  const raw = (file as { ui?: unknown } | null)?.ui;
  if (raw === undefined) return;
  const parsed = UiPrefsExportSchema.safeParse(raw);
  if (parsed.success) useUiStore.setState(parsed.data as never);
}

export function useExportConfig() {
  return useMutation({
    mutationFn: async (body: ConfigExportBody) => {
      const file: ConfigExportFile = {
        ...(await post<ConfigExportFile>('/api/backup/config/export', body)),
        ui: uiPrefs(),
      };
      const name = `relay-config-${dateTag()}${body.includeSecrets ? '-sealed' : ''}.json`;
      saveBlob(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), name);
    },
  });
}

export function useDownloadDbBackup() {
  return useMutation({
    mutationFn: async () => {
      const { blob, fileName } = await postForBlob('/api/backup/db');
      saveBlob(blob, fileName ?? `relay-${dateTag()}.db`);
    },
  });
}

export interface ImportArgs {
  file: unknown;
  passphrase?: string;
}

export function usePreviewImport() {
  return useMutation({
    mutationFn: async (args: ImportArgs) =>
      (await post<{ preview: ConfigImportPreview }>('/api/backup/config/import/preview', args))
        .preview,
  });
}

export function useApplyImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ImportArgs) =>
      (
        await post<{ preview: ConfigImportPreview }>('/api/backup/config/import', {
          ...args,
          confirm: true,
        })
      ).preview,
    onSuccess: (_preview, args) => {
      applyUiPrefs(args.file);
      return Promise.all([
        qc.invalidateQueries({ queryKey: settingsKeys.settings }),
        qc.invalidateQueries({ queryKey: settingsKeys.repos }),
      ]);
    },
  });
}
