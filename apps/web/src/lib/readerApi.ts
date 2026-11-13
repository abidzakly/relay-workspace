import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReaderCreate, ReaderDoc, ReaderDocSummary, ReaderUpdate } from '@relay/shared';
import { del, get, patch, post } from './api';

/** Reader library API. */

export const readerKeys = {
  list: ['reader', 'list'] as const,
  doc: (id: string) => ['reader', 'doc', id] as const,
};

export function useReaderList() {
  return useQuery({
    queryKey: readerKeys.list,
    queryFn: () => get<ReaderDocSummary[]>('/api/reader'),
  });
}

export function useReaderDoc(id: string | null) {
  return useQuery({
    queryKey: id ? readerKeys.doc(id) : ['reader', 'doc', 'none'],
    queryFn: () => get<ReaderDoc>(`/api/reader/${id}`),
    enabled: id !== null,
    staleTime: 60_000,
  });
}

export function useCreateReaderDoc() {
  const qc = useQueryClient();
  return useMutation<ReaderDoc, Error, ReaderCreate>({
    mutationFn: (b) => post('/api/reader', b),
    onSuccess: (doc) => {
      qc.setQueryData(readerKeys.doc(doc.id), doc);
      void qc.invalidateQueries({ queryKey: readerKeys.list });
    },
  });
}

export function useUpdateReaderDoc(id: string) {
  const qc = useQueryClient();
  return useMutation<ReaderDoc, Error, ReaderUpdate>({
    mutationFn: (b) => patch(`/api/reader/${id}`, b),
    onSuccess: (doc, b) => {
      qc.setQueryData(readerKeys.doc(id), doc);
      // A saved reading position does not reorder the library; an edit does.
      if (b.body !== undefined || b.title !== undefined || b.format !== undefined)
        void qc.invalidateQueries({ queryKey: readerKeys.list });
    },
  });
}

/** Saves the reading position quietly: no list refresh, no error surface. */
export const saveReaderPos = (id: string, lastPos: number) =>
  patch<ReaderDoc>(`/api/reader/${id}`, { lastPos }).catch(() => undefined);

export function useDeleteReaderDoc() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => del(`/api/reader/${id}`),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: readerKeys.doc(id) });
      void qc.invalidateQueries({ queryKey: readerKeys.list });
    },
  });
}
