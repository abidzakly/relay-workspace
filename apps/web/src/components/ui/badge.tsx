import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold tracking-[0.03em] uppercase whitespace-nowrap [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-foreground/25 text-foreground',
        success: 'border-success/30 bg-transparent text-success',
        warning: 'border-warning/35 bg-transparent text-warning',
        destructive: 'border-destructive/35 bg-transparent text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
