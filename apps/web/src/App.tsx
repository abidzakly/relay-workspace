import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { MotionProvider } from '@/lib/motion/MotionProvider';
import { queryClient } from '@/lib/queryClient';
import { router } from '@/router';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MotionProvider>
        <RouterProvider router={router} />
      </MotionProvider>
    </QueryClientProvider>
  );
}
