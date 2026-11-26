import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarListResult } from '@relay/shared';
import { get, post } from './api';
import { keys } from './settingsApi';

/** Setup reads for Google: the calendar list, the Drive key upload and the service account's folders. */
export const googleSetupKeys = {
  calendars: ['calendar', 'calendars'] as const,
  folders: (search: string) => ['drive', 'folders', search] as const,
};

export function useCalendarList(enabled: boolean) {
  return useQuery({
    queryKey: googleSetupKeys.calendars,
    queryFn: ({ signal }) => get<CalendarListResult>('/api/calendar/calendars', { signal }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Writes the picked key file's content to the configured key path; answers with the account's email. */
export function useUploadDriveKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: string) =>
      post<{ ok: true; clientEmail: string }>('/api/drive/key', { json }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...keys.settings, 'drive-key'] }),
  });
}

export interface DriveFolderOption {
  id: string;
  name: string;
  driveId: string | null;
}

export function useDriveFolders(search: string, enabled: boolean) {
  return useQuery({
    queryKey: googleSetupKeys.folders(search),
    queryFn: () => post<DriveFolderOption[]>('/api/drive/folders', search ? { search } : {}),
    enabled,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}
