import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigExportBody, ConfigExportFile, ConfigImportPreview } from '@relay/shared';
import { post, postForBlob } from './api';
import { saveBlob } from './saveFile';
import { keys as settingsKeys } from './settingsApi';

const dateTag = () => new Date().toISOString().slice(0, 10);

export function useExportConfig() {
  return useMutation({
    mutationFn: async (body: ConfigExportBody) => {
      const file = await post<ConfigExportFile>('/api/backup/config/export', body);
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
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: settingsKeys.settings }),
        qc.invalidateQueries({ queryKey: settingsKeys.repos }),
      ]),
  });
}
