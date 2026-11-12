import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Stand-in for a view that a later part builds. */
export function Placeholder({
  title,
  description,
  part,
  children,
}: {
  title: string;
  description: string;
  part: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Coming in {part}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        {children ? <CardContent>{children}</CardContent> : <div className="pb-6" />}
      </Card>
    </div>
  );
}
