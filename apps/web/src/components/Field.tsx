import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Label + control + hint + inline error. `error` comes from the Zod issue at this field's path. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label {...(htmlFor ? { htmlFor } : {})}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** First error per dotted path (`gitlab.projectId`). */
export function errorMap(issues: { path?: string | undefined; message?: string | undefined }[]) {
  const m: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path ?? '';
    if (!(k in m)) m[k] = i.message ?? 'invalid';
  }
  return m;
}
