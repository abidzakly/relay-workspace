import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuditActor, AuditList, UndoResult } from '@relay/shared';
import { get, post } from './api';
import { kpiKeys } from './kpiApi';
import { mrKeys } from './mrApi';
import { stateKeys } from './stateApi';

/** The root matches what `audit.added` invalidates (`lib/sse.ts`), so the view follows new writes live. */
export const auditKeys = { root: ['audit'] as const };

export interface AuditFilters {
  action: string;
  actor: AuditActor | '';
  targetType: string;
  onlyUndoable: boolean;
}

const PAGE_SIZE = 100;

export function useAuditLog(f: AuditFilters) {
  return useInfiniteQuery({
    queryKey: [...auditKeys.root, f],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (f.action) q.set('action', f.action);
      if (f.actor) q.set('actor', f.actor);
      if (f.targetType) q.set('targetType', f.targetType);
      if (f.onlyUndoable) q.set('onlyUndoable', 'true');
      if (pageParam !== null) q.set('beforeId', String(pageParam));
      return get<AuditList>(`/api/audit?${q.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextBeforeId,
  });
}

/** Undo of any audit row; whatever it touched (card or MR) is refetched, refused or not. */
export function useUndoAudit() {
  const qc = useQueryClient();
  return useMutation<UndoResult, Error, number>({
    mutationFn: (auditId) => post<UndoResult>(`/api/audit/${auditId}/undo`),
    onSettled: () => {
      for (const queryKey of [
        auditKeys.root,
        stateKeys.state,
        stateKeys.health,
        mrKeys.inboxRoot,
        mrKeys.detailRoot,
        kpiKeys.root,
      ]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}
