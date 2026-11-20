import { useMutation } from '@tanstack/react-query';
import type {
  ReviewExplainRequest,
  ReviewExplainResult,
  ReviewProposeRequest,
  ReviewProposeResult,
} from '@relay/shared';
import { post } from './api';

/** Code Review assist: the client holds the Explain conversation; nothing is stored on the server. */
export function useExplainChat() {
  return useMutation<ReviewExplainResult, Error, ReviewExplainRequest>({
    mutationFn: (b) => post('/api/review-assist/explain', b),
  });
}

export function useProposeChange() {
  return useMutation<ReviewProposeResult, Error, ReviewProposeRequest>({
    mutationFn: (b) => post('/api/review-assist/propose', b),
  });
}
