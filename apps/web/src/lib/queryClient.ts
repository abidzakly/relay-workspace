import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** Server data lives here; `lib/sse.ts` invalidates it from `GET /api/events`. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});
