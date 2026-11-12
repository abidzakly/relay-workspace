import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('relative w-full rounded-surface border border-l-2 px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-card text-card-foreground',
      destructive: 'border-destructive/30 border-l-destructive bg-destructive/5 text-destructive',
      warning: 'border-warning/30 border-l-warning bg-warning/5 text-foreground',
      success: 'border-success/30 border-l-success bg-success/5 text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mb-1 type-micro', className)} {...props} />;
}
export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-sm opacity-90', className)} {...props} />;
}
