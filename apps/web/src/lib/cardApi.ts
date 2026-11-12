import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BulkReadyPreview,
  BulkReadyResult,
  CardStatusResult,
  CardWritePreview,
  SyncFixTarget,
  UndoConflictDetails,
  UndoResult,
} from '@relay/shared';
import { api, post } from './api';
import { stateKeys } from './stateApi';

/**
 * Card status changes and Fixes. Every write is two calls: `preview` (writes nothing, returns
 * before -> after and a single-use token) and the write itself, which the server refuses without that token.
 * None of this is optimistic: the board only moves once the server (and Notion) said yes.
 */
export type WriteRequest =
  | { kind: 'status'; cardId: string; to: string }
  | { kind: 'fix'; ruleId: string; target: SyncFixTarget; fixIndex: number };

export function usePreviewWrite() {
  return useMutation<CardWritePreview, Error, WriteRequest>({
    mutationFn: (r) =>
      r.kind === 'status'
        ? post<CardWritePreview>(`/api/cards/${encodeURIComponent(r.cardId)}/status/preview`, {
            status: r.to,
          })
        : post<CardWritePreview>('/api/sync/fix/preview', {
            ruleId: r.ruleId,
            target: r.target,
            fixIndex: r.fixIndex,
          }),
  });
}

export function useApplyWrite() {
  const qc = useQueryClient();
  return useMutation<CardStatusResult, Error, { request: WriteRequest; confirmToken: string }>({
    mutationFn: ({ request: r, confirmToken }) =>
      r.kind === 'status'
        ? api<CardStatusResult>('PATCH', `/api/cards/${encodeURIComponent(r.cardId)}/status`, {
            status: r.to,
            confirmToken,
          })
        : post<CardStatusResult>('/api/sync/fix', {
            ruleId: r.ruleId,
            target: r.target,
            fixIndex: r.fixIndex,
            confirmToken,
          }),
    // The server updated its cache on success; on a refusal the page was stale, so refetch either way.
    onSettled: () => refreshBoard(qc),
  });
}

/** Bulk Ready to Test, step 1: reads every card live, writes nothing, returns the one token for that picture. */
export function usePreviewBulkReady() {
  return useMutation<BulkReadyPreview, Error, string[]>({
    mutationFn: (cardIds) => post<BulkReadyPreview>('/api/cards/bulk-ready/preview', { cardIds }),
  });
}

export function useApplyBulkReady() {
  const qc = useQueryClient();
  return useMutation<
    BulkReadyResult,
    Error,
    { cardIds: string[]; includeWarned: string[]; confirmToken: string }
  >({
    mutationFn: (body) => post<BulkReadyResult>('/api/cards/bulk-ready', body),
    onSettled: () => refreshBoard(qc),
  });
}

/** `POST /api/audit/:id/undo` for a card write. A conflicting external edit comes back as 409 `undo_conflict`. */
export function useUndoWrite() {
  const qc = useQueryClient();
  return useMutation<UndoResult, Error, number>({
    mutationFn: (auditId) => post<UndoResult>(`/api/audit/${auditId}/undo`),
    onSettled: () => refreshBoard(qc),
  });
}

function refreshBoard(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: stateKeys.state });
  void qc.invalidateQueries({ queryKey: stateKeys.health });
}

/** Error codes after which re-reading the card (a fresh preview) is the right next step. */
export const REVIEW_AGAIN_CODES = new Set([
  'confirmation_required',
  'confirmation_stale',
  'write_in_progress',
]);

export type { UndoConflictDetails };
